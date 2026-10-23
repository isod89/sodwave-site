// SPDX-License-Identifier: GPL-3.0-only
// The command palette (Ctrl+K): every action, track, sound, kit and effect, found by typing.
import { h } from './kit.js';
import { ACTIONS } from '../control.js';
import { DEVICES, DEVICE_ORDER, defaults } from '../fx.js';
import { uid } from '../project.js';

export class Palette {
  constructor(app) { this.app = app; }
  items() {
    const app = this.app, p = app.store.p, t = app.store.track(app.view.selTrack), $ = (id) => document.getElementById(id);
    const out = [];
    const add = (group, label, run, hint = '') => out.push({ group, label, run, hint, key: `${group} ${label} ${hint}`.toLowerCase() });
    for (const [a, l] of ACTIONS) add('ACTION', l, () => app.control.run(a));
    for (const [act, l] of [['new', 'New project'], ['demo', 'Open the demo song'], ['open', 'Open a project…'], ['save', 'Save project'], ['wav', 'Export mix (WAV)'],
      ['stems', 'Export stems (WAV)'], ['midi', 'Export MIDI'], ['importmidi', 'Import a MIDI file…'], ['install', 'Install the app (offline)'], ['help', 'Keys & mouse']]) add('PROJECT', l, () => app.fileAction(act));
    for (const [id, l] of [['add-synth', 'Synth track'], ['add-drum', 'Drum track'], ['add-audio', 'Audio track'], ['add-sampler', 'Sampler track'], ['add-ext', 'External MIDI track'],
      ['add-group', 'Group the selected track'], ['add-return', 'Return track'], ['add-tempo', 'Tempo lane']]) add('ADD', l, () => $(id).click());
    for (const x of p.tracks) add('TRACK', `Go to ${x.name}`, () => app.selectTrack(x.id), x.kind);
    if (t) {
      add('TRACK', `Delete ${t.name}…`, () => app.deleteTrack(t.id));
      add('TRACK', `Duplicate ${t.name}`, () => app.duplicateTrack(t.id));
      if (['synth', 'drum', 'sampler'].includes(t.kind)) add('TRACK', t.frozen ? `Unfreeze ${t.name}` : `Freeze ${t.name}`, () => (t.frozen ? app.unfreeze(t.id) : app.freeze(t.id)));
      for (const type of DEVICE_ORDER) add('EFFECT', `Add ${DEVICES[type].name} to ${t.name}`, () => { app.store.change((pp) => pp.tracks.find((x) => x.id === t.id).fx.push({ id: uid('f'), type, on: true, p: defaults(type) })); app.showTab('device'); });
    }
    for (const type of DEVICE_ORDER) add('EFFECT', `Add ${DEVICES[type].name} to the master`, () => { app.store.change((pp) => pp.master.fx.push({ id: uid('f'), type, on: true, p: defaults(type) })); app.view.selBus = 'master'; app.showTab('device'); });
    for (const s of app.lib.sounds) add('SOUND', s.name, () => app.library.pick({ bank: s.bank, engine: s.engine, preset: s.preset }, false), `${s.eng} ${s.kind}`);
    app.lib.sloop.kits.forEach((k, i) => { if (!/^USR|^SYN/.test(k)) add('KIT', k, () => app.library.pick({ kit: i }, false)); });
    p.scenes.forEach((sc, i) => add('SESSION', `Launch ${sc.name}`, () => app.launchScene(i)));
    return out;
  }
  open() {
    if (document.querySelector('.palette')) return;
    const all = this.items();
    let sel = 0, shown = [];
    const input = h('input', { class: 'pal-in', placeholder: 'Type a command, a track, a sound, an effect…', spellcheck: 'false', 'aria-label': 'Command' });
    const list = h('div', { class: 'pal-list', role: 'listbox' });
    const bg = h('div', { class: 'modal-bg palette' }, h('div', { class: 'modal pal' }, input, list,
      h('p', { text: '↑ ↓ choose · Enter run · Esc close' })));
    const close = () => bg.remove();
    const render = () => {
      const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = all.filter((x) => q.every((w) => x.key.includes(w))).slice(0, 60);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((x, i) => {
        const el = h('button', { class: 'pal-item' + (i === sel ? ' on' : ''), role: 'option' }, h('span', { class: 'pg', text: x.group }), h('span', { text: x.label }), x.hint ? h('span', { class: 'ph', text: x.hint.toUpperCase() }) : null);
        el.addEventListener('click', () => { close(); x.run(); });
        return el;
      }));
      list.children[sel]?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); const x = shown[sel]; close(); x?.run(); }
      else if (e.key === 'Escape') close();
    });
    bg.addEventListener('pointerdown', (e) => { if (e.target === bg) close(); });
    document.body.append(bg);
    render();
    input.focus();
  }
}
