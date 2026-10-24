// SPDX-License-Identifier: GPL-3.0-only
// Warping: an audio file's time mapped onto the song's beats, by warp markers. Pure functions (page, worker, tests).
// - detectTransients: the attacks of the audio (spectral flux, adaptive threshold);
// - warp markers: [{ s: seconds in the file, b: beat of the file's own timeline }], sorted; between two markers the
//   audio is stretched evenly; outside them it runs at the clip's tempo (bpm);
// - autoMarkers: markers on the attacks that fall near a beat, to straighten a loose performance;
// - stretchWarp: the file rendered on the song's beats at the song's tempo, pitch kept (or shifted): a phase vocoder
//   with phase locking (tonal sound stays clean) and its phases reset on attacks (drums stay sharp).
const RATE = 44100;

// ------------------------------------------------------------------------------------------------- FFT ---
const fftCache = new Map();
function plan(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  const p = { rev, cos, sin };
  fftCache.set(n, p);
  return p;
}
// in place, complex; inverse: conjugate twiddles, scaled by 1 / n
export function fft(re, im, inverse = false) {
  const n = re.length, { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k], wi = inverse ? -sin[k] : sin[k];
        const a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const hann = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

// ----------------------------------------------------------------------------------------- transients ---
// -> seconds of each attack, in order
export function detectTransients(L, R = L, { sensitivity = 1 } = {}) {
  const N = 1024, H = 256, w = hann(N), frames = Math.max(0, Math.floor((L.length - N) / H));
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  const flux = new Float64Array(frames), energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * H;
    for (let i = 0; i < N; i++) { re[i] = (L[o + i] + R[o + i]) * 0.5 * w[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    let fl = 0, e = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      mag[k] = m; e += m;
      const d = m - prev[k];
      if (d > 0) fl += d * (1 + k / (N / 2));                       // (the highs weigh a little more: attacks)
    }
    flux[f] = fl; energy[f] = e; prev = mag;
  }
  const out = [], W = 10, minGap = Math.round(0.05 * RATE / H);
  let last = -1e9;
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, frames);
  const floor = Math.max(...flux.subarray(1)) * 0.08;               // (a steady sound's small wobbles are no attacks)
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;   // a peak
    let s = 0, c = 0;
    for (let j = Math.max(0, f - W); j <= Math.min(frames - 1, f + W); j++) { s += flux[j]; c++; }
    const th = (s / c) * 1.35 / sensitivity + mean * 0.4 / sensitivity;
    if (flux[f] <= th || flux[f] < floor || f - last < minGap) continue;
    // the sound must get louder (a steady sound's wobble moves energy between bins, it does not grow)
    const on = Math.round(refine(L, R, f * H + N / 2) * RATE);
    const lvl = (a, b) => { let m = 0; for (let i = Math.max(0, a); i < Math.min(L.length, b); i++) { const v = Math.abs(L[i]) + Math.abs(R[i]); if (v > m) m = v; } return m; };
    if (lvl(on, on + H) < (1 + 0.3 / sensitivity) * lvl(on - 3 * H, on - 16) + 1e-4) continue;
    last = f;
    out.push(on / RATE);
  }
  return out;
}

// the attack to the sample: in the window around the frame, where the short-term level jumps the most
function refine(L, R, centre) {
  const B = 64, a = Math.max(0, centre - 768), b = Math.min(L.length - B, centre + 512);
  let best = a, jump = 0, prev = 1e-6;
  for (let i = a; i < b; i += B / 2) {
    let e = 0;
    for (let j = i; j < i + B; j++) { const v = Math.abs(L[j]) + Math.abs(R[j]); if (v > e) e = v; }
    const r = (e + 1e-6) / (prev + 1e-4);
    if (r > jump) { jump = r; best = i; }
    prev = e;
  }
  return best / RATE;
}

// ------------------------------------------------------------------------------------------- the map ---
// seconds of the file at beat b of the file's own timeline (bpm: its tempo; markers sorted by b)
export function srcAt(b, markers, bpm) {
  const spb = 60 / bpm, m = markers || [];
  if (!m.length) return b * spb;
  if (b <= m[0].b) return m[0].s + (b - m[0].b) * spb;
  const last = m[m.length - 1];
  if (b >= last.b) return last.s + (b - last.b) * spb;
  let lo = 0, hi = m.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (m[mid].b <= b) lo = mid; else hi = mid; }
  const a = m[lo], c = m[hi];
  return a.s + (b - a.b) * (c.s - a.s) / Math.max(1e-9, c.b - a.b);
}
// the inverse: the beat where second s of the file plays
export function beatAt(s, markers, bpm) {
  const spb = 60 / bpm, m = markers || [];
  if (!m.length) return s / spb;
  if (s <= m[0].s) return m[0].b + (s - m[0].s) / spb;
  const last = m[m.length - 1];
  if (s >= last.s) return last.b + (s - last.s) / spb;
  let lo = 0, hi = m.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (m[mid].s <= s) lo = mid; else hi = mid; }
  const a = m[lo], c = m[hi];
  return a.b + (s - a.s) * (c.b - a.b) / Math.max(1e-9, c.s - a.s);
}
// markers kept sound: in order both ways, a little apart
export function cleanMarkers(markers) {
  const m = [...(markers || [])].filter((x) => Number.isFinite(x.s) && Number.isFinite(x.b) && x.s >= 0).sort((a, b) => a.b - b.b);
  const out = [];
  for (const x of m) { const p = out[out.length - 1]; if (p && (x.b - p.b < 1 / 32 || x.s - p.s < 0.005)) continue; out.push({ s: +x.s.toFixed(5), b: +x.b.toFixed(5) }); }
  return out;
}
// markers on the attacks near a beat (the first attack: beat 0 of the bar it starts), to follow a loose performance
export function autoMarkers(transients, bpm, { grid = 1, tolerance = 0.2 } = {}) {
  if (!transients.length) return [];
  const spb = 60 / bpm, t0 = transients[0], out = [{ s: t0, b: 0 }];
  let drift = 0;                                                    // (where the last marker put the beat: tempo wanders slowly)
  for (const s of transients.slice(1)) {
    const nominal = (s - t0) / spb + drift, q = Math.round(nominal / grid) * grid;
    if (Math.abs(nominal - q) <= tolerance * grid && q > out[out.length - 1].b) { out.push({ s, b: q }); drift = q - (s - t0) / spb; }
  }
  // the file starts at its own beat 0: everything shifts so the first attack sits on a whole beat
  const shift = Math.ceil(t0 / spb - 1e-9) - 0;
  return cleanMarkers(out.map((m) => ({ s: m.s, b: m.b + shift })));
}

// ---------------------------------------------------------------------------------------------- stretch ---
// L, R: the file. bpm: its tempo; songBpm: the song's; markers: the warp; semis: transposition, the length kept.
// -> { L, R }: the file laid on the song's beats (beat b of the file at b * 60 / songBpm seconds)
export function stretchWarp(L, R, { bpm, songBpm, markers = [], semis = 0, transients = null } = {}) {
  R ||= L;
  const pitch = Math.pow(2, semis / 12);
  const fileBeats = beatAt(L.length / RATE, markers, bpm);
  const outSec = fileBeats * 60 / songBpm;
  // with a transposition: stretched longer by the pitch ratio, then read faster (resampled)
  const N = 2048, Hs = 512, win = hann(N), half = N / 2;
  const outLen = Math.max(1, Math.ceil(outSec * RATE * pitch));
  const posAt = (k) => srcAt(((k * Hs) / pitch / RATE) * songBpm / 60, markers, bpm) * RATE;   // analysis centre of synthesis frame k
  const att = (transients || detectTransients(L, R)).map((s) => s * RATE);
  const oL = new Float64Array(outLen + N), oR = new Float64Array(outLen + N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const chans = [L, R].map(() => ({ prevPhase: new Float64Array(half + 1), synPhase: new Float64Array(half + 1), started: false }));
  const omega = new Float64Array(half + 1); for (let k = 0; k <= half; k++) omega[k] = 2 * Math.PI * k / N;
  const mag = new Float64Array(half + 1), ph = new Float64Array(half + 1), outPh = new Float64Array(half + 1);
  let ai = 0, prevPos = posAt(-1);
  const frames = Math.ceil(outLen / Hs) + 2;
  for (let k = 0; k < frames; k++) {
    const pos = posAt(k), Ha = pos - prevPos;
    prevPos = pos;
    // an attack in this hop: the phases start again from the file (no smearing)
    while (ai < att.length && att[ai] < pos - Math.abs(Ha)) ai++;
    const reset = ai < att.length && att[ai] <= pos + Math.max(Hs, Math.abs(Ha)) * 0.5 && att[ai] >= pos - Math.max(Hs, Math.abs(Ha)) * 0.5;
    const start = Math.round(pos) - half;
    [L, R].forEach((X, ci) => {
      const st = chans[ci];
      for (let i = 0; i < N; i++) { const j = start + i; re[i] = j >= 0 && j < X.length ? X[j] * win[i] : 0; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b <= half; b++) { mag[b] = Math.hypot(re[b], im[b]); ph[b] = Math.atan2(im[b], re[b]); }
      if (!st.started || reset) {
        for (let b = 0; b <= half; b++) outPh[b] = ph[b];
        st.started = true;
      } else {
        // the true frequency of each peak, its phase carried on; the bins around a peak keep their offset to it
        let b = 1;
        const peakOf = new Int32Array(half + 1).fill(-1);
        const peaks = [];
        for (b = 1; b < half; b++) if (mag[b] > mag[b - 1] && mag[b] >= mag[b + 1] && mag[b] > 1e-6) peaks.push(b);
        if (!peaks.length) peaks.push(1);
        // regions: each bin to the nearest peak (boundaries halfway between peaks)
        let pi = 0;
        for (b = 0; b <= half; b++) {
          while (pi < peaks.length - 1 && Math.abs(peaks[pi + 1] - b) < Math.abs(peaks[pi] - b)) pi++;
          peakOf[b] = peaks[pi];
        }
        const ha = Math.abs(Ha) > 1e-9 ? Ha : 1e-9;
        for (const p of peaks) {
          let d = ph[p] - st.prevPhase[p] - omega[p] * ha;
          d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
          const inst = omega[p] + d / ha;
          outPh[p] = st.synPhase[p] + inst * Hs;
        }
        for (b = 0; b <= half; b++) { const p = peakOf[b]; if (p !== b) outPh[b] = outPh[p] + ph[b] - ph[p]; }
      }
      for (let b = 0; b <= half; b++) { st.prevPhase[b] = ph[b]; st.synPhase[b] = outPh[b]; }
      // back to time: a real signal (mirror the spectrum), windowed again, added in
      for (let b = 0; b <= half; b++) { re[b] = mag[b] * Math.cos(outPh[b]); im[b] = mag[b] * Math.sin(outPh[b]); }
      for (let b = half + 1; b < N; b++) { re[b] = re[N - b]; im[b] = -im[N - b]; }
      fft(re, im, true);
      const O = ci ? oR : oL, at = k * Hs - half;
      for (let i = 0; i < N; i++) { const j = at + i; if (j >= 0 && j < O.length) O[j] += re[i] * win[i]; }
    });
  }
  const norm = 1 / 1.5;                                              // (hann² at a quarter hop sums to 1.5)
  const n = Math.max(1, Math.round(outSec * RATE)), rL = new Float32Array(n), rR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * pitch, a = Math.floor(x), f = x - a;
    rL[i] = ((oL[a] || 0) + ((oL[a + 1] || 0) - (oL[a] || 0)) * f) * norm;
    rR[i] = ((oR[a] || 0) + ((oR[a + 1] || 0) - (oR[a] || 0)) * f) * norm;
  }
  return { L: rL, R: rR };
}
