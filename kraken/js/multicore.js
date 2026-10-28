// SPDX-License-Identifier: GPL-3.0-only
// Multi-core playback, the page's side: the setting (MULTI-CORE: Auto / Off, in Check this device), the helper threads
// (mc-worker.js, one per spare core, up to 6), and every message to the audio engine routed through the timeline
// (multicore-core.js says how it all fits). Only where the page is cross-origin isolated (SharedArrayBuffer). On any
// trouble it goes back to one thread, the way Kraken always played, and says so once.
import { McRouter, makeShared, planParts } from './multicore-core.js';

const WORKER = new URL('./mc-worker.js', import.meta.url);
const KEY = 'kraken.multicore';

export const mcSupported = () => typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true && typeof Atomics === 'object' && typeof Worker === 'function';
export function mcMode() { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } }
// helper threads wanted: Auto, from 4 cores (the audio thread and the page keep one each); 'on' (stored by hand, for
// tests and the curious): at least one; kraken.mcWorkers: a number of helpers, by hand
export function mcWorkers(mode = mcMode()) {
  if (mode === 'off' || !mcSupported()) return 0;
  const hc = navigator.hardwareConcurrency || 1;
  let forced = 0; try { forced = Math.floor(+localStorage.getItem('kraken.mcWorkers') || 0); } catch { /* */ }
  if (forced > 0) return Math.min(8, forced);
  if (mode === 'on') return Math.max(1, Math.min(6, hc - 2));
  return hc >= 4 ? Math.min(6, hc - 2) : 0;
}

export class MultiCore {
  constructor(audio, { stopped = () => true, toast = () => {} } = {}) {
    this.audio = audio; this.stopped = stopped; this.toast = toast;
    this.router = new McRouter(0);
    this.workers = []; this.ready = [];
    this.state = 'off';        // off, starting, go (waiting for the worklet), on, leaving
    this.failed = '';          // why it went back to one thread (for this session)
    this.loads = []; this.load = 0; this.late = [];
    this.assets = new Map();   // id -> { L, R }: what the engine was sent, for helpers started later
    this.copies = new WeakMap(); // an audio array -> its copy in shared memory (one for every helper)
    this.gen = 0;
    this.timer = setInterval(() => this.consider(), 1500);
    audio.on((m) => this.fromWorklet(m));
  }
  get active() { return this.state === 'on' || this.state === 'leaving'; }
  get cores() { return this.state === 'on' ? 1 + this.workers.length : 1; }
  setMode(v) { try { localStorage.setItem(KEY, v); } catch { /* */ } this.failed = v === 'off' ? '' : this.failed; this.consider(); }
  // the line under the CPU readout
  describe() {
    if (this.state === 'on') return `Multi-core: ${this.cores} cores (the audio thread at ${Math.round(this.load * 100)} %, ${this.workers.length} helper${this.workers.length > 1 ? 's' : ''} at ${this.loads.map((x) => `${Math.round((x || 0) * 100)} %`).join(', ')})`;
    if (this.failed) return `Multi-core: off (${this.failed})`;
    if (!mcSupported()) return 'Multi-core: not available here (the page is not cross-origin isolated)';
    if (!mcWorkers()) return mcMode() === 'off' ? 'Multi-core: off' : `Multi-core: off on ${navigator.hardwareConcurrency || '?'} cores (Auto: from 4)`;
    return 'Multi-core: starting';
  }
  share(a) {
    if (!a || a.buffer instanceof SharedArrayBuffer) return a;
    let c = this.copies.get(a);
    if (!c) { c = new Float32Array(new SharedArrayBuffer(a.length * 4)); c.set(a); this.copies.set(a, c); }
    return c;
  }
  toWorkers(m) { for (const w of this.workers) w.postMessage(m); }
  // every message to the engine comes here (Audio.send)
  send(m) {
    if (m.t !== 'note' && m.t !== 'meters') this.busyAt = performance.now();
    if (m.t === 'asset') { this.assets.set(m.id, m); if (this.workers.length) this.toWorkers({ t: 'asset', id: m.id, L: this.share(m.L), R: this.share(m.R) }); }
    for (const [to, x] of this.router.route(m)) { if (to === 'w') this.audio.post(x); else this.toWorkers(x); }
    if (m.t === 'stop') setTimeout(() => this.consider(), 300);
  }
  // helpers for this song: one for about 4 tracks they can play, up to what the setting allows
  wanted() {
    const max = this.failed ? 0 : mcWorkers(), p = this.router.view();
    if (!max || !p) return 0;
    if (this.counted?.ver !== this.router.ver) this.counted = { ver: this.router.ver, n: Object.keys(planParts(p, { workers: 64, monitor: this.router.monitor, keys: new Map() }).owner).length };
    const n = this.counted.n;
    return n ? Math.min(max, Math.ceil(n / 4)) : 0;
  }
  // starts when wanted and the song stands still; leaves when no longer wanted (or, stopped, to have more helpers for a
  // song that grew)
  consider() {
    const want = this.wanted();
    if (this.state === 'on' && (!want || mcWorkers() < this.workers.length || (want > this.workers.length && this.stopped()))) { this.leave(); return; }
    // (and the page idle for 2 s: not while a song opens, the helpers' start costs a moment of every core)
    if (this.state === 'off' && want && this.stopped() && this.audio.node && this.router.top && performance.now() - (this.busyAt || 0) > 2000) this.start(want);
  }
  async start(n) {
    const gen = ++this.gen;
    this.state = 'starting';
    try {
      this.mem = makeShared(n);
      // a port from the audio thread to each helper: the start goes straight to them
      const chans = Array.from({ length: n }, () => new MessageChannel());
      this.audio.post({ t: 'mc-init', shared: this.mem, ports: chans.map((c) => c.port2) }, chans.map((c) => c.port2));
      this.router.n = n;
      const p = this.router.view(), mods = this.audio.modules;
      this.workers = []; this.loads = new Array(n).fill(0);
      const ready = [];
      for (let k = 1; k <= n; k++) {
        const w = new Worker(WORKER, { type: 'module', name: `kraken-core-${k}` });
        w.onerror = (e) => { e.preventDefault?.(); this.fail(`a helper thread failed${e.message ? ` (${e.message})` : ''}`); };
        w.onmessageerror = () => this.fail('a helper thread could not read a message');
        ready.push(new Promise((res) => { this.ready[k] = res; }));
        w.onmessage = ({ data }) => this.fromWorker(k, data);
        const port = chans[k - 1].port1;
        try { w.postMessage({ t: 'init', role: k, shared: this.mem, port, modules: Object.fromEntries(Object.entries(mods)) }, [port]); }
        catch { w.postMessage({ t: 'init', role: k, shared: this.mem, port, wasm: mods.bytes }, [port]); }   // (a browser that cannot pass a compiled engine)
        for (const a of this.assets.values()) w.postMessage({ t: 'asset', id: a.id, L: this.share(a.L), R: this.share(a.R) });
        w.postMessage({ t: 'base', p, warm: true });
        this.workers.push(w);
      }
      const ok = await Promise.race([Promise.all(ready).then(() => true), new Promise((r) => setTimeout(() => r(false), 15000))]);
      if (gen !== this.gen || this.state !== 'starting') return;
      if (!ok) { this.fail('the helper threads did not start'); return; }
      if (!this.stopped()) { this.teardown(); return; }            // (playing now: at the next stop)
      // the song as it is now (it may have changed while they started), then the start, on the timeline
      const base = this.router.view();
      for (const w of this.workers) w.postMessage({ t: 'base', p: base, final: true });
      this.router.on = true;
      const part = this.router.plan(true);
      this.state = 'go';
      this.audio.post({ t: 'mc-go', part });
    } catch (err) { this.fail(`it could not start (${err?.message || err})`); }
  }
  fromWorklet(m) {
    if (m.t === 'mc-start' && this.state === 'go') { this.toWorkers({ t: 'start', Q0: m.Q0, schedStart: m.schedStart, snap: m.snap, part: m.part }); this.state = 'on'; this.late = []; this.onChange?.(); }
    else if (m.t === 'mc-reject' && this.state === 'go') this.teardown();     // (it played meanwhile: at the next stop)
    else if (m.t === 'mc-fail') this.fail(m.message);
    else if (m.t === 'crash') this.fail('the audio engine stopped');
    else if (m.t === 'load' && this.state === 'on') {
      this.load = m.v;
      // sound from a helper came late (a crackle): a few times is a busy moment; often, the device cannot keep up
      const t = performance.now();
      if (m.late) this.late.push([t, m.late]);
      this.late = this.late.filter(([x]) => t - x < 10000);
      if (this.late.reduce((s, [, n]) => s + n, 0) > 40 || this.late.length >= 6) this.fail('the helper threads could not keep up on this device');
    }
  }
  fromWorker(k, m) {
    if (m.t === 'ready') this.ready[k]?.();
    else if (m.t === 'load') this.loads[k - 1] = m.v;
    else if (m.t === 'error') { console.error('multicore', m.message); this.fail('a helper thread failed'); }
  }
  // back to one thread when no longer wanted: the tracks come back to the worklet at once, what rings in the helpers
  // rings out, then they go
  leave() {
    if (this.state !== 'on') return;
    this.state = 'leaving';
    this.router.n = 0;
    const part = this.router.plan(true);
    for (const [to, x] of this.router.timeline({ t: 'mc-part', part }, null, { t: 'mc-part', part })) { if (to === 'w') this.audio.post(x); else this.toWorkers(x); }
    const gen = this.gen;
    setTimeout(() => { if (gen === this.gen && this.state === 'leaving') { this.teardown(); this.onChange?.(); this.consider(); } }, 8000);
  }
  teardown() {
    this.gen++;
    this.router.on = false; this.router.n = 0; this.router.part = { owner: {}, keys: {} }; this.router.sig = '';
    this.audio.post({ t: 'mc-off' });
    for (const w of this.workers) { try { w.postMessage({ t: 'stop' }); w.terminate(); } catch { /* */ } }
    this.workers = []; this.loads = []; this.state = 'off';
  }
  fail(reason) {
    if (this.state === 'off') return;
    this.failed = reason;
    this.teardown();
    this.toast(`Multi-core playback is off: ${reason}. Kraken plays on one core, as before.`);
    this.onChange?.();
  }
  // the audio engine was made again (Audio.restart): the helpers go with the old one
  reset() { if (this.state !== 'off') this.teardown(); }
}
