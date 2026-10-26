// SPDX-License-Identifier: GPL-3.0-only
// The note effects of a track in the instrument tab: a chain of modules before the instrument.
import { h, knob } from './kit.js';
import { NOTE_FX, NOTE_FX_ORDER, noteFxDefaults, fmtNoteParam } from '../notefx.js';
import { uid } from '../project.js';

export const NOTE_KINDS = ['synth', 'drum', 'sampler', 'external', 'lab'];

export function noteFxModules(dev, t) {
  if (!NOTE_KINDS.includes(t.kind)) return [];
  const app = dev.app, list = t.nfx || [];
  const edit = (fn, tag) => app.store.change((p) => { const tr = p.tracks.find((x) => x.id === t.id); tr.nfx ||= []; fn(tr.nfx); }, tag);
  dev.nfxKnobs = new Map();
  const mods = list.map((d, i) => {
    const spec = NOTE_FX[d.type];
    const knobs = spec.params.map((p) => {
      const step = p.names || Number.isInteger(p.min + p.max + p.def) && p.unit !== '%' && p.k !== 'cu' ? 1 : p.k === 'cu' ? 0.05 : 0.01;
      const k = knob({ label: p.l, min: p.min, max: p.max, step, value: d.p[p.k] ?? p.def, def: p.def, color: t.color,
        format: (v) => fmtNoteParam(p, v),
        onChange: (v) => edit((nfx) => { const x = nfx.find((y) => y.id === d.id); if (x) x.p[p.k] = v; }, `nfx${d.id}${p.k}`),
        onEnd: () => app.store.endGesture() });
      k.dataset.learn = `nfx:${t.id}:${d.id}:${p.k}`;
      dev.nfxKnobs.set(`${d.id}:${p.k}`, k);
      return k;
    });
    const move = (dir) => edit((nfx) => { const j = nfx.findIndex((y) => y.id === d.id), k2 = j + dir; if (k2 >= 0 && k2 < nfx.length) [nfx[j], nfx[k2]] = [nfx[k2], nfx[j]]; });
    return h('div', { class: 'module fx nfx' + (d.on === false ? ' off' : '') },
      h('h4', {}, h('span', { text: spec.name }), h('span', { class: 'fx-ctl' },
        h('button', { class: 'tb' + (d.on !== false ? ' fxon' : ''), title: 'On / off', onclick: () => edit((nfx) => { const x = nfx.find((y) => y.id === d.id); x.on = x.on === false; }) }, '⏻'),
        h('button', { class: 'tb', title: 'Move left', onclick: () => move(-1), disabled: i === 0 ? true : null }, '◀'),
        h('button', { class: 'tb', title: 'Move right', onclick: () => move(1), disabled: i === list.length - 1 ? true : null }, '▶'),
        h('button', { class: 'tb', title: 'Remove', onclick: () => app.store.change((p) => {
          const tr = p.tracks.find((x) => x.id === t.id);
          tr.nfx = (tr.nfx || []).filter((y) => y.id !== d.id);
          for (const m of tr.mods || []) m.to = (m.to || []).filter((tg) => !tg.key.startsWith(`nfx:${d.id}:`));
        }) }, '×'))),
      h('div', { class: 'knobs', '--cols': spec.params.length > 4 ? 3 : 2 }, knobs));
  });
  const add = h('div', { class: 'module fx-add nfx-add' }, h('h4', {}, 'NOTE FX', h('em', { text: list.length ? `${list.length} · BEFORE THE SOUND` : 'BEFORE THE SOUND' })),
    h('div', { class: 'fx-list' }, NOTE_FX_ORDER.map((type) => h('button', { class: 'add', title: `Add ${NOTE_FX[type].name.toLowerCase()} to the notes of ${t.name}`,
      onclick: () => edit((nfx) => { nfx.push({ id: uid('n'), type, on: true, p: noteFxDefaults(type) }); }) }, NOTE_FX[type].name))));
  return [...mods, add];
}
export function refreshNoteKnobs(dev, t) {
  for (const d of t.nfx || []) for (const p of NOTE_FX[d.type].params) dev.nfxKnobs?.get(`${d.id}:${p.k}`)?.setValue(d.p[p.k] ?? p.def);
}
