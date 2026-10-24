// SPDX-License-Identifier: GPL-3.0-only
// Audio to MIDI (no DOM: tested in Node):
// - MELODY: a voice, a bass, a lead (one note at a time): its pitch followed (YIN), held pitches become notes, their
//   level the velocity;
// - DRUMS: the attacks (warp.js) and the band each one is strongest in: kick, snare, hat;
// - CHORDS would need polyphonic analysis: not here.
// Times in seconds; the caller turns them into beats.
import { detectTransients, fft } from './warp.js';

const RATE = 44100;

// the pitch of a frame (YIN, cumulative mean normalised difference): -> { hz, clarity } or null
export function yin(x, at, W = 2048, minHz = 50, maxHz = 1400, thr = 0.15, rate = RATE) {
  const tauMin = Math.floor(rate / maxHz), tauMax = Math.min(Math.floor(rate / minHz), W / 2);
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W / 2; i++) { const a = x[at + i] - x[at + i + tau]; s += a * a; }
    d[tau] = s;
  }
  let run = 0, best = -1;
  for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; d[tau] = run ? (d[tau] * tau) / run : 1; }
  for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < thr) { while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++; best = tau; break; }   // the first dip, to its bottom
  if (best < 0) return null;
  const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best], den = a - 2 * b + c;
  const t = den ? best + (a - c) / (2 * den) : best;                 // (between two lags)
  return { hz: rate / t, clarity: 1 - b };
}

export function melodyToNotes(L, R = L, { minDur = 0.06 } = {}) {
  // the mono signal at a quarter of the rate (11 025 Hz: pitches up to 1.4 kHz, four times less work), low-passed first
  const D = 4, rate = RATE / D, n = Math.floor(L.length / D), x = new Float32Array(n);
  let a = 0, b = 0;
  for (let i = 0, j = 0; j < n; j++) for (let k = 0; k < D; k++, i++) { const v = (L[i] + R[i]) * 0.5; a += 0.35 * (v - a); b += 0.35 * (a - b); if (k === D - 1) x[j] = b; }
  const H = 64, W = 512, frames = [];
  for (let at = 0; at + W < n; at += H) {
    let e = 0; for (let i = 0; i < W / 2; i++) e += x[at + i] * x[at + i];
    const rms = Math.sqrt(e / (W / 2)), p = rms > 0.01 ? yin(x, at, W, 50, 1400, 0.15, rate) : null;
    frames.push({ t: at / rate, midi: p ? 69 + 12 * Math.log2(p.hz / 440) : null, rms });
  }
  const hop = H / rate;
  // notes: runs of frames on the same semitone (a frame's wobble under half a semitone kept)
  const notes = [];
  let cur = null;
  const close = () => { if (cur && cur.end - cur.t >= minDur) notes.push({ t: cur.t, d: cur.end - cur.t, n: Math.round(median(cur.pitches)), v: Math.max(1, Math.min(127, Math.round(40 + 87 * Math.min(1, cur.peak * 3)))) }); cur = null; };
  for (const f of frames) {
    const k = f.midi == null ? null : Math.round(f.midi);
    if (k == null) { close(); continue; }
    if (cur && Math.abs(f.midi - median(cur.pitches)) < 0.6) { cur.end = f.t + hop; cur.pitches.push(f.midi); cur.peak = Math.max(cur.peak, f.rms); }
    else { close(); cur = { t: f.t, end: f.t + hop, pitches: [f.midi], peak: f.rms }; }
  }
  close();
  return notes;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// drums: each attack, and which band it is loudest in: low (kick 36), mid (snare 38), high (hat 42)
export function drumsToNotes(L, R = L, { sensitivity = 1 } = {}) {
  const hits = detectTransients(L, R, { sensitivity });
  const N = 1024, re = new Float64Array(N), im = new Float64Array(N), out = [];
  const band = (lo, hi) => { let s = 0; for (let k = Math.floor(lo / RATE * N); k < Math.ceil(hi / RATE * N); k++) s += Math.hypot(re[k], im[k]); return s / Math.max(1, Math.ceil(hi / RATE * N) - Math.floor(lo / RATE * N)); };
  let peakAll = 1e-9;
  const raw = [];
  for (const h of hits) {
    const at = Math.floor((h.t ?? h) * RATE);
    if (at + N >= L.length) continue;
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = (L[at + i] + R[at + i]) * 0.5 * w; im[i] = 0; }
    fft(re, im);
    const low = band(30, 150), mid = band(150, 2500), high = band(5000, 16000);
    let pk = 0; for (let i = 0; i < 512; i++) pk = Math.max(pk, Math.abs(L[at + i]), Math.abs(R[at + i]));
    peakAll = Math.max(peakAll, pk);
    raw.push({ t: at / RATE, low, mid, high, pk });
  }
  for (const r of raw) {
    const n = r.low > r.mid * 1.2 && r.low > r.high * 2 ? 36 : r.high > r.mid * 0.8 && r.high > r.low ? 42 : 38;
    out.push({ t: r.t, d: 0.1, n, v: Math.max(30, Math.min(127, Math.round(127 * Math.sqrt(r.pk / peakAll)))) });
  }
  return out;
}
