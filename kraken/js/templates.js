// SPDX-License-Identifier: GPL-3.0-only
// Starters: a song already playing in a style, ready to be changed. Each one: drums, bass, chords and a top line on
// factory sounds of SLOOP / Clipper, mixed, 8 bars, the loop on, a scene for each part in the session.
import { newProject, newTrack, newClip, uid } from './project.js';
import { defaults } from './fx.js';
import { GENERATED, genSound } from './gensounds.js';

const fx = (type, p = {}) => ({ id: uid('f'), type, on: true, p: { ...defaults(type), ...p } });
export const misses = [];                       // sounds or kits a starter asked for and the library has not (the tests read it)
function sound(lib, bank, eng, preset) {
  for (const b of [bank, bank === 'clipper' ? 'sloop' : 'clipper']) {
    const cat = lib[b], e = cat.engines.findIndex((x) => x.name === eng);
    const i = e < 0 ? -1 : cat.engines[e].presets.indexOf(preset);
    if (i >= 0) return { bank: b, engine: e, preset: i };
  }
  misses.push(`${eng} ${preset}`);
  return { bank: 'clipper', engine: 0, preset: 0 };
}
const kit = (lib, name) => { const i = lib.sloop.kits.indexOf(name); if (i < 0) misses.push(`kit ${name}`); return Math.max(0, i); };
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

// a note pattern repeated on each chord: per bar (4 beats), `steps` notes `len` beats apart, taken from the chord's
// notes by index (pat), with velocities from vel (cycled)
function perChord(chs, pat, step, len, vel = [100]) {
  const out = [];
  chs.forEach((ch, b) => { for (let i = 0; i * step < 4 - 1e-9; i++) { const k = pat[i % pat.length]; if (k == null) continue; out.push({ t: b * 4 + i * step, d: len, n: ch[k], v: vel[i % vel.length] }); } });
  return out;
}
// the same rhythm for each chord of a list (one a bar): [[beat, length]]
const rhythm = (chs, hits, v = 84) => chs.flatMap((ch, b) => hits.flatMap(([t, d]) => ch.map((n) => ({ t: b * 4 + t, d, n, v }))));
// a bass line: each bar its root, with a rhythm [[beat, length, offset (semitones), velocity?]]
const roots = (rs, hits, v = 104) => rs.flatMap((r, b) => hits.map(([t, d, o = 0, vv]) => ({ t: b * 4 + t, d, n: r + o, v: vv ?? v })));
// stepped automation: the value held from each point to the next ([[beat, value]]), the pattern repeated to `to`
function steps(list, every, to = 32) {
  const out = [];
  for (let at = 0; at < to - 1e-9; at += every) list.forEach(([t, v], i) => { const end = i + 1 < list.length ? list[i + 1][0] : every; out.push({ t: at + t, v }, { t: at + end - 0.001, v }); });
  return out;
}

export const FAMILIES = ['Electronic', 'Hip-hop & R&B', 'Latin & Afro', 'Pop, rock & more'];
export const STARTERS = [
  { id: 'house', name: 'House', bpm: 124, fam: 0, text: 'Four on the floor, a piano, a round bass' },
  { id: 'techno', name: 'Techno', bpm: 130, fam: 0, text: 'A driving kick, an acid line, a dark pad' },
  { id: 'trance', name: 'Trance', bpm: 138, fam: 0, text: 'Gated supersaws, a rolling bass, a pluck arpeggio' },
  { id: 'dubstep', name: 'Dubstep', bpm: 140, fam: 0, text: 'Half-time drums, a wobbling growl, a sub' },
  { id: 'dnb', name: 'Drum & bass', bpm: 174, fam: 0, text: 'Two-step breaks, a reese bass, an airy pad' },
  { id: 'ukg', name: 'UK garage', bpm: 132, fam: 0, text: 'Shuffled 2-step, organ stabs, a wow bass' },
  { id: 'futurebass', name: 'Future bass', bpm: 150, fam: 0, text: 'Pumping supersaw chords, vocal chops' },
  { id: 'synthwave', name: 'Synthwave', bpm: 100, fam: 0, text: '80s drums, Juno pads, a soaring lead' },
  { id: 'disco', name: 'Disco', bpm: 118, fam: 0, text: 'Octave bass, clavinet, string pads' },
  { id: 'hiphop', name: 'Hip-hop', bpm: 90, fam: 1, text: 'Swung drums, Rhodes chords, a deep sub' },
  { id: 'trap', name: 'Trap', bpm: 140, fam: 1, text: 'Rolling hats, a gliding 808, a bell melody' },
  { id: 'drill', name: 'Drill', bpm: 142, fam: 1, text: 'Sliding 808s, triplet hats, dark strings' },
  { id: 'phonk', name: 'Phonk', bpm: 135, fam: 1, text: 'A cowbell melody, a distorted 808' },
  { id: 'rnb', name: 'R&B', bpm: 72, fam: 1, text: 'Rhodes ninths, a soft 808, a soul voice' },
  { id: 'lofi', name: 'Lo-fi', bpm: 78, fam: 1, text: 'Dusty piano, upright bass, vinyl crackle' },
  { id: 'reggaeton', name: 'Reggaeton', bpm: 95, fam: 2, text: 'The dembow, a pluck, a flute hook' },
  { id: 'afrobeats', name: 'Afrobeats', bpm: 104, fam: 2, text: 'Shakers and rims, afro keys, a marimba' },
  { id: 'amapiano', name: 'Amapiano', bpm: 113, fam: 2, text: 'The log drum, jazzy keys, shakers' },
  { id: 'pop', name: 'Pop', bpm: 112, fam: 3, text: 'Piano chords, a pluck hook, a warm pad' },
  { id: 'rock', name: 'Rock', bpm: 124, fam: 3, text: 'Power chords through an amp, bass, a lead' },
  { id: 'cinematic', name: 'Cinematic', bpm: 90, fam: 3, text: 'Cello ostinato, brass, choir, timpani' },
  { id: 'ambient', name: 'Ambient', bpm: 70, fam: 3, text: 'Frozen pads, a sparse piano, a drone' },
  { id: 'chiptune', name: 'Chiptune', bpm: 150, fam: 3, text: '8-bit bass, fast arpeggios, a game lead' },
];

export function starterProject(lib, id) {
  const p = newProject();
  const st = STARTERS.find((s) => s.id === id) || STARTERS[0];
  p.name = `My ${st.name} song`; p.bpm = st.bpm;
  if (MORE[id]) return MORE[id](lib, p);
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

// ------------------------------------------------------------------ more styles ---
// each: the key it is in (the piano roll lights it), drums, a bass, harmony and a top line, mixed and ready
const sc = (dr, o = {}) => fx('comp', { th: -30, ra: 8, at: 1, re: 160, kn: 3, ...o, sc: dr.id });   // (the kick pumps it)
const MORE = {
  pop(lib, p) {
    p.key = { root: 0, sc: 0 };                                                    // C major: C, G/B, Am, F
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'TIGHT') }, 'BEAT', beat({
      36: 'X.......X.x.....', 39: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.', 70: '.o.o.o.o.o.o.o.o' }), 4, { opts: { vol: 1, sends: [0.06, 0] } });
    const CH = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]];
    const pno = track(lib, 'synth', 1, 'PIANO', sound(lib, 'sloop', 'SAMPLE', 'GRAND PNO'), 'CHORDS', rhythm(CH, [[0, 1.4], [1.5, 0.45], [2, 1.9]], 80), 16, { opts: { vol: -8, sends: [0.18, 0] } });
    pno.fx = [fx('eq', { hp: 140, m2g: 2, m2f: 3000 }), fx('comp', { th: -22, ra: 3 })];
    const bass = track(lib, 'synth', 2, 'BASS', sound(lib, 'clipper', 'JUNO', 'JUNO BASS'), 'EIGHTHS', roots([36, 35, 33, 41], [[0, 0.45], [0.5, 0.45], [1, 0.45], [1.5, 0.45], [2, 0.45], [2.5, 0.45], [3, 0.45], [3.5, 0.45, 0, 84]]), 16, { opts: { vol: -12, sends: [0, 0] } });
    bass.fx = [sc(dr, { th: -26, ra: 4, re: 120 })];
    const pad = track(lib, 'synth', 3, 'PAD', sound(lib, 'clipper', 'JUNO', 'DREAM PAD'), 'PAD', chords([[0, 3.9, [67, 72, 76]], [4, 3.9, [67, 71, 74]], [8, 3.9, [69, 72, 76]], [12, 3.9, [69, 72, 77]]], 58), 16, { opts: { vol: -19, sends: [0.35, 0] } });
    const hook = track(lib, 'synth', 4, 'PLUCK', sound(lib, 'clipper', 'HYBRID', 'PLUCK'), 'HOOK', line([[0, 0.5, 76], [0.5, 0.5, 79], [1, 0.5, 76], [1.5, 0.5, 74], [2, 1, 72],
      [4, 0.5, 74], [4.5, 0.5, 74], [5, 0.5, 71], [5.5, 0.5, 74], [6, 1.5, 79], [8, 0.5, 76], [8.5, 0.5, 79], [9, 0.5, 76], [9.5, 0.5, 74], [10, 0.5, 72], [10.5, 1.5, 69],
      [12, 0.5, 72], [12.5, 0.5, 74], [13, 1, 76], [14, 0.5, 74], [14.5, 1.5, 72]], 92), 16, { opts: { vol: -10, pan: 0.1, sends: [0.2, 0.18] } });
    return finish(p, [dr, pno, bass, pad, hook], ['VERSE', 'CHORUS']);
  },
  dubstep(lib, p) {
    p.key = { root: 5, sc: 1 };                                                    // F minor
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'DUBSTEP') }, 'HALF TIME', beat({
      36: 'X.........X.....X.....X...X.....', 38: '........X...............X.......', 42: '..x...x.x.x...x...x...x.x.x.xxxx' }), 8, { opts: { vol: -4, sends: [0.08, 0] } });
    const sub = track(lib, 'synth', 1, 'SUB', sound(lib, 'clipper', 'ANALOG', 'SUB BASS'), 'SUB', line([[0, 2, 29], [2.5, 1.5, 32], [4, 1.5, 29], [6, 2, 24]], 112), 8, { opts: { vol: -8, sends: [0, 0] } });
    sub.fx = [sc(dr, { th: -24, ra: 4, re: 100 })];
    const wob = fx('filter', { ty: 0, fr: 420, q: 5, lr: 3, ld: 0.75 });
    const growl = track(lib, 'synth', 2, 'GROWL', sound(lib, 'clipper', 'WAVE', 'FM GROWL'), 'WOBBLE', line([[0, 1.5, 41], [2, 0.5, 41], [2.5, 1.5, 44], [4, 1, 41], [5, 0.5, 39], [5.5, 0.5, 41], [6, 2, 36]], 110), 8, { opts: { vol: -11, sends: [0.05, 0] } });
    growl.fx = [fx('eq', { hp: 120 }), fx('sat', { dr: 12, ty: 1, mx: 0.8, ou: -6 }), wob, sc(dr, { th: -26, ra: 6, re: 120 })];
    growl.auto = { [`fx:${wob.id}:lr`]: steps([[0, 3], [2, 1], [4, 5], [6, 4]], 8) };   // the wobble's speed: 1/8, 1/16, 1/4, 1/8.
    const pad = track(lib, 'synth', 3, 'PAD', sound(lib, 'clipper', 'HYBRID', 'DARK PAD'), 'CHORDS', chords([[0, 3.9, [53, 56, 60]], [4, 3.9, [49, 53, 56]], [8, 3.9, [49, 53, 58]], [12, 3.9, [51, 55, 58]]], 60), 16, { opts: { vol: -18, sends: [0.4, 0] } });
    const bell = track(lib, 'synth', 4, 'BELL', sound(lib, 'clipper', 'HYBRID', 'SPACE BEL'), 'MELODY', line([[0, 1, 77], [1, 1, 80], [2, 2, 84], [4, 1, 82], [5, 1, 80], [6, 2, 75], [8, 1, 77], [9, 1, 80], [10, 2, 84], [12, 2, 87], [14, 2, 84]], 82), 16, { opts: { vol: -11, pan: -0.15, sends: [0.35, 0.25] } });
    return finish(p, [dr, sub, growl, pad, bell], ['DROP', 'DROP + BELL']);
  },
  trance(lib, p) {
    p.key = { root: 9, sc: 1 };                                                    // A minor: Am, F, C, G
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, '909') }, 'BEAT', beat({
      36: 'X...X...X...X...', 39: '....X.......X...', 46: '..x...x...x...x.', 42: 'oooooooooooooooo' }), 4, { opts: { vol: -4, sends: [0.05, 0] } });
    const CH = [[57, 60, 64, 69], [57, 60, 65, 69], [55, 60, 64, 67], [55, 59, 62, 67]];
    const bass = track(lib, 'synth', 1, 'BASS', sound(lib, 'clipper', 'ANALOG', 'SAW BASS'), 'ROLLING', roots([33, 29, 36, 31], [0, 1, 2, 3].flatMap((b) => [[b + 0.25, 0.2], [b + 0.5, 0.2], [b + 0.75, 0.2]]), 100), 16, { opts: { vol: -2, sends: [0, 0] } });
    bass.fx = [fx('eq', { hp: 35, lp: 4000 }), sc(dr)];
    const saw = track(lib, 'synth', 2, 'SUPERSAW', sound(lib, 'clipper', 'ANALOG', 'SUPERSAW'), 'GATED', chords(CH.map((c, i) => [i * 4, 3.95, c]), 72), 16, { opts: { vol: -5, sends: [0.3, 0.1] } });
    saw.fx = [fx('eq', { hp: 200 }), fx('slicer', { ra: 1, pa: 0, de: 0.85, sm: 0.15 }), sc(dr, { th: -28, ra: 6 })];
    const arp = track(lib, 'synth', 3, 'ARP', sound(lib, 'clipper', 'HYBRID', 'SAW PLUCK'), 'ARP', perChord(CH.map((c) => [c[0] + 12, c[1] + 12, c[2] + 12, c[3] + 12]), [0, 1, 2, 3, 2, 1, 0, 1], 0.25, 0.2, [96, 70, 80, 70]), 16, { opts: { vol: -16, pan: 0.15, sends: [0.2, 0.3] } });
    arp.fx = [fx('delay', { ti: 4, fb: 0.35, mx: 0.2 })];
    return finish(p, [dr, bass, saw, arp], ['BUILD', 'PEAK']);
  },
  dnb(lib, p) {
    p.key = { root: 2, sc: 1 };                                                    // D minor: Dm, Bb, F, C
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'JUNGLE') }, 'TWO-STEP', beat({
      36: 'X.........X.....', 38: '....X.......X...', 42: 'x.xox.x.x.xox.xo', 51: '..o...o...o...o.' }), 4, { opts: { vol: -2, sends: [0.08, 0] } });
    const reese = track(lib, 'synth', 1, 'REESE', sound(lib, 'clipper', 'ANALOG', 'REESE'), 'REESE', line([[0, 3.5, 38], [3.5, 0.5, 38], [4, 4, 34], [8, 3, 41], [11, 1, 40], [12, 4, 36]], 108), 16, { opts: { vol: -9, sends: [0, 0] } });
    reese.fx = [fx('eq', { hp: 30, lp: 6000 }), fx('sat', { dr: 6, ty: 1, ou: -3 }), sc(dr, { th: -24, ra: 4, re: 90 })];
    const pad = track(lib, 'synth', 2, 'PAD', sound(lib, 'clipper', 'ANALOG', 'ATMOS PAD'), 'ATMOS', chords([[0, 3.9, [62, 65, 69]], [4, 3.9, [62, 65, 70]], [8, 3.9, [60, 65, 69]], [12, 3.9, [60, 64, 67]]], 60), 16, { opts: { vol: -17, sends: [0.45, 0] } });
    const lead = track(lib, 'synth', 3, 'BELL', sound(lib, 'clipper', 'HYBRID', 'BRIGHT BEL'), 'MELODY', line([[0, 2, 74], [2, 1, 77], [3, 1, 76], [4, 3, 74], [8, 2, 72], [10, 1, 74], [11, 1, 77], [12, 4, 76]], 80), 16, { opts: { vol: -11, pan: 0.2, sends: [0.35, 0.3] } });
    return finish(p, [dr, reese, pad, lead], ['ROLLER', 'FULL']);
  },
  ukg(lib, p) {
    p.key = { root: 5, sc: 1 }; p.swing = 0.3;                                     // F minor: Fm7, Dbmaj7, Bbm7, Eb7
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'GARAGE') }, '2-STEP', beat({
      36: 'X.........X.......X.......X.....', 39: '....X.......X.......X.......X...', 42: 'x.xxx.x.x.xxx.x.x.xxx.x.x.xxx.xx', 37: '.......x......x........x......x.' }), 8, { opts: { vol: -2, sends: [0.06, 0] } });
    const CH = [[56, 60, 63, 65], [56, 60, 61, 65], [56, 58, 61, 65], [55, 58, 61, 63]];
    const bass = track(lib, 'synth', 1, 'BASS', sound(lib, 'clipper', 'VOICE', 'WOW BASS'), 'WOW', roots([41, 37, 34, 39], [[0, 0.75], [1.5, 0.4], [2.5, 0.75, 12, 90], [3.5, 0.4]]), 16, { opts: { vol: -9, sends: [0, 0] } });
    bass.fx = [sc(dr, { th: -26, ra: 5 })];
    const org = track(lib, 'synth', 2, 'ORGAN', sound(lib, 'clipper', 'WHEEL', 'HOUSE ORGN'), 'STABS', rhythm(CH, [[0.5, 0.4], [1.75, 0.25], [2.5, 0.4], [3.75, 0.25]], 80), 16, { opts: { vol: -9, sends: [0.2, 0.1] } });
    org.fx = [fx('eq', { hp: 180 })];
    const vox = track(lib, 'synth', 3, 'VOX', sound(lib, 'clipper', 'VOICE', 'AAH LEAD'), 'CHOPS', line([[0.75, 0.25, 72], [1, 0.5, 75], [2.75, 0.25, 72], [3, 0.5, 77], [4.75, 0.25, 72], [5, 0.5, 75], [6, 1, 72],
      [8.75, 0.25, 77], [9, 0.5, 75], [10.75, 0.25, 72], [11, 0.5, 70], [12.75, 0.25, 72], [13, 0.5, 75], [14, 1.5, 72]], 86), 16, { opts: { vol: -10, pan: -0.15, sends: [0.25, 0.25] } });
    return finish(p, [dr, bass, org, vox], ['GROOVE', 'FULL']);
  },
  futurebass(lib, p) {
    p.key = { root: 2, sc: 0 };                                                    // D major: Gmaj7, A, F#m7, Bm7
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'TRAP') }, 'HALF TIME', beat({
      36: 'X.........X.....X.......X.......', 39: '........X...............X.......', 42: 'x.x.x.x.x.x.x.xxx.x.x.x.x.x.xxxx' }), 8, { opts: { vol: -5, sends: [0.06, 0] } });
    const CH = [[55, 59, 62, 66], [57, 61, 64, 69], [54, 57, 61, 64], [59, 62, 66, 69]];
    const saw = track(lib, 'synth', 1, 'CHORDS', sound(lib, 'clipper', 'ANALOG', 'SUPERSAW'), 'STABS', rhythm(CH, [[0, 0.7], [0.75, 0.7], [1.5, 0.95], [2.5, 0.45], [3, 0.95]], 80), 16, { opts: { vol: -3, sends: [0.3, 0.1] } });
    saw.fx = [fx('eq', { hp: 180 }), fx('chorus', { mx: 0.3 }), sc(dr, { th: -30, ra: 6, re: 220 })];
    const sub = track(lib, 'synth', 2, 'SUB', sound(lib, 'clipper', 'ANALOG', 'SUB BASS'), 'SUB', line([[0, 3.9, 31], [4, 3.9, 33], [8, 3.9, 30], [12, 3.9, 35]], 110), 16, { opts: { vol: -9, sends: [0, 0] } });
    sub.fx = [sc(dr, { th: -28, ra: 6 })];
    const vox = track(lib, 'synth', 3, 'VOX', sound(lib, 'clipper', 'VOICE', 'AAH LEAD'), 'CHOPS', line([[0.5, 0.5, 74], [1, 0.5, 76], [1.5, 1, 78], [4.5, 0.5, 76], [5, 0.5, 78], [5.5, 1, 81],
      [8.5, 0.5, 78], [9, 0.5, 76], [9.5, 1, 73], [12.5, 0.5, 74], [13, 1, 71], [14, 2, 74]], 88), 16, { opts: { vol: -13, sends: [0.3, 0.25] } });
    vox.fx = [fx('pitch', { st: 12, mx: 0.3 })];
    return finish(p, [dr, saw, sub, vox], ['BUILD', 'DROP']);
  },
  synthwave(lib, p) {
    p.key = { root: 9, sc: 1 };                                                    // A minor: Am, F, C, G
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'SYNTHWV') }, 'BEAT', beat({
      36: 'X.......X.......', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' }), 4, { opts: { vol: -2, sends: [0.15, 0] } });
    const CH = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]];
    const bass = track(lib, 'synth', 1, 'BASS', sound(lib, 'clipper', 'JUNO', 'JUNO BASS'), 'PULSE', roots([33, 29, 36, 31], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => [t, 0.4, i % 2 ? 12 : 0, i % 2 ? 84 : 104])), 16, { opts: { vol: -9, sends: [0, 0] } });
    bass.fx = [sc(dr, { th: -24, ra: 4 })];
    const pad = track(lib, 'synth', 2, 'PAD', sound(lib, 'clipper', 'JUNO', 'JUNO 106 PAD'), 'PAD', chords(CH.map((c, i) => [i * 4, 3.95, c]), 64), 16, { opts: { vol: -15, sends: [0.4, 0] } });
    pad.fx = [fx('chorus', { mx: 0.35 })];
    const arp = track(lib, 'synth', 3, 'ARP', sound(lib, 'clipper', 'JUNO', 'ARP PLUCK'), 'ARP', perChord(CH.map((c) => [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24]), [0, 1, 2, 3], 0.25, 0.2, [90, 64, 72, 64]), 16, { opts: { vol: -12, pan: -0.25, sends: [0.2, 0.3] } });
    const lead = track(lib, 'synth', 4, 'LEAD', sound(lib, 'clipper', 'JUNO', 'SYNTHWAVE LD'), 'LEAD', line([[0, 1.5, 76], [1.5, 0.5, 74], [2, 2, 72], [4, 1.5, 72], [5.5, 0.5, 71], [6, 2, 69],
      [8, 1, 67], [9, 1, 69], [10, 2, 72], [12, 1.5, 74], [13.5, 0.5, 72], [14, 2, 71]], 90), 16, { opts: { vol: -12, pan: 0.1, sends: [0.3, 0.3] } });
    lead.fx = [fx('delay', { ti: 4, fb: 0.35, mx: 0.2 })];
    return finish(p, [dr, bass, pad, arp, lead], ['NIGHT DRIVE', 'FULL']);
  },
  disco(lib, p) {
    p.key = { root: 9, sc: 2 };                                                    // A dorian: Am7, D9
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'DISCO') }, 'BEAT', beat({
      36: 'X...X...X...X...', 39: '....X.......X...', 46: '..x...x...x...x.', 42: 'x...x...x...x...', 70: 'oooooooooooooooo' }), 4, { opts: { vol: -3, sends: [0.08, 0] } });
    const bass = track(lib, 'synth', 1, 'BASS', sound(lib, 'clipper', 'ANALOG', 'FUNK BASS'), 'OCTAVES', roots([33, 33, 38, 38], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => [t, 0.35, i % 2 ? 12 : 0, i % 2 ? 92 : 108])), 16, { opts: { vol: -9, sends: [0, 0] } });
    const clav = track(lib, 'synth', 2, 'CLAV', sound(lib, 'clipper', 'DIGITAL', 'CLAV'), 'FUNK', rhythm([[57, 60, 64, 67], [57, 60, 64, 67], [54, 57, 60, 64], [54, 57, 60, 64]], [[0.25, 0.2], [0.75, 0.2], [1.5, 0.2], [2.25, 0.2], [2.75, 0.2], [3.5, 0.2]], 76), 16, { opts: { vol: -7, pan: -0.25, sends: [0.12, 0] } });
    clav.fx = [fx('phaser', { ra: 0.4, mx: 0.35 })];
    const str = track(lib, 'synth', 3, 'STRINGS', sound(lib, 'clipper', 'STRINGS', 'SOLINA'), 'STRINGS', chords([[0, 7.9, [64, 67, 69, 72]], [8, 7.9, [66, 69, 72, 76]]], 62), 16, { opts: { vol: -15, pan: 0.2, sends: [0.35, 0] } });
    return finish(p, [dr, bass, clav, str], ['GROOVE', 'FULL']);
  },
  drill(lib, p) {
    p.key = { root: 0, sc: 1 };                                                    // C minor: Cm, Ab, Fm, Gm
    // UK drill: the snare late in the second bar, hats in triplets with rolls
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'DRILL') }, 'DRILL', [...beat({
      36: 'X.........X.......X.......X.....', 38: '........X..........X....X.......' }),
    ...[...Array(24)].map((_, i) => ({ t: i / 3, d: 0.1, n: 42, v: i % 3 === 0 ? 96 : 66 })).filter((x, i) => ![2, 5, 14, 20].includes(i)),
    ...[7 + 1 / 6, 7 + 2 / 6, 7 + 3 / 6, 7 + 4 / 6].map((t) => ({ t, d: 0.08, n: 42, v: 70 }))], 8, { opts: { vol: -5, sends: [0.06, 0] } });
    const b808 = track(lib, 'synth', 1, '808', sound(lib, 'clipper', 'ANALOG', '808 SLIDE'), 'SLIDES', line([[0, 1.5, 36], [1.5, 1, 36], [2.5, 0.75, 39], [3.25, 0.75, 36], [4, 1.5, 32], [5.75, 1, 32], [6.75, 1.25, 31]], 116), 8, { opts: { vol: -7, sends: [0, 0] } });
    b808.fx = [fx('sat', { dr: 5, mx: 0.5 })];
    const choir = track(lib, 'synth', 2, 'CHOIR', sound(lib, 'clipper', 'VOICE', 'MALE CHOIR'), 'CHORDS', chords([[0, 3.9, [60, 63, 67]], [4, 3.9, [60, 63, 68]], [8, 3.9, [60, 65, 68]], [12, 3.9, [62, 67, 70]]], 58), 16, { opts: { vol: -12, sends: [0.4, 0] } });
    const str = track(lib, 'synth', 3, 'STRINGS', sound(lib, 'clipper', 'STRINGS', 'DARK ENS'), 'MELODY', line([[0, 1, 72], [1, 1, 75], [2, 2, 74], [4, 1, 72], [5, 1, 68], [6, 2, 67],
      [8, 1, 72], [9, 1, 75], [10, 1.5, 77], [11.5, 0.5, 75], [12, 1, 74], [13, 1, 70], [14, 2, 67]], 84), 16, { opts: { vol: -13, pan: 0.15, sends: [0.3, 0.1] } });
    return finish(p, [dr, b808, choir, str], ['VERSE', 'HOOK']);
  },
  phonk(lib, p) {
    p.key = { root: 5, sc: 1 };                                                    // F minor
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'PHONK') }, 'BEAT', beat({
      36: 'X.......X.x.....', 38: '....X.......X...', 42: 'x.x.x.x.x.x.xxxx', 46: '..............x.' }), 4, { opts: { vol: -5, sends: [0.05, 0] } });
    const b808 = track(lib, 'synth', 1, '808', sound(lib, 'clipper', 'ANALOG', '808 DIRTY'), 'DIRTY', line([[0, 1.5, 29], [1.5, 0.5, 29], [2, 1, 32], [3, 1, 29], [4, 1.5, 27], [5.5, 0.5, 27], [6, 2, 24]], 118), 8, { opts: { vol: -5, sends: [0, 0] } });
    b808.fx = [fx('sat', { dr: 14, ty: 3, mx: 0.6, ou: -8 }), sc(dr, { th: -24, ra: 4 })];
    const drone = track(lib, 'synth', 2, 'DRONE', sound(lib, 'clipper', 'GRAIN', 'DARK DRONE'), 'DRONE', line([[0, 15.9, 53]], 70), 16, { opts: { vol: -22, sends: [0.3, 0] } });
    const bell = track(lib, 'synth', 3, 'COWBELL', sound(lib, 'clipper', 'TRIO', 'RING BELL'), 'MEMPHIS', line([[0, 0.25, 77], [0.5, 0.25, 80], [0.75, 0.25, 77], [1.25, 0.25, 84], [1.75, 0.25, 82], [2, 0.5, 80], [2.75, 0.25, 77], [3.25, 0.25, 75], [3.5, 0.5, 77],
      [4, 0.25, 77], [4.5, 0.25, 80], [4.75, 0.25, 77], [5.25, 0.25, 84], [5.75, 0.25, 87], [6, 0.5, 84], [6.75, 0.25, 82], [7.25, 0.25, 80], [7.5, 0.5, 75]], 96), 8, { opts: { vol: -13, sends: [0.15, 0.1] } });
    bell.fx = [fx('eq', { hp: 300, m2g: 3, m2f: 1800 })];
    return finish(p, [dr, b808, drone, bell], ['DRIFT', 'FULL']);
  },
  rnb(lib, p) {
    p.key = { root: 2, sc: 1 };                                                    // D minor: Dm9, Gm9, Bbmaj7, Am7
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, '808') }, 'BEAT', beat({
      36: 'X.....X...X.....', 38: '....X.......X...', 42: 'x.x.x.xxx.x.x.xo', 70: '..o...o...o...o.' }), 4, { opts: { vol: -6, sends: [0.1, 0] } });
    const keys = track(lib, 'synth', 1, 'KEYS', sound(lib, 'clipper', 'DIGITAL', 'SUITCASE'), 'NINTHS', chords([[0, 3.8, [53, 57, 60, 64]], [4, 3.8, [53, 57, 58, 62]], [8, 3.8, [50, 53, 57, 58]], [12, 3.8, [52, 55, 57, 60]]], 70), 16, { opts: { vol: -9, sends: [0.25, 0] } });
    keys.fx = [fx('chorus', { mx: 0.25 }), fx('eq', { hp: 120 })];
    const b808 = track(lib, 'synth', 2, '808', sound(lib, 'clipper', 'ANALOG', '808 BOOM'), '808', roots([38, 43, 34, 33], [[0, 2.5], [2.75, 1]], 108), 16, { opts: { vol: -9, sends: [0, 0] } });
    const voice = track(lib, 'synth', 3, 'VOICE', sound(lib, 'clipper', 'VOICE', 'SOUL OOH'), 'MELODY', line([[1, 0.5, 69], [1.5, 0.5, 72], [2, 1.5, 74], [4.5, 0.5, 74], [5, 0.5, 72], [5.5, 2, 70],
      [8.5, 0.5, 69], [9, 0.5, 70], [9.5, 0.5, 72], [10, 2, 69], [12.5, 0.5, 67], [13, 1, 69], [14, 2, 64]], 82), 16, { opts: { vol: -12, sends: [0.35, 0.15] } });
    return finish(p, [dr, keys, b808, voice], ['VERSE', 'HOOK']);
  },
  reggaeton(lib, p) {
    p.key = { root: 9, sc: 1 };                                                    // A minor: Am, F, C, G
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'DEMBOW') }, 'DEMBOW', beat({
      36: 'X...X...X...X...', 38: '...x..x....x..x.', 42: 'x.x.x.x.x.x.x.x.' }), 4, { opts: { vol: -5, sends: [0.06, 0] } });
    const bass = track(lib, 'synth', 1, 'BASS', sound(lib, 'clipper', 'ANALOG', '808 BOOM'), 'DEMBOW', roots([33, 29, 36, 31], [[0, 0.7], [1.5, 0.4], [2, 0.7], [3.5, 0.4]], 110), 16, { opts: { vol: -9, sends: [0, 0] } });
    const CH = [[64, 69, 72], [65, 69, 72], [64, 67, 72], [62, 67, 71]];
    const pluck = track(lib, 'synth', 2, 'PLUCK', sound(lib, 'clipper', 'PHASE', 'RESO PLUCK'), '3-3-2', rhythm(CH, [[0, 0.3], [0.75, 0.3], [1.5, 0.3], [2, 0.3], [2.75, 0.3], [3.5, 0.3]], 80), 16, { opts: { vol: -12, sends: [0.2, 0.1] } });
    const flute = track(lib, 'synth', 3, 'FLUTE', sound(lib, 'clipper', 'ANALOG', 'PAN FLUTE'), 'HOOK', line([[0, 0.5, 76], [0.5, 0.5, 74], [1, 1, 72], [2, 0.5, 71], [2.5, 1.5, 69], [4, 0.5, 72], [4.5, 0.5, 74], [5, 1, 76], [6, 2, 77],
      [8, 0.5, 76], [8.5, 0.5, 74], [9, 1, 72], [10, 2, 76], [12, 1, 74], [13, 1, 72], [14, 2, 71]], 88), 16, { opts: { vol: -12, pan: 0.15, sends: [0.25, 0.2] } });
    return finish(p, [dr, bass, pluck, flute], ['VERSE', 'CORO']);
  },
  afrobeats(lib, p) {
    p.key = { root: 0, sc: 0 };                                                    // C major: Fmaj7, Em7, Dm7, Cmaj7
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'AFRO') }, 'GROOVE', beat({
      36: 'X.....X...X.....', 39: '....X.......X...', 37: '..x....x..x...x.', 70: 'xoxoxoxoxoxoxoxo', 63: '.......o.....o.o' }), 4, { opts: { vol: -2, sends: [0.08, 0] } });
    const keys = track(lib, 'synth', 1, 'KEYS', sound(lib, 'clipper', 'DIGITAL', 'AFRO KEYS'), 'KEYS', rhythm([[60, 64, 65, 69], [59, 62, 64, 67], [57, 60, 62, 65], [55, 59, 60, 64]], [[0.5, 0.4], [1.25, 0.4], [2.5, 0.4], [3.25, 0.6]], 76), 16, { opts: { vol: -11, sends: [0.2, 0.1] } });
    const bass = track(lib, 'synth', 2, 'BASS', sound(lib, 'clipper', 'FM6', 'ROUND BASS'), 'BASS', roots([41, 40, 38, 36], [[0, 0.75], [1.5, 0.5], [2.5, 0.5, 7, 90], [3, 0.75]]), 16, { opts: { vol: -9, sends: [0, 0] } });
    const mar = track(lib, 'synth', 3, 'MARIMBA', sound(lib, 'clipper', 'DIGITAL', 'MARIMBA'), 'MELODY', line([[0, 0.5, 72], [0.5, 0.5, 74], [1, 1, 76], [2.5, 0.5, 74], [3, 1, 72], [4, 0.5, 71], [4.5, 0.5, 72], [5, 1, 74], [6.5, 1.5, 67],
      [8, 0.5, 69], [8.5, 0.5, 72], [9, 1, 74], [10.5, 0.5, 72], [11, 1, 69], [12, 1, 67], [13, 1, 64], [14, 2, 67]], 90), 16, { opts: { vol: -8, pan: 0.2, sends: [0.2, 0.15] } });
    return finish(p, [dr, keys, bass, mar], ['GROOVE', 'FULL']);
  },
  amapiano(lib, p) {
    p.key = { root: 5, sc: 1 };                                                    // F minor: Fm9, Bbm9, Eb7, Dbmaj7
    const id = 'gen-logdrum-1', g = genSound(id);
    p.assets[id] = { name: GENERATED[id].name, frames: g.L.length };
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'AMAPIANO') }, 'GROOVE', beat({
      36: 'X...X...X...X...', 39: '....X.......X...', 37: '...x..x....x..x.', 70: 'xoxoxoxoxoxoxoxo' }), 4, { opts: { vol: -6, sends: [0.08, 0] } });
    const log = track(lib, 'sampler', 1, 'LOG DRUM', { src: id, sampleName: 'LOG DRUM' }, 'LOG DRUM', line([[0.5, 0.4, 41], [1.25, 0.4, 41], [2, 0.5, 44], [2.75, 0.4, 41], [3.5, 0.5, 39],
      [4.5, 0.4, 36], [5.25, 0.4, 39], [6, 0.5, 41], [6.75, 0.3, 44], [7.25, 0.75, 46]], 110), 8, { opts: { vol: -7, sends: [0.05, 0] } });
    Object.assign(log.sample, { root: GENERATED[id].root, att: 1, rel: 120 });
    log.fx = [fx('sat', { dr: 4, ty: 1, ou: -2 }), sc(dr, { th: -22, ra: 3 })];
    const keys = track(lib, 'synth', 2, 'KEYS', sound(lib, 'clipper', 'DIGITAL', 'DX RHODES'), 'JAZZY', rhythm([[56, 60, 63, 67], [56, 60, 61, 65], [55, 58, 61, 63], [53, 56, 60, 61]], [[0, 1.4], [1.5, 2.4]], 72), 16, { opts: { vol: -11, sends: [0.25, 0.1] } });
    const pad = track(lib, 'synth', 3, 'PAD', sound(lib, 'clipper', 'VOICE', 'VOX PAD'), 'PAD', chords([[0, 3.9, [68, 72, 75]], [4, 3.9, [68, 73, 77]], [8, 3.9, [67, 70, 75]], [12, 3.9, [68, 72, 77]]], 56), 16, { opts: { vol: -19, sends: [0.4, 0] } });
    return finish(p, [dr, log, keys, pad], ['GROOVE', 'FULL']);
  },
  rock(lib, p) {
    p.key = { root: 4, sc: 1 };                                                    // E minor: Em, C, G, D (power chords)
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'ACOUSTIC') }, 'ROCK', beat({
      36: 'X.....x.X.......X.....x.X.......X.....x.X.......X.....x.X...X.X.', 38: '....X.......X.......X.......X.......X.......X.......X.......X.XX',
      42: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.....', 49: 'X...............................................................' }), 16, { opts: { vol: -2, sends: [0.12, 0] } });
    const PW = [[40, 47, 52], [36, 43, 48], [43, 50, 55], [38, 45, 50]];
    const gtr = track(lib, 'synth', 1, 'GUITAR', sound(lib, 'clipper', 'PHYS', 'STEEL GTR'), 'POWER CHORDS', rhythm(PW, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => [t, 0.45]), 96), 16, { opts: { vol: -14, pan: -0.2, sends: [0.08, 0] } });
    gtr.fx = [fx('amp', { mo: 1, ga: 8, ba: 6, mi: 6, tr: 6, pr: 6, ca: 3 }), fx('eq', { hp: 90 })];
    const bass = track(lib, 'synth', 2, 'BASS', sound(lib, 'clipper', 'DIGITAL', 'BASS GTR'), 'EIGHTHS', roots([28, 36, 31, 38], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => [t, 0.45])), 16, { opts: { vol: -11, sends: [0, 0] } });
    bass.fx = [fx('amp', { mo: 4, ga: 3, ca: 4, mx: 0.5 })];
    const lead = track(lib, 'synth', 3, 'LEAD GTR', sound(lib, 'clipper', 'PHYS', 'STEEL GTR'), 'SOLO', line([[0, 1, 64], [1, 0.5, 67], [1.5, 0.5, 69], [2, 2, 71], [4, 1, 72], [5, 1, 71], [6, 2, 67],
      [8, 1, 67], [9, 0.5, 69], [9.5, 0.5, 71], [10, 2, 74], [12, 1, 74], [13, 1, 71], [14, 2, 69]], 100), 16, { opts: { vol: -15, pan: 0.25, sends: [0.2, 0.25] } });
    lead.fx = [fx('amp', { mo: 2, ga: 7, ba: 5, mi: 7, tr: 5, pr: 5, ca: 3 }), fx('delay', { ti: 4, fb: 0.3, mx: 0.18 })];
    return finish(p, [dr, gtr, bass, lead], ['RIFF', 'SOLO']);
  },
  cinematic(lib, p) {
    p.key = { root: 2, sc: 1 };                                                    // D minor: Dm, Bb, F, C
    const dr = track(lib, 'drum', 0, 'PERC', { kit: kit(lib, 'TRIBAL') }, 'TOMS', beat({
      36: 'X.......X.......', 43: '..x...x.o.x.x.xx', 48: '......x.......x.' }), 4, { opts: { vol: -7, sends: [0.25, 0] } });
    const cello = track(lib, 'synth', 1, 'CELLOS', sound(lib, 'clipper', 'STRINGS', 'CELLOS'), 'OSTINATO', roots([38, 34, 41, 36], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => [t, 0.45, [0, 12, 7, 12][i % 4], i % 4 ? 84 : 104])), 16, { opts: { vol: -10, sends: [0.3, 0] } });
    const brass = track(lib, 'synth', 2, 'BRASS', sound(lib, 'clipper', 'ANALOG', 'OBX BRASS'), 'SWELLS', chords([[0, 3.9, [50, 57, 62, 65]], [4, 3.9, [50, 53, 58, 62]], [8, 3.9, [53, 57, 60, 65]], [12, 3.9, [52, 55, 60, 64]]], 70), 16, { opts: { vol: -15, sends: [0.4, 0] } });
    const timp = track(lib, 'synth', 3, 'TIMPANI', sound(lib, 'clipper', 'PHYS', 'TIMPANI'), 'HITS', line([[0, 1, 38], [7.5, 0.5, 38], [8, 1, 41], [15, 0.5, 36], [15.5, 0.5, 38]], 110), 16, { opts: { vol: -9, sends: [0.35, 0] } });
    const choir = track(lib, 'synth', 4, 'CHOIR', sound(lib, 'clipper', 'VOICE', 'CHOIR AAH'), 'THEME', line([[0, 4, 69], [4, 4, 70], [8, 4, 72], [12, 2, 72], [14, 2, 76]], 76), 16, { opts: { vol: -10, sends: [0.5, 0] } });
    return finish(p, [dr, cello, brass, timp, choir], ['TENSION', 'EPIC']);
  },
  ambient(lib, p) {
    p.key = { root: 2, sc: 0 };                                                    // D major: Dmaj7, Bm7, Gmaj7, A
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'AMBIENT') }, 'PULSE', beat({
      36: 'X...............X.........x.....', 37: '........x...............x.......', 70: '..o...o...o...o...o...o...o...o.' }), 8, { opts: { vol: -10, sends: [0.4, 0.2] } });
    const drone = track(lib, 'synth', 1, 'DRONE', sound(lib, 'clipper', 'GRAIN', 'DARK DRONE'), 'DRONE', line([[0, 31.9, 38]], 70), 32, { opts: { vol: -17, sends: [0.3, 0] } });
    const pad = track(lib, 'synth', 2, 'PAD', sound(lib, 'clipper', 'GRAIN', 'FROZEN PAD'), 'CHORDS', chords([[0, 7.9, [62, 66, 69, 73]], [8, 7.9, [59, 62, 66, 69]], [16, 7.9, [55, 59, 62, 66]], [24, 7.9, [57, 61, 64, 69]]], 62), 32, { opts: { vol: -10, sends: [0.2, 0] } });
    pad.fx = [fx('space', { si: 1, dc: 12, da: 0.6, pr: 0.06, mo: 0.9, lc: 200, mx: 0.45 })];
    const pno = track(lib, 'synth', 3, 'PIANO', sound(lib, 'sloop', 'SAMPLE', 'GRAND PNO'), 'NOTES', line([[0, 4, 78], [4, 2, 76], [6, 2, 73], [8, 6, 74], [16, 4, 78], [20, 2, 81], [22, 2, 78], [24, 8, 76]], 60), 32, { opts: { vol: -8, sends: [0.4, 0.3] } });
    pno.fx = [fx('delay', { ti: 6, fb: 0.45, to: 0.4, mx: 0.25 })];
    return finish(p, [dr, drone, pad, pno], ['DRIFT', 'FULL']);
  },
  chiptune(lib, p) {
    p.key = { root: 0, sc: 0 };                                                    // C major: C, Am, F, G
    const dr = track(lib, 'drum', 0, 'DRUMS', { kit: kit(lib, 'CHIP') }, 'BEAT', beat({
      36: 'X.......X.X.....', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' }), 4, { opts: { vol: -2, sends: [0, 0] } });
    const CH = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
    const bass = track(lib, 'synth', 1, 'BASS', sound(lib, 'clipper', 'LOFI', 'NES BASS'), 'BASS', roots([36, 33, 29, 31], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => [t, 0.4, i % 2 ? 12 : 0])), 16, { opts: { vol: -10, sends: [0, 0] } });
    const arp = track(lib, 'synth', 2, 'ARP', sound(lib, 'clipper', 'LOFI', 'CHIP ARP'), 'ARP', perChord(CH.map((c) => [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24]), [0, 1, 2, 3], 0.25, 0.22, [84, 70, 70, 70]), 16, { opts: { vol: -17, pan: -0.2, sends: [0, 0.15] } });
    const lead = track(lib, 'synth', 3, 'LEAD', sound(lib, 'clipper', 'LOFI', 'GAME LEAD'), 'THEME', line([[0, 0.5, 76], [0.5, 0.5, 79], [1, 1, 84], [2, 0.5, 83], [2.5, 0.5, 81], [3, 1, 79],
      [4, 1, 81], [5, 0.5, 79], [5.5, 0.5, 76], [6, 2, 72], [8, 0.5, 77], [8.5, 0.5, 81], [9, 1, 84], [10, 0.5, 81], [10.5, 0.5, 77], [11, 1, 72], [12, 1, 74], [13, 1, 79], [14, 2, 83]], 92), 16, { opts: { vol: -13, pan: 0.1, sends: [0.05, 0.15] } });
    return finish(p, [dr, bass, arp, lead], ['LEVEL 1', 'BOSS']);
  },
};
