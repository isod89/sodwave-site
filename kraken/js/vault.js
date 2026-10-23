// SPDX-License-Identifier: GPL-3.0-only
// Where a project lives in the browser, so that a song is never lost:
// - the autosave, in IndexedDB, with the save before it (a crash while writing never loses both), and a copy in
//   localStorage when IndexedDB fails or the page is being closed (written at once, while the page can still write);
//   each copy carries its time: the newest good one comes back;
// - earlier versions (snapshots): every few minutes of work, and before another project replaces this one;
// - one tab writes the autosave at a time (Web Locks), so two open tabs never overwrite each other's work;
// - the browser is asked to keep the data (persistent storage) and how much room is left is known.
export const AUTOSAVE = 'kraken.autosave.v1';
const EMERGENCY = AUTOSAVE + '.emergency';
const SNAP_KEEP = 40;

let dbp = null;
// version 2, as Kraken 0.5 made it: no upgrade, so a tab of an older Kraken still open never blocks this one
// (the earlier versions live in the projects store, under keys of their own)
export function db() {
  dbp ||= new Promise((resolve) => {
    try {
      const r = indexedDB.open('kraken', 2);
      r.onupgradeneeded = () => { for (const st of ['assets', 'projects']) if (!r.result.objectStoreNames.contains(st)) r.result.createObjectStore(st); };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); };
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
// one request in its own transaction: its result, or null (no IndexedDB, a quota error...); err gets the error
export const tx = async (mode, fn, store = 'assets', err = null) => {
  const d = await db();
  if (!d) { err?.(new Error('no IndexedDB')); return null; }
  return new Promise((resolve) => {
    try {
      const t = d.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? (req.result ?? null) : true);   // (a get of nothing: null)
      t.onerror = () => { err?.(t.error || req?.error); resolve(null); };
      t.onabort = () => { err?.(t.error || req?.error); resolve(null); };
    } catch (e) { err?.(e); resolve(null); }
  });
};

// a stored record: {t, json} (0.6+) or the bare JSON string of earlier versions (t 0)
const rec = (x) => (typeof x === 'string' ? { t: 0, json: x } : x && typeof x.json === 'string' ? x : null);
const lsGet = (k) => { try { const s = localStorage.getItem(k); if (!s) return null; return s[0] === '{' && s.includes('"json"') ? rec(JSON.parse(s)) : rec(s); } catch { return null; } };
const lsSet = (k, r) => { try { localStorage.setItem(k, JSON.stringify(r)); return true; } catch { return false; } };

// every saved copy, newest first: [{t, json, from}]
export async function autosaves() {
  const out = [];
  const add = (r, from) => { if (r) out.push({ ...r, from }); };
  add(rec(await tx('readonly', (s) => s.get(AUTOSAVE), 'projects')), 'autosave');
  add(rec(await tx('readonly', (s) => s.get(AUTOSAVE + '.prev'), 'projects')), 'previous autosave');
  add(lsGet(EMERGENCY), 'copy made when the page closed');
  add(lsGet(AUTOSAVE), 'local copy');
  return out.sort((a, b) => b.t - a.t);
}

// the autosave: true when it is safely in IndexedDB or (failing that) in localStorage
let lastErr = null;
export async function writeAutosave(json, t = Date.now()) {
  lastErr = null;
  const r = { t, json };
  const prev = rec(await tx('readonly', (s) => s.get(AUTOSAVE), 'projects'));
  if (prev && prev.json !== json) await tx('readwrite', (s) => s.put(prev, AUTOSAVE + '.prev'), 'projects');   // (.prev: a different state)
  const ok = await tx('readwrite', (s) => s.put(r, AUTOSAVE), 'projects', (e) => { lastErr = e; });
  if (ok !== null) { const em = lsGet(EMERGENCY); if (em && em.t <= t) try { localStorage.removeItem(EMERGENCY); } catch { /* */ } return true; }
  return lsSet(AUTOSAVE, r);
}
export const autosaveError = () => lastErr;
// the page is closing: written at once (localStorage is synchronous); the next start compares the times
export function emergencySave(json) { return lsSet(EMERGENCY, { t: Date.now(), json }); }

// ---------------------------------------------------------------- earlier versions ---
const SNAP = 'snap:', snapKey = (t) => SNAP + String(t).padStart(15, '0');
const SNAPS = () => IDBKeyRange.bound(SNAP, SNAP + '\uffff');
// meta.keep: a project put aside for the person (it never goes with the oldest)
export async function addSnapshot(json, meta = {}) {
  const keys = ((await tx('readonly', (s) => s.getAllKeys(SNAPS()), 'projects')) || []).sort();
  if (keys.length && !meta.keep) { const last = await tx('readonly', (s) => s.get(keys.at(-1)), 'projects'); if (last?.json === json) return true; }
  const t = Math.max(Date.now(), keys.length ? +keys.at(-1).slice(SNAP.length) + 1 : 0);
  const ok = await tx('readwrite', (s) => s.put({ t, json, ...meta }, snapKey(t)), 'projects');
  if (ok === null) return false;
  if (keys.length + 1 > SNAP_KEEP) {
    const all = (await tx('readonly', (s) => s.getAll(SNAPS()), 'projects')) || [];
    const drop = all.filter((x) => !x.keep).sort((a, b) => a.t - b.t).slice(0, Math.max(0, all.length - SNAP_KEEP)).map((x) => snapKey(x.t));
    if (drop.length) await tx('readwrite', (s) => { for (const k of drop) s.delete(k); return null; }, 'projects');
  }
  return true;
}
// newest first, without their JSON: [{t, name, why, tracks}]
export async function listSnapshots() {
  const all = (await tx('readonly', (s) => s.getAll(SNAPS()), 'projects')) || [];
  return all.filter((x) => x && typeof x.json === 'string').map(({ json, ...m }) => ({ ...m, size: json.length })).sort((a, b) => b.t - a.t);
}
export async function getSnapshot(t) { const x = await tx('readonly', (s) => s.get(snapKey(t)), 'projects'); return x?.json || null; }

// ------------------------------------------------------------------ one writer ---
// claims the autosave for this tab. onLost(): another tab took it over. Resolves true (this tab writes) or false
// (another tab has it: take(): this one takes it over). Without Web Locks: always true.
// onGot(): the other tab closed, this one has it now
export function claimAutosave(onLost, onGot = () => {}) {
  if (!navigator.locks?.request) return Promise.resolve({ ok: true, take: () => Promise.resolve(true) });
  let held = false;
  const hold = (mode) => new Promise((resolve) => {
    let granted = false;
    try {
      navigator.locks.request('kraken-autosave', mode, (lock) => {
        if (!lock) { resolve(false); return null; }
        granted = true; held = true;
        resolve(true);
        return new Promise(() => {});                  // held while the tab lives
      }).catch(() => { if (granted) { held = false; onLost(); wait(); } else resolve(true); });   // (stolen; or no locks here)
    } catch { resolve(true); }
  });
  // waits its turn: when the tab that has it closes (or gives it up), this one saves
  const wait = () => hold({}).then((ok) => { if (ok && held) onGot(); });
  return hold({ ifAvailable: true }).then((ok) => {
    if (!ok) wait();
    return { ok, take: () => hold({ steal: true }) };
  });
}

// ------------------------------------------------------------------ the room ---
export async function storageInfo() {
  const o = { persisted: null, usage: null, quota: null };
  try { o.persisted = await navigator.storage?.persisted?.() ?? null; } catch { /* */ }
  try { const e = await navigator.storage?.estimate?.(); if (e) { o.usage = e.usage ?? null; o.quota = e.quota ?? null; } } catch { /* */ }
  return o;
}
// ask the browser to keep Kraken's data (never cleared to make room); some grant it at once, some after use
export async function askPersist() { try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch { return false; } }
