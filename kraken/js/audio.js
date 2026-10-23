// SPDX-License-Identifier: GPL-3.0-only
// The audio side of the UI: the engines (compiled once, shared by every track), the live
// AudioWorklet, and offline export through the very same worklet.
import { RATE } from './engine-core.js';
import { projectEnd } from './project.js';
import { beatsToSeconds } from './engine-core.js';

const WORKLET = new URL('./worklet.js', import.meta.url);

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
  const res = await fetch(new URL('../engines/categories.json', import.meta.url));
  buildLibrary(lib, res.ok ? await res.json() : { kinds: [], sounds: [] });
  Object.defineProperty(modules, 'bytes', { value: bytes });     // (for a browser that cannot hand a compiled module to the audio thread)
  return { modules, lib };
}

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
  lib.sounds = sounds;
  lib.kinds = KIND;
  lib.byEngine = {};
  for (const s of sounds) (lib.byEngine[s.eng] ||= []).push(s);
  lib.engineNames = lib.clipper.engines.map((e) => e.name).filter((n) => lib.byEngine[n]);
  lib.soundOf = (t) => sounds.find((s) => s.bank === t.bank && s.engine === t.engine && s.preset === t.preset) || null;
}

export class Audio {
  constructor(modules) {
    this.modules = modules;
    this.handlers = new Set();
    this.node = null;
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
    const make = () => new AudioWorkletNode(this.ctx, 'kraken', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: this.options() });
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
    if (this.input) this.input.connect(this.node);
  }
  // after a crash: a fresh engine (the caller sends it the project and the audio again)
  restart() {
    try { this.node.port.onmessage = null; this.node.disconnect(); this.input?.disconnect(); } catch { /* gone */ }
    this.makeNode();
  }
  on(fn) { this.handlers.add(fn); }
  // the microphone or audio interface, raw (no echo cancelling, no gain control), into the engine
  async enableInput() {
    if (this.input) return true;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser gives no access to audio inputs.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
    this.input = this.ctx.createMediaStreamSource(stream);
    this.input.connect(this.node);
    this.inputName = stream.getAudioTracks()[0]?.label || 'Input';
    return true;
  }
  // seconds between the engine's clock and what the player hears and plays back
  roundTrip() { return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + 0.006; }
  send(msg) { this.node?.port.postMessage(msg); }
  latency() { return (this.ctx?.baseLatency || 0) + (this.ctx?.outputLatency || 0); }

  // Render the project offline (no loop, from 0 to its end plus a tail), optionally one track only.
  // the song (or a range of it: start / end in beats) rendered offline, with the same engine
  async render(project, { soloTrack = null, freezeTrack = null, tail = 2, assets = {}, start = 0, end = null } = {}) {
    const beats = end ?? Math.max(1, projectEnd(project));
    const seconds = beatsToSeconds(project, beats) - beatsToSeconds(project, start) + tail;
    const frames = Math.ceil(seconds * RATE / 128) * 128;
    const ctx = new OfflineAudioContext(2, frames, RATE);
    await ctx.audioWorklet.addModule(WORKLET);
    const node = new AudioWorkletNode(ctx, 'kraken', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: this.options({ project: structuredClone(project), offline: true, soloTrack, freezeTrack, assets, start }),
    });
    node.connect(ctx.destination);
    const buf = await ctx.startRendering(), exact = Math.min(frames, Math.round(seconds * RATE));   // to the sample (a loop exports seamless)
    return [buf.getChannelData(0).subarray(0, exact), buf.getChannelData(1).subarray(0, exact)];
  }
}
