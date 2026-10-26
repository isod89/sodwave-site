// SPDX-License-Identifier: GPL-3.0-only
// Presets, where you need them: an effect's ☰ (factory and yours), the chain's PRESETS (replace or add after),
// a track's menu (save it, load one), + TRACK > From a preset, SOUNDS > ★ MY SOUNDS, PROJECT > Save as a
// template, and PROJECT > My presets (rename, delete, export them all as one file with their samples, import).
import { h } from './kit.js';
import { listPresets, addPreset, removePreset, writePresets, factoryFx, fxData, applyFx, chainData, applyChain, trackData, applyTrack, PRESET_FORMAT } from '../presets.js';
import { DEVICES } from '../fx.js';
import { zip, unzip, saveFile } from '../io.js';
import { encodeWav } from '../wav.js';
import { validate, uid } from '../project.js';

const KIND_LABEL = { fx: 'EFFECTS', chain: 'EFFECT CHAINS', track: 'TRACKS & SOUNDS', template: 'PROJECT TEMPLATES', lab: 'LAB PATCHES' };

// a name, asked in a small dialog: -> the name, or null
export function askName(app, title, def = '', note = '') {
  return new Promise((resolve) => {
    let done = false;
    const inp = h('input', { value: def, maxlength: 40, style: { width: '100%' }, 'aria-label': 'Name' });
    const ok = () => { if (done) return; done = true; const v = inp.value.trim(); resolve(v || null); };
    const m = app.modal(title, [note ? h('p', { class: 'hint', text: note }) : null, inp].filter(Boolean), [['Cancel', () => { done = true; resolve(null); }], ['Save', ok, true]]);
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { ok(); m.close(); } if (e.key === 'Escape') { done = true; resolve(null); } });
    new MutationObserver((_x, o) => { if (!m.box.isConnected) { o.disconnect(); if (!done) { done = true; resolve(null); } } }).observe(document.body, { childList: true });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

// ------------------------------------------------------------- an effect ---
// o: the device panel's owner (a track or a bus: { t?, edit(fn) }), d: the effect
export async function fxPresetSheet(app, o, d) {
  const mine = (await listPresets()).filter((x) => x.kind === 'fx' && x.type === d.type);
  const load = (q) => () => { o.edit((fx) => { const x = fx.find((y) => y.id === d.id); if (x) applyFx(x, q.data); }); app.toast(`${DEVICES[d.type].name}: ${q.name}.`); };
  app.sheet(`${DEVICES[d.type].name} presets`, [
    ...mine.map((q) => [`★ ${q.name.toUpperCase()}`, load(q)]),
    ...factoryFx(d.type).map((q) => [q.name.toUpperCase(), load(q)]),
    ['SAVE THESE SETTINGS AS A PRESET…', async () => {
      const name = await askName(app, `Save a ${DEVICES[d.type].name.toLowerCase()} preset`, '', 'It will be in the ☰ of every ' + DEVICES[d.type].name.toLowerCase() + ', in every project.');
      if (!name) return;
      const cur = (o.t ? app.store.track(o.t.id)?.fx : null)?.find((y) => y.id === d.id) || d;
      app.toast((await addPreset({ kind: 'fx', type: d.type, name, data: fxData(cur) })) ? `Preset "${name}" saved.` : 'The preset could not be saved (storage?).');
    }, 'go'],
    ['☁ PUBLISH THESE SETTINGS TO THE HUB…', () => {                // (the community hub: ui/hub.js)
      const cur = (o.t ? app.store.track(o.t.id)?.fx : null)?.find((y) => y.id === d.id) || d;
      app.hub?.publish({ preset: { kind: 'fx', type: d.type, name: DEVICES[d.type].name, data: fxData(cur) } });
    }],
  ]);
}

// ------------------------------------------------------------- a chain ---
export async function chainPresetSheet(app, o) {
  const mine = (await listPresets()).filter((x) => x.kind === 'chain');
  const put = (q, append) => {
    if (o.t) app.store.change((p) => { applyChain(p.tracks.find((x) => x.id === o.t.id), q.data, append); });
    else o.edit((fx) => { const tmp = { fx: append ? [...fx] : [] }; applyChain(tmp, { fx: q.data.fx }, true); fx.splice(0, fx.length, ...tmp.fx); });
    app.toast(`${q.name}: ${append ? 'added after the chain' : 'the chain replaced'}.`);
  };
  const pick = (q) => () => app.modal(q.name, [h('p', { class: 'hint', text: `${q.data.fx?.length || 0} effect(s)${q.data.nfx?.length ? `, ${q.data.nfx.length} note effect(s)` : ''}${q.data.mods?.length ? `, ${q.data.mods.length} modulator(s)` : ''}.` })],
    [['Cancel'], ['Add after the chain', () => put(q, true)], ['Replace the chain', () => put(q, false), true]]);
  app.sheet(`Effect chain presets · ${o.name}`, [
    ...mine.map((q) => [`★ ${q.name.toUpperCase()}`, pick(q)]),
    ...(mine.length ? [] : [['(none yet: save one below)', () => {}]]),
    ['SAVE THIS CHAIN AS A PRESET…', async () => {
      const name = await askName(app, 'Save the effect chain', '', o.t ? 'Its effects, note effects and modulators, with their settings.' : 'Its effects, with their settings.');
      if (!name) return;
      const src = o.t ? app.store.track(o.t.id) : { fx: o.fx };
      const data = o.t ? chainData(src) : { fx: chainData({ fx: o.fx }).fx, nfx: [], mods: [] };
      app.toast((await addPreset({ kind: 'chain', name, data })) ? `Chain "${name}" saved.` : 'The preset could not be saved (storage?).');
    }, 'go'],
    ['☁ PUBLISH THIS CHAIN TO THE HUB…', () => {
      const data = o.t ? chainData(app.store.track(o.t.id)) : { fx: chainData({ fx: o.fx }).fx, nfx: [], mods: [] };
      app.hub?.publish({ preset: { kind: 'chain', name: o.name, data } });
    }],
  ]);
}

// ------------------------------------------------------------- a track ---
export async function saveTrackPreset(app, id) {
  const t = app.store.track(id);
  if (!t) return;
  const name = await askName(app, 'Save the track as a preset', t.name, 'Its instrument and sound (samples too), effects, modulators, level and pan: not its clips. Load it on a track of the same kind, or start a new track with it.');
  if (!name) return;
  const q = await addPreset({ kind: 'track', type: t.kind, name, data: trackData(t, app.store.p) });
  app.toast(q ? `"${name}" saved: + TRACK > From a preset, or the track's menu.` : 'The preset could not be saved (storage?).');
  app.library?.render(true);
}
export async function loadTrackPresetSheet(app, id) {
  const t = app.store.track(id);
  const mine = (await listPresets()).filter((x) => x.kind === 'track' && x.type === t.kind);
  if (!mine.length) { app.toast(`No ${t.kind} track preset yet: the track's menu > SAVE AS A PRESET.`); return; }
  app.sheet(`Load a preset on ${t.name}`, mine.map((q) => [q.name.toUpperCase(), async () => {
    await app.ensureAssets(Object.keys(q.data.assets || {}));
    app.store.change((p) => { applyTrack(p.tracks.find((x) => x.id === id), q.data, p); });
    app.toast(`${t.name} now plays ${q.name}.`);
  }]));
}
// a new track from a preset
export async function newTrackFromPreset(app, q) {
  if (!q) {
    const mine = (await listPresets()).filter((x) => x.kind === 'track');
    if (!mine.length) { app.toast('No track preset yet: right-click a track (hold on a phone) > SAVE AS A PRESET.'); return; }
    app.sheet('A new track from a preset', mine.map((x) => [`${x.name.toUpperCase()} · ${x.type.toUpperCase()}`, () => newTrackFromPreset(app, x)]));
    return;
  }
  await app.ensureAssets(Object.keys(q.data.assets || {}));
  const id = app.addTrack(q.data.kind, { name: q.name.toUpperCase().slice(0, 16), color: q.data.color, kit: q.data.kit }).id;
  app.store.change((p) => { applyTrack(p.tracks.find((x) => x.id === id), q.data, p); }, 'preset-new');
  app.toast(`${q.name}: a new track.`);
}
// a track preset's sound on the selected track (the library): same kind, else a new track
export async function useSoundPreset(app, q) {
  const t = app.store.track(app.view.selTrack);
  if (t?.kind !== q.data.kind) return newTrackFromPreset(app, q);
  await app.ensureAssets(Object.keys(q.data.assets || {}));
  app.store.change((p) => { applyTrack(p.tracks.find((x) => x.id === t.id), q.data, p, { soundOnly: true }); });
  app.audition(t.id, t.kind === 'drum' ? [36, 38, 42] : [60, 64, 67]);
}

// ------------------------------------------------------------- templates ---
export async function saveTemplate(app) {
  const p = app.store.p;
  const name = await askName(app, 'Save as a template', p.name, 'The whole project as a starting point: tracks, sounds, effects, routing, tempo, and its clips (clear them first for an empty template). It shows in "Start a song in a style".');
  if (!name) return;
  const q = await addPreset({ kind: 'template', name, data: { json: JSON.stringify({ ...p, name }) } });
  app.toast(q ? `Template "${name}" saved.` : 'The template could not be saved (storage?).');
}
export async function openTemplate(app, q) {
  const p = validate(JSON.parse(q.data.json));
  p.name = q.name;
  await app.ensureAssets(Object.keys(p.assets || {}));
  app.load(p);
  app.toast(`A new song from your template ${q.name}. What you had is one Ctrl+Z away.`);
}

// ------------------------------------------------------------- manage ---
export async function managePresets(app) {
  const list = await listPresets();
  const rows = [];
  for (const kind of ['fx', 'chain', 'track', 'template', 'lab']) {
    const qs = list.filter((x) => x.kind === kind).sort((a, b) => (a.type || '').localeCompare(b.type || '') || a.name.localeCompare(b.name));
    if (!qs.length) continue;
    rows.push(h('div', { class: 'eng-h open' }, h('span', { text: KIND_LABEL[kind] }), h('span', { text: String(qs.length) })));
    for (const q of qs) rows.push(h('div', { class: 'preset-row' },
      h('span', { text: q.name }), h('span', { class: 'tag', text: kind === 'fx' ? DEVICES[q.type]?.name || q.type : kind === 'track' ? q.type.toUpperCase() : '' }),
      h('button', { class: 'tb', title: 'Rename', onclick: async () => { const n = await askName(app, 'Rename the preset', q.name); if (!n) return; const all = await listPresets(); const x = all.find((y) => y.id === q.id); if (x) { x.name = n.slice(0, 40); await writePresets(all); } m.close(); managePresets(app); } }, '✎'),
      h('button', { class: 'tb', title: 'Publish to the hub', onclick: () => { m.close(); app.hub?.publish({ preset: q }); } }, '☁'),
      h('button', { class: 'tb', title: 'Delete', onclick: async () => { await removePreset(q.id); m.close(); managePresets(app); app.library?.render(true); } }, '×')));
  }
  const m = app.modal('My presets', [
    h('p', { class: 'hint', text: list.length ? 'Kept in this browser, for every project. Export them to keep a copy or to share them (samples included).' : 'Nothing yet. Save presets from an effect\'s ☰, the effect chain\'s PRESETS, a track\'s menu, or PROJECT > Save as a template.' }),
    h('div', { class: 'preset-list' }, rows),
  ], [['Import…', () => importPresets(app)], ...(list.length ? [['Export all…', () => exportPresets(app)]] : []), ['Done', null, true]]);
  m.box.classList.add('preset-dlg');
}
// one file with every preset, and the samples their tracks and templates play
export async function exportPresets(app) {
  const list = await listPresets();
  const ids = new Set();
  for (const q of list) {
    if (q.kind === 'track') for (const id of Object.keys(q.data.assets || {})) ids.add(id);
    if (q.kind === 'template') { try { for (const id of Object.keys(JSON.parse(q.data.json).assets || {})) ids.add(id); } catch { /* */ } }
  }
  await app.ensureAssets([...ids]);
  const files = [{ name: 'presets.json', data: JSON.stringify({ format: 'kraken-presets', version: PRESET_FORMAT, presets: list }) }];
  for (const id of ids) { const a = app.assets.get(id); if (a) files.push({ name: `assets/${id}.wav`, data: encodeWav([a.L, a.R], 44100, 24) }); }
  const name = await saveFile('kraken-presets.zip', zip(files));
  app.toast(`${list.length} preset${list.length === 1 ? '' : 's'} in ${name}.`);
}
export function importPresets(app) {
  const inp = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', hidden: true });
  inp.onchange = async () => {
    const f = inp.files[0]; inp.remove();
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let json, entries = [];
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) { entries = await unzip(bytes); const pj = entries.find((x) => x.name.endsWith('presets.json')); if (!pj) throw new Error('This file holds no Kraken presets.'); json = JSON.parse(new TextDecoder().decode(pj.data)); }
      else json = JSON.parse(new TextDecoder().decode(bytes));
      if (json?.format !== 'kraken-presets' || !Array.isArray(json.presets)) throw new Error('This file holds no Kraken presets.');
      if (json.version > PRESET_FORMAT) throw new Error('These presets come from a newer Kraken: update Kraken to open them.');
      const audio = entries.filter((en) => /assets\/[^/]+\.wav$/.test(en.name));
      await app.addAssetFiles(audio.map((en) => ({ id: en.name.match(/assets\/([^/]+)\.wav$/)[1], data: en.data })));
      const all = await listPresets();
      let n = 0;
      for (const q of json.presets) {
        if (!q || typeof q.name !== 'string') continue;
        const same = all.findIndex((x) => x.kind === q.kind && x.type === q.type && x.name === q.name);
        const item = { ...q, id: same >= 0 ? all[same].id : uid('pr') };
        if (same >= 0) all[same] = item; else all.push(item);
        n++;
      }
      await writePresets(all);
      app.toast(`${n} preset${n === 1 ? '' : 's'} imported.`);
      app.library?.render(true);
    } catch (err) { app.toast(err.message); }
  };
  document.body.append(inp); inp.click();
}
