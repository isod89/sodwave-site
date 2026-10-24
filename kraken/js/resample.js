// SPDX-License-Identifier: GPL-3.0-only
// Sample-rate conversion for export (44.1 kHz to 48 or 96 kHz, or back): a polyphase windowed-sinc filter
// (Kaiser window, 32 zero crossings each side), its cutoff just under the lower Nyquist. Rational ratios use
// a table of phases; anything else interpolates between 512 phases.
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; } return s; }

// the phases of the filter: taps[p * W + j], the j-th tap for fractional position p / P
function table(P, half, cut, beta) {
  const W = half * 2, taps = new Float32Array(P * W), i0 = bessel0(beta);
  for (let p = 0; p < P; p++) {
    const frac = p / P;
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const x = j - half + 1 - frac;                      // the distance (input samples) from the output point
      const s = x === 0 ? 1 : Math.sin(Math.PI * cut * x) / (Math.PI * cut * x);
      const r = x / half, w = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0;
      taps[p * W + j] = s * w * cut; sum += taps[p * W + j];
    }
    for (let j = 0; j < W; j++) taps[p * W + j] /= sum;   // unity gain at DC on every phase
  }
  return taps;
}

// one channel from rate `from` to rate `to`
export function resample(x, from, to, { half = 32, beta = 9 } = {}) {
  if (from === to) return x.slice();
  const g = gcd(from, to), up = to / g, down = from / g;
  const P = up <= 1024 ? up : 512, cut = Math.min(1, to / from) * 0.97;
  const taps = table(P, half, cut, beta), W = half * 2;
  const n = Math.floor(x.length * to / from), y = new Float32Array(n), N = x.length;
  for (let k = 0; k < n; k++) {
    // the output point k sits at input position k * from / to
    let i0, p;
    if (P === up) { const num = k * down; i0 = Math.floor(num / up); p = num - i0 * up; }
    else { const pos = k * from / to; i0 = Math.floor(pos); p = Math.round((pos - i0) * P); if (p === P) { p = 0; i0++; } }
    const base = p * W, s0 = i0 - half + 1;
    let acc = 0;
    if (s0 >= 0 && s0 + W <= N) for (let j = 0; j < W; j++) acc += x[s0 + j] * taps[base + j];
    else for (let j = 0; j < W; j++) { const i = s0 + j; if (i >= 0 && i < N) acc += x[i] * taps[base + j]; }
    y[k] = acc;
  }
  return y;
}
