// SPDX-License-Identifier: GPL-3.0-only
// Modulators: sources that move a track's parameters by themselves. An LFO, a random walk, an envelope
// on the track's notes, an envelope follower on any track's sound. Each one drives any number of targets
// (an engine parameter, an effect's knob, a note effect's knob, the volume, the pan, a send), by an amount
// from -100 % to +100 % of the target's range, on top of its knob or its automation. No DOM.
import { DEVICES, toNorm, fromNorm } from './fx.js';
import { NOTE_FX } from './notefx.js';

const P = (k, l, min, max, def, names = null, unit = '') => ({ k, l, min, max, def, names, unit });
export const MOD_RATES = [['8 BARS', 32], ['4 BARS', 16], ['2 BARS', 8], ['1 BAR', 4], ['1/2', 2], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/4T', 2 / 3], ['1/8T', 1 / 3], ['1/16T', 1 / 6]];
const RATE_NAMES = MOD_RATES.map((r) => r[0]);

export const MODS = {
  lfo: { name: 'LFO', params: [
    P('sh', 'SHAPE', 0, 5, 0, ['SINE', 'TRIANGLE', 'SAW UP', 'SAW DOWN', 'SQUARE', 'S & H']),
    P('sy', 'SYNC', 0, 1, 1, ['FREE', 'SYNC']), P('ra', 'RATE', 0, MOD_RATES.length - 1, 5, RATE_NAMES), P('hz', 'HZ', 0.02, 20, 1, null, 'Hz'),
    P('ph', 'PHASE', 0, 1, 0, null, '%'), P('rt', 'RETRIG', 0, 1, 0, ['OFF', 'NOTES'])] },
  random: { name: 'RANDOM', params: [P('ra', 'RATE', 0, MOD_RATES.length - 1, 7, RATE_NAMES), P('sm', 'SMOOTH', 0, 1, 0.5, null, '%'), P('bi', 'POLARITY', 0, 1, 1, ['UNI', 'BI'])] },
  env: { name: 'ENVELOPE', params: [P('at', 'ATTACK', 0, 2000, 5, null, 'ms'), P('de', 'DECAY', 1, 4000, 300, null, 'ms'), P('su', 'SUSTAIN', 0, 1, 0, null, '%'), P('re', 'RELEASE', 1, 4000, 200, null, 'ms')] },
  follow: { name: 'FOLLOWER', params: [P('at', 'ATTACK', 0.1, 200, 5, null, 'ms'), P('re', 'RELEASE', 5, 2000, 150, null, 'ms'), P('ga', 'GAIN', -24, 24, 0, null, 'dB')] },
};
export const MOD_ORDER = ['lfo', 'random', 'env', 'follow'];
export function modDefaults(type) { const o = {}; for (const p of MODS[type].params) o[p.k] = p.def; return o; }
export function fmtModParam(p, v) {
  if (p.names) return p.names[Math.round(v)] ?? String(v);
  if (p.unit === '%') return `${Math.round(v * 100)}%`;
  if (p.unit === 'Hz') return v < 1 ? v.toFixed(2) : v.toFixed(1);
  if (p.unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}`;
  if (p.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(0)}`;
  if (p.k === 'ga') return `${v > 0 ? '+' : ''}${Math.round(v)} dB`;
  return String(Math.round(v * 100) / 100);
}
// a value in [0, 1) from an integer: the same "random" values in every playback and every export
const hash = (k) => { let x = (k | 0) * 374761393 + 668265263; x = (x ^ (x >>> 13)) * 1274126177; x ^= x >>> 16; return (x >>> 0) / 4294967296; };

export class Modulator {
  constructor(def) { this.id = def.id; this.type = def.type; this.value = 0; this.env = 0; this.stage = 0; this.held = 0; this.noteAt = 0; this.hzPhase = 0; this.rnd = 0; this.fol = 0; this.set(def); }
  set(def) { this.def = def; this.p = { ...modDefaults(def.type), ...def.p }; this.on = def.on !== false; this.seed = [...def.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) | 0; }
  note(on) {
    if (on) { this.held++; this.noteAt = this.clock ?? 0; this.hzPhase = 0; this.stage = 1; }
    else if (this.held > 0 && --this.held === 0) this.stage = 3;
  }
  // one block: clock in beats (the song's, or a free one when stopped), dt in beats, sec in seconds; key: the follower's input level
  step(clock, dt, sec, key) {
    this.clock = clock;
    const p = this.p;
    if (this.type === 'lfo') {
      let ph;
      if (Math.round(p.sy)) { const len = MOD_RATES[Math.round(p.ra)][1]; ph = ((Math.round(p.rt) ? clock - this.noteAt : clock) / len) + p.ph; }
      else { this.hzPhase += p.hz * sec; ph = this.hzPhase + p.ph; }
      const cyc = Math.floor(ph), f = ph - cyc;
      switch (Math.round(p.sh)) {
        case 0: this.value = Math.sin(f * Math.PI * 2); break;
        case 1: this.value = f < 0.5 ? 4 * f - 1 : 3 - 4 * f; break;
        case 2: this.value = 2 * f - 1; break;
        case 3: this.value = 1 - 2 * f; break;
        case 4: this.value = f < 0.5 ? 1 : -1; break;
        default: this.value = hash(cyc + this.seed) * 2 - 1;
      }
    } else if (this.type === 'random') {
      const len = MOD_RATES[Math.round(p.ra)][1], k = Math.floor(clock / len), f = clock / len - k;
      const a = hash(k + this.seed), b = hash(k + 1 + this.seed);
      const sm = p.sm, x = sm > 0 && f > 1 - sm ? (f - (1 - sm)) / sm : 0, w = x * x * (3 - 2 * x);
      const v = a + (b - a) * w;
      this.value = Math.round(p.bi) ? v * 2 - 1 : v;
    } else if (this.type === 'env') {
      const ms = sec * 1000;
      if (this.stage === 1) { this.env += p.at > 0 ? ms / p.at : 1; if (this.env >= 1) { this.env = 1; this.stage = 2; } }
      else if (this.stage === 2) { this.env -= (1 - p.su) * ms / p.de; if (this.env <= p.su) this.env = p.su; }
      else if (this.stage === 3) { this.env -= Math.max(this.env, 0.001) * ms / p.re * 3; if (this.env <= 0.0005) { this.env = 0; this.stage = 0; } }
      this.value = this.env;
    } else if (this.type === 'follow') {
      const x = key * Math.pow(10, p.ga / 20), ms = sec * 1000;
      const k = x > this.fol ? 1 - Math.exp(-ms / Math.max(0.05, p.at)) : 1 - Math.exp(-ms / Math.max(1, p.re));
      this.fol += (x - this.fol) * k;
      this.value = Math.min(1, this.fol);
    }
    if (!this.on) this.value = 0;
    return this.value;
  }
}

// a target's range, and how a modulation lands on it: in the knob's own scale (log for frequencies)
export function applyMod(key, base, delta, t) {
  if (key.startsWith('fx:')) {
    const [, fxId, pk] = key.split(':'), d = t.fx?.find((x) => x.id === fxId), spec = d && DEVICES[d.type]?.params.find((x) => x.k === pk);
    if (!spec) return null;
    const v = fromNorm(spec, Math.max(0, Math.min(1, toNorm(spec, base ?? d.p[pk] ?? spec.def) + delta)));
    return spec.names ? Math.round(v) : v;
  }
  if (key.startsWith('nfx:')) {
    const [, fxId, pk] = key.split(':'), d = t.nfx?.find((x) => x.id === fxId), spec = d && NOTE_FX[d.type]?.params.find((x) => x.k === pk);
    if (!spec) return null;
    const v = Math.max(spec.min, Math.min(spec.max, (base ?? d.p[pk] ?? spec.def) + delta * (spec.max - spec.min)));
    return spec.names ? Math.round(v) : v;
  }
  return null;
}
