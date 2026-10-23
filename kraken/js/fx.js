// SPDX-License-Identifier: GPL-3.0-only
// Kraken's audio effects: the devices of a track, return or master rack. Each processes planar
// stereo blocks in place. Shared by the live engine, the offline export and the Node tests.
export const RATE = 44100;
const TAU = Math.PI * 2;
const dbg = (db) => Math.pow(10, db / 20);

// ---------------------------------------------------------------- building blocks ---
export class Biquad {                                   // RBJ cookbook, transposed direct form II, stereo
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.z = [0, 0, 0, 0]; this.on = true; }
  set(type, f, q = 0.707, gainDb = 0) {
    f = Math.max(10, Math.min(RATE * 0.49, f));
    const w = TAU * f / RATE, c = Math.cos(w), s = Math.sin(w), A = Math.pow(10, gainDb / 40), al = s / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'hp': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'notch': b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'peak': b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
      case 'low': { const r = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * c + r); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - r); a0 = (A + 1) + (A - 1) * c + r; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - r; break; }
      case 'high': { const r = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * c + r); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - r); a0 = (A + 1) - (A - 1) * c + r; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - r; break; }
      default: b0 = 1; b1 = b2 = a1 = a2 = 0; a0 = 1;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(L, R, n) {
    const { b0, b1, b2, a1, a2 } = this, z = this.z;
    for (let i = 0; i < n; i++) {
      let x = L[i], y = b0 * x + z[0]; z[0] = b1 * x - a1 * y + z[1]; z[1] = b2 * x - a2 * y; L[i] = y;
      x = R[i]; y = b0 * x + z[2]; z[2] = b1 * x - a1 * y + z[3]; z[3] = b2 * x - a2 * y; R[i] = y;
    }
    if (!(Math.abs(z[0]) < 1e6)) z.fill(0);       // never let a filter blow up
  }
}

export class Reverb {                            // Freeverb (Jezar, public domain), stereo, 100 % wet out
  constructor() {
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225], spread = 23;
    this.c = [0, 1].map((ch) => combs.map((n) => ({ b: new Float32Array(n + ch * spread), i: 0, f: 0 })));
    this.a = [0, 1].map((ch) => aps.map((n) => ({ b: new Float32Array(n + ch * spread), i: 0 })));
    this.pre = new Float32Array(Math.round(RATE * 0.25)); this.pi = 0;
    this.set(0.82, 0.35, 0.02);
  }
  set(size, damp, predelay) {
    this.fb = 0.7 + size * 0.28; this.d1 = damp * 0.6; this.d2 = 1 - this.d1;
    this.preN = Math.max(1, Math.min(this.pre.length - 1, Math.round(predelay * RATE)));
  }
  process(inL, inR, outL, outR, n) {
    const pre = this.pre, pn = pre.length, fb = this.fb, d1 = this.d1, d2 = this.d2;
    for (let i = 0; i < n; i++) {
      pre[this.pi] = (inL[i] + inR[i]) * 0.5;
      let r = this.pi - this.preN; if (r < 0) r += pn;
      const x = pre[r] * 0.03;
      if (++this.pi >= pn) this.pi = 0;
      for (let ch = 0; ch < 2; ch++) {
        const cs = this.c[ch], as = this.a[ch];
        let s = 0;
        for (let k = 0; k < 8; k++) { const c = cs[k], b = c.b; const y = b[c.i]; c.f = y * d2 + c.f * d1; b[c.i] = x + c.f * fb; if (++c.i >= b.length) c.i = 0; s += y; }
        for (let k = 0; k < 4; k++) { const a = as[k], b = a.b; const y = b[a.i]; b[a.i] = s + y * 0.5; if (++a.i >= b.length) a.i = 0; s = y - s; }
        if (ch) outR[i] += s; else outL[i] += s;
      }
    }
  }
}

export class Delay {                             // tempo-synced ping-pong with a darkening feedback, 100 % wet out
  constructor() {
    this.L = new Float32Array(RATE * 3); this.R = new Float32Array(RATE * 3); this.w = 0;
    this.lpL = 0; this.lpR = 0; this.pp = 1;
    this.set(0.75, 0.42, 0.55, 120);
  }
  set(beats, feedback, tone, bpm, pingpong = 1) {
    this.n = Math.max(32, Math.min(this.L.length - 1, Math.round(beats * 60 / bpm * RATE)));
    this.fb = Math.min(0.95, feedback); this.k = 0.08 + tone * 0.9; this.pp = pingpong;
  }
  process(inL, inR, outL, outR, n) {
    const len = this.L.length;
    for (let i = 0; i < n; i++) {
      let r = this.w - this.n; if (r < 0) r += len;
      const yl = this.L[r], yr = this.R[r];
      this.lpL += (yl - this.lpL) * this.k; this.lpR += (yr - this.lpR) * this.k;
      if (this.pp) { this.L[this.w] = (inL[i] + inR[i]) * 0.5 + this.lpR * this.fb; this.R[this.w] = this.lpL * this.fb; }
      else { this.L[this.w] = inL[i] + this.lpL * this.fb; this.R[this.w] = inR[i] + this.lpR * this.fb; }
      if (++this.w >= len) this.w = 0;
      outL[i] += yl; outR[i] += yr;
    }
  }
}

// ---------------------------------------------------------------------- devices ---
// parameter: [key, label, min, max, default, unit, curve ('log' | 'lin'), names?]
const P = (k, l, min, max, def, unit = '', curve = 'lin', names = null) => ({ k, l, min, max, def, unit, curve, names });
const SYNC = ['1/32', '1/16', '1/16.', '1/8', '1/8.', '1/4', '1/4.', '1/2', '1 BAR'];
const SYNC_BEATS = [0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 4];

export const DEVICES = {
  eq: { name: 'EQ', params: [
    P('hp', 'LOW CUT', 20, 2000, 20, 'Hz', 'log'), P('lg', 'LOW', -15, 15, 0, 'dB'), P('lf', 'LOW F', 40, 600, 120, 'Hz', 'log'),
    P('m1g', 'MID 1', -15, 15, 0, 'dB'), P('m1f', 'MID 1 F', 100, 8000, 500, 'Hz', 'log'), P('m1q', 'MID 1 Q', 0.3, 8, 1, '', 'log'),
    P('m2g', 'MID 2', -15, 15, 0, 'dB'), P('m2f', 'MID 2 F', 300, 16000, 3000, 'Hz', 'log'), P('m2q', 'MID 2 Q', 0.3, 8, 1, '', 'log'),
    P('hg', 'HIGH', -15, 15, 0, 'dB'), P('hf', 'HIGH F', 1500, 16000, 8000, 'Hz', 'log'), P('lp', 'HIGH CUT', 1000, 20000, 20000, 'Hz', 'log')] },
  comp: { name: 'COMPRESSOR', params: [
    P('th', 'THRESH', -60, 0, -18, 'dB'), P('ra', 'RATIO', 1, 20, 4, ':1', 'log'), P('at', 'ATTACK', 0.1, 100, 10, 'ms', 'log'),
    P('re', 'RELEASE', 10, 1000, 120, 'ms', 'log'), P('kn', 'KNEE', 0, 18, 6, 'dB'), P('mk', 'MAKEUP', 0, 24, 0, 'dB'), P('mx', 'MIX', 0, 1, 1, '%'),
    P('sc', 'SIDECHAIN', 0, 0, 0, '', 'lin', null)] },
  sat: { name: 'SATURATOR', params: [
    P('dr', 'DRIVE', 0, 36, 6, 'dB'), P('ty', 'TYPE', 0, 3, 0, '', 'lin', ['SOFT', 'TUBE', 'FOLD', 'HARD']), P('to', 'TONE', -1, 1, 0, ''),
    P('mx', 'MIX', 0, 1, 1, '%'), P('ou', 'OUTPUT', -24, 6, -3, 'dB')] },
  filter: { name: 'AUTO FILTER', params: [
    P('ty', 'TYPE', 0, 3, 0, '', 'lin', ['LOW PASS', 'HIGH PASS', 'BAND', 'NOTCH']), P('fr', 'FREQ', 30, 18000, 2000, 'Hz', 'log'), P('q', 'RES', 0.5, 12, 1.2, '', 'log'),
    P('lr', 'LFO RATE', 0, 8, 5, '', 'lin', SYNC), P('ld', 'LFO DEPTH', 0, 1, 0, '%'), P('mx', 'MIX', 0, 1, 1, '%')] },
  chorus: { name: 'CHORUS', params: [P('ra', 'RATE', 0.05, 5, 0.6, 'Hz', 'log'), P('de', 'DEPTH', 0, 1, 0.5, '%'), P('fb', 'FEEDBACK', 0, 0.9, 0.1, '%'), P('mx', 'MIX', 0, 1, 0.5, '%')] },
  phaser: { name: 'PHASER', params: [P('ra', 'RATE', 0.02, 4, 0.3, 'Hz', 'log'), P('de', 'DEPTH', 0, 1, 0.7, '%'), P('fb', 'FEEDBACK', 0, 0.9, 0.5, '%'), P('mx', 'MIX', 0, 1, 0.5, '%')] },
  delay: { name: 'DELAY', params: [P('ti', 'TIME', 0, 8, 4, '', 'lin', SYNC), P('fb', 'FEEDBACK', 0, 0.95, 0.4, '%'), P('to', 'TONE', 0, 1, 0.6, '%'), P('pp', 'PING-PONG', 0, 1, 1, '', 'lin', ['OFF', 'ON']), P('mx', 'MIX', 0, 1, 0.3, '%')] },
  reverb: { name: 'REVERB', params: [P('si', 'SIZE', 0, 1, 0.75, '%'), P('da', 'DAMP', 0, 1, 0.4, '%'), P('pr', 'PRE-DELAY', 0, 0.2, 0.02, 's'), P('mx', 'MIX', 0, 1, 0.25, '%')] },
  crush: { name: 'BIT CRUSHER', params: [P('bi', 'BITS', 2, 16, 8, ''), P('ds', 'DOWNSAMPLE', 1, 32, 4, '×', 'log'), P('mx', 'MIX', 0, 1, 1, '%')] },
  gate: { name: 'GATE', params: [P('th', 'THRESH', -80, 0, -40, 'dB'), P('at', 'ATTACK', 0.1, 50, 1, 'ms', 'log'), P('re', 'RELEASE', 5, 1000, 80, 'ms', 'log'), P('fl', 'FLOOR', -80, 0, -80, 'dB')] },
  slicer: { name: 'SLICER', params: [P('ra', 'RATE', 0, 8, 1, '', 'lin', SYNC), P('pa', 'PATTERN', 0, 7, 0, '', 'lin', ['EVEN', 'OFFBEAT', 'TRIPLET', 'GALLOP', 'SYNCO', 'STUTTER', 'BUILD', 'RANDOM']), P('de', 'DEPTH', 0, 1, 1, '%'), P('sm', 'SMOOTH', 0, 1, 0.2, '%')] },
  utility: { name: 'UTILITY', params: [P('ga', 'GAIN', -36, 18, 0, 'dB'), P('wi', 'WIDTH', 0, 2, 1, '%'), P('pa', 'PAN', -1, 1, 0, ''), P('bm', 'BASS MONO', 20, 500, 20, 'Hz', 'log'), P('ph', 'PHASE', 0, 3, 0, '', 'lin', ['NORMAL', 'INVERT L', 'INVERT R', 'INVERT'])] },
  limiter: { name: 'LIMITER', params: [P('ga', 'GAIN', 0, 24, 0, 'dB'), P('ce', 'CEILING', -12, 0, -0.3, 'dB'), P('re', 'RELEASE', 10, 1000, 80, 'ms', 'log')] },
};
export const DEVICE_ORDER = ['eq', 'comp', 'sat', 'filter', 'chorus', 'phaser', 'delay', 'reverb', 'crush', 'gate', 'slicer', 'utility', 'limiter'];

export function defaults(type) {
  const o = {};
  for (const p of DEVICES[type].params) o[p.k] = p.def;
  return o;
}
export function fmtParam(p, v) {
  if (p.names) return p.names[Math.round(v)] ?? String(v);
  if (p.k === 'sc') return '';
  if (p.unit === '%') return `${Math.round(v * 100)}%`;
  if (p.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : `${Math.round(v)}`;
  if (p.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}`;
  if (p.unit === 'ms') return v < 10 ? v.toFixed(1) : `${Math.round(v)}`;
  if (p.unit === ':1') return `${v.toFixed(1)}:1`;
  if (p.unit === 's') return `${Math.round(v * 1000)}ms`;
  if (p.k === 'pa' && p.min < 0) return Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
// 0..1 <-> a parameter's value, along its curve (knobs and controllers)
export const toNorm = (p, v) => (p.curve === 'log' ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min || 1));
export const fromNorm = (p, x) => {
  const v = p.curve === 'log' ? p.min * Math.pow(p.max / p.min, x) : p.min + x * (p.max - p.min);
  return p.names || p.k === 'bi' ? Math.round(v) : v;
};

// a device instance: set(params) when they change, process(L, R, n, ctx) per block
export function createDevice(type) {
  const C = { eq: EqDev, comp: CompDev, sat: SatDev, filter: FilterDev, chorus: ChorusDev, phaser: PhaserDev, delay: DelayDev, reverb: ReverbDev,
    crush: CrushDev, gate: GateDev, slicer: SlicerDev, utility: UtilityDev, limiter: LimiterDev }[type];
  return C ? new C() : null;
}

class Dev {
  constructor() { this.p = {}; this.gr = 0; this.dryL = new Float32Array(128); this.dryR = new Float32Array(128); }
  set(p, bpm) { const changed = JSON.stringify(p) !== this.key || bpm !== this.bpm; this.p = p; this.bpm = bpm; this.key = JSON.stringify(p); if (changed) this.update?.(); }
  keepDry(L, R, n) { if ((this.p.mx ?? 1) >= 1) return; this.dryL.set(L.subarray(0, n)); this.dryR.set(R.subarray(0, n)); }   // (all wet: no dry needed)
  mix(L, R, n, m) { if (m >= 1) return; for (let i = 0; i < n; i++) { L[i] = this.dryL[i] + (L[i] - this.dryL[i]) * m; R[i] = this.dryR[i] + (R[i] - this.dryR[i]) * m; } }
}

class EqDev extends Dev {
  constructor() { super(); this.f = [...Array(6)].map(() => new Biquad()); }
  update() {
    const p = this.p, f = this.f;
    f[0].set('hp', p.hp, 0.707); f[0].on = p.hp > 21;
    f[1].set('low', p.lf, 0.707, p.lg); f[1].on = Math.abs(p.lg) > 0.05;
    f[2].set('peak', p.m1f, p.m1q, p.m1g); f[2].on = Math.abs(p.m1g) > 0.05;
    f[3].set('peak', p.m2f, p.m2q, p.m2g); f[3].on = Math.abs(p.m2g) > 0.05;
    f[4].set('high', p.hf, 0.707, p.hg); f[4].on = Math.abs(p.hg) > 0.05;
    f[5].set('lp', p.lp, 0.707); f[5].on = p.lp < 19900;
  }
  process(L, R, n) { for (const b of this.f) if (b.on) b.run(L, R, n); }
}

class CompDev extends Dev {
  constructor() { super(); this.env = 0; this.g = 1; }
  // the level is read and the gain worked out every 4 samples (the gain glides between): a quarter of the logs and
  // powers of doing it at every sample, the same sound (the fastest attack, 0.1 ms, is 4.4 samples)
  update() {
    const p = this.p;
    this.at = Math.exp(-4 / (p.at * 0.001 * RATE)); this.re = Math.exp(-4 / (p.re * 0.001 * RATE));
    this.mk = dbg(p.mk);
  }
  process(L, R, n, ctx) {
    const p = this.p, key = p.sc && ctx.sidechain ? ctx.sidechain(p.sc) : null;
    const at = this.at, re = this.re, th = p.th, ra = p.ra, kn = p.kn, mk = this.mk, slope = 1 - 1 / ra;
    const kL = key ? key.L : L, kR = key ? key.R : R;
    this.keepDry(L, R, n);
    let env = this.env, g0 = this.g, maxGr = 0;
    for (let i = 0; i < n; i += 4) {
      const e = i + 4 < n ? i + 4 : n;
      let x = 0;
      for (let j = i; j < e; j++) { const a = Math.abs(kL[j]), b = Math.abs(kR[j]); if (a > x) x = a; if (b > x) x = b; }
      const lvl = 8.685889638065035 * Math.log(x + 1e-9);          // (dB)
      env = lvl > env ? at * env + (1 - at) * lvl : re * env + (1 - re) * lvl;
      const over = env - th;
      let gr = 0;
      if (over > kn / 2) gr = over * slope;
      else if (over > -kn / 2 && kn > 0) gr = slope * (over + kn / 2) ** 2 / (2 * kn);
      const g1 = Math.exp(-0.11512925464970229 * gr) * mk;        // (dB to gain)
      const step = (g1 - g0) / (e - i);
      for (let j = i; j < e; j++) { g0 += step; L[j] *= g0; R[j] *= g0; }
      g0 = g1;
      if (gr > maxGr) maxGr = gr;
    }
    this.env = Number.isFinite(env) ? env : -120;
    this.g = Number.isFinite(g0) ? g0 : 1;
    this.gr = Math.max(this.gr * 0.9, maxGr);
    this.mix(L, R, n, p.mx);
  }
}

class SatDev extends Dev {
  constructor() { super(); this.tl = new Biquad(); this.th = new Biquad(); this.lpL = 0; this.lpR = 0; }
  update() { this.tl.set('low', 300, 0.7, -this.p.to * 6); this.th.set('high', 3000, 0.7, this.p.to * 6); this.d = dbg(this.p.dr); this.o = dbg(this.p.ou); }
  process(L, R, n) {
    const p = this.p, d = this.d, o = this.o, ty = Math.round(p.ty);
    this.keepDry(L, R, n);
    for (const X of [L, R]) {
      if (ty === 0) for (let i = 0; i < n; i++) X[i] = Math.tanh(X[i] * d) * o;
      else if (ty === 1) for (let i = 0; i < n; i++) { const x = X[i] * d; X[i] = (x >= 0 ? 1 - Math.exp(-x) : -(1 - Math.exp(x)) * 0.8) * o; }   // asymmetric: even harmonics
      else if (ty === 2) for (let i = 0; i < n; i++) X[i] = Math.sin(X[i] * d) * o;                                                      // wavefolder
      else for (let i = 0; i < n; i++) { const x = X[i] * d; X[i] = (x > 1 ? 1 : x < -1 ? -1 : x) * o; }
    }
    if (Math.abs(p.to) > 0.02) { this.tl.run(L, R, n); this.th.run(L, R, n); }
    this.mix(L, R, n, p.mx);
  }
}

class FilterDev extends Dev {
  constructor() { super(); this.b = new Biquad(); this.ph = 0; this.last = -1; }
  process(L, R, n, ctx) {
    const p = this.p;
    const beats = SYNC_BEATS[Math.round(p.lr)] || 1;
    const lfo = p.ld > 0 ? Math.sin(TAU * ((ctx.pos || 0) / beats)) : 0;     // locked to the song position
    const f = p.fr * Math.pow(2, lfo * p.ld * 4);
    if (Math.abs(f - this.last) > 0.5) { this.b.set(['lp', 'hp', 'bp', 'notch'][Math.round(p.ty)], f, p.q); this.last = f; }
    this.keepDry(L, R, n);
    this.b.run(L, R, n);
    this.mix(L, R, n, p.mx);
  }
}

class ChorusDev extends Dev {
  constructor() { super(); this.L = new Float32Array(4096); this.R = new Float32Array(4096); this.w = 0; this.ph = 0; }
  // the delay times move with the LFO, worked out every 8 samples and glided between
  process(L, R, n) {
    const p = this.p, base = 0.012 * RATE, depth = p.de * 0.008 * RATE, inc = TAU * p.ra / RATE, fb = p.fb;
    const BL = this.L, BR = this.R;
    this.keepDry(L, R, n);
    let w = this.w, ph = this.ph;
    let dl0 = base + depth * (1 + Math.sin(ph)) / 2, dr0 = base + depth * (1 + Math.cos(ph)) / 2;
    for (let i = 0; i < n; i += 8) {
      const e = i + 8 < n ? i + 8 : n;
      ph += inc * (e - i); if (ph > TAU) ph -= TAU;
      const dl1 = base + depth * (1 + Math.sin(ph)) / 2, dr1 = base + depth * (1 + Math.cos(ph)) / 2;   // (cos: sin a quarter turn on)
      const sl = (dl1 - dl0) / (e - i), sr = (dr1 - dr0) / (e - i);
      for (let j = i; j < e; j++) {
        dl0 += sl; dr0 += sr;
        let x = w - dl0; if (x < 0) x += 4096; let a = x | 0, f = x - a;
        const yl = BL[a & 4095] * (1 - f) + BL[(a + 1) & 4095] * f;
        x = w - dr0; if (x < 0) x += 4096; a = x | 0; f = x - a;
        const yr = BR[a & 4095] * (1 - f) + BR[(a + 1) & 4095] * f;
        BL[w] = L[j] + yl * fb; BR[w] = R[j] + yr * fb;
        w = (w + 1) & 4095;
        L[j] = yl; R[j] = yr;
      }
      dl0 = dl1; dr0 = dr1;
    }
    this.w = w; this.ph = ph;
    this.mix(L, R, n, p.mx);
  }
}

class PhaserDev extends Dev {
  constructor() { super(); this.st = [new Float32Array(6), new Float32Array(6)]; this.fbv = [0, 0]; this.ph = 0; }
  // the all-pass frequency follows the LFO, worked out every 8 samples (the LFO is 4 Hz at most)
  process(L, R, n) {
    const p = this.p, inc = TAU * p.ra / RATE, fb = p.fb;
    this.keepDry(L, R, n);
    for (let i = 0; i < n; i += 8) {
      const e = i + 8 < n ? i + 8 : n;
      for (let ch = 0; ch < 2; ch++) {
        const m = (1 + Math.sin(this.ph + inc * (e - i) / 2 + ch * 0.6)) / 2;
        const f = 200 * Math.pow(30, m * p.de);
        const t = Math.tan(Math.PI * Math.min(f, RATE * 0.45) / RATE), a = (t - 1) / (t + 1);
        const s = this.st[ch], X = ch ? R : L;
        let v = this.fbv[ch];
        for (let j = i; j < e; j++) {
          let x = X[j] + v * fb;
          for (let k = 0; k < 6; k++) { const y = a * x + s[k]; s[k] = x - a * y; x = y; }
          v = x;
          X[j] = x;
        }
        this.fbv[ch] = v;
      }
      this.ph += inc * (e - i); if (this.ph > TAU) this.ph -= TAU;
    }
    this.mix(L, R, n, p.mx);
  }
}

class DelayDev extends Dev {
  constructor() { super(); this.d = new Delay(); this.oL = new Float32Array(128); this.oR = new Float32Array(128); }
  update() { this.d.set(SYNC_BEATS[Math.round(this.p.ti)] || 0.5, this.p.fb, this.p.to, this.bpm || 120, Math.round(this.p.pp)); }
  process(L, R, n) {
    this.oL.fill(0, 0, n); this.oR.fill(0, 0, n);
    this.d.process(L, R, this.oL, this.oR, n);
    for (let i = 0; i < n; i++) { L[i] += this.oL[i] * this.p.mx; R[i] += this.oR[i] * this.p.mx; }
  }
}

class ReverbDev extends Dev {
  constructor() { super(); this.r = new Reverb(); this.oL = new Float32Array(128); this.oR = new Float32Array(128); }
  update() { this.r.set(this.p.si, this.p.da, this.p.pr); }
  process(L, R, n) {
    this.oL.fill(0, 0, n); this.oR.fill(0, 0, n);
    this.r.process(L, R, this.oL, this.oR, n);
    const w = this.p.mx, d = 1 - w * 0.5;
    for (let i = 0; i < n; i++) { L[i] = L[i] * d + this.oL[i] * w; R[i] = R[i] * d + this.oR[i] * w; }
  }
}

class CrushDev extends Dev {
  constructor() { super(); this.hl = 0; this.hr = 0; this.c = 0; }
  process(L, R, n) {
    const p = this.p, q = Math.pow(2, p.bi - 1), ds = Math.max(1, p.ds);
    this.keepDry(L, R, n);
    for (let i = 0; i < n; i++) {
      if ((this.c += 1) >= ds) { this.c -= ds; this.hl = Math.round(L[i] * q) / q; this.hr = Math.round(R[i] * q) / q; }
      L[i] = this.hl; R[i] = this.hr;
    }
    this.mix(L, R, n, p.mx);
  }
}

class GateDev extends Dev {
  constructor() { super(); this.g = 0; this.env = 0; }
  process(L, R, n) {
    const p = this.p, th = dbg(p.th), fl = dbg(p.fl);
    const at = 1 - Math.exp(-1 / (p.at * 0.001 * RATE)), re = 1 - Math.exp(-1 / (p.re * 0.001 * RATE));
    for (let i = 0; i < n; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = Math.max(x, this.env * 0.9995);
      const want = this.env > th ? 1 : fl;
      this.g += (want - this.g) * (want > this.g ? at : re);
      L[i] *= this.g; R[i] *= this.g;
    }
    this.gr = -20 * Math.log10(Math.max(1e-4, this.g));
  }
}

const SLICES = [
  [1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 0, 1, 0, 1, 0, 1], [1, 1, 0, 1, 1, 0, 1, 1], [1, 0, 1, 1, 1, 0, 1, 1],
  [1, 0, 0, 1, 0, 0, 1, 0], [1, 1, 1, 1, 1, 0, 1, 0], [1, 0, 1, 0, 1, 1, 1, 1], null];
class SlicerDev extends Dev {                     // SLOOP's slicer: a tempo-locked volume pattern
  constructor() { super(); this.g = 1; this.rnd = [...Array(64)].map(() => Math.random() > 0.4 ? 1 : 0); }
  process(L, R, n, ctx) {
    const p = this.p, step = SYNC_BEATS[Math.round(p.ra)] || 0.25, pat = SLICES[Math.round(p.pa)];
    const dt = (ctx.bpm || 120) / 60 / RATE, k = 1 - Math.exp(-1 / ((0.0005 + p.sm * 0.02) * RATE));
    let pos = ctx.pos || 0;
    for (let i = 0; i < n; i++, pos += dt) {
      const s = Math.floor(pos / step), ph = (pos / step) % 1;
      const on = pat ? pat[s % 8] : this.rnd[s % 64];
      const want = on && ph < 0.75 ? 1 : 1 - p.de;
      this.g += (want - this.g) * k;
      L[i] *= this.g; R[i] *= this.g;
    }
  }
}

class UtilityDev extends Dev {
  constructor() { super(); this.lp = new Biquad(); this.mono = false; this.sl = new Float32Array(128); this.sr = new Float32Array(128); }
  update() { this.mono = this.p.bm > 21; this.lp.set('lp', this.p.bm, 0.707); }
  process(L, R, n) {
    const p = this.p, g = dbg(p.ga), w = p.wi, ph = Math.round(p.ph);
    const a = (p.pa + 1) * Math.PI / 4, gl = Math.cos(a) * Math.SQRT2, gr = Math.sin(a) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (ph & 1) l = -l; if (ph & 2) r = -r;
      const m = (l + r) / 2, s = (l - r) / 2 * w;
      L[i] = (m + s) * g * gl; R[i] = (m - s) * g * gr;
    }
    if (this.mono) {                              // the lows in mono: side under the cutoff removed
      const sl = this.sl, sr = this.sr;
      for (let i = 0; i < n; i++) { const s = (L[i] - R[i]) / 2; sl[i] = s; sr[i] = -s; }
      this.lp.run(sl, sr, n);
      for (let i = 0; i < n; i++) { L[i] -= sl[i]; R[i] -= sr[i]; }
    }
  }
}

class LimiterDev extends Dev {
  constructor() { super(); this.env = 1; }
  process(L, R, n) {
    const p = this.p, g = dbg(p.ga), ceil = dbg(p.ce), rel = 1 - Math.exp(-1 / (p.re * 0.001 * RATE));
    let env = this.env, minG = 1;
    for (let i = 0; i < n; i++) {
      const l = L[i] * g, r = R[i] * g, pk = Math.max(Math.abs(l), Math.abs(r));
      const want = pk > ceil ? ceil / pk : 1;
      env = want < env ? want : env + (want - env) * rel;
      L[i] = l * env; R[i] = r * env;
      if (env < minG) minG = env;
    }
    this.env = env;
    this.gr = Math.max(this.gr * 0.9, -20 * Math.log10(minG));
  }
}

// a rack: the chain of a track, a return or the master, kept in step with its definitions
export class Rack {
  constructor() { this.devs = new Map(); this.list = []; }
  sync(defs = [], bpm) {
    const keep = new Set();
    this.list = [];
    for (const d of defs) {
      let dev = this.devs.get(d.id);
      if (!dev || dev.type !== d.type) { dev = createDevice(d.type); if (!dev) continue; dev.type = d.type; this.devs.set(d.id, dev); }
      dev.def = d;
      dev.set({ ...d.p, ...(dev.auto || {}) }, bpm);
      keep.add(d.id);
      this.list.push(dev);
    }
    for (const id of this.devs.keys()) if (!keep.has(id)) this.devs.delete(id);
  }
  automate(fxId, key, v, bpm) {
    const dev = this.devs.get(fxId);
    if (!dev) return;
    dev.auto ||= {};
    if (dev.auto[key] === v) return;
    dev.auto[key] = v;
    dev.set({ ...dev.def.p, ...dev.auto }, bpm);
  }
  release(fxId, key, bpm) {                       // a modulation or automation lets go: back to the knob
    const dev = this.devs.get(fxId);
    if (!dev?.auto || !(key in dev.auto)) return;
    delete dev.auto[key];
    dev.set({ ...dev.def.p, ...dev.auto }, bpm);
  }
  process(L, R, n, ctx) { for (const d of this.list) if (d.def.on !== false) d.process(L, R, n, ctx); }
}
