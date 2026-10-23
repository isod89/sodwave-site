// SPDX-License-Identifier: GPL-3.0-only
// SLOOP songs (.sloopsong, SLOOP 2.7+ web editor: Song & sections > Export this song) into a Kraken project.
// The file: JSON {format: "sloop-song", version, name, firmware, order: base64 | null, objects: [{id, len, crc, data}]}.
// Object 0 is the working loop, 2..5 the sections A..D; each one a SLOOP project record (firmware/src/project.c,
// format 6 "FUN6", or 5 "FUN5"): the globals, then four tracks (three synth parts and the drums) of 64 steps with
// their nudges, fill conditions and parameter locks. order: the SONG screen's 36 bytes (arranger.h arr_config_t):
// count, loop, 2 spare, then 16 x {scene, bars}.
// The steps are played here the way the FM-1's sequencer plays them (seq.c seq_tick / seq_step): division, length,
// swing, gate, ties, slides, ratchets, nudges, levels, accents; then written as Kraken notes.
import { newProject, newTrack, newClip, uid, COLORS } from './project.js';

const SONG = { FORMAT: 'sloop-song', SECS: [2, 3, 4, 5], ORDER_LEN: 36 };
const MAGIC6 = 0x46554e36, MAGIC5 = 0x46554e35;
const NTRK = 4, NSTEP = 64, NLOCK = 24, TRK_DRUM = 3;
// parameter ids (core.h)
const P = { LEVEL: 0, AMODE: 17, AHOLD: 23, ROOT: 25, TRANS: 28, SLEN: 29, SDIV: 30, SSWING: 31, SGATE: 32, PAN: 39, MUTE: 40, CHORD: 49, VLEAD: 52, ITYPE: 53, E0: 63, COUNT: 71 };
const G = { BPM: 0, SWING: 1, DRLVL: 25, DRREV: 26 };
// what the sequencer, the keys or Kraken's own mixer do, not the sound: never written as a sound parameter
const NOT_SOUND = new Set([17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 39, 40, 49, 52]);
const ST_NOTE = 0, ST_TIE = 1, ST_REST = 2;
const SF_ACCENT = 1, SF_SLIDE = 2, SF_CONT_ALL = 0x78, SF_LEG = 0x80;
const FC_FILL = 1;
const DIV_BEATS = [1, 0.5, 0.25, 0.125, 1 / 3, 1 / 6, 2, 4, 8];   // N_SDIV: 1/4 1/8 1/16 1/32 8T 16T 1/2 1BAR 2BAR
export const LANE_NOTE = [36, 35, 38, 39, 42, 46, 44, 37, 40, 43, 48, 49, 51, 70, 63, 56];
const LV = [0, 42, 72, 127];
const lvlVel = (lvl, vel) => (lvl & 3 ? LV[lvl & 3] : vel);
const SEC_NAME = ['A', 'B', 'C', 'D'];

// --------------------------------------------------------------- bytes ---
function b64(s) {
  s = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
  if (typeof atob === 'function') return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(s, 'base64'));
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// a project record -> {format, g[32], drdly, tracks: [{p[71], engine, preset, steps[64], micro[64], fill[64], locks}]}
export function parseRecord(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 8) throw new Error('too short');
  const magic = v.getUint32(0, true), v6 = magic === MAGIC6, v5 = magic === MAGIC5;
  if (!v6 && !v5) {
    const f = d[1] === 0x4e && d[2] === 0x55 && d[3] === 0x46 ? d[0] - 0x30 : 0;
    throw new Error(f ? `saved by an older SLOOP (format ${f}): load and save it on SLOOP 2.4 or later first` : 'not a SLOOP project');
  }
  const TS = v6 ? 934 : 940, size = 76 + NTRK * TS + 4;
  if (d.length < size) throw new Error('cut short');
  const g = [];
  for (let i = 0; i < 32; i++) g.push(v.getInt16(8 + 2 * i, true));
  const tracks = [];
  for (let k = 0; k < NTRK; k++) {
    const o = 76 + k * TS, p = new Array(P.COUNT).fill(null);
    let so, mo, lo;
    if (v6) {
      for (let i = 0; i < 53; i++) p[i] = v.getInt16(o + 2 * i, true);
      for (let i = 0; i < 8; i++) p[P.E0 + i] = v.getInt16(o + 106 + 2 * i, true);
      for (let i = 0; i < 10; i++) p[P.ITYPE + i] = d[o + 122 + i];
      so = o + 134; mo = o + 774; lo = o + 838;
    } else {
      for (let i = 0; i < 53; i++) p[i] = v.getInt16(o + 2 * i, true);
      for (let i = 0; i < 8; i++) p[P.E0 + i] = v.getInt16(o + 106 + 2 * i, true);
      so = o + 124; mo = o + 764; lo = o + 828;
    }
    const engine = d[so - 2], preset = d[so - 1];
    const steps = [], micro = [], fill = [];
    for (let i = 0; i < NSTEP; i++) {
      const s = so + 10 * i;
      steps.push(d.subarray(s, s + 10));
      if (v6) { const m = d[mo + i] & 63; micro.push(m >= 32 ? m - 64 : m); fill.push(d[mo + i] >> 6); }
      else { micro.push(v.getInt8(mo + i)); fill.push((d[o + 924 + (i >> 2)] >> (2 * (i & 3))) & 3); }
    }
    const locks = [];
    for (let i = 0; i < NLOCK; i++) {
      const l = lo + 4 * i, step = d[l], param = d[l + 1];
      if (step < NSTEP && param < P.COUNT) locks.push({ step, param, val: v.getInt16(l + 2, true) });
    }
    tracks.push({ p, engine, preset, steps, micro: micro.map((m) => Math.max(-32, Math.min(31, m))), fill: fill.map((c) => (c === 3 ? 0 : c)), locks });
  }
  return { format: v6 ? 6 : 5, g, drdly: d[73], tracks };
}

// the file -> {name, loop, sections: [rec | null] x4, order: [{sec, bars}] | null, loopFlag, warnings}
export function parseSong(json) {
  const f = typeof json === 'string' ? JSON.parse(json) : json;
  if (!f || f.format !== SONG.FORMAT || !Array.isArray(f.objects)) throw new Error('This file is not a SLOOP song.');
  const warnings = [], recs = new Map();
  for (const o of f.objects) {
    const d = b64(o.data);
    if (!(o.id === 0 || SONG.SECS.includes(o.id))) continue;
    if (d.length !== o.len || crc32(d) !== (o.crc >>> 0)) throw new Error(`This SLOOP song is damaged (${o.id ? `section ${SEC_NAME[o.id - 2]}` : 'the loop'}).`);
    if (!d.length) continue;
    try { recs.set(o.id, parseRecord(d)); } catch (e) {
      if (o.id === 0) throw new Error(`The loop of this SLOOP song: ${e.message}.`);
      warnings.push(`Section ${SEC_NAME[o.id - 2]} left out: ${e.message}.`);
    }
  }
  if (!recs.has(0)) throw new Error('This SLOOP song has no loop.');
  const sections = SONG.SECS.map((id) => recs.get(id) || null);
  let order = null, loopFlag = false;
  if (f.order) {
    const b = b64(f.order);
    if (b.length === SONG.ORDER_LEN && b[0] >= 1 && b[0] <= 16) {
      const list = [];
      for (let i = 0; i < b[0]; i++) list.push({ sec: b[4 + 2 * i], bars: b[5 + 2 * i] });
      if (list.every((e) => e.sec < 4 && e.bars >= 1 && e.bars <= 64 && sections[e.sec])) { order = list; loopFlag = b[1] === 1; }
      else warnings.push('The song order plays an empty section: each section is placed once instead.');
    }
  }
  return { name: String(f.name || '').trim(), firmware: f.firmware || '', loop: recs.get(0), sections, order, loopFlag, warnings };
}

// ---------------------------------------------------------- the steps ---
const stepBeats = (tr) => DIV_BEATS[((tr.p[P.SDIV] % 9) + 9) % 9];
const trackLen = (tr) => Math.max(1, Math.min(NSTEP, tr.p[P.SLEN] || 1));
// the bars a section's loop takes (arranger_scene.c section_bars): its longest pattern, at least 1
export function sectionBars(rec) {
  let bars = 1;
  for (const tr of rec.tracks) bars = Math.max(bars, Math.ceil((trackLen(tr) * stepBeats(tr)) / 4 - 1e-9));
  return Math.min(64, bars);
}
function stepVel(s, i) { return lvlVel((s[8] >> (2 * i)) & 3, s[6] & SF_ACCENT ? 127 : s[7] || 96); }
const odd16 = (t) => Math.abs((t % 0.5) - 0.25) < 0.01;

// the notes track tr plays over the grid steps [a, a + count) (absolute: the pattern runs from the song's start),
// times in beats from step a. swing: the song's (0..100); kSwing: what Kraken adds by itself (p.swing)
export function playSteps(tr, a, count, { drum = false, swing = 0, kSwing = 0 } = {}) {
  const len = trackLen(tr), u = stepBeats(tr), div = ((tr.p[P.SDIV] % 9) + 9) % 9;
  const sw = div < 4 ? (Math.max(0, Math.min(100, (tr.p[P.SSWING] || 0) + swing)) * u) / 200 : 0;
  const base = a * u, end = (a + count) * u;
  const out = [];
  const lockAt = (idx) => { const l = {}; let gate = null; for (const k of tr.locks) if (k.step === idx) { if (k.param === P.SGATE) gate = k.val; else if (!NOT_SOUND.has(k.param) && (!drum || k.param >= P.E0 || k.param <= 16)) l[k.param] = k.val; } return { l: Object.keys(l).length ? l : null, gate }; };
  // a note at grid time tg (beats from the song's start), heard at ideal, until off
  const emit = (n, v, tg, ideal, off, extra) => {
    const t = tg - base, real = Math.max(base, ideal), m = real - tg - (odd16(t) ? kSwing * 0.125 : 0);
    const note = { t: +t.toFixed(6), d: +Math.max(0.01, Math.min(off, end) - real).toFixed(6), n, v: Math.max(1, Math.min(127, v)) };
    if (Math.abs(m) > 1e-4) note.m = +m.toFixed(6);
    Object.assign(note, extra);
    if (note.t < end - base - 1e-9 && note.n >= 0 && note.n <= 127) out.push(note);
  };
  let sounding = [];                     // {n, v, tg, ideal, l}
  let hold = false, off = Infinity;
  const release = (at, keep = () => false) => {
    const still = [];
    for (const s of sounding) { if (keep(s)) still.push(s); else emit(s.n, s.v, s.tg, s.ideal, at, s.l ? { l: s.l } : {}); }
    sounding = still;
  };
  for (let abs = a; abs < a + count; abs++) {
    const idx = abs % len, s = tr.steps[idx];
    const grid = abs * u, slen = sw ? (abs & 1 ? u - sw : u + sw) : u;
    const T = grid + (abs & 1 ? sw : 0) + (tr.micro[idx] * u) / 64;
    if (sounding.length && !hold && off <= T) { release(off); }
    const skip = tr.fill[idx] === FC_FILL;           // a fill step: only during a fill (none here)
    const { l, gate: gl } = skip ? { l: null, gate: null } : lockAt(idx);
    const gate = (slen * (gl ?? tr.p[P.SGATE] ?? 64)) / 128;
    if (drum) {
      if (skip) continue;
      const on = s[0] | (s[1] << 8);
      for (let lane = 0; lane < 16; lane++) {
        if (!((on >> lane) & 1)) continue;
        const lvl = (s[2 + (lane >> 2)] >> ((lane & 3) * 2)) & 3, hits = 1 + ((s[6 + (lane >> 2)] >> ((lane & 3) * 2)) & 3);
        const extra = {}; if (hits > 1) extra.r = hits; if (l) extra.l = l;
        emit(LANE_NOTE[lane], lvlVel(lvl, 100), grid, T, T + (hits > 1 ? slen : Math.min(slen, 0.25)), extra);
      }
      continue;
    }
    const n = Math.min(4, s[4]), time = s[5], flags = s[6];
    const nx = tr.steps[(idx + 1) % len];
    const nextTie = nx[5] === ST_TIE || (nx[5] === ST_NOTE && (nx[6] & (SF_CONT_ALL | SF_LEG)));
    if (skip || time === ST_REST || (time === ST_NOTE && !n)) { release(T); hold = false; off = Infinity; continue; }
    if (time === ST_TIE) {
      if (sounding.length) { hold = !!(flags & SF_SLIDE) || !!nextTie; off = T + gate + slen / 2; }
      continue;
    }
    const notes = []; for (let i = 0; i < n; i++) notes.push(s[i] & 127);
    if (flags & SF_CONT_ALL) {             // notes going on from the step before: kept; the others end
      const kept = new Set();
      release(T, (x) => { const i = notes.findIndex((nn, j) => !kept.has(j) && nn === x.n && (flags & (8 << j))); if (i >= 0) { kept.add(i); return true; } return false; });
      notes.forEach((nn, i) => { if (!kept.has(i)) sounding.push({ n: nn, v: stepVel(s, i), tg: grid, ideal: T, l }); });
      hold = !!(flags & SF_SLIDE) || !!nextTie; off = T + gate;
      continue;
    }
    let hits = 1;
    for (let i = 0; i < n; i++) hits = Math.max(hits, 1 + ((s[9] >> (2 * i)) & 3));
    const slideIn = hold && sounding.length > 0;
    if (hits > 1) {                        // ratchets: each hit its share of the step, never held over
      release(slideIn ? T + 0.01 : T);
      notes.forEach((nn, i) => { const r = 1 + ((s[9] >> (2 * i)) & 3), extra = {}; if (r > 1) extra.r = r; if (l) extra.l = l;
        emit(nn, stepVel(s, i), grid, T, T + (r > 1 ? slen : gate / hits), extra); });
      hold = false; off = Infinity;
      continue;
    }
    if (slideIn) {                         // a slide: the same notes go on, the others overlap the new ones a little
      const kept = new Set();
      release(T + 0.01, (x) => { const i = notes.findIndex((nn, j) => !kept.has(j) && nn === x.n); if (i >= 0) { kept.add(i); return true; } return false; });
      notes.forEach((nn, i) => { if (!kept.has(i)) sounding.push({ n: nn, v: stepVel(s, i), tg: grid, ideal: T, l }); });
    } else {
      release(T);
      notes.forEach((nn, i) => sounding.push({ n: nn, v: stepVel(s, i), tg: grid, ideal: T, l }));
    }
    hold = !!(flags & SF_SLIDE) || !!nextTie; off = T + gate;
  }
  release(hold ? end : Math.min(off, end));
  return out.sort((x, y) => x.t - y.t || x.n - y.n);
}
const hasSteps = (tr, drum) => { const len = trackLen(tr); for (let i = 0; i < len; i++) { const s = tr.steps[i]; if (drum ? s[0] | s[1] : s[5] === ST_NOTE && s[4]) return true; } return false; };

// ------------------------------------------------------------ to Kraken ---
// cat: the sloop catalog (app.lib.sloop) for the names and to check the engines; defaults(engine, preset): the
// values a factory sound loads with (only the knobs set otherwise are kept as the track's own). Both optional
export function songToProject(song, cat = null, defaults = null) {
  const p = newProject(), warnings = [...song.warnings];
  const g = song.loop.g;
  p.name = (song.name || 'SLOOP SONG').toUpperCase().slice(0, 40);
  p.bpm = Math.max(40, Math.min(240, g[G.BPM] || 90));
  p.swing = Math.max(0, Math.min(100, g[G.SWING] || 0)) / 100;
  p.returns.forEach((r) => { r.vol = r.vol ?? -4; });
  const swing = g[G.SWING] || 0, kSwing = p.swing;
  // the sections in the song's order (no order: each one there once, A..D; none at all: the loop)
  const recs = song.sections.map((r, i) => r && { rec: r, name: SEC_NAME[i], sec: i }).filter(Boolean);
  let plan = song.order ? song.order.map((e) => ({ rec: song.sections[e.sec], name: SEC_NAME[e.sec], sec: e.sec, bars: e.bars }))
    : recs.map((x) => ({ ...x, bars: sectionBars(x.rec) }));
  if (!plan.length) plan = [{ rec: song.loop, name: 'LOOP', sec: -1, bars: sectionBars(song.loop) }];
  const engines = cat?.engines?.length || 12, kits = cat?.kits?.length || 46;
  // one Kraken track per SLOOP track and sound (engine + preset, or drum kit): a section with another sound on
  // the same SLOOP track gets a track of its own; knob changes from one section to the next become automation
  const tracks = new Map();
  const soundOf = (k, tr) => {
    if (k === TRK_DRUM) return { key: `d${Math.max(0, Math.min(kits - 1, tr.p[P.E0] || 0))}`, kind: 'drum', kit: Math.max(0, Math.min(kits - 1, tr.p[P.E0] || 0)) };
    let engine = tr.engine, preset = tr.preset === 0xff ? 0 : tr.preset;
    if (engine >= engines) { warnings.push(`Track ${k + 1}: the ${engine === 12 ? 'SLICE' : `#${engine}`} engine is not in Kraken: played with SAMPLE.`); engine = 4; preset = 0; }
    const np = cat?.engines?.[engine]?.presets?.length;
    if (np) preset %= np;
    return { key: `s${k}:${engine}:${preset}`, kind: 'synth', engine, preset };
  };
  const values = (k, tr, rec) => {               // what may change from one section to the next on that track
    const o = {};
    if (k === TRK_DRUM) { o.vol = -6 + 20 * Math.log10(Math.max(1, rec.g[G.DRLVL] ?? 100) / 100); return o; }
    for (let i = 0; i < P.COUNT; i++) if (!NOT_SOUND.has(i) && tr.p[i] != null) o[`p${i}`] = tr.p[i];
    o.pan = Math.max(-1, Math.min(1, (tr.p[P.PAN] || 0) / 64));
    return o;
  };
  const trackFor = (k, tr, rec) => {
    const s = soundOf(k, tr);
    let x = tracks.get(s.key);
    if (!x) {
      const i = tracks.size;
      const name = k === TRK_DRUM ? `DRUMS${[...tracks.keys()].some((q) => q[0] === 'd') ? ' ' + (cat?.kits?.[s.kit] || s.kit) : ''}`
        : `${k + 1} ${(cat?.engines?.[s.engine]?.presets?.[s.preset] || cat?.engines?.[s.engine]?.name || 'PART').toUpperCase()}`.slice(0, 16);
      const t = newTrack(s.kind, i, { name, color: COLORS[(k === TRK_DRUM ? 0 : k + 1) % COLORS.length], bank: 'sloop', engine: s.engine ?? 0, preset: s.preset ?? 0, kit: s.kit ?? 15, sends: [0, 0] });
      t.order = k * 100 + i;
      x = { t, k, base: null, points: {} };
      tracks.set(s.key, x);
    }
    return x;
  };
  let at = 0;
  for (const e of plan) {
    const beats = e.bars * 4;
    e.rec.tracks.forEach((tr, k) => {
      const drum = k === TRK_DRUM;
      if (!hasSteps(tr, drum)) return;
      const x = trackFor(k, tr, e.rec);
      const vals = values(k, tr, e.rec);
      if (!x.base) x.base = vals;
      for (const key in vals) (x.points[key] ||= []).push({ t: at, v: vals[key] });
      if (!drum && tr.p[P.MUTE]) return;                        // muted in this section: no clip
      const u = stepBeats(tr), len = trackLen(tr), first = Math.round(at / u), count = Math.ceil(beats / u - 1e-9);
      const patBeats = len * u, div = ((tr.p[P.SDIV] % 9) + 9) % 9;
      const swung = kSwing > 0 || (div < 4 && (tr.p[P.SSWING] || 0) + swing > 0);
      const c = newClip(at, beats, e.name);
      if (first % len === 0 && patBeats <= beats + 1e-9 && (len % 2 === 0 || !swung)) {   // the pattern from its first step: one pass, looped
        c.notes = playSteps(tr, first, len, { drum, swing, kSwing });
        c.loop = +patBeats.toFixed(6);
      } else c.notes = playSteps(tr, first, count, { drum, swing, kSwing });
      x.t.clips.push(c);
    });
    at += beats;
  }
  // the session: one scene per section (A..D) and the loop, each clip its pattern, looped
  const scenes = [...recs.map((x) => ({ rec: x.rec, name: x.name })), { rec: song.loop, name: 'LOOP' }];
  scenes.forEach((sc, si) => {
    if (si >= p.scenes.length) return;
    p.scenes[si].name = sc.name === 'LOOP' ? 'SLOOP LOOP' : `SECTION ${sc.name}`;
    sc.rec.tracks.forEach((tr, k) => {
      const drum = k === TRK_DRUM;
      if (!hasSteps(tr, drum) || (!drum && tr.p[P.MUTE])) return;
      const x = trackFor(k, tr, sc.rec), u = stepBeats(tr), len = trackLen(tr);
      if (!x.base) x.base = values(k, tr, sc.rec);
      const patBeats = len * u, loopBeats = Math.max(patBeats, 4 * Math.ceil(patBeats / 4 - 1e-9));
      const c = newClip(0, +loopBeats.toFixed(6), sc.name);
      delete c.start;
      c.notes = playSteps(tr, 0, Math.ceil(loopBeats / u - 1e-9), { drum, swing, kSwing });
      x.t.slots[si] = c;
    });
  });
  // each track's sound: the first section's values; the changes later as automation (a step at each section)
  const list = [...tracks.values()].sort((q, r) => q.t.order - r.t.order);
  for (const x of list) {
    const t = x.t;
    delete t.order;
    const b = x.base || {};
    for (const key in b) {
      if (key === 'vol') t.vol = +b.vol.toFixed(2);
      else if (key === 'pan') t.pan = +b.pan.toFixed(3);
      else t.params[+key.slice(1)] = b[key];
    }
    const def = t.kind === 'synth' && defaults ? defaults(t.engine, t.preset) : null;
    if (def) for (const id in t.params) if (def[id] === t.params[id]) delete t.params[id];
    for (const key in x.points) {
      const pts = x.points[key];
      if (pts.every((q) => q.v === pts[0].v)) continue;
      const auto = [];
      pts.forEach((q, i) => { if (i && pts[i - 1].v !== q.v) auto.push({ t: Math.max(0, q.t - 0.01), v: pts[i - 1].v }); if (!i || pts[i - 1].v !== q.v) auto.push({ t: q.t, v: q.v }); });
      t.auto[key] = auto;
    }
  }
  p.tracks = list.map((x) => x.t);
  p.loop = { on: song.loopFlag, a: 0, b: Math.max(4, at) };
  p.markers = [];
  let m = 0;
  for (const e of plan) { if (e.name !== 'LOOP' && !p.markers.some((q) => q.t === m)) p.markers.push({ id: uid('k'), t: m, name: `SECTION ${e.name}` }); m += e.bars * 4; }
  if (!p.tracks.length) throw new Error('This SLOOP song has no notes.');
  return { project: p, warnings };
}

export function importSloopSong(text, cat, defaults) {
  return songToProject(parseSong(text), cat, defaults);
}
// the factory values of the SLOOP sounds, from the engine itself (a WebAssembly.Module of sloop.wasm)
export function presetDefaults(module) {
  const cache = new Map();
  let w = null;
  return (engine, preset) => {
    const key = `${engine}:${preset}`;
    if (!cache.has(key)) {
      w ||= new WebAssembly.Instance(module, {}).exports;
      w.k_init(0);
      w.k_preset(engine, preset);
      const v = {};
      for (let i = 0; i < P.COUNT; i++) v[i] = w.k_get(i);
      cache.set(key, v);
    }
    return cache.get(key);
  };
}
