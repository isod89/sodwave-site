// SPDX-License-Identifier: GPL-3.0-only
// The modulators of a track in the instrument tab: each one with its knobs, a live meter and its targets.
// A target is any parameter of the track: pick it in the list, or press MAP and click a knob.
import { h, knob } from './kit.js';
import { MODS, MOD_ORDER, modDefaults, fmtModParam } from '../mods.js';
import { uid } from '../project.js';
import { autoTargets } from './arrange.js';

// a learn id (the data-learn of a knob, a fader, a send) as a modulation key of track t, or null
export function learnToKey(id, t, app) {
  const parts = id.split(':');
  if (parts[0] === 'sel' && parts[1] === 'p') return app.view.selTrack === t.id ? `p${parts[2]}` : null;
  if (parts[0] === 'fx' && parts[1] === t.id) return `fx:${parts[2]}:${parts[3]}`;
  if (parts[0] === 'nfx' && parts[1] === t.id) return `nfx:${parts[2]}:${parts[3]}`;
  if (parts[0] === 't' && parts[1] === t.id && /^(vol|pan|send\d+|p:\d+)$/.test(parts.slice(2).join(':'))) return parts[2] === 'p' ? `p${parts[3]}` : parts[2];
  if (parts[0] === 'sel' && app.view.selTrack === t.id && /^(vol|pan|send\d+)$/.test(parts[1])) return parts[1];
  return null;
}

export function modModules(dev, t) {
  const app = dev.app, list = t.mods || [];
  const edit = (fn, tag) => app.store.change((p) => { const tr = p.tracks.find((x) => x.id === t.id); tr.mods ||= []; fn(tr.mods); }, tag);
  const targets = autoTargets(app, t);
  const tlabel = (key) => targets.find((x) => x.key === key)?.label || key;
  dev.modKnobs = new Map(); dev.modMeters = new Map();
  const mods = list.map((m) => {
    const spec = MODS[m.type];
    const sync = m.type === 'lfo' ? Math.round(m.p.sy ?? 1) : 1;
    const knobs = spec.params.filter((p) => !(m.type === 'lfo' && ((p.k === 'hz' && sync) || (p.k === 'ra' && !sync)))).map((p) => {
      const step = p.names ? 1 : p.unit === '%' ? 0.01 : p.unit === 'Hz' ? 0.01 : 1;
      const k = knob({ label: p.l, min: p.min, max: p.max, step, value: m.p[p.k] ?? p.def, def: p.def, color: t.color, format: (v) => fmtModParam(p, v),
        onChange: (v) => edit((ms) => { const x = ms.find((y) => y.id === m.id); if (x) x.p[p.k] = v; }, `mod${m.id}${p.k}`),
        onEnd: () => { app.store.endGesture(); if (p.k === 'sy') dev.refresh(true); } });
      dev.modKnobs.set(`${m.id}:${p.k}`, k);
      return k;
    });
    const meter = h('div', { class: 'mod-meter', title: 'The modulator now' }, h('i'));
    dev.modMeters.set(m.id, meter);
    const rows = (m.to || []).map((tg) => h('div', { class: 'mod-tgt' },
      h('span', { class: 'mod-tname', text: tlabel(tg.key), title: tlabel(tg.key) }),
      h('input', { type: 'range', min: -100, max: 100, step: 1, value: Math.round(tg.amt * 100), 'aria-label': `Amount to ${tlabel(tg.key)}`, title: 'Amount: drag; double-click for 0',
        oninput: (e) => { e.target.nextSibling.textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}%`; edit((ms) => { const x = ms.find((y) => y.id === m.id)?.to.find((y) => y.key === tg.key); if (x) x.amt = +e.target.value / 100; }, `modamt${m.id}${tg.key}`); },
        ondblclick: (e) => { e.target.value = 0; e.target.dispatchEvent(new Event('input')); },
        onchange: () => app.store.endGesture(), onkeydown: (e) => e.stopPropagation() }),
      h('span', { class: 'mod-amt', text: `${tg.amt > 0 ? '+' : ''}${Math.round(tg.amt * 100)}%` }),
      h('button', { class: 'tb', title: 'Remove this target', onclick: () => edit((ms) => { const x = ms.find((y) => y.id === m.id); x.to = x.to.filter((y) => y.key !== tg.key); }) }, '×')));
    const free = targets.filter((x) => x.key !== 'tempo' && !(m.to || []).some((y) => y.key === x.key));
    const addTo = (key, amt = 0.5) => { const tg = targets.find((x) => x.key === key); if (!tg) return; edit((ms) => { const x = ms.find((y) => y.id === m.id); x.to ||= []; if (!x.to.some((y) => y.key === key)) x.to.push({ key, amt, lo: tg.min, hi: tg.max }); }); };
    const pick = h('select', { 'aria-label': 'Add a target', onchange: (e) => { if (e.target.value) addTo(e.target.value); } },
      h('option', { value: '' }, '+ TARGET…'), free.map((x) => h('option', { value: x.key }, x.label)));
    const map = h('button', { class: 'add' + (app.modMap?.mod === m.id ? ' on' : ''), title: 'Then click any knob, fader or send of this track', onclick: () => startMap(app, t, m.id, addTo) }, app.modMap?.mod === m.id ? 'CLICK A KNOB…' : 'MAP');
    const src = m.type === 'follow' ? h('label', { class: 'mod-src' }, 'LISTENS TO',
      h('select', { 'aria-label': 'Follower source', onchange: (e) => edit((ms) => { ms.find((y) => y.id === m.id).src = e.target.value; }) },
        app.store.p.tracks.filter((x) => x.kind !== 'group').map((x) => h('option', { value: x.id, selected: (m.src || t.id) === x.id ? true : null }, x.id === t.id ? `${x.name} (ITSELF)` : x.name)))) : null;
    return h('div', { class: 'module fx modm' + (m.on === false ? ' off' : '') },
      h('h4', {}, h('span', { text: `MOD · ${spec.name}` }), h('span', { class: 'fx-ctl' },
        h('button', { class: 'tb' + (m.on !== false ? ' fxon' : ''), title: 'On / off', onclick: () => edit((ms) => { const x = ms.find((y) => y.id === m.id); x.on = x.on === false; }) }, '⏻'),
        h('button', { class: 'tb', title: 'Remove', onclick: () => edit((ms) => { ms.splice(ms.findIndex((y) => y.id === m.id), 1); }) }, '×'))),
      meter,
      h('div', { class: 'knobs', '--cols': Math.min(3, knobs.length) }, knobs), src,
      h('div', { class: 'mod-tgts' }, rows.length ? rows : h('p', { class: 'ctl-note', text: 'No target yet: pick one, or press MAP and click a knob.' })),
      h('div', { class: 'row mod-add' }, pick, map));
  });
  const add = h('div', { class: 'module fx-add mod-add-mod' }, h('h4', {}, 'MODULATORS', h('em', { text: list.length ? String(list.length) : 'ANY KNOB' })),
    h('p', { class: 'ctl-note', text: 'Sources that move this track\'s knobs by themselves.' }),
    h('div', { class: 'fx-list' }, MOD_ORDER.map((type) => h('button', { class: 'add', onclick: () => edit((ms) => { ms.push({ id: uid('m'), type, on: true, p: modDefaults(type), to: [], ...(type === 'follow' ? { src: t.id } : {}) }); }) }, MODS[type].name))));
  return [...mods, add];
}
export function refreshModKnobs(dev, t) {
  for (const m of t.mods || []) for (const p of MODS[m.type].params) dev.modKnobs?.get(`${m.id}:${p.k}`)?.setValue(m.p[p.k] ?? p.def);
}
// the live values, from the engine's ticks
export function modMeters(dev, values, t) {
  if (!values || !dev.modMeters) return;
  (t.mods || []).forEach((m, i) => {
    const el = dev.modMeters.get(m.id), v = values[i];
    if (!el || v == null) return;
    const bi = m.type === 'lfo' || (m.type === 'random' && Math.round(m.p.bi ?? 1));
    el.firstChild.style.left = bi ? `${Math.min(50, 50 + v * 50)}%` : '0';
    el.firstChild.style.width = bi ? `${Math.abs(v) * 50}%` : `${v * 100}%`;
  });
}
// MAP: the next click on a knob (anything with data-learn) of this track becomes a target
function startMap(app, t, modId, addTo) {
  if (app.modMap) { app.modMap.cancel(); return; }
  const banner = document.getElementById('learn-banner');
  const done = () => { document.removeEventListener('pointerdown', grab, true); document.removeEventListener('keydown', esc, true); app.modMap = null; banner.hidden = true; document.body.classList.remove('mapping'); app.device.refresh(true); };
  const grab = (e) => {
    if (e.target.closest('#learn-banner')) { done(); return; }                        // a tap on the banner stops
    if (e.target.closest('.tab, #mnav button, .mixer, .device')) {                    // tabs and panels: go and find the knob there
      const el0 = e.target.closest('[data-learn]');
      if (!el0) return;
    }
    const el = e.target.closest('[data-learn]');
    if (!el) { if (!e.target.closest('.modm')) done(); return; }
    const key = learnToKey(el.dataset.learn, t, app);
    e.preventDefault(); e.stopPropagation();
    if (!key) { app.toast('That one is not a knob of this track.'); return; }
    done(); addTo(key);
  };
  const esc = (e) => { if (e.key === 'Escape') done(); };
  app.modMap = { mod: modId, cancel: done };
  document.addEventListener('pointerdown', grab, true);
  document.addEventListener('keydown', esc, true);
  banner.textContent = matchMedia('(pointer: coarse)').matches ? 'MAP: tap a knob of this track (the MIXER tab has its fader and sends) · tap here to stop'
    : 'MAP: click a knob of this track (the MIXER tab has its fader and sends) · Esc or a click here to stop';
  banner.hidden = false;
  document.body.classList.add('mapping');
  app.device.refresh(true);
}
