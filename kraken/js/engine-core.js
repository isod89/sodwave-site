// SPDX-License-Identifier: GPL-3.0-only
// Kraken audio engine core. Runs in the AudioWorklet (live), in an OfflineAudioContext (export)
// and under Node (tests). No DOM, no Web Audio: blocks of BLOCK frames in, stereo floats out.
//
// Tracks: SLOOP / Clipper instruments (one WebAssembly instance each), drums, audio, sampler,
// external MIDI (a hardware synth, the FM-1) and groups (buses). Clips play from the arrangement or,
// launched, from the session's slots. Racks of effects, sends to any number of returns, the master
// with its loudness meter. Tempo map, swing, count-in, punch; per note probability, ratchets,
// micro-timing and parameter locks, the way SLOOP's sequencer plays them. Plugins (WAM: instruments,
// effects in racks) play outside, through the worklet's extra inputs and outputs: wam.js.

import { Reverb, Delay, Rack, Biquad } from './fx.js';
import { NoteChain } from './notefx.js';
import { Modulator, applyMod } from './mods.js';
import { isFolder, expandFolder } from './comp.js';
import { envAt, autoAt } from './project.js';
import { Sampler } from './sampler.js';
import { meterList, barOf } from './meter.js';
import { Levels } from './levels.js';
import { pdc, Lag } from './wam.js';

export const RATE = 44100;
export const BLOCK = 32;                       // the firmware's control block (CTL)
const TAU = Math.PI * 2;

export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

// ------------------------------------------------------------------- time ---
// the tempo at a beat: the project's, or its tempo map (points { t, v }, ramps between them)
export function tempoAt(p, beat) {
  const m = p.tempo;
  if (!m || !m.length) return p.bpm;
  if (beat <= m[0].t) return m[0].v;
  for (let i = 1; i < m.length; i++) if (beat < m[i].t) { const a = m[i - 1], b = m[i]; return a.v + (b.v - a.v) * (beat - a.t) / (b.t - a.t); }
  return m[m.length - 1].v;
}
export function beatsToSeconds(p, beats) {
  if (!p.tempo || !p.tempo.length) return beats * 60 / p.bpm;
  let s = 0;
  for (let b = 0; b < beats; b += 0.0625) s += Math.min(0.0625, beats - b) * 60 / tempoAt(p, b + 0.03125);
  return s;
}

// a clip's notes as events: repeated over the clip's length when its loop is shorter (patterns),
// with the swing, the micro-timing and the ratchets placed. Probability and locks travel along.
export function clipEvents(clip, out, { start = clip.start, len = clip.len, swing = 0 } = {}) {
  const loop = clip.loop > 0 ? clip.loop : clip.len;
  for (let base = 0; base < len - 1e-9; base += loop) {
    for (const nt of clip.notes) {
      if (nt.t >= loop - 1e-9) continue;
      let t = base + nt.t;
      if (t >= len - 1e-9) continue;
      const d = Math.min(nt.d, loop - nt.t, len - t);
      const odd = Math.abs((nt.t % 0.5) - 0.25) < 0.01;            // an offbeat 16th: swung
      t += (odd ? swing * 0.125 : 0) + (nt.m || 0);
      const r = Math.max(1, nt.r || 1);
      for (let k = 0; k < r; k++) {
        out.push({ t: start + t + k * d / r, d: Math.max(0.01, (d / r) * (r > 1 ? 0.8 : 1)), n: nt.n, v: k ? Math.max(1, Math.round(nt.v * 0.82)) : nt.v, p: nt.p ?? 1, l: nt.l || null });
      }
    }
  }
  return out;
}

// a clip's controller lanes (clip.ctl: { 'cc:64': [{ t, v }], 'pb': …, 'cp': … }) as events { t, c: [status, d1, d2] },
// repeated over the clip's loop like its notes
export const ctlMessage = (key, v) => {
  if (key === 'pb') { const x = Math.max(0, Math.min(16383, Math.round(v) + 8192)); return [0xe0, x & 127, x >> 7]; }
  if (key === 'cp') return [0xd0, Math.max(0, Math.min(127, Math.round(v))), 0];
  return [0xb0, +key.slice(3) & 127, Math.max(0, Math.min(127, Math.round(v)))];
};
export function ctlEvents(clip, out, { start = clip.start, len = clip.len } = {}) {
  if (!clip.ctl) return out;
  const loop = clip.loop > 0 ? clip.loop : clip.len;
  for (const key in clip.ctl) for (let base = 0; base < len - 1e-9; base += loop)
    for (const q of clip.ctl[key]) {
      if (q.t >= loop - 1e-9 || base + q.t >= len - 1e-9) continue;
      out.push({ t: start + base + q.t, d: 0, n: -1, v: 0, c: ctlMessage(key, q.v) });
    }
  return out;
}

// --------------------------------------------------------------- loudness ---
// EBU R128 / ITU-R BS.1770: K-weighting, momentary (400 ms), short-term (3 s), integrated (gated) and loudness
// range (EBU Tech 3342). The gated measures keep histograms (0.05 LU bins): the same cost after an hour as after a second.
const HB = 2000, H0 = -70, HS = 0.05;
const hbin = (lu) => Math.max(0, Math.min(HB - 1, Math.floor((lu - H0) / HS)));
export class Lufs {
  constructor() {
    this.pre = new Biquad(); this.pre.set('high', 1681.97, 0.7072, 4.0);
    this.rlb = new Biquad(); this.rlb.set('hp', 38.13, 0.5003);
    this.l = new Float32Array(BLOCK); this.r = new Float32Array(BLOCK);
    this.steps = new Float64Array(30);                         // the last 3 s, in 100 ms steps (a ring)
    this.he = new Float64Array(HB); this.hn = new Uint32Array(HB);   // 400 ms blocks: energy and count per bin
    this.sn = new Uint32Array(HB);                             // 3 s values, for the range
    this.reset();
  }
  reset() { this.acc = 0; this.n = 0; this.k = 0; this.he.fill(0); this.hn.fill(0); this.sn.fill(0); this.sE = 0; this.sC = 0; this.cache = null; }
  // keep: the gated measures count this (while the song plays); the momentary and short-term always follow
  push(L, R, n, keep = true) {
    const l = this.l, r = this.r;
    for (let i = 0; i < n; i++) { l[i] = L[i]; r[i] = R[i]; }
    this.pre.run(l, r, n); this.rlb.run(l, r, n);
    for (let i = 0; i < n; i++) this.acc += l[i] * l[i] + r[i] * r[i];
    this.n += n;
    if (this.n >= 4410) {                        // 100 ms steps
      this.steps[this.k++ % 30] = this.acc / this.n; this.acc = 0; this.n = 0;
      if (!keep) return;
      if (this.k >= 4) { const b = this.mean(4), lu = Lufs.lu(b); if (lu > H0) { const i = hbin(lu); this.he[i] += b; this.hn[i]++; this.cache = null; } }
      if (this.k >= 30) { const b = this.mean(30), lu = Lufs.lu(b); if (lu > H0) { this.sn[hbin(lu)]++; this.sE += b; this.sC++; this.cache = null; } }
    }
  }
  mean(k) { let s = 0; for (let j = 1; j <= k; j++) s += this.steps[(this.k - j) % 30]; return s / k; }
  static lu(ms) { return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity; }
  get momentary() { return this.k >= 4 ? Lufs.lu(this.mean(4)) : -Infinity; }
  get short() { return this.k ? Lufs.lu(this.mean(Math.min(30, this.k))) : -Infinity; }
  gated() {
    if (this.cache) return this.cache;
    let e = 0, c = 0;
    for (let i = 0; i < HB; i++) { e += this.he[i]; c += this.hn[i]; }
    let integrated = -Infinity, range = 0;
    if (c) {
      const from = hbin(Lufs.lu(e / c) - 10 + HS / 2);           // relative gate: 10 LU under the ungated mean
      e = 0; c = 0;
      for (let i = from; i < HB; i++) { e += this.he[i]; c += this.hn[i]; }
      if (c) integrated = Lufs.lu(e / c);
    }
    if (this.sC) {                                               // range: 10th to 95th percentile of the short-term values over -20 LU
      const from = hbin(Lufs.lu(this.sE / this.sC) - 20 + HS / 2);
      let total = 0; for (let i = from; i < HB; i++) total += this.sn[i];
      if (total) {
        let lo = -1, hi = -1, run = 0;
        for (let i = from; i < HB; i++) { run += this.sn[i]; if (lo < 0 && run > total * 0.1) lo = i; if (run >= total * 0.95) { hi = i; break; } }
        range = Math.max(0, (hi - lo) * HS);
      }
    }
    return (this.cache = { integrated, range });
  }
  get integrated() { return this.gated().integrated; }
  get range() { return this.gated().range; }
}

// ---------------------------------------------------------------- sampler ---
// (sampler.js: keys, zones, slices, pads)

// ------------------------------------------------------------------- tracks ---
class Track {
  constructor(engine, def) {
    this.id = def.id;
    this.kind = def.kind;
    this.bank = def.kind === 'drum' ? 'sloop' : def.kind === 'synth' ? def.bank : null;
    if (this.bank) {
      this.w = new WebAssembly.Instance(engine.modules[this.bank], {}).exports;
      this.w.k_init(this.kind === 'drum' ? 1 : 0);
      this.out = new Float32Array(this.w.memory.buffer, this.w.k_render(), BLOCK * 2);
      this.nparams = this.w.k_nparams();
    } else {
      this.w = null;
      this.out = new Float32Array(BLOCK * 2);
      this.nparams = 0;
    }
    if (this.kind === 'sampler') this.sampler = new Sampler();
    if (this.kind === 'drum') this.pads = new Sampler();      // (a drum track's pads loaded with your own samples)
    this.soundKey = '';
    this.params = {};
    this.events = [];          // arrangement note-ons, sorted by time (beats)
    this.cursor = 0;
    this.active = new Map();   // note -> end (beats), from the sequencer
    this.live = new Map();     // note -> start (beats), keys / MIDI (for recording)
    this.gL = 0; this.gR = 0;
    this.peakL = 0; this.peakR = 0;
    this.msL = 0; this.msR = 0; this.msN = 0;
    this.lastAuto = {};
    this.lockBase = {}; this.lockUntil = -1;
    this.rack = new Rack();
    this.bufL = new Float32Array(BLOCK); this.bufR = new Float32Array(BLOCK);   // post-FX, pre-fader (sidechain key)
    this.busL = new Float32Array(BLOCK); this.busR = new Float32Array(BLOCK);   // a group's input
    this.slotEvents = [];      // per session slot: its notes, in [0, loop)
    this.sess = null;          // { slot, at } while a session clip plays
    this.queued = null;        // { slot, at } a launch (slot -1: a stop) waiting for its quantize
    this.chain = new NoteChain((on, n, v) => (on ? this.instOn(engine, n, v) : this.instOff(engine, n)));   // the note effects
    this.mods = []; this.modKeys = new Set(); this.modBase = {}; this.modLast = {};             // the modulators
  }
  // notes go through the track's note effects, then to the instrument
  noteOn(engine, n, v) { if (this.chain.empty) this.instOn(engine, n, v); else this.chain.noteOn(n, v); }
  noteOff(engine, n) { if (this.chain.empty) this.instOff(engine, n); else this.chain.noteOff(n); }
  instOn(engine, n, v) {
    for (const m of this.mods) m.note(true);
    if (this.mc && !this.mc.on(n, engine)) return;               // (multicore: this track's notes play in another thread)
    const pad = this.pads && this.def.pads?.[n];
    if (pad?.src) this.pads.padOn(pad, engine.assets.get(pad.src), n, v);   // your own sample on this pad
    else if (this.w) this.w.k_note(n, v, 1);
    else if (this.sampler) this.sampler.noteOn(this.def, engine.assets, n, v);
    else if (this.kind === 'external') engine.ext.push([this.id, 0x90, n, v]);
    else if (this.kind === 'wam') engine.wamOut(this.id, 0x90, n, v);
  }
  instOff(engine, n) {
    for (const m of this.mods) m.note(false);
    if (this.mc && !this.mc.off(n)) return;
    this.instEnd(engine, n);
  }
  instEnd(engine, n) {                                           // the instrument lets the note go
    if (this.pads && this.def.pads?.[n]?.src) return;
    if (this.w) this.w.k_note(n, 0, 0);
    else if (this.sampler) this.sampler.noteOff(n);
    else if (this.kind === 'external') engine.ext.push([this.id, 0x80, n, 0]);
    else if (this.kind === 'wam') engine.wamOut(this.id, 0x80, n, 0);
  }
  // a controller from a clip: sustain, mod wheel, pitch bend, pressure… to the instrument or the MIDI device
  control(engine, [st, d1, d2]) {
    if (this.w && this.kind !== 'drum') this.w.k_midi(st, d1, d2);
    else if (this.kind === 'external') engine.ext.push([this.id, st, d1, d2]);
    else if (this.kind === 'wam') engine.wamOut(this.id, st, d1, d2);
    this.ctlUsed = true;
  }
  allOff(engine) {
    if (this.ctlUsed) { this.control(engine, [0xb0, 64, 0]); this.control(engine, [0xe0, 0, 64]); this.ctlUsed = false; }   // (no pedal left down, no bend left bent)
    this.seqOff(engine);
    this.chain.reset();
  }
  seqOff(engine) {                                   // the sequencer's notes only: keys held live keep their arpeggio going
    for (const n of this.active.keys()) this.noteOff(engine, n);
    this.active.clear();
    this.unlock();
  }
  unlock() {
    if (!this.w) return;
    for (const id in this.lockBase) this.w.k_param(+id, this.lockBase[id]);
    this.lockBase = {}; this.lockUntil = -1;
  }
  readParams() {
    const v = new Array(this.nparams);
    for (let i = 0; i < this.nparams; i++) v[i] = this.w.k_get(i);
    return v;
  }
  // a note from the sequencer: its probability, its parameter locks, then the note
  trigger(engine, e, at) {
    if (e.c) { this.control(engine, e.c); return; }
    if (e.p < 1 && Math.random() >= e.p) return;
    if (e.l && this.w) {
      for (const id in e.l) { if (this.lockBase[id] === undefined) this.lockBase[id] = this.w.k_get(+id); this.w.k_param(+id, e.l[id]); }
      this.lockUntil = Math.max(this.lockUntil, at + e.d);
    }
    if (this.active.has(e.n)) this.noteOff(engine, e.n);
    this.noteOn(engine, e.n, e.v);
    this.active.set(e.n, at + e.d);
  }
  render(engine) {
    this.renderSound(engine);
    // an armed audio track: its input level, and the input itself through the track when monitoring
    const m = this.kind === 'audio' && engine.input && engine.monitor?.find((x) => x.id === this.id);
    if (m) {
      const inp = engine.input, a = inp[Math.min(m.a ?? 0, inp.length - 1)], b = m.b == null ? a : inp[Math.min(m.b, inp.length - 1)], o = this.out, off = engine.blockOff || 0;
      let pk = 0;
      for (let f = 0; f < BLOCK; f++) {
        const l = a[off + f] || 0, r = b[off + f] || 0;
        if (m.listen) { o[f * 2] += l; o[f * 2 + 1] += r; }
        const x = Math.max(Math.abs(l), Math.abs(r)); if (x > pk) pk = x;
      }
      this.inPeak = Math.max(this.inPeak || 0, pk);
    }
  }
  renderSound(engine) {
    const d = this.def;
    if (d.frozen) return this.playAudio(engine, [{ start: 0, len: 1e9, src: d.frozen.src, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0 }]);
    if (this.w) { this.w.k_render(); if (this.pads?.v.length) this.pads.render(null, this.out, true); return; }
    if (this.sampler) return this.sampler.render(d, this.out);
    if (this.kind === 'wam') {                                   // a plugin instrument: its sound, back from its slot
      const inp = this.wamInst >= 0 ? engine.wamIO?.ins[this.wamInst] : null, o = this.out, off = engine.blockOff || 0;
      if (!inp?.length) { o.fill(0); return; }
      const a = inp[0], b = inp[1] || a;
      for (let f = 0; f < BLOCK; f++) { o[f * 2] = a[off + f]; o[f * 2 + 1] = b[off + f]; }
      return;
    }
    if (this.kind === 'audio') {
      if (this.sess) {                                           // a session clip: looped from its launch
        const c = d.slots?.[this.sess.slot];
        if (!c) { this.out.fill(0); return; }
        const loop = c.loop || c.len, k = Math.floor((engine.pos - this.sess.at) / loop);
        return this.playAudio(engine, [0, 1].map((j) => ({ ...c, start: this.sess.at + (k + j) * loop, len: loop })));
      }
      // take folders play their comp, crossfades overlap their two clips: rebuilt when the project or the tempo changes
      if (this.playList?.clips !== d.clips || this.playList.bpm !== engine.bpm) {
        const list = [];
        for (const c of d.clips) if (isFolder(c)) list.push(...expandFolder(c, 60 / engine.bpm)); else list.push(c);
        this.playList = { clips: d.clips, bpm: engine.bpm, list: crossfaded(list, 60 / engine.bpm) };
      }
      return this.playAudio(engine, this.playList.list);
    }
    this.out.fill(0);                                            // groups and external tracks make no sound here
  }
  playAudio(engine, clips) {
    const o = this.out;
    o.fill(0);
    if (!engine.playing || engine.counting) return;
    const dt = BLOCK / RATE * engine.bpm / 60, pos = engine.pos, spb = 60 / engine.bpm * RATE;
    for (const c of clips) {
      const end = c.start + c.len;
      if (c.start >= pos + dt || end <= pos) continue;
      const a = engine.assets.get(c.src);
      if (!a) continue;
      const g = dbToGain(c.gain || 0), fin = Math.max(1, (c.fadeIn ?? 0.005) * RATE), fout = Math.max(1, (c.fadeOut ?? 0.005) * RATE);
      // RE-PITCH warp: the audio follows the tempo, its pitch with it (tape)
      const rate = c.warp === 'repitch' && c.bpm ? engine.bpm / c.bpm : 1;
      const clipFrames = c.len * spb, base = (c.offset || 0) * RATE;
      const f0 = Math.max(0, Math.ceil((c.start - pos) / dt * BLOCK)), f1 = Math.min(BLOCK, Math.ceil((end - pos) / dt * BLOCK));
      const L = a.L, R = a.R || a.L, n = L.length;
      // the clip's gain envelope: its gain at the block's two ends, a line between
      const env = c.env ? [f0, f1].map((f) => dbToGain(envAt(c.env, ((pos - c.start) * spb + f) / spb - (c.envOff || 0)))) : null;
      for (let f = f0; f < f1; f++) {
        const local = (pos - c.start) * spb + f;
        let sp = base + local * rate, k = g;
        if (c.aloop && n - base > 256) {                           // LOOP THE AUDIO: the file again from the clip's start, the seam faded
          const per = n - 1 - base, ph = (local * rate) % per;
          sp = base + ph;
          k *= Math.min(1, ph / 64, (per - ph) / 64);
        }
        const s0 = Math.floor(sp), fr = sp - s0;
        if (s0 < 0 || s0 + 1 >= n) continue;
        if (env) k *= env[0] + (env[1] - env[0]) * (f - f0) / Math.max(1, f1 - f0);
        if (local < fin) k *= local / fin;
        if (clipFrames - local < fout) k *= Math.max(0, (clipFrames - local) / fout);
        o[f * 2] += (L[s0] + (L[s0 + 1] - L[s0]) * fr) * k; o[f * 2 + 1] += (R[s0] + (R[s0 + 1] - R[s0]) * fr) * k;
      }
    }
  }
}

// crossfades: a clip with xf (beats) and the clip ending where it starts overlap by xf, centred on the seam, one fading
// out while the other fades in (each plays a little of its file beyond its edge)
export function crossfaded(list, spbSec) {
  if (!list.some((c) => c.xf > 0)) return list;
  const out = list.map((c) => ({ ...c }));
  for (const c of out) {
    if (!(c.xf > 0) || !c.src) continue;
    const prev = out.find((p) => p !== c && p.src && Math.abs(p.start + p.len - c.start) < 1e-6);
    if (!prev) continue;
    const h = c.xf / 2, sec = c.xf * spbSec, rate = (x) => (x.warp === 'repitch' && x.bpm ? 60 / x.bpm / spbSec : 1);
    prev.len += h; prev.fadeOut = sec;
    c.start -= h; c.len += h; c.fadeIn = sec; c.envOff = h; c.offset = (c.offset || 0) - h * spbSec * rate(c);
  }
  return out;
}

// the slot a follow action goes to: an index, -1 (stop), or null (nothing: keep playing)
export function followSlot(slots, i, act) {
  const full = slots.map((c, k) => (c ? k : -1)).filter((k) => k >= 0);
  if (!full.length) return -1;
  const j = full.indexOf(i);
  switch (act) {
    case 'next': return full[(j + 1) % full.length];
    case 'prev': return full[(j - 1 + full.length) % full.length];
    case 'first': return full[0];
    case 'last': return full[full.length - 1];
    case 'any': return full[Math.floor(Math.random() * full.length)];
    case 'other': { const o = full.filter((k) => k !== i); return o.length ? o[Math.floor(Math.random() * o.length)] : i; }
    case 'again': return i;
    case 'stop': return -1;
    default: return null;
  }
}

class Return {                                   // a return track: its effect, its rack, its fader
  constructor() { this.L = new Float32Array(BLOCK); this.R = new Float32Array(BLOCK); this.oL = new Float32Array(BLOCK); this.oR = new Float32Array(BLOCK); this.rack = new Rack(); this.peak = [0, 0]; this.kind = ''; }
  sync(def, bpm) {
    if (def.type !== this.kind) { this.kind = def.type; this.fx = def.type === 'reverb' ? new Reverb() : def.type === 'delay' ? new Delay() : null; }
    if (def.type === 'reverb') this.fx.set(def.size ?? 0.82, def.damp ?? 0.35, def.pre ?? 0.02);
    else if (def.type === 'delay') this.fx.set(def.time ?? 0.75, def.fb ?? 0.42, def.tone ?? 0.55, bpm);
    this.rack.sync(def.fx, bpm);
    this.def = def;
  }
}

// ------------------------------------------------------------------- engine ---
export class KrakenEngine {
  constructor(modules, post = () => {}) {
    this.modules = modules;    // { sloop: WebAssembly.Module, clipper: WebAssembly.Module }
    this.assets = new Map();   // audio: id -> { L, R } at RATE
    this.post = post;
    this.tracks = new Map();
    this.order = [];           // every track, in project order
    this.renderOrder = [];     // the same, without the groups, the sidechain keys first
    this.project = null;
    this.playing = false;
    this.recording = false;
    this.counting = false;     // a count-in bar before the start
    this.pos = 0;              // beats
    this.bpm = 120;
    this.sig = 4;
    this.loop = { on: false, a: 0, b: 16 };
    this.click = false;
    this.offline = false;
    this.soloTrack = null;     // export of a stem
    this.freezeTrack = null;   // freeze: that track's own sound, nothing else
    this.bounceTrack = null;   // bounce: that track after its effects, before its fader, nothing else
    this.soloReturn = null;    // export of a return's stem: what the tracks send it, through it, nothing else
    this.returns = [];
    this.masterRack = new Rack();
    this.mix = { L: new Float32Array(BLOCK), R: new Float32Array(BLOCK) };
    this.fxCtx = { bpm: 120, pos: 0, sidechain: (id) => { const t = this.tracks.get(id); return t ? t.pdc?.key || { L: t.bufL, R: t.bufR } : null; } };   // (a key waiting for plugins: heard before its wait)
    this.master = { env: 1, peakL: 0, peakR: 0 };
    this.lufs = new Lufs();
    this.levels = new Levels(BLOCK, RATE);   // true peak, RMS, correlation, clip lights
    this.clickPhase = 0; this.clickEnv = 0; this.clickFreq = 1000;
    this.blocksSinceMeter = 0;
    this.lastBeat = -1;
    this.ext = [];             // notes for external MIDI tracks, posted after each render
    this.slotMsgs = [];
    this.free = 0;             // a clock in beats that always runs: the note effects' time when stopped
    // plugins (WAM, wam.js): the routing plan from the page, the slots' audio for this render (set by the worklet),
    // the MIDI for plugin instruments ([track, frame, status, d1, d2], sent by the worklet after each render)
    this.wam = null; this.wamIO = null; this.wamMidi = [];
  }

  // ------------------------------------------------------------- project ---
  setProject(p, changed = null) {
    this.project = p;
    this.sig = p.sig || 4;
    this.meters = meterList(p);
    this.bpm = tempoAt(p, this.pos);
    this.loop = { ...p.loop };
    const ids = new Set(p.tracks.map((t) => t.id));
    for (const [id, tr] of this.tracks) if (!ids.has(id)) { tr.allOff(this); this.tracks.delete(id); }
    this.order = [];
    const swing = p.swing || 0;
    for (const def of p.tracks) {
      let tr = this.tracks.get(def.id);
      const bank = def.kind === 'drum' ? 'sloop' : def.kind === 'synth' ? def.bank : null;
      if (tr && (tr.kind !== def.kind || tr.bank !== bank)) { tr.allOff(this); tr = null; }
      if (!tr) { tr = new Track(this, def); this.tracks.set(def.id, tr); }
      const fresh = tr.def !== def || !changed || changed.has(def.id);
      tr.def = def;
      this.order.push(tr);
      if (!fresh) continue;                                     // unchanged: its events and sound stay as they are
      tr.rack.sync(def.fx, this.bpm);
      tr.chain.sync(def.nfx);
      this.syncMods(tr, def);
      if (tr.w) {
        this.applySound(tr, def);
        tr.w.k_bpm(Math.round(this.bpm));
        if (def.kind === 'synth' && tr.mpe !== (def.mpe || 0)) { tr.mpe = def.mpe || 0; tr.w.k_mpe(tr.mpe); }
      }
      if (def.kind === 'audio' || def.kind === 'group' || def.kind === 'vca') continue;
      const ev = [];
      for (const c of def.clips) { clipEvents(c, ev, { swing }); ctlEvents(c, ev); }
      ev.sort((a, b) => a.t - b.t || a.n - b.n);                 // (a controller before the notes at its time: n -1)
      tr.events = ev;
      tr.cursor = this.seekIndex(ev, this.pos);
      tr.slotEvents = (def.slots || []).map((c) => (c && c.notes ? ctlEvents(c, clipEvents(c, [], { start: 0, len: c.loop || c.len, swing }), { start: 0, len: c.loop || c.len }).sort((a, b) => a.t - b.t || a.n - b.n) : null));
    }
    // the groups, deepest first: a group's output can feed another group
    const depth = (t, k = 0) => { const parent = p.tracks.find((x) => x.id === t.out && x.kind === 'group'); return parent && k < 8 ? depth(parent, k + 1) + 1 : 0; };
    this.groups = this.order.filter((t) => t.kind === 'group').sort((a, b) => depth(b.def) - depth(a.def));
    // a compressor keyed by another track hears that track in the same block: the keys play first
    const keys = new Set();
    for (const t of p.tracks) for (const f of t.fx || []) if (f.type === 'comp' && f.p?.sc && f.on !== false) keys.add(f.p.sc);
    this.renderOrder = [...this.order.filter((t) => t.kind !== 'group' && t.kind !== 'vca' && keys.has(t.id)), ...this.order.filter((t) => t.kind !== 'group' && t.kind !== 'vca' && !keys.has(t.id))];   // (a VCA makes no sound)
    this.audibleCache = null;
    while (this.returns.length < p.returns.length) this.returns.push(new Return());
    this.returns.length = p.returns.length;
    p.returns.forEach((r, i) => this.returns[i].sync(r, this.bpm));
    this.masterRack.sync(p.master.fx, this.bpm);
    this.syncWam();
  }
  // ------------------------------------------------------------- plugins ---
  // the plugin routing (wam.js wamPlan): which slot each plugin instrument and each run of plugin effects uses; every
  // track then waits what it must for all to reach the master together (plugin delay compensation)
  setWam(plan) { this.wam = plan && Object.keys(plan.tracks || {}).length ? plan : null; this.syncWam(); }
  syncWam() {
    const plan = this.wam, delay = plan && this.project ? pdc(this.project, plan.lat).delay : {};
    for (const tr of this.order) {
      const x = plan?.tracks[tr.id], fx = tr.def.fx || [];
      tr.wamInst = tr.kind === 'wam' && x?.inst ? x.inst.slot : -1;
      // each run before the first Kraken device that follows it in the rack
      tr.wamRuns = x?.runs.length ? x.runs.map((r) => ({ slot: r.slot, at: fx.findIndex((d) => d.id === r.ids[0]) })).filter((r) => r.at >= 0).sort((a, b) => a.at - b.at) : null;
      if (tr.wamRuns) tr.rackAt = tr.rack.list.map((d) => fx.indexOf(d.def));
      const n = delay[tr.id] || 0;
      if (n !== (tr.pdc?.n || 0)) tr.pdc = n ? new Lag(n) : null;
    }
  }
  // a rack with plugins: its devices up to a run of plugins, out to them through the run's slot, back one quantum
  // later, on through the rest
  wamRack(tr, L, R, ctx) {
    const list = tr.rack.list, at = tr.rackAt, runs = tr.wamRuns;
    let r = 0;
    for (let k = 0; k < list.length; k++) {
      while (r < runs.length && runs[r].at < at[k]) this.wamTrip(runs[r++].slot, L, R);
      if (list[k].def.on !== false) list[k].process(L, R, BLOCK, ctx);
    }
    while (r < runs.length) this.wamTrip(runs[r++].slot, L, R);
  }
  wamTrip(slot, L, R) {
    const out = this.wamIO?.outs[slot], inp = this.wamIO?.ins[slot], off = this.blockOff || 0;
    if (!out) return;                                            // (not routed: the sound passes as it is)
    out[0].set(L, off); out[1]?.set(R, off);
    if (!inp?.length) return;                                    // (its plugin not connected yet: the same)
    const a = inp[0], b = inp[1] || a;
    for (let i = 0; i < BLOCK; i++) { L[i] = a[off + i]; R[i] = b[off + i]; }
  }
  wamOut(id, st, d1, d2) { if (this.wam?.tracks[id]?.inst) this.wamMidi.push([id, this.blockOff || 0, st, d1, d2]); }
  // a change from the UI: only what moved (the tracks it names, the top of the project) is rebuilt
  patch(m) {
    const p = this.project;
    if (!p || m.full) return this.setProject(m.p);
    Object.assign(p, m.top);
    const byId = new Map(p.tracks.map((t) => [t.id, t]));
    for (const [id, def] of Object.entries(m.tracks || {})) byId.set(id, def);
    p.tracks = m.order.map((id) => byId.get(id)).filter(Boolean);
    this.setProject(p, new Set(Object.keys(m.tracks || {})));
  }
  applySound(tr, def) {
    const key = def.kind === 'drum' ? `kit:${def.kit}` : `${def.bank}:${def.engine}:${def.preset}:${def.rev || 0}:${def.dx7?.name || ''}`;
    if (key !== tr.soundKey) {
      tr.allOff(this);
      if (def.kind === 'drum') tr.w.k_kit(def.kit);
      else {
        tr.w.k_preset(def.engine, def.preset);
        tr.w.k_render(); tr.w.k_render();                         // (the preset's panic passes now, not on the next note)
        if (def.dx7?.data) {                                     // a DX7 voice on FM6
          for (let i = 0; i < 20; i++) tr.w.k_render();          // (the preset's patch lands first)
          const bytes = Uint8Array.from(atob(def.dx7.data), (c) => c.charCodeAt(0));
          new Uint8Array(tr.w.memory.buffer, tr.w.k_buffer(), 128).set(bytes.subarray(0, 128));
          tr.w.k_fm6();
        }
      }
      tr.soundKey = key;
      tr.params = {}; tr.modBase = {}; tr.modLast = {};
      if (!this.offline) this.post({ t: 'params', track: tr.id, values: tr.readParams() });
    }
    for (const k in def.params) {
      if (tr.params[k] !== def.params[k]) { tr.w.k_param(+k, def.params[k]); tr.params[k] = def.params[k]; }
    }
  }
  // the modulators of a track; a target no longer modulated goes back to its knob
  syncMods(tr, def) {
    const old = new Map(tr.mods.map((m) => [m.id, m]));
    tr.mods = (def.mods || []).map((d) => { let m = old.get(d.id); if (!m || m.type !== d.type) m = new Modulator(d); else m.set(d); return m; });
    const keys = new Set();
    for (const d of def.mods || []) if (d.on !== false) for (const t of d.to || []) keys.add(t.key);
    for (const k of tr.modKeys) if (!keys.has(k)) {
      if (k.startsWith('fx:')) { const [, id, pk] = k.split(':'); tr.rack.release(id, pk, this.bpm); }
      else if (k[0] === 'p' && tr.w) { const id = +k.slice(1), v = def.params[id] ?? tr.modBase[id]; if (v != null) tr.w.k_param(id, v); delete tr.modLast[id]; }
    }
    tr.modKeys = keys;
  }
  modulate(tr, clock, dt, sec) {
    tr.modVol = tr.modPan = tr.modSend = undefined;
    if (!tr.mods.length) return;
    const d = tr.def, sums = new Map();
    for (const m of tr.mods) {
      let key = 0;
      if (m.type === 'follow') {
        const src = this.tracks.get(m.def.src || tr.id);
        if (src) { let pk = 0; for (let i = 0; i < BLOCK; i++) { const a = Math.abs(src.bufL[i]) + Math.abs(src.bufR[i]); if (a > pk) pk = a; } key = pk * 0.5; }
      }
      const v = m.step(clock, dt, sec, key);
      if (!m.on) continue;
      for (const t of m.def.to || []) { const s = sums.get(t.key); if (s) s.d += v * t.amt; else sums.set(t.key, { d: v * t.amt, lo: t.lo, hi: t.hi }); }
    }
    const playing = this.playing && !this.counting, autoV = (key) => (playing && d.auto?.[key]?.length ? autoAt(d.auto[key], this.pos) : undefined);
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    for (const [key, { d: delta, lo, hi }] of sums) {
      if (key === 'vol') tr.modVol = clamp((tr.autoVol ?? d.vol) + delta * 66, -60, 6);
      else if (key === 'pan') tr.modPan = clamp((tr.autoPan ?? d.pan) + delta * 2, -1, 1);
      else if (key.startsWith('send')) { tr.modSend ??= [...(tr.autoSend || d.sends || [])]; const i = +key.slice(4); tr.modSend[i] = clamp((tr.modSend[i] || 0) + delta, 0, 1); }
      else if (key[0] === 'p') {
        if (!tr.w) continue;
        const id = +key.slice(1);
        if (tr.lockBase[id] !== undefined) continue;                  // a parameter lock has it for now
        const base = autoV(key) ?? d.params[id] ?? (tr.modBase[id] ??= tr.w.k_get(id));
        const a = lo ?? 0, b = hi ?? 127, v = Math.round(clamp(base + delta * (b - a), a, b));
        if (tr.modLast[id] !== v) { tr.modLast[id] = v; tr.w.k_param(id, v); }
      } else if (key.startsWith('fx:')) {
        const v = applyMod(key, autoV(key), delta, d);
        if (v != null) { const [, fxId, pk] = key.split(':'); tr.rack.automate(fxId, pk, v, this.bpm); }
      } else if (key.startsWith('nfx:')) {
        const v = applyMod(key, autoV(key), delta, d);
        if (v != null) { const [, fxId, pk] = key.split(':'); tr.chain.automate(fxId, pk, v); }
      }
    }
  }
  seekIndex(ev, t) {
    let lo = 0, hi = ev.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].t < t - 1e-9) lo = m + 1; else hi = m; }
    return lo;
  }

  // ------------------------------------------------------------ transport ---
  play(countIn = false) {
    if (!this.playing) { this.lufs.reset(); this.levels.resetPeak(); }
    this.playing = true; this.lastBeat = -1;
    if (countIn) { this.countTo = this.pos; this.pos -= this.project ? barOf(this.project, this.pos, this.meters).len : this.sig; this.counting = true; }
  }
  stop() {
    if (!this.playing) { this.seek(this.loop.on ? this.loop.a : 0); }
    if (this.counting) { this.pos = this.countTo; this.counting = false; }
    this.playing = false;
    this.flushRecording();
    for (const tr of this.order) { tr.allOff(this); if (tr.queued) tr.queued = null; }
  }
  seek(beat, wrap = false) {
    this.pos = Math.max(0, beat);
    this.counting = false;
    for (const tr of this.order) {
      if (wrap) { tr.seqOff(this); if (tr.ctlUsed) { tr.control(this, [0xb0, 64, 0]); tr.control(this, [0xe0, 0, 64]); } } else tr.allOff(this);
      tr.cursor = this.seekIndex(tr.events, this.pos);
      // the controllers as they stand here (a pedal held down since before, a wheel left up): sent again
      const last = new Map();
      for (let i = 0; i < tr.cursor; i++) { const e = tr.events[i]; if (e.c) last.set(e.c[0] === 0xb0 ? 0xb000 + e.c[1] : e.c[0], e); }
      for (const e of last.values()) tr.control(this, e.c);
    }
    this.lastBeat = -1;
  }
  panic() { for (const tr of this.order) { tr.allOff(this); tr.w?.k_panic(); tr.sampler && (tr.sampler.v = []); tr.pads && (tr.pads.v = []); if (tr.kind === 'wam') this.wamOut(tr.id, 0xb0, 123, 0); } }
  punchOpen() { const pu = this.project?.punch; return !pu?.on || (this.pos >= pu.a && this.pos < pu.b); }

  // ---------------------------------------------------------------- session ---
  launch(trackId, slot, now = false) {
    const tr = this.tracks.get(trackId);
    if (!tr) return;
    const q = this.project.launchQ ?? 4;
    if (!this.playing) { this.play(); now = true; }
    const at = now || !q ? this.pos : Math.ceil((this.pos - 1e-6) / q) * q;
    tr.queued = { slot, at };
  }
  scene(slot) { for (const tr of this.order) if (tr.def.slots?.[slot] || tr.sess) this.launch(tr.id, tr.def.slots?.[slot] ? slot : -1); }
  stopAll() { for (const tr of this.order) if (tr.sess || tr.queued) this.launch(tr.id, -1); }
  sessionBlock(tr, end) {
    if (tr.queued && tr.queued.at < end) {
      const { slot, at } = tr.queued;
      tr.queued = null;
      tr.allOff(this);
      tr.sess = slot >= 0 && tr.def.slots?.[slot] ? { slot, at } : null;
      this.slotMsgs.push({ track: tr.id, slot: tr.sess ? slot : -1, at });
    }
    const s = tr.sess;
    // a follow action: after its clip has played n times, the next launch (next, previous, first, last, any, another,
    // again, stop; a second action by chance), queued just ahead so it starts on its beat
    const fc = s && tr.def.slots?.[s.slot];
    if (fc?.follow && !tr.queued && !s.fired) {
      const loop = fc.loop || fc.len, at = s.at + Math.max(Math.max(1, fc.follow.n || 1), Math.ceil((this.pos - s.at - 1e-6) / loop)) * loop;   // (set late: the next turn)
      if (at - this.pos < 0.5) { s.fired = true; tr.queued = { slot: followSlot(tr.def.slots, s.slot, Math.random() < (fc.follow.p ?? 1) ? fc.follow.a : (fc.follow.b || 'none')), at }; if (tr.queued.slot === null) tr.queued = null; }
    }
    if (!s || !tr.slotEvents?.[s.slot]) return;
    const c = tr.def.slots[s.slot], loop = c.loop || c.len, ev = tr.slotEvents[s.slot];
    const l0 = this.pos - s.at, l1 = end - s.at;
    if (l1 <= 0) return;
    const k0 = Math.floor(Math.max(0, l0) / loop), k1 = Math.floor((l1 - 1e-9) / loop);
    for (let k = k0; k <= k1; k++) {
      const a = Math.max(0, l0) - k * loop, b = l1 - k * loop;
      for (const e of ev) if (e.t >= a - 1e-9 && e.t < b) tr.trigger(this, e, s.at + k * loop + e.t);
    }
  }

  // a controller played live (sustain, wheels, pressure): to the instrument, and recorded when recording
  liveCtl(id, st, d1, d2) {
    const tr = this.tracks.get(id);
    if (!tr) return;
    tr.w?.k_midi(st, d1, d2);
    if (tr.kind === 'wam') this.wamOut(id, st, d1, d2);
    const kind = st & 0xf0;
    if (this.recording && this.playing && !this.counting && (kind === 0xb0 || kind === 0xe0 || kind === 0xd0)) this.post({ t: 'recctl', track: id, ev: { t: this.pos, st: kind, d1, d2 } });
  }
  // live notes (keys, MIDI); recorded when recording and playing (into the playing session clip, if any)
  liveNote(id, n, v, on, silent = false, preview = false) {   // (preview: a sound auditioned, never recorded)
    const tr = this.tracks.get(id);
    if (!tr) return;
    if (on) {
      if (!silent) tr.noteOn(this, n, v);
      if (!preview && this.playing && this.recording && !this.counting && this.punchOpen()) tr.live.set(n, { t: this.pos, v });
    } else {
      if (!silent) tr.noteOff(this, n);
      const s = tr.live.get(n);
      if (s) {
        tr.live.delete(n);
        let d = this.pos - s.t;
        if (d <= 0) d += this.loop.b - this.loop.a;
        this.recNote(tr, { t: s.t, d: Math.max(0.02, d), n, v: s.v });
      }
    }
  }
  recNote(tr, note) {
    const s = tr.sess;
    if (s) {                                                     // session overdub: into the playing slot
      const c = tr.def.slots[s.slot], loop = c.loop || c.len;
      this.post({ t: 'rec', track: tr.id, slot: s.slot, note: { ...note, t: ((note.t - s.at) % loop + loop) % loop } });
    } else this.post({ t: 'rec', track: tr.id, note: { ...note, pass: this.recPass || 0 } });   // (pass: the loop's turn, for takes)
  }
  flushRecording() {
    for (const tr of this.order) {
      for (const [n, s] of tr.live) this.recNote(tr, { t: s.t, d: Math.max(0.02, this.pos - s.t), n, v: s.v });
      tr.live.clear();
    }
  }
  // the tracks heard: mute and solo, through the groups (a soloed group plays its tracks, a soloed track its groups)
  audible() {
    const p = this.project, by = new Map(p.tracks.map((t) => [t.id, t]));
    const up = (t) => { const out = []; let x = by.get(t.out); let k = 0; while (x && k++ < 8) { out.push(x); x = by.get(x.out); } return out; };
    const anySolo = p.tracks.some((t) => t.solo && t.kind !== 'vca');   // (a VCA has no sound to solo)
    const res = new Map();
    for (const t of p.tracks) {
      const anc = up(t);
      let on = !t.mute && !anc.some((g) => g.mute);
      if (anySolo) on = on && (t.solo || anc.some((g) => g.solo) || p.tracks.some((c) => c.solo && up(c).includes(t)));
      res.set(t.id, on);
    }
    return res;
  }

  // ----------------------------------------------------------------- audio ---
  render(L, R) {
    for (let off = 0; off < L.length; off += BLOCK) this.block(L, R, off);
    this.blockOff = 0;                                           // (a live note before the next render: its start)
    if (this.ext.length && !this.offline) { this.post({ t: 'ext', ev: this.ext }); this.ext = []; }
    if (this.slotMsgs.length) { if (!this.offline) this.post({ t: 'slot', ev: this.slotMsgs }); this.slotMsgs = []; }
  }
  block(L, R, off) {
    this.blockOff = off;
    const p = this.project;
    if (!p) { L.fill(0, off, off + BLOCK); R.fill(0, off, off + BLOCK); return; }
    const bpm = tempoAt(p, Math.max(0, this.pos));
    if (Math.abs(bpm - this.bpm) > 1e-6) {
      this.bpm = bpm;
      for (const tr of this.order) tr.w?.k_bpm(Math.round(bpm));
      this.returns.forEach((r, i) => r.sync(p.returns[i], bpm));
    }
    const dt = BLOCK / RATE * this.bpm / 60;
    if (this.playing) this.sequence(dt);
    // the note effects' time: the song's while it plays (an arpeggio on the grid, the same in an export)
    const song = this.playing && !this.counting, t0 = song ? this.pos : this.free;
    for (const tr of this.order) if (!tr.chain.empty) tr.chain.tick(t0, t0 + dt);
    this.applyMacros();
    for (const tr of this.order) if (tr.mods.length || tr.modVol !== undefined) this.modulate(tr, t0, dt, BLOCK / RATE);
    this.free += dt;
    // instruments, racks, faders, sends, groups
    const mL = this.mix.L, mR = this.mix.R;
    mL.fill(0); mR.fill(0);
    for (const r of this.returns) { r.L.fill(0); r.R.fill(0); }
    for (const g of this.groups) { g.busL.fill(0); g.busR.fill(0); }
    const aud = this.audibleCache || (this.audibleCache = this.audible());
    const ctx = this.fxCtx; ctx.bpm = this.bpm; ctx.pos = this.pos;
    // multicore (multicore-core.js), per track: 1 it plays here; 2 only what still rings here (its notes went to another
    // thread: an audio track's clips stop, its effects ring out); 0 not here
    const mc = this.mc;
    if (mc) mc.begin();
    this.blockN = (this.blockN || 0) + 1;
    const strip = (tr) => {
      const d = tr.def, bL = tr.bufL, bR = tr.bufR, own = mc ? mc.own(tr) : 1;
      if (tr.kind === 'group') { bL.set(tr.busL); bR.set(tr.busR); }
      else if (own) { if (own === 2 && tr.kind === 'audio') tr.out.fill(0); else tr.render(this); const o = tr.out; for (let i = 0; i < BLOCK; i++) { bL[i] = o[i * 2]; bR[i] = o[i * 2 + 1]; } }
      else { bL.fill(0); bR.fill(0); }
      if (this.freezeTrack) {                                    // freeze: the track's own sound, alone, pre-rack
        if (tr.id === this.freezeTrack) for (let i = 0; i < BLOCK; i++) { mL[i] += bL[i]; mR[i] += bR[i]; }
        return;
      }
      // (in a Web Worker, where the processor does not flush denormal numbers to zero as audio threads do, a silent
      // track's effects would decay into them and run several times slower: a tiny square wave, -480 dB, keeps them out)
      if (this.antiDenormal && own) { const x = this.blockN & 1 ? this.antiDenormal : -this.antiDenormal; for (let i = 0; i < BLOCK; i++) { bL[i] += x; bR[i] += x; } }
      if (own) { if (tr.wamRuns) this.wamRack(tr, bL, bR, ctx); else tr.rack.process(bL, bR, BLOCK, ctx); }
      if (mc && mc.take(tr, bL, bR, own)) return;                // (a worker: into its ring, no mix; the worklet: the workers' sound added)
      tr.pdc?.run(bL, bR, BLOCK);                                // (plugin delay compensation)
      if (this.bounceTrack) {                                    // bounce: the track with its effects, alone (in time: the render cuts the delay)
        if (tr.id === this.bounceTrack) for (let i = 0; i < BLOCK; i++) { mL[i] += bL[i]; mR[i] += bR[i]; }
        return;
      }
      let on = aud.get(tr.id);
      if (this.soloTrack) on = tr.id === this.soloTrack || (tr.kind === 'group' && this.isAncestor(tr.id, this.soloTrack));
      let vol = tr.modVol ?? tr.autoVol ?? d.vol;
      const pan = tr.modPan ?? tr.autoPan ?? d.pan;
      const vca = d.vca && this.tracks.get(d.vca);               // a VCA moves its tracks' faders (and mutes them)
      if (vca && vca.kind === 'vca') { vol += (vca.modVol ?? vca.autoVol ?? vca.def.vol); if (vca.def.mute) on = false; }
      const g = on ? dbToGain(vol) : 0, a = (pan + 1) * Math.PI / 4;
      const tl = g * Math.cos(a) * Math.SQRT2, trg = g * Math.sin(a) * Math.SQRT2;
      const sl0 = tr.gL, sr0 = tr.gR;
      const parent = d.out && this.tracks.get(d.out);
      const solo = this.soloReturn != null, sink = solo ? (this.sinkL ||= [new Float32Array(BLOCK), new Float32Array(BLOCK)]) : null;   // (a return's stem: the tracks only feed it)
      const dL = parent && parent.kind === 'group' ? parent.busL : solo ? sink[0] : mL, dR = parent && parent.kind === 'group' ? parent.busR : solo ? sink[1] : mR;
      let pl = 0, pr = 0, el = 0, er = 0;
      for (let i = 0; i < BLOCK; i++) {
        const k = (i + 1) / BLOCK, l = bL[i] * (sl0 + (tl - sl0) * k), r = bR[i] * (sr0 + (trg - sr0) * k);
        dL[i] += l; dR[i] += r;
        el += l * l; er += r * r;
        if (l > pl) pl = l; else if (-l > pl) pl = -l;
        if (r > pr) pr = r; else if (-r > pr) pr = -r;
      }
      tr.gL = tl; tr.gR = trg;
      tr.peakL = Math.max(tr.peakL, pl); tr.peakR = Math.max(tr.peakR, pr);
      tr.msL += el; tr.msR += er; tr.msN += BLOCK;                // (its RMS, for the mixer's meters)
      if (this.soloTrack && tr.id !== this.soloTrack) return;
      const sends = tr.modSend || tr.autoSend || d.sends || [];
      for (let s = 0; s < this.returns.length; s++) {
        const amt = (sends[s] || 0) * (on ? 1 : 0);
        if (amt <= 0) continue;
        const r = this.returns[s], pre = d.sendPre?.[s];
        const sl = (pre ? 1 : tl) * amt, sr = (pre ? 1 : trg) * amt;
        for (let i = 0; i < BLOCK; i++) { r.L[i] += bL[i] * sl; r.R[i] += bR[i] * sr; }
      }
    };
    for (const tr of this.renderOrder) strip(tr);
    if (mc?.part) { this.advance(dt); return; }                // (a multicore worker: its tracks only, no mix)
    for (const g of this.groups) strip(g);
    if (!this.freezeTrack && !this.bounceTrack) {
      // returns
      this.returns.forEach((r, s) => {
        const def = p.returns[s];
        r.oL.fill(0); r.oR.fill(0);
        if (r.fx) r.fx.process(r.L, r.R, r.oL, r.oR, BLOCK); else { r.oL.set(r.L); r.oR.set(r.R); }
        r.rack.process(r.oL, r.oR, BLOCK, ctx);
        const g = def.mute || this.soloTrack || (this.soloReturn != null && this.soloReturn !== s) ? 0 : dbToGain(def.vol);
        let pl = 0, pr = 0;
        for (let i = 0; i < BLOCK; i++) { const l = r.oL[i] * g, rr = r.oR[i] * g; mL[i] += l; mR[i] += rr; pl = Math.max(pl, Math.abs(l)); pr = Math.max(pr, Math.abs(rr)); }
        r.peak[0] = Math.max(r.peak[0], pl); r.peak[1] = Math.max(r.peak[1], pr);
      });
      this.masterRack.process(mL, mR, BLOCK, ctx);
    }
    // master: fader, glue limiter (fast attack, smooth release) to its ceiling (p.master.limit: on, -0.3 dB by
    // default); then the meters, then the click on top. Off, the mix passes as it is, overs and all, never a NaN.
    const raw = this.freezeTrack || this.bounceTrack, lim = p.master.limit, limOn = !raw && lim?.on !== false;
    const cdb = Number.isFinite(lim?.ceil) ? Math.max(-6, Math.min(0, lim.ceil)) : -0.3;
    const mg = raw ? 1 : dbToGain(p.master.vol), ceil = Math.pow(10, cdb / 20);
    let env = this.master.env, pl = 0, pr = 0, bad = false;
    if (limOn) {
      for (let i = 0; i < BLOCK; i++) {
        let l = mL[i] * mg, r = mR[i] * mg;
        if (l - l !== 0) { l = 0; bad = true; }                   // (NaN or infinite: silence)
        if (r - r !== 0) { r = 0; bad = true; }
        const peak = Math.max(Math.abs(l), Math.abs(r)), want = peak > ceil ? ceil / peak : 1;
        env = want < env ? want : env + (want - env) * 0.0004;
        if (env > 1) env = 1;
        mL[i] = l * env; mR[i] = r * env;
      }
    } else {
      env = 1;
      for (let i = 0; i < BLOCK; i++) {
        let l = mL[i] * mg, r = mR[i] * mg;
        if (l - l !== 0) { l = 0; bad = true; }
        if (r - r !== 0) { r = 0; bad = true; }
        mL[i] = l; mR[i] = r;
      }
    }
    if (bad && !this.badReported && !this.offline) { this.badReported = true; this.post({ t: 'error', message: 'An effect or instrument produced an invalid sample: muted it.' }); }
    if (!this.offline) { this.lufs.push(mL, mR, BLOCK, this.playing && !this.counting); this.levels.push(mL, mR, BLOCK); }
    for (let i = 0; i < BLOCK; i++) {
      let l = mL[i], r = mR[i];
      pl = Math.max(pl, Math.abs(l)); pr = Math.max(pr, Math.abs(r));
      if (this.clickEnv > 0.0005) {
        const c = Math.sin(this.clickPhase) * this.clickEnv * 0.3;
        this.clickPhase += TAU * this.clickFreq / RATE; this.clickEnv *= 0.9975;
        l += c; r += c;
      }
      L[off + i] = l; R[off + i] = r;
    }
    this.master.env = env;
    this.master.peakL = Math.max(this.master.peakL, pl); this.master.peakR = Math.max(this.master.peakR, pr);
    this.advance(dt);
  }
  advance(dt) {                                                  // the song moves on one block (and the meters, now and then)
    if (this.playing) {
      this.pos += dt;
      if (this.counting && this.pos >= this.countTo - 1e-9) { this.counting = false; this.pos = this.countTo; }
    }
    if (!this.offline && ++this.blocksSinceMeter >= 46) this.report();
  }
  isAncestor(groupId, trackId) {
    const by = this.tracks;
    let x = by.get(trackId)?.def.out, k = 0;
    while (x && k++ < 8) { if (x === groupId) return true; x = by.get(x)?.def.out; }
    return false;
  }
  sequence(dt) {
    if (!this.counting && this.loop.on && this.pos >= this.loop.b - 1e-9) { this.flushWrap(); this.seek(this.loop.a, true); if (this.recording) this.recPass = (this.recPass || 0) + 1; }
    const end = this.pos + dt;
    for (const tr of this.order) {
      for (const [n, e] of tr.active) if (e <= end) { tr.noteOff(this, n); tr.active.delete(n); }
      if (tr.lockUntil >= 0 && this.pos >= tr.lockUntil && !tr.active.size) tr.unlock();
      if (this.counting || tr.def.frozen) continue;              // a frozen track plays its audio, nothing to trigger
      this.sessionBlock(tr, end);
      const ev = tr.events;
      while (tr.cursor < ev.length && ev[tr.cursor].t < end) {
        const e = ev[tr.cursor++];
        if (e.t < this.pos - 1e-6 || tr.sess) continue;          // a session clip has the track
        tr.trigger(this, e, e.t);
      }
      this.automate(tr);
    }
    // metronome (live only; always during the count-in)
    if ((this.click || this.counting) && !this.offline) {
      // the signature's own beats (eighths in 7/8), the first of each bar higher
      let b;
      if (this.pos >= 0) b = barOf(this.project, this.pos, this.meters);
      else { const c = barOf(this.project, this.countTo || 0, this.meters); b = { start: (this.countTo || 0) - c.len, d: c.d }; }
      const unit = 4 / b.d, k = Math.floor((this.pos - b.start) / unit + 1e-9), tick = b.start + k * unit, key = Math.round(tick * 960);
      if (key !== this.lastBeat && this.pos - tick < dt) { this.clickEnv = 1; this.clickFreq = k === 0 ? 1600 : 1000; }
      this.lastBeat = key;
    }
  }
  report() {
    this.blocksSinceMeter = 0;
    const tracks = {}, sess = {}, mods = {}, inputs = {};
    for (const tr of this.order) {
      const n = tr.msN || 1;
      tracks[tr.id] = [tr.peakL, tr.peakR, Math.sqrt(tr.msL / n), Math.sqrt(tr.msR / n)]; tr.peakL = tr.peakR = tr.msL = tr.msR = tr.msN = 0;
      if (tr.inPeak != null) { inputs[tr.id] = tr.inPeak; tr.inPeak = 0; }
      if (tr.sess || tr.queued) sess[tr.id] = { slot: tr.sess?.slot ?? -1, at: tr.sess?.at, queued: tr.queued?.slot, qat: tr.queued?.at };
      if (tr.mods.length) mods[tr.id] = tr.mods.map((m) => Math.round(m.value * 1000) / 1000);
    }
    const gr = {};
    const grOf = (rack) => { for (const d of rack.list) if (d.gr !== undefined && (d.type === 'comp' || d.type === 'limiter' || d.type === 'gate' || d.type === 'mband' || d.type === 'deess')) gr[d.def.id] = d.gr; };
    for (const tr of this.order) grOf(tr.rack);
    this.returns.forEach((r) => grOf(r.rack)); grOf(this.masterRack);
    const l = this.lufs;
    this.post({ t: 'tick', inputs, pos: this.pos, seq: this.seekSeq || 0, playing: this.playing, counting: this.counting, bpm: this.bpm, tracks, gr, sess, mods,
      master: [this.master.peakL, this.master.peakR, 1 - this.master.env],
      lufs: [l.momentary, l.short, l.integrated, l.range],
      meter: this.levels.read(),
      returns: this.returns.map((r) => { const x = [...r.peak]; r.peak = [0, 0]; return x; }) });
    this.master.peakL = this.master.peakR = 0;
  }
  // the meters' buttons: the clip lights, or the loudness and true-peak maximum (as at play)
  resetMeters(what) {
    if (what === 'clip') this.levels.resetClip();
    else { this.lufs.reset(); this.levels.resetPeak(); }
  }
  flushWrap() {                                // the loop wraps: held recorded notes end at the loop's end
    if (!this.recording) return;
    for (const tr of this.order) {
      for (const [n, s] of tr.live) {
        this.recNote(tr, { t: s.t, d: Math.max(0.02, this.loop.b - s.t), n, v: s.v });
        tr.live.set(n, { t: this.loop.a, v: s.v });
      }
    }
  }
  // the project's macros: each target set from its macro (its automation lane while playing, else its knob), from lo to
  // hi; a parameter its track automates itself keeps its automation; a target let go goes back to its knob
  applyMacros() {
    const p = this.project, ms = p.macros;
    const now = new Map();                                       // track id -> Map(key -> value)
    if (ms) for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m.to?.length) continue;
      const pts = p.macroAuto?.[`m${i}`];
      const v = this.playing && !this.counting && pts?.length ? autoAt(pts, this.pos) : m.v;
      for (const tg of m.to) {
        const tr = this.tracks.get(tg.track);
        if (!tr || (this.playing && tr.def.auto?.[tg.key]?.length)) continue;
        let x = now.get(tr.id); if (!x) now.set(tr.id, (x = new Map()));
        x.set(tg.key, tg.lo + (tg.hi - tg.lo) * v);
      }
    }
    for (const tr of this.order) {
      const set = now.get(tr.id), was = tr.macroKeys;
      if (!set && !was) continue;
      if (was) for (const key of was) if (!set?.has(key)) this.macroRelease(tr, key);
      tr.macroKeys = set ? new Set(set.keys()) : null;
      if (set) for (const [key, v] of set) this.macroSet(tr, key, v);
    }
  }
  macroSet(tr, key, v) {
    if (key === 'vol') tr.autoVol = v;
    else if (key === 'pan') tr.autoPan = v;
    else if (key.startsWith('send')) { tr.autoSend ??= [...(tr.def.sends || [])]; tr.autoSend[+key.slice(4)] = v; }
    else if (key.startsWith('fx:')) { const [, id, pk] = key.split(':'); tr.rack.automate(id, pk, v, this.bpm); }
    else if (key.startsWith('nfx:')) { const [, id, pk] = key.split(':'); tr.chain.automate(id, pk, v); }
    else if (key[0] === 'p' && tr.w) {
      const id = +key.slice(1), iv = Math.round(v);
      if (tr.lockBase[id] === undefined && tr.lastAuto[id] !== iv) { tr.modBase[id] ??= tr.w.k_get(id); tr.lastAuto[id] = iv; tr.w.k_param(id, iv); }
    }
  }
  macroRelease(tr, key) {
    const d = tr.def;
    if (key === 'vol') tr.autoVol = undefined;
    else if (key === 'pan') tr.autoPan = undefined;
    else if (key.startsWith('send')) tr.autoSend = undefined;
    else if (key.startsWith('fx:')) { const [, id, pk] = key.split(':'); tr.rack.release(id, pk, this.bpm); }
    else if (key.startsWith('nfx:')) { const [, id, pk] = key.split(':'), v = d.nfx?.find((x) => x.id === id)?.p?.[pk]; if (v != null) tr.chain.automate(id, pk, v); }
    else if (key[0] === 'p' && tr.w) { const id = +key.slice(1), v = d.params[id] ?? tr.modBase[id]; if (v != null) tr.w.k_param(id, v); delete tr.lastAuto[id]; }
  }
  automate(tr) {
    const a = tr.def.auto;
    tr.autoVol = tr.autoPan = undefined; tr.autoSend = undefined;
    if (!a) return;
    for (const key in a) {
      const pts = a[key];
      if (!pts || !pts.length) continue;
      const v = autoAt(pts, this.pos);
      if (key === 'vol') tr.autoVol = v;
      else if (key === 'pan') tr.autoPan = v;
      else if (key.startsWith('send')) { tr.autoSend ??= [...(tr.def.sends || [])]; tr.autoSend[+key.slice(4)] = v; }
      else if (key.startsWith('fx:')) { const [, fxId, pk] = key.split(':'); tr.rack.automate(fxId, pk, v, this.bpm); }
      else if (key.startsWith('nfx:')) { const [, fxId, pk] = key.split(':'); tr.chain.automate(fxId, pk, v); }
      else if (key[0] === 'p') {
        const id = +key.slice(1), iv = Math.round(v);
        if (tr.w && tr.lastAuto[id] !== iv && tr.lockBase[id] === undefined) { tr.lastAuto[id] = iv; tr.w.k_param(id, iv); }
      }
    }
  }
}
