// SPDX-License-Identifier: GPL-3.0-only
// LAB's factory patches: instruments and effects ready to play, and to open to see how they are made.
import { validatePatch, modDefaults } from './lab-modules.js';
import { defaults } from './fx.js';

const M = (id, type, x, y, p = {}, extra = {}) => ({ id, type, x, y, p: { ...modDefaults(type), ...p }, ...extra });
const C = (from, to, amt = 1) => ({ from: from.split('.'), to: to.split('.'), amt });
const FX = (type, p = {}) => ({ id: `f${type}`, type, on: true, p: { ...defaults(type), ...p } });
const macros = (list) => [...Array(8)].map((_, i) => ({ name: list[i]?.[0] || `MACRO ${i + 1}`, v: list[i]?.[1] ?? 0.5 }));
// columns and rows of the layout
const X = [20, 250, 480, 710, 940, 1170], Y = [20, 290, 560, 830];
const inst = (name, tags, mods, cables, o = {}) => ({ name, tags, kind: 'inst', patch: validatePatch({ kind: 'inst', name, voice: { poly: o.poly ?? 8, mode: o.mode || 'poly', glide: o.glide || 0, bend: o.bend ?? 2 },
  macros: macros(o.macros || []), mods, cables, fx: o.fx || [] }) });
const effect = (name, tags, mods, cables, o = {}) => ({ name, tags, kind: 'fx', patch: validatePatch({ kind: 'fx', name, macros: macros(o.macros || []), mods, cables }, 'fx') });
const amp = (env = {}) => M('env', 'adsr', X[2], Y[2], { a: 3, d: 300, s: 0.75, r: 250, ...env });

export const LAB_FACTORY = [
  // ------------------------------------------------------------------ instruments
  inst('Classic subtractive', 'synth lead keys', [
    M('note', 'note', X[0], Y[0]), M('o1', 'osc', X[1], Y[0], { shape: 2, level: 0.5 }), M('o2', 'osc', X[1], Y[1], { shape: 2, fine: 9, level: 0.5 }), M('mix', 'mix', X[2], Y[0]),
    M('flt', 'filter', X[3], Y[0], { cut: 500, res: 0.25 }), M('fenv', 'adsr', X[2], Y[3], { a: 2, d: 400, s: 0.2, r: 300 }), M('envamt', 'vca', X[3], Y[3]),
    M('m0', 'macro', X[0], Y[1], { n: 0 }), M('m1', 'macro', X[0], Y[2], { n: 1 }), M('m2', 'macro', X[0], Y[3], { n: 2 }), M('m3', 'macro', X[1], Y[3], { n: 3 }),
    amp(), M('vca', 'vca', X[4], Y[0]), M('out', 'out', X[5], Y[0])],
  [C('o1.out', 'mix.a'), C('o2.out', 'mix.b'), C('mix.out', 'flt.in'), C('fenv.out', 'envamt.in'), C('m2.out', 'envamt.cv'), C('envamt.out', 'flt.cut', 0.7), C('m0.out', 'flt.cut', 0.6),
    C('m1.out', 'flt.res', 0.8), C('m3.out', 'o2.pmod', 0.05), C('flt.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'out.l')],
  { macros: [['CUTOFF', 0.45], ['RESONANCE', 0.2], ['ENV AMOUNT', 0.6], ['DETUNE', 0.3]] }),

  inst('Acid line', 'bass 303 techno', [
    M('note', 'note', X[0], Y[0]), M('o', 'osc', X[1], Y[0], { shape: 2, level: 0.9 }), M('lad', 'ladder', X[2], Y[0], { cut: 260, res: 0.82, drive: 0.4 }),
    M('fenv', 'adsr', X[1], Y[2], { a: 1, d: 220, s: 0, r: 80, vel: 0 }), M('envamt', 'vca', X[2], Y[2]), M('m0', 'macro', X[0], Y[1], { n: 0 }), M('m1', 'macro', X[0], Y[2], { n: 1 }),
    M('m2', 'macro', X[0], Y[3], { n: 2 }), amp({ a: 1, d: 300, s: 0.7, r: 60, vel: 0.4 }), M('vca', 'vca', X[3], Y[0]), M('sat', 'shaper', X[4], Y[0], { type: 1, drive: 8, out: -6 }), M('out', 'out', X[5], Y[0])],
  [C('o.out', 'lad.in'), C('fenv.out', 'envamt.in'), C('m1.out', 'envamt.cv'), C('envamt.out', 'lad.cut', 0.8), C('m0.out', 'lad.cut', 0.5), C('note.vel', 'lad.cut', 0.15),
    C('m2.out', 'lad.res', 0.25), C('lad.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'sat.in'), C('sat.out', 'out.l')],
  { poly: 1, mode: 'legato', glide: 70, macros: [['CUTOFF', 0.35], ['ENV MOD', 0.7], ['RESONANCE', 0.4]] }),

  inst('Supersaw lead', 'lead trance edm', [
    M('s', 'super', X[1], Y[0], { detune: 0.4, mix: 0.8 }), M('fl', 'filter', X[2], Y[0], { cut: 5000, res: 0.1 }), M('fr', 'filter', X[2], Y[1], { cut: 5000, res: 0.1 }),
    amp({ a: 6, d: 500, s: 0.8, r: 350 }), M('vl', 'vca', X[3], Y[0]), M('vr', 'vca', X[3], Y[1]), M('m0', 'macro', X[0], Y[0], { n: 0 }), M('m1', 'macro', X[0], Y[1], { n: 1 }), M('out', 'out', X[4], Y[0])],
  [C('s.l', 'fl.in'), C('s.r', 'fr.in'), C('m0.out', 's.detune', 0.6), C('m1.out', 'fl.cut', 0.4), C('m1.out', 'fr.cut', 0.4), C('fl.out', 'vl.in'), C('fr.out', 'vr.in'),
    C('env.out', 'vl.cv'), C('env.out', 'vr.cv'), C('vl.out', 'out.l'), C('vr.out', 'out.r')],
  { macros: [['DETUNE', 0.35], ['BRIGHT', 0.3]], fx: [FX('delay', { ti: 4, fb: 0.35, mx: 0.18 }), FX('reverb', { mx: 0.18 })] }),

  inst('Supersaw pad', 'pad chords trance', [
    M('s', 'super', X[1], Y[0], { detune: 0.5, mix: 0.9, level: 0.5 }), M('lfo', 'lfo', X[0], Y[1], { rate: 0.15 }), M('fl', 'filter', X[2], Y[0], { cut: 1800, res: 0.15 }),
    M('fr', 'filter', X[2], Y[1], { cut: 1800, res: 0.15 }), amp({ a: 700, d: 800, s: 0.85, r: 1600 }), M('vl', 'vca', X[3], Y[0]), M('vr', 'vca', X[3], Y[1]),
    M('m0', 'macro', X[0], Y[0], { n: 0 }), M('out', 'out', X[4], Y[0])],
  [C('s.l', 'fl.in'), C('s.r', 'fr.in'), C('lfo.out', 'fl.cut', 0.12), C('lfo.out', 'fr.cut', -0.12), C('m0.out', 'fl.cut', 0.5), C('m0.out', 'fr.cut', 0.5),
    C('fl.out', 'vl.in'), C('fr.out', 'vr.in'), C('env.out', 'vl.cv'), C('env.out', 'vr.cv'), C('vl.out', 'out.l'), C('vr.out', 'out.r')],
  { macros: [['BRIGHT', 0.4]], fx: [FX('chorus', { mx: 0.35 }), FX('space', { si: 0.9, dc: 4, mx: 0.35 })] }),

  inst('FM e-piano', 'keys fm rhodes', [
    M('note', 'note', X[0], Y[0]), M('mod', 'op', X[1], Y[0], { ratio: 1, level: 1 }), M('menv', 'adsr', X[0], Y[2], { a: 1, d: 900, s: 0.1, r: 300, vel: 0.8 }),
    M('mamt', 'vca', X[1], Y[2]), M('car', 'op', X[2], Y[0], { ratio: 1, level: 0.7 }), M('tine', 'op', X[1], Y[1], { ratio: 14, level: 1 }), M('tenv', 'adsr', X[0], Y[3], { a: 0.5, d: 90, s: 0, r: 60, vel: 1 }),
    M('tamt', 'vca', X[2], Y[3]), M('m0', 'macro', X[0], Y[1], { n: 0 }), amp({ a: 2, d: 2200, s: 0.25, r: 450, vel: 0.6 }), M('vca', 'vca', X[3], Y[0]), M('out', 'out', X[4], Y[0])],
  [C('menv.out', 'mamt.in'), C('m0.out', 'mamt.cv'), C('mamt.out', 'mod.amp'), C('mod.out', 'car.pm', 0.22), C('tenv.out', 'tamt.in'), C('tamt.out', 'tine.amp'), C('tine.out', 'car.pm', 0.08),
    C('car.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'out.l')],
  { macros: [['BRIGHTNESS', 0.6]], fx: [FX('chorus', { ra: 0.5, de: 0.4, mx: 0.3 }), FX('reverb', { si: 0.5, mx: 0.15 })] }),

  inst('FM bell', 'bell fm mallet', [
    M('mod', 'op', X[1], Y[0], { ratio: 3.5, level: 1 }), M('menv', 'adsr', X[0], Y[1], { a: 0.5, d: 2500, s: 0, r: 2000, vel: 0.7 }), M('car', 'op', X[2], Y[0], { ratio: 1 }),
    amp({ a: 1, d: 4000, s: 0, r: 3000, vel: 0.5 }), M('vca', 'vca', X[3], Y[0]), M('out', 'out', X[4], Y[0])],
  [C('menv.out', 'mod.amp'), C('mod.out', 'car.pm', 0.35), C('car.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'out.l')],
  { fx: [FX('space', { si: 0.8, dc: 3.5, mx: 0.3 })] }),

  inst('Plucked guitar', 'guitar pluck acoustic', [
    M('p', 'pluck', X[1], Y[0], { decay: 0.75, damp: 0.45, pick: 0.6 }), M('fl', 'filter', X[2], Y[0], { cut: 6000, res: 0 }), M('m0', 'macro', X[0], Y[0], { n: 0 }), M('out', 'out', X[3], Y[0])],
  [C('p.out', 'fl.in'), C('m0.out', 'fl.cut', 0.4), C('fl.out', 'out.l')],
  { macros: [['BRIGHT', 0.5]], fx: [FX('amp', { mo: 0, ga: 2, tr: 6, ca: 2, mx: 0.4 }), FX('space', { si: 0.3, dc: 0.9, mx: 0.15 })] }),

  inst('Wobble bass', 'bass dubstep wobble', [
    M('o1', 'osc', X[1], Y[0], { shape: 2 }), M('o2', 'osc', X[1], Y[1], { shape: 3, oct: -1 }), M('mix', 'mix', X[2], Y[0]), M('lfo', 'lfo', X[0], Y[1], { sync: 5, start: 2 }),
    M('m0', 'macro', X[0], Y[0], { n: 0 }), M('m1', 'macro', X[0], Y[2], { n: 1 }), M('lad', 'ladder', X[3], Y[0], { cut: 300, res: 0.55, drive: 0.6 }), amp({ a: 2, d: 200, s: 0.9, r: 80 }),
    M('vca', 'vca', X[4], Y[0]), M('sat', 'shaper', X[4], Y[1], { type: 0, drive: 12, out: -6 }), M('out', 'out', X[5], Y[0])],
  [C('o1.out', 'mix.a'), C('o2.out', 'mix.b'), C('mix.out', 'lad.in'), C('lfo.uni', 'lad.cut', 0.7), C('m0.out', 'lfo.rate', 0.25), C('m1.out', 'lad.cut', 0.3),
    C('lad.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'sat.in'), C('sat.out', 'out.l')],
  { poly: 1, mode: 'legato', glide: 40, macros: [['WOBBLE SPEED', 0], ['OPEN', 0.3]] }),

  inst('Reese bass', 'bass dnb reese', [
    M('o1', 'osc', X[1], Y[0], { shape: 2, fine: -14 }), M('o2', 'osc', X[1], Y[1], { shape: 2, fine: 14 }), M('sub', 'osc', X[1], Y[2], { shape: 0, oct: -1, level: 0.7 }),
    M('mix', 'mix', X[2], Y[0]), M('lfo', 'lfo', X[0], Y[1], { rate: 0.3 }), M('fl', 'filter', X[3], Y[0], { cut: 700, res: 0.3 }), amp({ a: 5, d: 300, s: 0.95, r: 150 }),
    M('vca', 'vca', X[4], Y[0]), M('sat', 'shaper', X[4], Y[1], { type: 1, drive: 6, out: -4 }), M('m0', 'macro', X[0], Y[0], { n: 0 }), M('out', 'out', X[5], Y[0])],
  [C('o1.out', 'mix.a'), C('o2.out', 'mix.b'), C('sub.out', 'mix.c'), C('mix.out', 'fl.in'), C('lfo.out', 'fl.cut', 0.15), C('m0.out', 'fl.cut', 0.4), C('fl.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'sat.in'), C('sat.out', 'out.l')],
  { poly: 1, mode: 'legato', glide: 30, macros: [['OPEN', 0.4]] }),

  inst('808 bass', 'bass 808 trap', [
    M('o', 'osc', X[1], Y[0], { shape: 0, oct: -1, level: 1 }), M('penv', 'adsr', X[0], Y[1], { a: 0.1, d: 70, s: 0, r: 40, vel: 0 }), amp({ a: 1, d: 1800, s: 0, r: 300, vel: 0.3 }),
    M('vca', 'vca', X[2], Y[0]), M('m0', 'macro', X[0], Y[0], { n: 0 }), M('sat', 'shaper', X[3], Y[0], { type: 1, drive: 4, out: -2 }), M('out', 'out', X[4], Y[0])],
  [C('penv.out', 'o.pmod', 0.6), C('o.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'sat.in'), C('m0.out', 'sat.drive', 0.6), C('sat.out', 'out.l')],
  { poly: 1, mode: 'legato', glide: 90, macros: [['DIRT', 0.2]] }),

  inst('String ensemble', 'strings pad orchestral', [
    M('s', 'super', X[1], Y[0], { detune: 0.18, mix: 0.6, level: 0.5 }), M('vib', 'lfo', X[0], Y[0], { rate: 5.2, fade: 700 }), M('fl', 'filter', X[2], Y[0], { cut: 3500, res: 0.05 }),
    M('fr', 'filter', X[2], Y[1], { cut: 3500, res: 0.05 }), amp({ a: 350, d: 600, s: 0.9, r: 900 }), M('vl', 'vca', X[3], Y[0]), M('vr', 'vca', X[3], Y[1]), M('out', 'out', X[4], Y[0])],
  [C('vib.out', 's.pmod', 0.012), C('s.l', 'fl.in'), C('s.r', 'fr.in'), C('fl.out', 'vl.in'), C('fr.out', 'vr.in'), C('env.out', 'vl.cv'), C('env.out', 'vr.cv'), C('vl.out', 'out.l'), C('vr.out', 'out.r')],
  { fx: [FX('chorus', { mx: 0.3 }), FX('space', { si: 0.8, dc: 2.5, mx: 0.28 })] }),

  inst('Talking bass', 'bass vowel funk', [
    M('o', 'osc', X[1], Y[0], { shape: 2 }), M('lfo', 'lfo', X[0], Y[1], { sync: 8, start: 2, wave: 1 }), M('vw', 'vowel', X[2], Y[0], { q: 0.7 }), amp({ a: 2, d: 300, s: 0.85, r: 120 }),
    M('vca', 'vca', X[3], Y[0]), M('out', 'out', X[4], Y[0])],
  [C('o.out', 'vw.in'), C('lfo.uni', 'vw.vowel', 1), C('vw.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'out.l')],
  { poly: 1, mode: 'legato', glide: 30 }),

  inst('Chip arpeggio', 'chiptune 8bit arp', [
    M('o', 'osc', X[1], Y[0], { shape: 3, pw: 0.25, level: 0.6 }), M('st', 'steps', X[0], Y[1], { sync: 3, len: 4, s0: 0, s1: 4 / 12, s2: 7 / 12, s3: 1 }), amp({ a: 1, d: 100, s: 0.8, r: 60 }),
    M('vca', 'vca', X[2], Y[0]), M('out', 'out', X[3], Y[0])],
  [C('st.out', 'o.pmod', 1), C('o.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'out.l')],
  { fx: [FX('delay', { ti: 3, fb: 0.25, mx: 0.15 })] }),

  inst('Kick drum', 'drum kick percussion', [
    M('o', 'osc', X[1], Y[0], { shape: 0, oct: -1, level: 1, phase: 1 }), M('penv', 'adsr', X[0], Y[1], { a: 0.1, d: 45, s: 0, r: 30, vel: 0 }), amp({ a: 0.1, d: 380, s: 0, r: 150, vel: 0.4 }),
    M('vca', 'vca', X[2], Y[0]), M('sat', 'shaper', X[3], Y[0], { type: 0, drive: 6, out: -1 }), M('out', 'out', X[4], Y[0])],
  [C('penv.out', 'o.pmod', 1), C('o.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'sat.in'), C('sat.out', 'out.l')], { poly: 4 }),

  inst('Snare drum', 'drum snare percussion', [
    M('n', 'noise', X[1], Y[0], { color: 0, level: 0.7 }), M('bp', 'filter', X[2], Y[0], { type: 2, cut: 2500, res: 0.2 }), M('o', 'osc', X[1], Y[1], { shape: 1, phase: 1, level: 0.6 }),
    M('nenv', 'adsr', X[0], Y[0], { a: 0.1, d: 180, s: 0, r: 120, vel: 0.5 }), M('tenv', 'adsr', X[0], Y[2], { a: 0.1, d: 70, s: 0, r: 60 }), M('nv', 'vca', X[3], Y[0]), M('tv', 'vca', X[3], Y[1]),
    M('mix', 'mix', X[4], Y[0], { la: 1, lb: 0.8 }), M('out', 'out', X[5], Y[0])],
  [C('n.out', 'bp.in'), C('bp.out', 'nv.in'), C('nenv.out', 'nv.cv'), C('o.out', 'tv.in'), C('tenv.out', 'tv.cv'), C('nv.out', 'mix.a'), C('tv.out', 'mix.b'), C('mix.out', 'out.l')], { poly: 4 }),

  inst('Hi-hat', 'drum hat percussion', [
    M('n', 'noise', X[1], Y[0], { color: 0, level: 0.8 }), M('hp', 'filter', X[2], Y[0], { type: 1, cut: 7500, res: 0.1 }), amp({ a: 0.1, d: 55, s: 0, r: 40, vel: 0.7 }),
    M('vca', 'vca', X[3], Y[0]), M('out', 'out', X[4], Y[0])],
  [C('n.out', 'hp.in'), C('hp.out', 'vca.in'), C('env.out', 'vca.cv'), C('vca.out', 'out.l')], { poly: 4 }),

  inst('Generative bells', 'ambient random generative', [
    M('sh', 'sh', X[0], Y[0], { sync: 5 }), M('sc', 'scale', X[1], Y[0], { mul: 12, add: 72 }), M('q', 'quant', X[2], Y[0], { scale: 9 }), M('o', 'op', X[3], Y[0], { ratio: 1 }),
    M('m', 'op', X[2], Y[1], { ratio: 2.01, level: 0.5 }), M('pl', 'adsr', X[1], Y[2], { a: 1, d: 350, s: 0, r: 300 }), M('clk', 'lfo', X[0], Y[1], { sync: 5, start: 2, wave: 4 }), M('note', 'note', X[0], Y[2]), M('and', 'math', X[0], Y[3], { op: 2 }), M('vca', 'vca', X[4], Y[0]),
    M('out', 'out', X[5], Y[0])],
  [C('sh.out', 'sc.in'), C('sc.out', 'q.in'), C('q.out', 'o.pitch'), C('q.out', 'm.pitch'), C('m.out', 'o.pm', 0.15), C('clk.uni', 'and.a'), C('note.gate', 'and.b'), C('and.out', 'pl.gate'), C('o.out', 'vca.in'), C('pl.out', 'vca.cv'), C('vca.out', 'out.l')],
  { poly: 1, fx: [FX('delay', { ti: 6, fb: 0.4, mx: 0.3 }), FX('space', { si: 0.9, dc: 5, mx: 0.35 })] }),

  inst('Formula synth', 'formula experimental fm', [
    M('env', 'adsr', X[0], Y[0], { a: 2, d: 600, s: 0.3, r: 400 }), M('f', 'expr', X[1], Y[0], {}, { text: 'sin(6.2832 * mtof(pitch) * t + a * 3 * sin(6.2832 * mtof(pitch) * 2 * t)) * a' }),
    M('out', 'out', X[2], Y[0])],
  [C('env.out', 'f.a'), C('f.out', 'out.l')]),

  // ------------------------------------------------------------------ effects
  effect('Tape echo', 'delay echo tape', [
    M('in', 'in', X[0], Y[0]), M('wow', 'lfo', X[0], Y[2], { rate: 0.6 }), M('dl', 'delay', X[2], Y[0], { sync: 6, fb: 0.45, damp: 0.55, mix: 0.35 }),
    M('dr', 'delay', X[2], Y[1], { sync: 8, fb: 0.4, damp: 0.6, mix: 0.35 }), M('sat', 'shaper', X[3], Y[0], { type: 1, drive: 3, out: -1, mix: 0.6 }), M('satr', 'shaper', X[3], Y[1], { type: 1, drive: 3, out: -1, mix: 0.6 }),
    M('out', 'out', X[4], Y[0])],
  [C('in.l', 'dl.in'), C('in.r', 'dr.in'), C('wow.out', 'dl.time', 0.006), C('wow.out', 'dr.time', -0.006), C('dl.out', 'sat.in'), C('dr.out', 'satr.in'), C('sat.out', 'out.l'), C('satr.out', 'out.r')]),

  effect('Lo-fi', 'lofi crush vintage', [
    M('in', 'in', X[0], Y[0]), M('mix', 'mix', X[1], Y[0], { la: 0.6, lb: 0.6 }), M('cr', 'shaper', X[2], Y[0], { type: 5, drive: 27, out: 0 }), M('fl', 'filter', X[3], Y[0], { cut: 4000, res: 0.15 }),
    M('wob', 'lfo', X[2], Y[1], { rate: 0.4, wave: 6 }), M('out', 'out', X[4], Y[0])],
  [C('in.l', 'mix.a'), C('in.r', 'mix.b'), C('mix.out', 'cr.in'), C('cr.out', 'fl.in'), C('wob.out', 'fl.cut', 0.08), C('fl.out', 'out.l')]),

  effect('Ring modulator', 'ring metal robot', [
    M('in', 'in', X[0], Y[0]), M('o', 'osc', X[1], Y[1], { shape: 0, level: 1 }), M('m0', 'macro', X[0], Y[1], { n: 0 }), M('vl', 'vca', X[2], Y[0]), M('vr', 'vca', X[2], Y[1]), M('out', 'out', X[3], Y[0])],
  [C('m0.out', 'o.pmod', 1), C('in.l', 'vl.in'), C('in.r', 'vr.in'), C('o.out', 'vl.cv'), C('o.out', 'vr.cv'), C('vl.out', 'out.l'), C('vr.out', 'out.r')],
  { macros: [['FREQUENCY', 0.5]] }),

  effect('Talk filter', 'vowel filter wah', [
    M('in', 'in', X[0], Y[0]), M('lfo', 'lfo', X[0], Y[2], { sync: 10, start: 2, wave: 1 }), M('vl', 'vowel', X[2], Y[0], { q: 0.7 }), M('vr', 'vowel', X[2], Y[1], { q: 0.7 }), M('out', 'out', X[3], Y[0])],
  [C('in.l', 'vl.in'), C('in.r', 'vr.in'), C('lfo.uni', 'vl.vowel', 1), C('lfo.uni', 'vr.vowel', 0.9), C('vl.out', 'out.l'), C('vr.out', 'out.r')]),

  effect('Comb resonator', 'comb metallic resonator', [
    M('in', 'in', X[0], Y[0]), M('cl', 'comb', X[1], Y[0], { follow: 0, hz: 220, fb: 0.85, damp: 0.3, mix: 0.6 }), M('cr', 'comb', X[1], Y[1], { follow: 0, hz: 330, fb: 0.85, damp: 0.3, mix: 0.6 }), M('out', 'out', X[2], Y[0])],
  [C('in.l', 'cl.in'), C('in.r', 'cr.in'), C('cl.out', 'out.l'), C('cr.out', 'out.r')]),

  effect('Auto-pan', 'pan stereo movement', [
    M('in', 'in', X[0], Y[0]), M('lfo', 'lfo', X[0], Y[2], { sync: 8, start: 2 }), M('a', 'scale', X[1], Y[2], { mul: 0.5, add: 0.5 }), M('b', 'scale', X[1], Y[3], { mul: -0.5, add: 0.5 }),
    M('vl', 'vca', X[2], Y[0]), M('vr', 'vca', X[2], Y[1]), M('out', 'out', X[3], Y[0])],
  [C('lfo.out', 'a.in'), C('lfo.out', 'b.in'), C('in.l', 'vl.in'), C('in.r', 'vr.in'), C('a.out', 'vl.cv'), C('b.out', 'vr.cv'), C('vl.out', 'out.l'), C('vr.out', 'out.r')]),

  effect('Sidechain pump', 'pump sidechain house', [
    M('in', 'in', X[0], Y[0]), M('tempo', 'tempo', X[0], Y[2]), M('f', 'expr', X[1], Y[2], {}, { text: 'clamp(a * 3, 0, 1) ^ 0.7' }), M('vl', 'vca', X[2], Y[0]), M('vr', 'vca', X[2], Y[1]), M('out', 'out', X[3], Y[0])],
  [C('tempo.beat', 'f.a'), C('in.l', 'vl.in'), C('in.r', 'vr.in'), C('f.out', 'vl.cv'), C('f.out', 'vr.cv'), C('vl.out', 'out.l'), C('vr.out', 'out.r')]),

  effect('Crunch amp', 'amp guitar distortion', [
    M('in', 'in', X[0], Y[0]), M('pre', 'shaper', X[1], Y[0], { type: 1, drive: 9, out: -4, mix: 1 }), M('pr', 'shaper', X[1], Y[1], { type: 1, drive: 9, out: -4, mix: 1 }),
    M('amp', 'fx', X[2], Y[0], { dev: 6 }, { fx: { p: { mo: 1, ga: 6, ca: 3 } } }), M('out', 'out', X[3], Y[0])],
  [C('in.l', 'pre.in'), C('in.r', 'pr.in'), C('pre.out', 'amp.l'), C('pr.out', 'amp.r'), C('amp.l', 'out.l'), C('amp.r', 'out.r')]),
];
