// SPDX-License-Identifier: GPL-3.0-only
// Plugins (Web Audio Modules 2.0) in the INSTRUMENT tab: the dialog that loads one from its address, a plugin effect
// in the rack and a plugin instrument, each with the plugin's own panel (bigger in a window) and its parameters.
import { h } from './kit.js';
import { uid } from '../project.js';
import { KNOWN, cleanUrl, nameFromUrl } from '../wam.js';
import { trust, trusted, pluginOrigin } from '../wam-host.js';

// the address of a plugin: pasted, or one of the known free ones. instrument: a new plugin track (or, with trackId,
// that track's plugin replaced); else an effect at the end of trackId's rack
export function wamDialog(app, { instrument = false, trackId = null } = {}) {
  const inp = h('input', { type: 'url', placeholder: 'https://…/index.js', style: { width: '100%' }, 'aria-label': 'Plugin address', spellcheck: 'false', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); } });
  const list = KNOWN.filter((k) => (k.kind === 'inst') === instrument);
  const pick = h('div', { class: 'wam-known' }, list.map((k) => h('button', { class: 'add', title: `${k.about}\n${k.url}`, onclick: () => { inp.value = k.url; inp.focus(); } }, k.name)));
  const go = () => {
    const url = cleanUrl(inp.value);
    if (!url) { app.toast(inp.value.trim() ? 'That is not a plugin address (http or https, ending in its .js file).' : 'Paste a plugin address first.'); return false; }
    m.close();
    trust(url);                                                  // (you chose it: its site may run here)
    const name = (KNOWN.find((k) => k.url === url)?.name || nameFromUrl(url)).toUpperCase().slice(0, 40);
    const plugin = { url, name, state: null };
    if (instrument && trackId) app.store.change((p) => { const t = p.tracks.find((x) => x.id === trackId); if (t) t.wam = plugin; });
    else if (instrument) app.addTrack('wam', { name: name.slice(0, 16), wam: plugin, sends: [0.1, 0] });
    else app.store.change((p) => { p.tracks.find((x) => x.id === trackId)?.fx.push({ id: uid('f'), type: 'wam', on: true, p: {}, ...plugin }); });
    app.toast(`Loading ${name}…`);
    return true;
  };
  const m = app.modal(instrument ? 'Plugin instrument (WAM)' : 'Plugin effect (WAM)', [
    h('p', { class: 'hint', text: 'A Web Audio Module: the open plugin standard of the web. Paste the address of its module (its index.js), or pick a free one.' }),
    inp,
    h('p', { class: 'wam-warn', text: 'Plugins run code from their website: load the ones you trust.' }),
    list.length ? h('p', { class: 'hint', text: 'FREE PLUGINS (WAM COMMUNITY)' }) : null, pick], [['Cancel'], ['Load', () => {}, true]]);
  // (Load checks the address first: the dialog stays open on a bad one)
  const load = m.box.querySelector('.row .add.go');
  const fresh = load.cloneNode(true); load.replaceWith(fresh);
  fresh.addEventListener('click', go);
  setTimeout(() => inp.focus(), 30);
  return m;
}

// a plugin's panel: its state, its own GUI (scrolled in the panel; bigger in a window), its parameters
function pluginPanel(app, key, color) {
  const e = app.wam?.entry(key);
  const status = !e ? 'NOT LOADED' : e.status === 'ok' ? 'READY' : e.status === 'loading' ? 'LOADING…' : 'FAILED';
  const box = h('div', { class: 'wam-gui', '--c': color });
  const kids = [];
  const url = e?.url || e?.wam?.url;
  if (e?.status === 'failed' && url && !trusted(url)) kids.push(h('p', { class: 'ctl-note wam-err', text: `This plugin came with the song (a file, a preset or someone you play with). It runs code from ${pluginOrigin(url)}: allow it only if you trust that site. Until then the track plays without it.` }),
    h('button', { class: 'add go', onclick: () => { trust(url); app.wam.retry(key); app.device.refresh(true); } }, `ALLOW ${pluginOrigin(url).replace(/^https?:\/\//, '').toUpperCase()}`));
  else if (e?.status === 'failed') kids.push(h('p', { class: 'ctl-note wam-err', text: `Not loaded: ${e.error}. The track plays without it (an effect lets the sound through). Check the address or the network.` }));
  else if (e?.status !== 'ok') kids.push(h('p', { class: 'ctl-note', text: 'Loading the plugin…' }));
  else {
    box.textContent = '';
    app.wam.gui(key).then((g) => {
      if (g) box.replaceChildren(g); else box.replaceChildren(h('p', { class: 'ctl-note', text: 'This plugin has no panel of its own: its parameters are below.' }));
    }).catch((err) => box.replaceChildren(h('p', { class: 'ctl-note wam-err', text: `Its panel did not open: ${err.message}` })));
    // a change in its panel: its settings kept with the project (an undo step)
    let t = 0;
    const later = () => { clearTimeout(t); t = setTimeout(() => app.wam.capture(key), 350); };
    for (const ev of ['pointerup', 'change', 'keyup', 'wheel']) box.addEventListener(ev, later, { passive: true });
    kids.push(box);
  }
  const params = h('div', { class: 'wam-params', hidden: true });
  const row = h('div', { class: 'row' },
    e?.status === 'ok' ? h('button', { class: 'add', title: 'The plugin\'s panel in a large window', onclick: () => bigger(app, key, box) }, 'OPEN BIGGER') : null,
    e?.status === 'ok' ? h('button', { class: 'add', title: 'Its parameters, as the plugin lists them', onclick: async () => {
      params.hidden = !params.hidden;
      if (!params.hidden) params.replaceChildren(...paramRows(app, key, await app.wam.params(key).catch(() => [])));
    } }, 'PARAMETERS') : null,
    e?.status === 'failed' ? h('button', { class: 'add', onclick: () => { app.wam.retry(key); app.device.refresh(true); } }, 'TRY AGAIN') : null);
  return [h('div', { class: 'screen wam-screen' }, h('span', { class: 'eng', text: status }), h('span', { class: 'pre', text: e?.wam?.name || e?.name || '' })), ...kids, row, params];
}
function paramRows(app, key, list) {
  if (!list.length) return [h('p', { class: 'ctl-note', text: 'This plugin lists no parameters.' })];
  return list.slice(0, 64).map((q) => {
    const out = h('span', { class: 'wam-pv', text: fmtV(q, q.value) });
    const inp = h('input', { type: 'range', min: q.min, max: q.max, step: q.step || (q.type === 'int' || q.type === 'boolean' || q.type === 'choice' ? 1 : (q.max - q.min) / 1000 || 0.001), value: q.value, 'aria-label': q.label,
      oninput: (e) => { out.textContent = fmtV(q, +e.target.value); app.wam.setParam(key, q.id, +e.target.value); }, onkeydown: (e) => e.stopPropagation() });
    return h('label', { class: 'wam-param', title: q.id }, h('span', { text: q.label }), inp, out);
  });
}
const fmtV = (q, v) => (q.choices?.length ? String(q.choices[Math.round(v)] ?? v) : `${Math.abs(v) >= 100 ? Math.round(v) : +(+v).toFixed(2)}${q.units ? ' ' + q.units : ''}`);
// the plugin's panel in a large window; back in the rack when it closes
function bigger(app, key, box) {
  const g = box.firstElementChild;
  if (!g) return;
  const big = h('div', { class: 'wam-gui wam-big' }, g);
  const m = app.modal(app.wam.entry(key)?.wam?.name || 'Plugin', [big], [['Close', null, true]]);
  m.box.classList.add('wam-modal');
  new MutationObserver((_x, o) => { if (!m.box.isConnected) { o.disconnect(); app.wam.capture(key); if (box.isConnected) box.replaceChildren(g); else app.device.refresh(true); } }).observe(document.body, { childList: true });
}

// a plugin effect in the rack: on / off, move, remove, like every effect
export function wamFxModule(dev, o, d, i) {
  const app = dev.app, key = `f:${d.id}`;
  const move = (dir) => o.edit((fx) => { const j = fx.findIndex((y) => y.id === d.id), k2 = j + dir; if (k2 >= 0 && k2 < fx.length) [fx[j], fx[k2]] = [fx[k2], fx[j]]; });
  return h('div', { class: 'module fx wam' + (d.on === false ? ' off' : ''), '--c': o.t?.color || 'var(--accent)' },
    h('h4', {}, h('span', { text: `PLUGIN · ${d.name || 'WAM'}`.slice(0, 40), title: d.url }), h('span', { class: 'fx-ctl' },
      h('button', { class: 'tb' + (d.on !== false ? ' fxon' : ''), title: 'On / off', 'data-learn': `fxon:${o.id}:${d.id}`, onclick: () => o.edit((fx) => { const x = fx.find((y) => y.id === d.id); x.on = x.on === false; }) }, '⏻'),
      h('button', { class: 'tb', title: 'Move left', onclick: () => move(-1), disabled: i === 0 ? true : null }, '◀'),
      h('button', { class: 'tb', title: 'Move right', onclick: () => move(1), disabled: i === o.fx.length - 1 ? true : null }, '▶'),
      h('button', { class: 'tb', title: 'Remove', onclick: () => app.store.change((pp) => {
        const tr = pp.tracks.find((x) => x.id === o.t.id);
        tr.fx = tr.fx.filter((y) => y.id !== d.id);
        for (const m of tr.mods || []) m.to = (m.to || []).filter((tg) => !tg.key.startsWith(`fx:${d.id}:`));
      }) }, '×'))),
    ...pluginPanel(app, key, o.t?.color || 'var(--accent)'));
}

// a plugin instrument track: its plugin, its panel; notes and controllers go to it, its sound comes back in the track
export function buildWamInstrument(dev, t) {
  const app = dev.app;
  const head = h('div', { class: 'module sound-lcd' }, h('h4', {}, 'PLUGIN', h('em', { text: 'WAM INSTRUMENT' })),
    h('div', { class: 'screen' }, h('span', { class: 'eng', text: t.wam ? 'WEB AUDIO MODULE' : 'NO PLUGIN' }), h('span', { class: 'pre', text: t.wam?.name || 'CHOOSE ONE' })),
    h('div', { class: 'row' }, h('button', { class: 'add', title: 'Another plugin on this track', onclick: () => wamDialog(app, { instrument: true, trackId: t.id }) }, t.wam ? 'REPLACE…' : 'CHOOSE A PLUGIN…')),
    t.wam ? h('p', { class: 'ctl-note wam-url', text: t.wam.url }) : null,
    h('p', { class: 'ctl-note', text: 'Its notes and controllers come from this track\'s clips and your keys. Its sound comes back through the track (2.9 ms later; the other tracks wait as long).' }));
  const mods = [head];
  if (t.wam) mods.push(h('div', { class: 'module wam inst', '--c': t.color }, h('h4', {}, h('span', { text: t.wam.name }), h('em', { text: 'ITS PANEL' })), ...pluginPanel(app, `i:${t.id}`, t.color)));
  dev.wrap.replaceChildren(...mods);
}
