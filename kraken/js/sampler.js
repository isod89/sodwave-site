// SPDX-License-Identifier: GPL-3.0-only
// The sampler's voices (no DOM: the engine, the export and the tests share it).
// - KEYS: one sample across the keyboard, or ZONES: several samples, each on its own keys and velocities (a
//   multi-sampled piano, layers soft and hard), each pitched from its root;
// - SLICE: one sample cut in equal slices, one a key from C2;
// - PADS: one sample a note, one-shot (a drum rack, or a drum track's pads with your own samples), with choke groups.
// Every voice: an ADSR envelope, a resonant low-pass filter that can follow the envelope, velocity.
const RATE = 44100, BLOCK = 32;
const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

// the zone a note plays: explicit zones (key range, velocity range), else the sample itself
export function zoneFor(s, n, vel) {
  if (Array.isArray(s.zones) && s.zones.length) {
    const hit = s.zones.filter((z) => n >= (z.lo ?? 0) && n <= (z.hi ?? 127) && vel >= (z.vlo ?? 1) && vel <= (z.vhi ?? 127));
    if (hit.length) return hit[0];
    // no zone holds it: the nearest root (a gap between zones still plays)
    return [...s.zones].sort((a, b) => Math.abs(a.root - n) - Math.abs(b.root - n))[0];
  }
  return s.src ? { src: s.src, root: s.root ?? 60, gain: 0, tune: 0 } : null;
}
// zones from files named with their note (Piano_C4.wav, Rhodes-A#2-soft.wav, 60.wav): each a root, the keys between
// two roots split halfway; a name with soft / pp / p, hard / ff / f: a velocity layer
export function zonesFromNames(files) {
  const NOTE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const parse = (name) => {
    const base = name.replace(/\.[a-z0-9]+$/i, '');
    const m = base.match(/(?:^|[^a-z])([a-g])(#|b|s)?(-?\d)(?![0-9])/i);
    if (m) return 12 * (+m[3] + 1) + NOTE[m[1].toLowerCase()] + (m[2] === '#' || m[2] === 's' ? 1 : m[2] === 'b' ? -1 : 0);
    const k = base.match(/(?:^|\D)(\d{2,3})(?:\D|$)/);
    return k && +k[1] <= 127 ? +k[1] : null;
  };
  // (p and f alone only as a word of their own: the F of F3 is a note)
  const layer = (name) => { const b = name.replace(/\.[a-z0-9]+$/i, ''); return /(^|[^a-z0-9])(soft|pp|p|mp|quiet|low)([^a-z0-9#]|$)/i.test(b) ? 'soft' : /(^|[^a-z0-9])(hard|ff|f|loud|high)([^a-z0-9#]|$)/i.test(b) ? 'hard' : 'all'; };
  const list = files.map((f) => ({ ...f, root: parse(f.name), layer: layer(f.name) })).filter((f) => f.root != null);
  const layers = [...new Set(list.map((f) => f.layer))];
  const out = [];
  for (const ly of layers) {
    const zs = list.filter((f) => f.layer === ly).sort((a, b) => a.root - b.root);
    zs.forEach((z, i) => {
      const lo = i === 0 ? 0 : Math.floor((zs[i - 1].root + z.root) / 2) + 1, hi = i === zs.length - 1 ? 127 : Math.floor((z.root + zs[i + 1].root) / 2);
      const [vlo, vhi] = layers.length < 2 || ly === 'all' ? [1, 127] : ly === 'soft' ? [1, 80] : [81, 127];
      out.push({ src: z.src, name: z.name, root: z.root, lo, hi, vlo, vhi, gain: 0, tune: 0 });
    });
  }
  return out;
}

export class Sampler {
  constructor() { this.v = []; }
  // a note of a KEYS / ZONES / SLICE sampler (def.sample)
  noteOn(def, assets, n, vel) {
    const s = def.sample || {};
    const z = s.mode === 'slice' ? (s.src ? { src: s.src, root: 60 } : null) : zoneFor(s, n, vel);
    const a = z && assets.get(z.src);
    if (!a) return;
    const len = a.L.length, zoned = Array.isArray(s.zones) && s.zones.length;
    const st = zoned ? 0 : Math.floor((s.start ?? 0) * len), en = zoned ? len : Math.max(st + 64, Math.floor((s.end ?? 1) * len));
    let from = st, to = en, rate = 1;
    if (s.mode === 'slice') {
      const k = n - 36, cnt = Math.max(1, s.slices || 16);
      if (k < 0 || k >= cnt) return;
      const w = (en - st) / cnt;
      from = Math.floor(st + k * w); to = Math.floor(st + (k + 1) * w);
    } else rate = Math.pow(2, (n - (z.root ?? 60) + ((s.tune || 0) + (z.tune || 0)) / 100) / 12);
    this.push({ n, a, pos: from, to, from, rate, g: (vel / 127) ** 1.4 * dbToGain(z.gain || 0), loop: s.mode !== 'slice' && s.loop, s });
  }
  // a pad: one sample, one-shot (pad: { src, gain, tune (semitones), dec (ms, 0: the whole sample), choke, start, end })
  padOn(pad, a, n, vel) {
    if (!a) return;
    const len = a.L.length, st = Math.floor((pad.start ?? 0) * len), en = Math.max(st + 64, Math.floor((pad.end ?? 1) * len));
    if (pad.choke) for (const v of this.v) if (v.choke === pad.choke) v.cut = true;          // a closed hat stops the open one
    this.push({ n, a, pos: st, to: en, from: st, rate: Math.pow(2, (pad.tune || 0) / 12), g: (vel / 127) ** 1.2 * dbToGain(pad.gain || 0), oneShot: true, choke: pad.choke || 0,
      s: { att: 0.5, dec: pad.dec || 0, sus: pad.dec ? 0 : 1, rel: pad.dec ? Math.max(5, pad.dec * 0.3) : 30, cut: pad.cut ?? 20000, res: pad.res ?? 0 } });
  }
  push(v) {
    if (this.v.length >= 32) this.v.shift();
    this.v.push({ ...v, env: 0, stage: 0, f1: [0, 0], f2: [0, 0], t: 0 });
  }
  noteOff(n) { for (const v of this.v) if (v.n === n && !v.oneShot) v.stage = 3; }
  // the voices into out (interleaved stereo, BLOCK frames), added (add) or alone
  render(def, out, add = false) {
    if (!add) out.fill(0);
    if (!this.v.length) return;
    const gs = dbToGain(def?.sample?.gain || 0);
    for (const v of this.v) {
      const s = v.s || {}, L = v.a.L, R = v.a.R || v.a.L;
      const att = 1 / Math.max(1, (s.att ?? 2) * 0.001 * RATE), dec = s.dec ? 1 / Math.max(1, s.dec * 0.001 * RATE) : 0, sus = s.sus ?? 1;
      const rel = 1 / Math.max(1, (s.rel ?? 120) * 0.001 * RATE);
      // the filter: a zero-delay-feedback state-variable low-pass (stable at any cutoff), its cutoff moved by the
      // envelope (FILTER ENV, in octaves)
      const cut0 = Math.max(30, Math.min(20000, s.cut ?? 20000)), fenv = s.fenv || 0, kq = 2 - 2 * Math.min(0.95, s.res || 0);
      const filt = cut0 < 19900 || fenv > 0;
      const k = (v.oneShot ? 1 : gs) * v.g;
      for (let i = 0; i < BLOCK; i++) {
        if (v.pos >= v.to - 1) { if (v.loop) v.pos = v.from; else { v.done = true; break; } }
        if (v.cut) { v.env -= 1 / (0.005 * RATE); if (v.env <= 0) { v.done = true; break; } }
        else if (v.stage === 0) { v.env += att; if (v.env >= 1) { v.env = 1; v.stage = dec ? 1 : 2; } }
        else if (v.stage === 1) { v.env -= dec * (1 - sus); if (v.env <= sus) { v.env = sus; v.stage = 2; } if (v.env <= 0.0005 && v.oneShot) { v.done = true; break; } }
        else if (v.stage === 3) { v.env -= rel; if (v.env <= 0) { v.done = true; break; } }
        const p0 = Math.floor(v.pos), f = v.pos - p0;
        let l = L[p0] + ((L[p0 + 1] ?? L[p0]) - L[p0]) * f, r = R[p0] + ((R[p0 + 1] ?? R[p0]) - R[p0]) * f;
        if (filt) {
          if ((v.t++ & 7) === 0) {
            const fc = Math.min(19000, cut0 * Math.pow(2, fenv * v.env)), g = Math.tan(Math.PI * fc / RATE);
            v.a1 = 1 / (1 + g * (g + kq)); v.a2 = g * v.a1; v.a3 = g * v.a2;
          }
          const a1 = v.a1, a2 = v.a2, a3 = v.a3, f1 = v.f1, f2 = v.f2;        // (f1, f2: the two integrators, per side)
          let v3 = l - f2[0], v1 = a1 * f1[0] + a2 * v3, v2 = f2[0] + a2 * f1[0] + a3 * v3;
          f1[0] = 2 * v1 - f1[0]; f2[0] = 2 * v2 - f2[0]; l = v2;
          v3 = r - f2[1]; v1 = a1 * f1[1] + a2 * v3; v2 = f2[1] + a2 * f1[1] + a3 * v3;
          f1[1] = 2 * v1 - f1[1]; f2[1] = 2 * v2 - f2[1]; r = v2;
        }
        out[i * 2] += l * v.env * k; out[i * 2 + 1] += r * v.env * k;
        v.pos += v.rate;
      }
    }
    this.v = this.v.filter((v) => !v.done);
  }
}
