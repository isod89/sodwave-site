// SPDX-License-Identifier: GPL-3.0-only
// Web Audio Modules 2.0 (WAM, the open plugin standard of the web) in Kraken: the model and the routing. No DOM:
// the engine (worklet, Node tests) and the page both use it.
//
// A plugin effect is a device of a track's rack: { id, type: 'wam', on, p: {}, url, name, state }. A plugin
// instrument is a track of kind 'wam': t.wam = { url, name, state }. state is the plugin's own getState(), kept with
// the project so it opens as it was left. The plugins run outside the Kraken worklet (wam-host.js): a track's sound
// leaves the engine through an extra output (a "slot"), goes through its plugins, and comes back through the
// matching input one render quantum later (a loop in a Web Audio graph needs a delay of at least one quantum).
// The other tracks are delayed to match (plugin delay compensation), so everything stays in time.
import { DEVICES } from './fx.js';

export const WAM_SLOTS = 8;          // stereo pairs out of and back into the engine: plugin chains playing at once
export const QUANTUM = 128;          // frames: one trip through the plugins and back

// a plugin effect has no knobs of Kraken's own: registered as a device so that every list of a rack's devices
// (automation lanes, MIDI learn, presets, the mixer's count) takes it as one; the engine's racks skip it
DEVICES.wam ??= { name: 'PLUGIN', params: [] };

// free plugins of the WAM community, hosted by the WAM group (https://github.com/boourns/wam-community)
const COMMUNITY = 'https://www.webaudiomodules.com/community/plugins/';
export const KNOWN = [
  ['Synth-101', 'burns-audio/synth101/index.js', 'inst', 'A monophonic classic (SH-101 style)'],
  ['Spectrum: Modal', 'burns-audio/modal/index.js', 'inst', 'Modal synthesis voice'],
  ['Soundfont Player', 'burns-audio/soundfont/index.js', 'inst', 'Polyphonic soundfonts'],
  ['Simple Delay', 'burns-audio/delay/index.js', 'fx', 'Stereo filtered delay'],
  ['Simple EQ', 'burns-audio/simpleEQ/index.js', 'fx', 'Three-band equalizer'],
  ['Microverb', 'burns-audio/reverb/index.js', 'fx', 'Convolution reverb, vintage units'],
  ['Simple Distortion', 'burns-audio/distortion/index.js', 'fx', 'Waveshaper'],
  ['Big Muff', 'wimmics/BigMuff/index.js', 'fx', 'Fuzz pedal'],
  ['TS9 Overdrive', 'wimmics/TS9_Overdrive/index.js', 'fx', 'Overdrive pedal'],
  ['KBVerb', 'wimmics/kbverb/index.js', 'fx', 'Reverb'],
  ['Grey Hole', 'wimmics/greyhole/index.js', 'fx', 'Huge diffuse reverb'],
  ['StonePhaser', 'wimmics/stonephaser/index.js', 'fx', 'Analog-style phaser'],
  ['ThruZeroFlanger', 'wimmics/ThruZeroFlanger/index.js', 'fx', 'Tape flanger'],
  ['PingPongDelay', 'wimmics/pingpongdelay/dist/index.js', 'fx', 'Ping-pong delay'],
  ['Stereo Enhancer', 'wimmics/StereoEnhancer/index.js', 'fx', 'Stereo width'],
].map(([name, path, kind, about]) => ({ name, url: COMMUNITY + path, kind, about }));

// ------------------------------------------------------------------ model ---
const MAX_STATE = 8e6;               // characters of JSON: a state larger than this is not kept
// a plugin's address: http(s), or a path on this site; nothing else (no javascript:, data:, blob:)
export function cleanUrl(u) {
  if (typeof u !== 'string') return null;
  u = u.trim();
  if (!u || u.length > 1000 || /[\s\u0000-\u001f]/.test(u)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  return u;
}
// a short name from the address: .../stonephaser/index.js -> stonephaser
export function nameFromUrl(u) {
  const parts = String(u).split(/[?#]/)[0].split('/').filter((x) => x && !/^(index\.m?js|dist|src|build)$/i.test(x));
  return (parts.pop() || 'PLUGIN').replace(/\.m?js$/i, '').slice(0, 40);
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// a plugin's state as JSON: its buffers and typed arrays in base64, what JSON cannot hold left out
export function packState(x, depth = 0) {
  if (x == null || typeof x === 'boolean' || typeof x === 'string') return x;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x !== 'object' || depth > 40) return undefined;
  if (x instanceof ArrayBuffer) return { $wamBytes: 'ArrayBuffer', b64: b64(new Uint8Array(x)) };
  if (ArrayBuffer.isView(x)) return { $wamBytes: x.constructor.name, b64: b64(new Uint8Array(x.buffer, x.byteOffset, x.byteLength)) };
  if (Array.isArray(x)) return x.map((v) => packState(v, depth + 1) ?? null);
  if (x instanceof Map) return { $wamMap: [...x].map(([k, v]) => [packState(k, depth + 1) ?? null, packState(v, depth + 1) ?? null]) };
  const o = {};
  for (const k of Object.keys(x)) { const v = packState(x[k], depth + 1); if (v !== undefined) o[k] = v; }
  return o;
}
const VIEWS = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, DataView };
export function unpackState(x) {
  if (Array.isArray(x)) return x.map(unpackState);
  if (!x || typeof x !== 'object') return x;
  if (typeof x.$wamBytes === 'string' && typeof x.b64 === 'string') {
    const u8 = unb64(x.b64), buf = u8.buffer;
    if (x.$wamBytes === 'ArrayBuffer') return buf;
    const V = VIEWS[x.$wamBytes] || Uint8Array, size = V.BYTES_PER_ELEMENT || 1;
    return V === DataView ? new DataView(buf) : new V(buf, 0, Math.floor(u8.length / size));
  }
  if (Array.isArray(x.$wamMap)) return new Map(x.$wamMap.map(([k, v]) => [unpackState(k), unpackState(v)]));
  const o = {};
  for (const k of Object.keys(x)) o[k] = unpackState(x[k]);
  return o;
}
// a state as saved: JSON only, not too large (else none: the plugin opens with its defaults)
export function cleanState(s) {
  if (s === undefined || s === null) return null;
  try { const js = JSON.stringify(packState(s)); return js && js.length <= MAX_STATE ? JSON.parse(js) : null; } catch { return null; }
}
// a plugin as saved ({ url, name, state }); null when it has no usable address
export function cleanPlugin(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const url = cleanUrl(x.url);
  if (!url) return null;
  const name = typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 60) : nameFromUrl(url);
  return { url, name, state: cleanState(x.state) };
}
// a plugin effect of a rack, repaired (null: left out)
export function cleanWamFx(d) {
  const pl = cleanPlugin(d);
  return pl && { ...d, type: 'wam', on: d.on !== false, p: {}, ...pl };
}

// ---------------------------------------------------------------- routing ---
// which slot each plugin chain gets. Requests, in project order: a plugin instrument (key 'i:<track id>'), then each
// run of plugin effects that follow each other in a rack (key 'f:<first device id>'; a Kraken effect switched off
// between two plugins does not break the run). ok(key): its plugins loaded (a run keeps the ones that did). prev
// (key -> slot): the slots already in use keep their place, so a change elsewhere never moves a playing chain.
// -> { tracks: { id: { inst: { slot, key } | null, runs: [{ slot, key, ids }] } }, slots: { key: slot }, dropped: [key], lat }
export function wamPlan(p, { ok = () => true, prev = null, max = WAM_SLOTS } = {}) {
  const want = [];
  for (const t of p.tracks || []) {
    if (t.kind === 'wam' && t.wam?.url && !t.frozen && ok(`i:${t.id}`)) want.push({ t, key: `i:${t.id}`, inst: true });
    let run = null;
    for (const d of t.fx || []) {
      if (d.on === false) continue;
      if (d.type !== 'wam') { run = null; continue; }
      if (!d.url || !ok(`f:${d.id}`)) continue;
      if (!run) { run = { t, key: `f:${d.id}`, ids: [] }; want.push(run); }
      run.ids.push(d.id);
    }
  }
  const slots = {}, used = new Set(), dropped = [];
  if (prev) for (const w of want) { const s = prev instanceof Map ? prev.get(w.key) : prev[w.key]; if (Number.isInteger(s) && s >= 0 && s < max && !used.has(s)) { slots[w.key] = s; used.add(s); } }
  for (const w of want) {
    if (w.key in slots) continue;
    let s = 0; while (used.has(s)) s++;
    if (s >= max) { dropped.push(w.key); continue; }
    slots[w.key] = s; used.add(s);
  }
  const tracks = {}, lat = {};
  for (const w of want) {
    if (!(w.key in slots)) continue;
    const x = (tracks[w.t.id] ||= { inst: null, runs: [] });
    if (w.inst) x.inst = { slot: slots[w.key], key: w.key }; else x.runs.push({ slot: slots[w.key], key: w.key, ids: w.ids });
    lat[w.t.id] = (lat[w.t.id] || 0) + QUANTUM;
  }
  return { tracks, slots, dropped, lat };
}
// plugin delay compensation: how many frames each track waits after its rack so that every sound reaches the
// master at the same time; total: how late the master is. A group's input is aligned on its latest track.
// (Sends leave after the wait: in time with the other tracks of their group.)
export function pdc(p, lat = {}) {
  const tracks = p.tracks || [], by = new Map(tracks.map((t) => [t.id, t]));
  const parent = (t) => { const g = by.get(t.out); return g && g.kind === 'group' && g.id !== t.id ? g : null; };
  const into = new Map(), memo = new Map();
  const arrival = (t, seen = new Set()) => {
    if (memo.has(t.id)) return memo.get(t.id);
    if (seen.has(t.id)) return 0;                                 // (a loop: validate() never lets one through)
    seen.add(t.id);
    const v = (t.kind === 'group' ? inAt(t, seen) : 0) + (lat[t.id] || 0);
    memo.set(t.id, v);
    return v;
  };
  const inAt = (g, seen = new Set()) => {
    if (into.has(g.id)) return into.get(g.id);
    let m = 0;
    for (const c of tracks) if (c !== g && parent(c) === g) m = Math.max(m, arrival(c, seen));
    into.set(g.id, m);
    return m;
  };
  let total = 0;
  for (const t of tracks) if (!parent(t)) total = Math.max(total, arrival(t));
  const delay = {};
  for (const t of tracks) { const g = parent(t), d = (g ? inAt(g) : total) - arrival(t); if (d > 0) delay[t.id] = d; }
  return { delay, total };
}
// how late a render comes out of the engine: the master's lateness, or (freezing a track: its sound alone, before
// its rack) its instrument's trip through its plugin
export function renderLatency(p, plan, { freezeTrack = null } = {}) {
  if (freezeTrack) return plan.tracks[freezeTrack]?.inst ? QUANTUM : 0;
  return pdc(p, plan.lat).total;
}

// a stereo delay of n frames, block by block (the compensation of one track). key: the sound before it (a sidechain
// keyed by this track hears it on time, as the track it ducks does)
export class Lag {
  constructor(n) {
    let s = 64; while (s < n + 64) s <<= 1;
    this.n = n; this.m = s - 1; this.L = new Float32Array(s); this.R = new Float32Array(s); this.w = 0;
    this.key = { L: new Float32Array(0), R: new Float32Array(0) };
  }
  run(L, R, len) {
    const bl = this.L, br = this.R, m = this.m, n = this.n, k = this.key;
    if (k.L.length !== len) { k.L = new Float32Array(len); k.R = new Float32Array(len); }
    k.L.set(L.subarray(0, len)); k.R.set(R.subarray(0, len));
    let w = this.w;
    for (let i = 0; i < len; i++) {
      bl[w] = L[i]; br[w] = R[i];
      const r = (w - n) & m;
      L[i] = bl[r]; R[i] = br[r];
      w = (w + 1) & m;
    }
    this.w = w;
  }
}
