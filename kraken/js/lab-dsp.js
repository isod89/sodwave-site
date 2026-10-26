// SPDX-License-Identifier: GPL-3.0-only
// LAB's sound: a patch (lab-modules.js) played. Each module is a small processor working on blocks of 32 samples; the
// cables add their sources (times their amounts) into the inputs; the modules run in the cables' order (a cable that
// loops back reads the block before: 32 samples, 0.7 ms). An instrument runs one copy of the patch per voice and adds
// the voices, then its own effects; an effect runs one copy on the track's sound.
// LabSynth looks to the engine like a firmware engine (k_note, k_param, k_get, k_midi, k_render): its eight macros
// are its eight parameters, so automation, modulators, MIDI learn, parameter locks, freezing and the multi-core
// engine work on it as they do on SLOOP and Clipper. No DOM: the worklet, the export, the workers and the tests use it.
import { MODULES, FX_TYPES, patchShape, SYNC_BEATS, LAB_VERSION } from './lab-modules.js';
import { createDevice, Rack, DEVICES } from './fx.js';   // (only inside functions: fx.js imports this file)
import { SCALES } from './notefx.js';

const RATE = 44100, BLOCK = 32, TAU = Math.PI * 2, INV = 1 / RATE;
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const dbg = (db) => Math.pow(10, db / 20);
const frac = (x) => x - Math.floor(x);
const fin = (x) => (x === x && x < 1e4 && x > -1e4 ? x : 0);
// PolyBLEP: the corner of a saw or a square smoothed over a sample, so the oscillators do not alias
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
// randomness from a fixed seed (each module its own, from its id and its voice): the same patch sounds the same in
// the live engine, the export, the multi-core helpers and on another computer
function prng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 196314165 + 907633515) >>> 0; return s / 2147483648 - 1; }; }   // (-1..1)
const hash = (str, salt = 0) => { let h = 2166136261 ^ salt; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };

// ------------------------------------------------------------------ the modules
// each: constructor(m), set(p, m) when its knobs change, start(v) when its voice starts a note, process(I, O, v, g)
// I: inputs (a Float32Array, or null when nothing is plugged), O: outputs; v: the voice; g: the instrument
class Note {
  process(I, O, v) {
    const { pitch, gate, vel, trig, key, rand } = O, p = v.pitch, gt = v.gate ? 1 : 0, t0 = v.trig ? 1 : 0;
    for (let i = 0; i < BLOCK; i++) { pitch[i] = p; gate[i] = gt; vel[i] = v.vel; trig[i] = 0; key[i] = v.note / 127; rand[i] = v.rand; }
    trig[0] = t0;
  }
}
class Midi {
  set(p) { this.cc = p.cc | 0; }
  process(I, O, v, g) { O.wheel.fill(g.wheel); O.press.fill(g.press); O.bend.fill(g.bendN); O.sus.fill(g.sus ? 1 : 0); O.cc.fill(g.cc[this.cc] || 0); }
}
class Macro { set(p) { this.n = p.n | 0; } process(I, O, v, g) { O.out.fill(g.macros[this.n] ?? 0); } }
class AudioIn { process(I, O, v, g) { O.l.set(g.inL); O.r.set(g.inR); } }
class Out {
  set(p) { this.g = dbg(p.gain); const a = (p.pan + 1) * Math.PI / 4; this.gl = Math.cos(a) * Math.SQRT2 * this.g; this.gr = Math.sin(a) * Math.SQRT2 * this.g; }
  process(I, O, v) {
    const l = I.l, r = I.r || I.l, oL = v.outL, oR = v.outR;
    if (!l && !r) return;
    for (let i = 0; i < BLOCK; i++) { oL[i] += (l ? l[i] : 0) * this.gl; oR[i] += (r ? r[i] : 0) * this.gr; }
  }
}
class Tempo {
  process(I, O, v, g) {
    const d = g.bpm / 60 * INV, sig = g.sig || 4;
    let pos = g.pos;
    for (let i = 0; i < BLOCK; i++, pos += d) { O.beat[i] = frac(pos); O.bar[i] = frac(pos / sig); O.play[i] = g.playing ? 1 : 0; }
  }
}
class Osc {
  constructor(m, rnd) { this.ph = (rnd() + 1) / 2; this.lastSync = 0; this.tri = 0; }
  set(p) { this.p = p; }
  start() { if (this.p.phase >= 1) { this.ph = 0; this.tri = 0; } }
  process(I, O, v) {
    const p = this.p, out = O.out, base = p.oct * 12 + p.tune + p.fine / 100;
    const iP = I.pitch, iM = I.pmod, iF = I.fm, iS = I.shape, iW = I.pw, iY = I.sync;
    let ph = this.ph, f = mtof((iP ? iP[0] : v.pitch) + base + (iM ? iM[0] * 12 : 0));
    for (let i = 0; i < BLOCK; i++) {
      if (iP || iM) f = mtof((iP ? iP[i] : v.pitch) + base + (iM ? iM[i] * 12 : 0));
      const dt = Math.min(0.49, f * INV);
      if (iY) { const s = iY[i]; if (s > 0 && this.lastSync <= 0) ph = 0; this.lastSync = s; }
      const t = iF ? frac(ph + iF[i]) : ph;
      let shape = p.shape + (iS ? iS[i] * 4 : 0); shape = shape < 0 ? 0 : shape > 4 ? 4 : shape;
      let pw = p.pw + (iW ? iW[i] * 0.45 : 0); pw = pw < 0.02 ? 0.02 : pw > 0.98 ? 0.98 : pw;
      const k = Math.floor(shape), x = shape - k;
      const w = (n) => {
        switch (n) {
          case 0: return Math.sin(TAU * t);
          case 1: return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
          case 2: return 2 * t - 1 - blep(t, dt);
          case 3: { let s = t < pw ? 1 : -1; s += blep(t, dt); s -= blep(frac(t + 1 - pw), dt); return s; }
          default: { const q = 0.1; let s = t < q ? 1 : -1; s += blep(t, dt); s -= blep(frac(t + 1 - q), dt); return s * 0.8; }
        }
      };
      const y = x > 0.001 && k < 4 ? w(k) * (1 - x) + w(k + 1) * x : w(k);
      out[i] = y * p.level;
      ph += dt; if (ph >= 1) ph -= 1;
    }
    this.ph = ph;
  }
}
const SUPER_OFF = [-1, -0.62, -0.28, 0, 0.3, 0.65, 1], SUPER_PAN = [-1, 0.66, -0.33, 0, 0.33, -0.66, 1];
class Super {
  constructor(m, rnd) { this.ph = SUPER_OFF.map(() => (rnd() + 1) / 2); }
  set(p) { this.p = p; }
  process(I, O, v) {
    const p = this.p, L = O.l, R = O.r, iP = I.pitch, iM = I.pmod, iD = I.detune;
    const base = p.oct * 12 + p.tune, side = p.mix, cen = 1 - p.mix * 0.55, g = p.level / 2.2;
    const pitch = (iP ? iP[0] : v.pitch) + base + (iM ? iM[0] * 12 : 0);
    let det = p.detune + (iD ? iD[0] : 0); det = det < 0 ? 0 : det > 1 ? 1 : det;
    const spread = Math.pow(det, 1.6) * 0.9;                     // (semitones at the outer saws)
    L.fill(0); R.fill(0);
    for (let s = 0; s < 7; s++) {
      const f = mtof(pitch + SUPER_OFF[s] * spread), dt = Math.min(0.49, f * INV), lv = (s === 3 ? cen : side) * g;
      const pan = SUPER_PAN[s] * p.width, gl = lv * Math.min(1, 1 - pan), gr = lv * Math.min(1, 1 + pan);
      let ph = this.ph[s];
      for (let i = 0; i < BLOCK; i++) { const y = 2 * ph - 1 - blep(ph, dt); L[i] += y * gl; R[i] += y * gr; ph += dt; if (ph >= 1) ph -= 1; }
      this.ph[s] = ph;
    }
  }
}
class Op {
  constructor() { this.ph = 0; this.y1 = 0; this.y2 = 0; }
  set(p) { this.p = p; }
  start() { this.ph = 0; this.y1 = this.y2 = 0; }
  process(I, O, v) {
    const p = this.p, out = O.out, iP = I.pitch, iM = I.pm, iA = I.amp, iQ = I.pmod;
    const r = p.ratio * Math.pow(2, p.fine / 1200), fb = p.fb * p.fb * 0.6;
    let ph = this.ph, y1 = this.y1, y2 = this.y2;
    for (let i = 0; i < BLOCK; i++) {
      const f = p.fixed >= 1 ? p.hz : mtof((iP ? iP[i] : v.pitch) + (iQ ? iQ[i] * 12 : 0)) * r;
      const y = Math.sin(TAU * (ph + (iM ? iM[i] : 0) + fb * (y1 + y2) * 0.5));
      y2 = y1; y1 = y;
      out[i] = y * p.level * (iA ? iA[i] : 1);
      ph += f * INV; if (ph >= 1) ph -= Math.floor(ph);
    }
    this.ph = ph; this.y1 = y1; this.y2 = y2;
  }
}
class Noise {
  constructor(m, rnd) { this.b = [0, 0, 0, 0, 0, 0, 0]; this.br = 0; this.rnd = rnd; }
  set(p) { this.p = p; }
  process(I, O) {
    const p = this.p, out = O.out, c = p.color, b = this.b, iA = I.amp;
    for (let i = 0; i < BLOCK; i++) {
      const w = this.rnd();
      let y;
      if (c === 0) y = w;
      else if (c === 1) {                                        // pink (Paul Kellet's filter)
        b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
        b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
        y = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11; b[6] = w * 0.115926;
      } else { this.br = (this.br + w * 0.02) * 0.998; y = this.br * 3.5; }
      out[i] = y * p.level * (iA ? iA[i] : 1);
    }
  }
}
class Pluck {
  constructor(m, rnd) { this.buf = new Float32Array(4096); this.w = 0; this.lp = 0; this.last = 0; this.len = 100; this.rnd = rnd; }
  set(p) { this.p = p; }
  excite(f) {
    const p = this.p, n = Math.min(4000, Math.max(2, RATE / f)), lp = 1 - p.pick * 0.95;
    let s = 0;
    this.buf.fill(0);
    for (let j = 0; j < n + 2; j++) { const x = this.rnd(); s += (x - s) * (1 - lp * 0.9); this.buf[(this.w - 1 - j + 8192) & 4095] = s; }   // (behind the write head: what is read next)
  }
  process(I, O, v) {
    const p = this.p, out = O.out, iP = I.pitch, iT = I.trig, buf = this.buf;
    const fbk = 0.95 + 0.04999 * Math.pow(p.decay, 0.35), damp = p.damp;
    for (let i = 0; i < BLOCK; i++) {
      const f = mtof(iP ? iP[i] : v.pitch);
      const t = iT ? iT[i] : (i === 0 && v.trig ? 1 : 0);
      if (t > 0 && this.last <= 0) this.excite(f);
      this.last = t;
      const d = Math.min(4000, Math.max(2, RATE / f)), r = this.w - d, ri = Math.floor(r), fr = r - ri;
      const a = buf[(ri + 8192) & 4095], b = buf[(ri + 1 + 8192) & 4095], x = a + (b - a) * fr;
      this.lp += (x - this.lp) * (1 - damp * 0.9);
      const y = (x * (1 - damp) + this.lp * damp) * fbk;
      buf[this.w] = y; this.w = (this.w + 1) & 4095;
      out[i] = x * p.level;
    }
  }
}
// a zero-delay state-variable filter (Simper / Zavalishin), its coefficients worked out every 4 samples when modulated
class Filter {
  constructor() { this.s1 = 0; this.s2 = 0; }
  set(p) { this.p = p; }
  process(I, O, v) {
    const p = this.p, x = I.in, out = O.out, iC = I.cut, iR = I.res;
    if (!x) { out.fill(0); this.s1 *= 0.9; this.s2 *= 0.9; return; }
    const ty = p.type, drv = p.drive > 0.001 ? 1 + p.drive * 8 : 0, kt = p.key ? Math.pow(2, (v.pitch - 60) / 12 * p.key) : 1;
    let s1 = this.s1, s2 = this.s2, g = 0, k = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let i = 0; i < BLOCK; i++) {
      if ((i & 3) === 0) {
        let fc = p.cut * kt * (iC ? Math.pow(2, iC[i] * 5) : 1); fc = fc < 15 ? 15 : fc > 20000 ? 20000 : fc;
        let res = p.res + (iR ? iR[i] : 0); res = res < 0 ? 0 : res > 1 ? 1 : res;
        g = Math.tan(Math.PI * Math.min(fc, RATE * 0.45) * INV); k = 2 - 1.96 * res;
        a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
      }
      let xi = x[i];
      if (drv) xi = Math.tanh(xi * drv) / Math.sqrt(drv);
      const v3 = xi - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
      s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
      out[i] = ty === 0 ? v2 : ty === 1 ? xi - k * v1 - v2 : ty === 2 ? v1 : xi - k * v1;
    }
    this.s1 = fin(s1); this.s2 = fin(s2);
  }
}
class Ladder {
  constructor() { this.y = [0, 0, 0, 0]; }
  set(p) { this.p = p; }
  process(I, O, v) {
    const p = this.p, x = I.in, out = O.out, iC = I.cut, iR = I.res, y = this.y;
    if (!x) { out.fill(0); for (let j = 0; j < 4; j++) y[j] *= 0.9; return; }
    const kt = p.key ? Math.pow(2, (v.pitch - 60) / 12 * p.key) : 1, drv = 1 + p.drive * 6;
    let g = 0, k = 0;
    for (let i = 0; i < BLOCK; i++) {
      if ((i & 3) === 0) {
        let fc = p.cut * kt * (iC ? Math.pow(2, iC[i] * 5) : 1); fc = fc < 15 ? 15 : fc > 18000 ? 18000 : fc;
        g = 1 - Math.exp(-TAU * fc * INV); k = 4.7 * Math.max(0, Math.min(1.12, p.res + (iR ? iR[i] : 0)));   // (sings from about 1.0)
      }
      const u = Math.tanh(x[i] * drv - k * y[3]);
      y[0] += g * (u - y[0]); y[1] += g * (y[0] - y[1]); y[2] += g * (y[1] - y[2]); y[3] += g * (y[2] - y[3]);
      out[i] = y[3] * (1 + k * 0.25) / Math.sqrt(drv) * 1.25;
    }
    for (let j = 0; j < 4; j++) y[j] = fin(y[j]);
  }
}
class Comb {
  constructor() { this.buf = new Float32Array(4096); this.w = 0; this.lp = 0; }
  set(p) { this.p = p; }
  process(I, O, v) {
    const p = this.p, x = I.in, out = O.out, iP = I.pitch, iF = I.fb, buf = this.buf;
    for (let i = 0; i < BLOCK; i++) {
      const f = p.follow >= 1 ? mtof(iP ? iP[i] : v.pitch) : p.hz, d = Math.min(4000, Math.max(2, RATE / f));
      const r = this.w - d, ri = Math.floor(r), fr = r - ri, a = buf[(ri + 8192) & 4095], b = buf[(ri + 1 + 8192) & 4095], dl = a + (b - a) * fr;
      this.lp += (dl - this.lp) * (1 - p.damp * 0.95);
      let fb = p.fb + (iF ? iF[i] : 0); fb = fb > 0.99 ? 0.99 : fb < -0.99 ? -0.99 : fb;
      const xi = x ? x[i] : 0, y = xi + this.lp * fb;
      buf[this.w] = Math.tanh(y); this.w = (this.w + 1) & 4095;
      out[i] = xi * (1 - p.mix) + y * p.mix * 0.5;
    }
    this.lp = fin(this.lp);
  }
}
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240]];
class Vowel {
  constructor() { this.s = new Float64Array(6); }
  set(p) { this.p = p; }
  process(I, O) {
    const p = this.p, x = I.in, out = O.out, s = this.s;
    let vw = p.vowel + (I.vowel ? I.vowel[0] * 4 : 0); vw = vw < 0 ? 0 : vw > 4 ? 4 : vw;
    const k0 = Math.floor(vw), fr = vw - k0, k1 = Math.min(4, k0 + 1), q = 2 + p.q * 18, gains = [1, 0.6, 0.35], co = [];
    for (let j = 0; j < 3; j++) {
      const f = VOWELS[k0][j] * (1 - fr) + VOWELS[k1][j] * fr, g = Math.tan(Math.PI * f * INV), k = 1 / q, a1 = 1 / (1 + g * (g + k));
      co.push([a1, g * a1, g * g * a1, gains[j] * k]);   // (× k: each band-pass at unity at its centre)
    }
    for (let i = 0; i < BLOCK; i++) {
      const xi = x ? x[i] : 0;
      let y = 0;
      for (let j = 0; j < 3; j++) {
        const [a1, a2, a3, gn] = co[j], v3 = xi - s[j * 2 + 1], v1 = a1 * s[j * 2] + a2 * v3, v2 = s[j * 2 + 1] + a2 * s[j * 2] + a3 * v3;
        s[j * 2] = 2 * v1 - s[j * 2]; s[j * 2 + 1] = 2 * v2 - s[j * 2 + 1];
        y += v1 * gn;
      }
      out[i] = xi * (1 - p.mix) + y * p.mix * 1.4;
    }
    for (let j = 0; j < 6; j++) s[j] = fin(s[j]);
  }
}
// ENVELOPE: shaped like an analog one (it aims past 1 on the attack, glides down to the sustain, then to silence)
class Adsr {
  constructor() { this.lv = 0; this.st = 0; this.lastGate = 0; }         // st: 0 idle, 1 attack, 2 decay/sustain, 3 release
  set(p) {
    this.p = p; const t = (ms) => Math.max(1, ms * 0.001 * RATE);
    this.over = 1.02 + (p.curve + 1) * 0.5;                                // (attack target: more over 1, straighter)
    this.ka = 1 - Math.exp(-Math.log(this.over / (this.over - 1)) / t(p.a));
    this.kd = 1 - Math.exp(-4.6 / t(p.d)); this.kr = 1 - Math.exp(-4.6 / t(p.r));
  }
  start(v) { this.velG = 1 - this.p.vel * (1 - v.vel); }
  get idle() { return this.st === 0; }
  process(I, O, v) {
    const out = O.out, gI = I.gate, s = this.p.s;
    let lv = this.lv, st = this.st;
    for (let i = 0; i < BLOCK; i++) {
      const gt = gI ? (gI[i] > 0.5 ? 1 : 0) : (v.gate ? 1 : 0);
      const trig = gI ? (gt && !this.lastGate) : (i === 0 && v.trig);
      if (trig) st = 1;
      else if (!gt && this.lastGate && st) st = 3;
      else if (!gI && !v.gate && st && st !== 3) st = 3;
      this.lastGate = gt;
      if (st === 1) { lv += (this.over - lv) * this.ka; if (lv >= 1) { lv = 1; st = 2; } }
      else if (st === 2) lv += (s - lv) * this.kd;
      else if (st === 3) { lv -= lv * this.kr; if (lv < 1e-4) { lv = 0; st = 0; } }
      out[i] = lv * (this.velG ?? 1);
    }
    this.lv = lv; this.st = st;
  }
}
const LFO_W = (w, t, r) => {
  switch (w) {
    case 0: return Math.sin(TAU * t);
    case 1: return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
    case 2: return 1 - 2 * t;
    case 3: return 2 * t - 1;
    case 4: return t < 0.5 ? 1 : -1;
    case 5: return r[0];
    default: { const x = t * t * (3 - 2 * t); return r[1] * (1 - x) + r[0] * x; }
  }
};
class Lfo {
  constructor(m, rnd) { this.rnd = rnd; this.ph = (rnd() + 1) / 2; this.r = [rnd(), rnd()]; this.age = 0; }
  set(p) { this.p = p; }
  start() { if (this.p.start === 1) { this.ph = 0; } this.age = 0; }
  process(I, O, v, g) {
    const p = this.p, out = O.out, uni = O.uni, iR = I.rate, iA = I.amp, beats = SYNC_BEATS[p.sync | 0];
    const song = p.start === 2 && beats > 0, fadeN = p.fade * 0.001 * RATE;
    let pos = g.pos;
    const dPos = g.bpm / 60 * INV;
    for (let i = 0; i < BLOCK; i++, pos += dPos) {
      let rate = beats > 0 ? g.bpm / 60 / beats : p.rate;
      if (iR) rate *= Math.pow(2, iR[i] * 4);
      let t;
      if (song) t = frac(pos / beats + p.phase);
      else { this.ph += rate * INV; if (this.ph >= 1) { this.ph -= Math.floor(this.ph); this.r[1] = this.r[0]; this.r[0] = this.rnd(); } t = frac(this.ph + p.phase); }
      if (song) { const c = Math.floor(pos / beats); if (c !== this.cyc) { this.cyc = c; this.r[1] = this.r[0]; this.r[0] = this.rnd(); } }
      let y = LFO_W(p.wave, t, this.r) * (iA ? iA[i] : 1);
      if (fadeN > 0 && this.age < fadeN) y *= this.age / fadeN;
      this.age++;
      out[i] = y; uni[i] = (y + 1) * 0.5;
    }
  }
}
class Steps {
  constructor() { this.cur = 0; this.y = 0; this.idx = -1; this.t0 = 0; this.n = 0; }
  set(p) { this.p = p; }
  start() { this.n = 0; }
  process(I, O, v, g) {
    const p = this.p, out = O.out, tr = O.trig, beats = SYNC_BEATS[Math.max(1, p.sync | 0)], len = Math.max(1, p.len | 0);
    const dPos = g.bpm / 60 * INV, k = p.glide > 0 ? 1 - Math.exp(-1 / (p.glide * beats * 60 / g.bpm * RATE * 0.5 + 1)) : 1;
    let pos = g.pos;
    for (let i = 0; i < BLOCK; i++, pos += dPos) {
      const t = p.start === 2 ? pos / beats : this.n * dPos / beats;
      this.n++;
      const idx = ((Math.floor(t) % len) + len) % len;
      tr[i] = idx !== this.idx ? 1 : 0;
      this.idx = idx;
      const target = p[`s${idx}`];
      this.y += (target - this.y) * k;
      out[i] = this.y;
    }
  }
}
class Slew {
  constructor() { this.y = 0; }
  set(p) { const t = (ms) => (ms <= 0 ? 1 : 1 - Math.exp(-1 / (ms * 0.001 * RATE))); this.ku = t(p.up); this.kd = t(p.down); }
  process(I, O) { const x = I.in, out = O.out; let y = this.y; for (let i = 0; i < BLOCK; i++) { const xi = x ? x[i] : 0; y += (xi - y) * (xi > y ? this.ku : this.kd); out[i] = y; } this.y = fin(y); }
}
class Follow {
  constructor() { this.e = 0; }
  set(p) { this.ka = 1 - Math.exp(-1 / (p.att * 0.001 * RATE)); this.kr = 1 - Math.exp(-1 / (p.rel * 0.001 * RATE)); this.g = p.gain; }
  process(I, O) { const x = I.in, out = O.out; let e = this.e; for (let i = 0; i < BLOCK; i++) { const a = x ? Math.abs(x[i]) : 0; e += (a - e) * (a > e ? this.ka : this.kr); out[i] = Math.min(1, e * this.g); } this.e = fin(e); }
}
class Sh {
  constructor(m, rnd) { this.y = 0; this.last = 0; this.c = -1; this.rnd = rnd; }
  set(p) { this.p = p; }
  process(I, O, v, g) {
    const out = O.out, x = I.in, tr = I.trig, beats = SYNC_BEATS[this.p.sync | 0] || 0.5, dPos = g.bpm / 60 * INV;
    let pos = g.pos;
    for (let i = 0; i < BLOCK; i++, pos += dPos) {
      let hit;
      if (tr) { hit = tr[i] > 0 && this.last <= 0; this.last = tr[i]; } else { const c = Math.floor(pos / beats); hit = c !== this.c; this.c = c; }
      if (hit) this.y = x ? x[i] : this.rnd();
      out[i] = this.y;
    }
  }
}
class Vca { set(p) { this.g = p.gain; } process(I, O) { const x = I.in, cv = I.cv, out = O.out, g = this.g; if (!x) { out.fill(0); return; } for (let i = 0; i < BLOCK; i++) out[i] = x[i] * (cv ? cv[i] : 1) * g; } }
class Mix {
  set(p) { this.l = [p.la, p.lb, p.lc, p.ld]; }
  process(I, O) { const out = O.out; out.fill(0); const ins = [I.a, I.b, I.c, I.d]; for (let j = 0; j < 4; j++) { const x = ins[j], l = this.l[j]; if (x) for (let i = 0; i < BLOCK; i++) out[i] += x[i] * l; } }
}
class Scale { set(p) { this.m = p.mul; this.a = p.add; } process(I, O) { const x = I.in, out = O.out; for (let i = 0; i < BLOCK; i++) out[i] = (x ? x[i] : 0) * this.m + this.a; } }
class Maths {
  set(p) { this.p = p; }
  process(I, O) {
    const p = this.p, A = I.a, B = I.b, out = O.out, op = p.op;
    for (let i = 0; i < BLOCK; i++) {
      const a = (A ? A[i] : 0) + p.a, b = (B ? B[i] : 0) + p.b;
      out[i] = op === 0 ? a + b : op === 1 ? a - b : op === 2 ? a * b : op === 3 ? Math.min(a, b) : op === 4 ? Math.max(a, b) : (a + b) * 0.5;
    }
  }
}
class Shaper {
  set(p) { this.p = p; this.o = dbg(p.out); }
  process(I, O) {
    const p = this.p, x = I.in, iD = I.drive, out = O.out, ty = p.type;
    if (!x) { out.fill(0); return; }
    for (let i = 0; i < BLOCK; i++) {
      const d = dbg(p.drive + (iD ? iD[i] * 24 : 0)), xi = x[i], s = xi * d;
      let y;
      if (ty === 0) y = Math.tanh(s);
      else if (ty === 1) y = s >= 0 ? 1 - Math.exp(-s) : -(1 - Math.exp(s)) * 0.8;
      else if (ty === 2) y = s > 1 ? 1 : s < -1 ? -1 : s;
      else if (ty === 3) y = Math.sin(s * Math.PI / 2);
      else if (ty === 4) y = Math.abs(s) * 2 - 0.5;
      else { const q = Math.pow(2, Math.max(1, 16 - p.drive / 3)); y = Math.round(xi * q) / q; }
      out[i] = (xi * (1 - p.mix) + y * p.mix) * this.o;
    }
  }
}
class Xfade { set(p) { this.x = p.x; } process(I, O) { const a = I.a, b = I.b, X = I.x, out = O.out; for (let i = 0; i < BLOCK; i++) { let x = this.x + (X ? X[i] : 0); x = x < 0 ? 0 : x > 1 ? 1 : x; out[i] = (a ? a[i] : 0) * (1 - x) + (b ? b[i] : 0) * x; } } }
class Quant {
  set(p) { this.root = p.root; this.set_ = SCALES[p.scale]?.[1] || SCALES[0][1]; }
  process(I, O) {
    const x = I.in, out = O.out;
    for (let i = 0; i < BLOCK; i++) {
      const n = x ? x[i] : 60, r = Math.round(n);
      let best = r, bd = 99;
      for (let d = -6; d <= 6; d++) { const m = r + d, pc = (((m - this.root) % 12) + 12) % 12; if (this.set_.includes(pc) && Math.abs(m - n) < bd) { bd = Math.abs(m - n); best = m; } }
      out[i] = best;
    }
  }
}
class Value { set(p) { this.v = p.v; } process(I, O) { O.out.fill(this.v); } }
class Delay {
  constructor() { this.buf = new Float32Array(131072); this.w = 0; this.lp = 0; }
  set(p) { this.p = p; }
  process(I, O, v, g) {
    const p = this.p, x = I.in, iT = I.time, out = O.out, buf = this.buf, beats = SYNC_BEATS[p.sync | 0];
    const base = (beats > 0 ? beats * 60 / g.bpm * 1000 : p.time) * 0.001 * RATE;
    for (let i = 0; i < BLOCK; i++) {
      let d = base * (iT ? Math.pow(2, iT[i]) : 1); d = d < 1 ? 1 : d > 131000 ? 131000 : d;
      const r = this.w - d, ri = Math.floor(r), fr = r - ri, a = buf[(ri + 262144) & 131071], b = buf[(ri + 1 + 262144) & 131071], y = a + (b - a) * fr;
      this.lp += (y - this.lp) * (1 - p.damp * 0.9);
      const xi = x ? x[i] : 0;
      buf[this.w] = xi + this.lp * p.fb; this.w = (this.w + 1) & 131071;
      out[i] = xi * (1 - p.mix) + y * p.mix;
    }
    this.lp = fin(this.lp);
  }
}
class Effect {
  constructor() { this.tl = new Float32Array(BLOCK); this.tr = new Float32Array(BLOCK); this.type = null; this.dev = null; }
  set(p, m) {
    const type = FX_TYPES[p.dev] || 'reverb';
    if (type !== this.type) { this.type = type; this.dev = createDevice(type); if (this.dev) { this.dev.type = type; this.dev.def = { id: 'lab', type, on: true }; } }
    const q = {}; for (const k of DEVICES[type].params) q[k.k] = m.fx?.p?.[k.k] ?? k.def;
    this.q = q;
    this.dev?.set(q, this.bpm || 120);
  }
  process(I, O, v, g) {
    const L = O.l, R = O.r;
    L.set(I.l || this.tl.fill(0)); R.set(I.r || I.l || this.tr.fill(0));
    if (!this.dev) return;
    if (g.bpm !== this.bpm) { this.bpm = g.bpm; this.dev.set(this.q, g.bpm); }
    this.dev.process(L, R, BLOCK, { bpm: g.bpm, pos: g.pos, sidechain: () => null });
  }
}

// ---- FORMULA: a small maths language, read here (never run as JavaScript): numbers, a b c d t pitch gate vel x pi sr,
// + - * / % ^, comparisons, && || !, cond ? a : b, and a fixed list of functions
const FUNCS = { sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sqrt: (x) => Math.sqrt(Math.max(0, x)), exp: (x) => Math.exp(Math.min(50, x)), log: (x) => Math.log(Math.max(1e-12, x)), pow: (a, b) => Math.pow(a, b), sign: Math.sign,
  clamp: (x, a, b) => Math.max(a, Math.min(b, x)), frac, mtof, ftom: (f) => 69 + 12 * Math.log2(Math.max(1e-6, f) / 440) };
const VARS = ['a', 'b', 'c', 'd', 't', 'pitch', 'gate', 'vel', 'x', 'pi', 'sr'];
export function compileFormula(src) {
  const s = String(src || '').slice(0, 200), toks = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_]\w*)|(\|\||&&|==|!=|<=|>=|[-+*/%^(),?:<>!]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(s))) { if (/^\s*$/.test(s.slice(at))) break; throw new Error(`I do not understand "${s.slice(at, at + 8).trim()}"`); }
    toks.push(m[1] != null ? { n: +m[1] } : m[2] != null ? { id: m[2] } : { op: m[3] });
  }
  let i = 0;
  const peek = (op) => toks[i]?.op === op, take = (op) => { if (peek(op)) { i++; return true; } return false; };
  const need = (op) => { if (!take(op)) throw new Error(`"${op}" missing`); };
  const bin = (next, ops) => () => {
    let l = next();
    for (;;) {
      const t = toks[i]; if (!t?.op || !ops[t.op]) return l;
      i++; const r = next(), f = ops[t.op], L = l; l = (e) => f(L(e), r(e));
    }
  };
  const primary = () => {
    const t = toks[i++];
    if (!t) throw new Error('the formula stops too early');
    if (t.n != null) { const v = t.n; return () => v; }
    if (t.op === '(') { const e = cond(); need(')'); return e; }
    if (t.op === '-') { const e = power(); return (x) => -e(x); }
    if (t.op === '+') return power();
    if (t.op === '!') { const e = power(); return (x) => (e(x) ? 0 : 1); }
    if (t.id) {
      if (peek('(') && t.id === 'noise') { i++; need(')'); return (e) => e.rng(); }
      if (peek('(')) {
        const f = Object.hasOwn(FUNCS, t.id) ? FUNCS[t.id] : null; if (!f) throw new Error(`no function "${t.id}"`);
        i++; const args = [];
        if (!peek(')')) { do args.push(cond()); while (take(',')); }
        need(')');
        return (x) => f(...args.map((a) => a(x)));
      }
      if (t.id === 'pi') return () => Math.PI;
      if (t.id === 'sr') return () => RATE;
      if (!VARS.includes(t.id)) throw new Error(`no value "${t.id}" (a, b, c, d, t, pitch, gate, vel, x, pi)`);
      const k = t.id; return (e) => e[k];
    }
    throw new Error(`"${t.op}" out of place`);
  };
  const power = () => { const b = primary(); if (take('^')) { const e = power(); return (x) => Math.pow(b(x), e(x)); } return b; };
  const mul = bin(power, { '*': (a, b) => a * b, '/': (a, b) => (b ? a / b : 0), '%': (a, b) => (b ? a % b : 0) });
  const add = bin(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const cmp = bin(add, { '<': (a, b) => +(a < b), '>': (a, b) => +(a > b), '<=': (a, b) => +(a <= b), '>=': (a, b) => +(a >= b), '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b) });
  const and = bin(cmp, { '&&': (a, b) => +(a && b) });
  const or = bin(and, { '||': (a, b) => +(a || b) });
  const cond = () => { const c = or(); if (take('?')) { const a = cond(); need(':'); const b = cond(); return (x) => (c(x) ? a(x) : b(x)); } return c; };
  const e = cond();
  if (i < toks.length) throw new Error(`"${toks[i].op || toks[i].id || toks[i].n}" out of place`);
  return e;
}
const formulas = new Map();
function formula(text) {
  let f = formulas.get(text);
  if (!f) { try { f = { fn: compileFormula(text) }; } catch (err) { f = { err: err.message }; } formulas.set(text, f); if (formulas.size > 200) formulas.delete(formulas.keys().next().value); }
  return f;
}
export const formulaError = (text) => formula(text).err || null;
class Expr {
  constructor(m, rnd) { this.f = formula(m.text || ''); this.e = { a: 0, b: 0, c: 0, d: 0, t: 0, pitch: 60, gate: 0, vel: 0, x: 0, rng: rnd }; this.t = 0; }
  set(p, m) { this.f = formula(m.text || ''); }
  start() { this.t = 0; }
  process(I, O, v) {
    const out = O.out, fn = this.f.fn, e = this.e, A = I.a, B = I.b, C = I.c, D = I.d;
    if (!fn) { out.fill(0); return; }
    e.pitch = v.pitch; e.gate = v.gate ? 1 : 0; e.vel = v.vel;
    for (let i = 0; i < BLOCK; i++) {
      e.a = A ? A[i] : 0; e.b = B ? B[i] : 0; e.c = C ? C[i] : 0; e.d = D ? D[i] : 0; e.t = this.t; this.t += INV;
      let y = +fn(e); y = y === y ? (y > 64 ? 64 : y < -64 ? -64 : y) : 0;
      out[i] = y; e.x = y;
    }
  }
}
const DSP = { note: Note, midi: Midi, macro: Macro, in: AudioIn, out: Out, tempo: Tempo, osc: Osc, super: Super, op: Op, noise: Noise, pluck: Pluck, filter: Filter, ladder: Ladder,
  comb: Comb, vowel: Vowel, adsr: Adsr, lfo: Lfo, steps: Steps, slew: Slew, follow: Follow, sh: Sh, vca: Vca, mix: Mix, scale: Scale, math: Maths, shaper: Shaper, xfade: Xfade,
  quant: Quant, value: Value, expr: Expr, delay: Delay, fx: Effect };

// ------------------------------------------------------------------ the graph: one copy of a patch
class Graph {
  constructor(patch, salt = 0) {
    this.nodes = [];
    const byId = new Map();
    for (const m of patch.mods) {
      const def = MODULES[m.type], C = DSP[m.type];
      if (!def || !C) continue;
      const node = { m, def, dsp: new C(m, prng(hash(m.id, salt))), I: {}, O: {}, sums: [] };
      for (const o of def.outs) node.O[o.k] = new Float32Array(BLOCK);
      for (const inp of def.ins) node.I[inp.k] = null;
      node.dsp.set?.(m.p, m);
      byId.set(m.id, node);
      this.nodes.push(node);
    }
    // inputs: the cables into each, added up with their amounts
    const into = new Map();
    for (const c of patch.cables) {
      const a = byId.get(c.from[0]), b = byId.get(c.to[0]);
      if (!a || !b || !a.O[c.from[1]] || !(c.to[1] in b.I)) continue;
      const k = `${c.to[0]}.${c.to[1]}`;
      if (!into.has(k)) into.set(k, { node: b, key: c.to[1], list: [] });
      into.get(k).list.push({ src: a.O[c.from[1]], amt: c.amt, from: a, c });
    }
    for (const { node, key, list } of into.values()) {
      node.I[key] = new Float32Array(BLOCK); node.sums.push({ buf: node.I[key], list });
      node.deps = [...(node.deps || []), ...list.map((x) => x.from)];
    }
    // the order: sources before what they feed (a loop: the module later in it reads the block before)
    const order = [], state = new Map();
    const visit = (n) => {
      const s = state.get(n);
      if (s === 2 || s === 1) return;
      state.set(n, 1);
      for (const d of n.deps || []) visit(d);
      state.set(n, 2);
      order.push(n);
    };
    for (const n of this.nodes) visit(n);
    this.order = order;
    this.envs = this.nodes.filter((n) => n.m.type === 'adsr').map((n) => n.dsp);
    this.byId = byId;
  }
  // new knob values and cable amounts, the same modules and cables
  update(patch) {
    for (const m of patch.mods) { const n = this.byId.get(m.id); if (n) { n.m = m; n.dsp.set?.(m.p, m); } }
    const amt = new Map(patch.cables.map((c) => [`${c.from.join('.')}>${c.to.join('.')}`, c.amt]));
    for (const n of this.nodes) for (const s of n.sums) for (const x of s.list) { const a = amt.get(`${x.c.from.join('.')}>${x.c.to.join('.')}`); if (a != null) x.amt = a; }
  }
  start(v) { for (const n of this.nodes) n.dsp.start?.(v); }
  run(v, g) {
    for (const n of this.order) {
      for (const s of n.sums) {
        const b = s.buf; b.fill(0);
        for (const { src, amt } of s.list) if (amt === 1) for (let i = 0; i < BLOCK; i++) b[i] += src[i]; else for (let i = 0; i < BLOCK; i++) b[i] += src[i] * amt;
      }
      n.dsp.process(n.I, n.O, v, g);
      // a loop of cables can feed itself louder and louder: every output kept within ±256 (pitches reach 127), NaN to 0
      for (const k in n.O) { const o = n.O[k]; for (let i = 0; i < BLOCK; i++) { const x = o[i]; if (!(x > -256 && x < 256)) o[i] = x > 0 ? 256 : x < 0 ? -256 : 0; } }
    }
  }
}
const graphShape = (p) => patchShape(p);       // (what a graph is built for: its modules and cables; knobs and amounts follow)

// ------------------------------------------------------------------ an instrument
const SILENT = 1e-5, QUIET_BLOCKS = 140;                          // (a released voice silent for 0.1 s is free)
export class LabSynth {
  constructor(engine = null) {
    this.engine = engine;
    this.out = new Float32Array(BLOCK * 2);
    this.L = new Float32Array(BLOCK); this.R = new Float32Array(BLOCK);
    this.g = { bpm: 120, pos: 0, sig: 4, playing: false, macros: new Float64Array(8).fill(0.5), wheel: 0, press: 0, bendN: 0, sus: false, cc: new Float32Array(128) };
    this.voices = []; this.patch = null; this.shape = ''; this.held = []; this.sustained = new Set();
    this.rack = new Rack(); this.lastPitch = 60; this.tick = 0; this.rnd = prng(7);
    this.setPatch(null);
  }
  // the patch (validated by the project): rebuilt when its structure changes, else its knobs follow
  setPatch(patch) {
    if (!patch) patch = { v: LAB_VERSION, kind: 'inst', voice: { poly: 1, mode: 'poly', glide: 0, bend: 2 }, macros: [], mods: [], cables: [], fx: [] };
    if (patch === this.patch) return;
    const shape = graphShape(patch);
    this.patch = patch;
    if (shape !== this.shape) {
      this.shape = shape;
      const n = patch.voice?.mode === 'poly' ? patch.voice.poly : 1;
      this.voices = [...Array(Math.max(1, n))].map((_, i) => this.voice(patch, i));
      this.held = []; this.sustained.clear();
    } else for (const v of this.voices) v.graph.update(patch);
    this.rack.sync(patch.fx || [], this.g.bpm);
    if (!this.touched) patch.macros?.forEach((m, i) => { this.g.macros[i] = m.v; });
  }
  voice(patch, i) {
    return { graph: new Graph(patch, i + 1), on: false, gate: false, trig: false, note: 60, pitch: 60, target: 60, vel: 0, rand: 0, age: 0, rel: 0, quiet: 0, fade: 1,
      outL: new Float32Array(BLOCK), outR: new Float32Array(BLOCK) };
  }
  // ---- the engine's side (as a firmware engine)
  k_nparams() { return 8; }
  k_param(id, v) { if (id >= 0 && id < 8) { this.g.macros[id] = Math.max(0, Math.min(127, v)) / 127; this.touched = true; } }
  k_get(id) { return Math.round((this.g.macros[id] ?? 0) * 127); }
  k_bpm(b) { this.g.bpm = b; }
  k_mpe() {}
  k_note(n, vel, on) { if (on && vel > 0) this.noteOn(n, vel / 127); else this.noteOff(n); }
  k_midi(st, d1, d2) {
    const g = this.g, t = st & 0xf0;
    if (t === 0xb0) {
      if (d1 === 1) g.wheel = d2 / 127;
      else if (d1 === 64) { g.sus = d2 >= 64; if (!g.sus) { for (const n of this.sustained) this.release(n); this.sustained.clear(); } }
      else if (d1 === 120 || d1 === 123) this.allOff();
      g.cc[d1] = d2 / 127;
    } else if (t === 0xd0) g.press = d1 / 127;
    else if (t === 0xa0) g.press = d2 / 127;
    else if (t === 0xe0) g.bendN = ((d1 | (d2 << 7)) - 8192) / 8192;
  }
  k_render() { this.render(); }
  // ---- notes
  noteOn(n, vel) {
    const pv = this.patch.voice || {}, mono = pv.mode !== 'poly';
    this.sustained.delete(n);
    this.held = this.held.filter((x) => x !== n); this.held.push(n);
    let v;
    if (mono) {
      v = this.voices[0];
      const legato = pv.mode === 'legato' && v.on && v.gate;
      v.target = n; v.note = n;
      if (!legato || !v.on) { this.begin(v, n, vel, pv.glide > 0 ? (v.on ? v.pitch : this.lastPitch) : n); }
      else v.vel = vel;
    } else {
      v = this.voices.find((x) => !x.on) || this.voices.filter((x) => !x.gate).sort((a, b) => b.rel - a.rel)[0] || this.voices.reduce((a, b) => (a.age > b.age ? a : b));
      this.begin(v, n, vel, pv.glide > 0 ? this.lastPitch : n);
    }
    this.lastPitch = n;
  }
  begin(v, n, vel, from) {
    const fresh = !v.on;
    v.on = true; v.gate = true; v.trig = true; v.note = n; v.target = n; v.pitch = from; v.vel = vel; v.rand = (this.rnd() + 1) / 2; v.age = 0; v.rel = 0; v.quiet = 0; v.fade = 1;
    if (fresh) { for (const node of v.graph.nodes) if (node.m.type === 'adsr') { node.dsp.lv = 0; node.dsp.st = 0; } }
    v.graph.start(v);
  }
  noteOff(n) {
    this.held = this.held.filter((x) => x !== n);
    if (this.g.sus) { this.sustained.add(n); return; }
    this.release(n);
  }
  release(n) {
    const pv = this.patch.voice || {};
    if (pv.mode !== 'poly') {
      const v = this.voices[0];
      if (v.note !== n) return;
      const back = this.held[this.held.length - 1];
      if (back != null) { v.target = back; v.note = back; if (pv.mode === 'mono') { v.trig = true; v.graph.start(v); } return; }
      v.gate = false; return;
    }
    for (const v of this.voices) if (v.on && v.gate && v.note === n) v.gate = false;
  }
  allOff() { for (const v of this.voices) { v.gate = false; } this.held = []; this.sustained.clear(); }
  panic() { for (const v of this.voices) { v.on = false; v.gate = false; } this.held = []; this.sustained.clear(); }
  // ---- sound
  render() {
    const g = this.g, e = this.engine, L = this.L, R = this.R, out = this.out, pv = this.patch.voice || {};
    if (e) { g.bpm = e.bpm || g.bpm; g.pos = e.pos || 0; g.playing = !!e.playing && !e.counting; g.sig = e.sig || 4; }
    L.fill(0); R.fill(0);
    const bend = g.bendN * (pv.bend ?? 2), gk = pv.glide > 0 ? 1 - Math.exp(-BLOCK / (pv.glide * 0.001 * RATE / 4.6)) : 1;
    let any = false;
    for (const v of this.voices) {
      if (!v.on) continue;
      any = true;
      v.pitch += (v.target - v.pitch) * gk;
      const pitch = v.pitch; v.pitch = pitch + bend;
      v.outL.fill(0); v.outR.fill(0);
      v.graph.run(v, g);
      v.pitch = pitch;
      v.trig = false; v.age += BLOCK;
      // the end of a voice: its envelopes done; with none, a short fade after the key is let go; or a long silence
      if (!v.gate) {
        v.rel += BLOCK;
        const envs = v.graph.envs;
        let pk = 0; for (let i = 0; i < BLOCK; i++) { const a = Math.abs(v.outL[i]) + Math.abs(v.outR[i]); if (a > pk) pk = a; }
        v.quiet = pk < SILENT ? v.quiet + 1 : 0;
        if (!envs.length) v.fade = Math.max(0, v.fade - BLOCK / (0.008 * RATE));
        if ((envs.length && envs.every((x) => x.idle)) || (!envs.length && v.fade <= 0) || v.quiet > QUIET_BLOCKS || v.rel > 30 * RATE) { v.on = false; }
      }
      const f0 = v.fade;
      for (let i = 0; i < BLOCK; i++) { L[i] += fin(v.outL[i]) * f0; R[i] += fin(v.outR[i]) * f0; }
    }
    if (this.rack.list.length) this.rack.process(L, R, BLOCK, { bpm: g.bpm, pos: g.pos, sidechain: () => null });
    if (!e) { g.playing = true; g.pos += BLOCK / RATE * g.bpm / 60; }   // (on its own, as in the tests: as if the song played)
    // (what leaves the instrument: never more than +18 dB over full scale, whatever the patch does)
    for (let i = 0; i < BLOCK; i++) { const l = fin(L[i]), r = fin(R[i]); out[i * 2] = l > 8 ? 8 : l < -8 ? -8 : l; out[i * 2 + 1] = r > 8 ? 8 : r < -8 ? -8 : r; }
    this.busy = any;
  }
}

// ------------------------------------------------------------------ an effect (a device in fx.js's racks)
export class LabFxDev {
  constructor() {
    this.p = {}; this.gr = 0; this.g = { bpm: 120, pos: 0, sig: 4, playing: false, macros: new Float64Array(8).fill(0.5), wheel: 0, press: 0, bendN: 0, sus: false, cc: new Float32Array(128), inL: new Float32Array(BLOCK), inR: new Float32Array(BLOCK) };
    this.v = { on: true, gate: true, trig: false, note: 60, pitch: 60, vel: 1, rand: 0.5, outL: new Float32Array(BLOCK), outR: new Float32Array(BLOCK) };
    this.patch = null; this.graph = null; this.shape = '';
    this.dL = new Float32Array(BLOCK); this.dR = new Float32Array(BLOCK);
  }
  set(p, bpm) { this.p = p; this.g.bpm = bpm || this.g.bpm; for (let i = 0; i < 8; i++) this.g.macros[i] = p[`m${i}`] ?? 0.5; }
  sync() {
    const patch = this.def?.lab;
    if (patch === this.patch) return;
    this.patch = patch;
    if (!patch) { this.graph = null; this.shape = ''; return; }
    const shape = graphShape(patch);
    if (shape !== this.shape) { this.shape = shape; this.graph = new Graph(patch); this.graph.start(this.v); } else this.graph.update(patch);
  }
  process(L, R, n, ctx) {
    this.sync();
    if (!this.graph) return;                                         // (no patch yet: the sound passes)
    const g = this.g, v = this.v, mx = this.p.mx ?? 1;
    g.bpm = ctx?.bpm || g.bpm; g.pos = ctx?.pos || 0;
    for (let o = 0; o < n; o += BLOCK) {
      const k = Math.min(BLOCK, n - o);
      g.inL.fill(0); g.inR.fill(0);
      for (let i = 0; i < k; i++) { g.inL[i] = L[o + i]; g.inR[i] = R[o + i]; }
      v.outL.fill(0); v.outR.fill(0);
      this.graph.run(v, g);
      for (let i = 0; i < k; i++) {
        let wl = fin(v.outL[i]), wr = fin(v.outR[i]); wl = wl > 8 ? 8 : wl < -8 ? -8 : wl; wr = wr > 8 ? 8 : wr < -8 ? -8 : wr;
        L[o + i] = g.inL[i] * (1 - mx) + wl * mx; R[o + i] = g.inR[i] * (1 - mx) + wr * mx;
      }
      g.pos += BLOCK / RATE * g.bpm / 60;
    }
  }
}

// ------------------------------------------------------------------ for the editor
// one voice of a patch played offline: a note held `held` seconds out of `seconds`; -> each output's signal, by
// "module id.output" (what the editor draws when you hover a port), and the sound
export function probe(patch, { note = 60, vel = 0.8, seconds = 0.6, held = 0.4, bpm = 120, input = null } = {}) {
  const fx = patch.kind === 'fx', g = { bpm, pos: 0, sig: 4, playing: true, macros: new Float64Array(8), wheel: 0, press: 0, bendN: 0, sus: false, cc: new Float32Array(128), inL: new Float32Array(BLOCK), inR: new Float32Array(BLOCK) };
  patch.macros?.forEach((m, i) => { g.macros[i] = m.v; });
  const graph = new Graph(patch), v = { on: true, gate: true, trig: true, note, pitch: note, vel, rand: 0.5, outL: new Float32Array(BLOCK), outR: new Float32Array(BLOCK) };
  graph.start(v);
  const blocks = Math.ceil(seconds * RATE / BLOCK), sig = new Map(), L = new Float32Array(blocks * BLOCK), R = new Float32Array(blocks * BLOCK);
  for (const n of graph.nodes) for (const k in n.O) sig.set(`${n.m.id}.${k}`, new Float32Array(blocks * BLOCK));
  for (let b = 0; b < blocks; b++) {
    if (b * BLOCK >= held * RATE) v.gate = false;
    if (fx) for (let i = 0; i < BLOCK; i++) { const t = (b * BLOCK + i) / RATE, x = input ? input(t) : Math.sin(TAU * 220 * t) * 0.5 * (t < held ? 1 : 0); g.inL[i] = x; g.inR[i] = x; }
    v.outL.fill(0); v.outR.fill(0);
    graph.run(v, g);
    v.trig = false;
    for (const n of graph.nodes) for (const k in n.O) sig.get(`${n.m.id}.${k}`).set(n.O[k], b * BLOCK);
    L.set(v.outL, b * BLOCK); R.set(v.outR, b * BLOCK);
    g.pos += BLOCK / RATE * bpm / 60;
  }
  return { sig, L, R };
}
