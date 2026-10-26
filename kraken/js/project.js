// SPDX-License-Identifier: GPL-3.0-only
// The Kraken project: one plain JSON document, the single source of truth. Times are in beats
// (quarter notes). Every edit goes through store.change(), which keeps the undo history and tells
// the audio engine and the views.

import { isFolder, shiftFolder } from './comp.js';
import { DEVICES } from './fx.js';
import { NOTE_FX } from './notefx.js';
import { MODS } from './mods.js';
import { meterList, cleanMeters } from './meter.js';
import { cleanPlugin, cleanWamFx } from './wam.js';
import { validatePatch, newPatch } from './lab-modules.js';

// FORMAT: the project file's own version. It goes up only when a saved project must be changed to be read by the
// new Kraken; MIGRATIONS[n] turns a format-n project into format n + 1. Every format ever saved keeps a reference
// file in tests/fixtures/projects that the newest Kraken must open and play (tests/projects_test.mjs).
export const FORMAT = 1;
export const APP_VERSION = '0.7.0';
const MIGRATIONS = {};
export const SCENES = 8;
export const MACROS = 8;
export const COLORS = ['#ff5b14', '#3d6bff', '#1fb46a', '#ffc21a', '#e8e8e8', '#ff4f8b', '#8a5cff', '#22c5d6'];

// ids: this browser's own random part, then a count (two people, two browsers, playing together: never the same)
const SESSION = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
let n = 0;
export const uid = (p = 'x') => `${p}${SESSION}${(n++).toString(36)}`;

const KIND_NAME = { drum: 'DRUMS', audio: 'AUDIO', group: 'GROUP', sampler: 'SAMPLER', external: 'EXT MIDI', synth: 'SYNTH', vca: 'VCA', wam: 'PLUGIN' };
// kinds: synth (SLOOP / Clipper engines), drum, audio, sampler, external (a MIDI device), wam (a plugin instrument,
// wam.js), group (a bus), vca (a fader that moves others)
export function newTrack(kind, i, opts = {}) {
  const t = {
    id: uid('t'), name: opts.name || (kind === 'drum' ? 'DRUMS' : `${KIND_NAME[kind]} ${i + 1}`),
    color: opts.color || COLORS[i % COLORS.length], kind,
    bank: kind === 'drum' ? 'sloop' : (opts.bank || 'clipper'),
    engine: opts.engine ?? 0, preset: opts.preset ?? 0, kit: opts.kit ?? 15, params: {},
    vol: opts.vol ?? (kind === 'group' || kind === 'vca' ? 0 : -6), pan: opts.pan ?? 0, mute: false, solo: false, arm: false,
    sends: opts.sends || [kind === 'group' || kind === 'vca' ? 0 : 0.15, 0], sendPre: [], clips: [], slots: Array(opts.scenes || SCENES).fill(null),
    auto: {}, rev: 0, fx: [], nfx: [], mods: [], midiCh: 0, out: opts.out || 'master',
  };
  if (kind === 'sampler') t.sample = { src: opts.src || null, name: opts.sampleName || '', root: 60, mode: opts.mode || 'keys', slices: 16, start: 0, end: 1, att: 2, rel: 150, gain: 0, loop: false, tune: 0 };
  if (kind === 'external') t.ext = { port: '', ch: 1, latency: 0 };
  if (kind === 'wam') t.wam = cleanPlugin(opts.wam);
  if (kind === 'lab') t.lab = opts.lab ? structuredClone(opts.lab) : newPatch('inst');              // { url, name, state }, or none chosen yet
  return t;
}
export const newReturn = (type, name) => ({ id: uid('r'), name, type, vol: -4, mute: false, fx: [],
  ...(type === 'reverb' ? { size: 0.82, damp: 0.35, pre: 0.02 } : type === 'delay' ? { time: 0.75, fb: 0.42, tone: 0.55 } : {}) });

export function newProject() {
  return {
    kraken: FORMAT, name: 'Untitled', bpm: 120, sig: 4, meters: [],   // sig: beats in a bar; meters: signature changes
    loop: { on: true, a: 0, b: 16 },
    master: { vol: 0, fx: [], limit: { on: true, ceil: -0.3 } },   // limit: the master's own limiter, its ceiling in dB
    returns: [{ ...newReturn('reverb', 'REVERB'), vol: -4 }, { ...newReturn('delay', 'DELAY'), vol: -6 }],
    tracks: [],
    scenes: [...Array(SCENES)].map((_, i) => ({ id: uid('s'), name: `SCENE ${i + 1}` })),
    launchQ: 4,              // session launches wait for the next bar (beats; 0 = at once)
    tempo: [],               // the tempo map: [{ t: beat, v: bpm }], ramps between points; empty = bpm
    swing: 0,                // 0 straight .. 1 (offbeat 16ths 75 %)
    countIn: false,
    punch: { on: false, a: 4, b: 12 },
    markers: [],             // arrangement markers: [{ id, t: beat, name }]
    macros: [...Array(MACROS)].map((_, i) => ({ id: `m${i}`, name: `MACRO ${i + 1}`, v: 0, to: [] })),   // project macros
    macroAuto: {},           // their automation: { m0: [{ t, v }] }
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
  // a change that belongs to the last step of the history (the clip a drag cut, after the drag): no new undo step
  amend(fn) { fn(this.p); this.emit('change'); }
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
  // another project: the one before stays one undo away (keep), or the history starts afresh
  replace(p, keep = false) {
    if (keep && this.p) { this.past.push(structuredClone(this.p)); if (this.past.length > 300) this.past.shift(); } else this.past = [];
    this.p = p; this.future = []; this.lastTag = null;
    this.emit('load');
  }
  track(id) { return this.p.tracks.find((t) => t.id === id); }
}

// a project from a file or a save, made safe to open: from an older format, the steps up to this one; whatever a
// damaged or hand-edited file holds, repaired or left out, so the app and the engine only ever see what they expect.
// Throws (with a sentence for the person) only when there is nothing to open.
export function migrate(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !('kraken' in p)) throw new Error('This file is not a Kraken project.');
  const f = Number(p.kraken);
  if (!Number.isInteger(f) || f < 1) throw new Error('This file is not a Kraken project.');
  if (f > FORMAT) throw new Error(`This project was saved by a newer Kraken${p.savedWith ? ` (${p.savedWith})` : ''}. Reload the page to get the latest version, then open it again.`);
  for (let v = f; v < FORMAT; v++) { p = MIGRATIONS[v](p); p.kraken = v + 1; }
  return p;
}
// every audio file a track plays (clips, takes, slots, its sampler's zones, its pads, its frozen render)
export function trackSources(t) {
  const out = [];
  for (const c of t.clips || []) { out.push(c.src, c.orig); for (const k of c.takes || []) out.push(k.src); }
  for (const c of t.slots || []) if (c) out.push(c.src, c.orig);
  out.push(t.sample?.src, t.frozen?.src);
  for (const z of t.sample?.zones || []) out.push(z.src);
  for (const pd of Object.values(t.pads || {})) out.push(pd?.src);
  return [...new Set(out.filter((x) => typeof x === 'string'))];
}
const KINDS = new Set(['synth', 'drum', 'audio', 'sampler', 'external', 'group', 'vca', 'wam', 'lab']);
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clampN = (x, a, b, d) => Math.max(a, Math.min(b, num(x, d)));
const str = (x, d, max = 64) => (typeof x === 'string' ? x.slice(0, max) : typeof x === 'number' ? String(x) : d);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
const arr = (x) => (Array.isArray(x) ? x : []);
const COLOR = /^#[0-9a-f]{3,8}$/i;
// automation points: finite, in time order
const points = (list) => arr(list).filter((q) => obj(q) && Number.isFinite(q.t) && Number.isFinite(q.v)).map((q) => (Number.isFinite(q.c) && Math.abs(q.c) >= 0.01 ? { t: Math.max(0, q.t), v: q.v, c: Math.max(-1, Math.min(1, q.c)) } : { t: Math.max(0, q.t), v: q.v })).sort((a, b) => a.t - b.t);
// a device's knobs: only its own, each a number in range (a missing one: its default)
function knobs(spec, values, sidechain = false) {
  const o = obj(values) || {}, out = {};
  for (const pr of spec.params) {
    if (sidechain && pr.k === 'sc') { out.sc = typeof o.sc === 'string' ? o.sc : ''; continue; }   // (a compressor's key: a track id)
    out[pr.k] = clampN(o[pr.k], Math.min(pr.min, pr.max), Math.max(pr.min, pr.max), pr.def);
  }
  return out;
}
const devices = (list, table, prefix) => {
  const seen = new Set();
  return arr(list).filter((d) => obj(d) && table[d.type]).map((d) => {
    let id = str(d.id, '', 40); if (!id || seen.has(id)) id = uid(prefix); seen.add(id);
    const o = { ...d, id, on: d.on !== false, p: knobs(table[d.type], d.p, table === DEVICES && d.type === 'comp') };
    if (table === DEVICES && d.type === 'lab' && d.lab) o.lab = validatePatch(d.lab, 'fx');   // (an effect of your own: its patch, made safe; none yet: the sound passes)
    else delete o.lab;
    return o;
  });
};
function note(nt) {
  if (!obj(nt) || !Number.isFinite(nt.t) || !Number.isFinite(nt.d) || !(nt.d > 0) || !(nt.n >= 0 && nt.n <= 127)) return null;
  const o = { ...nt, t: Math.max(0, nt.t), d: Math.min(nt.d, 1e5), n: Math.round(nt.n), v: Math.round(clampN(nt.v, 1, 127, 100)) };
  delete o.p; delete o.r; delete o.m; delete o.l;
  if (Number.isFinite(nt.p) && nt.p < 1) o.p = Math.max(0, nt.p);           // chance
  if (Number.isFinite(nt.r) && nt.r > 1) o.r = Math.min(16, Math.round(nt.r));   // ratchet
  if (Number.isFinite(nt.m) && nt.m) o.m = Math.max(-1, Math.min(1, nt.m));  // nudge (beats)
  const l = obj(nt.l);                                                       // parameter locks
  if (l) { const ll = {}; for (const k in l) if (/^\d+$/.test(k) && Number.isFinite(l[k])) ll[k] = l[k]; if (Object.keys(ll).length) o.l = ll; }
  return o;
}
// a clip of the arrangement (start) or of the session (no start)
function clip(c, slot) {
  if (!obj(c)) return null;
  const len = num(c.len, 0);
  if (!(len > 0.001)) return null;
  const o = { ...c, id: str(c.id, '', 40) || uid('c'), name: str(c.name, 'CLIP', 40), len: Math.min(len, 1e5) };
  if (slot) delete o.start; else o.start = Math.max(0, num(c.start, NaN));
  if (!slot && !Number.isFinite(o.start)) return null;
  if (o.loop != null) o.loop = num(o.loop, 0) > 0.001 ? Math.min(o.loop, 1e5) : o.len;
  if (c.follow != null) {                                    // a session clip's follow action
    const F = ['next', 'prev', 'first', 'last', 'any', 'other', 'again', 'stop', 'none'], f = obj(c.follow) || {};
    if (slot && F.includes(f.a)) o.follow = { n: Math.round(clampN(f.n, 1, 64, 1)), a: f.a, b: F.includes(f.b) ? f.b : 'none', p: clampN(f.p, 0, 1, 1) }; else delete o.follow;
  }
  if (c.src != null || c.takes != null) {                   // audio
    o.src = str(c.src, null, 80); o.offset = Math.max(0, num(c.offset, 0)); o.gain = clampN(c.gain, -60, 24, 0);
    o.fadeIn = Math.max(0, num(c.fadeIn, 0.005)); o.fadeOut = Math.max(0, num(c.fadeOut, 0.01));
    // a crossfade with the clip before (beats, across the seam), the clip's own gain envelope (beats from its start, dB)
    if (c.xf != null) { o.xf = clampN(c.xf, 0, Math.min(16, o.len), 0); if (!o.xf) delete o.xf; }
    if (c.env != null) { o.env = envPoints(c.env, o.len); if (!o.env.length) delete o.env; }
    if (c.takes != null) {
      o.takes = arr(c.takes).filter((k) => obj(k) && typeof k.src === 'string').map((k) => ({ ...k, at: num(k.at, o.start || 0), offset: Math.max(0, num(k.offset, 0)), name: str(k.name, 'TAKE', 40) }));
      o.comp = arr(c.comp).filter((x) => obj(x) && Number.isFinite(x.a) && Number.isFinite(x.b) && x.b > x.a && Number.isInteger(x.k) && x.k >= 0 && x.k < o.takes.length);
      if (!o.takes.length) { delete o.takes; delete o.comp; }
    }
    if (!o.src && !o.takes) return null;
    delete o.notes;
    if (c.wm != null) {                                         // warp markers: { s: seconds of the file, b: its beat }
      o.wm = arr(c.wm).filter((m) => obj(m) && Number.isFinite(m.s) && Number.isFinite(m.b) && m.s >= 0).map((m) => ({ s: m.s, b: m.b })).sort((a, b) => a.b - b.b);
      if (!o.wm.length) delete o.wm;
    }
  } else {
    o.notes = arr(c.notes).map(note).filter(Boolean);
    if (c.ctl != null) {                                        // controller lanes: { 'cc:64' | 'pb' | 'cp': [{ t, v }] }
      const ct = obj(c.ctl) || {}; o.ctl = {};
      for (const k in ct) {
        if (!/^(cc:\d{1,3}|pb|cp)$/.test(k)) continue;
        const lo = k === 'pb' ? -8192 : 0, hi = k === 'pb' ? 8191 : 127;
        const pts = points(ct[k]).map((q) => ({ t: q.t, v: Math.round(Math.max(lo, Math.min(hi, q.v))) }));
        if (pts.length) o.ctl[k] = pts;
      }
      if (!Object.keys(o.ctl).length) delete o.ctl;
    }
    if (c.mtakes != null) {                                     // MIDI takes, and the comp over them
      o.mtakes = arr(c.mtakes).filter(obj).map((k, i) => ({ name: str(k.name, `TAKE ${i + 1}`, 40), notes: arr(k.notes).map(note).filter(Boolean) }));
      o.comp = arr(c.comp).filter((x) => obj(x) && Number.isFinite(x.a) && Number.isFinite(x.b) && x.b > x.a && Number.isInteger(x.k) && x.k >= 0 && x.k < o.mtakes.length);
      if (!o.mtakes.length) { delete o.mtakes; delete o.comp; }
    }
    if (o.loop == null) o.loop = o.len;
  }
  return o;
}

export function validate(p) {
  p = migrate(p);
  if (!Array.isArray(p.tracks)) throw new Error('This file is not a Kraken project: it has no tracks.');
  const d = newProject();
  p.name = str(p.name, 'Untitled', 40) || 'Untitled';
  p.bpm = clampN(p.bpm, 20, 300, 120);
  p.sig = clampN(p.sig, 0.25, 32, 4);
  p.meters = cleanMeters(p);                                    // time signature changes, on bar lines
  p.sig = meterList(p)[0].len;                                  // (the first bar's length in beats)
  p.swing = clampN(p.swing, 0, 1, 0);
  p.launchQ = clampN(p.launchQ, 0, 64, 4);
  p.countIn = !!p.countIn;
  p.recTakes = p.recTakes !== false;
  // project macros: 8 knobs, each one turning many parameters of many tracks at once ({ track, key, lo, hi })
  const ms = arr(p.macros).filter(obj);
  p.macros = [...Array(Math.max(MACROS, Math.min(16, ms.length)))].map((_, i) => {
    const m = ms[i] || {};
    return { id: str(m.id, '', 40) || `m${i}`, name: str(m.name, `MACRO ${i + 1}`, 16) || `MACRO ${i + 1}`, v: clampN(m.v, 0, 1, 0),
      to: arr(m.to).filter((x) => obj(x) && typeof x.track === 'string' && typeof x.key === 'string').map((x) => ({ track: x.track, key: x.key, lo: num(x.lo, 0), hi: num(x.hi, 1) })) };
  });
  const ma = obj(p.macroAuto) || {}; p.macroAuto = {};
  for (const k in ma) { const pts = points(ma[k]); if (/^m\d+$/.test(k) && pts.length) p.macroAuto[k] = pts.map((q) => ({ ...q, v: Math.max(0, Math.min(1, q.v)) })); }                            // loop recording: each pass a take (or overdub)
  const span = (x, def) => { const o = obj(x); const a = Math.max(0, num(o?.a, def.a)), b = num(o?.b, def.b); return { ...(o || {}), on: o ? !!o.on : def.on, a, b: b > a ? b : a + 4 }; };
  p.loop = span(p.loop, d.loop);
  p.punch = span(p.punch, d.punch);
  p.tempo = points(p.tempo).map((q) => ({ t: q.t, v: Math.max(20, Math.min(300, q.v)) }));
  if (obj(p.key) && Number.isFinite(p.key.root)) p.key = { root: Math.round(clampN(p.key.root, 0, 11, 0)), sc: Math.round(clampN(p.key.sc, 0, 63, 0)) }; else delete p.key;   // the song's key (the piano roll lights it)
  p.markers = arr(p.markers).filter((m) => obj(m) && Number.isFinite(m.t)).map((m) => ({ id: str(m.id, '', 40) || uid('k'), t: Math.max(0, m.t), name: str(m.name, 'MARKER', 40) }));
  p.scenes = arr(p.scenes).filter(obj).map((s, i) => ({ ...s, id: str(s.id, '', 40) || uid('s'), name: str(s.name, `SCENE ${i + 1}`, 24) }));
  if (!p.scenes.length) p.scenes = d.scenes;
  p.assets = obj(p.assets) || {};
  for (const k of Object.keys(p.assets)) if (!obj(p.assets[k])) delete p.assets[k];
  p.master = obj(p.master) || d.master;
  p.master.vol = clampN(p.master.vol, -60, 12, 0);
  p.master.fx = devices(p.master.fx, DEVICES, 'f').filter((d) => d.type !== 'wam');   // (plugins: on tracks only)
  const lim = obj(p.master.limit);                              // (before the switch: always on, at -0.3 dB)
  p.master.limit = { on: lim ? lim.on !== false : true, ceil: Math.round(clampN(lim?.ceil, -6, 0, -0.3) * 10) / 10 };
  p.returns = (Array.isArray(p.returns) ? p.returns : d.returns).filter(obj);
  p.returns.forEach((r, i) => {
    r.id = str(r.id, '', 40) || uid('r'); r.name = str(r.name, `RETURN ${i + 1}`, 24);
    r.type ??= i === 0 ? 'reverb' : i === 1 ? 'delay' : 'none';
    if (!['reverb', 'delay', 'none'].includes(r.type)) r.type = 'none';
    r.vol = clampN(r.vol, -60, 12, -4); r.mute = !!r.mute; r.fx = devices(r.fx, DEVICES, 'f').filter((d) => d.type !== 'wam');
    if (r.type === 'reverb') { r.size = clampN(r.size, 0, 1, 0.82); r.damp = clampN(r.damp, 0, 1, 0.35); r.pre = clampN(r.pre, 0, 0.5, 0.02); }
    if (r.type === 'delay') { r.time = clampN(r.time, 0.01, 8, 0.75); r.fb = clampN(r.fb, 0, 0.98, 0.42); r.tone = clampN(r.tone, 0, 1, 0.55); }
  });
  // the tracks: unknown kinds and broken entries left out, every field in shape
  const ids = new Set();
  p.tracks = p.tracks.filter((t) => obj(t) && KINDS.has(t.kind));
  for (const [i, t] of p.tracks.entries()) {
    let id = str(t.id, '', 40); if (!id || ids.has(id)) id = uid('t'); ids.add(id); t.id = id;
    t.name = str(t.name, `TRACK ${i + 1}`, 24) || `TRACK ${i + 1}`;
    t.color = typeof t.color === 'string' && COLOR.test(t.color) ? t.color : COLORS[i % COLORS.length];
    t.vol = clampN(t.vol, -60, 12, -6); t.pan = clampN(t.pan, -1, 1, 0);
    t.mute = !!t.mute; t.solo = !!t.solo; t.arm = !!t.arm;
    t.sends = arr(t.sends).map((x) => clampN(x, 0, 1, 0)); while (t.sends.length < p.returns.length) t.sends.push(0);
    t.sendPre = arr(t.sendPre).map(Boolean);
    if (t.kind === 'synth' || t.kind === 'wam') { t.bank = t.bank === 'sloop' ? 'sloop' : 'clipper'; }
    if (t.kind === 'drum') t.bank = 'sloop';
    t.engine = Math.max(0, Math.round(num(t.engine, 0))); t.preset = Math.max(0, Math.round(num(t.preset, 0))); t.kit = Math.max(0, Math.round(num(t.kit, 15)));
    t.rev = Math.round(num(t.rev, 0));
    const pa = obj(t.params) || {}; t.params = {};
    for (const k in pa) if (/^\d+$/.test(k) && Number.isFinite(pa[k])) t.params[k] = Math.round(pa[k]);
    t.clips = arr(t.clips).map((c) => clip(c, false)).filter(Boolean);
    if (t.kind === 'group') t.clips = [];
    t.slots = arr(t.slots).slice(0, p.scenes.length).map((c) => (c ? clip(c, true) : null));
    while (t.slots.length < p.scenes.length) t.slots.push(null);
    const au = obj(t.auto) || {}; t.auto = {};
    for (const k in au) { const pts = points(au[k]); if (pts.length) t.auto[k] = pts; }
    t.fx = devices(t.fx, DEVICES, 'f').map((d) => (d.type === 'wam' ? cleanWamFx(d) : d)).filter(Boolean);   // (a plugin: its address, its state)
    t.nfx = devices(t.nfx, NOTE_FX, 'n');
    t.mods = devices(t.mods, MODS, 'm').map((m) => ({ ...m, to: arr(m.to).filter((x) => obj(x) && typeof x.key === 'string').map((x) => ({ ...x, amt: clampN(x.amt, -1, 1, 0) })) }));
    t.midiCh = Math.round(clampN(t.midiCh, 0, 16, 0));
    t.out = typeof t.out === 'string' ? t.out : 'master';
    if (t.h != null) { t.h = Math.round(clampN(t.h, 30, 240, 58)); }                   // its height in the arrangement (px)
    if (t.fold != null) { if (t.kind === 'group' && t.fold) t.fold = true; else delete t.fold; }   // a group folded: its tracks hidden
    if (t.vca != null && typeof t.vca !== 'string') delete t.vca;
    if (t.kind === 'lab') t.lab = validatePatch(t.lab, 'inst'); else delete t.lab;   // LAB: an instrument of your own (lab-modules.js)
    if (t.kind === 'sampler') {
      const s = obj(t.sample) || {};
      t.sample = { ...s, src: typeof s.src === 'string' ? s.src : null, name: str(s.name, '', 80), root: Math.round(clampN(s.root, 0, 127, 60)), mode: s.mode === 'slice' ? 'slice' : 'keys',
        slices: Math.round(clampN(s.slices, 1, 64, 16)), start: clampN(s.start, 0, 1, 0), end: clampN(s.end, 0, 1, 1), att: clampN(s.att, 0, 5000, 2), rel: clampN(s.rel, 0, 10000, 150),
        gain: clampN(s.gain, -60, 24, 0), loop: !!s.loop, tune: clampN(s.tune, -100, 100, 0),
        dec: clampN(s.dec, 0, 20000, 0), sus: clampN(s.sus, 0, 1, 1), cut: clampN(s.cut, 30, 20000, 20000), res: clampN(s.res, 0, 0.95, 0), fenv: clampN(s.fenv, 0, 8, 0),
        zones: arr(s.zones).filter((z) => obj(z) && typeof z.src === 'string').slice(0, 128).map((z) => {
          const lo = Math.round(clampN(z.lo, 0, 127, 0)), vlo = Math.round(clampN(z.vlo, 1, 127, 1));
          return { src: z.src, name: str(z.name, '', 80), root: Math.round(clampN(z.root, 0, 127, 60)), lo, hi: Math.max(lo, Math.round(clampN(z.hi, 0, 127, 127))),
            vlo, vhi: Math.max(vlo, Math.round(clampN(z.vhi, 1, 127, 127))), gain: clampN(z.gain, -60, 24, 0), tune: clampN(z.tune, -100, 100, 0) };
        }) };
      if (!t.sample.zones.length) delete t.sample.zones;
      if (t.sample.end <= t.sample.start) { t.sample.start = 0; t.sample.end = 1; }
    }
    if (t.kind === 'drum') {                                   // pads with your own samples (note -> one-shot)
      const pads = {};
      for (const [k, pd] of Object.entries(obj(t.pads) || {})) {
        const n = +k;
        if (!Number.isInteger(n) || n < 0 || n > 127 || !obj(pd) || typeof pd.src !== 'string') continue;
        const st = clampN(pd.start, 0, 1, 0), en = clampN(pd.end, 0, 1, 1);
        pads[n] = { src: pd.src, name: str(pd.name, '', 80), gain: clampN(pd.gain, -60, 24, 0), tune: clampN(pd.tune, -48, 48, 0), dec: clampN(pd.dec, 0, 20000, 0),
          choke: Math.round(clampN(pd.choke, 0, 8, 0)), start: en > st ? st : 0, end: en > st ? en : 1, cut: clampN(pd.cut, 30, 20000, 20000) };
      }
      if (Object.keys(pads).length) t.pads = pads; else delete t.pads;
    }
    if (t.kind === 'audio') {                                  // its input channels (b null: mono) and its monitoring
      const ip = obj(t.input) || {}; t.input = { a: Math.round(clampN(ip.a, 0, 31, 0)), b: ip.b === null ? null : Math.round(clampN(ip.b, 0, 31, 1)) };
      t.monitor = ['auto', 'in', 'off'].includes(t.monitor) ? t.monitor : 'auto';
    }
    if (t.kind === 'wam') t.wam = cleanPlugin(t.wam);
    else delete t.wam;
    if (t.kind === 'external') { const e = obj(t.ext) || {}; t.ext = { ...e, port: str(e.port, '', 200), ch: Math.round(clampN(e.ch, 1, 16, 1)), latency: clampN(e.latency, -500, 500, 0) }; }
    if (t.frozen && !(obj(t.frozen) && typeof t.frozen.src === 'string')) delete t.frozen;
  }
  // routing: a track goes to the master or to a group that exists, never into itself or round in a circle
  const groups = new Map(p.tracks.filter((t) => t.kind === 'group').map((t) => [t.id, t]));
  for (const t of p.tracks) if (t.out !== 'master' && (!groups.has(t.out) || t.out === t.id)) t.out = 'master';
  for (const t of p.tracks) {
    const seen = new Set([t.id]);
    for (let g = groups.get(t.out); g; g = groups.get(g.out)) { if (seen.has(g.id)) { t.out = 'master'; break; } seen.add(g.id); }
  }
  // a VCA: a VCA track that exists
  const vcas = new Set(p.tracks.filter((t) => t.kind === 'vca').map((t) => t.id));
  for (const t of p.tracks) if (t.vca != null && (!vcas.has(t.vca) || t.kind === 'vca')) delete t.vca;
  for (const t of p.tracks) if (t.kind === 'vca') { t.clips = []; t.out = 'master'; }
  for (const m of p.macros) m.to = m.to.filter((x) => ids.has(x.track));
  // a compressor's sidechain and a follower's source: a track that exists
  for (const t of p.tracks) {
    for (const f of t.fx) if (f.type === 'comp' && f.p.sc && !ids.has(f.p.sc)) f.p.sc = '';
    for (const m of t.mods) if (m.type === 'follow' && !ids.has(m.src)) m.src = t.id;
  }
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

// clear the beats [a, b) of a track's clips (a recording or a moved clip lands there): what overlaps is cut,
// a clip across the range becomes two, each part still playing what it played. bpm for audio offsets.
// automation between two points: a line, or a curve (the first point's c, -1..1: slow then fast, or fast then slow),
// held before the first and after the last
export const curveOf = (c, x) => (!c || Math.abs(c) < 1e-3 ? x : (Math.exp(c * 5 * x) - 1) / (Math.exp(c * 5) - 1));
export function autoAt(pts, t) {
  if (!pts || !pts.length) return null;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) if (t < pts[i].t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * curveOf(a.c, (t - a.t) / (b.t - a.t)); }
  return pts[pts.length - 1].v;
}
// a clip's gain envelope: points in order, inside the clip, -60..+12 dB
export function envPoints(pts, len) {
  return (Array.isArray(pts) ? pts : []).filter((q) => q && Number.isFinite(q.t) && Number.isFinite(q.v)).map((q) => ({ t: Math.max(0, Math.min(len, q.t)), v: Math.max(-60, Math.min(12, q.v)) }))
    .sort((x, y) => x.t - y.t).slice(0, 2000);
}
export function envAt(pts, t) {
  if (!pts?.length) return 0;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) if (t < pts[i].t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1)); }
  return pts[pts.length - 1].v;
}
export function cutRange(clips, a, b, bpm, keep = null) {
  const out = [], spb = 60 / bpm;
  for (const c of clips) {
    const s = c.start, e = c.start + c.len;
    if (c === keep || c.id === keep || e <= a + 1e-6 || s >= b - 1e-6) { out.push(c); continue; }
    if (s < a - 1e-6) {                                           // the part before
      const left = structuredClone(c);
      left.len = a - s;
      if (left.notes && (left.loop || 0) >= c.len - 1e-6) left.loop = left.len;
      if (isFolder(left)) left.comp = left.comp.filter((g) => g.a < left.len).map((g) => ({ ...g, b: Math.min(g.b, left.len) }));
      if (left.env) left.env = [...left.env.filter((q) => q.t < left.len), { t: left.len, v: envAt(c.env, left.len) }];
      if (left.xf) left.xf = Math.min(left.xf, left.len);
      out.push(left);
    }
    if (e > b + 1e-6) {                                           // the part after, in phase with what was there
      const right = structuredClone(c), off = b - s;
      right.id = uid('c'); right.start = b; right.len = e - b;
      delete right.xf;                                            // (a cut is not a crossfade)
      if (c.env) right.env = [{ t: 0, v: envAt(c.env, off) }, ...c.env.filter((q) => q.t > off).map((q) => ({ ...q, t: q.t - off }))];
      if (c.notes) {
        const loop = c.loop || c.len;
        if (loop < c.len - 1e-6) { const ph = off % loop; right.notes = c.notes.filter((n) => n.t < loop).map((n) => ({ ...n, t: ((n.t - ph) % loop + loop) % loop })); right.loop = loop; }
        else { right.notes = c.notes.filter((n) => n.t >= off - 1e-6).map((n) => ({ ...n, t: n.t - off })); right.loop = right.len; }
      } else if (isFolder(c)) shiftFolder(right, c.takes, c.comp, off, right.len);
      else if (c.src) right.offset = (c.offset || 0) + off * (c.warp === 'repitch' && c.bpm ? 60 / c.bpm : spb);
      out.push(right);
    }
  }
  return out;
}
