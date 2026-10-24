// SPDX-License-Identifier: GPL-3.0-only
// Time signatures: a song can change metre (4/4, then a bar of 7/8, then 6/8…). Times stay in quarter-note beats;
// a bar of n/d lasts n * 4 / d beats. p.meters: [{ t: beat, n, d }], each change on a bar line; none: p.sig / 4.
// Pure functions, for the page, the engine and the tests.
export const DENOMS = [1, 2, 4, 8, 16];

// the changes in force, each with the bar it starts: [{ t, n, d, len, bar }]
export function meterList(p) {
  const list = Array.isArray(p.meters) ? p.meters.filter((m) => m && m.t > 1e-9) : [];
  const first = (Array.isArray(p.meters) && p.meters.find((m) => m && m.t <= 1e-9)) || { t: 0, n: Math.round(p.sig || 4), d: 4 };
  const out = [{ t: 0, n: first.n, d: first.d, len: (first.n * 4) / first.d, bar: 0 }];
  for (const m of [...list].sort((a, b) => a.t - b.t)) {
    const prev = out[out.length - 1];
    const bars = Math.max(1, Math.round((m.t - prev.t) / prev.len));   // (a change sits on a bar line of the metre before it)
    const t = prev.t + bars * prev.len;
    if (prev.n === m.n && prev.d === m.d) continue;
    out.push({ t, n: m.n, d: m.d, len: (m.n * 4) / m.d, bar: prev.bar + bars });
  }
  return out;
}
const at = (L, beat) => { let i = L.length - 1; while (i > 0 && L[i].t > beat + 1e-9) i--; return L[i]; };
// the bar holding a beat: its number (0 = the first), start, length, signature, and where the beat is in it
export function barOf(p, beat, L = meterList(p)) {
  const m = at(L, Math.max(0, beat)), k = Math.floor((Math.max(0, beat) - m.t) / m.len + 1e-9);
  const start = m.t + k * m.len;
  return { bar: m.bar + k, start, len: m.len, n: m.n, d: m.d, inBar: beat - start };
}
export function barStart(p, bar, L = meterList(p)) {
  let m = L[0];
  for (const x of L) if (x.bar <= bar) m = x;
  return m.t + (bar - m.bar) * m.len;
}
export const floorBar = (p, beat, L) => barOf(p, beat, L).start;
export const nextBar = (p, beat, L) => { const b = barOf(p, beat, L); return b.start + b.len; };
export const prevBar = (p, beat, L) => { const b = barOf(p, beat - 1e-6, L); return beat - b.start < 0.01 ? (b.bar > 0 ? barStart(p, b.bar - 1, L) : 0) : b.start; };
export const barLen = (p, beat, L) => barOf(p, beat, L).len;
// "bar.beat.sixteenth" (the beat in the signature's own unit: an eighth in 7/8)
export function posLabel(p, beat, L) {
  const b = barOf(p, beat + 1e-6, L), unit = 4 / b.d, beatN = Math.floor(b.inBar / unit + 1e-6);
  const six = Math.floor(((b.inBar - beatN * unit) / 0.25) + 1e-6);
  return `${String(b.bar + 1).padStart(3, '0')}.${beatN + 1}.${six + 1}`;
}
// a beat as a bar number for people: 1, 2.5…
export const barLabel = (p, beat, L) => { const b = barOf(p, beat, L); return +(b.bar + 1 + b.inBar / b.len).toFixed(2); };
// the bar lines between two beats: [{ t, bar, n, d, change }]
export function barLines(p, a, b, L = meterList(p)) {
  const out = [];
  let x = barOf(p, Math.max(0, a), L);
  let t = x.start, bar = x.bar;
  while (t <= b + 1e-9 && out.length < 20000) {
    const m = at(L, t);
    out.push({ t, bar, n: m.n, d: m.d, change: L.some((q) => Math.abs(q.t - t) < 1e-9 && q.t > 0) });
    t += m.len; bar++;
  }
  return out;
}
// the beats of the signature (its own unit) between two beats, for grids and the metronome: [{ t, down }]
export function beatLines(p, a, b, L = meterList(p)) {
  const out = [];
  for (const bl of barLines(p, a, b, L)) {
    const unit = 4 / bl.d;
    for (let k = 0; k < bl.n; k++) { const t = bl.t + k * unit; if (t >= a - 1e-9 && t <= b + 1e-9) out.push({ t, down: k === 0 }); }
  }
  return out;
}
// repaired: in order, on bar lines, sane values; the first one (if at 0) also sets p.sig
export function cleanMeters(p) {
  const raw = Array.isArray(p.meters) ? p.meters : [];
  const ok = raw.filter((m) => m && Number.isFinite(m.t) && m.t >= 0 && Number.isInteger(m.n) && m.n >= 1 && m.n <= 32 && DENOMS.includes(m.d));
  if (!ok.length) return [];
  const L = meterList({ ...p, meters: ok });
  return L.length === 1 && L[0].d === 4 && L[0].n === Math.round(p.sig || 4) ? [] : L.map(({ t, n, d }) => ({ t, n, d }));
}
