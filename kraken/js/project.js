// SPDX-License-Identifier: GPL-3.0-only
// The Kraken project: one plain JSON document, the single source of truth. Times are in beats
// (quarter notes). Every edit goes through store.change(), which keeps the undo history and tells
// the audio engine and the views.

export const FORMAT = 1;
export const SCENES = 8;
export const COLORS = ['#ff5b14', '#3d6bff', '#1fb46a', '#ffc21a', '#e8e8e8', '#ff4f8b', '#8a5cff', '#22c5d6'];

let n = Date.now() % 100000;
export const uid = (p = 'x') => `${p}${(n++).toString(36)}`;

const KIND_NAME = { drum: 'DRUMS', audio: 'AUDIO', group: 'GROUP', sampler: 'SAMPLER', external: 'EXT MIDI', synth: 'SYNTH' };
// kinds: synth (SLOOP / Clipper engines), drum, audio, sampler, external (a MIDI device), group (a bus)
export function newTrack(kind, i, opts = {}) {
  const t = {
    id: uid('t'), name: opts.name || (kind === 'drum' ? 'DRUMS' : `${KIND_NAME[kind]} ${i + 1}`),
    color: opts.color || COLORS[i % COLORS.length], kind,
    bank: kind === 'drum' ? 'sloop' : (opts.bank || 'clipper'),
    engine: opts.engine ?? 0, preset: opts.preset ?? 0, kit: opts.kit ?? 15, params: {},
    vol: opts.vol ?? (kind === 'group' ? 0 : -6), pan: opts.pan ?? 0, mute: false, solo: false, arm: false,
    sends: opts.sends || [kind === 'group' ? 0 : 0.15, 0], sendPre: [], clips: [], slots: Array(opts.scenes || SCENES).fill(null),
    auto: {}, rev: 0, fx: [], midiCh: 0, out: opts.out || 'master',
  };
  if (kind === 'sampler') t.sample = { src: opts.src || null, name: opts.sampleName || '', root: 60, mode: opts.mode || 'keys', slices: 16, start: 0, end: 1, att: 2, rel: 150, gain: 0, loop: false, tune: 0 };
  if (kind === 'external') t.ext = { port: '', ch: 1, latency: 0 };
  return t;
}
export const newReturn = (type, name) => ({ id: uid('r'), name, type, vol: -4, mute: false, fx: [],
  ...(type === 'reverb' ? { size: 0.82, damp: 0.35, pre: 0.02 } : type === 'delay' ? { time: 0.75, fb: 0.42, tone: 0.55 } : {}) });

export function newProject() {
  return {
    kraken: FORMAT, name: 'Untitled', bpm: 120, sig: 4,
    loop: { on: true, a: 0, b: 16 },
    master: { vol: 0, fx: [] },
    returns: [{ ...newReturn('reverb', 'REVERB'), vol: -4 }, { ...newReturn('delay', 'DELAY'), vol: -6 }],
    tracks: [],
    scenes: [...Array(SCENES)].map((_, i) => ({ id: uid('s'), name: `SCENE ${i + 1}` })),
    launchQ: 4,              // session launches wait for the next bar (beats; 0 = at once)
    tempo: [],               // the tempo map: [{ t: beat, v: bpm }], ramps between points; empty = bpm
    swing: 0,                // 0 straight .. 1 (offbeat 16ths 75 %)
    countIn: false,
    punch: { on: false, a: 4, b: 12 },
    assets: {},              // audio files: id -> { name, frames }; their samples live outside the JSON
  };
}

export function newClip(start, len, name = 'CLIP') {
  return { id: uid('c'), name, start, len, loop: len, notes: [] };
}

// --------------------------------------------------------------- the demo song ---
// "First Dive": A minor, 112 BPM, 8 bars. Every sound is a factory sound of SLOOP / Clipper.
export function demoProject(lib) {
  const p = newProject();
  p.name = 'First Dive';
  p.bpm = 112;
  p.loop = { on: true, a: 0, b: 32 };
  const find = (bank, eng, preset) => {
    const cat = lib[bank];
    const e = cat.engines.findIndex((x) => x.name === eng);
    const i = e < 0 ? 0 : Math.max(0, cat.engines[e].presets.indexOf(preset));
    return { bank, engine: Math.max(0, e), preset: i };
  };
  const drums = newTrack('drum', 0, { name: 'DRUMS', kit: lib.sloop.kits.indexOf('HOUSE'), vol: -4, sends: [0.06, 0] });
  const bass = newTrack('synth', 1, { name: 'BASS', ...find('clipper', 'HYBRID', 'MOOG BASS'), vol: -7, sends: [0, 0] });
  const pad = newTrack('synth', 2, { name: 'PAD', ...find('clipper', 'JUNO', 'JUNO 106 PAD'), vol: -12, sends: [0.35, 0.1] });
  const keys = newTrack('synth', 3, { name: 'KEYS', ...find('clipper', 'FMX', 'FMX EP'), vol: -11, pan: -0.25, sends: [0.25, 0.2] });
  const lead = newTrack('synth', 5, { name: 'LEAD', ...find('clipper', 'HYBRID', 'SYNC LEAD'), vol: -14, pan: 0.15, sends: [0.25, 0.35] });

  // drums: a 1-bar house pattern, looped over 8 bars; an extra clap and open hat in the second half
  const dc = newClip(0, 32, 'GROOVE'); dc.loop = 4;
  for (let b = 0; b < 4; b++) dc.notes.push({ t: b, d: 0.25, n: 36, v: 118 });
  for (const b of [1, 3]) dc.notes.push({ t: b, d: 0.25, n: 39, v: 104 });
  for (let s = 0; s < 4; s++) dc.notes.push({ t: s + 0.5, d: 0.25, n: 46, v: 82 });
  for (let s = 0; s < 16; s++) if (s % 2 === 0) dc.notes.push({ t: s / 4, d: 0.25, n: 42, v: s % 4 ? 70 : 54 });
  dc.notes.push({ t: 3.75, d: 0.25, n: 38, v: 64 });
  dc.notes.push({ t: 2.75, d: 0.25, n: 70, v: 60 });
  drums.clips.push(dc);

  // chords: Am / F / C / G, one bar each
  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
  const roots = [33, 29, 36, 31];
  const pc = newClip(0, 32, 'CHORDS'); pc.loop = 16;
  chords.forEach((c, i) => c.forEach((nn) => pc.notes.push({ t: i * 4, d: 3.9, n: nn, v: 80 })));
  pad.clips.push(pc);

  const bc = newClip(0, 32, 'BASSLINE'); bc.loop = 16;
  const rhythm = [[0, 0.5, 0], [0.75, 0.25, 12], [1.5, 0.5, 0], [2, 0.25, 0], [2.5, 0.25, 12], [3, 0.5, 0], [3.5, 0.25, 7]];
  roots.forEach((r, i) => rhythm.forEach(([t, d, o]) => bc.notes.push({ t: i * 4 + t, d, n: r + o, v: o ? 92 : 112 })));
  bass.clips.push(bc);

  const kc = newClip(8, 24, 'STABS'); kc.loop = 8;
  [[0, 0], [1, 0]].forEach(([bar]) => {
    const c = chords[bar];
    for (const t of [0.5, 1.75, 2.5, 3.5]) c.forEach((nn) => kc.notes.push({ t: bar * 4 + t, d: 0.4, n: nn + 12, v: 76 }));
  });
  keys.clips.push(kc);

  const lc = newClip(16, 16, 'HOOK');
  const mel = [[0, 0.75, 76], [0.75, 0.75, 74], [1.5, 1, 72], [2.5, 1.5, 69],
    [4, 0.75, 72], [4.75, 0.75, 74], [5.5, 2.5, 76],
    [8, 0.5, 79], [8.5, 0.5, 76], [9, 1, 74], [10, 2, 72],
    [12, 0.75, 71], [12.75, 0.75, 72], [13.5, 2.5, 74]];
  mel.forEach(([t, d, nn]) => lc.notes.push({ t, d, n: nn, v: 96 }));
  lead.clips.push(lc);

  lead.auto = { send1: [{ t: 16, v: 0.1 }, { t: 30, v: 0.6 }, { t: 32, v: 0.1 }] };
  // a mix, as a producer would set it up: the bass ducks under the kick, the pad keeps out of its way
  const fx = (type, p) => ({ id: uid('f'), type, on: true, p });
  bass.fx = [fx('comp', { th: -30, ra: 8, at: 1.5, re: 140, kn: 6, mk: 2, mx: 1, sc: drums.id }), fx('sat', { dr: 8, ty: 1, to: 0.2, mx: 0.6, ou: -3 })];
  pad.fx = [fx('eq', { hp: 260, lg: 0, lf: 120, m1g: -3, m1f: 600, m1q: 1, m2g: 2, m2f: 5000, m2q: 0.8, hg: 0, hf: 8000, lp: 16000 }), fx('chorus', { ra: 0.4, de: 0.5, fb: 0.1, mx: 0.35 })];
  lead.fx = [fx('delay', { ti: 4, fb: 0.35, to: 0.55, pp: 1, mx: 0.22 })];
  p.master.fx = [fx('eq', { hp: 28, lg: 1, lf: 90, m1g: 0, m1f: 500, m1q: 1, m2g: 0, m2f: 3000, m2q: 1, hg: 1.5, hf: 10000, lp: 20000 }), fx('comp', { th: -16, ra: 2, at: 20, re: 200, kn: 8, mk: 1.5, mx: 1, sc: '' })];
  p.tracks = [drums, bass, pad, keys, lead];
  // the session: two scenes to launch live, from the song's own clips
  const slot = (c, loop) => { const x = structuredClone(c); x.id = uid('c'); delete x.start; x.len = loop; x.loop = loop; return x; };
  p.scenes[0].name = 'INTRO'; p.scenes[1].name = 'DROP';
  drums.slots[0] = slot(dc, 4); bass.slots[0] = slot(bc, 16); pad.slots[0] = slot(pc, 16);
  drums.slots[1] = slot(dc, 4); bass.slots[1] = slot(bc, 16); pad.slots[1] = slot(pc, 16); keys.slots[1] = slot(kc, 8); lead.slots[1] = slot(lc, 16);
  return p;
}

// ------------------------------------------------------------------- the store ---
export class Store {
  constructor(project) {
    this.p = project;
    this.past = [];
    this.future = [];
    this.listeners = new Set();
    this.lastTag = null;
    this.lastTime = 0;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(why) { for (const fn of this.listeners) fn(this.p, why); }
  // fn mutates a copy; tag merges quick repeats (a drag, a knob turn) into one undo step
  change(fn, tag = null) {
    const now = performance.now();
    const merge = tag && tag === this.lastTag && now - this.lastTime < 1200;
    if (!merge) {
      this.past.push(structuredClone(this.p));
      if (this.past.length > 300) this.past.shift();
      this.future = [];
    }
    this.lastTag = tag; this.lastTime = now;
    fn(this.p);
    this.emit('change');
  }
  endGesture() { this.lastTag = null; }
  undo() {
    if (!this.past.length) return;
    this.future.push(structuredClone(this.p));
    this.p = this.past.pop();
    this.lastTag = null;
    this.emit('history');
  }
  redo() {
    if (!this.future.length) return;
    this.past.push(structuredClone(this.p));
    this.p = this.future.pop();
    this.lastTag = null;
    this.emit('history');
  }
  replace(p) {
    this.p = p; this.past = []; this.future = []; this.lastTag = null;
    this.emit('load');
  }
  track(id) { return this.p.tracks.find((t) => t.id === id); }
}

export function validate(p) {
  if (!p || p.kraken !== FORMAT || !Array.isArray(p.tracks)) throw new Error('This file is not a Kraken project.');
  const d = newProject();
  p.loop ??= d.loop; p.master ??= d.master; p.returns ??= d.returns; p.sig ??= 4; p.assets ??= {};
  p.scenes ??= d.scenes; p.launchQ ??= 4; p.tempo ??= []; p.swing ??= 0; p.countIn ??= false; p.punch ??= d.punch;
  // repairs: what a damaged or hand-edited file may hold
  const num = (x, d) => (Number.isFinite(x) ? x : d);
  p.bpm = Math.max(20, Math.min(300, num(p.bpm, 120)));
  for (const t of p.tracks) {
    t.vol = num(t.vol, -6); t.pan = Math.max(-1, Math.min(1, num(t.pan, 0)));
    t.clips = (t.clips || []).filter((c) => c && Number.isFinite(c.start) && c.len > 0.001).map((c) => { c.start = Math.max(0, c.start); if (c.notes) c.notes = c.notes.filter((n) => n && Number.isFinite(n.t) && n.d > 0 && n.n >= 0 && n.n <= 127); return c; });
  }
  p.returns.forEach((r, i) => { r.id ??= uid('r'); r.type ??= i === 0 ? 'reverb' : i === 1 ? 'delay' : 'none'; });
  for (const t of p.tracks) {
    t.auto ??= {}; t.params ??= {}; t.sends ??= [0, 0]; t.sendPre ??= []; t.clips ??= []; t.fx ??= []; t.midiCh ??= 0; t.out ??= 'master';
    t.slots ??= []; while (t.slots.length < p.scenes.length) t.slots.push(null);
  }
  for (const r of p.returns) r.fx ??= [];
  p.master.fx ??= [];
  return p;
}

export function newAudioClip(start, len, src, name) {
  return { id: uid('c'), name, start, len, src, offset: 0, gain: 0, fadeIn: 0.005, fadeOut: 0.01 };
}

export function projectEnd(p) {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.len);
  return end;
}
