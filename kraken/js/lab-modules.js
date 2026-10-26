// SPDX-License-Identifier: GPL-3.0-only
// LAB: build your own instruments and effects from modules and cables. This file is the catalogue (what each module
// is, its inputs, outputs and knobs, in words) and the patch format; lab-dsp.js plays patches, ui/lab.js edits them.
// A patch is DATA, never code: shared on the hub or in a project, it can do nothing but make sound.
//
// The patch (JSON):
//   { v: 1, kind: 'inst' | 'fx', name,
//     voice: { poly: 1..16, mode: 'poly' | 'mono' | 'legato', glide: ms, bend: semitones },   (instruments)
//     macros: [{ name, v: 0..1 }] × 8,          the plugin's eight knobs (automation, MIDI learn, modulators)
//     mods: [{ id, type, x, y, p: { knob: value }, text?: formula }],
//     cables: [{ from: [module id, output], to: [module id, input], amt: -1..1 (times the input's range) }],
//     fx: [effects of the track rack format] }  the effects after all the voices (instruments)
// Signals: every cable carries a signal. Audio around ±1; modulation 0..1 or -1..1; gates 0 or 1; pitch in semitones
// (MIDI note numbers: 60 is middle C). An input that modulates a knob adds (signal × cable amount × its range) to the
// knob: a FILTER's CUTOFF input moves the cutoff by up to 5 octaves, an OSC's PITCH MOD by up to 12 semitones.
import { SCALES } from './notefx.js';
import { DEVICES } from './fx.js';                // (used only inside functions: fx.js and lab-dsp.js import each other)

export const LAB_VERSION = 1;
// the effects an EFFECT module can be (all of Kraken's but the LAB itself), and their names
export const FX_TYPES = ['eq', 'comp', 'mband', 'deess', 'trans', 'sat', 'amp', 'filter', 'chorus', 'flanger', 'phaser', 'pitch', 'delay', 'reverb', 'space', 'crush', 'gate', 'slicer', 'utility', 'limiter'];
const FX_NAMES = ['EQ', 'COMPRESSOR', 'MULTIBAND', 'DE-ESSER', 'TRANSIENT', 'SATURATOR', 'AMP', 'AUTO FILTER', 'CHORUS', 'FLANGER', 'PHASER', 'PITCH SHIFT', 'DELAY', 'REVERB', 'SPACE', 'BIT CRUSHER', 'GATE', 'SLICER', 'UTILITY', 'LIMITER'];
export const MAX_MODS = 64, MAX_CABLES = 160, MAX_TEXT = 200;
// ENGINE: what MOD A / MOD B can move: the engine's eight own settings (their names come from the firmware), then its
// envelope and level (the firmware's track settings of those names). MAX_ENGINES: each voice runs its own copy of
// each ENGINE (4 MB each), so a patch holds two at most.
export const ENG_TP = ['ATK', 'DEC', 'SUS', 'REL', 'LVL'];
export const ENG_TP_NAMES = ['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE', 'LEVEL'];
export const ENG_TARGETS = 8 + ENG_TP.length, MAX_ENGINES = 2;

const P = (k, l, min, max, def, unit = '', curve = 'lin', names = null) => ({ k, l, min, max, def, unit, curve, names });
const IN = (k, l, kind = 'audio', range = 1, unit = '') => ({ k, l, kind, range, unit });
const OUT = (k, l, kind = 'audio') => ({ k, l, kind });
export const SYNC_NAMES = ['FREE', '1/32', '1/16T', '1/16', '1/8T', '1/8', '1/8.', '1/4T', '1/4', '1/4.', '1/2', '1 BAR', '2 BARS', '4 BARS'];
export const SYNC_BEATS = [0, 0.125, 1 / 6, 0.25, 1 / 3, 0.5, 0.75, 2 / 3, 1, 1.5, 2, 4, 8, 16];

// categories in the order the palette shows them
export const CATS = [['io', 'NOTES & I/O'], ['src', 'SOURCES'], ['flt', 'FILTERS'], ['mod', 'MODULATION'], ['util', 'MATHS & UTILITIES'], ['fx', 'EFFECTS']];

export const MODULES = {
  // ------------------------------------------------------------------ notes & I/O
  note: { name: 'NOTE', cat: 'io', only: 'inst', help: 'The note being played: its pitch, its gate (1 while the key is held), its velocity, a trigger at its start, the key across the keyboard and a random value per note.',
    ins: [], outs: [OUT('pitch', 'PITCH', 'pitch'), OUT('gate', 'GATE', 'gate'), OUT('vel', 'VELOCITY', 'mod'), OUT('trig', 'TRIGGER', 'gate'), OUT('key', 'KEY', 'mod'), OUT('rand', 'RANDOM', 'mod')], params: [] },
  midi: { name: 'MIDI', cat: 'io', only: 'inst', help: 'Your controller: the mod wheel, pressure (aftertouch), pitch bend (-1 to 1), the sustain pedal, and any CC number you choose.',
    ins: [], outs: [OUT('wheel', 'WHEEL', 'mod'), OUT('press', 'PRESSURE', 'mod'), OUT('bend', 'BEND', 'mod'), OUT('sus', 'SUSTAIN', 'gate'), OUT('cc', 'CC', 'mod')], params: [P('cc', 'CC #', 0, 127, 74)] },
  macro: { name: 'MACRO', cat: 'io', help: 'One of the plugin\'s eight knobs (0 to 1). Name it in MACROS: it is what you turn, automate, map to a controller or modulate in the track.',
    ins: [], outs: [OUT('out', 'VALUE', 'mod')], params: [P('n', 'KNOB', 0, 7, 0, '', 'lin', ['1', '2', '3', '4', '5', '6', '7', '8'])] },
  in: { name: 'AUDIO IN', cat: 'io', only: 'fx', help: 'The sound coming into the effect, left and right.',
    ins: [], outs: [OUT('l', 'LEFT'), OUT('r', 'RIGHT')], params: [] },
  out: { name: 'OUTPUT', cat: 'io', help: 'What you hear. Plug a sound into LEFT (and RIGHT for stereo; LEFT alone plays in both). In an instrument each voice adds up here.',
    ins: [IN('l', 'LEFT'), IN('r', 'RIGHT')], outs: [], params: [P('gain', 'GAIN', -36, 12, 0, 'dB'), P('pan', 'PAN', -1, 1, 0)] },
  tempo: { name: 'TEMPO', cat: 'io', help: 'The song\'s clock: a ramp from 0 to 1 on every beat and on every bar, and 1 while the song plays.',
    ins: [], outs: [OUT('beat', 'BEAT', 'mod'), OUT('bar', 'BAR', 'mod'), OUT('play', 'PLAYING', 'gate')], params: [] },
  // ------------------------------------------------------------------ sources
  eng: { name: 'ENGINE', cat: 'src', only: 'inst', help: 'A real SLOOP or Clipper engine in your patch, the very one of the firmware: pick the FIRMWARE, one of its ENGINES and one of its SOUNDS, and every setting of that engine shows below. It plays each note with its own envelope and effects. Run it through filters, VCAs and effects, and move any of its settings with MOD A and MOD B (a MACRO, an LFO, an envelope…).',
    ins: [IN('ma', 'MOD A', 'mod', 1), IN('mb', 'MOD B', 'mod', 1)],
    outs: [OUT('l', 'LEFT'), OUT('r', 'RIGHT')],
    params: [P('bank', 'FIRMWARE', 0, 1, 1, '', 'lin', ['SLOOP', 'CLIPPER']), P('engine', 'ENGINE', 0, 31, 0), P('preset', 'SOUND', 0, 63, 12),
      P('ta', 'MOD A MOVES', 0, ENG_TARGETS - 1, 4), P('tb', 'MOD B MOVES', 0, ENG_TARGETS - 1, 5), P('level', 'LEVEL', 0, 1, 0.8, '%')], eng: true },
  osc: { name: 'OSC', cat: 'src', help: 'An oscillator. SHAPE goes smoothly from sine to triangle, saw, square and a thin pulse. It plays the note unless PITCH is plugged. FM: another oscillator into it for bells and metal; SYNC restarts it on another one\'s cycle.',
    ins: [IN('pitch', 'PITCH', 'pitch'), IN('pmod', 'PITCH MOD', 'mod', 12, 'st'), IN('fm', 'FM', 'audio', 1), IN('shape', 'SHAPE', 'mod', 4), IN('pw', 'WIDTH', 'mod', 0.45), IN('sync', 'SYNC', 'audio')],
    outs: [OUT('out', 'OUT')],
    params: [P('shape', 'SHAPE', 0, 4, 2, '', 'lin'), P('oct', 'OCTAVE', -4, 4, 0), P('tune', 'TUNE', -12, 12, 0, 'st'), P('fine', 'FINE', -100, 100, 0, 'ct'), P('pw', 'WIDTH', 0.05, 0.95, 0.5, '%'),
      P('level', 'LEVEL', 0, 1, 0.8, '%'), P('phase', 'START', 0, 1, 0, '', 'lin', ['FREE', 'RESTART'])] },
  super: { name: 'SUPERSAW', cat: 'src', help: 'Seven detuned saws spread across the stereo field: the big trance and EDM sound. DETUNE spreads them, MIX brings in the side saws.',
    ins: [IN('pitch', 'PITCH', 'pitch'), IN('pmod', 'PITCH MOD', 'mod', 12, 'st'), IN('detune', 'DETUNE', 'mod', 1)],
    outs: [OUT('l', 'LEFT'), OUT('r', 'RIGHT')],
    params: [P('oct', 'OCTAVE', -4, 4, 0), P('tune', 'TUNE', -12, 12, 0, 'st'), P('detune', 'DETUNE', 0, 1, 0.35, '%'), P('mix', 'MIX', 0, 1, 0.75, '%'), P('width', 'WIDTH', 0, 1, 0.8, '%'), P('level', 'LEVEL', 0, 1, 0.6, '%')] },
  op: { name: 'FM OP', cat: 'src', help: 'An FM operator: a sine at RATIO times the note. Plug another operator into PM (phase modulation) as in a DX7; FEEDBACK makes it bright and buzzy.',
    ins: [IN('pitch', 'PITCH', 'pitch'), IN('pm', 'PM', 'audio', 1), IN('amp', 'LEVEL', 'mod', 1), IN('pmod', 'PITCH MOD', 'mod', 12, 'st')],
    outs: [OUT('out', 'OUT')],
    params: [P('ratio', 'RATIO', 0.25, 16, 1, '×', 'log'), P('fine', 'FINE', -100, 100, 0, 'ct'), P('fb', 'FEEDBACK', 0, 1, 0, '%'), P('level', 'LEVEL', 0, 1, 0.8, '%'), P('fixed', 'FIXED HZ', 0, 1, 0, '', 'lin', ['OFF', 'ON']), P('hz', 'FREQ', 1, 8000, 440, 'Hz', 'log')] },
  noise: { name: 'NOISE', cat: 'src', help: 'Noise: WHITE is bright hiss, PINK is softer, BROWN is a low rumble. For hats, wind, breath, risers.',
    ins: [IN('amp', 'LEVEL', 'mod', 1)], outs: [OUT('out', 'OUT')], params: [P('color', 'COLOR', 0, 2, 0, '', 'lin', ['WHITE', 'PINK', 'BROWN']), P('level', 'LEVEL', 0, 1, 0.5, '%')] },
  pluck: { name: 'PLUCK', cat: 'src', help: 'A plucked string (Karplus-Strong): it rings on every note. DECAY is how long, DAMP how dark, PICK how bright the pluck.',
    ins: [IN('pitch', 'PITCH', 'pitch'), IN('trig', 'PLUCK', 'gate')], outs: [OUT('out', 'OUT')],
    params: [P('decay', 'DECAY', 0, 1, 0.7, '%'), P('damp', 'DAMP', 0, 1, 0.4, '%'), P('pick', 'PICK', 0, 1, 0.6, '%'), P('level', 'LEVEL', 0, 1, 0.8, '%')] },
  // ------------------------------------------------------------------ filters
  filter: { name: 'FILTER', cat: 'flt', help: 'A smooth state-variable filter: LOW PASS darkens, HIGH PASS thins, BAND keeps the middle, NOTCH removes it. CUTOFF input: an envelope or an LFO for sweeps (up to 5 octaves). KEY makes it follow the note.',
    ins: [IN('in', 'IN'), IN('cut', 'CUTOFF', 'mod', 5, 'oct'), IN('res', 'RESONANCE', 'mod', 1)], outs: [OUT('out', 'OUT')],
    params: [P('type', 'TYPE', 0, 3, 0, '', 'lin', ['LOW PASS', 'HIGH PASS', 'BAND', 'NOTCH']), P('cut', 'CUTOFF', 20, 20000, 1800, 'Hz', 'log'), P('res', 'RESONANCE', 0, 1, 0.2, '%'),
      P('drive', 'DRIVE', 0, 1, 0, '%'), P('key', 'KEY', 0, 1, 0, '%')] },
  ladder: { name: 'LADDER', cat: 'flt', help: 'A four-pole ladder low-pass, fat and creamy like classic analog monosynths; it sings (self-oscillates) at high RESONANCE. DRIVE pushes it.',
    ins: [IN('in', 'IN'), IN('cut', 'CUTOFF', 'mod', 5, 'oct'), IN('res', 'RESONANCE', 'mod', 1)], outs: [OUT('out', 'OUT')],
    params: [P('cut', 'CUTOFF', 20, 20000, 1200, 'Hz', 'log'), P('res', 'RESONANCE', 0, 1.1, 0.3, '%'), P('drive', 'DRIVE', 0, 1, 0.2, '%'), P('key', 'KEY', 0, 1, 0, '%')] },
  comb: { name: 'COMB', cat: 'flt', help: 'A comb filter tuned to the note (or a frequency): metallic, string-like, flanging. FEEDBACK makes it ring.',
    ins: [IN('in', 'IN'), IN('pitch', 'PITCH', 'pitch'), IN('fb', 'FEEDBACK', 'mod', 1)], outs: [OUT('out', 'OUT')],
    params: [P('follow', 'FOLLOW', 0, 1, 1, '', 'lin', ['FREQ', 'NOTE']), P('hz', 'FREQ', 20, 4000, 220, 'Hz', 'log'), P('fb', 'FEEDBACK', -0.98, 0.98, 0.7, '%'), P('damp', 'DAMP', 0, 1, 0.3, '%'), P('mix', 'MIX', 0, 1, 1, '%')] },
  vowel: { name: 'VOWEL', cat: 'flt', help: 'A formant filter: makes any sound say A, E, I, O, U. Move VOWEL with an LFO for talking basses.',
    ins: [IN('in', 'IN'), IN('vowel', 'VOWEL', 'mod', 4)], outs: [OUT('out', 'OUT')],
    params: [P('vowel', 'VOWEL', 0, 4, 0, '', 'lin'), P('q', 'SHARPNESS', 0, 1, 0.6, '%'), P('mix', 'MIX', 0, 1, 1, '%')] },
  // ------------------------------------------------------------------ modulation
  adsr: { name: 'ENVELOPE', cat: 'mod', help: 'Attack, decay, sustain, release: a shape over the note\'s life (0 to 1). Plug it into a VCA for volume, into a FILTER\'s CUTOFF for a sweep. It follows the note\'s gate unless GATE is plugged.',
    ins: [IN('gate', 'GATE', 'gate')], outs: [OUT('out', 'OUT', 'mod')],
    params: [P('a', 'ATTACK', 0.1, 10000, 5, 'ms', 'log'), P('d', 'DECAY', 1, 10000, 300, 'ms', 'log'), P('s', 'SUSTAIN', 0, 1, 0.7, '%'), P('r', 'RELEASE', 1, 20000, 300, 'ms', 'log'),
      P('vel', 'VELOCITY', 0, 1, 0.5, '%'), P('curve', 'CURVE', -1, 1, 0.5, '')] },
  lfo: { name: 'LFO', cat: 'mod', help: 'A slow wave for movement: vibrato, wobble, tremolo, sweeps. SYNC locks it to the tempo; START: free running, restarted on each note, or locked to the song.',
    ins: [IN('rate', 'RATE', 'mod', 4, 'oct'), IN('amp', 'DEPTH', 'mod', 1)], outs: [OUT('out', 'OUT', 'mod'), OUT('uni', '0..1', 'mod')],
    params: [P('wave', 'WAVE', 0, 6, 0, '', 'lin', ['SINE', 'TRIANGLE', 'SAW DOWN', 'SAW UP', 'SQUARE', 'RANDOM', 'SMOOTH']), P('rate', 'RATE', 0.01, 50, 2, 'Hz', 'log'),
      P('sync', 'SYNC', 0, 13, 0, '', 'lin', SYNC_NAMES), P('start', 'START', 0, 2, 2, '', 'lin', ['FREE', 'NOTE', 'SONG']), P('phase', 'PHASE', 0, 1, 0, '%'), P('fade', 'FADE IN', 0, 5000, 0, 'ms')] },
  steps: { name: 'STEPS', cat: 'mod', help: 'A step sequencer for modulation: up to 16 values in time with the song. Draw the steps; GLIDE slides between them.',
    ins: [], outs: [OUT('out', 'OUT', 'mod'), OUT('trig', 'STEP', 'gate')],
    params: [P('sync', 'RATE', 1, 13, 3, '', 'lin', SYNC_NAMES), P('len', 'STEPS', 1, 16, 8), P('glide', 'GLIDE', 0, 1, 0, '%'), P('start', 'START', 1, 2, 2, '', 'lin', ['FREE', 'NOTE', 'SONG']),
      ...[...Array(16)].map((_, i) => P(`s${i}`, `STEP ${i + 1}`, -1, 1, [1, 0.25, 0.5, 0, 0.75, -0.25, 0.5, -0.5][i % 8]))] },
  slew: { name: 'SLEW', cat: 'mod', help: 'Smooths a signal: glides between pitches, softens steps, slows changes. UP and DOWN set how long it takes each way.',
    ins: [IN('in', 'IN', 'mod')], outs: [OUT('out', 'OUT', 'mod')], params: [P('up', 'UP', 0, 5000, 80, 'ms'), P('down', 'DOWN', 0, 5000, 80, 'ms')] },
  follow: { name: 'FOLLOWER', cat: 'mod', help: 'Reads how loud a sound is (0 to 1): make one sound move another, duck, open a filter on loud notes.',
    ins: [IN('in', 'IN')], outs: [OUT('out', 'OUT', 'mod')], params: [P('att', 'ATTACK', 0.1, 500, 5, 'ms', 'log'), P('rel', 'RELEASE', 5, 3000, 150, 'ms', 'log'), P('gain', 'GAIN', 0, 4, 1, '×')] },
  sh: { name: 'SAMPLE & HOLD', cat: 'mod', help: 'Grabs its input (or a random value if nothing is plugged) on each trigger and holds it: stepped random patterns.',
    ins: [IN('in', 'IN', 'mod'), IN('trig', 'TRIGGER', 'gate')], outs: [OUT('out', 'OUT', 'mod')], params: [P('sync', 'RATE', 0, 13, 5, '', 'lin', SYNC_NAMES)] },
  // ------------------------------------------------------------------ maths & utilities
  vca: { name: 'VCA', cat: 'util', help: 'Volume control: IN times CV. With an ENVELOPE in CV, the note fades in and out.',
    ins: [IN('in', 'IN'), IN('cv', 'CV', 'mod', 1)], outs: [OUT('out', 'OUT')], params: [P('gain', 'GAIN', 0, 2, 1, '×')] },
  mix: { name: 'MIXER', cat: 'util', help: 'Adds up to four signals, each with its own level.',
    ins: [IN('a', 'A'), IN('b', 'B'), IN('c', 'C'), IN('d', 'D')], outs: [OUT('out', 'OUT')],
    params: [P('la', 'A', 0, 1, 0.8, '%'), P('lb', 'B', 0, 1, 0.8, '%'), P('lc', 'C', 0, 1, 0.8, '%'), P('ld', 'D', 0, 1, 0.8, '%')] },
  scale: { name: 'SCALE', cat: 'util', help: 'Multiplies a signal and adds an offset: turn -1..1 into 0..1, flip a modulation, make it smaller.',
    ins: [IN('in', 'IN', 'mod')], outs: [OUT('out', 'OUT', 'mod')], params: [P('mul', 'TIMES', -4, 4, 1, '×'), P('add', 'PLUS', -2, 2, 0)] },
  math: { name: 'MATHS', cat: 'util', help: 'Combines two signals: add, subtract, multiply, the smaller or the larger, their average.',
    ins: [IN('a', 'A', 'mod'), IN('b', 'B', 'mod')], outs: [OUT('out', 'OUT', 'mod')],
    params: [P('op', 'DO', 0, 5, 0, '', 'lin', ['A + B', 'A − B', 'A × B', 'MIN', 'MAX', 'AVERAGE']), P('a', 'A', -1, 1, 0), P('b', 'B', -1, 1, 0)] },
  shaper: { name: 'SHAPER', cat: 'util', help: 'Distorts: SOFT and TUBE warm it up, HARD clips, FOLD folds the wave back (rich, synthy), RECTIFY flips it, CRUSH lowers the resolution.',
    ins: [IN('in', 'IN'), IN('drive', 'DRIVE', 'mod', 24, 'dB')], outs: [OUT('out', 'OUT')],
    params: [P('type', 'TYPE', 0, 5, 0, '', 'lin', ['SOFT', 'TUBE', 'HARD', 'FOLD', 'RECTIFY', 'CRUSH']), P('drive', 'DRIVE', 0, 48, 6, 'dB'), P('mix', 'MIX', 0, 1, 1, '%'), P('out', 'OUTPUT', -24, 6, -3, 'dB')] },
  xfade: { name: 'CROSSFADE', cat: 'util', help: 'Blends from A to B as X goes from 0 to 1.',
    ins: [IN('a', 'A'), IN('b', 'B'), IN('x', 'X', 'mod', 1)], outs: [OUT('out', 'OUT')], params: [P('x', 'X', 0, 1, 0.5, '%')] },
  quant: { name: 'QUANTIZE', cat: 'util', help: 'Snaps a pitch to the nearest note of a scale: random or smooth pitches become melodies in key.',
    ins: [IN('in', 'IN', 'pitch')], outs: [OUT('out', 'OUT', 'pitch')],
    params: [P('root', 'ROOT', 0, 11, 0, '', 'lin', ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']), P('scale', 'SCALE', 0, SCALES.length - 1, 0, '', 'lin', SCALES.map((s) => s[0]))] },
  value: { name: 'VALUE', cat: 'util', help: 'A fixed value (-1 to 1) on a knob: an offset, a constant pitch, a manual control.',
    ins: [], outs: [OUT('out', 'OUT', 'mod')], params: [P('v', 'VALUE', -1, 1, 0.5)] },
  expr: { name: 'FORMULA', cat: 'util', help: 'Write your own maths: out = tanh(a * 3), sin(t * 6.28 * 2), a > 0.5 ? b : c… Inputs a, b, c, d; also t (seconds), pitch, gate, vel, x (the last output), pi. Functions: sin cos tan tanh abs min max clamp floor ceil round sqrt exp log pow sign noise.',
    ins: [IN('a', 'a', 'mod'), IN('b', 'b', 'mod'), IN('c', 'c', 'mod'), IN('d', 'd', 'mod')], outs: [OUT('out', 'OUT', 'mod')], params: [], text: 'a' },
  // ------------------------------------------------------------------ effects
  delay: { name: 'DELAY', cat: 'fx', help: 'A delay line: echoes (long TIME, FEEDBACK), chorus and flanger (a few milliseconds moved by an LFO), resonators.',
    ins: [IN('in', 'IN'), IN('time', 'TIME', 'mod', 1)], outs: [OUT('out', 'OUT')],
    params: [P('time', 'TIME', 0.1, 2000, 250, 'ms', 'log'), P('sync', 'SYNC', 0, 13, 0, '', 'lin', SYNC_NAMES), P('fb', 'FEEDBACK', 0, 0.98, 0.35, '%'), P('damp', 'DAMP', 0, 1, 0.3, '%'), P('mix', 'MIX', 0, 1, 0.35, '%')] },
  fx: { name: 'EFFECT', cat: 'fx', help: 'Any of Kraken\'s 20 effects inside your patch: EQ, compressor, amp, reverb, delay… Pick it in EFFECT; its knobs appear below.',
    ins: [IN('l', 'LEFT'), IN('r', 'RIGHT')], outs: [OUT('l', 'LEFT'), OUT('r', 'RIGHT')], params: [P('dev', 'EFFECT', 0, FX_TYPES.length - 1, FX_TYPES.indexOf('reverb'), '', 'lin', FX_NAMES)], dev: true },
};
export const MODULE_TYPES = Object.keys(MODULES);
export const PORT_KINDS = { audio: 'Audio', mod: 'Modulation', gate: 'Gate', pitch: 'Pitch' };

// a module's knobs at their defaults
export function modDefaults(type) {
  const o = {};
  for (const q of MODULES[type]?.params || []) o[q.k] = q.def;
  return o;
}
const rid = () => Math.random().toString(36).slice(2, 8);
export function newModule(type, x = 0, y = 0, id = null) {
  const m = { id: id || `${type}${rid()}`, type, x: Math.round(x), y: Math.round(y), p: modDefaults(type) };
  if (MODULES[type].text) m.text = MODULES[type].text;
  if (MODULES[type].dev) m.fx = { p: {} };
  if (MODULES[type].eng) m.eng = { p: {} };
  return m;
}
const MACRO_NAMES = ['CUTOFF', 'RESONANCE', 'ENV AMOUNT', 'ATTACK', 'RELEASE', 'DRIVE', 'MOVEMENT', 'SPACE'];
export const newMacros = () => MACRO_NAMES.map((name) => ({ name, v: 0.5 }));

// a fresh patch: an instrument that already plays (an oscillator through a filter and a volume envelope), or an
// effect that passes the sound through
export function newPatch(kind = 'inst') {
  if (kind === 'fx') return { v: LAB_VERSION, kind: 'fx', name: 'My effect', macros: newMacros().map((m, i) => ({ ...m, name: ['MIX', 'DRIVE', 'TONE', 'TIME', 'FEEDBACK', 'RATE', 'DEPTH', 'OUTPUT'][i] })),
    mods: [newModule('in', 40, 120, 'in'), newModule('out', 520, 120, 'out')], cables: [{ from: ['in', 'l'], to: ['out', 'l'], amt: 1 }, { from: ['in', 'r'], to: ['out', 'r'], amt: 1 }], fx: [] };
  const note = newModule('note', 20, 40, 'note'), osc = newModule('osc', 220, 30, 'osc'), flt = newModule('filter', 420, 30, 'filter'), env = newModule('adsr', 220, 260, 'env'), vca = newModule('vca', 620, 30, 'vca'), out = newModule('out', 820, 30, 'out');
  return { v: LAB_VERSION, kind: 'inst', name: 'My instrument', voice: { poly: 8, mode: 'poly', glide: 0, bend: 2 }, macros: newMacros(),
    mods: [note, osc, flt, env, vca, out],
    cables: [{ from: ['osc', 'out'], to: ['filter', 'in'], amt: 1 }, { from: ['filter', 'out'], to: ['vca', 'in'], amt: 1 }, { from: ['env', 'out'], to: ['vca', 'cv'], amt: 1 },
      { from: ['env', 'out'], to: ['filter', 'cut'], amt: 0.3 }, { from: ['vca', 'out'], to: ['out', 'l'], amt: 1 }],
    fx: [] };
}

// any patch made safe and whole: unknown modules and ports dropped, knobs clamped, cables between real ports, sizes
// capped, formulas bounded. (A patch from the hub or a file goes through this before anything plays it.)
const num = (x, d) => (Number.isFinite(+x) ? +x : d);
const clamp = (x, a, b, d) => Math.max(a, Math.min(b, num(x, d)));
const str = (x, d, n) => (typeof x === 'string' ? x.slice(0, n) : d);
export function validatePatch(raw, kindHint = null) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const kind = kindHint === 'fx' || kindHint === 'inst' ? kindHint : p.kind === 'fx' ? 'fx' : 'inst';   // (where it goes decides)
  const out = { v: LAB_VERSION, kind, name: str(p.name, kind === 'fx' ? 'My effect' : 'My instrument', 60) || 'Untitled' };
  if (kind === 'inst') {
    const v = p.voice && typeof p.voice === 'object' ? p.voice : {};
    out.voice = { poly: Math.round(clamp(v.poly, 1, 16, 8)), mode: ['poly', 'mono', 'legato'].includes(v.mode) ? v.mode : 'poly', glide: clamp(v.glide, 0, 5000, 0), bend: Math.round(clamp(v.bend, 0, 24, 2)) };
  }
  const ms = Array.isArray(p.macros) ? p.macros : [];
  out.macros = newMacros().map((d, i) => ({ name: str(ms[i]?.name, d.name, 16) || d.name, v: clamp(ms[i]?.v, 0, 1, 0.5) }));
  const ids = new Set();
  out.mods = [];
  for (const m of Array.isArray(p.mods) ? p.mods : []) {
    if (out.mods.length >= MAX_MODS || !m || typeof m !== 'object') continue;
    const def = MODULES[m.type];
    if (!def || (def.only && def.only !== kind)) continue;
    if (def.eng && out.mods.filter((x) => x.type === m.type).length >= MAX_ENGINES) continue;
    let id = str(m.id, '', 24).replace(/[^\w-]/g, '');
    if (!id || /^__|^(constructor|prototype|hasOwnProperty|toString)$/.test(id)) id = `${m.type}${ids.size}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    const q = { id, type: m.type, x: Math.round(clamp(m.x, -5000, 5000, 0)), y: Math.round(clamp(m.y, -5000, 5000, 0)), p: {} };
    for (const k of def.params) {
      let v = clamp(m.p?.[k.k], k.min, k.max, k.def);
      if (k.names) v = Math.round(v);
      q.p[k.k] = v;
    }
    if (def.text) q.text = str(m.text, def.text, MAX_TEXT);
    if (def.eng) {                                  // (whole numbers; the settings: firmware parameter ids, at most 64)
      for (const k of ['bank', 'engine', 'preset', 'ta', 'tb']) q.p[k] = Math.round(q.p[k]);
      const ep = {};
      for (const [id, v] of Object.entries(m.eng?.p && typeof m.eng.p === 'object' ? m.eng.p : {}).slice(0, 64)) if (/^\d{1,3}$/.test(id) && +id < 256) ep[id] = Math.round(clamp(v, -128, 127, 0));
      q.eng = { p: ep };
    }
    if (def.dev) {
      const type = FX_TYPES[q.p.dev], dp = {};
      for (const k of DEVICES[type].params) if (k.k !== 'sc') dp[k.k] = clamp(m.fx?.p?.[k.k], k.min, k.max, k.def);
      q.fx = { p: dp };
    }
    out.mods.push(q);
  }
  const byId = new Map(out.mods.map((m) => [m.id, m]));
  const seen = new Set();
  out.cables = [];
  for (const c of Array.isArray(p.cables) ? p.cables : []) {
    if (out.cables.length >= MAX_CABLES || !c || !Array.isArray(c.from) || !Array.isArray(c.to)) continue;
    const a = byId.get(c.from[0]), b = byId.get(c.to[0]);
    if (!a || !b) continue;
    if (!MODULES[a.type].outs.some((o) => o.k === c.from[1]) || !MODULES[b.type].ins.some((i) => i.k === c.to[1])) continue;
    const key = `${a.id}.${c.from[1]}>${b.id}.${c.to[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.cables.push({ from: [a.id, c.from[1]], to: [b.id, c.to[1]], amt: clamp(c.amt, -1, 1, 1) });
  }
  out.fx = (Array.isArray(p.fx) ? p.fx : []).filter((d) => d && FX_TYPES.includes(d.type)).slice(0, 8).map((d) => {
    const dp = {};
    for (const k of DEVICES[d.type].params) if (k.k !== 'sc') dp[k.k] = clamp(d.p?.[k.k], k.min, k.max, k.def);
    return { id: str(d.id, '', 24).replace(/[^\w-]/g, '') || `f${rid()}`, type: d.type, on: d.on !== false, p: dp };
  });
  return out;
}
// the structure of a patch (modules, cables, voices), without its knob values: what forces a rebuild when it changes
export const patchShape = (p) => JSON.stringify([p.kind, p.voice?.poly, p.voice?.mode, p.mods.map((m) => [m.id, m.type, m.text || '', m.type === 'fx' ? m.p.dev : m.type === 'eng' ? m.p.bank : 0]), p.cables.map((c) => [c.from, c.to]), (p.fx || []).map((f) => [f.id, f.type])]);
