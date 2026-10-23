// SPDX-License-Identifier: GPL-3.0-only
// Kraken audio engine core. Runs in the AudioWorklet (live), in an OfflineAudioContext (export)
// and under Node (tests). No DOM, no Web Audio: blocks of BLOCK frames in, stereo floats out.
//
// Tracks: SLOOP / Clipper instruments (one WebAssembly instance each), drums, audio, sampler,
// external MIDI (a hardware synth, the FM-1) and groups (buses). Clips play from the arrangement or,
// launched, from the session's slots. Racks of effects, sends to any number of returns, the master
// with its loudness meter. Tempo map, swing, count-in, punch; per note probability, ratchets,
// micro-timing and parameter locks, the way SLOOP's sequencer plays them.

import { Reverb, Delay, Rack, Biquad } from './fx.js';

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

function autoAt(points, t) {                     // linear automation, held before / after
  if (!points || !points.length) return null;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) if (t < points[i].t) { const a = points[i - 1], b = points[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t)); }
  return points[points.length - 1].v;
}

// --------------------------------------------------------------- loudness ---
// EBU R128 / ITU-R BS.1770: K-weighting, momentary (400 ms), short-term (3 s), integrated (gated)
export class Lufs {
  constructor() {
    this.pre = new Biquad(); this.pre.set('high', 1681.97, 0.7072, 4.0);
    this.rlb = new Biquad(); this.rlb.set('hp', 38.13, 0.5003);
    this.l = new Float32Array(BLOCK); this.r = new Float32Array(BLOCK);
    this.reset();
  }
  reset() { this.acc = 0; this.n = 0; this.steps = []; this.blocks = []; }
  push(L, R, n) {
    const l = this.l, r = this.r;
    for (let i = 0; i < n; i++) { l[i] = L[i]; r[i] = R[i]; }
    this.pre.run(l, r, n); this.rlb.run(l, r, n);
    for (let i = 0; i < n; i++) this.acc += l[i] * l[i] + r[i] * r[i];
    this.n += n;
    if (this.n >= 4410) {                        // 100 ms steps
      this.steps.push(this.acc / this.n); this.acc = 0; this.n = 0;
      if (this.steps.length > 30) this.steps.shift();
      if (this.steps.length >= 4) this.blocks.push(this.mean(4));
    }
  }
  mean(k) { const s = this.steps.slice(-k); return s.reduce((a, b) => a + b, 0) / s.length; }
  static lu(ms) { return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity; }
  get momentary() { return this.steps.length >= 4 ? Lufs.lu(this.mean(4)) : -Infinity; }
  get short() { return this.steps.length ? Lufs.lu(this.mean(Math.min(30, this.steps.length))) : -Infinity; }
  get integrated() {
    const abs = this.blocks.filter((b) => Lufs.lu(b) > -70);
    if (!abs.length) return -Infinity;
    const rel = Lufs.lu(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((b) => Lufs.lu(b) > rel);
    return g.length ? Lufs.lu(g.reduce((a, b) => a + b, 0) / g.length) : -Infinity;
  }
}

// ---------------------------------------------------------------- sampler ---
// a sample across the keys (KEYS: pitched from its root note) or chopped (SLICE: one slice a key from C2)
class Sampler {
  constructor() { this.v = []; }
  noteOn(def, a, n, vel) {
    if (!a) return;
    const s = def.sample, len = a.L.length;
    const st = Math.floor((s.start ?? 0) * len), en = Math.max(st + 64, Math.floor((s.end ?? 1) * len));
    let from = st, to = en, rate = 1;
    if (s.mode === 'slice') {
      const k = n - 36, cnt = Math.max(1, s.slices || 16);
      if (k < 0 || k >= cnt) return;
      const w = (en - st) / cnt;
      from = Math.floor(st + k * w); to = Math.floor(st + (k + 1) * w);
    } else rate = Math.pow(2, (n - (s.root ?? 60) + (s.tune || 0) / 100) / 12);
    if (this.v.length >= 24) this.v.shift();
    this.v.push({ n, pos: from, to, from, rate, g: (vel / 127) ** 1.4, env: 0, rel: false, done: false, loop: s.mode !== 'slice' && s.loop });
  }
  noteOff(n) { for (const v of this.v) if (v.n === n) v.rel = true; }
  render(def, a, out) {
    out.fill(0);
    if (!a || !this.v.length) return;
    const s = def.sample, L = a.L, R = a.R || a.L;
    const att = 1 / Math.max(1, (s.att ?? 2) * 0.001 * RATE), rel = 1 / Math.max(1, (s.rel ?? 120) * 0.001 * RATE), g = dbToGain(s.gain || 0);
    for (const v of this.v) {
      for (let i = 0; i < BLOCK; i++) {
        if (v.pos >= v.to - 1) { if (v.loop) v.pos = v.from; else { v.done = true; break; } }
        v.env = v.rel ? v.env - rel : Math.min(1, v.env + att);
        if (v.env <= 0 && v.rel) { v.done = true; break; }
        const p0 = Math.floor(v.pos), f = v.pos - p0, k = v.env * v.g * g;
        out[i * 2] += (L[p0] + (L[p0 + 1] - L[p0]) * f) * k;
        out[i * 2 + 1] += (R[p0] + (R[p0 + 1] - R[p0]) * f) * k;
        v.pos += v.rate;
      }
    }
    this.v = this.v.filter((v) => !v.done);
  }
}

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
    this.soundKey = '';
    this.params = {};
    this.events = [];          // arrangement note-ons, sorted by time (beats)
    this.cursor = 0;
    this.active = new Map();   // note -> end (beats), from the sequencer
    this.live = new Map();     // note -> start (beats), keys / MIDI (for recording)
    this.gL = 0; this.gR = 0;
    this.peakL = 0; this.peakR = 0;
    this.lastAuto = {};
    this.lockBase = {}; this.lockUntil = -1;
    this.rack = new Rack();
    this.bufL = new Float32Array(BLOCK); this.bufR = new Float32Array(BLOCK);   // post-FX, pre-fader (sidechain key)
    this.busL = new Float32Array(BLOCK); this.busR = new Float32Array(BLOCK);   // a group's input
    this.slotEvents = [];      // per session slot: its notes, in [0, loop)
    this.sess = null;          // { slot, at } while a session clip plays
    this.queued = null;        // { slot, at } a launch (slot -1: a stop) waiting for its quantize
  }
  noteOn(engine, n, v) {
    if (this.w) this.w.k_note(n, v, 1);
    else if (this.sampler) this.sampler.noteOn(this.def, engine.assets.get(this.def.sample?.src), n, v);
    else if (this.kind === 'external') engine.ext.push([this.id, 0x90, n, v]);
  }
  noteOff(engine, n) {
    if (this.w) this.w.k_note(n, 0, 0);
    else if (this.sampler) this.sampler.noteOff(n);
    else if (this.kind === 'external') engine.ext.push([this.id, 0x80, n, 0]);
  }
  allOff(engine) {
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
    const d = this.def;
    if (d.frozen) return this.playAudio(engine, [{ start: 0, len: 1e9, src: d.frozen.src, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0 }]);
    if (this.w) { this.w.k_render(); return; }
    if (this.sampler) return this.sampler.render(d, engine.assets.get(d.sample?.src), this.out);
    if (this.kind === 'audio') {
      if (this.sess) {                                           // a session clip: looped from its launch
        const c = d.slots?.[this.sess.slot];
        if (!c) { this.out.fill(0); return; }
        const loop = c.loop || c.len, k = Math.floor((engine.pos - this.sess.at) / loop);
        return this.playAudio(engine, [0, 1].map((j) => ({ ...c, start: this.sess.at + (k + j) * loop, len: loop })));
      }
      return this.playAudio(engine, d.clips);
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
      for (let f = f0; f < f1; f++) {
        const local = (pos - c.start) * spb + f;
        const sp = base + local * rate, s0 = Math.floor(sp), fr = sp - s0;
        if (s0 < 0 || s0 + 1 >= n) continue;
        let k = g;
        if (local < fin) k *= local / fin;
        if (clipFrames - local < fout) k *= Math.max(0, (clipFrames - local) / fout);
        o[f * 2] += (L[s0] + (L[s0 + 1] - L[s0]) * fr) * k; o[f * 2 + 1] += (R[s0] + (R[s0 + 1] - R[s0]) * fr) * k;
      }
    }
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
    this.returns = [];
    this.masterRack = new Rack();
    this.mix = { L: new Float32Array(BLOCK), R: new Float32Array(BLOCK) };
    this.fxCtx = { bpm: 120, pos: 0, sidechain: (id) => { const t = this.tracks.get(id); return t ? { L: t.bufL, R: t.bufR } : null; } };
    this.master = { env: 1, peakL: 0, peakR: 0 };
    this.lufs = new Lufs();
    this.clickPhase = 0; this.clickEnv = 0; this.clickFreq = 1000;
    this.blocksSinceMeter = 0;
    this.lastBeat = -1;
    this.ext = [];             // notes for external MIDI tracks, posted after each render
    this.slotMsgs = [];
  }

  // ------------------------------------------------------------- project ---
  setProject(p, changed = null) {
    this.project = p;
    this.sig = p.sig || 4;
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
      if (tr.w) {
        this.applySound(tr, def);
        tr.w.k_bpm(Math.round(this.bpm));
        if (def.kind === 'synth' && tr.mpe !== (def.mpe || 0)) { tr.mpe = def.mpe || 0; tr.w.k_mpe(tr.mpe); }
      }
      if (def.kind === 'audio' || def.kind === 'group') continue;
      const ev = [];
      for (const c of def.clips) clipEvents(c, ev, { swing });
      ev.sort((a, b) => a.t - b.t || a.n - b.n);
      tr.events = ev;
      tr.cursor = this.seekIndex(ev, this.pos);
      tr.slotEvents = (def.slots || []).map((c) => (c && c.notes ? clipEvents(c, [], { start: 0, len: c.loop || c.len, swing }).sort((a, b) => a.t - b.t) : null));
    }
    // the groups, deepest first: a group's output can feed another group
    const depth = (t, k = 0) => { const parent = p.tracks.find((x) => x.id === t.out && x.kind === 'group'); return parent && k < 8 ? depth(parent, k + 1) + 1 : 0; };
    this.groups = this.order.filter((t) => t.kind === 'group').sort((a, b) => depth(b.def) - depth(a.def));
    this.audibleCache = null;
    while (this.returns.length < p.returns.length) this.returns.push(new Return());
    this.returns.length = p.returns.length;
    p.returns.forEach((r, i) => this.returns[i].sync(r, this.bpm));
    this.masterRack.sync(p.master.fx, this.bpm);
  }
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
      tr.params = {};
      if (!this.offline) this.post({ t: 'params', track: tr.id, values: tr.readParams() });
    }
    for (const k in def.params) {
      if (tr.params[k] !== def.params[k]) { tr.w.k_param(+k, def.params[k]); tr.params[k] = def.params[k]; }
    }
  }
  seekIndex(ev, t) {
    let lo = 0, hi = ev.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].t < t - 1e-9) lo = m + 1; else hi = m; }
    return lo;
  }

  // ------------------------------------------------------------ transport ---
  play(countIn = false) {
    if (!this.playing) this.lufs.reset();
    this.playing = true; this.lastBeat = -1;
    if (countIn) { this.countTo = this.pos; this.pos -= this.sig; this.counting = true; }
  }
  stop() {
    if (!this.playing) { this.seek(this.loop.on ? this.loop.a : 0); }
    if (this.counting) { this.pos = this.countTo; this.counting = false; }
    this.playing = false;
    this.flushRecording();
    for (const tr of this.order) { tr.allOff(this); if (tr.queued) tr.queued = null; }
  }
  seek(beat) {
    this.pos = Math.max(0, beat);
    this.counting = false;
    for (const tr of this.order) { tr.allOff(this); tr.cursor = this.seekIndex(tr.events, this.pos); }
    this.lastBeat = -1;
  }
  panic() { for (const tr of this.order) { tr.allOff(this); tr.w?.k_panic(); tr.sampler && (tr.sampler.v = []); } }
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
    if (!s || !tr.slotEvents[s.slot]) return;
    const c = tr.def.slots[s.slot], loop = c.loop || c.len, ev = tr.slotEvents[s.slot];
    const l0 = this.pos - s.at, l1 = end - s.at;
    if (l1 <= 0) return;
    const k0 = Math.floor(Math.max(0, l0) / loop), k1 = Math.floor((l1 - 1e-9) / loop);
    for (let k = k0; k <= k1; k++) {
      const a = Math.max(0, l0) - k * loop, b = l1 - k * loop;
      for (const e of ev) if (e.t >= a - 1e-9 && e.t < b) tr.trigger(this, e, s.at + k * loop + e.t);
    }
  }

  // live notes (keys, MIDI); recorded when recording and playing (into the playing session clip, if any)
  liveNote(id, n, v, on, silent = false) {
    const tr = this.tracks.get(id);
    if (!tr) return;
    if (on) {
      if (!silent) tr.noteOn(this, n, v);
      if (this.playing && this.recording && !this.counting && this.punchOpen()) tr.live.set(n, { t: this.pos, v });
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
    } else this.post({ t: 'rec', track: tr.id, note });
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
    const anySolo = p.tracks.some((t) => t.solo);
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
    if (this.ext.length && !this.offline) { this.post({ t: 'ext', ev: this.ext }); this.ext = []; }
    if (this.slotMsgs.length) { if (!this.offline) this.post({ t: 'slot', ev: this.slotMsgs }); this.slotMsgs = []; }
  }
  block(L, R, off) {
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
    // instruments, racks, faders, sends, groups
    const mL = this.mix.L, mR = this.mix.R;
    mL.fill(0); mR.fill(0);
    for (const r of this.returns) { r.L.fill(0); r.R.fill(0); }
    for (const g of this.groups) { g.busL.fill(0); g.busR.fill(0); }
    const aud = this.audibleCache || (this.audibleCache = this.audible());
    const ctx = this.fxCtx; ctx.bpm = this.bpm; ctx.pos = this.pos;
    const strip = (tr) => {
      const d = tr.def, bL = tr.bufL, bR = tr.bufR;
      if (tr.kind === 'group') { bL.set(tr.busL); bR.set(tr.busR); }
      else { tr.render(this); const o = tr.out; for (let i = 0; i < BLOCK; i++) { bL[i] = o[i * 2]; bR[i] = o[i * 2 + 1]; } }
      if (this.freezeTrack) {                                    // freeze: the track's own sound, alone, pre-rack
        if (tr.id === this.freezeTrack) for (let i = 0; i < BLOCK; i++) { mL[i] += bL[i]; mR[i] += bR[i]; }
        return;
      }
      tr.rack.process(bL, bR, BLOCK, ctx);
      let on = aud.get(tr.id);
      if (this.soloTrack) on = tr.id === this.soloTrack || (tr.kind === 'group' && this.isAncestor(tr.id, this.soloTrack));
      const vol = tr.autoVol ?? d.vol, pan = tr.autoPan ?? d.pan;
      const g = on ? dbToGain(vol) : 0, a = (pan + 1) * Math.PI / 4;
      const tl = g * Math.cos(a) * Math.SQRT2, trg = g * Math.sin(a) * Math.SQRT2;
      const sl0 = tr.gL, sr0 = tr.gR;
      const parent = d.out && this.tracks.get(d.out);
      const dL = parent && parent.kind === 'group' ? parent.busL : mL, dR = parent && parent.kind === 'group' ? parent.busR : mR;
      let pl = 0, pr = 0;
      for (let i = 0; i < BLOCK; i++) {
        const k = (i + 1) / BLOCK, l = bL[i] * (sl0 + (tl - sl0) * k), r = bR[i] * (sr0 + (trg - sr0) * k);
        dL[i] += l; dR[i] += r;
        if (l > pl) pl = l; else if (-l > pl) pl = -l;
        if (r > pr) pr = r; else if (-r > pr) pr = -r;
      }
      tr.gL = tl; tr.gR = trg;
      tr.peakL = Math.max(tr.peakL, pl); tr.peakR = Math.max(tr.peakR, pr);
      if (this.soloTrack && tr.id !== this.soloTrack) return;
      const sends = tr.autoSend || d.sends || [];
      for (let s = 0; s < this.returns.length; s++) {
        const amt = (sends[s] || 0) * (on ? 1 : 0);
        if (amt <= 0) continue;
        const r = this.returns[s], pre = d.sendPre?.[s];
        const sl = (pre ? 1 : tl) * amt, sr = (pre ? 1 : trg) * amt;
        for (let i = 0; i < BLOCK; i++) { r.L[i] += bL[i] * sl; r.R[i] += bR[i] * sr; }
      }
    };
    for (const tr of this.order) if (tr.kind !== 'group') strip(tr);
    for (const g of this.groups) strip(g);
    if (!this.freezeTrack) {
      // returns
      this.returns.forEach((r, s) => {
        const def = p.returns[s];
        r.oL.fill(0); r.oR.fill(0);
        if (r.fx) r.fx.process(r.L, r.R, r.oL, r.oR, BLOCK); else { r.oL.set(r.L); r.oR.set(r.R); }
        r.rack.process(r.oL, r.oR, BLOCK, ctx);
        const g = def.mute || this.soloTrack ? 0 : dbToGain(def.vol);
        let pl = 0, pr = 0;
        for (let i = 0; i < BLOCK; i++) { const l = r.oL[i] * g, rr = r.oR[i] * g; mL[i] += l; mR[i] += rr; pl = Math.max(pl, Math.abs(l)); pr = Math.max(pr, Math.abs(rr)); }
        r.peak[0] = Math.max(r.peak[0], pl); r.peak[1] = Math.max(r.peak[1], pr);
      });
      this.masterRack.process(mL, mR, BLOCK, ctx);
    }
    // master: fader, glue limiter (fast attack, smooth release), ceiling -0.3 dB; the click on top
    const mg = this.freezeTrack ? 1 : dbToGain(p.master.vol), ceil = 0.966;
    let env = this.master.env, pl = 0, pr = 0;
    for (let i = 0; i < BLOCK; i++) {
      let l = mL[i] * mg, r = mR[i] * mg;
      if (!this.freezeTrack) {
        const peak = Math.max(Math.abs(l), Math.abs(r)), want = peak > ceil ? ceil / peak : 1;
        env = want < env ? want : env + (want - env) * 0.0004;
        if (env > 1) env = 1;
        l *= env; r *= env;
      }
      mL[i] = l; mR[i] = r;
    }
    if (this.playing && !this.counting) this.lufs.push(mL, mR, BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      let l = mL[i], r = mR[i];
      if (this.clickEnv > 0.0005) {
        const c = Math.sin(this.clickPhase) * this.clickEnv * 0.3;
        this.clickPhase += TAU * this.clickFreq / RATE; this.clickEnv *= 0.9975;
        l += c; r += c;
      }
      L[off + i] = l; R[off + i] = r;
      pl = Math.max(pl, Math.abs(l)); pr = Math.max(pr, Math.abs(r));
    }
    this.master.env = env;
    this.master.peakL = Math.max(this.master.peakL, pl); this.master.peakR = Math.max(this.master.peakR, pr);
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
    if (!this.counting && this.loop.on && this.pos >= this.loop.b - 1e-9) { this.flushWrap(); this.seek(this.loop.a); }
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
      const beat = Math.floor(this.pos + 1e-9);
      if (beat !== this.lastBeat && this.pos - beat < dt) { this.clickEnv = 1; this.clickFreq = ((beat % this.sig) + this.sig) % this.sig === 0 ? 1600 : 1000; }
      this.lastBeat = beat;
    }
  }
  report() {
    this.blocksSinceMeter = 0;
    const tracks = {}, sess = {};
    for (const tr of this.order) {
      tracks[tr.id] = [tr.peakL, tr.peakR]; tr.peakL = tr.peakR = 0;
      if (tr.sess || tr.queued) sess[tr.id] = { slot: tr.sess?.slot ?? -1, at: tr.sess?.at, queued: tr.queued?.slot, qat: tr.queued?.at };
    }
    const gr = {};
    const grOf = (rack) => { for (const d of rack.list) if (d.gr !== undefined && (d.type === 'comp' || d.type === 'limiter' || d.type === 'gate')) gr[d.def.id] = d.gr; };
    for (const tr of this.order) grOf(tr.rack);
    this.returns.forEach((r) => grOf(r.rack)); grOf(this.masterRack);
    const l = this.lufs;
    this.post({ t: 'tick', pos: this.pos, playing: this.playing, counting: this.counting, bpm: this.bpm, tracks, gr, sess,
      master: [this.master.peakL, this.master.peakR, 1 - this.master.env],
      lufs: [l.momentary, l.short, l.integrated],
      returns: this.returns.map((r) => { const x = [...r.peak]; r.peak = [0, 0]; return x; }) });
    this.master.peakL = this.master.peakR = 0;
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
      else if (key[0] === 'p') {
        const id = +key.slice(1), iv = Math.round(v);
        if (tr.w && tr.lastAuto[id] !== iv && tr.lockBase[id] === undefined) { tr.lastAuto[id] = iv; tr.w.k_param(id, iv); }
      }
    }
  }
}
