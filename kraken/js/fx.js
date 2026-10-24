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
      case 'ap': b0 = 1 - al; b1 = -2 * c; b2 = 1 + al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
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
    // nor crawl: a state decaying on silence is cut to zero before it goes denormal (ten times slower to compute)
    if (Math.abs(z[0]) + Math.abs(z[1]) < 1e-25) z[0] = z[1] = 0;
    if (Math.abs(z[2]) + Math.abs(z[3]) < 1e-25) z[2] = z[3] = 0;
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

// a 4-point cubic (Hermite) read between the samples of a power-of-two ring buffer (mask m), at position x
function cubic(b, m, x) {
  const i = x | 0, f = x - i, y0 = b[(i - 1) & m], y1 = b[i & m], y2 = b[(i + 1) & m], y3 = b[(i + 2) & m];
  const c1 = 0.5 * (y2 - y0), c3 = 1.5 * (y1 - y2) + 0.5 * (y3 - y0), c2 = y0 - y1 + c1 - c3;
  return ((c3 * f + c2) * f + c1) * f + y1;
}
const glide = (n) => n / (n + 256);              // a block's step of a smoothed knob (about 6 ms)
const softClip = (v) => (v > 1 ? 2 - 1 / v : v < -1 ? -2 - 1 / v : v);   // untouched under 1, never over 2

// ---------------------------------------------------------------------- devices ---
// parameter: [key, label, min, max, default, unit, curve ('log' | 'lin'), names?]
const P = (k, l, min, max, def, unit = '', curve = 'lin', names = null) => ({ k, l, min, max, def, unit, curve, names });
const SYNC = ['1/32', '1/16', '1/16.', '1/8', '1/8.', '1/4', '1/4.', '1/2', '1 BAR'];
const SYNC_BEATS = [0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 4];
const SWEEP = ['FREE', '1/16', '1/8', '1/4', '1/2', '1 BAR', '2 BARS', '4 BARS', '8 BARS'];
const SWEEP_BEATS = [0, 0.25, 0.5, 1, 2, 4, 8, 16, 32];

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
  mband: { name: 'MULTIBAND', params: [
    P('f1', 'LO/MID', 40, 1000, 200, 'Hz', 'log'), P('f2', 'MID/HI', 600, 12000, 2500, 'Hz', 'log'), P('ra', 'RATIO', 1, 20, 3, ':1', 'log'),
    P('at', 'ATTACK', 0.1, 100, 10, 'ms', 'log'), P('re', 'RELEASE', 10, 1000, 150, 'ms', 'log'), P('ou', 'OUTPUT', -12, 12, 0, 'dB'),
    P('t1', 'LO THR', -60, 0, -20, 'dB'), P('t2', 'MID THR', -60, 0, -20, 'dB'), P('t3', 'HI THR', -60, 0, -20, 'dB'),
    P('g1', 'LO GAIN', -12, 12, 0, 'dB'), P('g2', 'MID GAIN', -12, 12, 0, 'dB'), P('g3', 'HI GAIN', -12, 12, 0, 'dB')] },
  deess: { name: 'DE-ESSER', params: [P('fr', 'FREQ', 2000, 12000, 5500, 'Hz', 'log'), P('th', 'THRESH', -60, 0, -30, 'dB'), P('ra', 'RANGE', 0, 24, 10, 'dB'),
    P('ty', 'BAND', 0, 1, 0, '', 'lin', ['HIGH', 'BELL']), P('li', 'LISTEN', 0, 1, 0, '', 'lin', ['OFF', 'ON'])] },
  trans: { name: 'TRANSIENT', params: [P('at', 'ATTACK', -1, 1, 0, '%'), P('su', 'SUSTAIN', -1, 1, 0, '%'), P('al', 'ATK TIME', 5, 60, 20, 'ms', 'log'),
    P('sl', 'SUS TIME', 50, 1000, 300, 'ms', 'log'), P('ou', 'OUTPUT', -18, 18, 0, 'dB'), P('mx', 'MIX', 0, 1, 1, '%')] },
  flanger: { name: 'FLANGER', params: [P('ra', 'RATE', 0.02, 10, 0.25, 'Hz', 'log'), P('sy', 'SYNC', 0, 8, 0, '', 'lin', SWEEP), P('de', 'DEPTH', 0, 1, 0.7, '%'),
    P('dl', 'DELAY', 0.1, 10, 1, 'ms', 'log'), P('fb', 'FEEDBACK', -0.95, 0.95, 0.5, '%'), P('st', 'STEREO', 0, 180, 90, '°'), P('mx', 'MIX', 0, 1, 0.5, '%')] },
  pitch: { name: 'PITCH SHIFT', params: [P('st', 'PITCH', -12, 12, 0, 'st'), P('ce', 'FINE', -100, 100, 0, 'ct'), P('wi', 'WINDOW', 10, 100, 35, 'ms', 'log'), P('mx', 'MIX', 0, 1, 1, '%')] },
  space: { name: 'SPACE', params: [P('si', 'SIZE', 0, 1, 0.6, '%'), P('dc', 'DECAY', 0.2, 20, 2.5, 'sec', 'log'), P('da', 'DAMP', 0, 1, 0.4, '%'), P('pr', 'PREDELAY', 0, 0.25, 0.02, 's'),
    P('lc', 'LOW CUT', 20, 1000, 20, 'Hz', 'log'), P('mo', 'MOD', 0, 1, 0.5, '%'), P('wi', 'WIDTH', 0, 1, 1, '%'), P('mx', 'MIX', 0, 1, 0.3, '%')] },
  limiter: { name: 'LIMITER', params: [P('ga', 'GAIN', 0, 24, 0, 'dB'), P('ce', 'CEILING', -12, 0, -0.3, 'dB'), P('re', 'RELEASE', 10, 1000, 80, 'ms', 'log')] },
};
export const DEVICE_ORDER = ['eq', 'comp', 'mband', 'deess', 'trans', 'sat', 'filter', 'chorus', 'flanger', 'phaser', 'pitch', 'delay', 'reverb', 'space', 'crush', 'gate', 'slicer', 'utility', 'limiter'];

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
  if (p.unit === 'sec') return v < 10 ? `${v.toFixed(1)}s` : `${Math.round(v)}s`;
  if (p.unit === 'st' || p.unit === 'ct') return `${v > 0 ? '+' : ''}${Math.round(v)}${p.unit}`;
  if (p.unit === '°') return `${Math.round(v)}°`;
  if (p.k === 'pa' && p.min < 0) return Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
// 0..1 <-> a parameter's value, along its curve (knobs and controllers)
export const toNorm = (p, v) => (p.curve === 'log' ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min || 1));
export const fromNorm = (p, x) => {
  const v = p.curve === 'log' ? p.min * Math.pow(p.max / p.min, x) : p.min + x * (p.max - p.min);
  return p.names || p.k === 'bi' || p.unit === 'st' ? Math.round(v) : v;
};

// a device instance: set(params) when they change, process(L, R, n, ctx) per block
export function createDevice(type) {
  const C = { eq: EqDev, comp: CompDev, sat: SatDev, filter: FilterDev, chorus: ChorusDev, phaser: PhaserDev, delay: DelayDev, reverb: ReverbDev,
    crush: CrushDev, gate: GateDev, slicer: SlicerDev, utility: UtilityDev, limiter: LimiterDev,
    mband: MbandDev, deess: DeessDev, trans: TransDev, flanger: FlangerDev, pitch: PitchDev, space: SpaceDev }[type];
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

// ------------------------------------------------------------ dynamics, by band ---
// a band's detector: its level read every 4 samples (dB, linked stereo), a gain worked out and glided to
const TO_DB = 8.685889638065035, FROM_DB = -0.11512925464970229;   // (20 / ln 10; dB of reduction to a gain exponent)

class MbandDev extends Dev {                      // three bands (Linkwitz-Riley 24 dB/oct), each its own compressor
  constructor() {
    super();
    this.x = [...Array(9)].map(() => new Biquad());      // low: 2 LP + all-pass, the rest: 2 HP, then mid 2 LP, high 2 HP
    this.b = [...Array(6)].map(() => new Float32Array(128));
    this.env = new Float64Array(3).fill(-120); this.g = new Float64Array(3).fill(1); this.mk = null; this.f1 = 0; this.f2 = 0;
  }
  update() { const p = this.p; this.at = Math.exp(-4 / (p.at * 0.001 * RATE)); this.re = Math.exp(-4 / (p.re * 0.001 * RATE)); }
  // the crossovers: the low band goes through the high crossover's all-pass, so the three add up flat
  xover() {
    const [a, b, c, d, e, f, g, h, ap] = this.x, f1 = this.f1, f2 = this.f2, q = Math.SQRT1_2;
    a.set('lp', f1, q); b.set('lp', f1, q); c.set('hp', f1, q); d.set('hp', f1, q);
    e.set('lp', f2, q); f.set('lp', f2, q); g.set('hp', f2, q); h.set('hp', f2, q); ap.set('ap', f2, q);
  }
  process(L, R, n) {
    const p = this.p, x = this.x, b = this.b, lL = b[0], lR = b[1], mL = b[2], mR = b[3], hL = b[4], hR = b[5];
    // the crossover points glide (an automated sweep does not click), the high one kept over the low one
    const t1 = p.f1, t2 = Math.max(p.f2, p.f1 * 1.25);
    if (this.f1 !== t1 || this.f2 !== t2) {
      if (!this.f1) { this.f1 = t1; this.f2 = t2; }
      else {
        const k = glide(n); this.f1 *= Math.pow(t1 / this.f1, k); this.f2 *= Math.pow(t2 / this.f2, k);
        if (Math.abs(this.f1 / t1 - 1) < 1e-3 && Math.abs(this.f2 / t2 - 1) < 1e-3) { this.f1 = t1; this.f2 = t2; }
      }
      this.xover();
    }
    lL.set(L.subarray(0, n)); lR.set(R.subarray(0, n)); hL.set(L.subarray(0, n)); hR.set(R.subarray(0, n));
    x[0].run(lL, lR, n); x[1].run(lL, lR, n); x[8].run(lL, lR, n);
    x[2].run(hL, hR, n); x[3].run(hL, hR, n);
    mL.set(hL.subarray(0, n)); mR.set(hR.subarray(0, n));
    x[4].run(mL, mR, n); x[5].run(mL, mR, n); x[6].run(hL, hR, n); x[7].run(hL, hR, n);
    // each band's makeup (its gain and the output, in dB) glides from block to block
    const mk = this.mk ||= [p.g1 + p.ou, p.g2 + p.ou, p.g3 + p.ou], k = glide(n);
    mk[0] += (p.g1 + p.ou - mk[0]) * k; mk[1] += (p.g2 + p.ou - mk[1]) * k; mk[2] += (p.g3 + p.ou - mk[2]) * k;
    const at = this.at, re = this.re, slope = 1 - 1 / p.ra, kn = 6;
    let maxGr = 0;
    for (let band = 0; band < 3; band++) {
      const BL = this.b[band * 2], BR = this.b[band * 2 + 1], th = band === 0 ? p.t1 : band === 1 ? p.t2 : p.t3, gain = mk[band];
      let env = this.env[band], g0 = this.g[band];
      for (let i = 0; i < n; i += 4) {
        const e = i + 4 < n ? i + 4 : n;
        let pk = 0;
        for (let j = i; j < e; j++) { const a = Math.abs(BL[j]), b = Math.abs(BR[j]); if (a > pk) pk = a; if (b > pk) pk = b; }
        const lvl = TO_DB * Math.log(pk + 1e-9);
        env = lvl > env ? at * env + (1 - at) * lvl : re * env + (1 - re) * lvl;
        const over = env - th;
        let gr = 0;
        if (over > kn / 2) gr = over * slope; else if (over > -kn / 2) gr = slope * (over + kn / 2) ** 2 / (2 * kn);
        if (gr > maxGr) maxGr = gr;
        const g1 = Math.exp(FROM_DB * (gr - gain)), step = (g1 - g0) / (e - i);
        if (band === 0) for (let j = i; j < e; j++) { g0 += step; L[j] = BL[j] * g0; R[j] = BR[j] * g0; }
        else for (let j = i; j < e; j++) { g0 += step; L[j] += BL[j] * g0; R[j] += BR[j] * g0; }
        g0 = g1;
      }
      this.env[band] = Number.isFinite(env) ? env : -120;
      this.g[band] = Number.isFinite(g0) ? g0 : 1;
    }
    this.gr = Math.max(this.gr * 0.9, maxGr);
  }
}

class DeessDev extends Dev {                      // the sibilant band compressed alone: above FREQ (split) or around it (bell)
  constructor() {
    super();
    this.x = [...Array(4)].map(() => new Biquad()); this.bell = new Biquad();
    this.bL = new Float32Array(128); this.bR = new Float32Array(128); this.env = -120; this.g = 1;
    this.at = Math.exp(-4 / (0.0005 * RATE)); this.re = Math.exp(-4 / (0.06 * RATE));
  }
  update() { const p = this.p, q = Math.SQRT1_2; for (let i = 0; i < 4; i++) this.x[i].set(i < 2 ? 'lp' : 'hp', p.fr, q); this.bell.set('bp', p.fr, 1.4); }
  process(L, R, n) {
    const p = this.p, bL = this.bL, bR = this.bR, bell = Math.round(p.ty) === 1, listen = Math.round(p.li) === 1, x = this.x;
    bL.set(L.subarray(0, n)); bR.set(R.subarray(0, n));
    // split: the lows pass, the highs come back times the gain; bell: the band (in phase at its centre) taken out by 1 - gain
    if (bell) this.bell.run(bL, bR, n);
    else { x[2].run(bL, bR, n); x[3].run(bL, bR, n); x[0].run(L, R, n); x[1].run(L, R, n); }
    if (listen) { L.set(bL.subarray(0, n)); R.set(bR.subarray(0, n)); }      // (LISTEN: the band the detector hears)
    const at = this.at, re = this.re, th = p.th, range = p.ra, off = bell ? 1 : 0;
    let env = this.env, g0 = this.g, maxGr = 0;
    for (let i = 0; i < n; i += 4) {
      const e = i + 4 < n ? i + 4 : n;
      let pk = 0;
      for (let j = i; j < e; j++) { const a = Math.abs(bL[j]), b = Math.abs(bR[j]); if (a > pk) pk = a; if (b > pk) pk = b; }
      const lvl = TO_DB * Math.log(pk + 1e-9);
      env = lvl > env ? at * env + (1 - at) * lvl : re * env + (1 - re) * lvl;
      const over = env - th;                       // (5:1 over a 4 dB knee, no deeper than the range)
      let gr = over > 2 ? over * 0.8 : over > -2 ? 0.8 * (over + 2) ** 2 / 8 : 0;
      if (gr > range) gr = range;
      if (gr > maxGr) maxGr = gr;
      const g1 = Math.exp(FROM_DB * gr), step = (g1 - g0) / (e - i);
      if (!listen) for (let j = i; j < e; j++) { g0 += step; const c = g0 - off; L[j] += bL[j] * c; R[j] += bR[j] * c; }
      g0 = g1;
    }
    this.env = Number.isFinite(env) ? env : -120;
    this.g = Number.isFinite(g0) ? g0 : 1;
    this.gr = Math.max(this.gr * 0.9, maxGr);
  }
}

class TransDev extends Dev {                      // transient shaper: the gap between a fast and a slow envelope
  constructor() { super(); this.e = new Float64Array(4); this.g = 1; this.s = null; this.seg = new Float64Array(8); this.si = 0; this.cur = 0; this.cn = 0; this.held = 0; }
  // the level: the peak of the last 26 ms or so (8 segments of 128 samples and the one filling), so a steady low note
  // reads steady. Four followers of it, every 4 samples: attack = instant attack over slow attack (both release in 60 ms),
  // sustain = slow release over fast release (both catch a peak at once); their ratios in dB move the gain
  update() {
    const p = this.p, c = (ms) => Math.exp(-4 / (ms * 0.001 * RATE));
    this.cs = c(p.al); this.rf = c(40); this.rs = c(p.sl); this.ra = c(60);
  }
  process(L, R, n) {
    const p = this.p, e = this.e, seg = this.seg, cs = this.cs, rf = this.rf, rs = this.rs, ra = this.ra, k = glide(n);
    const s = this.s ||= { at: p.at, su: p.su, o: dbg(p.ou), m: p.mx };
    s.at += (p.at - s.at) * k; s.su += (p.su - s.su) * k; s.o += (dbg(p.ou) - s.o) * k; s.m += (p.mx - s.m) * k;
    const at = s.at * 0.5, su = s.su * 1.5, o = s.o, m = s.m;
    let a1 = e[0], a2 = e[1], s1 = e[2], s2 = e[3], g0 = this.g, cur = this.cur, cn = this.cn, held = this.held;
    for (let i = 0; i < n; i += 4) {
      const end = i + 4 < n ? i + 4 : n;
      let x = 0;
      for (let j = i; j < end; j++) { const a = Math.abs(L[j]), b = Math.abs(R[j]); if (a > x) x = a; if (b > x) x = b; }
      if (x > cur) cur = x;
      if ((cn += end - i) >= 128) {               // (a segment full: the window's peak worked out again)
        seg[this.si] = cur; this.si = (this.si + 1) & 7; cur = 0; cn = 0;
        held = 0; for (let q = 0; q < 8; q++) if (seg[q] > held) held = seg[q];
      }
      x = cur > held ? cur : held;
      a1 = x > a1 ? x : a1 * ra; a2 = x > a2 ? x + (a2 - x) * cs : a2 * ra;
      s1 = x > s1 ? x : s1 * rs; s2 = x > s2 ? x : s2 * rf;
      let dA = TO_DB * Math.log((a1 + 1e-5) / (a2 + 1e-5)) * at, dS = TO_DB * Math.log((s1 + 1e-5) / (s2 + 1e-5)) * su;
      dA = dA < -18 ? -18 : dA > 18 ? 18 : dA; dS = dS < -24 ? -24 : dS > 24 ? 24 : dS;
      // (the gain, the output and the mix in one: 1 + mix * (gain * output - 1); attack ±18 dB at most, sustain ±24)
      const g1 = 1 + m * (Math.exp(-FROM_DB * (dA + dS)) * o - 1), step = (g1 - g0) / (end - i);
      for (let j = i; j < end; j++) { g0 += step; L[j] *= g0; R[j] *= g0; }
      g0 = g1;
    }
    e[0] = a1 + 1e-30; e[1] = a2 + 1e-30; e[2] = s1 + 1e-30; e[3] = s2 + 1e-30;    // (never denormal)
    if (!(e[0] < 1e6 && e[1] < 1e6 && e[2] < 1e6 && e[3] < 1e6 && cur < 1e6 && held < 1e6)) { e.fill(0); seg.fill(0); cur = held = 0; }
    this.g = Number.isFinite(g0) ? g0 : 1; this.cur = cur; this.cn = cn; this.held = held;
  }
}

// ------------------------------------------------------------- modulation, pitch ---
const sweep = (base, sw, ph) => base * Math.exp(sw * (0.5 + 0.5 * Math.sin(TAU * ph)));   // (a flanger's delay at an LFO phase)
class FlangerDev extends Dev {                    // a short swept delay fed back (+ or -), the notches move by octaves
  constructor() { super(); this.L = new Float32Array(4096); this.R = new Float32Array(4096); this.w = 0; this.ph = 0; this.dL = 0; this.dR = 0; this.s = null; this.pos = -1; }
  // the delay times follow the LFO, worked out every 8 samples and glided between. Synced, the LFO runs at the note
  // length and is drawn (gently) into phase with the song while it plays
  process(L, R, n, ctx) {
    const p = this.p, BL = this.L, BR = this.R, k = glide(n);
    const s = this.s ||= { dl: p.dl, de: p.de, fb: p.fb, m: p.mx };
    const fbA = s.fb, mA = s.m;
    s.dl += (p.dl - s.dl) * k; s.de += (p.de - s.de) * k; s.fb += (p.fb - s.fb) * k; s.m += (p.mx - s.m) * k;
    const beats = SWEEP_BEATS[Math.round(p.sy)] || 0, bpm = ctx?.bpm || this.bpm || 120;
    const inc = beats ? bpm / (60 * beats * RATE) : p.ra / RATE;        // (turns per sample)
    let ph = this.ph;
    if (beats && ctx && ctx.pos !== this.pos) { let err = ctx.pos / beats - ph; err -= Math.round(err); ph += err * 0.02; }
    this.pos = ctx?.pos;
    const base = s.dl * 0.001 * RATE, sw = s.de * 3 * Math.LN2, off = p.st / 360;   // (up to 3 octaves of sweep)
    if (!this.dL) { this.dL = sweep(base, sw, ph); this.dR = sweep(base, sw, ph + off); }
    let w = this.w, dL = this.dL, dR = this.dR, fb = fbA, m = mA;
    const sfb = (s.fb - fbA) / n, sm = (s.m - mA) / n;
    for (let i = 0; i < n; i += 8) {
      const e = i + 8 < n ? i + 8 : n;
      ph += inc * (e - i); ph -= Math.floor(ph);
      const sl = (sweep(base, sw, ph) - dL) / (e - i), sr = (sweep(base, sw, ph + off) - dR) / (e - i);
      for (let j = i; j < e; j++) {
        dL += sl; dR += sr; fb += sfb; m += sm;
        let x = w - dL; if (x < 0) x += 4096;
        const yl = cubic(BL, 4095, x);
        x = w - dR; if (x < 0) x += 4096;
        const yr = cubic(BR, 4095, x);
        const xl = L[j], xr = R[j];
        BL[w] = softClip(xl + yl * fb); BR[w] = softClip(xr + yr * fb);
        w = (w + 1) & 4095;
        L[j] = xl + (yl - xl) * m; R[j] = xr + (yr - xr) * m;
      }
    }
    this.w = w; this.ph = ph; this.dL = dL; this.dR = dR;
    if (!Number.isFinite(dL + dR + ph)) { this.dL = this.dR = this.ph = 0; BL.fill(0); BR.fill(0); }
  }
}

class PitchDev extends Dev {                      // pitch shift: two grains read from a delay line, crossfaded
  constructor() {
    super();
    this.L = new Float32Array(8192); this.R = new Float32Array(8192); this.w = 0; this.s = null;
    this.pa = 0.5; this.pb = 0; this.da = 0; this.db = 0; this.seg = new Float32Array(128);
  }
  // each grain's read point slides at (1 - ratio) samples per sample through a window; where it wraps, its grain is
  // silent and the other (half a window away) plays. The weights add up to 1, with flat tops: a grain alone half the time
  process(L, R, n) {
    const p = this.p, BL = this.L, BR = this.R, k = glide(n);
    const ratio = Math.exp((p.st + p.ce / 100) * 0.057762265046662105);    // (ln 2 / 12)
    const s = this.s ||= { r: ratio, W: p.wi, m: p.mx };
    const mA = s.m;
    s.r += (ratio - s.r) * k; s.W += (p.wi - s.W) * k; s.m += (p.mx - s.m) * k;
    const W = s.W * 0.001 * RATE, S = W * 0.2, base = 3 + S, Si = S | 0;
    let inc = (1 - s.r) / W;
    // no shift: the grains drift (by less than a few cents) to where one plays alone, so nothing combs
    if (Math.abs(s.r - 1) < 1e-4) {
      const q = this.pa % 0.5, err = q < 0.25 ? -q : 0.5 - q, lim = 0.002 / W;
      inc += Math.max(-lim, Math.min(lim, err / n));
    }
    let w = this.w, pa = this.pa, pb = this.pb, da = this.da, db = this.db, m = mA;
    const sm = (s.m - mA) / n;
    for (let j = 0; j < n; j++) {
      BL[w] = L[j]; BR[w] = R[j];
      pa += inc; pb += inc;
      if (pa >= 1 || pa < 0) { pa -= Math.floor(pa); da = this.align(w, base + pa * W, base + pb * W + db, Si); }
      if (pb >= 1 || pb < 0) { pb -= Math.floor(pb); db = this.align(w, base + pb * W, base + pa * W + da, Si); }
      let t = 1.5 - 4 * Math.abs(pa - 0.5); t = t < 0 ? 0 : t > 1 ? 1 : t;    // (a flat top, smooth edges)
      const ga = t * t * (3 - 2 * t), gb = 1 - ga;
      let xa = w - Math.max(3, base + pa * W + da), xb = w - Math.max(3, base + pb * W + db);
      if (xa < 0) xa += 8192; if (xb < 0) xb += 8192;
      const yl = cubic(BL, 8191, xa) * ga + cubic(BL, 8191, xb) * gb, yr = cubic(BR, 8191, xa) * ga + cubic(BR, 8191, xb) * gb;
      m += sm;
      L[j] += (yl - L[j]) * m; R[j] += (yr - R[j]) * m;
      w = (w + 1) & 8191;
    }
    this.w = w; this.da = da; this.db = db;
    this.pa = Number.isFinite(pa) ? pa : 0.5; this.pb = Number.isFinite(pb) ? pb : 0;
  }
  // a grain starting again: its read point nudged (by up to a fifth of the window) to where its sound lines up best with
  // the grain playing (cross-correlation over 6 ms), so the crossfade joins two waves in phase: no beating, no pitch drift
  align(w, D, Do, S) {
    const BL = this.L, BR = this.R, seg = this.seg;
    let o = (w - Math.round(Do)) | 0, e = 0;
    for (let q = 0; q < 128; q++) { const i = (o - 2 * q) & 8191; e += Math.abs(seg[q] = BL[i] + BR[i]); }
    if (e < 1e-6) return 0;
    const at = w - Math.round(D);
    let best = -Infinity, bd = 0;
    for (let d = -S; d <= S; d += 2) { const c = this.corr(at - d); if (c > best) { best = c; bd = d; } }
    for (let d = bd - 1; d <= bd + 1; d += 2) if (d >= -S && d <= S) { const c = this.corr(at - d); if (c > best) { best = c; bd = d; } }
    return bd;
  }
  corr(b) { const BL = this.L, BR = this.R, seg = this.seg; let c = 0; for (let q = 0; q < 128; q++) { const i = (b - 2 * q) & 8191; c += seg[q] * (BL[i] + BR[i]); } return c; }
}

// -------------------------------------------------------------------- SPACE ---
// a feedback delay network: 8 delay lines mixed through a Hadamard matrix (lossless), each line losing exactly what
// its length costs over the decay time (lows) and more in the highs (damping). The input is pre-delayed, low-cut
// and smeared by 4 all-passes per side; the line lengths are slowly modulated so the tail never rings metallic.
const SPACE_LEN = [2003, 2243, 2477, 2791, 3089, 3433, 3803, 4241];    // (samples at full size)
const SPACE_AP = [[211, 159, 563, 411], [223, 167, 547, 397]], SPACE_G = [0.75, 0.75, 0.625, 0.625];
const SPACE_RATE = [0.31, 0.43, 0.53, 0.67, 0.73, 0.89, 1.03, 1.13];   // (Hz)
const SPACE_MOD = 12;                              // (the deepest modulation, samples)

class SpaceDev extends Dev {
  constructor() {
    super();
    this.buf = new Float32Array(8 << 13); this.w = 0;                  // the lines, 8192 samples each
    this.d = new Float64Array(8); this.st = new Float64Array(8); this.y = new Float64Array(8); this.lp = new Float64Array(8);
    this.a = new Float64Array(8); this.b = new Float64Array(8); this.len = new Float64Array(8);
    this.mph = Float64Array.from(SPACE_RATE, (_, i) => i * 0.785);
    this.ap = [...SPACE_AP[0], ...SPACE_AP[1]].map((len) => ({ b: new Float32Array(len), i: 0 }));
    this.pre = [new Float32Array(16384), new Float32Array(16384)]; this.pw = 0;
    this.hp = new Biquad(); this.iL = new Float32Array(128); this.iR = new Float32Array(128);
    this.size = -1; this.s = null;
  }
  update() { this.hp.set('hp', this.p.lc, Math.SQRT1_2); if (this.size >= 0) this.lens(); }
  // the line lengths at this size, and their losses: a one-pole per line, its gain at DC and at the top set by the decay
  lens() {
    const p = this.p, rt = p.dc * RATE, rtHi = rt * (1 - 0.92 * p.da), sc = 0.12 + 0.88 * this.size;
    for (let i = 0; i < 8; i++) {
      const len = this.len[i] = SPACE_LEN[i] * sc;
      const g0 = Math.exp(-6.907755278982137 * len / rt), gHi = Math.exp(-6.907755278982137 * len / rtHi);   // (-60 dB over rt)
      const a = (g0 - gHi) / (g0 + gHi);
      this.a[i] = a; this.b[i] = g0 * (1 - a);
    }
  }
  process(L, R, n) {
    const p = this.p, buf = this.buf, d = this.d, st = this.st, y = this.y, lp = this.lp, A = this.a, B = this.b, k = glide(n);
    if (this.size < 0) { this.size = p.si; this.lens(); for (let i = 0; i < 8; i++) d[i] = this.len[i] + SPACE_MOD; }
    else if (Math.abs(p.si - this.size) > 1e-5) { this.size += (p.si - this.size) * k; this.lens(); }
    const s = this.s ||= { m: p.mx, wi: p.wi, mo: p.mo };
    const mA = s.m, wA = s.wi;
    s.m += (p.mx - s.m) * k; s.wi += (p.wi - s.wi) * k; s.mo += (p.mo - s.mo) * k;
    // the input: pre-delayed, low-cut
    const iL = this.iL, iR = this.iR, pL = this.pre[0], pR = this.pre[1], pn = Math.max(1, Math.round(p.pr * RATE));
    let pw = this.pw;
    for (let j = 0; j < n; j++) { pL[pw] = L[j]; pR[pw] = R[j]; const r = (pw - pn) & 16383; iL[j] = pL[r]; iR[j] = pR[r]; pw = (pw + 1) & 16383; }
    this.pw = pw;
    this.hp.run(iL, iR, n);
    // the modulated lengths at the end of the block, glided to sample by sample
    const dep = s.mo * SPACE_MOD * (0.4 + 0.6 * this.size);
    for (let i = 0; i < 8; i++) {
      this.mph[i] += TAU * SPACE_RATE[i] * n / RATE; if (this.mph[i] > TAU) this.mph[i] -= TAU;
      st[i] = (this.len[i] + SPACE_MOD + dep * Math.sin(this.mph[i]) - d[i]) / n;
    }
    // dry and wet: an equal-power crossfade
    const h = Math.PI / 2, dry0 = Math.cos(mA * h), wet0 = Math.sin(mA * h);
    const sDry = (Math.cos(s.m * h) - dry0) / n, sWet = (Math.sin(s.m * h) - wet0) / n, sWi = (s.wi - wA) / n;
    let dry = dry0, wet = wet0, wi = wA, w = this.w;
    const ap = this.ap;
    for (let j = 0; j < n; j++) {
      let xl = iL[j] + 1e-20, xr = iR[j] + 1e-20;                    // (a hair of DC: nothing in the loop goes denormal)
      for (let q = 0; q < 4; q++) {
        const u = ap[q], v = ap[q + 4], g = SPACE_G[q];
        let z = u.b[u.i], t = xl - g * z; u.b[u.i] = t; xl = z + g * t; if (++u.i >= u.b.length) u.i = 0;
        z = v.b[v.i]; t = xr - g * z; v.b[v.i] = t; xr = z + g * t; if (++v.i >= v.b.length) v.i = 0;
      }
      for (let i = 0; i < 8; i++) {
        const di = d[i] += st[i];
        let r = w - di; if (r < 0) r += 8192;
        const ri = r | 0, f = r - ri, o = i << 13;                 // (a cubic read: little loss in the highs, pass after pass)
        const y0 = buf[o + ((ri - 1) & 8191)], y1 = buf[o + ri], y2 = buf[o + ((ri + 1) & 8191)], y3 = buf[o + ((ri + 2) & 8191)];
        const c1 = 0.5 * (y2 - y0), c3 = 1.5 * (y1 - y2) + 0.5 * (y3 - y0), c2 = y0 - y1 + c1 - c3;
        const yi = y[i] = ((c3 * f + c2) * f + c1) * f + y1;
        lp[i] = B[i] * yi + A[i] * lp[i];
      }
      // the Hadamard mix (fast: three rounds of butterflies), scaled to stay lossless; the input enters with mixed signs
      const a0 = lp[0] + lp[1], a1 = lp[0] - lp[1], a2 = lp[2] + lp[3], a3 = lp[2] - lp[3], a4 = lp[4] + lp[5], a5 = lp[4] - lp[5], a6 = lp[6] + lp[7], a7 = lp[6] - lp[7];
      const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3, b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
      const sc = 0.35355339059327373, inL = xl * 0.25, inR = xr * 0.25;
      buf[w] = (b0 + b4) * sc + inL; buf[8192 + w] = (b1 + b5) * sc + inR;
      buf[16384 + w] = (b2 + b6) * sc - inL; buf[24576 + w] = (b3 + b7) * sc + inR;
      buf[32768 + w] = (b0 - b4) * sc + inL; buf[40960 + w] = (b1 - b5) * sc - inR;
      buf[49152 + w] = (b2 - b6) * sc - inL; buf[57344 + w] = (b3 - b7) * sc - inR;
      w = (w + 1) & 8191;
      // out: two orthogonal sums of the lines, the diffused input bleeding in (the early part), then the width
      const oL = (y[0] - y[1] + y[2] - y[3] + y[4] - y[5] + y[6] - y[7]) * 0.5 + xl * 0.15;
      const oR = (y[0] + y[1] - y[2] - y[3] + y[4] + y[5] - y[6] - y[7]) * 0.5 + xr * 0.15;
      dry += sDry; wet += sWet; wi += sWi;
      const mid = (oL + oR) * 0.5, side = (oL - oR) * 0.5 * wi;
      L[j] = L[j] * dry + (mid + side) * wet; R[j] = R[j] * dry + (mid - side) * wet;
    }
    this.w = w;
    if (!(Math.abs(lp[0]) < 1e6)) { buf.fill(0); lp.fill(0); }      // (never: the loop is lossless at worst)
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
