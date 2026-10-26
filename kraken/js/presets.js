// SPDX-License-Identifier: GPL-3.0-only
// Presets: an effect's settings, a whole effect chain (audio effects, note effects, modulators), a whole track
// (its instrument, sample zones or pads, chain and mix), a whole project as a template. Factory presets for the
// effects; yours are kept in this browser (IndexedDB) and travel as a .kraken-preset file.
import { tx } from './vault.js';
import { uid } from './project.js';
import { DEVICES, defaults } from './fx.js';

const KEY = 'cfg:presets';
export const PRESET_FORMAT = 1;

// --------------------------------------------------------------- factory ---
// a few starting points per effect (the rest of each effect's knobs stay at their defaults)
export const FACTORY_FX = {
  reverb: [['Small room', { si: 0.3, da: 0.55, pr: 0.004, mx: 0.18 }], ['Hall', { si: 0.85, da: 0.35, pr: 0.03, mx: 0.28 }], ['Bright plate', { si: 0.6, da: 0.1, pr: 0.012, mx: 0.25 }],
    ['Vocal space', { si: 0.7, da: 0.5, pr: 0.06, mx: 0.2 }], ['Endless', { si: 0.99, da: 0.6, pr: 0.08, mx: 0.5 }]],
  delay: [['Slapback', { ti: 0, fb: 0.1, to: 0.7, pp: 0, mx: 0.25 }], ['Eighth ping-pong', { ti: 3, fb: 0.4, to: 0.6, pp: 1, mx: 0.3 }], ['Dotted eighth', { ti: 4, fb: 0.45, to: 0.5, pp: 0, mx: 0.28 }],
    ['Dub', { ti: 5, fb: 0.75, to: 0.3, pp: 1, mx: 0.35 }], ['Quarter throw', { ti: 5, fb: 0.3, to: 0.6, pp: 0, mx: 0.2 }]],
  comp: [['Vocal', { th: -20, ra: 3, at: 5, re: 100, kn: 6, mk: 4, mx: 1 }], ['Drum bus glue', { th: -14, ra: 2, at: 30, re: 150, kn: 6, mk: 2, mx: 1 }],
    ['Punchy drums', { th: -22, ra: 4, at: 20, re: 80, kn: 3, mk: 5, mx: 1 }], ['Parallel smash', { th: -35, ra: 10, at: 1, re: 60, kn: 0, mk: 12, mx: 0.35 }],
    ['Bass level', { th: -18, ra: 5, at: 8, re: 120, kn: 6, mk: 4, mx: 1 }], ['Sidechain pump (pick the kick)', { th: -32, ra: 10, at: 0.5, re: 180, kn: 0, mk: 0, mx: 1 }]],
  eq: [['Vocal clean-up', { hp: 90, m1g: -3, m1f: 350, m1q: 1.2, m2g: 2.5, m2f: 3500, hg: 3, hf: 10000 }], ['Air', { hg: 4, hf: 11000 }],
    ['Kick punch', { hp: 30, lg: 4, lf: 60, m1g: -5, m1f: 320, m1q: 1.4, m2g: 3, m2f: 4000 }], ['Bass room', { hp: 35, m1g: -3, m1f: 250, m2g: 2, m2f: 900 }],
    ['Make room for vocals', { m2g: -3, m2f: 2500, m2q: 0.8 }], ['Telephone', { hp: 450, lp: 3200, m1g: 6, m1f: 1300, m1q: 1.5 }]],
  sat: [['Warm tape', { dr: 6, ty: 1, to: -0.2, mx: 1, ou: -3 }], ['Crunch', { dr: 18, ty: 3, to: 0.1, mx: 0.7, ou: -8 }], ['Fold', { dr: 14, ty: 2, to: 0, mx: 0.6, ou: -6 }], ['Glow', { dr: 3, ty: 0, to: 0.2, mx: 1, ou: -1 }]],
  amp: [['Sparkle clean', { mo: 0, ga: 3, ba: 4, mi: 5, tr: 7, pr: 6, ca: 2 }], ['Blues crunch', { mo: 1, ga: 4, ba: 5, mi: 6, tr: 5, pr: 5, ca: 1 }],
    ['Rock rhythm', { mo: 1, ga: 8, ba: 6, mi: 6, tr: 6, pr: 6, ca: 3 }], ['Lead solo', { mo: 2, ga: 7, ba: 5, mi: 7, tr: 5, pr: 5, ca: 3 }],
    ['Metal tight', { mo: 3, ga: 7, ba: 6, mi: 4, tr: 6, pr: 6, ca: 3 }], ['Bass growl', { mo: 4, ga: 5, ba: 6, mi: 6, tr: 4, pr: 4, ca: 4 }],
    ['Synth through an amp', { mo: 1, ga: 5, ba: 5, mi: 5, tr: 4, pr: 5, ca: 3, mx: 0.6 }], ['Old radio', { mo: 1, ga: 6, ba: 2, mi: 8, tr: 3, pr: 3, ca: 1, ou: -4 }]],
  filter: [['Wobble', { ty: 0, fr: 600, q: 4, lr: 5, ld: 0.7 }], ['Sweep low', { ty: 0, fr: 400, q: 2, lr: 8, ld: 0.6 }], ['Thin', { ty: 1, fr: 500, q: 1 }], ['Radio band', { ty: 2, fr: 1500, q: 2 }]],
  chorus: [['Wide', { ra: 0.4, de: 0.6, fb: 0.1, mx: 0.5 }], ['Vibrato', { ra: 5, de: 0.3, fb: 0, mx: 1 }], ['Thick', { ra: 0.9, de: 0.8, fb: 0.4, mx: 0.5 }]],
  phaser: [['Slow swirl', { ra: 0.15, de: 0.8, fb: 0.5, mx: 0.5 }], ['Jet', { ra: 0.06, de: 1, fb: 0.85, mx: 0.6 }]],
  crush: [['Lo-fi', { bi: 10, ds: 3, mx: 0.6 }], ['8-bit', { bi: 6, ds: 6, mx: 1 }]],
  gate: [['Tight drums', { th: -30, at: 0.5, re: 40, fl: -80 }], ['Soft noise gate', { th: -50, at: 2, re: 200, fl: -24 }]],
  slicer: [['Trance gate', { ra: 1, pa: 0, de: 1, sm: 0.15 }], ['Offbeat', { ra: 3, pa: 1, de: 1, sm: 0.2 }], ['Stutter', { ra: 1, pa: 5, de: 1, sm: 0.1 }]],
  utility: [['Mono', { wi: 0 }], ['Wider', { wi: 1.6 }], ['Bass mono 120 Hz', { bm: 120 }], ['-6 dB', { ga: -6 }]],
  limiter: [['Master: loud', { ga: 6, ce: -0.3, re: 80 }], ['Master: safe', { ga: 0, ce: -1, re: 120 }], ['Streaming -1 dBTP', { ga: 3, ce: -1, re: 100 }]],
  mband: [['Master glue', { f1: 120, f2: 3000, ra: 2, at: 30, re: 200, t1: -18, t2: -16, t3: -18, ou: 1 }], ['Tame the lows', { f1: 150, f2: 2500, ra: 4, at: 10, re: 120, t1: -24, t2: 0, t3: 0 }],
    ['Vocal smooth', { f1: 250, f2: 4500, ra: 3, at: 5, re: 100, t1: -24, t2: -20, t3: -26 }], ['Heavy squash', { f1: 90, f2: 2500, ra: 10, at: 1, re: 80, t1: -36, t2: -36, t3: -36, g1: 6, g2: 6, g3: 8 }]],
  deess: [['Vocal (low voice)', { fr: 4500, th: -30, ra: 8, ty: 0 }], ['Vocal (high voice)', { fr: 6500, th: -30, ra: 8, ty: 0 }],
    ['Gentle bell', { fr: 7000, th: -24, ra: 4, ty: 1 }], ['Tame cymbals', { fr: 9000, th: -28, ra: 6, ty: 1 }]],
  trans: [['Punchier drums', { at: 0.5, su: 0 }], ['Tight drums', { at: 0.2, su: -0.6, sl: 200 }], ['Soften the attack', { at: -0.6 }], ['More room', { su: 0.6, sl: 500 }]],
  flanger: [['Classic jet', { ra: 0.12, de: 0.9, dl: 1, fb: 0.7, mx: 0.5 }], ['Through the bar', { sy: 5, de: 0.8, fb: 0.6, mx: 0.5 }],
    ['Metallic (negative)', { ra: 0.3, de: 0.6, dl: 2, fb: -0.8, mx: 0.5 }], ['Subtle width', { ra: 0.1, de: 0.4, dl: 2.5, fb: 0.2, st: 180, mx: 0.3 }]],
  pitch: [['Octave up', { st: 12, mx: 1 }], ['Octave down', { st: -12, wi: 50, mx: 1 }], ['Fifth harmony', { st: 7, mx: 0.4 }], ['Detune thicken', { ce: 9, wi: 25, mx: 0.35 }]],
  space: [['Room', { si: 0.25, dc: 0.7, da: 0.5, pr: 0.005, mx: 0.2 }], ['Hall', { si: 0.8, dc: 2.8, da: 0.4, pr: 0.025, mx: 0.28 }],
    ['Cathedral', { si: 1, dc: 7, da: 0.35, pr: 0.04, lc: 120, mx: 0.35 }], ['Ambient wash', { si: 1, dc: 15, da: 0.6, pr: 0.08, mo: 0.9, lc: 200, mx: 0.5 }]],
};
export const factoryFx = (type) => (FACTORY_FX[type] || []).map(([name, p]) => ({ id: `f:${type}:${name}`, kind: 'fx', type, name, factory: true, data: { ...defaults(type), ...p } }));

// ------------------------------------------------------------- your presets ---
const clean = (x) => (Array.isArray(x) ? x : []).filter((q) => q && typeof q === 'object' && typeof q.name === 'string' && ['fx', 'chain', 'track', 'template', 'lab'].includes(q.kind) && q.data && typeof q.data === 'object');
export async function listPresets() { return clean(await tx('readonly', (s) => s.get(KEY), 'projects')); }
export async function writePresets(list) { return (await tx('readwrite', (s) => s.put(clean(list), KEY), 'projects')) !== null; }
export async function addPreset(q) {
  const list = await listPresets();
  const item = { id: uid('pr'), t: Date.now(), ...q, name: String(q.name).slice(0, 40) };
  // the same name of the same kind: replaced (saving again updates it)
  const same = list.findIndex((x) => x.kind === item.kind && x.type === item.type && x.name.toLowerCase() === item.name.toLowerCase());
  if (same >= 0) { item.id = list[same].id; list[same] = item; } else list.push(item);
  return (await writePresets(list)) ? item : null;
}
export async function removePreset(id) { return writePresets((await listPresets()).filter((x) => x.id !== id)); }

// --------------------------------------------------------------- the data ---
// an effect's settings (its sidechain is the project's: left out)
export const fxData = (d) => { const p = { ...d.p }; delete p.sc; return p; };
export function applyFx(d, data) { const sc = d.p.sc; d.p = { ...defaults(d.type), ...data }; if (sc) d.p.sc = sc; else delete d.p.sc; }

// a track's chain: audio effects, note effects, modulators (their targets follow the new ids)
export function chainData(t) {
  return structuredClone({ fx: (t.fx || []).map((d) => ({ ...d, p: fxData(d) })), nfx: t.nfx || [], mods: t.mods || [] });
}
// fresh ids for a chain, and its modulators pointed at them; follow (envelope follower) sources dropped to the track itself
function rekey(chain, trackId) {
  const map = new Map();
  const fx = (chain.fx || []).filter((d) => DEVICES[d.type]).map((d) => { const id = uid('f'); map.set(`fx:${d.id}:`, `fx:${id}:`); return { ...d, id, p: { ...defaults(d.type), ...d.p } }; });
  const nfx = (chain.nfx || []).map((d) => { const id = uid('n'); map.set(`nfx:${d.id}:`, `nfx:${id}:`); return { ...d, id }; });
  const mods = (chain.mods || []).map((m) => ({ ...m, id: uid('m'), src: m.type === 'follow' ? trackId : m.src,
    to: (m.to || []).map((x) => { for (const [a, b] of map) if (x.key.startsWith(a)) return { ...x, key: b + x.key.slice(a.length) }; return x; }) }));
  return { fx, nfx, mods };
}
// a chain onto a track: replacing its own, or after it (append)
export function applyChain(t, data, append = false) {
  const c = rekey(structuredClone(data), t.id);
  if (append) { t.fx = [...(t.fx || []), ...c.fx]; t.nfx = [...(t.nfx || []), ...c.nfx]; t.mods = [...(t.mods || []), ...c.mods]; }
  else { t.fx = c.fx; t.nfx = c.nfx; t.mods = c.mods; }
}

// a whole track but its song: the instrument and its sound, samples, chain, level, pan, colour
const TRACK_KEYS = ['kind', 'name', 'color', 'bank', 'engine', 'preset', 'kit', 'params', 'sample', 'pads', 'mpe', 'dx7', 'ext', 'midiCh', 'vol', 'pan', 'input', 'monitor', 'wam'];
export function trackData(t, p) {
  const out = {};
  for (const k of TRACK_KEYS) if (t[k] !== undefined) out[k] = structuredClone(t[k]);
  Object.assign(out, chainData(t));
  // the files its sampler or pads play (their audio stays in this browser; an exported preset carries it)
  const ids = [t.sample?.src, ...(t.sample?.zones || []).map((z) => z.src), ...Object.values(t.pads || {}).map((x) => x.src)].filter((x) => typeof x === 'string');
  out.assets = Object.fromEntries([...new Set(ids)].map((id) => [id, p.assets?.[id] || { name: 'sample', frames: 0 }]));
  return out;
}
// a track preset onto a track: its sound (the kind must match), and its chain; mix too unless soundOnly
export function applyTrack(t, data, p, { soundOnly = false } = {}) {
  if (data.kind !== t.kind) return false;
  for (const k of ['bank', 'engine', 'preset', 'kit', 'params', 'sample', 'pads', 'mpe', 'dx7', 'ext', 'midiCh', 'wam']) {
    if (data[k] !== undefined) t[k] = structuredClone(data[k]); else if (k === 'pads' || k === 'dx7') delete t[k];
  }
  if (!soundOnly) { for (const k of ['vol', 'pan', 'color']) if (data[k] !== undefined) t[k] = data[k]; applyChain(t, data); }
  for (const [id, m] of Object.entries(data.assets || {})) if (!p.assets[id]) p.assets[id] = structuredClone(m);
  return true;
}
