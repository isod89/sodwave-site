// SPDX-License-Identifier: GPL-3.0-only
// Community engines in Kraken: the engines of other firmwares, shipped with Kraken (packs.js). Their sounds are in the
// library from the start (◆ NAME); an engine is fetched the first time a track or a LAB patch plays it, then the audio
// engine starts again with it. PROJECT > Community engines… says what each is, who made it, its licence and its source.
import { h } from './kit.js';
import { fetchPack, packsOf, isPackBank } from '../packs.js';

const loading = new Map();                                       // bank -> its fetch
let again = 0;
// the audio engine again with every bank loaded (once for several packs arriving together)
function restart(app) {
  clearTimeout(again);
  again = setTimeout(() => {
    app.store.emit('change');                                     // (every panel redraws: a track of that pack included)
    if (app.audio?.node) { app.audio.restart(); app.audio.onRestart?.(); }
  }, 30);
}
// a pack's engine, fetched once (null when it cannot be: its tracks stay silent and the panel says why)
export function loadPack(app, bank) {
  if (!isPackBank(bank) || app.modules[bank]) return Promise.resolve(app.modules[bank] || null);
  const cat = app.lib[bank];
  if (!cat?.file || cat.missing) return Promise.resolve(null);
  if (!loading.has(bank)) {
    loading.set(bank, fetchPack(cat).then(({ module, bytes }) => {
      app.modules[bank] = module;
      app.modules.bytes[bank] = bytes;
      restart(app);
      return module;
    }, (e) => {
      cat.error = e.message;
      app.toast(`${cat.pack.name} could not be loaded (${e.message}).`);
      app.store.emit('change');
      return null;
    }));
  }
  return loading.get(bank);
}
// every pack the project plays, loaded (on a change of the project: a sound picked, a song opened, an undo…)
export function needPacks(app) { return Promise.all(packsOf(app.store.p).map((b) => loadPack(app, b))); }
export const packLoading = (app, bank) => isPackBank(bank) && !app.modules[bank] && !app.lib[bank]?.error && loading.has(bank);

const sizeOf = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
function facts(m) {
  return h('div', { class: 'pack-facts' },
    [[m.author && 'By', m.author], ['Version', m.version], ['Licence', m.license]].filter(([k, v]) => k && v)
      .map(([k, v]) => h('span', {}, h('b', { text: k }), ' ', h('span', { translate: 'no', text: v }))),
    m.source ? h('a', { href: m.source, target: '_blank', rel: 'noopener', translate: 'no', text: m.source.replace(/^https:\/\//, '') }) : null);
}
// PROJECT > Community engines…: what each is, who made it, where its source is
export function packsDialog(app) {
  const banks = Object.keys(app.lib).filter((b) => isPackBank(b) && app.lib[b]?.pack && !app.lib[b].missing);
  const rows = banks.map((b) => {
    const cat = app.lib[b], m = cat.pack, used = app.store.p.tracks.filter((t) => t.bank === b).length;
    const sounds = cat.engines.reduce((a, e) => a + e.presets.length, 0);
    return h('div', { class: 'pack-row', 'data-id': m.id },
      h('div', {}, h('b', { translate: 'no', text: `◆ ${m.name}` }),
        h('small', { text: `${cat.engines.length} ${cat.engines.length === 1 ? 'engine' : 'engines'} · ${sounds} sounds${cat.bytes ? ` · ${sizeOf(cat.bytes)}` : ''}${used ? ` · ${used} ${used === 1 ? 'track' : 'tracks'} here` : ''}` }),
        m.description ? h('p', { class: 'hint', text: m.description }) : null,
        facts(m)),
      h('button', { class: 'add go', onclick: (e) => {
        e.target.closest('.modal-bg')?.remove();
        const t = app.addTrack('synth', { bank: b, engine: 0, preset: 0, name: m.name.toUpperCase().slice(0, 16), sends: [0.1, 0] });
        app.selectTrack?.(t.id);
        loadPack(app, b).then((ok) => { if (ok) setTimeout(() => app.audition?.(t.id, [60, 64, 67]), 200); });
      } }, 'New track'));
  });
  app.modal('Community engines', [
    h('p', { class: 'hint', text: 'The engines of other FM-1 and SMK-37 firmwares, built by Sodwave from their source and played here as on the device. Each is an instrument of its own (its sounds in the library) and a firmware of the LAB\'s ENGINE module. Thanks to their authors.' }),
    rows.length ? h('div', { class: 'pack-list' }, rows) : h('p', { class: 'hint', text: 'None in this version yet.' }),
  ], [['Close']]);
}
// a track of a pack this version of Kraken does not have, or could not load
export function missingNotice(app, t) {
  const k = t.pack || {}, err = app.lib[t.bank]?.error;
  return h('div', { class: 'module pack-missing' },
    h('h4', {}, 'COMMUNITY ENGINE', h('em', { text: err ? 'NOT LOADED' : 'NOT AVAILABLE' })),
    h('p', { text: err ? `This track plays ${k.name || t.bank.slice(2)}, which could not be loaded (${err}): it stays silent. Reload the page to try again.`
      : `This track plays ${k.name || t.bank.slice(2)}, an engine this version of Kraken does not have: it stays silent.` }),
    k.source ? h('a', { class: 'add', href: k.source, target: '_blank', rel: 'noopener', translate: 'no', text: `Its source: ${k.source.replace(/^https:\/\//, '')}` }) : null);
}
