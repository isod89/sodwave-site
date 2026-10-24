// SPDX-License-Identifier: GPL-3.0-only
// Comping: an audio clip can hold several takes of the same passage (a take folder). Its comp says which
// take plays where: segments { a, b, k } in beats from the clip's start, take k from a to b.
// A take: { src, at, offset, name }: its audio starts playing `offset` seconds in at beat `at` of the clip.
// Pure functions, shared by the UI, the engine and the tests.

export const isFolder = (c) => !!(c && Array.isArray(c.takes) && c.takes.length && Array.isArray(c.comp));

// a plain audio clip becomes a folder of one take
export function toFolder(c) {
  if (isFolder(c)) return c;
  c.takes = [{ src: c.src, at: 0, offset: c.offset || 0, name: c.name }];
  c.comp = [{ a: 0, b: c.len, k: 0 }];
  return c;
}

// take k plays from a to b; what was there is cut around it; neighbours of the same take merge
export function setComp(comp, a, b, k) {
  if (b - a < 1e-6) return comp;
  const out = [];
  for (const s of comp) {
    if (s.b <= a + 1e-9 || s.a >= b - 1e-9) { out.push({ ...s }); continue; }
    if (s.a < a - 1e-9) out.push({ a: s.a, b: a, k: s.k });
    if (s.b > b + 1e-9) out.push({ a: b, b: s.b, k: s.k });
  }
  out.push({ a, b, k });
  out.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && last.k === s.k && Math.abs(last.b - s.a) < 1e-9) last.b = s.b; else merged.push(s);
  }
  return merged;
}
export function segmentAt(comp, beat) { return comp.find((s) => beat >= s.a - 1e-9 && beat < s.b) || null; }

// the clip moved its start by d beats (a left trim): its takes and its comp stay where they are in the song
export function shiftFolder(c, takes0, comp0, d, len) {
  c.takes = takes0.map((t) => ({ ...t, at: t.at - d }));
  c.comp = comp0.map((s) => ({ ...s, a: s.a - d, b: s.b - d })).filter((s) => s.b > 1e-6 && s.a < len - 1e-6).map((s) => ({ ...s, a: Math.max(0, s.a), b: Math.min(len, s.b) }));
}

// a new take recorded over the folder, from beat `start` (song) for `len` beats: the folder grows to hold it,
// and the new take plays where it was recorded
export function addTake(c, take, start, len) {
  toFolder(c);
  const end = start + len, s0 = Math.min(c.start, start), e0 = Math.max(c.start + c.len, end), d = c.start - s0;
  if (d > 0) { for (const t of c.takes) t.at += d; for (const s of c.comp) { s.a += d; s.b += d; } }
  c.start = s0; c.len = e0 - s0;
  const k = c.takes.push({ ...take, at: start - s0 }) - 1;
  c.comp = setComp(c.comp, start - s0, end - s0, k);
  c.src = take.src; c.offset = take.offset;
  return k;
}

// the comp as plain clips, for playback: one a segment, short fades where takes meet
export function expandFolder(c, spbSec) {
  const out = [];
  for (const s of c.comp) {
    const t = c.takes[s.k], a = Math.max(0, s.a), b = Math.min(c.len, s.b);
    if (!t || b - a < 1e-6) continue;
    out.push({ start: c.start + a, len: b - a, src: t.src, offset: t.offset + (a - t.at) * spbSec, gain: c.gain || 0,
      fadeIn: a < 1e-6 ? c.fadeIn : 0.004, fadeOut: b >= c.len - 1e-6 ? c.fadeOut : 0.004 });
  }
  return out;
}

// the comp rendered to one buffer (FLATTEN): what plays, sample for sample, with the fades
export function renderFolder(c, assets, bpm, rate = 44100) {
  const spbSec = 60 / bpm, n = Math.max(1, Math.round(c.len * spbSec * rate));
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const s of expandFolder({ ...c, gain: 0 }, spbSec)) {
    const a = assets.get(s.src);
    if (!a) continue;
    const AL = a.L, AR = a.R || a.L, f0 = Math.round((s.start - c.start) * spbSec * rate), f1 = Math.min(n, Math.round((s.start - c.start + s.len) * spbSec * rate));
    const fin = Math.max(1, s.fadeIn * rate), fout = Math.max(1, s.fadeOut * rate), base = Math.round(s.offset * rate);
    for (let f = f0; f < f1; f++) {
      const i = base + (f - f0);
      if (i < 0 || i >= AL.length) continue;
      let k = 1;
      if (f - f0 < fin) k *= (f - f0) / fin;
      if (f1 - f < fout) k *= (f1 - f) / fout;
      L[f] += AL[i] * k; R[f] += AR[i] * k;
    }
  }
  return { L, R };
}

// ------------------------------------------------------------------- MIDI takes ---
// A MIDI clip recorded over and over in a loop keeps each pass as a take: clip.mtakes = [{ name, notes }], and the
// same comp as audio ({ a, b, k }, beats in the clip's loop). clip.notes is always what the comp plays.
export const isMidiFolder = (c) => !!(c && Array.isArray(c.mtakes) && c.mtakes.length && Array.isArray(c.comp));
export function compNotes(c) {
  const out = [];
  for (const s of c.comp || []) {
    const tk = c.mtakes?.[s.k];
    if (!tk) continue;
    for (const n of tk.notes) if (n.t >= s.a - 1e-9 && n.t < s.b - 1e-9) out.push({ ...n });
  }
  return out.sort((x, y) => x.t - y.t || x.n - y.n);
}
// a new pass recorded into a clip: a take of its own (the notes there before: take 1), playing where it was recorded
export function addMidiTake(c, a, b, name) {
  const loop = c.loop || c.len;
  if (!isMidiFolder(c)) {
    c.mtakes = c.notes?.length ? [{ name: 'TAKE 1', notes: c.notes.map((n) => ({ ...n })) }] : [];
    c.comp = c.mtakes.length ? [{ a: 0, b: loop, k: 0 }] : [];
  }
  const k = c.mtakes.push({ name: name || `TAKE ${c.mtakes.length + 1}`, notes: [] }) - 1;
  c.comp = setComp(c.comp, Math.max(0, a), Math.min(loop, b), k);
  return k;
}
