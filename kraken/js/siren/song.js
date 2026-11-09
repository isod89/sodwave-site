// SPDX-License-Identifier: GPL-3.0-only
// A whole song written by SIREN's brain (siren/brain.js), as a Kraken project: the brain plays its track sixteenth by
// sixteenth, from its first bar to its last (its intro, grooves, builds, drops, breaks and outro, or a song's verses,
// choruses and bridge), and every event lands in the arrangement: one track a layer (drums, bass, sub, arp, hook, pad,
// stabs, risers), one clip a section, the sections as markers, SIREN's filters, its build's high-pass sweep, its
// filtered intros and its quieter breaks as automation, the kick ducking the rest. Its sounds and drum kits are SIREN's
// for SIREN's eight styles (siren/data.js: the FM-1's own selection), Kraken's for the others (siren/sounds.js), each at
// the level siren/levels.js measured for it in its layer. The same seed in the same style is the same song, and for
// SIREN's styles the same as the FM-1 plays (its code, as SIREN shows it: TECHNO 11R-3N07).
import { Brain, STYLES, code as seedCode, uncode } from './brain.js';
import { SIREN_CUR, SIREN_KITS } from './data.js';
import { EXT_SOUNDS } from './sounds.js';
import { TRIMS } from './levels.js';
import { newProject, newTrack, newClip, uid, COLORS } from '../project.js';
import { defaults } from '../fx.js';

// Kraken's styles (templates.js STARTERS ids) -> the brain's
export const SIREN_STYLE = {
  house: 'HOUSE', techno: 'TECHNO', trance: 'TRANCE', dnb: 'DNB', psy: 'PSY', acid: 'ACID', rave: 'RAVE', hard: 'HARD',
  dubstep: 'DUBSTEP', futurebass: 'FUTUREBASS', ukg: 'UKG', disco: 'DISCO', synthwave: 'SYNTHWAVE', chiptune: 'CHIPTUNE',
  hiphop: 'HIPHOP', trap: 'TRAP', drill: 'DRILL', phonk: 'PHONK', rnb: 'RNB', lofi: 'LOFI',
  reggaeton: 'REGGAETON', afrobeats: 'AFROBEATS', amapiano: 'AMAPIANO', pop: 'POP', rock: 'ROCK', cinematic: 'CINEMATIC', ambient: 'AMBIENT',
};
export const SIREN_OWN = new Set(['TECHNO', 'TRANCE', 'PSY', 'ACID', 'RAVE', 'HARD', 'DNB', 'HOUSE']);
const LAYERS = ['DRUMS', 'BASS', 'SUB', 'ARP', 'HOOK', 'PAD', 'STAB', 'FX'];
const SECS = ['INTRO', 'GROOVE', 'BUILD', 'DROP', 'BREAK', 'PEAK', 'OUTRO'];
// each layer's place in SIREN's mix (siren.c SIREN_MIX: level in P_LEVEL steps, 112 = 0 dB, 2 a dB; pan, delay and
// reverb sends of 127), the sub's from the bass's; its colour in the arrangement
const MIX = { BASS: [110, 0, 0, 0], SUB: [108, 0, 0, 0], ARP: [97, -16, 40, 32], HOOK: [102, 10, 36, 38], PAD: [97, 0, 6, 70], STAB: [100, 16, 25, 38], FX: [95, 0, 0, 57] };
const COLOR = { DRUMS: 0, BASS: 1, SUB: 1, ARP: 7, HOOK: 5, PAD: 2, STAB: 3, FX: 6 };
const NAMES = { DRUMS: 'DRUMS', BASS: 'BASS', SUB: 'SUB', ARP: 'ARP', HOOK: 'HOOK', PAD: 'PAD', STAB: 'STABS', FX: 'RISER' };
// each style's drums in SIREN's mix (siren.c SIREN_DMIX: level %, reverb and delay sends of 127)
const DMIX = { TECHNO: [100, 12, 6], TRANCE: [100, 30, 8], PSY: [95, 12, 12], ACID: [100, 8, 4], RAVE: [100, 16, 6], HARD: [100, 18, 6], DNB: [100, 14, 6], HOUSE: [100, 22, 8] };
// (Kraken: hard techno's kits are distorted, measured louder than they sound against the rest: up a little)
const DTRIM = { HARD: 3 };
// Kraken's scales by name (notefx.js SCALES)
const SCALE_IX = { major: 0, minor: 1, dorian: 2, phrygian: 3, lydian: 4, mixolydian: 5, harmonic: 7 };
// SIREN's track filter (siren.c: per mille -> closed by up to 40 steps, the FX's by 45) as Hz on Kraken's AUTO FILTER
const cutHz = (L, c) => { const k = L === 'FX' ? (c >= 950 ? 0 : (950 - c) / 850) : (c >= 700 ? 0 : (700 - c) / 700); return Math.round(18000 * 2 ** (-k * (L === 'FX' ? 6.5 : 5.5))); };
// the wobble's period (siren.c: rate3 thirds of a sixteenth) on the AUTO FILTER's LFO (fx.js SYNC: 1/32 .. 1 bar)
const SYNC_BEATS = [0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 4];
const wobRate = (rate3) => { const b = rate3 / 12; let best = 0; SYNC_BEATS.forEach((x, i) => { if (Math.abs(Math.log(x / b)) < Math.abs(Math.log(SYNC_BEATS[best] / b))) best = i; }); return best; };
const fx = (type, p = {}) => ({ id: uid('f'), type, on: true, p: { ...defaults(type), ...p } });
const db = (x) => Math.round(x * 10) / 10;

// a sound by its engine and preset name: in Clipper, then SLOOP, then a community engine (x:ID)
function findSound(lib, name) {
  const [eng, pre] = name.split(':');
  for (const b of ['clipper', 'sloop', ...Object.keys(lib).filter((k) => k.startsWith('x:'))]) {
    const cat = lib[b]; if (!cat?.engines) continue;
    const e = cat.engines.findIndex((x) => x.name === eng), i = e < 0 ? -1 : cat.engines[e].presets.indexOf(pre);
    if (i >= 0) return { bank: b, engine: e, preset: i };
  }
  return null;
}
export const sirenMisses = [];                                       // (sounds or kits the library has not: the tests read it)

// the palette the brain picks from: SIREN's own for its styles (the same order: the same picks as the FM-1), Kraken's
function palette(style) {
  if (SIREN_OWN.has(style)) return { CUR: { [style]: SIREN_CUR[style] }, DKITS: { [style]: SIREN_KITS[style] } };
  const S = EXT_SOUNDS[style];
  return { CUR: { [style]: S.sounds }, DKITS: { [style]: S.kits.map((name) => ({ name, kickN16: 0, kick2N16: 0 })) } };
}

// the brain, playing one track from its first sixteenth to its last: -> { brain, steps: [{ notes, params, master, info, bass }], plan }
export function writeSong(style, seed) {
  const b = new Brain();
  b.styleLock = true;
  b.setPalette(palette(style));
  b.setSeed(seed >>> 0, style);
  const plan = b.plan.map((x) => [...x]), ik = b.introKind, sounds = { ...b.sounds }, info = { bpm: b.bpm, key: b.key, scale: b.scaleName, swing: b.swing };
  const steps = [];
  while (b.trackNo === 0 && steps.length < 16 * 512) {
    const bassNow = b.sounds.BASS;
    const ev = b.step16();
    ev.bass = bassNow;
    steps.push(ev);
  }
  return { brain: b, steps, plan, ik, sounds, info };
}

// -> a Kraken project
export function sirenSong(lib, id, { seed = (Math.random() * 2 ** 32) >>> 0 } = {}) {
  const style = SIREN_STYLE[id] || id;
  if (!STYLES[style]) throw new Error(`SIREN has no style ${id}`);
  if (typeof seed === 'string') seed = uncode(seed);
  const st = STYLES[style], own = SIREN_OWN.has(style), X = own ? null : EXT_SOUNDS[style];
  const { steps, plan, sounds, info } = writeSong(style, seed);
  const p = newProject();
  const label = (sec) => (st.labels && st.labels[sec]) || sec;
  const nice = id.length > 3 ? id[0].toUpperCase() + id.slice(1) : id.toUpperCase();
  p.name = `${STYLE_TITLE[style] || nice} · ${seedCode(seed)}`;
  p.bpm = info.bpm; p.key = { root: info.key, sc: SCALE_IX[info.scale] ?? 1 }; p.swing = Math.round((2 * info.swing) / 1000 * 100) / 100;
  p.siren = { style, id, seed, code: seedCode(seed) };
  // the sections: where each begins (sixteenths), its name, its number (CHORUS 2)
  const secs = [], count = {};
  let at = 0;
  for (const [sec, len] of plan) {
    const name = label(sec);
    count[name] = (count[name] || 0) + 1;
    secs.push({ sec, name, n: count[name], at, len: len * 16 });
    at += len * 16;
  }
  const total = Math.min(at, steps.length);
  for (const s of secs) if (count[s.name] > 1) s.name = `${s.name} ${s.n}`;
  p.markers = secs.map((s) => ({ id: uid('k'), t: s.at / 4, name: s.name }));
  p.loop = { on: false, a: 0, b: 16 };

  // ---- the tracks
  const tracks = [], byLayer = {};
  const bus = newTrack('group', 0, { name: 'SIREN', vol: -2.5 });
  bus.color = '#e8e8e8';
  const out = bus.id;
  // the drums: SIREN's kit (the DRUM SYNTH's bytes, its kick tuned to the key) or Kraken's own
  const dk = sounds.DRUMS;
  const drums = newTrack('drum', 0, { name: 'DRUMS', out });
  if (own && dk.kitData) {
    const kd = dk.kitData, lanes = kd.lanes.map((l) => [...l]);
    const tune = (lane, n16) => { if (n16) { lanes[lane][2] = n16 >> 4; lanes[lane][3] = n16 & 15; } };
    tune(0, dk.kickN16); tune(14, dk.kick2N16);
    drums.kit = Math.max(0, lib.sloop.kits.indexOf('SYN1'));
    drums.dsyn = { name: kd.name.slice(0, 8), crush: kd.crush | 0, src: 0, sounds: lanes };
    const m = DMIX[style];
    drums.vol = db(20 * Math.log10(m[0] / 100) + (TRIMS[`DRUMS|${kd.name}`] ?? 0) - 5.5 + (DTRIM[style] || 0)); drums.sends = [m[1] / 127, m[2] / 127];
  } else {
    const k = lib.sloop.kits.indexOf(dk.kit);
    if (k < 0) sirenMisses.push(`kit ${dk.kit}`);
    drums.kit = Math.max(0, k);
    drums.vol = db((TRIMS[`DRUMS|${dk.kit}`] ?? 0) - 5.5 + (X.drumsDb || 0)); drums.sends = [X.drumSends?.[0] ?? 0.08, X.drumSends?.[1] ?? 0.02];
    if (X.drumFx) drums.fx = X.drumFx.map(([t, q]) => fx(t, q));
  }
  drums.color = COLORS[COLOR.DRUMS];
  byLayer.DRUMS = [drums];
  // the melodic layers: a track for each sound a layer plays (the dubstep bass changes sound inside its drops)
  const soundTrack = (L, name) => {
    const s = findSound(lib, name);
    if (!s) { sirenMisses.push(name); return null; }
    const [lv, pan, dly, rev] = MIX[L], trim = TRIMS[`${L === 'SUB' ? 'BASS' : L}|${name}`] ?? 0;
    const t = newTrack('synth', 0, { name: NAMES[L], ...s, out, vol: db((lv - 112) / 2 + trim + (X?.layerDb?.[L] || 0)), pan: Math.round((pan / 64) * 100) / 100, sends: [Math.round((rev / 127) * 0.55 * 100) / 100, Math.round((dly / 127) * 0.45 * 100) / 100] });
    t.color = COLORS[COLOR[L]]; t.siren = { layer: L, sound: name };
    const extra = X?.fx?.[L]; if (extra) t.fx.push(...extra.map(([ty, q]) => fx(ty, q)));
    return t;
  };
  const layerSound = (L, ev) => (L === 'BASS' ? ev.bass : L === 'SUB' ? (X?.sub || 'ANALOG:SUB BASS') : sounds[L]);
  const trackOf = (L, ev) => {
    const name = layerSound(L, ev);
    if (!name) return null;
    const list = byLayer[L] ||= [];
    let t = list.find((x) => x.siren.sound === name);
    if (!t) { t = soundTrack(L, name); if (!t) return null; if (list.length) t.name = `${NAMES[L]} ${list.length + 1}`; list.push(t); }
    return t;
  };
  // ---- the notes, section by section: a clip for each track that plays in it
  const clips = new Map();                                          // track id -> Map(section index -> clip)
  const clipOf = (t, si) => {
    let m = clips.get(t.id); if (!m) clips.set(t.id, m = new Map());
    let c = m.get(si);
    if (!c) { const s = secs[si]; c = newClip(s.at / 4, s.len / 4, secs[si].name); m.set(si, c); }
    return c;
  };
  const sampled = !own;
  let si = 0;
  for (let i = 0; i < total; i++) {
    while (si < secs.length - 1 && i >= secs[si + 1].at) si++;
    const ev = steps[i], s0 = secs[si].at;
    for (const [L, n, v, len, off] of ev.notes) {
      const t = L === 'DRUMS' ? drums : trackOf(L, ev);
      if (!t) continue;
      const c = clipOf(t, si), tt = (i - s0 + (off || 0) / 6) / 4;
      let note = n;
      if (L === 'DRUMS' && sampled && n === 75) note = 56;             // (the clave: a sampled kit's bell)
      c.notes.push({ t: Math.round(tt * 10000) / 10000, d: L === 'DRUMS' ? 0.25 : Math.max(0.05, Math.round((len / 4) * 0.92 * 1000) / 1000), n: note, v });
    }
  }
  // ---- the automation: SIREN's filters on each layer, the wobble, the build's high-pass and the filtered intro on the
  // bus, the bus's level (a break breathes lower, a drop hits), the reverb as the brain asks
  const pts = new Map();                                             // key -> [[step, value]]
  const put = (key, i, v) => { let a = pts.get(key); if (!a) pts.set(key, a = []); if (!a.length || a[a.length - 1][1] !== v) a.push([i, v]); };
  const filt = {};                                                   // layer -> its AUTO FILTER (on every track of the layer)
  for (let i = 0; i < total; i++) {
    const ev = steps[i];
    for (const [L, kind, v] of ev.params) {
      if (kind === 'cut') put(`cut:${L}`, i, cutHz(L, v));
      else if (kind === 'wob') { put('wob:rate', i, wobRate(v.rate3)); put('wob:depth', i, Math.round(v.depth / 10) / 100); }
    }
    if (st.dropBass || st.bass.includes('roller')) { if (ev.notes.some((x) => x[0] === 'BASS') && !ev.params.some((x) => x[1] === 'wob')) put('wob:depth', i, 0); }
    put('hp', i, ev.master.hp > 0 ? Math.round(30 * 2 ** (Math.min(1000, ev.master.hp) / 1000 * 7.5)) : 30);
    put('lp', i, ev.master.lp > 0 ? Math.round(18000 * 2 ** (-(ev.master.lp / 1000) * 6.5)) : 18000);
    put('gain', i, db(20 * Math.log10(Math.max(1, ev.master.gain) / 1000) - 2.5));   // (2.5 dB of headroom under the master's limiter)
    put('verb', i, Math.round((450 + ev.master.verb / 2) / 10) / 100);
  }
  // [[step, v]] -> automation points in beats: a value held to the next change, a ramp where it moves step by step
  const toAuto = (a) => {
    const o = [];
    for (let k = 0; k < a.length; k++) {
      const [i, v] = a[k], prev = a[k - 1];
      if (prev && i - prev[0] > 1) o.push({ t: Math.max(0, i / 4 - 0.001), v: prev[1] });
      if (!(k > 1 && i - a[k - 1][0] === 1 && a[k - 1][0] - a[k - 2][0] === 1 && Math.abs((v - a[k - 1][1]) - (a[k - 1][1] - a[k - 2][1])) < 1e-9)) o.push({ t: i / 4, v });
      else o[o.length - 1] = { t: i / 4, v };                        // (a straight ramp: its end point moves on)
    }
    return o;
  };
  const melodic = ['BASS', 'SUB', 'ARP', 'HOOK', 'PAD', 'STAB', 'FX'];
  for (const L of melodic) for (const t of byLayer[L] || []) {
    const key = `cut:${L === 'SUB' ? 'BASS' : L}`, a = pts.get(key);
    const wob = L === 'BASS' && pts.get('wob:depth')?.some(([, v]) => v > 0);
    if (!a?.some(([, v]) => v < 18000) && !wob) continue;
    const f = fx('filter', { ty: 0, fr: 18000, q: wob ? 3 : 0.8, lr: 5, ld: 0, mx: 1 });
    t.fx.unshift(f);
    if (a) t.auto[`fx:${f.id}:fr`] = toAuto(a);
    if (wob) { t.auto[`fx:${f.id}:ld`] = toAuto(pts.get('wob:depth')); if (pts.get('wob:rate')) t.auto[`fx:${f.id}:lr`] = toAuto(pts.get('wob:rate')); }
    filt[L] = f;
  }
  // the kick ducks the rest (SIREN's duck, its depth at a drop's)
  for (const L of melodic) for (const t of byLayer[L] || []) if (L !== 'FX') t.fx.push(fx('comp', { th: L === 'BASS' || L === 'SUB' ? -30 : -26, ra: L === 'BASS' || L === 'SUB' ? 8 : 5, at: 1, re: 140, kn: 3, sc: drums.id }));
  // the reverb: wetter in a break and a build
  const verb = pts.get('verb');
  if (verb && verb.length > 1) for (const L of ['ARP', 'HOOK', 'PAD', 'STAB']) for (const t of byLayer[L] || []) t.auto.send0 = toAuto(verb.map(([i, v]) => [i, Math.round(t.sends[0] * v / 0.575 * 100) / 100]));
  // the bus: the build's high-pass sweep, the filtered intro, the level
  const hp = fx('filter', { ty: 1, fr: 30, q: 0.9, lr: 5, ld: 0, mx: 1 }), lp = fx('filter', { ty: 0, fr: 18000, q: 0.9, lr: 5, ld: 0, mx: 1 });
  if (pts.get('hp')?.some(([, v]) => v > 30)) { bus.fx.push(hp); bus.auto[`fx:${hp.id}:fr`] = toAuto(pts.get('hp')); }
  if (pts.get('lp')?.some(([, v]) => v < 18000)) { bus.fx.push(lp); bus.auto[`fx:${lp.id}:fr`] = toAuto(pts.get('lp')); }
  if (pts.get('gain')?.length > 1) bus.auto.vol = toAuto(pts.get('gain'));
  // lo-fi: the vinyl under everything
  const extraTracks = [];
  if (X?.under) {
    const s = findSound(lib, X.under[0]);
    if (s) {
      const t = newTrack('synth', 0, { name: X.under[1], ...s, out, vol: X.under[2], sends: [0, 0] }); t.color = COLORS[4];
      const c = newClip(0, total / 4, X.under[1]); c.notes.push({ t: 0, d: total / 4, n: 60, v: 80 }); t.clips.push(c); extraTracks.push(t);
    } else sirenMisses.push(X.under[0]);
  }
  // ---- the clips into their tracks; tracks that never play left out
  for (const L of LAYERS) for (const t of byLayer[L] || []) {
    const m = clips.get(t.id);
    if (!m || !m.size) continue;
    t.clips = [...m.values()].sort((a, b) => a.start - b.start);
    tracks.push(t);
  }
  tracks.push(...extraTracks);
  // ---- the session: a scene for each kind of section (its first 4 bars, looped), for GROOVE and the clip launcher
  const scen = [], seen = new Set();
  secs.forEach((s, k) => { const base = s.name.replace(/ \d+$/, ''); if (!seen.has(base) && scen.length < 8 && s.len >= 32) { seen.add(base); scen.push([k, base]); } });
  p.scenes = p.scenes.slice(0, Math.max(scen.length, 1));
  scen.forEach(([k, name], j) => {
    p.scenes[j].name = name;
    const bars = Math.min(4, secs[k].len / 16), from = secs[k].at / 4, to = from + bars * 4;
    for (const t of tracks) {
      const c = clips.get(t.id)?.get(k); if (!c) continue;
      const loop = { ...newClip(0, bars * 4, name), notes: c.notes.filter((n) => n.t < bars * 4).map((n) => ({ ...n, d: Math.min(n.d, bars * 4 - n.t) })) };
      delete loop.start;
      while (t.slots.length <= j) t.slots.push(null);
      t.slots[j] = loop;
      void to;
    }
  });
  for (const t of [...tracks, bus]) t.slots = (t.slots || []).slice(0, p.scenes.length).concat(Array(Math.max(0, p.scenes.length - (t.slots || []).length)).fill(null));
  tracks.forEach((t, i) => { if (!t.color) t.color = COLORS[i % COLORS.length]; });
  p.tracks = [...tracks, bus];
  return p;
}

// an 8-bar loop from the song (its first drop, or chorus): for a style's LOOP start, the clips looping from bar 1
export function sirenLoop(lib, id, opts = {}) {
  const p = sirenSong(lib, id, opts), mk = p.markers;
  const want = mk.find((m) => /DROP|CHORUS|HOOK|CLIMAX|BLOOM|^B\b/.test(m.name)) || mk[Math.min(1, mk.length - 1)];
  const a = want.t, b = a + 32;
  for (const t of p.tracks) {
    if (t.kind === 'group') { t.auto = {}; t.fx = []; continue; }
    const notes = t.clips.flatMap((c) => c.notes.map((n) => ({ ...n, t: n.t + c.start }))).filter((n) => n.t >= a && n.t < b).map((n) => ({ ...n, t: Math.round((n.t - a) * 10000) / 10000, d: Math.min(n.d, b - n.t) }));
    const c = newClip(0, 32, 'LOOP'); c.notes = notes;
    t.clips = notes.length ? [c] : [];
    for (const k of Object.keys(t.auto)) { const pts = t.auto[k].filter((q) => q.t >= a && q.t < b).map((q) => ({ t: q.t - a, v: q.v })); if (pts.length) t.auto[k] = pts; else delete t.auto[k]; }
  }
  p.tracks = p.tracks.filter((t) => t.kind === 'group' || t.clips.length);
  p.markers = []; p.loop = { on: true, a: 0, b: 32 };
  return p;
}

export const STYLE_TITLE = { HOUSE: 'House', TECHNO: 'Techno', TRANCE: 'Trance', DNB: 'Drum & bass', PSY: 'Psytrance', ACID: 'Acid', RAVE: 'Rave', HARD: 'Hard techno',
  DUBSTEP: 'Dubstep', FUTUREBASS: 'Future bass', UKG: 'UK garage', DISCO: 'Disco', SYNTHWAVE: 'Synthwave', CHIPTUNE: 'Chiptune', HIPHOP: 'Hip-hop', TRAP: 'Trap',
  DRILL: 'Drill', PHONK: 'Phonk', RNB: 'R&B', LOFI: 'Lo-fi', REGGAETON: 'Reggaeton', AFROBEATS: 'Afrobeats', AMAPIANO: 'Amapiano', POP: 'Pop', ROCK: 'Rock',
  CINEMATIC: 'Cinematic', AMBIENT: 'Ambient' };
