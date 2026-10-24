// SPDX-License-Identifier: GPL-3.0-only
// Arrangement edits on the project (pure: they change the project they are given, for store.change): split, join,
// time ranges (cut, copy, paste, delete or insert time across every track, with automation, markers, tempo and
// metre following), a clip's notes unrolled. The app wires them to keys, menus and the selection.
import { cutRange, uid } from './project.js';
import { isMidiFolder } from './comp.js';

// a MIDI clip's notes, unrolled over its length (its loop repeated), from its start: [{ t, d, n, v, ... }]
export function unrollNotes(c) {
  const loop = c.loop > 0 ? c.loop : c.len, out = [];
  for (let base = 0; base < c.len - 1e-9; base += loop)
    for (const n of c.notes || []) {
      if (n.t >= loop - 1e-9) continue;
      const t = base + n.t;
      if (t >= c.len - 1e-9) continue;
      out.push({ ...n, t, d: Math.min(n.d, loop - n.t, c.len - t) });
    }
  return out.sort((a, b) => a.t - b.t || a.n - b.n);
}
const flatMidi = (c) => { if (isMidiFolder(c)) { delete c.mtakes; delete c.comp; } return c; };

// split the clips with these ids (or every clip of these tracks) where they cross beat `at`; -> the new right parts' ids
export function split(p, at, { ids = null, tracks = null } = {}) {
  const made = [];
  for (const t of p.tracks) {
    if (tracks && !tracks.includes(t.id)) continue;
    const hit = t.clips.filter((c) => c.start < at - 1e-6 && c.start + c.len > at + 1e-6 && (!ids || ids.includes(c.id)));
    if (!hit.length) continue;
    const before = new Set(t.clips.map((c) => c.id));
    t.clips = [...t.clips.filter((c) => !hit.includes(c)), ...cutRange(hit, at, at, p.bpm)].map(flatMidi);
    for (const c of t.clips) if (!before.has(c.id)) made.push(c.id);
  }
  return made;
}

// join MIDI clips of one track into one (each one's notes unrolled where it was; the gaps silent): -> its id, or null
export function join(p, trackId, ids) {
  const t = p.tracks.find((x) => x.id === trackId);
  const cs = t?.clips.filter((c) => ids.includes(c.id) && c.notes).sort((a, b) => a.start - b.start);
  if (!cs || cs.length < 2) return null;
  const start = cs[0].start, end = Math.max(...cs.map((c) => c.start + c.len));
  const notes = cs.flatMap((c) => unrollNotes(c).map((n) => ({ ...n, t: n.t + c.start - start })));
  const out = { ...structuredClone(cs[0]), id: uid('c'), start, len: end - start, loop: end - start, notes };
  delete out.mtakes; delete out.comp;
  t.clips = [...t.clips.filter((c) => !cs.includes(c)), out];
  return out.id;
}

// a time range [a, b) of the song, as pieces of clips per track (times from a): the clipboard of a range
export function copyRange(p, a, b, tracks = null) {
  const out = { len: b - a, tracks: {} };
  for (const t of p.tracks) {
    if (tracks && !tracks.includes(t.id)) continue;
    const inside = t.clips.filter((c) => c.start < b - 1e-6 && c.start + c.len > a + 1e-6);
    if (!inside.length) continue;
    // cut the clips at a and at b; the pieces between them are the range
    let parts = cutRange(structuredClone(inside), a, a, p.bpm);
    parts = cutRange(parts, b, b, p.bpm);
    out.tracks[t.id] = parts.filter((c) => c.start >= a - 1e-6 && c.start + c.len <= b + 1e-6).map((c) => ({ ...flatMidi(c), start: c.start - a }));
  }
  return out;
}
// everything at or after beat `at` moves by d beats (d < 0: earlier): clips, automation, markers, tempo, metre, loop
function shiftFrom(p, at, d) {
  for (const t of p.tracks) {
    for (const c of t.clips) if (c.start >= at - 1e-6) c.start = Math.max(0, c.start + d);
    for (const k in t.auto) t.auto[k] = t.auto[k].map((q) => (q.t >= at - 1e-6 ? { ...q, t: Math.max(0, q.t + d) } : q));
  }
  for (const k in p.macroAuto || {}) p.macroAuto[k] = p.macroAuto[k].map((q) => (q.t >= at - 1e-6 ? { ...q, t: Math.max(0, q.t + d) } : q));
  for (const m of p.markers || []) if (m.t >= at - 1e-6) m.t = Math.max(0, m.t + d);
  for (const q of p.tempo || []) if (q.t >= at - 1e-6) q.t = Math.max(0, q.t + d);
  for (const m of p.meters || []) if (m.t >= at - 1e-6) m.t = Math.max(0, m.t + d);
  for (const r of [p.loop, p.punch]) { if (!r) continue; if (r.a >= at - 1e-6) r.a = Math.max(0, r.a + d); if (r.b >= at - 1e-6) r.b = Math.max(r.a + 0.25, r.b + d); }
}
// remove what is in [a, b) everywhere (points too), without moving anything else
export function clearRange(p, a, b, tracks = null) {
  for (const t of p.tracks) {
    if (tracks && !tracks.includes(t.id)) continue;
    t.clips = cutRange(t.clips, a, b, p.bpm).map(flatMidi);
    if (!tracks || tracks.includes(t.id)) for (const k in t.auto) { const pts = t.auto[k].filter((q) => q.t < a - 1e-6 || q.t >= b - 1e-6); if (pts.length) t.auto[k] = pts; else delete t.auto[k]; }
  }
}
// delete time: [a, b) goes, what was after it closes the gap
export function deleteTime(p, a, b) {
  clearRange(p, a, b);
  p.markers = (p.markers || []).filter((m) => m.t < a - 1e-6 || m.t >= b - 1e-6);
  p.tempo = (p.tempo || []).filter((q) => q.t < a - 1e-6 || q.t >= b - 1e-6);
  p.meters = (p.meters || []).filter((m) => m.t < a - 1e-6 || m.t >= b - 1e-6);
  for (const k in p.macroAuto || {}) p.macroAuto[k] = p.macroAuto[k].filter((q) => q.t < a - 1e-6 || q.t >= b - 1e-6);
  shiftFrom(p, b, -(b - a));
}
// insert time: `len` beats of silence at `at` (the clips across it split)
export function insertTime(p, at, len) {
  split(p, at);
  shiftFrom(p, at, len);
}
// paste a range clipboard at beat `at`: each track's pieces where they were (what was under them cleared)
export function pasteRange(p, clip, at) {
  const made = [];
  for (const [id, parts] of Object.entries(clip.tracks)) {
    const t = p.tracks.find((x) => x.id === id);
    if (!t) continue;
    t.clips = cutRange(t.clips, at, at + clip.len, p.bpm).map(flatMidi);
    for (const c of parts) { const x = { ...structuredClone(c), id: uid('c'), start: at + c.start }; t.clips.push(x); made.push(x.id); }
  }
  return made;
}
// move clips (on their tracks) by d beats, together; what they land on is cut
export function moveClips(p, ids, d) {
  for (const t of p.tracks) {
    const mine = t.clips.filter((c) => ids.includes(c.id));
    if (!mine.length) continue;
    for (const c of mine) c.start = Math.max(0, c.start + d);
    let rest = t.clips.filter((c) => !ids.includes(c.id));
    for (const c of mine) rest = cutRange(rest, c.start, c.start + c.len, p.bpm);
    t.clips = [...rest.map(flatMidi), ...mine];
  }
}
// a reversed copy of an audio file's frames
export function reversed(a) { return { L: a.L.slice().reverse(), R: (a.R || a.L).slice().reverse(), name: `${a.name || 'audio'} (reversed)` }; }
