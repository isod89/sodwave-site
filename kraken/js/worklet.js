// SPDX-License-Identifier: GPL-3.0-only
// The audio thread: one KrakenEngine, driven by messages from the UI. Its input (when the
// microphone or an interface is connected) is captured while an audio track records. Its other inputs and
// outputs (after the first) are the plugin slots (wam.js): out to the plugins, back into the engine. With multi-core
// playback on (multicore.js), workers play some tracks ahead and this thread mixes their sound (multicore-core.js).
import { KrakenEngine } from './engine-core.js';
import { McHost, engineMsg, QUANTUM } from './multicore-core.js';

const CHUNK = 8192;
const now = globalThis.performance?.now ? () => globalThis.performance.now() : () => Date.now();   // (ms; Date: averaged, it is fine)

class KrakenProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    // the engines compiled here when the page could only send their bytes
    const modules = o.modules || Object.fromEntries(Object.entries(o.wasm || {}).map(([k, b]) => [k, new WebAssembly.Module(b)]));
    this.engine = new KrakenEngine(modules, (m) => { if (m.t === 'tick' && this.host) this.host.fixTick(m); this.port.postMessage(m); });
    this.host = null;                // multi-core playback (multicore-core.js McHost), when the page turns it on
    this.engine.offline = !!o.offline;
    for (const [id, a] of Object.entries(o.assets || {})) this.engine.assets.set(id, a);
    this.L = new Float32Array(128);
    this.R = new Float32Array(128);
    this.caps = new Map();           // track id -> { start, L, R, n, a, b } while capturing (several armed tracks at once)
    this.capWanted = null;           // [{ id, a, b }]: the armed audio tracks and their input channels
    if (o.project) this.engine.setProject(o.project);
    this.wam = null;                 // the plugins: { group, key, ids: { key: [instance ids] }, procs } (wam-host.js)
    this.io = { ins: [], outs: [] };
    if (o.wam) this.setWam(o.wam);
    if (o.soloTrack) this.engine.soloTrack = o.soloTrack;
    if (o.freezeTrack) this.engine.freezeTrack = o.freezeTrack;
    if (o.bounceTrack) this.engine.bounceTrack = o.bounceTrack;
    if (o.soloReturn != null) this.engine.soloReturn = o.soloReturn;
    if (o.offline) { this.engine.seek(o.start || 0); this.engine.loop.on = false; this.engine.play(); }
    this.quiet = 0;                  // frames of silence while stopped: past 3 s the engine sleeps
    this.sleeping = false;
    this.failed = false;
    this.busy = 0; this.done = 0;
    this.port.onmessage = ({ data: m }) => {
      this.sleeping = false; this.quiet = 0;
      if (this.failed && m.t !== 'project') return;
      this.handle(m);
    };
  }
  handle(m) {
    const e = this.engine;
    try {
      switch (m.t) {
        case 'stop': e.stop(); this.endCapture(); break;
        case 'seek': engineMsg(e, m); this.endCapture(); break;
        case 'capture': if (m.on) this.capWanted = m.tracks || [{ id: m.track || '', a: 0, b: 1 }]; else this.endCapture(); break;
        case 'monitor': e.monitor = m.tracks || []; break;
        case 'wam': this.setWam(m); break;
        case '__crash': this.crashNext = true; break;            // tests: a fault in the audio thread
        // multi-core: the shared memory; a message on the timeline; the start; back to this thread alone
        case 'mc-init':
          this.host = new McHost(e, m.shared, (x) => this.handle(x), (x) => this.port.postMessage(x), { quiet: () => this.silent > sampleRate * 3 });
          this.host.ports = m.ports || []; this.lateQ = 0;
          break;
        case 'mc': if (this.host) this.host.receive(m); else { if (m.now) this.handle(m.now); if (m.m) this.handle(m.m); } break;
        case 'mc-go': if (this.host) this.host.receive(m); else this.port.postMessage({ t: 'mc-reject' }); break;
        case 'mc-off': this.host?.off(); this.host = null; break;
        default: engineMsg(e, m);                                 // (multicore-core.js: the engine's own messages)
      }
    } catch (err) { this.port.postMessage({ t: 'error', message: String(err && err.stack || err) }); }
  }
  flushChunk(id) {
    const c = this.caps.get(id);
    if (!c || !c.n) return;
    const L = c.L.slice(0, c.n), R = c.R.slice(0, c.n);
    this.port.postMessage({ t: 'cap', track: id, L, R }, [L.buffer, R.buffer]);
    c.n = 0;
  }
  // the takes end (keep: the tracks stay armed for the next pass)
  endCapture(keep = false) {
    for (const [id, c] of this.caps) { this.flushChunk(id); this.port.postMessage({ t: 'capEnd', track: id, start: c.start }); }
    this.caps.clear();
    if (!keep) this.capWanted = null;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (this.failed || this.sleeping) return true;             // silence: a crashed or resting engine
    try { return this.run(inputs, out, n, outputs); } catch (err) {
      this.failed = true;                                       // isolate the fault: silence, and tell the UI (it can restart)
      this.port.postMessage({ t: 'crash', message: String(err && err.stack || err) });
      return true;
    }
  }
  run(inputs, out, n, outputs) {
    if (this.crashNext) throw new Error('test fault in process()');
    const t0 = now(), host = this.host;
    if (host) {
      if (n !== QUANTUM) { host.off(); this.host = null; this.port.postMessage({ t: 'mc-fail', message: `render quantum of ${n} frames` }); }
      else { host.before(); host.ready(1, now); }                // (a worker late: 1 ms of grace, then its sound is missing)
    }
    if (this.engine.wam) this.wamIO(inputs, outputs, n);
    const inp = inputs[0];
    this.engine.input = inp?.length ? inp : null;                // (monitoring: the engine plays the input through the track)
    if (this.capWanted && this.engine.playing && !this.engine.counting && this.engine.punchOpen() && inp?.length) {
      for (const w of this.capWanted) {
        let c = this.caps.get(w.id);
        if (!c) this.caps.set(w.id, (c = { start: this.engine.pos, L: new Float32Array(CHUNK), R: new Float32Array(CHUNK), n: 0 }));
        const a = inp[Math.min(w.a ?? 0, inp.length - 1)], b = w.b == null ? a : inp[Math.min(w.b, inp.length - 1)];
        for (let i = 0; i < a.length; i++) {
          c.L[c.n] = a[i]; c.R[c.n] = b[i];
          if (++c.n === CHUNK) this.flushChunk(w.id);
        }
      }
    }
    if (this.L.length !== n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
    this.engine.render(this.L, this.R);
    if (this.host) this.host.after();
    if (this.wam) this.wamEvents();
    this.busy += now() - t0; this.done += n;
    if (this.done >= 22050 && !this.engine.offline) {                 // twice a second: how busy the engine is
      const h = this.host, late = h ? h.lateQ - (this.lateQ || 0) : 0;
      if (h) this.lateQ = h.lateQ;
      this.port.postMessage({ t: 'load', v: this.busy / (this.done / 44.1), mc: h?.workers || 0, late });
      this.busy = 0; this.done = 0;
    }
    const first = this.caps.values().next().value;
    if (first && (this.engine.pos < first.start || !this.engine.punchOpen())) {   // the loop wrapped, or the punch closed: one take each
      this.endCapture(this.engine.pos < first.start);
    }
    let peak = 0, bad = false;
    for (let i = 0; i < n; i++) {
      const l = this.L[i], r = this.R[i];
      if (l !== l || r !== r || l === Infinity || l === -Infinity || r === Infinity || r === -Infinity) { bad = true; break; }
      const a = l < 0 ? -l : l, b = r < 0 ? -r : r; if (a > peak) peak = a; if (b > peak) peak = b;
    }
    this.silent = peak < 1e-5 ? (this.silent || 0) + n : 0;     // (how long nothing has sounded)
    if (bad) {                                                  // never let a NaN reach the speakers
      this.L.fill(0); this.R.fill(0);
      if (!this.nanReported) { this.nanReported = true; this.port.postMessage({ t: 'error', message: 'An effect or instrument produced an invalid sample: muted that block.' }); }
    }
    out[0].set(this.L);
    if (out[1]) out[1].set(this.R);
    const e = this.engine;
    if (!e.playing && !e.offline && !this.capWanted && !e.monitor?.some((x) => x.listen) && peak < 1e-5) { this.quiet += n; if (this.quiet > 44100 * 3) { this.sleeping = true; this.port.postMessage({ t: 'sleep' }); } }
    else this.quiet = 0;
    return true;
  }
  // ------------------------------------------------------------- plugins ---
  setWam(m) {
    this.wam = m.plan ? { group: m.group, key: m.key, ids: m.ids || {}, procs: new Map() } : null;
    this.engine.setWam(m.plan || null);
    this.lastTransport = null;
  }
  // this render's slots for the engine: what came back from the plugins, and the outputs to them (silent unless used)
  wamIO(inputs, outputs, n) {
    const io = this.io, k = Math.max(0, outputs.length - 1);
    io.ins.length = k; io.outs.length = k;
    for (let s = 0; s < k; s++) {
      io.ins[s] = inputs[s + 1];
      const o = io.outs[s] = outputs[s + 1];
      for (const ch of o) ch.fill(0, 0, n);
    }
    this.engine.wamIO = io;
  }
  // a plugin's processor, in this audio thread (the WAM group of the page, wam-env.js)
  wamProc(instanceId) {
    const w = this.wam;
    let p = w.procs.get(instanceId);
    if (p) return p;
    try { p = globalThis.webAudioModules?.getGroup(w.group, w.key)?.processors?.get(instanceId); } catch { p = null; }
    if (p) w.procs.set(instanceId, p);
    return p;
  }
  // the notes of plugin instruments, straight to their processors, one quantum ahead: each lands on its exact frame
  // of the next render (the plugin has already played this one), and comes back with the plugin's sound one
  // quantum late, like every plugin trip (the other tracks wait as long)
  wamEvents() {
    const e = this.engine, w = this.wam, ahead = (n) => currentTime + n / sampleRate;
    const plan = e.wam;
    for (const [id, f, st, d1, d2] of e.wamMidi) {
      const inst = plan?.tracks[id]?.inst;
      for (const iid of (inst && w.ids[inst.key]) || []) this.wamProc(iid)?.scheduleEvents({ type: 'wam-midi', time: ahead(f + 128), data: { bytes: [st, d1, d2] } });
    }
    e.wamMidi.length = 0;
    // the transport (tempo, play, stop) to every plugin, when it changes: tempo-synced delays, arpeggiators
    const sig = `${e.playing && !e.counting}:${Math.round(e.bpm * 100)}:${e.sig}`;
    if (plan && sig !== this.lastTransport) {
      this.lastTransport = sig;
      const beats = Math.max(0, e.pos), bar = Math.floor(beats / (e.sig || 4));
      const data = { currentBar: bar, currentBarStarted: ahead(128) - (beats - bar * (e.sig || 4)) * 60 / e.bpm, tempo: e.bpm, timeSigNumerator: Math.round(e.sig || 4), timeSigDenominator: 4, playing: e.playing && !e.counting };
      for (const key in w.ids) for (const iid of w.ids[key]) this.wamProc(iid)?.scheduleEvents({ type: 'wam-transport', time: ahead(128), data });
    }
  }
}
registerProcessor('kraken', KrakenProcessor);
