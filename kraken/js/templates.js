// SPDX-License-Identifier: GPL-3.0-only
// Starters: a song already playing in a style, ready to be changed. Each one: drums, bass, chords and a top line on
// factory sounds of SLOOP / Clipper, mixed, 8 bars, the loop on, a scene for each part in the session.
import { newProject, newTrack, newClip, uid } from './project.js';
import { defaults } from './fx.js';

const fx = (type, p = {}) => ({ id: uid('f'), type, on: true, p: { ...defaults(type), ...p } });
function sound(lib, bank, eng, preset) {
  for (const b of [bank, bank === 'clipper' ? 'sloop' : 'clipper']) {
    const cat = lib[b], e = cat.engines.findIndex((x) => x.name === eng);
    const i = e < 0 ? -1 : cat.engines[e].presets.indexOf(preset);
    if (i >= 0) return { bank: b, engine: e, preset: i };
  }
  return { bank: 'clipper', engine: 0, preset: 0 };
}
const kit = (lib, name) => Math.max(0, lib.sloop.kits.indexOf(name));
// a drum pattern from strings, one per sound, a character per 16th: x hit, o soft, X accent, . nothing
function beat(rows, bars = 1) {
  const notes = [];
  for (const [n, s] of Object.entries(rows)) for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '.' || c === ' ') continue;
    notes.push({ t: i / 4, d: 0.25, n: +n, v: c === 'X' ? 122 : c === 'o' ? 62 : 96 });
  }
  void bars;
  return notes;
}
// chords: [[beat, length, [notes]]]
const chords = (list, v = 82) => list.flatMap(([t, d, ns]) => ns.map((n) => ({ t, d, n, v })));
const line = (list, v = 100) => list.map(([t, d, n, vv]) => ({ t, d, n, v: vv ?? v }));
function track(lib, kind, i, name, s, clipName, notes, loop, extra = {}) {
  const t = newTrack(kind, i, { name, ...s, ...extra.opts });
  const c = newClip(0, 32, clipName); c.loop = loop; c.notes = notes;
  t.clips.push(c);
  Object.assign(t, extra.set || {});
  return t;
}
function finish(p, tracks, scenes) {
  p.tracks = tracks;
  p.loop = { on: true, a: 0, b: 32 };
  // the session: the full groove, and the same without the top line (to build up live)
  const slot = (c) => { const x = structuredClone(c); x.id = uid('c'); delete x.start; x.len = x.loop; return x; };
  p.scenes[0].name = scenes[0]; p.scenes[1].name = scenes[1];
  tracks.forEach((t, i) => { t.slots[1] = slot(t.clips[0]); if (i < tracks.length - 1) t.slots[0] = slot(t.clips[0]); });
  return p;
}

export const STARTERS = [
  { id: 'house', name: 'House', bpm: 124, text: 'Four on the floor, a piano, a round bass' },
  { id: 'hiphop', name: 'Hip-hop', bpm: 90, text: 'Swung drums, Rhodes chords, a deep sub' },
  { id: 'lofi', name: 'Lo-fi', bpm: 78, text: 'Dusty piano, upright bass, vinyl crackle' },
  { id: 'trap', name: 'Trap', bpm: 140, text: 'Rolling hats, a gliding 808, a bell melody' },
  { id: 'techno', name: 'Techno', bpm: 130, text: 'A driving kick, an acid line, a dark pad' },
];

export function starterProject(lib, id) {
  const p = newProject();
  const st = STARTERS.find((s) => s.id === id) || STARTERS[0];
  p.name = `My ${st.name} song`; p.bpm = st.bpm;
  if (id === 'hiphop') {
    p.swing = 0.3;
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'BOOMBAP') }, 'BEAT', beat({
      36: 'X.......x.x.....X.......x.....x.', 38: '....X.......X.......X.......X..o', 42: 'x.x.x.x.x.x.x.xox.x.x.x.x.x.x.xo' }), 8, { opts: { vol: -5, sends: [0.08, 0] } });
    const ch = [[0, 3.8, [50, 53, 57, 60, 64]], [4, 3.8, [55, 58, 62, 65, 69]], [8, 3.8, [48, 52, 55, 59, 62]], [12, 3.8, [53, 57, 60, 64, 67]]];
    const keys = track(lib, 'synth', 1, 'KEYS', sound(lib, 'clipper', 'DIGITAL', 'RHODES'), 'CHORDS', chords(ch, 72), 16, { opts: { vol: -11, sends: [0.25, 0.08] } });
    keys.fx = [fx('eq', { hp: 120, hg: -2 }), fx('chorus', { mx: 0.25 })];
    const bass = track(lib, 'synth', 2, 'BASS', sound(lib, 'clipper', 'ANALOG', 'SUB BASS'), 'SUB', line([[0, 1.5, 38], [2.5, 1, 38], [4, 1.5, 43], [6.5, 1, 43], [8, 1.5, 36], [10.5, 1, 36], [12, 2, 41], [14.5, 1, 40]], 110), 16, { opts: { vol: -8, sends: [0, 0] } });
    bass.fx = [fx('comp', { th: -28, ra: 6, sc: dr.id })];
    const lead = track(lib, 'synth', 3, 'FLUTE', sound(lib, 'sloop', 'SAMPLE', 'LOFI FLUTE'), 'HOOK', line([[0.5, 0.5, 69], [1, 1, 72], [2.5, 0.5, 74], [3, 2, 72], [8.5, 0.5, 67], [9, 1, 69], [10.5, 0.5, 72], [11, 3, 69]], 84), 16, { opts: { vol: -12, pan: 0.2, sends: [0.3, 0.2] } });
    return finish(p, [dr, keys, bass, lead], ['BEAT', 'FULL']);
  }
  if (id === 'lofi') {
    p.swing = 0.4;
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'LO-FI') }, 'BEAT', beat({
      36: 'x......x..x.....x.......x.......', 38: '....x.......x.......x.......x...', 42: 'x.o.x.o.x.o.x.o.x.o.x.o.x.o.x.oo' }), 8, { opts: { vol: -3, sends: [0.1, 0] } });
    dr.fx = [fx('crush', { bi: 12, ds: 2, mx: 0.5 }), fx('eq', { lp: 9000 })];
    const ch = [[0, 3.9, [52, 55, 59, 62]], [4, 3.9, [50, 53, 57, 60]], [8, 3.9, [48, 52, 55, 59]], [12, 3.9, [47, 50, 53, 57]]];
    const pno = track(lib, 'synth', 1, 'PIANO', sound(lib, 'sloop', 'SAMPLE', 'DUSTY PNO'), 'CHORDS', chords(ch, 70), 16, { opts: { vol: -5, sends: [0.3, 0] } });
    pno.fx = [fx('eq', { hp: 150, lp: 7000 }), fx('chorus', { ra: 0.3, de: 0.3, mx: 0.3 })];
    const bass = track(lib, 'synth', 2, 'BASS', sound(lib, 'sloop', 'SAMPLE', 'UP BASS'), 'WALK', line([[0, 1, 40], [1.5, 0.5, 43], [2, 1.5, 45], [4, 1, 38], [5.5, 0.5, 41], [6, 1.5, 45], [8, 1, 36], [9.5, 0.5, 40], [10, 1.5, 43], [12, 1, 35], [13.5, 0.5, 38], [14, 1.5, 41]], 100), 16, { opts: { vol: -13, sends: [0.05, 0] } });
    const vin = track(lib, 'synth', 3, 'VINYL', sound(lib, 'sloop', 'NOISE', 'VINYL'), 'CRACKLE', line([[0, 32, 60]], 70), 32, { opts: { vol: -18, sends: [0, 0] } });
    return finish(p, [dr, pno, bass, vin], ['CHILL', 'FULL']);
  }
  if (id === 'trap') {
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'TRAP') }, 'BEAT', beat({
      36: 'X.........x.....X.....x...x.....', 39: '........X...............X.......', 42: 'x.x.x.x.x.xxx.x.x.x.x.x.xxxxx.x.', 46: '..............x...............x.' }), 8, { opts: { vol: -5, sends: [0.06, 0] } });
    const b808 = track(lib, 'synth', 1, '808', sound(lib, 'clipper', 'ANALOG', '808 BOOM'), 'SLIDE', line([[0, 2.5, 37], [3, 0.75, 37], [4, 2, 44], [6.5, 1.5, 42], [8, 2.5, 37], [11, 0.75, 37], [12, 2, 40], [14, 2, 32]], 118), 16, { opts: { vol: -7, sends: [0, 0] } });
    b808.fx = [fx('sat', { dr: 6, mx: 0.5 })];
    const bell = track(lib, 'synth', 2, 'BELL', sound(lib, 'clipper', 'DIGITAL', 'TRAP BELL'), 'MELODY', line([[0, 0.5, 73], [0.75, 0.5, 76], [1.5, 0.5, 80], [2, 1, 78], [4, 0.5, 73], [4.75, 0.5, 76], [5.5, 0.5, 80], [6, 1, 81], [8, 0.5, 73], [8.75, 0.5, 76], [9.5, 0.5, 80], [10, 1, 78], [12, 0.5, 76], [12.75, 0.5, 75], [13.5, 2, 73]], 88), 16, { opts: { vol: -9, sends: [0.25, 0.25] } });
    const pad = track(lib, 'synth', 3, 'PAD', sound(lib, 'clipper', 'HYBRID', 'DARK PAD'), 'DARK', chords([[0, 8, [49, 56, 61]], [8, 4, [52, 56, 61]], [12, 4, [49, 54, 58]]], 64), 16, { opts: { vol: -17, sends: [0.35, 0] } });
    return finish(p, [dr, b808, pad, bell], ['VERSE', 'HOOK']);
  }
  if (id === 'techno') {
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'TECHNO') }, 'BEAT', beat({
      36: 'X...X...X...X...', 39: '....x.......x...', 42: '..x...x...x...x.', 46: '..o...o...o...xo', 51: 'o.o.o.o.o.o.o.o.' }), 4, { opts: { vol: -4, sends: [0.05, 0] } });
    const acid = track(lib, 'synth', 1, 'ACID', sound(lib, 'clipper', 'ACID', 'ACID LINE'), 'LINE', line([[0, 0.25, 36], [0.5, 0.25, 36], [0.75, 0.25, 48], [1.25, 0.25, 36], [1.5, 0.25, 39], [2, 0.25, 36], [2.5, 0.5, 43], [3.25, 0.25, 36], [3.5, 0.25, 46]], 104), 4, { opts: { vol: -4, sends: [0.05, 0.2] } });
    acid.auto = { p5: [{ t: 0, v: 30 }, { t: 16, v: 100 }, { t: 32, v: 40 }] };
    acid.fx = [fx('comp', { th: -26, ra: 5, sc: dr.id }), fx('delay', { ti: 4, fb: 0.3, mx: 0.15 })];
    const pad = track(lib, 'synth', 2, 'PAD', sound(lib, 'clipper', 'HYBRID', 'DARK PAD'), 'CHORD', chords([[0, 15.9, [48, 51, 55, 58]], [16, 15.9, [46, 50, 53, 56]]], 60), 32, { opts: { vol: -16, sends: [0.4, 0] } });
    pad.fx = [fx('filter', { ty: 0, fr: 1500, lr: 6, ld: 0.4 })];
    const perc = track(lib, 'synth', 3, 'STAB', sound(lib, 'clipper', 'TRIO', 'MIN STAB'), 'STAB', line([[1.5, 0.25, 60], [7, 0.25, 60], [11.5, 0.25, 63], [14.75, 0.25, 58]], 90), 16, { opts: { vol: -10, pan: -0.3, sends: [0.2, 0.3] } });
    return finish(p, [dr, acid, pad, perc], ['GROOVE', 'PEAK']);
  }
  // house
  const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'HOUSE') }, 'BEAT', beat({
    36: 'X...X...X...X...', 39: '....x.......x...', 42: 'x.x.x.x.x.x.x.x.', 46: '..x...x...x...x.', 70: '.o.o.o.o.o.oo.o.' }), 4, { opts: { vol: -4, sends: [0.06, 0] } });
  const ch = [[0.5, 0.4, [56, 60, 63, 67]], [1.75, 0.4, [56, 60, 63, 67]], [3, 0.4, [56, 60, 63, 67]], [4.5, 0.4, [55, 58, 62, 65]], [5.75, 0.4, [55, 58, 62, 65]], [7, 0.4, [55, 58, 62, 65]],
    [8.5, 0.4, [53, 56, 60, 63]], [9.75, 0.4, [53, 56, 60, 63]], [11, 0.4, [53, 56, 60, 63]], [12.5, 0.4, [51, 55, 58, 62]], [13.75, 0.4, [51, 55, 58, 62]], [15, 0.4, [51, 55, 58, 62]]];
  const pno = track(lib, 'synth', 1, 'PIANO', sound(lib, 'clipper', 'DIGITAL', 'M1 PIANO'), 'STABS', chords(ch, 90), 16, { opts: { vol: -6, sends: [0.2, 0.1] } });
  pno.fx = [fx('eq', { hp: 200 }), fx('comp', { th: -24, ra: 4, sc: dr.id })];
  const bass = track(lib, 'synth', 2, 'BASS', sound(lib, 'clipper', 'JUNO', 'SUB BASS 106'), 'OFFBEAT', line([[0.5, 0.4, 41], [1.5, 0.4, 41], [2.5, 0.4, 41], [3.5, 0.4, 53], [4.5, 0.4, 39], [5.5, 0.4, 39], [6.5, 0.4, 39], [7.5, 0.4, 51], [8.5, 0.4, 37], [9.5, 0.4, 37], [10.5, 0.4, 37], [11.5, 0.4, 49], [12.5, 0.4, 36], [13.5, 0.4, 36], [14.5, 0.4, 36], [15.5, 0.4, 48]], 108), 16, { opts: { vol: -8, sends: [0, 0] } });
  bass.fx = [fx('comp', { th: -30, ra: 8, sc: dr.id })];
  const pad = track(lib, 'synth', 3, 'STRINGS', sound(lib, 'clipper', 'STRINGS', 'SOLINA'), 'STRINGS', chords([[0, 3.9, [68, 72, 75]], [4, 3.9, [67, 70, 74]], [8, 3.9, [65, 68, 72]], [12, 3.9, [63, 67, 70]]], 60), 16, { opts: { vol: -15, sends: [0.4, 0] } });
  return finish(p, [dr, pno, bass, pad], ['GROOVE', 'FULL']);
}
