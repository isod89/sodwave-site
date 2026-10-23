// SPDX-License-Identifier: GPL-3.0-only
// Audio assets: files people import or record. Decoded once to 44.1 kHz stereo floats, kept in
// memory and in IndexedDB (they outlive a reload), drawn from a peak summary.
import { RATE } from './engine-core.js';
import { tx } from './vault.js';

export const PEAK = 256;                       // frames per peak

export function peaks(L, R) {
  const n = Math.ceil(L.length / PEAK), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const e = Math.min(L.length, (i + 1) * PEAK);
    for (let j = i * PEAK; j < e; j++) { const a = Math.abs(L[j]), b = Math.abs(R[j]); if (a > m) m = a; if (b > m) m = b; }
    out[i] = m;
  }
  return out;
}

export async function decode(ctx, bytes) {
  const buf = await ctx.decodeAudioData(bytes);
  if (buf.sampleRate !== RATE) throw new Error('unexpected sample rate');
  const L = buf.getChannelData(0).slice(), R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
  return { L, R };
}

// ------------------------------------------------------------------ IndexedDB ---
// (vault.js holds the database: the projects, their earlier versions and these audio files)
export const storeAsset = (id, a) => tx('readwrite', (s) => s.put({ L: a.L, R: a.R, name: a.name }, id));
export const loadAsset = (id) => tx('readonly', (s) => s.get(id));

// --------------------------------------------------------------- tempo ---
// the tempo of a loop or a song: an onset envelope (spectral-ish flux of 512-frame energy),
// its autocorrelation over 70..180 BPM, the strongest lag (and its octave kept in range)
export function detectBpm(L, R) {
  const hop = 512, n = Math.floor(L.length / hop);
  if (n < 64) return null;
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) { const x = L[j] + R[j]; e += x * x; }
    e = Math.log1p(e * 100);
    env[i] = Math.max(0, e - prev); prev = e;
  }
  const fps = RATE / hop;
  let best = 0, bestBpm = null;
  for (let bpm = 70; bpm <= 180; bpm += 0.25) {
    const lag = 60 / bpm * fps, l0 = Math.floor(lag), fr = lag - l0;
    let s = 0;
    for (let i = 0; i + l0 + 1 < n; i++) s += env[i] * (env[i + l0] * (1 - fr) + env[i + l0 + 1] * fr);
    s /= (n - l0);
    if (s > best) { best = s; bestBpm = bpm; }
  }
  return bestBpm ? Math.round(bestBpm * 4) / 4 : null;
}

// ------------------------------------------------------------- stretch ---
// WSOLA: the audio ratio times longer (ratio > 1: slower), its pitch kept; semis transposes it
// (stretched by ratio * 2^(st/12), then resampled back). Overlapped 2048-frame grains, each placed
// where it best continues the last (cross-correlation over +-512 frames).
export function stretch(L, R, ratio, semis = 0) {
  const pitch = Math.pow(2, semis / 12), r = ratio * pitch;
  const N = 2048, H = N / 4, tol = 512;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const outLen = Math.ceil(L.length * r) + N;
  const oL = new Float32Array(outLen), oR = new Float32Array(outLen), norm = new Float32Array(outLen);
  let prevIn = 0;
  for (let out = 0; out + N < outLen; out += H) {
    const target = Math.round(out / r);
    let best = target, bestC = -Infinity;
    if (out > 0) {                                     // where the natural continuation of the last grain matches best
      const nat = prevIn + H;
      for (let d = -tol; d <= tol; d += 16) {
        const s = target + d;
        if (s < 0 || s + N >= L.length) continue;
        let c = 0;
        for (let i = 0; i < 256; i += 2) c += (L[s + i] + R[s + i]) * (L[nat + i] + R[nat + i] || 0);
        if (c > bestC) { bestC = c; best = s; }
      }
    }
    if (best < 0 || best + N >= L.length) { if (target + N >= L.length) break; best = Math.max(0, target); }
    for (let i = 0; i < N; i++) { const w = win[i]; oL[out + i] += L[best + i] * w; oR[out + i] += R[best + i] * w; norm[out + i] += w; }
    prevIn = best;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) { oL[i] /= norm[i]; oR[i] /= norm[i]; }
  if (pitch === 1) return { L: oL.subarray(0, Math.ceil(L.length * ratio)), R: oR.subarray(0, Math.ceil(L.length * ratio)) };
  const len = Math.floor(outLen / pitch), rL = new Float32Array(len), rR = new Float32Array(len);   // resample: the pitch
  for (let i = 0; i < len; i++) { const x = i * pitch, a = Math.floor(x), f = x - a; rL[i] = oL[a] + ((oL[a + 1] || 0) - oL[a]) * f; rR[i] = oR[a] + ((oR[a + 1] || 0) - oR[a]) * f; }
  return { L: rL.subarray(0, Math.ceil(L.length * ratio)), R: rR.subarray(0, Math.ceil(L.length * ratio)) };
}
