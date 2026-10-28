// SPDX-License-Identifier: GPL-3.0-only
// The audio side of the UI: the engines (compiled once, shared by every track), the live
// AudioWorklet, and offline export through the very same worklet. Plugins (WAM, wam-host.js) live in and out of
// its extra inputs and outputs, in both. With multi-core playback (multicore.js, this.mc), every message to the engine
// goes through its timeline; offline renders run side by side, one per spare core.
import { RATE } from './engine-core.js';
import { projectEnd } from './project.js';
import { beatsToSeconds } from './engine-core.js';
import { WAM_SLOTS, wamPlan } from './wam.js';
import { packIndex } from './packs.js';

const WORKLET = new URL('./worklet.js', import.meta.url);
const RENDER_WORKER = new URL('./render-worker.js', import.meta.url);

export async function loadEngines() {
  const modules = {}, lib = {}, bytes = {};
  for (const name of ['clipper', 'sloop']) {
    const res = await fetch(new URL(`../engines/${name}.wasm`, import.meta.url));
    if (!res.ok) throw new Error(`${name}.wasm: HTTP ${res.status}`);
    bytes[name] = await res.arrayBuffer();
    modules[name] = await WebAssembly.compile(bytes[name]);
    const w = new WebAssembly.Instance(modules[name], {}).exports;
    w.k_init(0);
    const n = w.k_catalog();
    lib[name] = JSON.parse(new TextDecoder().decode(new Uint8Array(w.memory.buffer, w.k_buffer(), n).slice()));
  }
  // the community engines Kraken ships (packs.js): a bank each, "x:ID"; their catalogues now, their engines when played
  Object.assign(lib, await packIndex());
  const res = await fetch(new URL('../engines/categories.json', import.meta.url));
  lib.cats = res.ok ? await res.json() : { kinds: [], sounds: [] };
  Object.defineProperty(lib, 'cats', { enumerable: false });
  buildLibrary(lib, lib.cats);
  Object.defineProperty(modules, 'bytes', { value: bytes });     // (for a browser that cannot hand a compiled module to the audio thread)
  return { modules, lib };
}
// every engine bank to send to another thread (the built-in two and the packs loaded; never the bytes' own property)
export const allModules = (modules) => Object.fromEntries(Object.entries(modules));

// One library for every sound, whichever firmware it comes from: grouped by kind (Clipper's own
// PRESETS order) and by engine. A sound in both firmwares plays from Clipper.
export function buildLibrary(lib, cats) {
  const KIND = ['BASS', 'KEYS', 'ORGAN', 'PAD', 'LEAD', 'PLUCK', 'STAB', 'FX'];
  const find = (bank, eng, name) => {
    const e = lib[bank].engines.findIndex((x) => x.name === eng);
    const i = e < 0 ? -1 : lib[bank].engines[e].presets.indexOf(name);
    return i < 0 ? null : { bank, engine: e, preset: i };
  };
  const sounds = [], seen = new Set();
  const add = (kind, eng, name) => {
    const key = eng + '|' + name;
    if (seen.has(key)) return;
    const ref = find('clipper', eng, name) || find('sloop', eng, name);
    if (!ref) return;
    seen.add(key);
    sounds.push({ kind, eng, name, ...ref });
  };
  for (const [k, eng, name] of cats.sounds) add(KIND[k], eng, name);
  for (const bank of ['clipper', 'sloop']) for (const e of lib[bank].engines) for (const name of e.presets) add('FX', e.name, name);
  // an engine pack: its sounds under its own name (by type) and its engines named after it (by engine)
  const packs = Object.keys(lib).filter((b) => lib[b]?.pack && !lib[b].missing);
  lib.engKey = (bank, name) => (lib[bank]?.pack ? `${lib[bank].pack.name.toUpperCase()} · ${name}` : name);
  lib.kindNames = {};
  for (const bank of packs) {
    const kind = `PACK:${bank}`;
    lib.kindNames[kind] = `◆ ${lib[bank].pack.name.toUpperCase()}`;
    lib[bank].engines.forEach((e, ei) => e.presets.forEach((name, pi) => sounds.push({ kind, eng: lib.engKey(bank, e.name), name, bank, engine: ei, preset: pi, pack: true })));
  }
  lib.sounds = sounds;
  lib.kinds = [...KIND, ...packs.map((b) => `PACK:${b}`)];
  lib.byEngine = {};
  for (const s of sounds) (lib.byEngine[s.eng] ||= []).push(s);
  lib.engineNames = [...lib.clipper.engines.map((e) => e.name), ...packs.flatMap((b) => lib[b].engines.map((e) => lib.engKey(b, e.name)))].filter((n) => lib.byEngine[n]);
  lib.soundOf = (t) => sounds.find((s) => s.bank === t.bank && s.engine === t.engine && s.preset === t.preset) || null;
}

export class Audio {
  constructor(modules) {
    this.modules = modules;
    this.handlers = new Set();
    this.node = null;
    this.pdc = 0;                // seconds the master is late, waiting for the plugins (wam.js pdc)
  }
  async start() {
    // iPhone, iPad: sound even with the silent switch on (a music app, not a notification sound)
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* */ }
    this.ctx?.close?.().catch?.(() => {});                       // (a start tried before: let its context go)
    try { this.ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' }); } catch { this.ctx = new AudioContext({ latencyHint: 'interactive' }); }
    if (this.ctx.sampleRate !== RATE) throw new Error(`this browser runs audio at ${this.ctx.sampleRate} Hz only; Kraken needs ${RATE} Hz`);
    if (!this.ctx.audioWorklet) throw new Error('this browser has no AudioWorklet (use a recent Chrome, Edge, Firefox or Safari)');
    await this.ctx.audioWorklet.addModule(WORKLET);
    this.makeNode();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.woken) return;
    this.woken = true;
    // after a phone call, the screen locked, another app playing: back as soon as the person touches Kraken again
    const wake = () => { if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, wake, true);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  }
  // the engines go to the audio thread compiled; a browser that cannot pass a compiled module there gets the bytes
  options(extra = {}) { return this.useBytes ? { wasm: this.modules.bytes, ...extra } : { modules: this.modules, ...extra }; }
  makeNode() {
    // input 0: the audio input; output 0: the mix; then one stereo pair each way per plugin slot
    const make = () => new AudioWorkletNode(this.ctx, 'kraken', { numberOfInputs: 1 + WAM_SLOTS, numberOfOutputs: 1 + WAM_SLOTS,
      outputChannelCount: Array(1 + WAM_SLOTS).fill(2), processorOptions: this.options() });
    try { this.node = make(); } catch (e) {
      if (this.useBytes || !this.modules.bytes) throw e;
      this.useBytes = true;
      this.node = make();
    }
    this.lastTick = 0;
    // the audio thread could not start the engines it was sent (a browser that passes the compiled module but cannot
    // use it there): once, again with the bytes, compiled on that thread; the app then sends the project again
    this.node.onprocessorerror = () => {
      if (this.useBytes || !this.modules.bytes) return;
      this.useBytes = true;
      this.restart();
      this.onRestart?.();
    };
    this.node.port.onmessage = ({ data }) => { if (data.t === 'tick') this.lastTick = performance.now(); for (const h of this.handlers) h(data); };
    this.node.connect(this.ctx.destination);
    this.tap();
    this.wireInput();
  }
  // the spectrum analyser on the output (for the mixer's display; it costs nothing until it is read)
  tap() {
    if (this.analyser?.context !== this.ctx) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 8192; this.analyser.smoothingTimeConstant = 0.55;
      this.analyser.minDecibels = -120; this.analyser.maxDecibels = 0;
    }
    try { this.node.connect(this.analyser); } catch { /* */ }
  }
  // after a crash: a fresh engine (the caller sends it the project and the audio again)
  restart() {
    this.mc?.reset();
    try { this.node.port.onmessage = null; this.node.disconnect(); this.input?.disconnect(); } catch { /* gone */ }
    this.makeNode();
  }
  on(fn) { this.handlers.add(fn); }
  // the microphone or audio interface, raw (no echo cancelling, no gain control), into the engine
  // the audio input: a device (its id, or the default), all its channels (an interface's 4, 8…), raw (no echo
  // cancelling, no noise suppression, no gain control)
  async enableInput(deviceId = null) {
    if (this.input && (deviceId == null || deviceId === this.inputId)) return true;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser gives no access to audio inputs.');
    const want = deviceId ?? (() => { try { return localStorage.getItem('kraken.inputDevice'); } catch { return null; } })();
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 32 }, ...(want ? { deviceId: { exact: want } } : {}) };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); } catch (e) { if (!want) throw e; delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    this.disableInput();
    const tr = stream.getAudioTracks()[0];
    this.stream = stream;
    this.inputChannels = Math.max(1, tr?.getSettings?.().channelCount || 2);
    this.inputId = tr?.getSettings?.().deviceId || want || '';
    this.inputName = tr?.label || 'Input';
    try { if (deviceId) localStorage.setItem('kraken.inputDevice', deviceId); } catch { /* */ }
    this.input = this.ctx.createMediaStreamSource(stream);
    this.wireInput();
    return true;
  }
  // every channel of the input reaches the engine apart (not mixed down to stereo)
  wireInput() {
    if (!this.input || !this.node) return;
    try { this.node.channelCount = Math.max(2, Math.min(32, this.inputChannels || 2)); this.node.channelCountMode = 'explicit'; this.node.channelInterpretation = 'discrete'; } catch { /* */ }
    this.input.connect(this.node);
  }
  disableInput() {
    try { this.input?.disconnect(); } catch { /* */ }
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.input = null; this.stream = null;
  }
  // the inputs this browser can see (names after the first permission): [{ deviceId, label }]
  async inputs() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Input' })); } catch { return []; }
  }
  // seconds between the engine's clock and what the player hears and plays back, plus the person's own correction
  roundTrip() {
    let extra = 0; try { extra = (+localStorage.getItem('kraken.recOffset') || 0) / 1000; } catch { /* */ }
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + 0.006 + extra + this.pdc;
  }
  send(msg) { if (this.mc) this.mc.send(msg); else this.node?.port.postMessage(msg); }
  post(msg, transfer = []) { this.node?.port.postMessage(msg, transfer); }
  latency() { return (this.ctx?.baseLatency || 0) + (this.ctx?.outputLatency || 0) + this.pdc; }

  // Render the project offline (no loop, from 0 to its end plus a tail), optionally one track only.
  // the song (or a range of it: start / end in beats) rendered offline, with the same engine
  // Plugins are made again in the offline context, with their saved settings; one that cannot load is left out
  // (onWarn says so) and the render goes on. The plugins' delay is rendered past and cut from the start.
  // Renders at once (stems, freezes, bounces) share the spare cores: each has its own OfflineAudioContext, its own thread;
  // as many run side by side as the cores allow, fewer for a long song (each holds the whole song in memory).
  renderSlots(seconds = 240) { return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1, Math.floor(1200 / Math.max(1, seconds)))); }
  async render(project, opts = {}) {
    const seconds = this.renderSeconds(project, opts), q = (this.renders ||= { n: 0, wait: [] });
    while (q.n >= this.renderSlots(seconds)) await new Promise((r) => q.wait.push(r));
    q.n++;
    try { return await this.renderNow(project, opts); } finally { q.n--; q.wait.shift()?.(); }
  }
  renderInWorker(job) {
    return new Promise((resolve, reject) => {
      const w = new Worker(RENDER_WORKER, { type: 'module', name: 'kraken-render' });
      const done = (f) => { try { w.terminate(); } catch { /* */ } f(); };
      w.onmessage = ({ data }) => done(() => (data.error ? reject(new Error(data.error)) : resolve([data.L, data.R])));
      w.onerror = (e) => { e.preventDefault?.(); done(() => reject(new Error(e.message || 'render worker failed'))); };
      const mods = this.modules;
      try { w.postMessage({ ...job, project: job.project, modules: allModules(mods) }); }
      catch { w.postMessage({ ...job, wasm: mods.bytes }); }
    });
  }
  renderSeconds(project, { tail = 2, start = 0, end = null } = {}) { return beatsToSeconds(project, end ?? Math.max(1, projectEnd(project))) - beatsToSeconds(project, start) + tail; }
  async renderNow(project, { soloTrack = null, freezeTrack = null, bounceTrack = null, soloReturn = null, tail = 2, assets = {}, start = 0, end = null } = {}) {
    const seconds = this.renderSeconds(project, { tail, start, end });
    const exact = Math.round(seconds * RATE);
    const hasWams = Object.keys(wamPlan(project).tracks).length > 0;
    // without plugins: in a Web Worker (several really run at once there), the same engine, the same samples
    if (!hasWams && typeof Worker === 'function' && !this.noRenderWorker) {
      try {
        const [L, R] = await this.renderInWorker({ project, soloTrack, freezeTrack, bounceTrack, soloReturn, assets, start, frames: Math.ceil(seconds * RATE / 128) * 128 });
        return [L.subarray(0, exact), R.subarray(0, exact)];
      } catch (err) { this.noRenderWorker = true; console.warn('render worker:', err); }   // (then in an OfflineAudioContext, as before)
    }
    const wams = hasWams ? await import('./wam-host.js') : null;
    // (the context's length waits on the plugins' delay, known once they load: a first context to load them in)
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * RATE / 128) * 128 + (wams ? 128 * WAM_SLOTS * 2 : 0), RATE);
    await ctx.audioWorklet.addModule(WORKLET);
    const plug = wams ? await wams.offlineWams(ctx, project, { freezeTrack, soloTrack }) : null;
    if (plug?.failed.length) this.onWarn?.(`Plugin${plug.failed.length > 1 ? 's' : ''} left out of this render: ${plug.failed.join(', ')}.`);
    const lat = plug?.latency || 0, k = 1 + (plug?.slots || 0);
    const node = new AudioWorkletNode(ctx, 'kraken', {
      numberOfInputs: plug?.slots ? k : 0, numberOfOutputs: k, outputChannelCount: Array(k).fill(2),
      processorOptions: this.options({ project: structuredClone(project), offline: true, soloTrack, freezeTrack, bounceTrack, soloReturn, assets, start,
        wam: plug?.slots ? { plan: plug.plan, group: plug.group, key: plug.key, ids: plug.ids } : null }),
    });
    if (plug?.slots) plug.connect(node);
    node.connect(ctx.destination);
    const buf = await ctx.startRendering();
    const frames = Math.min(buf.length - lat, exact);              // to the sample (a loop exports seamless)
    return [buf.getChannelData(0).subarray(lat, lat + frames), buf.getChannelData(1).subarray(lat, lat + frames)];
  }
}
