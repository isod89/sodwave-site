// SPDX-License-Identifier: GPL-3.0-only
// Changes between two versions of a project, as small operations, made to survive other people's changes:
// - a path names an element of a list by its id when it has one ('#t12'), so an edit lands on the same track or clip
//   even if the others added, removed or moved some;
// - lists of things with ids: elements added (after the element before them), removed, moved; never the whole list;
// - lists of notes and points (no ids): as a bag, the ones gone and the ones new, so two people adding notes to the
//   same clip both keep theirs;
// - anything else that changed: set (or deleted) at its path.
// Operations: { p: path, v } set · { p, del: 1 } delete · { p, ins: value, after: id|null } · { p, rm: id } ·
// { p, mv: id, after } · { p, bag: { add: [...], del: [...] } }
const hasIds = (a) => a.length > 0 && a.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string');
const isBag = (a) => a.length > 0 && a.every((x) => x && typeof x === 'object' && !Array.isArray(x) && !('id' in x));
const kind = (x) => (Array.isArray(x) ? 'array' : x && typeof x === 'object' && !ArrayBuffer.isView(x) ? 'object' : 'value');
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
const clone = (x) => (x === undefined ? undefined : structuredClone(x));
const key = (x) => JSON.stringify(x);

export function diff(a, b, path = [], out = []) {
  if (a === b) return out;
  const ta = kind(a), tb = kind(b);
  if (ta !== tb || ta === 'value') { if (!same(a, b)) out.push({ p: path, v: clone(b) }); return out; }
  if (ta === 'array') {
    if ((hasIds(a) || !a.length) && (hasIds(b) || !b.length) && (a.length || b.length)) return diffIds(a, b, path, out);
    if ((isBag(a) || !a.length) && (isBag(b) || !b.length) && (a.length || b.length)) return diffBag(a, b, path, out);
    if (a.length !== b.length) { out.push({ p: path, v: clone(b) }); return out; }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], [...path, i], out);
    return out;
  }
  for (const k of Object.keys(a)) if (!(k in b)) out.push({ p: [...path, k], del: 1 });
  for (const k of Object.keys(b)) diff(a[k], b[k], [...path, k], out);
  return out;
}
function diffIds(a, b, path, out) {
  const ia = new Map(a.map((x, i) => [x.id, i])), ib = new Set(b.map((x) => x.id));
  for (const x of a) if (!ib.has(x.id)) out.push({ p: path, rm: x.id });
  // what is kept, in its old order; what moved or is new, placed after the element before it in the new order
  const order = a.filter((x) => ib.has(x.id)).map((x) => x.id);
  b.forEach((x, i) => {
    const after = i ? b[i - 1].id : null, want = after ? order.indexOf(after) + 1 : 0;   // (what is before it: already in place)
    if (!ia.has(x.id)) { out.push({ p: path, ins: clone(x), after }); order.splice(want, 0, x.id); return; }
    const at = order.indexOf(x.id);
    if (at !== want) { out.push({ p: path, mv: x.id, after }); order.splice(at, 1); order.splice(after ? order.indexOf(after) + 1 : 0, 0, x.id); }
    diff(a[ia.get(x.id)], x, [...path, '#' + x.id], out);
  });
  return out;
}
function diffBag(a, b, path, out) {
  const count = new Map();
  for (const x of a) { const k = key(x); count.set(k, (count.get(k) || 0) + 1); }
  const add = [];
  for (const x of b) { const k = key(x), c = count.get(k) || 0; if (c) count.set(k, c - 1); else add.push(clone(x)); }
  const del = [];
  for (const [k, c] of count) for (let i = 0; i < c; i++) del.push(JSON.parse(k));
  if (add.length || del.length) out.push({ p: path, bag: { add, del } });
  return out;
}

// the object a path leads to (a '#id' step: the element with that id), or undefined
function walk(root, path) {
  let o = root;
  for (const k of path) {
    if (o == null || typeof o !== 'object') return undefined;
    o = typeof k === 'string' && k[0] === '#' && Array.isArray(o) ? o.find((x) => x?.id === k.slice(1)) : o[k];
  }
  return o;
}
// apply operations (in place); one that no longer leads anywhere is skipped. -> how many applied
export function patch(root, ops) {
  let n = 0;
  for (const op of ops) {
    const path = op.p;
    if (op.ins !== undefined || op.rm !== undefined || op.mv !== undefined || op.bag) {
      const list = walk(root, path);
      if (!Array.isArray(list)) continue;
      const place = (x) => { const i = op.after == null ? -1 : list.findIndex((y) => y?.id === op.after); list.splice(i + 1, 0, x); };
      if (op.ins !== undefined) { if (!list.some((y) => y?.id === op.ins?.id)) { place(clone(op.ins)); n++; } }
      else if (op.rm !== undefined) { const i = list.findIndex((y) => y?.id === op.rm); if (i >= 0) { list.splice(i, 1); n++; } }
      else if (op.mv !== undefined) { const i = list.findIndex((y) => y?.id === op.mv); if (i >= 0) { const [x] = list.splice(i, 1); place(x); n++; } }
      else {
        for (const d of op.bag.del || []) { const k = key(d), i = list.findIndex((y) => key(y) === k); if (i >= 0) list.splice(i, 1); }
        for (const x of op.bag.add || []) list.push(clone(x));
        n++;
      }
      continue;
    }
    if (!path.length) continue;                          // (never the root itself)
    const o = walk(root, path.slice(0, -1));
    if (o == null || typeof o !== 'object') continue;
    let k = path[path.length - 1];
    if (typeof k === 'string' && k[0] === '#' && Array.isArray(o)) { k = o.findIndex((x) => x?.id === k.slice(1)); if (k < 0) continue; }
    if (op.del) { if (Array.isArray(o)) continue; delete o[k]; } else o[k] = clone(op.v);
    n++;
  }
  return n;
}
// two paths touch the same thing (one is inside the other)
export const overlaps = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
// operations from someone else are safe to apply: plain keys (no __proto__, constructor, prototype, length), sane sizes
const SAFE_KEY = (k) => (typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < 1e6) || (typeof k === 'string' && k.length < 200 && !['__proto__', 'constructor', 'prototype', 'length'].includes(k));
export const safeOps = (ops) => Array.isArray(ops) && ops.length < 1e5 && ops.every((op) => op && typeof op === 'object' && Array.isArray(op.p) && op.p.length < 40 && op.p.every(SAFE_KEY)
  && (op.after == null || typeof op.after === 'string') && (op.rm == null || typeof op.rm === 'string') && (op.mv == null || typeof op.mv === 'string')
  && (!op.bag || (Array.isArray(op.bag.add) && Array.isArray(op.bag.del))));
// is this a structural operation (adding, removing, moving, a bag): they commute, they are always applied
export const structural = (op) => op.ins !== undefined || op.rm !== undefined || op.mv !== undefined || !!op.bag;
