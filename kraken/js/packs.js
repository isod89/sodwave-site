// SPDX-License-Identifier: GPL-3.0-only
// Community engines: the sound engines of other FM-1 / SMK-37 firmwares (Melodee, JIANT, X0X…), built by Sodwave from
// their source (engines/packs.py) and shipped with Kraken. Each is one .wasm file in engines/packs/: the engine with
// Kraken's engine interface (the k_* exports, the same as SLOOP's and Clipper's), no imports (it can only compute), and
// its description in a custom section "kraken.pack" (name, version, author, licence, source). engines/packs/index.json
// lists them with their catalogues, so the library shows their sounds at once; a pack's .wasm is only fetched when a
// track or a LAB patch plays it. Each is a bank of its own: "x:ID" (a track's def.bank, a LAB ENGINE module's m.pack).
export const PACK_SECTION = 'kraken.pack';
const REQUIRED = ['k_init', 'k_buffer', 'k_catalog', 'k_render', 'k_note', 'k_param', 'k_preset', 'k_engine', 'k_nparams'];
export const isPackBank = (b) => typeof b === 'string' && /^x:[a-z0-9][a-z0-9-]{0,39}$/.test(b);
export const packBank = (id) => `x:${id}`;

// read and check a pack: its description, the engine interface, a first start and its catalogue (a broken pack is refused
// here, never on a track). -> { manifest, module, catalog, sha256, bytes }
export async function inspectPack(bytes) {
  if (!(bytes instanceof ArrayBuffer)) bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let module;
  try { module = await WebAssembly.compile(bytes); } catch { throw new Error('This file is not a WebAssembly engine.'); }
  const sec = WebAssembly.Module.customSections(module, PACK_SECTION)[0];
  if (!sec) throw new Error('This .wasm is not a Kraken engine pack (no "kraken.pack" description inside).');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(sec)); } catch { throw new Error('The pack\'s description cannot be read.'); }
  manifest = cleanManifest(manifest);
  if (WebAssembly.Module.imports(module).length) throw new Error('This engine asks for access outside itself: refused (a pack only computes sound).');
  const ex = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  const missing = REQUIRED.filter((n) => !ex.has(n));
  if (missing.length || !ex.has('memory')) throw new Error(`This engine lacks Kraken's interface (${[...missing, ex.has('memory') ? null : 'memory'].filter(Boolean).join(', ')}).`);
  const catalog = catalogOf(module);
  return { manifest, module, catalog, sha256: await sha256(bytes), bytes };
}
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
// an engine's catalogue (its engines, sounds, parameters), from a fresh instance
export function catalogOf(module) {
  const w = new WebAssembly.Instance(module, {}).exports;
  w._initialize?.();
  w.k_init(0);
  const n = w.k_catalog();
  const cat = JSON.parse(new TextDecoder().decode(new Uint8Array(w.memory.buffer, w.k_buffer(), n).slice()));
  if (!Array.isArray(cat.engines) || !cat.engines.length || !Array.isArray(cat.tp) || typeof cat.e0 !== 'number') throw new Error('The engine\'s catalogue is not one Kraken reads.');
  return cat;
}
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, n) : '');
export function cleanManifest(m) {
  const id = str(m?.id, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new Error('The pack has no id.');
  const source = /^https:\/\/[^\s"<>]+$/.test(m.source || '') ? str(m.source, 300) : '';
  return { format: +m.format || 1, id, name: str(m.name, 40) || id, family: str(m.family, 20), version: str(m.version, 40), commit: str(m.commit, 40),
    author: str(m.author, 60), license: str(m.license, 40), source, built: str(m.built, 30), description: str(m.description, 300) };
}

// ---- the packs Kraken ships
// engines/packs/index.json: [{ id, file, sha256, bytes, manifest, catalog }] -> { [bank]: catalogue with .pack, .sha256, .file }
export async function packIndex() {
  const out = {};
  let list = [];
  // (its URL made here, not at the top: the audio thread imports this file and has no URL)
  try { const r = await fetch(new URL('../engines/packs/index.json', import.meta.url)); if (r.ok) list = await r.json(); } catch { /* (offline before the first visit, or none) */ }
  for (const e of Array.isArray(list) ? list : []) {
    try {
      const manifest = cleanManifest(e.manifest || {});
      if (!/^[a-z0-9-]+\.wasm$/.test(e.file || '') || !/^[0-9a-f]{64}$/.test(e.sha256 || '') || !Array.isArray(e.catalog?.engines)) continue;
      out[packBank(manifest.id)] = { ...e.catalog, pack: manifest, sha256: e.sha256, file: e.file, bytes: +e.bytes || 0 };
    } catch { /* (a bad entry is left out) */ }
  }
  return out;
}
// a pack's engine, fetched and checked against the index (its SHA-256), then compiled -> { module, bytes }
export async function fetchPack(entry) {
  const r = await fetch(new URL(`../engines/packs/${entry.file}`, import.meta.url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bytes = await r.arrayBuffer();
  if (await sha256(bytes) !== entry.sha256) throw new Error('its file does not match this version of Kraken');
  const module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('it asks for access outside itself');
  return { module, bytes };
}
// the packs a project plays: its tracks' banks and its LAB patches' ENGINE modules
export function packsOf(p) {
  const out = new Set();
  for (const t of p?.tracks || []) {
    if (isPackBank(t.bank)) out.add(t.bank);
    for (const m of t.lab?.mods || []) if (isPackBank(m.pack)) out.add(m.pack);
  }
  return [...out];
}
// a stand-in for a pack this version of Kraken does not have (a song from a newer one): its tracks stay silent, and say so
export function missingCatalog(bank, info = null) {
  return { missing: true, pack: { id: bank.slice(2), name: info?.name || bank.slice(2), source: info?.source || '' },
    rate: 44100, voices: 0, e0: 0, tp: [], gp: [], kits: [], lanes: [], laneNotes: [],
    engines: Array(128).fill({ name: 'MISSING ENGINE', edit: [], presets: Array(128).fill(info?.name ? `${info.name} (not available)` : 'NOT AVAILABLE') }) };   // (any engine, any sound of it)
}
