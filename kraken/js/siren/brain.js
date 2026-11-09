// SPDX-License-Identifier: GPL-3.0-only
// From SIREN (https://github.com/isod89/siren-fm1, tests/siren/brain.js at be3c780, SIREN 0.10), by Sodwave: the
// brain that writes SIREN's raves, the same as the FM-1's firmware (firmware/src/siren_brain.c) event for event; Kraken
// asks it for whole songs (siren/song.js). SIREN's eight styles are kept exactly as they are (tests/siren_song_test.mjs
// checks every event against the firmware's); Kraken's other styles are grammars of their own (siren/styles.js), each
// a groove, a bass, chords and a form, written into the same brain behind its own switches.
//
// SIREN, the brain: a rave that writes itself. A seed and a grammar make a track; the energy arc makes a set; the
// mutations make it never repeat yet stay recognisable. Integers only (the FM-1's firmware has no floating point):
// energies, knobs, chances and levels in per mille (0..1000), a seeded xorshift32, no clock, no Math.random. The C
// port (firmware/src/siren_brain.c) is this file line for line, and tests/siren_brain_test checks that both give the
// same events, step for step, for every style and many seeds.
//
// One call a sixteenth: brain.step16() -> the events of that step: notes [layer, note, velocity, length in steps],
// parameter moves [layer, 'cut', per mille] or [layer, 'wob', { rate3, shape, depth, growl }], the master's moves
// (hp, duck, gain, verb: per mille), and what the screen shows.
import { EXT_STYLES, EXT_FORMS, EXT_INTRO_W, EXT_GROOVES, extDrumPattern, extBass, extDrums, songForm, VOICES } from './styles.js';

  // ---------------------------------------------------------------------------------------------- the dice ---
  // xorshift32: one stream per purpose (its own seed: keeping a layer is keeping its stream)
  function rng(seed) {
    let s = (seed >>> 0) || 0x9E3779B9;
    return {
      next() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; },
      i(n) { return this.next() % n; },
      pick(a) { return a[this.next() % a.length]; },
      chance(pm) { return this.next() % 1000 < pm; },           // pm: per mille
    };
  }
  function hash(a, b) { let h = (a ^ Math.imul((b + 0x7F4A7C15) >>> 0, 0x85EBCA6B)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D) >>> 0; h ^= h >>> 12; h = Math.imul(h, 0x297A2D39) >>> 0; h ^= h >>> 15; return h >>> 0; }
  const div = (a, b) => Math.trunc(a / b);                       // (C's integer division: towards zero)
  const fdiv = (a, b) => Math.floor(a / b);                      // (floor: siren_brain.c fdiv)
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function code(seed) { let s = seed >>> 0, o = ''; for (let i = 0; i < 7; i++) { o = B32[s & 31] + o; s >>>= 5; } return o.slice(0, 3) + '-' + o.slice(3); }
  function uncode(c) { let s = 0; for (const ch of String(c).toUpperCase().replace(/[^0-9A-Z]/g, '')) { const v = B32.indexOf(ch); if (v >= 0) s = ((s * 32) + v) >>> 0; } return s >>> 0; }

  // ------------------------------------------------------------------------------------------- the music ---
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], harmonic: [0, 2, 3, 5, 7, 8, 11], major: [0, 2, 4, 5, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], lydian: [0, 2, 4, 6, 7, 9, 11] };
  // (0.6) the form of a track, generated (siren_brain.c SB_FORM): an intro (in two parts now and then), one to four
  // waves (a groove, a breakdown, a build: now and then a false one or a bar of silence before the drop, the drop or
  // the peak, a ride after it), the outro; each style its proportions. Lengths in bars; chances per mille. The next
  // track never takes the same order of sections as the one before.
  // (0.6) how a track begins (siren_brain.c IK_*, SB_INTRO_W): the DJ's drum intro, an atmosphere with no kick, the hook
  // alone, the groove under a low-pass that opens, the bassline before the kick, straight in, or the breakdown first
  const IK = { DRUMS: 0, ATMOS: 1, HOOK: 2, FILTER: 3, BASS: 4, DIRECT: 5, BREAK: 6 };
  const INTRO_W = { TECHNO: [500, 100, 50, 100, 200, 50, 0], TRANCE: [200, 250, 150, 100, 0, 50, 250], PSY: [330, 200, 50, 100, 250, 70, 0], ACID: [330, 50, 50, 150, 370, 50, 0],
    RAVE: [330, 100, 200, 100, 50, 150, 70], HARD: [330, 100, 100, 100, 70, 300, 0], DNB: [330, 150, 100, 100, 150, 70, 100], HOUSE: [500, 50, 200, 150, 100, 0, 0] };
  const O = (...v) => v;
  const F = (intro, intro2, groove1, midg, brks, brkl, build, drop, tail, outro, p) => ({ intro, intro2, groove1, midg, brks, brkl, build, drop, tail, outro,
    pIntro2: p[0], pGroove1: p[1], pMid: p[2], pBreak1: p[3], pBuild: p[4], pFake: p[5], pPause: p[6], pPeak: p[7], pPeakLast: p[8], pTail: p[9], cycLo: p[10], cycHi: p[11], maxBars: p[12] });   // (maxBars: about six minutes)
  const FORMS = {
    TECHNO: F(O(16, 32), O(16, 32), O(16, 32, 32), O(16, 32), O(8), O(8, 16), O(8), O(16, 32, 32), O(16, 32), O(16, 32), [300, 900, 700, 400, 350, 0, 100, 500, 500, 600, 2, 3, 200]),
    TRANCE: F(O(16, 32), O(16), O(16), O(8, 16), O(8, 16), O(16, 32, 32), O(8, 16, 16), O(16, 32), O(8, 16), O(16, 32), [600, 700, 200, 500, 1000, 150, 250, 100, 800, 300, 2, 3, 208]),
    PSY: F(O(16), O(16, 32), O(32, 48), O(16, 32), O(8), O(8, 16), O(8), O(32, 48), O(16, 32), O(8, 16), [300, 900, 600, 200, 700, 100, 200, 200, 400, 400, 2, 4, 216]),
    ACID: F(O(8, 16), O(16, 32), O(32, 48), O(16, 32), O(8), O(8, 16), O(8), O(32, 48), O(16, 32), O(8, 16), [400, 1000, 700, 500, 600, 50, 100, 200, 300, 500, 1, 3, 200]),
    RAVE: F(O(8, 16), O(8, 16), O(16), O(8, 16), O(8), O(8, 16), O(8, 16), O(16, 32), O(8, 16), O(8, 16), [300, 600, 400, 500, 900, 200, 300, 200, 600, 300, 2, 3, 200]),
    HARD: F(O(8, 16), O(8), O(16), O(8), O(8), O(8, 16), O(4, 8), O(16, 24, 32), O(8), O(8), [200, 500, 300, 600, 900, 250, 350, 200, 600, 200, 2, 4, 224]),
    DNB: F(O(16, 32, 32), O(16), O(8), O(8), O(8), O(16, 24, 32), O(8, 16), O(32, 32, 48), O(8), O(16, 32), [300, 200, 100, 300, 1000, 150, 300, 100, 400, 200, 2, 3, 256]),
    HOUSE: F(O(16, 32, 32), O(16, 32), O(32, 48, 64), O(16, 32), O(8), O(8, 16), O(8), O(32, 32, 48), O(16, 32), O(16, 32), [600, 900, 700, 700, 700, 100, 200, 200, 300, 600, 1, 3, 192]),
  };
  function form(f, r, wts) {
    const plan = [], add = (s, n) => { const l = plan[plan.length - 1]; if (l && l[0] === s) { l[1] += n; return; } if (plan.length < 40) plan.push([s, n]); };   // (the same twice: one longer)
    let ik = 0, w = r.i(1000);
    while (ik < 6 && w >= wts[ik]) w -= wts[ik++];
    plan.ik = ik;
    if (ik === IK.DIRECT) add('GROOVE', r.pick([4, 8]));                 // (straight in: a few bars, the drop)
    else if (ik === IK.BREAK) add('BREAK', r.pick(f.brkl));             // (the breakdown first)
    else {
      add('INTRO', r.pick(f.intro));
      if (r.chance(f.pIntro2)) add('GROOVE', r.pick(f.intro2));
    }
    const ncyc = f.cycLo + r.i(f.cycHi - f.cycLo + 1);
    for (let c = 0; c < ncyc; c++) {
      const last = c === ncyc - 1;
      if (!c && ik === IK.BREAK) add('BUILD', r.pick(f.build));         // (the breakdown first: its build, the drop)
      else if (!c && ik === IK.DIRECT) { /* (straight in: the drop now) */ }
      else {
        if (r.chance(c ? f.pMid : f.pGroove1)) add('GROOVE', r.pick(c ? f.midg : f.groove1));
        if (c || r.chance(f.pBreak1)) add('BREAK', r.pick(c ? f.brkl : f.brks));
        if (r.chance(f.pBuild)) {
          add('BUILD', r.pick(f.build));
          if (r.chance(f.pFake)) { const len = 4 * (1 + r.i(2)); add('BREAK', len); add('BUILD', r.pick(f.build)); }
          if (r.chance(f.pPause)) add('BREAK', 1);
        }
      }
      const sec = r.chance(last ? f.pPeakLast : f.pPeak) ? 'PEAK' : 'DROP';
      add(sec, r.pick(f.drop));
      if (!last && r.chance(f.pTail)) add('GROOVE', r.pick(f.tail));
    }
    if (r.chance(f.pTail)) add('GROOVE', r.pick(f.tail));
    add('OUTRO', r.pick(f.outro));
    return plan;
  }
  // the grammars: a style's rules (per mille where a chance or a level; tuned by ear on the prototype)
  // layers: the chance each melodic layer plays in a track, in this order (arp, hook, pad, stab, fx, piano)
  const STYLES = {
    TECHNO: { breakDrums: 1, groove: 'four', rumble: 550, kitTune: 1, sub: 0, dropBass: 0, gallop: 0, bpm: [126, 132], scales: ['minor', 'phrygian', 'dorian'], progs: [[0], [0, 0, 0, 5], [0, 3], [0, 0, 6, 0]], chordBars: 4, bass: ['rumble', 'offbeat', 'pulse'], swing: 40, layers: [350, 450, 450, 550, 1000, 0], hats: [5, 11], ride: 600, roll: 'snare', percLanes: ['rim', 'conga', 'toml', 'rim'], hatModes: ['16', 'off8', '16gap'] },   // (techno rides, hypnotic)
    TRANCE: { breakDrums: 0, groove: 'four', rumble: 0, kitTune: 1, sub: 0, dropBass: 0, gallop: 0, bpm: [136, 140], scales: ['minor', 'harmonic'], progs: [[0, 5, 2, 6], [0, 6, 5, 4], [0, 3, 5, 4], [5, 3, 0, 4], [0, 5, 3, 4]], chordBars: 2, bass: ['offbeat', 'offbeat', 'rolling'], swing: 0, layers: [950, 850, 950, 200, 1000, 0], hats: [4, 8], ride: 800, roll: 'snare', percLanes: ['shake', 'rim'], hatModes: ['16', '16gap'] },   // (the long breakdown)
    PSY: { breakDrums: 1, groove: 'four', rumble: 0, kitTune: 1, sub: 0, dropBass: 0, gallop: 0, bpm: [142, 146], scales: ['phrygian', 'harmonic'], progs: [[0], [0, 1], [0, 0, 0, 1]], chordBars: 8, bass: ['rolling'], swing: 0, layers: [600, 700, 350, 100, 1000, 0], hats: [6, 10], ride: 300, roll: 'snare', percLanes: ['shake', 'conga', 'rim'], hatModes: ['16', '16'] },
    ACID: { breakDrums: 1, groove: 'four', rumble: 150, kitTune: 0, sub: 0, dropBass: 0, gallop: 0, bpm: [128, 134], scales: ['minor', 'phrygian'], progs: [[0], [0, 0, 5, 0]], chordBars: 8, bass: ['acid'], swing: 80, layers: [200, 500, 300, 300, 1000, 0], hats: [6, 12], ride: 500, roll: 'clap', percLanes: ['bell', 'rim', 'clave'], hatModes: ['16', '16gap'] },
    RAVE: { breakDrums: 0, groove: 'breaks', rumble: 0, kitTune: 0, sub: 0, dropBass: 0, gallop: 0, bpm: [140, 150], scales: ['minor', 'harmonic'], progs: [[0, 5, 6, 4], [0, 3, 6, 5], [0, 6, 5, 6]], chordBars: 2, bass: ['reese', 'offbeat'], swing: 0, layers: [400, 600, 600, 950, 1000, 600], hats: [6, 12], ride: 400, roll: 'snare', percLanes: ['rim', 'shake'], hatModes: ['8', '16gap'] },
    HARD: { breakDrums: 1, groove: 'four', rumble: 350, kitTune: 1, sub: 0, dropBass: 0, gallop: 500, bpm: [150, 165], scales: ['harmonic', 'phrygian'], progs: [[0, 5, 6, 4], [0, 1], [0, 6, 5, 4]], chordBars: 2, bass: ['offbeat', 'pulse'], swing: 0, layers: [500, 850, 400, 500, 1000, 0], hats: [6, 12], ride: 600, roll: 'snare', percLanes: ['rim', 'toml'], hatModes: ['16', '16gap'] },
    // DRUM & BASS: the two-step, rolling basslines (reese and sub), liquid pads and bells
    DNB: { breakDrums: 0, groove: 'dnb', rumble: 0, kitTune: 1, sub: 850, dropBass: 0, gallop: 0, bpm: [170, 176], scales: ['minor', 'dorian'], progs: [[0, 5, 3, 4], [0, 3], [0, 6, 5, 4], [0, 0, 5, 6]], chordBars: 2, bass: ['roller', 'reese', 'roller'], swing: 0, layers: [500, 500, 900, 450, 1000, 0], hats: [6, 10], ride: 700, roll: 'snare', percLanes: ['rim', 'shake'], hatModes: ['8', '16gap'] },
    // HOUSE: four to the floor with swing, the clap on 2 and 4, the open hat on the offbeat, shakers and congas;
    // minor and dorian chords that move (piano, organ), a bass that bounces, a long groove then a breakdown and a drop
    HOUSE: { breakDrums: 0, groove: 'four', rumble: 0, kitTune: 1, sub: 0, dropBass: 0, gallop: 0, bpm: [122, 126], scales: ['minor', 'dorian'], progs: [[0, 3], [0, 5, 2, 6], [0, 3, 6, 4], [0, 0, 3, 3]], chordBars: 2, bass: ['offbeat', 'pulse', 'offbeat'], swing: 70, layers: [350, 800, 800, 950, 900, 0], hats: [4, 9], ride: 500, roll: 'clap', percLanes: ['shake', 'conga', 'clave'], hatModes: ['off8', '16', '16gap'] },
  };
  // (Kraken) the other styles: their grammars, forms and intros (siren/styles.js); SIREN's eight are untouched
  Object.assign(STYLES, EXT_STYLES); Object.assign(FORMS, EXT_FORMS); Object.assign(INTRO_W, EXT_INTRO_W);
  const STYLE_NAMES = Object.keys(STYLES);
  const STYLE_ORDER = ['HOUSE', 'TECHNO', 'ACID', 'TRANCE', 'PSY', 'HARD', 'RAVE', 'DNB'];   // (neighbours by tempo and family)
  // the sections of a track: their energy (per mille)
  const SEC_E = { INTRO: 250, GROOVE: 550, BUILD: 750, DROP: 1000, BREAK: 300, PEAK: 920, OUTRO: 320 };
  // the drum kit's lanes (GM notes: kick, kick2, snare, clap, hat, open, pedal, rim, snr 2, tom l, tom h, crash, ride, shake, conga, bell, clave)
  const D = { kick: 36, kick2: 35, snare: 38, clap: 39, hat: 42, open: 46, pedal: 44, rim: 37, snare2: 40, toml: 43, tomh: 48, crash: 49, ride: 51, shake: 70, conga: 63, bell: 56, clave: 75 };
  const fold = (n, top) => { while (n > top) n -= 12; return n; };   // (0.2) a melodic note an octave down while over top
  const LAYERS = ['DRUMS', 'BASS', 'ARP', 'HOOK', 'PAD', 'STAB', 'FX'];
  const LAYERS_ALL = ['DRUMS', 'BASS', 'SUB', 'ARP', 'HOOK', 'PAD', 'STAB', 'FX'];
  const SOUND_LAYERS = ['BASS', 'ARP', 'HOOK', 'PAD', 'STAB', 'FX'];
  const LAYER_KEYS = ['arp', 'hook', 'pad', 'stab', 'fx', 'piano'];
  const ARP_ORDERS = ['up', 'down', 'updown', 'random', 'up2'];
  const SHAPE_NAMES = ['sine', 'saw', 'square', 'tri'];

  function euclid(k, n, rot, i) { return (((i + n - (rot % n)) * k) % n) < k; }   // (is step i on, in k of n rotated)
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const has = (a, x) => a.indexOf(x) >= 0;

  // ------------------------------------------------------------------------------------------ the brain ---
  function Brain() {
    this.seed = 0x51A3; this.style = 'TRANCE'; this.styleLock = false;
    this.knobs = { energy: 500, density: 500, tension: 500, mutation: 350 };   // (per mille)
    this.locks = {}; this.rerolls = {};
    this.trackNo = 0; this.bar = 0; this.step = 0; this.phraseBar = 0;
    this.palette = null;                              // { CUR: { style: { layer: [sound] } }, DKITS: { style: [kit] } }
    this.dive = 0; this.breakReq = false;
    this.dropReq = false; this.stay = false; this.keyReq = false; this.motifOnly = null; this.motifVer = {};   // (0.5) the hands
    this.newTrack(this.seed, this.style, null);
  }
  Brain.prototype.setPalette = function (p) { this.palette = p; this.pickSounds(); };

  // a new track: its key, tempo, grammar, arrangement, sounds and patterns, all from its seed
  Brain.prototype.newTrack = function (seed, style, prev) {
    const st = STYLES[style] || STYLES.TRANCE;
    this.seed = seed >>> 0; this.style = STYLES[style] ? style : 'TRANCE'; this.g = st;
    const r = rng(hash(this.seed, 1));
    this.scaleName = r.pick(st.scales); this.scale = SCALES[this.scaleName];
    // the key: the last track's, or a neighbour of it (a fifth up or down, the relative), as a DJ mixes in key
    this.key = prev ? (prev.key + r.pick([0, 0, 7, 5, 3, 9])) % 12 : r.i(12);
    const lo = st.bpm[0], hi = st.bpm[1];
    this.bpmTarget = prev ? clamp(prev.bpm + r.i(5) - 2, lo, hi) : lo + r.i(hi - lo + 1);
    this.bpm = prev && Math.abs(prev.bpm - this.bpmTarget) <= 12 ? prev.bpm : this.bpmTarget;   // (far apart, as drum & bass and dubstep: the new tempo at once, as a DJ would cut)
    this.prog = r.pick(st.progs); this.chordBars = st.chordBars;
    this.kitPick = r.next(); this.swing = st.swing;
    this.bassKind = r.pick(st.bass);
    // the arrangement (0.6): its form, from its own stream; never the order of sections the last track had
    {
      const pr = rng(hash(this.seed, 7)), was = prev && this.plan ? this.plan.map((x) => x[0]).join() : null;
      let plan = null;
      for (let t = 0; t < 5; t++) { plan = st.song ? songForm(st.song, pr, INTRO_W[this.style], IK) : form(FORMS[this.style], pr, INTRO_W[this.style]); if (was === null || plan.map((x) => x[0]).join() !== was) break; }
      // too long for the style: the longest of its long sections 8 bars shorter, until it fits
      let bars = plan.reduce((a, x) => a + x[1], 0);
      while (bars > (st.song ? st.song.maxBars : FORMS[this.style].maxBars)) {
        let k = -1;
        for (let i = 0; i < plan.length; i++) if (plan[i][0] !== 'BUILD' && plan[i][0] !== 'BREAK' && plan[i][1] > 16 && (k < 0 || plan[i][1] > plan[k][1])) k = i;
        if (k < 0) break;
        plan[k][1] -= 8; bars -= 8;
      }
      this.plan = plan; this.introKind = plan.ik;
    }
    this.planAt = 0; this.secBar = 0; this.phraseBar = 0;
    this.layerOn = {}; LAYER_KEYS.forEach((k, i) => { this.layerOn[k] = r.chance(st.layers[i]); });
    if (!this.layerOn.hook && !this.layerOn.arp) this.layerOn.hook = true;   // (a track always sings something)
    this.motifs(); this.pickSounds();
    this.trackStartBar = this.bar;
    this.label = `${this.style} · ${code(this.seed)}`;
  };

  // the sounds of this track: a pick for each layer from the style's selection (the kept ones), by its own stream
  Brain.prototype.pickSounds = function () {
    const p = this.palette; if (!p) return;
    const st = this.g, sounds = this.sounds || {}, idx = this.soundIdx || {};
    for (const L of SOUND_LAYERS) {
      if (this.locks[L] && sounds[L]) continue;
      const r = rng(hash(this.seed, 100 + LAYERS.indexOf(L) * 7 + (this.rerolls[L] || 0) * 131));
      const pool = (p.CUR && p.CUR[this.style] && p.CUR[this.style][L]) || [];
      if (pool.length) { const i = r.i(pool.length); sounds[L] = pool[i]; idx[L] = i; }
    }
    // the drums: one of the style's own kits, its kick (and boom) tuned to the key, and the style's drum mix
    const kits = (p.DKITS && p.DKITS[this.style]) || [], ki = kits.length ? this.kitPick % kits.length : 0, K = kits[ki];
    const tuned = (n16) => {                         // (the nearest root or fifth of the key: never more than 3 semitones away)
      if (!st.kitTune || !n16) return n16; let best = n16, bd = 1 << 30;
      for (const pc of [this.key, this.key + 7]) for (let t = pc % 12; t < 128; t += 12) if (Math.abs(t * 16 - n16) < bd) { bd = Math.abs(t * 16 - n16); best = t * 16; }
      return best; };
    sounds.DRUMS = { kit: K ? K.name : '-', kitData: K, kickN16: K ? tuned(K.kickN16) : 0, kick2N16: K ? tuned(K.kick2N16) : 0, rumble: st.rumble, name: K ? K.name : '-' };
    idx.DRUMS = ki;
    this.kit = sounds.DRUMS.kit;
    // dubstep: the bass changes its sound inside a drop (two or three of the style's basses, switched every few bars)
    this.bassAlt = null;
    if (st.dropBass && !this.locks.BASS) {
      const r2 = rng(hash(this.seed, 177 + (this.rerolls.BASS || 0) * 131)), cur = (p.CUR && p.CUR[this.style] && p.CUR[this.style].BASS) || [];
      if (cur.length) { const a = r2.i(cur.length), b = r2.i(cur.length); this.bassAlt = [idx.BASS, a, b]; this.bassAltS = [sounds.BASS, cur[a], cur[b]]; }
    }
    this.sounds = sounds; this.soundIdx = idx; this.soundsChanged = true;
  };

  // the motifs: each layer's pattern, from its own stream (a locked layer keeps its own)
  Brain.prototype.motifs = function () {
    const k = this.knobs, st = this.g;
    const R = (L) => rng(hash(this.seed, 1000 + LAYERS.indexOf(L) * 17 + (this.rerolls[L] || 0) * 977 + (this.motifVer[L] || 0) * 313));
    const keep = (L) => (this.locks[L] || (this.motifOnly && this.motifOnly !== L)) && this.pat && this.pat[L];
    const pat = this.pat || {};
    const G = st.groove;
    // drums: hats, percussion as euclidean rhythms, rotated; the breaks' kicks and ghosts
    if (!keep('DRUMS')) {
      const r = R('DRUMS');
      const P = {};
      P.hatK = st.hats[0] + r.i(st.hats[1] - st.hats[0] + 1); P.hatRot = r.i(4); P.percK = 3 + r.i(4); P.percRot = r.i(16);
      P.percLane = r.pick(st.percLanes); P.clapGroove = r.chance(600); P.ride = r.chance(st.ride);
      P.hatMode = r.pick(st.hatModes); P.gallop = r.chance(st.gallop);
      P.breakK = r.pick(G === 'dnb' ? [[0, 10], [0, 10], [0, 7, 10], [0, 6, 10], [0, 10, 13]] : G === 'half' ? [[0], [0, 10], [0, 6], [0, 11, 14], [0, 3, 10], [0, 7]] : [[0, 10], [0, 6, 10], [0, 2, 10], [0, 10, 11], [0, 3, 6, 10]]);
      P.ghost = r.pick(G === 'half' ? [[], [15], [6, 14], [14]] : [[7, 9, 15], [7, 15], [9, 14], [3, 7, 11, 15], [7, 9]]);
      P.four = r.chance(500);
      if (EXT_GROOVES.has(G)) P.x = extDrumPattern(G, r, st);   // (Kraken: its own grooves, drawn after SIREN's)
      pat.DRUMS = P;
    }
    // bass: a bar (or two) of steps { d: degree, o: octave, len, v, slide, wob }
    if (!keep('BASS')) {
      const r = R('BASS'), kind = this.bassKind, two = kind === 'wobble' || kind === 'riddim' || kind === 'growl';
      const s = []; for (let i = 0; i < (two ? 32 : 16); i++) s.push(null);
      const S = (d, o, len, v) => ({ d, o, len, v, slide: 0, wob: null });
      if (kind === 'offbeat') for (const i of [2, 6, 10, 14]) s[i] = S(0, 0, 1, 100);
      else if (kind === 'rolling') for (let i = 0; i < 16; i++) { if (i % 4) s[i] = S((i % 4 === 3 && r.chance(250)) ? 4 : 0, 0, 1, i % 4 === 1 ? 110 : 90); }
      else if (kind === 'rumble') for (const i of [2, 6, 10, 14]) s[i] = S(0, 0, 2, 90);
      else if (kind === 'pulse') for (let i = 0; i < 16; i += 2) { if (i % 4) s[i] = S(0, 0, 1, 95); }
      else if (kind === 'reese') { s[0] = S(0, 0, 8, 100); s[8] = S(0, 0, 6, 95); s[14] = S(r.pick([4, 6, 2]), 0, 2, 90); }
      else if (kind === 'roller') {                    // drum & bass: a syncopated rolling line, the root and its octave
        const hits = r.pick([[0, 3, 6, 10, 14], [0, 6, 10, 11, 14], [0, 3, 7, 10], [0, 2, 6, 10, 13]]);
        for (const i of hits) {
          const d = r.chance(750) ? 0 : r.pick([4, 6, 7]), o = r.chance(200) ? 1 : 0, len = r.pick([1, 2, 2, 3]);
          s[i] = S(d, o, len, i === 0 ? 112 : 96); s[i].wob = { rate3: r.pick([48, 96, 24]), shape: 0, depth: 350, growl: 0 };
        }
      }
      else if (two) {                                  // dubstep: a 2-bar riff of hits, each its own wobble rate (in thirds of a sixteenth)
        const rates = kind === 'riddim' ? [4, 8, 2, 4] : [12, 6, 4, 3, 24, 2, 6];
        const shapes = kind === 'riddim' ? [2, 1, 2] : [0, 1, 2, 3, 0];
        const degs = this.scaleName === 'phrygian' ? [0, 0, 0, 0, 1, 4, 6, 7] : [0, 0, 0, 0, 4, 5, 6, 7];
        const W = (lo, span, gch, gval) => ({ rate3: r.pick(rates), shape: r.pick(shapes), depth: lo + r.i(span + 1), growl: kind === 'growl' ? 1000 : r.chance(gch) ? gval : 0 });
        let i = 0;
        while (i < 16) {
          const len = kind === 'riddim' ? r.pick([2, 3, 3]) : r.pick([2, 3, 4, 4, 6, 8]);
          const gap = kind === 'riddim' ? r.pick([1, 1, 2, 3]) : r.pick([0, 0, 1, 2]);
          const d = i === 0 ? 0 : r.pick(degs);
          s[i] = S(d === 7 ? 0 : d, d === 7 ? 1 : 0, Math.min(len, 16 - i), 115); s[i].wob = W(600, 400, 300, 600);
          i += len + gap;
        }
        for (let j = 0; j < 16; j++) s[16 + j] = s[j] && { ...s[j], wob: { ...s[j].wob } };   // the answer: bar 2 repeats bar 1, its end changed
        for (let j = 24; j < 32; j++) s[j] = null;
        for (let j = 24; j < 32;) {
          const len = r.pick([1, 2, 2, 3, 4]);
          if (r.chance(750)) { const d = r.pick(degs) % 7, o = r.chance(300) ? 1 : 0; s[j] = S(d, o, Math.min(len, 32 - j), 120); s[j].wob = W(700, 300, 500, 700); }
          j += len + (r.chance(400) ? 1 : 0);
        }
      }
      else if (kind === 'acid') for (let i = 0; i < 16; i++) {
        if (r.chance(700)) { const d = r.pick([0, 0, 0, 2, 4, 6, 7]), o = r.chance(250) ? 1 : 0, len = r.chance(250) ? 2 : 1, v = r.chance(300) ? 127 : 90; s[i] = S(d, o, len, v); s[i].slide = r.chance(200) ? 1 : 0; }
      }
      else { const x = extBass(kind, r, pat.DRUMS); s.length = x.length; for (let i = 0; i < x.length; i++) s[i] = x[i]; }   // (Kraken's basses)
      pat.BASS = s;
    }
    // the hook: a one- or two-bar motif, its rhythm from a template, its notes walking the scale, chord tones on the beats
    if (!keep('HOOK')) {
      const r = R('HOOK'), len = r.chance(500) ? 32 : 16, s = [];
      const dens = st.hookDens != null ? st.hookDens : 350 + div(350 * k.density, 1000);
      let d = r.pick([0, 2, 4, 7]);
      for (let i = 0; i < len; i++) {
        const strong = i % 4 === 0, on = strong ? r.chance(800) : r.chance(i % 2 ? div(dens * 7, 10) : dens);
        if (!on) { s.push(null); continue; }
        d += r.pick([-2, -1, -1, 0, 1, 1, 2, 3, -3]);
        if (d < -2) d += 4;
        if (d > 9) d -= 5;
        if (strong) { let b = 0; for (const c of [0, 2, 4, 7]) if (Math.abs(c - d) < Math.abs(b - d)) b = c; d = b; }
        s.push({ d, o: 1, len: r.chance(300) ? 2 : 1, v: strong ? 112 : 92 });
      }
      pat.HOOK = s; pat.HOOK_THEME = s.slice();
    }
    // the arp: the chord's notes in an order, at a rate, over octaves
    if (!keep('ARP')) { const r = R('ARP'); pat.ARP = { order: r.i(5), rate: r.pick([1, 1, 1, 2]), oct: 1 + r.i(2), gate: r.pick([0, 0, 1]), skip: r.chance(300) ? r.i(16) : -1, seed: r.next() }; }
    // the stabs: chords on an off-grid rhythm
    if (!keep('STAB')) {
      const r = R('STAB'); const kk = 3 + r.i(3), rot = r.i(16); pat.STAB = []; for (let i = 0; i < 16; i++) pat.STAB.push(euclid(kk, 16, rot, i) && i % 4 !== 0 ? 110 : 0);
      if (st.comp) { const c = r.pick(st.comp); pat.STAB = Array(16).fill(0); pat.STAB_LEN = Array(16).fill(1); for (const [i, len, v] of c) { pat.STAB[i] = v || (i % 4 ? 92 : 106); pat.STAB_LEN[i] = len; } }
    }
    if (!keep('PAD')) { const r = R('PAD'); const inv = r.i(3); pat.PAD = { inv, add9: r.chance(400) }; if (st.pad7) pat.PAD.add7 = r.chance(st.pad7); }
    this.pat = pat;
  };

  // a phrase ends: the motifs develop (a little, as MUTATION says), and the theme comes back now and then
  Brain.prototype.mutate = function () {
    const p = this.pat, m = this.knobs.mutation, r = rng(hash(this.seed, 7000 + this.bar));
    if (!this.locks.HOOK && r.chance(m)) {
      const s = p.HOOK, n = s.length;
      if (r.chance(180)) p.HOOK = p.HOOK_THEME.slice();                        // the theme again
      else {
        const op = r.i(6), i = r.i(n);
        if (op === 0) { const t = s[n - 1]; for (let j = n - 1; j > 0; j--) s[j] = s[j - 1]; s[0] = t; }        // rotate
        else if (op === 1 && s[i]) s[i] = { ...s[i], d: s[i].d + r.pick([-1, 1, 2, -2]) };                     // a note moves
        else if (op === 2 && !s[i] && i % 2 === 0) s[i] = { d: r.pick([0, 2, 4]), o: 1, len: 1, v: 90 };     // a note more
        else if (op === 3 && s[i] && i % 4) s[i] = null;                                                       // a note less
        else if (op === 4 && s[i]) s[i] = { ...s[i], o: s[i].o ? 0 : 1 };                                      // an octave
        else if (op === 5) { const j = r.i(n); const t = s[i]; s[i] = s[j]; s[j] = t; }                        // two swap
      }
    }
    if (!this.locks.DRUMS && r.chance(div(m * 7, 10))) { const d = p.DRUMS; if (r.chance(500)) d.percRot = (d.percRot + 1 + r.i(3)) % 16; else d.percK = clamp(d.percK + r.pick([-1, 1]), 2, 9); }
    if (!this.locks.BASS && this.bassKind === 'acid' && r.chance(m)) {
      const s = p.BASS, i = r.i(16);
      if (s[i]) { if (r.chance(500)) s[i] = null; else s[i] = { ...s[i], slide: s[i].slide ? 0 : 1, v: s[i].v > 100 ? 90 : 127 }; }
      else { const d = r.pick([0, 0, 2, 4, 7]), o = r.chance(300) ? 1 : 0; s[i] = { d, o, len: 1, v: 100, slide: 0, wob: null }; }
    }
    if (!this.locks.ARP && r.chance(div(m, 2))) p.ARP.order = r.i(5);
  };

  // where we are in the track: its section, and the energy the arc asks for there (per mille)
  Brain.prototype.section = function () { return this.plan[this.planAt][0]; };
  Brain.prototype.arcEnergy = function () {
    const sec = this.section(), len = this.plan[this.planAt][1];
    return sec === 'BUILD' ? 550 + div(450 * (this.secBar * 16 + this.step), len * 16) : SEC_E[sec];   // (a build climbs to the drop)
  };
  Brain.prototype.energy = function () { return clamp(this.arcEnergy() + div((this.knobs.energy - 500) * 7, 10), 0, 1000); };

  // a bar ends: every 8 bars the motifs develop; DIVE and BREAK change the plan at once (on the next bar, so the
  // hands are obeyed within two seconds); a section ends, the next begins; at the plan's end the next track is born
  Brain.prototype.nextBar = function () {
    this.secBar++; this.phraseBar++;
    if (this.phraseBar === 8) { this.phraseBar = 0; this.mutate(); }
    const enter = () => { this.planAt++; this.secBar = 0; this.phraseBar = 0; if (this.planAt >= this.plan.length) this.nextTrack(); };   // (past the plan's end: the next track)
    const ins = (at, sec, len) => {                   // (0.5: full, the hands asking again and again) the last gives way
      if (this.plan.length >= 40) { if (this.plan.length - 1 <= at) return; this.plan.pop(); }
      this.plan.splice(at, 0, [sec, len]);
    };
    const keyUp = () => {                             // (0.5) KEY UP asked: a tone up as a drop begins
      if (this.keyReq && this.planAt < this.plan.length && this.plan[this.planAt][0] === 'DROP' && this.secBar === 0) {
        this.keyReq = false; this.key = (this.key + 2) % 12; this.pickSounds();
      }
    };
    if (this.dropReq) {                               // (0.5) DROP: from this bar
      this.dropReq = false; this.dive = 0;
      if (this.plan[this.planAt][0] !== 'DROP') { ins(this.planAt + 1, 'DROP', 32); enter(); keyUp(); return; }
    }
    if (this.dive) {                                  // DIVE: a build of that many bars now, then the drop
      const cur = this.plan[this.planAt], next = this.plan[this.planAt + 1];
      if (cur[0] === 'BUILD') {                       // (already climbing: this build ends at most that far, the drop follows)
        cur[1] = Math.max(this.secBar + 1, Math.min(cur[1], this.secBar + this.dive));
        if (!next || next[0] !== 'DROP') ins(this.planAt + 1, 'DROP', 32);
        this.dive = 0;
      } else { ins(this.planAt + 1, 'BUILD', this.dive); ins(this.planAt + 2, 'DROP', 32); this.dive = 0; enter(); return; }
    }
    if (this.breakReq) { this.breakReq = false; ins(this.planAt + 1, 'BREAK', 8); enter(); return; }
    if (this.secBar >= this.plan[this.planAt][1]) {
      if (this.stay && this.plan[this.planAt][0] !== 'BUILD') { const len = this.plan[this.planAt][1]; this.secBar = len >= 8 ? len - 8 : 0; }   // (0.5) STAY
      else enter();
    }
    keyUp();
    if (this.planAt >= this.plan.length) this.nextTrack();
  };
  Brain.prototype.nextTrack = function () {
    {                                                 // the track ends: the next one, born of this one
      const prev = { key: this.key, bpm: this.bpm }, n = ++this.trackNo;
      let style = this.style;
      if (!this.styleLock && rng(hash(this.seed, 31)).chance(250)) {   // now and then a neighbouring style
        const i = STYLE_ORDER.indexOf(style);
        style = STYLE_ORDER[clamp(i + (rng(hash(this.seed, 33)).chance(500) ? 1 : -1), 0, STYLE_ORDER.length - 1)];
      }
      this.newTrack(hash(this.seed, n), style, prev);
    }
  };

  // ---------------------------------------------------------------------------------------- one sixteenth ---
  Brain.prototype.step16 = function () {
    const ev = { notes: [], params: [], master: {}, info: null };
    const st = this.g, k = this.knobs, p = this.pat;
    let sec = this.section(), e = this.energy();
    // (0.6) the intro as its kind plays it: its first half its own opening, then the drums come in; the filtered one is
    // the drop itself, under a low-pass that opens across the intro
    const secReal = sec, ik = sec === 'INTRO' ? this.introKind : IK.DRUMS, first0 = ik !== IK.DRUMS && 2 * this.secBar < this.plan[this.planAt][1];
    const quiet = first0 && (ik === IK.ATMOS || ik === IK.HOOK) ? 2 : first0 && ik === IK.BASS ? 1 : 0;
    if (ik === IK.FILTER) { sec = 'DROP'; e = clamp(SEC_E.DROP + div((k.energy - 500) * 7, 10), 0, 1000); }
    const step = this.step, bar = this.bar, barInPhrase = this.phraseBar;
    const secLen = this.plan[this.planAt][1], barInSec = this.secBar;
    const lastBarOfBuild = sec === 'BUILD' && barInSec === secLen - 1;
    const r = rng(hash(this.seed, bar * 16 + step + 99991));
    // tempo glides to the track's, a BPM a bar
    if (step === 0 && this.bpm !== this.bpmTarget) this.bpm += this.bpmTarget > this.bpm ? 1 : -1;
    const chord = this.prog[div(bar - this.trackStartBar, this.chordBars) % this.prog.length];
    const note = (deg, oct, base) => { const n = deg + chord, o = fdiv(n, 7), d = ((n % 7) + 7) % 7; return base + this.key + 12 * (o + oct) + this.scale[d]; };
    const add = (L, n, v, len, off) => ev.notes.push(off ? [L, n, clamp(v, 1, 127), len || 1, off] : [L, n, clamp(v, 1, 127), len || 1]);   // (off: Kraken's, in sixths of a sixteenth)
    const dens = k.density;

    // ---- drums: the style's groove (four on the floor, breakbeats, the two-step, half time)
    const DP = p.DRUMS, drum = (lane, v, off) => { if (!(quiet === 2 || (quiet === 1 && (lane === 'kick' || lane === 'kick2' || lane === 'clap' || lane === 'snare')))) add('DRUMS', D[lane], v, 1, off); }, G = st.groove;
    const brk = sec === 'BREAK', live = sec === 'DROP' || sec === 'PEAK', intro0 = sec === 'INTRO' && barInSec < 2 && this.trackNo === 0;
    const kickOn = !brk && !(lastBarOfBuild && step >= 8) && !(sec === 'BUILD' && G !== 'four' && barInSec >= secLen - 2 && step >= 8);
    const brkD = !brk || st.breakDrums;               // (techno, psy, acid and hard keep their hats and percussion through a break)
    const half = G === 'half', bb = half ? step === 8 : step === 4 || step === 12;
    if (!EXT_GROOVES.has(G)) {                       // (SIREN's grooves, as they are)
      // the kick
      if (kickOn) {
        if (G === 'four') {
          if (step % 4 === 0 && !(intro0 && step % 8)) drum('kick', 120);
          if (DP.gallop && live && step === 14 && barInPhrase % 2 === 1) drum('kick', 105);              // (hard: the gallop)
        } else if (sec === 'BUILD') { if (step % (2 * barInSec < secLen ? 8 : 4) === 0) drum('kick', 110); }   // (a build: the kick counts in)
        else {
          if (has(DP.breakK, step) && !(intro0 && step)) drum('kick', step ? 108 : 122);
          if (G === 'breaks' && DP.four && live && step % 4 === 0 && !has(DP.breakK, step)) drum('kick2', 100);   // (hardcore: 4/4 under the break)
        }
      }
      if (live && step === 0 && (barInSec === 0 || (barInPhrase === 0 && r.chance(500)))) drum('crash', barInSec === 0 ? 118 : 95);
      // the backbeat: the clap (four), the snare (breaks, two-step, half time), its ghosts
      const bbOn = sec !== 'BUILD' && !(sec === 'INTRO' && barInSec < 4) && !brk;
      if (G === 'four') {
        if (bbOn && e > 330 && bb && (sec !== 'GROOVE' || DP.clapGroove || this.style !== 'TECHNO') && !(this.style === 'PSY' && !live && sec !== 'GROOVE')) drum('clap', 108);
        if (bbOn && this.style === 'HARD' && live && bb) drum('snare', 96);
        if (bbOn && this.style === 'ACID' && e > 500 && (step === 7 || step === 15) && r.chance(500)) drum('snare', 52);
      } else if (bbOn && e > 300) {
        if (bb) { drum('snare', 120); if (half || live) drum('clap', half ? 115 : 90); }
        if (has(DP.ghost, step) && r.chance(500 + div(400 * dens, 1000))) drum('snare2', 45 + div(20 * e, 1000));
      }
      // the hats: closed (sixteenths, eighths, or gaps), the open one on the offbeat, choked by it
      const offbeat = step % 4 === 2;
      const ohOn = brkD && e > 450 && !brk && (G === 'four' || (G !== 'half' && live && step === 14) || (half && live && (step === 6 || step === 14) && DP.four));
      if (ohOn && (G !== 'four' || offbeat)) drum('open', (G === 'four' ? 92 : 80) + div(20 * e, 1000));
      if (e > 200 && brkD && !(ohOn && G === 'four' && offbeat)) {
        const m = DP.hatMode, acc = offbeat ? 1000 : step % 2 === 0 ? 820 : 620;
        let hit = m === '16' ? true : m === 'off8' ? offbeat : m === '8' ? step % 2 === 0 : euclid(div(DP.hatK * (600000 + 800 * dens) + 500000, 1000000), 16, DP.hatRot, step);
        if (G !== 'four' && step % 2 === 1 && e > 600 && !hit) hit = r.chance(div(350 * dens, 1000));
        if (hit && (m !== '16' || dens > 200 || step % 2 === 0)) { let v = 58 + div(46 * acc * (600 + div(400 * e, 1000)), 1000000); if (brk) v = div(v * 8, 10); drum('hat', v); }
      }
      // the ride in the drops, the percussion (euclidean, rotated), psy's ticks
      if (DP.ride && live && (G === 'dnb' ? step % 2 === 0 : half ? step % 4 === 0 : offbeat)) drum('ride', G === 'dnb' ? 62 + (step % 4 ? 0 : 14) : 72);
      if ((e > 550 || (brk && st.breakDrums)) && brkD && euclid(DP.percK, 16, DP.percRot, step) && r.chance(600 + div(400 * dens, 1000))) drum(DP.percLane, 78 + div(30 * e, 1000));
      if (this.style === 'PSY' && e > 600 && !brk && step % 2 === 1 && r.chance(300 + div(500 * dens, 1000))) drum('shake', 50 + div(20 * e, 1000));
      // the fill: the last beat of a phrase, now and then, the style's own
      if ((sec === 'GROOVE' || live) && barInPhrase === 7 && step >= 12 && rng(hash(this.seed, bar * 3 + 5)).chance(350 + div(400 * dens, 1000))) {
        const F = rng(hash(this.seed, bar)).i(3);
        if (this.style === 'PSY') drum(step % 2 ? 'tomh' : 'toml', 90 + 6 * (step - 12));                                   // (zaps)
        else if (G === 'dnb' || G === 'breaks') drum(step === 15 ? 'snare' : 'snare2', 80 + 10 * (step - 12));              // (a rush)
        else if (half) { if (step !== 13) drum(F ? 'snare' : 'tomh', 90 + 8 * (step - 12)); }
        else drum(F === 0 ? 'snare' : F === 1 ? (step < 14 ? 'tomh' : 'toml') : 'clap', 80 + 8 * (step - 12));
      }
      if (sec === 'BUILD' && !(half && lastBarOfBuild && step >= 8)) {   // the roll: quarters, eighths, sixteenths, then more (dubstep: the last half bar is silence)
        const every = 4 * barInSec < secLen ? 4 : 2 * barInSec < secLen ? 2 : 1;
        if (step % every === 0) drum(st.roll, 60 + div(60 * barInSec, secLen));
        if (4 * barInSec >= 3 * secLen && step % 2 === 1) drum(st.roll, 70 + div(50 * barInSec, secLen));
      }
    } else extDrums({ DP, drum, st, G, sec, step, bar, barInSec, secLen, barInPhrase, e, dens, r, brk, live, intro0, lastBarOfBuild, ik, IK, add, seed: this.seed, hash, rng, trackNo: this.trackNo });   // (Kraken's)
    // ---- bass (ducked by the kick); dubstep's and drum & bass's carry their wobble, and a sub under them
    const bassOn = !brk && (sec !== 'INTRO' || ik === IK.BASS) && !lastBarOfBuild && !(sec === 'BUILD' && st.sub && barInSec < secLen - 2 && this.bassKind !== 'roller');
    if (this.bassAlt && live && step === 0 && barInSec % 4 === 0) {   // (dubstep: the switch-up)
      const a = div(barInSec, 4) % 3;
      if (this.bassAlt[a] !== this.soundIdx.BASS) { this.soundIdx.BASS = this.bassAlt[a]; this.sounds.BASS = this.bassAltS[a]; this.soundsChanged = true; }
    }
    if (bassOn && (e > 300 || ik === IK.BASS)) {
      const B = p.BASS, b = B[(B.length > 16 ? (bar % 2) * 16 : 0) + step];
      if (b && !(sec === 'BUILD' && this.bassAlt)) {
        add('BASS', note(b.d, b.o, st.bassBase || 36), b.v, b.slide ? b.len + 1 : b.len);
        if (b.wob) ev.params.push(['BASS', 'wob', b.wob]);
        if (st.sub) { let sn = note(b.d, 0, 24); while (sn > 40) sn -= 12; while (sn < 28) sn += 12; add('SUB', sn, div(110 * st.sub, 1000), b.len); }
      }
    }
    // ---- arp
    const bassDrop = st.dropBass && live;             // (dubstep: the drop belongs to the bass)
    if (!bassDrop && this.layerOn.arp && (e > 550 || (brk && st.layers[0] > 900)) && sec !== 'INTRO') {
      const A = p.ARP;
      if (step % A.rate === 0 && step !== A.skip) {
        const tones = [0, 2, 4, 7], i = div(step, A.rate), span = 4 * A.oct;
        let j = i % span;
        if (A.order === 1) j = span - 1 - j;
        else if (A.order === 2) { const q = i % (2 * span - 2); j = q < span ? q : 2 * span - 2 - q; }
        else if (A.order === 3) j = rng(hash(A.seed, bar * 16 + step)).i(span);
        else if (A.order === 4) j = (i * 2) % span;
        add('ARP', fold(note(tones[j % 4], (A.oct === 2 ? 0 : 1) + div(j, 4), 48), 72), 80 + div(30 * e, 1000), A.gate ? A.rate : 1);   // (0.2: no higher than C5)
      }
    }
    // ---- the hook: in the drops, the peak, the break (alone, the theme), late grooves
    if ((!bassDrop && this.layerOn.hook && (live || brk || (sec === 'GROOVE' && barInSec >= 4 && e > 500))) || ik === IK.HOOK) {
      const H = p.HOOK, s = H[(barInPhrase * 16 + step) % H.length];
      if (s) add('HOOK', fold(note(s.d, s.o, 48), 74), div(s.v * (750 + div(250 * e, 1000)), 1000), s.len);
    }
    // ---- the pad: the chord, held (a break, an intro, an outro always have it)
    if ((!bassDrop && this.layerOn.pad && sec !== 'BUILD' && (e < 800 || st.layers[2] > 900)) || brk || sec === 'INTRO' || sec === 'OUTRO') {
      if (step === 0 && (bar - this.trackStartBar) % this.chordBars === 0) {
        const len = 16 * this.chordBars - 1, P = p.PAD;
        for (const d of P.add7 ? (P.add9 ? [0, 2, 4, 6, 8] : [0, 2, 4, 6]) : P.add9 ? [0, 2, 4, 8] : [0, 2, 4]) add('PAD', note(d + (P.inv === 1 && d === 0 ? 7 : 0), 0, 48), 70 + div(20 * e, 1000), len);
      }
    }
    // ---- stabs: the drops and peaks
    if (!bassDrop && this.layerOn.stab && (live || (st.compAlso && (sec === 'GROOVE' || sec === 'BUILD') && !lastBarOfBuild)) && p.STAB[step]) {
      if (!st.comp) for (const d of [0, 2, 4]) add('STAB', note(d, 0, 60), 100, 1);
      else for (const d of VOICES[st.compVoice || 'triad']) add('STAB', note(d, 0, st.compBase || 60), div(p.STAB[step] * (800 + div(200 * e, 1000)), 1000), p.STAB_LEN[step]);
    }
    // ---- fx: the riser through the build
    if (sec === 'BUILD' && barInSec === 0 && step === 0) add('FX', 60 + this.key, 110, secLen * 16 - 1);
    if (ik === IK.ATMOS && barInSec === 0 && step === 0) add('FX', 60 + this.key, 96, secLen * 8 - 1);   // (0.6: the atmosphere's swell)
    // ---- what the engines' filters, the master and the duck do (per mille)
    const t = sec === 'BUILD' ? div((barInSec * 16 + step) * 1000, secLen * 16) : ik === IK.ATMOS && first0 ? div((barInSec * 16 + step) * 1000, secLen * 8) : 0;
    if (!st.sub) ev.params.push(['BASS', 'cut', 350 + div(500 * e, 1000)]);
    ev.params.push(['ARP', 'cut', 300 + div(600 * e, 1000)], ['HOOK', 'cut', 450 + div(500 * e, 1000)], ['PAD', 'cut', 250 + div(500 * e * (1000 - div(k.tension, 2)), 1000000)], ['FX', 'cut', 100 + div(850 * t, 1000)]);
    ev.master.hp = sec === 'BUILD' ? Math.max(0, div((t - 500) * 16, 10)) : 0;     // the high-pass sweep at the end of a build
    ev.master.duck = 550 + div(350 * e, 1000);
    ev.master.gain = brk ? 580 : 600 + div(400 * Math.min(1000, div(e * 1000, 900)), 1000);   // a break breathes lower, a drop hits
    ev.master.verb = brk ? 600 : sec === 'BUILD' ? 350 + div(400 * t, 1000) : 250;
    ev.master.lp = ik === IK.FILTER ? 850 - div(850 * (barInSec * 16 + step), secLen * 16) : 0;   // (0.6: the filtered intro opening)
    ev.info = { bar, step, sec: secReal, e, bpm: this.bpm, label: this.label, track: this.trackNo, chord, key: this.key, scale: this.scaleName, kit: this.kit, secBar: barInSec, secLen, plan: this.plan.map((x) => x[0]), planLen: this.plan.map((x) => x[1]), planAt: this.planAt };
    // the clock
    this.step++;
    if (this.step === 16) { this.step = 0; this.bar++; this.nextBar(); }
    return ev;
  };

  // ---------------------------------------------------------------------------------------------- controls ---
  Brain.prototype.setSeed = function (c, style) { this.trackNo = 0; this.newTrack(typeof c === 'number' ? c : uncode(c), style || this.style, null); };
  Brain.prototype.reroll = function (L) { this.rerolls[L] = (this.rerolls[L] || 0) + 1; this.locks[L] = false; this.motifs(); this.pickSounds(); };
  Brain.prototype.lock = function (L, on) { this.locks[L] = !!on; };
  Brain.prototype.remotif = function (L, d) { this.motifVer[L] = ((this.motifVer[L] || 0) + d) & 255; this.motifOnly = L; this.motifs(); this.motifOnly = null; };   // (0.5)

  export { Brain, STYLES, STYLE_NAMES, STYLE_ORDER, LAYERS, LAYERS_ALL, SOUND_LAYERS, SHAPE_NAMES, SCALES, SEC_E, IK, D, code, uncode, hash, rng, euclid, clamp, div };
