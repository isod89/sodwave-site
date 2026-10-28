// SPDX-License-Identifier: GPL-3.0-only
// DAWproject (the open exchange format of Bitwig, PreSonus and others: https://github.com/bitwig/dawproject, MIT):
// a .dawproject is a ZIP with project.xml, metadata.xml and the audio files.
// - Out: tracks (groups nested, returns as effect channels, the master), volume, pan, mute, solo, sends, the clips
//   (notes, audio with its offset, fades and warping), looped clips, automation of volume, pan, sends and tempo,
//   markers, the session's scenes, and the built-in devices other DAWs know (EQ, compressor, gate, limiter); the
//   other devices by name and settings. Kraken's own project travels inside too: Kraken reads it back whole.
// - In: the same from any DAW that writes the format; a plug-in Kraken cannot play is named in a warning.
import { x, pretty, parseXml, kids, kid, num } from './xml.js';
import { newProject, newTrack, newClip, newReturn, newAudioClip, uid, validate, APP_VERSION, COLORS, trackSources } from './project.js';
import { DEVICES, defaults } from './fx.js';
import { encodeWav } from './wav.js';
import { isFolder, expandFolder } from './comp.js';
import { srcAt } from './warp.js';
import { meterList } from './meter.js';

const RATE = 44100;
const lin = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));
const db = (g) => (g <= 0.001 ? -60 : Math.max(-60, Math.min(12, 20 * Math.log10(g))));
const KRAKEN_JSON = 'kraken/project.json';

// ------------------------------------------------------------------------------------------------- export ---
// p: the project; assets: Map id -> { L, R, name }; lib: the catalogs (sound names). -> [{ name, data }] for zip()
export function exportDawproject(p, { assets = new Map(), lib = null } = {}) {
  let n = 0;
  const id = (k = 'id') => `${k}${++n}`;
  const files = [], audioFile = new Map();                      // asset id -> path in the zip
  const media = (src) => {
    if (!src || !assets.get(src)) return null;
    if (!audioFile.has(src)) {
      const a = assets.get(src), path = `audio/${src.replace(/[^\w-]/g, '_')}.wav`;
      files.push({ name: path, data: encodeWav([a.L, a.R || a.L], RATE, 24) });
      audioFile.set(src, { path, seconds: a.L.length / RATE });
    }
    return audioFile.get(src);
  };
  const spb = 60 / p.bpm;
  const color = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);
  const real = (tag, unit, value, extra = {}) => { const i = id(); return { i, xml: x(tag, { unit, value, ...extra, id: i }) }; };
  const masterCh = id('master'), retIds = p.returns.map(() => id('return'));
  const params = new Map();                                     // `${trackId}:${key}` -> parameter id (automation)
  const tempoId = id('tempo'), ML = meterList(p), sigId = id('sig');

  // the devices of a rack
  const device = (d) => {
    const on = x('Enabled', { value: d.on !== false });
    const P = d.p, I = () => id();
    const rp = (tag, unit, value) => x(tag, { unit, value, id: I() });
    if (d.type === 'eq') {
      const band = (type, f, g, q, enabled) => x('Band', { type }, rp('Freq', 'hertz', f), g == null ? null : rp('Gain', 'decibel', g), q == null ? null : rp('Q', 'linear', q), x('Enabled', { value: enabled }));
      return x('Equalizer', { deviceName: 'EQ', deviceRole: 'audioFX', deviceVendor: 'Sodwave', id: I() }, on,
        band('highPass', P.hp, null, 0.707, P.hp > 21), band('lowShelf', P.lf, P.lg, 0.707, Math.abs(P.lg) > 0.05),
        band('bell', P.m1f, P.m1g, P.m1q, Math.abs(P.m1g) > 0.05), band('bell', P.m2f, P.m2g, P.m2q, Math.abs(P.m2g) > 0.05),
        band('highShelf', P.hf, P.hg, 0.707, Math.abs(P.hg) > 0.05), band('lowPass', P.lp, null, 0.707, P.lp < 19900));
    }
    if (d.type === 'comp') return x('Compressor', { deviceName: 'Compressor', deviceRole: 'audioFX', deviceVendor: 'Sodwave', id: I() }, on,
      rp('Attack', 'seconds', P.at / 1000), x('AutoMakeup', { value: false }), rp('OutputGain', 'decibel', P.mk), rp('Ratio', 'linear', P.ra), rp('Release', 'seconds', P.re / 1000), rp('Threshold', 'decibel', P.th));
    if (d.type === 'gate') return x('NoiseGate', { deviceName: 'Gate', deviceRole: 'audioFX', deviceVendor: 'Sodwave', id: I() }, on,
      rp('Attack', 'seconds', P.at / 1000), rp('Range', 'decibel', P.fl), rp('Release', 'seconds', P.re / 1000), rp('Threshold', 'decibel', P.th));
    if (d.type === 'limiter') return x('Limiter', { deviceName: 'Limiter', deviceRole: 'audioFX', deviceVendor: 'Sodwave', id: I() }, on,
      rp('InputGain', 'decibel', P.ga), rp('Release', 'seconds', P.re / 1000), rp('Threshold', 'decibel', P.ce));
    const spec = DEVICES[d.type];
    return x('Device', { deviceName: `Kraken ${spec?.name || d.type}`, deviceRole: 'audioFX', deviceVendor: 'Sodwave', deviceID: `kraken.fx.${d.type}`, loaded: false, id: I() },
      x('Parameters', {}, (spec?.params || []).filter((q) => q.k !== 'sc').map((q) => x('RealParameter', { name: q.l, unit: 'linear', min: q.min, max: q.max, value: P[q.k] ?? q.def, id: I() }))), on);
  };
  const instrument = (t) => {
    if (t.kind === 'audio' || t.kind === 'group') return null;
    const cat = lib?.[t.bank], eng = cat?.engines?.[t.engine];
    const name = t.kind === 'drum' ? `Kraken drums · ${lib?.sloop?.kits?.[t.kit] || 'kit'}` : t.kind === 'sampler' ? 'Kraken sampler' : t.kind === 'external' ? 'External MIDI' : t.kind === 'wam' ? `Web Audio Module · ${t.wam?.name || 'none'}`
      : `${cat?.pack?.name || (t.bank === 'sloop' ? 'SLOOP' : 'Clipper')} ${eng?.name || ''} · ${eng?.presets?.[t.preset] || ''}`.trim();
    return x('Device', { deviceName: name, deviceRole: 'instrument', deviceVendor: 'Sodwave', deviceID: `kraken.${t.kind}`, loaded: false, id: id() });
  };
  const channel = (t, chId, role, dest) => {
    const vol = real('Volume', 'linear', lin(t.vol ?? 0), { min: 0, max: 2, name: 'Volume' }), pan = real('Pan', 'normalized', ((t.pan ?? 0) + 1) / 2, { min: 0, max: 1, name: 'Pan' });
    params.set(`${t.id}:vol`, vol.i); params.set(`${t.id}:pan`, pan.i);
    const sends = role === 'master' || role === 'effect' ? [] : p.returns.map((r, i) => {
      const s = real('Volume', 'linear', t.sends?.[i] || 0, { min: 0, max: 1, name: 'Send' });
      params.set(`${t.id}:send${i}`, s.i);
      return x('Send', { destination: retIds[i], type: t.sendPre?.[i] ? 'pre' : 'post', id: id() }, s.xml);
    });
    const devs = [instrument(t), ...(t.fx || []).map(device)].filter(Boolean);
    return x('Channel', { audioChannels: 2, destination: dest, role, solo: !!t.solo, id: chId },
      devs.length ? x('Devices', {}, devs) : null, x('Mute', { value: !!t.mute, id: id(), name: 'Mute' }), pan.xml, sends.length ? x('Sends', {}, sends) : null, vol.xml);
  };
  // the structure: groups hold their tracks
  const chOf = new Map(p.tracks.map((t) => [t.id, id('ch')]));
  const trackXml = (t) => {
    const children = t.kind === 'group' ? p.tracks.filter((c) => c.out === t.id) : [];
    const dest = t.out && chOf.has(t.out) ? chOf.get(t.out) : masterCh;
    const content = t.kind === 'audio' ? 'audio' : t.kind === 'group' ? 'tracks' : 'notes';
    return x('Track', { contentType: content, loaded: true, id: t.id, name: t.name, color: color(t.color) },
      channel(t, chOf.get(t.id), t.kind === 'group' ? 'submix' : 'regular', dest), children.map(trackXml));
  };
  const top = p.tracks.filter((t) => !(t.out && chOf.has(t.out)));
  const master = x('Track', { contentType: 'audio', loaded: true, id: id('mastertrack'), name: 'Master' }, channel({ id: '__master', vol: p.master.vol, pan: 0, fx: p.master.fx }, masterCh, 'master', null));
  const returns = p.returns.map((r, i) => x('Track', { contentType: 'audio', loaded: true, id: id('rtrack'), name: r.name },
    channel({ id: `__ret${i}`, vol: r.vol, pan: 0, mute: r.mute, fx: [...(r.type === 'reverb' ? [{ id: 'rv', type: 'reverb', on: true, p: { si: r.size ?? 0.82, da: r.damp ?? 0.35, pr: r.pre ?? 0.02, mx: 1 } }]
      : r.type === 'delay' ? [{ id: 'dl', type: 'delay', on: true, p: { ...defaults('delay'), fb: r.fb ?? 0.42, to: r.tone ?? 0.55, mx: 1 } }] : []), ...(r.fx || [])] }, retIds[i], 'effect', masterCh)));

  // a clip
  const noteXml = (nt, drum) => {
    const out = [], r = Math.max(1, nt.r || 1), t0 = Math.max(0, nt.t + (nt.m || 0));
    for (let k = 0; k < r; k++) out.push(x('Note', { time: t0 + (k * nt.d) / r, duration: (nt.d / r) * (r > 1 ? 0.8 : 1), channel: drum ? 9 : 0, key: nt.n, vel: (k ? nt.v * 0.82 : nt.v) / 127, rel: 0.5 }));
    return out;
  };
  const audioXml = (src, alg = null) => { const m = media(src); return m ? x('Audio', { algorithm: alg, channels: 2, sampleRate: RATE, duration: m.seconds, id: id() }, x('File', { path: m.path })) : null; };
  const clipXml = (c, t, start = c.start) => {
    if (t.kind === 'audio' || c.src || c.takes) {
      const parts = isFolder(c) ? expandFolder(c, spb).map((s) => ({ ...s, name: c.name })) : [c];
      return parts.map((s) => {
        const fades = { fadeTimeUnit: 'seconds', fadeInTime: s.fadeIn ?? 0.005, fadeOutTime: s.fadeOut ?? 0.005 };
        const st = s === c ? start : s.start;
        if ((c.warp === 'stretch' && c.orig && c.bpm) || (c.warp === 'repitch' && c.bpm)) {     // warped: the other DAW follows the tempo
          const src = c.warp === 'stretch' ? c.orig : s.src, a = audioXml(src, c.warp === 'stretch' ? 'stretch' : 'repitch');
          if (!a) return null;
          // the map from the clip's beats to the file's seconds: its two ends, and its warp markers between
          let warps;
          if (c.warp === 'stretch') {
            const ob = (s.offset || 0) * p.bpm / 60, wm = c.wm || [];   // (the clip starts this many beats into the file)
            warps = [{ t: 0, c: srcAt(ob, wm, c.bpm) }, ...wm.filter((m) => m.b - ob > 1e-6 && m.b - ob < s.len - 1e-6).map((m) => ({ t: m.b - ob, c: m.s })), { t: s.len, c: srcAt(ob + s.len, wm, c.bpm) }];
          } else warps = [{ t: 0, c: s.offset || 0 }, { t: s.len, c: (s.offset || 0) + s.len * 60 / c.bpm }];
          return x('Clip', { time: st, duration: s.len, playStart: 0, contentTimeUnit: 'beats', name: c.name, ...fades },
            x('Warps', { contentTimeUnit: 'seconds', timeUnit: 'beats', id: id() }, a, warps.map((w) => x('Warp', { time: w.t, contentTime: w.c }))));
        }
        const a = audioXml(s.src);
        if (!a) return null;
        return x('Clip', { time: st, duration: s.len, playStart: s.offset || 0, playStop: (s.offset || 0) + s.len * spb, contentTimeUnit: 'seconds', name: c.name, ...fades }, a);
      });
    }
    const loop = c.loop > 0 ? c.loop : c.len;
    return x('Clip', { time: start, duration: c.len, playStart: 0, ...(loop < c.len - 1e-9 ? { loopStart: 0, loopEnd: loop } : {}), name: c.name },
      x('Notes', { id: id() }, (c.notes || []).filter((nt) => nt.t < loop - 1e-9).flatMap((nt) => noteXml(nt, t.kind === 'drum'))));
  };
  // automation lanes of a track
  const autoXml = (t) => Object.entries(t.auto || {}).map(([key, pts]) => {
    const pid = params.get(`${t.id}:${key}`);
    if (!pid || !pts.length) return null;
    const unit = key === 'vol' || key.startsWith('send') ? 'linear' : 'normalized';
    const conv = key === 'vol' ? lin : key === 'pan' ? (v) => (v + 1) / 2 : (v) => v;
    return x('Points', { unit, id: id() }, x('Target', { parameter: pid }), pts.map((q) => x('RealPoint', { time: q.t, value: conv(q.v), interpolation: 'linear' })));
  });

  const structure = x('Structure', {}, master, top.map(trackXml), returns);
  const lanes = p.tracks.map((t) => {
    const clips = (t.clips || []).flatMap((c) => clipXml(c, t)).filter(Boolean);
    const autos = autoXml(t).filter(Boolean);
    if (!clips.length && !autos.length) return null;
    return x('Lanes', { track: t.id, id: id() }, clips.length ? x('Clips', { id: id() }, clips) : null, autos);
  });
  const markers = (p.markers || []).length ? x('Markers', { id: id() }, p.markers.map((m) => x('Marker', { time: m.t, name: m.name }))) : null;
  const tempo = (p.tempo || []).length ? x('TempoAutomation', { unit: 'bpm', id: id() }, x('Target', { parameter: tempoId }), p.tempo.map((q) => x('RealPoint', { time: q.t, value: q.v, interpolation: 'linear' }))) : null;
  const sigs = ML.length > 1 ? x('TimeSignatureAutomation', { id: id() }, x('Target', { parameter: sigId }), ML.map((m) => x('TimeSignaturePoint', { time: m.t, numerator: m.n, denominator: m.d }))) : null;
  const arrangement = x('Arrangement', { id: id() }, x('Lanes', { timeUnit: 'beats', id: id() }, lanes), markers, tempo, sigs);
  const scenes = p.scenes.map((s, i) => {
    const slots = p.tracks.filter((t) => t.slots?.[i]).map((t) => x('ClipSlot', { track: t.id, hasStop: true, id: id() }, clipXml({ ...t.slots[i], start: 0 }, t, 0)));
    return x('Scene', { id: id(), name: s.name }, x('Lanes', { timeUnit: 'beats', id: id() }, slots));
  });
  const transport = x('Transport', {}, x('Tempo', { unit: 'bpm', min: 20, max: 300, value: p.bpm, id: tempoId, name: 'Tempo' }), x('TimeSignature', { numerator: ML[0].n, denominator: ML[0].d, id: sigId }));
  const project = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` + pretty(x('Project', { version: '1.0' },
    x('Application', { name: 'Kraken', version: APP_VERSION }), transport, structure, arrangement, x('Scenes', {}, scenes)));
  const meta = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` + pretty(x('MetaData', {}, x('Title', {}, p.name), x('Comment', {}, `Made with Kraken ${APP_VERSION} (Sodwave)`)));
  // Kraken's own project, its audio by the same paths: opened in Kraken, nothing is lost
  for (const t of p.tracks) for (const id of trackSources(t)) media(id);
  const kp = { ...p, savedWith: APP_VERSION, __media: Object.fromEntries([...audioFile].map(([k, v]) => [k, v.path])) };
  return [{ name: 'project.xml', data: project }, { name: 'metadata.xml', data: meta }, { name: KRAKEN_JSON, data: JSON.stringify(kp) }, ...files];
}

// ------------------------------------------------------------------------------------------------- import ---
// entries: [{ name, data: Uint8Array }] from the ZIP. -> { project, media: [{ id, path, bytes }], warp: [{ track, clip, bpm }], warnings, kraken }
export function importDawproject(entries, { lib = null } = {}) {
  const byName = new Map(entries.map((e) => [e.name.replace(/^\.\//, ''), e.data]));
  const text = (name) => { const d = byName.get(name); return d ? new TextDecoder().decode(d) : null; };
  const warnings = [];
  // made by Kraken: its own project, whole
  const kj = text(KRAKEN_JSON);
  if (kj) {
    try {
      const raw = JSON.parse(kj), paths = raw.__media || {};
      delete raw.__media;
      const project = validate(raw);
      const mediaList = Object.entries(paths).filter(([, path]) => byName.has(path)).map(([mid, path]) => ({ id: mid, path, bytes: byName.get(path) }));
      return { project, media: mediaList, warp: [], warnings, kraken: true };
    } catch (e) { warnings.push(`Kraken's own copy could not be read (${e.message}): read as any DAWproject.`); }
  }
  const xml = text('project.xml');
  if (!xml) throw new Error('This file is not a DAWproject (no project.xml in it).');
  const root = parseXml(xml);
  if (!root || root.name !== 'Project') throw new Error('This file is not a DAWproject.');
  const p = newProject();
  p.tracks = []; p.returns = []; p.markers = []; p.tempo = [];
  const title = parseXml(text('metadata.xml') || '<MetaData/>');
  p.name = (kid(title, 'Title')?.text || '').trim().slice(0, 40) || 'Imported';
  const transport = kid(root, 'Transport');
  p.bpm = Math.max(20, Math.min(300, num(kid(transport, 'Tempo'), 'value', 120)));
  const ts = kid(transport, 'TimeSignature'), tsD = [1, 2, 4, 8, 16].includes(num(ts, 'denominator', 4)) ? num(ts, 'denominator', 4) : 4;
  p.meters = [{ t: 0, n: Math.max(1, Math.min(32, Math.round(num(ts, 'numerator', 4)))), d: tsD }];
  p.sig = (p.meters[0].n * 4) / tsD;
  const spb = 60 / p.bpm;

  // the structure
  const chToTrack = new Map(), chToReturn = new Map(), paramKey = new Map();   // ids -> where they go
  const pending = [];                                            // channels whose destination is resolved at the end
  const soundFor = (name, devs) => {
    const s = `${name} ${devs}`.toLowerCase();
    const kind = /bass|sub|808/.test(s) ? 'BASS' : /pad|string|choir|atmo/.test(s) ? 'PAD' : /lead|solo|synth/.test(s) ? 'LEAD' : /organ/.test(s) ? 'ORGAN'
      : /pluck|bell|guitar|harp|marimba/.test(s) ? 'PLUCK' : /brass|stab|horn/.test(s) ? 'STAB' : 'KEYS';
    const snd = lib?.sounds?.find((x2) => x2.kind === kind) || lib?.sounds?.[0];
    return snd ? { bank: snd.bank, engine: snd.engine, preset: snd.preset } : {};
  };
  const builtin = (d) => {
    const v = (tag, unit) => { const e = kid(d, tag); if (!e) return null; const val = num(e, 'value', NaN); return unit === 's' ? val * 1000 : val; };
    const on = kid(d, 'Enabled')?.attrs.value !== 'false';
    if (d.name === 'Equalizer') {
      const p0 = defaults('eq');
      for (const b of kids(d, 'Band')) {
        const f = num(kid(b, 'Freq'), 'value', 1000), g = num(kid(b, 'Gain'), 'value', 0), q = num(kid(b, 'Q'), 'value', 1), en = kid(b, 'Enabled')?.attrs.value !== 'false';
        if (!en) continue;
        const ty = b.attrs.type;
        if (ty === 'highPass') p0.hp = f; else if (ty === 'lowPass') p0.lp = f;
        else if (ty === 'lowShelf') { p0.lf = f; p0.lg = g; } else if (ty === 'highShelf') { p0.hf = f; p0.hg = g; }
        else if (ty === 'bell' || ty === 'notch' || ty === 'bandPass') { if (!p0.__m1) { p0.m1f = f; p0.m1g = ty === 'notch' ? -15 : g; p0.m1q = q; p0.__m1 = 1; } else { p0.m2f = f; p0.m2g = ty === 'notch' ? -15 : g; p0.m2q = q; } }
      }
      delete p0.__m1;
      return { id: uid('f'), type: 'eq', on, p: p0 };
    }
    if (d.name === 'Compressor') return { id: uid('f'), type: 'comp', on, p: { ...defaults('comp'), ...(v('Threshold') != null ? { th: v('Threshold') } : {}), ...(v('Ratio') != null ? { ra: v('Ratio') } : {}), ...(v('Attack', 's') != null ? { at: v('Attack', 's') } : {}), ...(v('Release', 's') != null ? { re: v('Release', 's') } : {}), ...(v('OutputGain') != null ? { mk: Math.max(0, v('OutputGain')) } : {}) } };
    if (d.name === 'NoiseGate') return { id: uid('f'), type: 'gate', on, p: { ...defaults('gate'), ...(v('Threshold') != null ? { th: v('Threshold') } : {}), ...(v('Attack', 's') != null ? { at: v('Attack', 's') } : {}), ...(v('Release', 's') != null ? { re: v('Release', 's') } : {}), ...(v('Range') != null ? { fl: v('Range') } : {}) } };
    if (d.name === 'Limiter') return { id: uid('f'), type: 'limiter', on, p: { ...defaults('limiter'), ...(v('Threshold') != null ? { ce: Math.min(0, v('Threshold')) } : {}), ...(v('InputGain') != null ? { ga: Math.max(0, v('InputGain')) } : {}), ...(v('Release', 's') != null ? { re: v('Release', 's') } : {}) } };
    return null;
  };
  const readDevices = (ch, owner) => {
    const fx = [];
    const devs = kids(kid(ch, 'Devices'));
    for (const d of devs) {
      const role = d.attrs.deviceRole;
      if (role === 'instrument' || role === 'noteFX') { if (d.name !== 'Device' || d.attrs.deviceVendor !== 'Sodwave') warnings.push(`${owner}: ${d.attrs.deviceName || 'an instrument'} (${d.name.replace('Plugin', '')}) is not in Kraken: a Kraken sound plays its notes.`); continue; }
      const b = builtin(d);
      if (b) { fx.push(b); continue; }
      const kt = (d.attrs.deviceID || '').match(/^kraken\.fx\.(\w+)$/);
      if (kt && DEVICES[kt[1]]) {                                   // one of ours, by its settings
        const spec = DEVICES[kt[1]], pr = kids(kid(d, 'Parameters')), pp = defaults(kt[1]);
        spec.params.filter((q) => q.k !== 'sc').forEach((q, i) => { const e = pr.find((x2) => x2.attrs.name === q.l) || pr[i]; if (e) pp[q.k] = num(e, 'value', q.def); });
        fx.push({ id: uid('f'), type: kt[1], on: kid(d, 'Enabled')?.attrs.value !== 'false', p: pp });
        continue;
      }
      warnings.push(`${owner}: the ${d.attrs.deviceName || 'plug-in'} effect (${d.name.replace('Plugin', '')}) is not in Kraken: left out.`);
    }
    return fx;
  };
  const readChannel = (ch, t, owner) => {
    const vol = kid(ch, 'Volume'), pan = kid(ch, 'Pan'), mute = kid(ch, 'Mute');
    if (vol) { t.vol = vol.attrs.unit === 'decibel' ? num(vol, 'value', 0) : db(num(vol, 'value', 1)); if (vol.attrs.id) paramKey.set(vol.attrs.id, { owner: t, key: 'vol', unit: vol.attrs.unit }); }
    if (pan) { t.pan = pan.attrs.unit === 'normalized' || !pan.attrs.unit ? num(pan, 'value', 0.5) * 2 - 1 : num(pan, 'value', 0) / 100; if (pan.attrs.id) paramKey.set(pan.attrs.id, { owner: t, key: 'pan', unit: pan.attrs.unit || 'normalized' }); }
    if (mute) t.mute = mute.attrs.value === 'true';
    if (ch.attrs.solo === 'true') t.solo = true;
    t.fx = readDevices(ch, owner);
    return kids(kid(ch, 'Sends'), 'Send');
  };
  const walkTrack = (tr, parent) => {
    const ch = kid(tr, 'Channel'), role = ch?.attrs.role || 'regular', name = (tr.attrs.name || 'TRACK').toUpperCase().slice(0, 24);
    const types = (tr.attrs.contentType || '').split(/\s+/);
    if (role === 'master') {
      const t = { id: '__master', vol: 0 };
      if (ch) { readChannel(ch, t, 'MASTER'); p.master.vol = t.vol; p.master.fx = t.fx || []; }
      return;
    }
    if (role === 'effect') {
      const r = newReturn('none', name.slice(0, 16));
      const t = { vol: -4 };
      if (ch) readChannel(ch, t, name);
      r.vol = t.vol; r.mute = !!t.mute; r.fx = t.fx || [];
      // our own reverb or delay, first in its rack: the return's own effect again
      const first = r.fx[0];
      if (first?.type === 'reverb') { r.type = 'reverb'; r.size = first.p.si; r.damp = first.p.da; r.pre = first.p.pr; r.fx.shift(); }
      else if (first?.type === 'delay') { r.type = 'delay'; r.time = 0.75; r.fb = first.p.fb; r.tone = first.p.to; r.fx.shift(); }
      if (ch?.attrs.id) chToReturn.set(ch.attrs.id, p.returns.length);
      p.returns.push(r);
      return;
    }
    const children = kids(tr, 'Track');
    const group = role === 'submix' || types.includes('tracks') || children.length > 0;
    const devNames = kids(kid(ch, 'Devices')).map((d) => d.attrs.deviceName || '').join(' ');
    const drum = !group && types.includes('notes') && /drum|kit|perc|beat|909|808 kit|snare|kick/i.test(`${name} ${devNames}`);
    const kind = group ? 'group' : types.includes('notes') ? (drum ? 'drum' : 'synth') : types.includes('audio') ? 'audio' : 'synth';
    const t = newTrack(kind, p.tracks.length, { name, color: /^#[0-9a-f]{6}$/i.test(tr.attrs.color || '') ? tr.attrs.color : COLORS[p.tracks.length % COLORS.length],
      ...(kind === 'synth' ? soundFor(name, devNames) : {}), ...(kind === 'drum' ? { kit: Math.max(0, lib?.sloop?.kits?.indexOf('ACOUSTIC') ?? 0) } : {}) });
    t.vol = 0; t.sends = [];
    if (ch) {
      const sends = readChannel(ch, t, name);
      pending.push({ t, ch, sends, parent });
      if (ch.attrs.id) chToTrack.set(ch.attrs.id, t);
    }
    chToTrack.set(tr.attrs.id, t);
    p.tracks.push(t);
    for (const c of children) walkTrack(c, t);
  };
  for (const el of kids(kid(root, 'Structure'))) {
    if (el.name === 'Track') walkTrack(el, null);
    else if (el.name === 'Channel' && el.attrs.role === 'master') walkTrack({ name: 'Track', attrs: { name: 'Master' }, children: [el] }, null);
  }
  // routing and sends, now that every channel is known
  for (const { t, ch, sends, parent } of pending) {
    const dest = ch.attrs.destination, g = dest && chToTrack.get(dest);
    t.out = g && g.kind === 'group' && g !== t ? g.id : parent ? parent.id : 'master';
    t.sends = p.returns.map(() => 0);
    for (const s of sends) {
      const i = chToReturn.get(s.attrs.destination);
      if (i == null) continue;
      const v = kid(s, 'Volume');
      t.sends[i] = Math.max(0, Math.min(1, v?.attrs.unit === 'decibel' ? lin(num(v, 'value', -60)) : num(v, 'value', 0)));
      if (s.attrs.type === 'pre') (t.sendPre ||= [])[i] = true;
      if (v?.attrs.id) paramKey.set(v.attrs.id, { owner: t, key: `send${i}`, unit: v.attrs.unit || 'linear' });
    }
  }
  if (!p.returns.length) p.returns = newProject().returns;          // (a song with no return: Kraken's two, unused)
  for (const t of p.tracks) while (t.sends.length < p.returns.length) t.sends.push(0);

  // time: the arrangement in beats or seconds
  const toBeats = (v, unit) => (unit === 'seconds' ? v / spb : v);
  // the notes a clip plays over its length: its content from playStart, looped between loopStart and loopEnd
  const collectNotes = (content, unit, offset = 0) => {
    const out = [];
    if (!content) return out;
    if (content.name === 'Notes') for (const ne of kids(content, 'Note')) out.push({ t: toBeats(num(ne, 'time'), unit) + offset, d: toBeats(num(ne, 'duration', 0.25), unit), n: num(ne, 'key', 60), v: Math.round(Math.max(1, Math.min(127, num(ne, 'vel', 0.8) * 127))) });
    else if (content.name === 'Lanes') for (const c of kids(content)) out.push(...collectNotes(c, content.attrs.timeUnit || unit, offset));
    else if (content.name === 'Clips') for (const c of kids(content, 'Clip')) out.push(...clipNotes(c, content.attrs.timeUnit || unit).map((nn) => ({ ...nn, t: nn.t + toBeats(num(c, 'time'), content.attrs.timeUnit || unit) + offset })));
    return out;
  };
  const clipNotes = (c, unit) => {
    const cu = c.attrs.contentTimeUnit || unit;
    const content = kids(c).find((e) => ['Notes', 'Lanes', 'Clips'].includes(e.name));
    const notes = collectNotes(content, cu);
    const len = toBeats(num(c, 'duration', Math.max(4, ...notes.map((q) => q.t + q.d))), unit);
    const ps = toBeats(num(c, 'playStart', 0), cu), ls = toBeats(num(c, 'loopStart', NaN), cu), le = toBeats(num(c, 'loopEnd', NaN), cu);
    const out = [];
    if (Number.isFinite(ls) && Number.isFinite(le) && le > ls) {
      // first from playStart to loopEnd, then the loop again and again
      let t = 0, from = ps;
      while (t < len - 1e-9) {
        const to = t === 0 ? Math.max(le, ps) : le;
        for (const q of notes) if (q.t >= from - 1e-9 && q.t < to - 1e-9) { const at = t + q.t - from; if (at < len - 1e-9) out.push({ ...q, t: at, d: Math.min(q.d, len - at) }); }
        t += to - from; from = ls;
        if (to - from <= 1e-9 && t === 0) break;
      }
    } else for (const q of notes) { const at = q.t - ps; if (at >= -1e-9 && at < len - 1e-9) out.push({ ...q, t: Math.max(0, at), d: Math.min(q.d, len - at) }); }
    return out;
  };
  const mediaList = [], warpList = [];
  const audioOf = (el) => { if (!el) return null; if (el.name === 'Audio') return el; for (const c of kids(el)) { const a = audioOf(c); if (a) return a; } return null; };
  const readClip = (c, unit, t, start) => {
    if (c.attrs.enable === 'false') return null;
    const name = (c.attrs.name || (t.kind === 'audio' ? 'AUDIO' : 'CLIP')).toUpperCase().slice(0, 40);
    const len = toBeats(num(c, 'duration', 4), unit);
    if (!(len > 0.001)) return null;
    if (t.kind === 'audio') {
      const warps = kid(c, 'Warps'), a = audioOf(warps || c);
      const path = kid(a, 'File')?.attrs.path;
      if (!a || !path) return null;
      if (!byName.has(path)) { warnings.push(`${t.name}: ${path} is not inside the file (an external file): left out.`); return null; }
      const mid = `dp${uid('a')}`;
      mediaList.push({ id: mid, path, bytes: byName.get(path) });
      const ac = newAudioClip(start, len, mid, name);
      const ft = c.attrs.fadeTimeUnit === 'beats' ? spb : 1;
      ac.fadeIn = Math.max(0.002, num(c, 'fadeInTime', 0.005) * ft); ac.fadeOut = Math.max(0.002, num(c, 'fadeOutTime', 0.005) * ft);
      if (warps) {
        const ws = kids(warps, 'Warp').map((w) => ({ t: num(w, 'time'), c: num(w, 'contentTime') })).sort((q, r) => q.t - r.t);
        const wu = warps.attrs.timeUnit || c.attrs.contentTimeUnit || 'beats';
        if (ws.length >= 2) {
          const f = ws[0], l = ws.at(-1), secPerBeat = (l.c - f.c) / Math.max(1e-9, toBeats(l.t - f.t, wu));
          const ps = toBeats(num(c, 'playStart', 0), c.attrs.contentTimeUnit || 'beats');
          ac.offset = Math.max(0, f.c + (ps - toBeats(f.t, wu)) * secPerBeat);
          const srcBpm = 60 / secPerBeat;
          // more than two points that do not lie on one line: warp markers
          const bent = ws.length > 2 && ws.some((w) => Math.abs((w.c - f.c) - toBeats(w.t - f.t, wu) * secPerBeat) > 0.002);
          if (bent && a.attrs.algorithm !== 'repitch') {
            ac.warp = 'stretch'; ac.bpm = +srcBpm.toFixed(4); ac.offset = ps * 60 / p.bpm;
            ac.wm = ws.map((w) => ({ s: w.c, b: toBeats(w.t, wu) }));
            warpList.push({ track: t.id, clip: ac.id, bpm: ac.bpm, markers: ac.wm });
          } else if (Math.abs(srcBpm - p.bpm) > 0.01) { ac.warp = a.attrs.algorithm === 'repitch' ? 'repitch' : 'stretch'; ac.bpm = +srcBpm.toFixed(4); if (ac.warp === 'stretch') warpList.push({ track: t.id, clip: ac.id, bpm: ac.bpm }); }
        }
      } else {
        const cu = c.attrs.contentTimeUnit || 'seconds';
        ac.offset = Math.max(0, cu === 'beats' ? num(c, 'playStart', 0) * spb : num(c, 'playStart', 0));
      }
      return ac;
    }
    const nc = newClip(start, len, name);
    nc.notes = clipNotes(c, unit).filter((q) => q.d > 0);
    nc.loop = len;
    const ls = num(c, 'loopStart', NaN), le = num(c, 'loopEnd', NaN), ps = num(c, 'playStart', 0);
    if (ls === 0 && ps === 0 && le > 0 && toBeats(le, c.attrs.contentTimeUnit || unit) < len - 1e-9) {   // a plain loop: a Kraken pattern
      nc.loop = toBeats(le, c.attrs.contentTimeUnit || unit);
      nc.notes = nc.notes.filter((q) => q.t < nc.loop - 1e-9).map((q) => ({ ...q, d: Math.min(q.d, nc.loop - q.t) }));
    }
    return nc;
  };
  const autoPoints = (pts, unit) => {
    const target = kid(pts, 'Target'), map = paramKey.get(target?.attrs.parameter);
    if (!map) { if (target?.attrs.expression) warnings.push(`A ${target.attrs.expression} lane (MIDI expression) was left out.`); return; }
    const conv = map.key === 'vol' ? (v) => (map.unit === 'decibel' ? v : db(v)) : map.key === 'pan' ? (v) => (map.unit === 'normalized' ? v * 2 - 1 : v / 100) : (v) => (map.unit === 'decibel' ? lin(v) : v);
    const out = [];
    for (const q of kids(pts)) {
      if (q.name === 'Target') continue;
      const tt = toBeats(num(q, 'time'), unit), v = conv(q.name === 'BoolPoint' ? (q.attrs.value === 'true' ? 1 : 0) : num(q, 'value'));
      if (q.attrs.interpolation === 'hold' && out.length) out.push({ t: Math.max(out.at(-1).t, tt - 0.001), v: out.at(-1).v });
      out.push({ t: tt, v });
    }
    if (out.length && map.owner.auto) map.owner.auto[map.key] = out;
  };
  // the arrangement
  const arr = kid(root, 'Arrangement');
  const walkLanes = (el, unit, t) => {
    for (const c of kids(el)) {
      const u = c.attrs.timeUnit || unit, tt = c.attrs.track ? chToTrack.get(c.attrs.track) || t : t;
      if (c.name === 'Lanes') walkLanes(c, u, tt);
      else if (c.name === 'Clips' && tt && tt.kind !== 'group') for (const cl of kids(c, 'Clip')) { const k = readClip(cl, u, tt, toBeats(num(cl, 'time'), u)); if (k) tt.clips.push(k); }
      else if (c.name === 'Notes' && tt && tt.kind !== 'group') { const k = newClip(0, 4, 'NOTES'); k.notes = collectNotes(c, u); k.len = k.loop = Math.max(4, Math.ceil(Math.max(0, ...k.notes.map((q) => q.t + q.d)) / 4) * 4); tt.clips.push(k); }
      else if (c.name === 'Points') autoPoints(c, u);
    }
  };
  if (arr) {
    const lanes = kid(arr, 'Lanes');
    if (lanes) walkLanes(lanes, lanes.attrs.timeUnit || 'beats', null);
    const mk = kid(arr, 'Markers'), mu = mk?.attrs.timeUnit || lanes?.attrs.timeUnit || 'beats';
    for (const m of kids(mk, 'Marker')) p.markers.push({ id: uid('k'), t: toBeats(num(m, 'time'), mu), name: (m.attrs.name || 'MARKER').toUpperCase().slice(0, 40) });
    const tsa = kid(arr, 'TimeSignatureAutomation');
    if (tsa) {
      const tu = tsa.attrs.timeUnit || lanes?.attrs.timeUnit || 'beats';
      const pts = kids(tsa, 'TimeSignaturePoint').map((q) => ({ t: toBeats(num(q, 'time'), tu), n: Math.round(num(q, 'numerator', 4)), d: num(q, 'denominator', 4) })).filter((q) => q.n >= 1 && q.n <= 32 && [1, 2, 4, 8, 16].includes(q.d));
      if (pts.length) { p.meters = pts; p.sig = meterList(p)[0].len; }
    }
    const ta = kid(arr, 'TempoAutomation');
    if (ta) {                                                      // (its target: the transport's tempo)
      const tu = ta.attrs.timeUnit || lanes?.attrs.timeUnit || 'beats';
      p.tempo = kids(ta, 'RealPoint').map((q) => ({ t: toBeats(num(q, 'time'), tu), v: num(q, 'value', p.bpm) }));
      if (p.tempo.length === 1) { p.bpm = p.tempo[0].v; p.tempo = []; }
    }
  }
  // the session
  const scenes = kids(kid(root, 'Scenes'), 'Scene');
  if (scenes.length) {
    p.scenes = scenes.map((s, i) => ({ id: uid('s'), name: (s.attrs.name || `SCENE ${i + 1}`).toUpperCase().slice(0, 24) }));
    while (p.scenes.length < 8) p.scenes.push({ id: uid('s'), name: `SCENE ${p.scenes.length + 1}` });
    for (const t of p.tracks) t.slots = p.scenes.map(() => null);
    scenes.forEach((s, i) => {
      const slots = [];
      (function find(el) { for (const c of kids(el)) { if (c.name === 'ClipSlot') slots.push(c); else find(c); } })(s);
      for (const sl of slots) {
        const t = chToTrack.get(sl.attrs.track), c = kid(sl, 'Clip');
        if (!t || !c || t.kind === 'group') continue;
        const k = readClip(c, 'beats', t, 0);
        if (k) { delete k.start; t.slots[i] = k; }
      }
    });
  }
  if (!p.tracks.length) throw new Error('This DAWproject has no track Kraken can open.');
  const plugins = warnings.length;
  return { project: validate(p), media: mediaList, warp: warpList, warnings: plugins > 6 ? [...warnings.slice(0, 6), `…and ${plugins - 6} more.`] : warnings, kraken: false };
}
