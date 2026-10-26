// SPDX-License-Identifier: GPL-3.0-only
// The command palette (Ctrl+K): every action, track, sound, kit and effect, found by typing.
import { barLabel } from '../meter.js';
import { h } from './kit.js';
import { ACTIONS } from '../control.js';
import { DEVICES, DEVICE_ORDER, defaults } from '../fx.js';
import { uid } from '../project.js';
import { t as tr } from '../i18n.js';
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();   // (found in English or French, accents or not)

export class Palette {
  constructor(app) { this.app = app; }
  items() {
    const app = this.app, p = app.store.p, t = app.store.track(app.view.selTrack), $ = (id) => document.getElementById(id);
    const out = [];
    const add = (group, label, run, hint = '') => out.push({ group, label, run, hint, key: fold(`${group} ${label} ${hint} ${tr(group)} ${tr(label)} ${tr(hint)}`) });
    for (const [a, l] of ACTIONS) add('ACTION', l, () => app.control.run(a));
    for (const m of ['read', 'touch', 'latch']) add('AUTOMATION', `Automation mode: ${m.toUpperCase()}`, () => { app.autorec.setMode(m); }, m === 'read' ? 'plays, records nothing' : m === 'touch' ? 'hold a knob while playing: recorded' : 'recorded, and held after you let go');
    add('AUTOMATION', 'Automation pencil (draw in the lanes)', () => { app.view.pencil = !app.view.pencil; app.arrange.renderHeads(); });
    for (const [act, l] of [['new', 'New empty project'], ['demo', 'Open the demo song'], ['open', 'Open a project…'], ['save', 'Save project'], ['export', 'Export audio (WAV, FLAC, MP3, Opus)…'],
      ['stems', 'Export stems…'], ['midi', 'Export MIDI'], ['dawexport', 'Export DAWproject (Bitwig, Studio One, Cubase…)'], ['saveas', 'Save the project as…'], ['template', 'Save the project as a template…'], ['presets', 'My presets: rename, delete, export, import…'], ['recover', 'Earlier versions of the project…'], ['importmidi', 'Import a MIDI file…'], ['sloop', 'Open a SLOOP song (.sloopsong)…'], ['install', 'Install the app (offline)'], ['help', 'Help: keys, mouse, fingers'], ['check', 'Check this device (audio, speed, storage, MIDI)'], ['report', 'Report a problem (beta)'], ['signature', 'Time signature from the bar at the playhead…'], ['starter', 'Start a song in a style (house, hip-hop, lo-fi, trap, techno)'], ['tour', 'Show me around (the tour)'], ['lang', 'Language: English / Français']]) add('PROJECT', l, () => app.fileAction(act));
    add('LAB', 'Build a plugin: instrument or effect…', () => app.labStart?.(), 'modules and cables, no code');
    for (const [id, l] of [['add-synth', 'Synth track'], ['add-drum', 'Drum track'], ['add-audio', 'Audio track'], ['add-sampler', 'Sampler track'], ['add-lab', 'LAB instrument track (build your own)'], ['add-ext', 'External MIDI track'],
      ['add-group', 'Group the selected track'], ['add-return', 'Return track'], ['add-tempo', 'Tempo lane']]) add('ADD', l, () => $(id).click());
    for (const [l, run, hint] of [['Split at the playhead', () => app.splitAt(), 'Ctrl+E'], ['Join / consolidate the selected clips', () => app.joinSelected(), 'Ctrl+J'],
      ['Copy the loop range (every track)', () => app.rangeAction('copy'), 'Ctrl+Shift+C'], ['Cut the loop range', () => app.rangeAction('cut'), 'Ctrl+Shift+X'],
      ['Paste the range at the playhead', () => app.rangeAction('paste'), 'Ctrl+Shift+V'], ['Delete the time of the loop range', () => app.rangeAction('delete'), 'what follows moves back'],
      ['Insert time at the loop range', () => app.rangeAction('insert'), 'its length'], ['Clear the loop range', () => app.rangeAction('clear'), 'leave a gap']]) add('EDIT', l, run, hint);
    for (const x of p.tracks) add('TRACK', `Go to ${x.name}`, () => app.selectTrack(x.id), x.kind);
    const warm = p.tracks.filter((x) => ['synth', 'drum', 'sampler', 'lab'].includes(x.kind) && !x.frozen && x.clips.length);
    if (warm.length > 1) add('TRACK', `Freeze every instrument track (${warm.length})`, () => app.freezeMany(warm.map((x) => x.id)), 'renders side by side, one per core');
    if (t) {
      add('TRACK', `Delete ${t.name}…`, () => app.deleteTrack(t.id));
      add('TRACK', `Duplicate ${t.name}`, () => app.duplicateTrack(t.id));
      if (['synth', 'drum', 'sampler', 'lab'].includes(t.kind)) add('TRACK', t.frozen ? `Unfreeze ${t.name}` : `Freeze ${t.name}`, () => (t.frozen ? app.unfreeze(t.id) : app.freeze(t.id)));
      for (const type of DEVICE_ORDER) add('EFFECT', `Add ${DEVICES[type].name} to ${t.name}`, () => { app.store.change((pp) => pp.tracks.find((x) => x.id === t.id).fx.push({ id: uid('f'), type, on: true, p: defaults(type) })); app.showTab('device'); });
    }
    for (const type of DEVICE_ORDER) add('EFFECT', `Add ${DEVICES[type].name} to the master`, () => { app.store.change((pp) => pp.master.fx.push({ id: uid('f'), type, on: true, p: defaults(type) })); app.view.selBus = 'master'; app.showTab('device'); });
    for (const s of app.lib.sounds) add('SOUND', s.name, () => app.library.pick({ bank: s.bank, engine: s.engine, preset: s.preset }, false), `${s.eng} ${s.kind}`);
    app.lib.sloop.kits.forEach((k, i) => { if (!/^USR|^SYN/.test(k)) add('KIT', k, () => app.library.pick({ kit: i }, false)); });
    p.scenes.forEach((sc, i) => add('SESSION', `Launch ${sc.name}`, () => app.launchScene(i)));
    for (const m of p.markers || []) add('MARKER', `Go to ${m.name}`, () => app.seek(m.t), `bar ${barLabel(p, m.t)}`);
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
      const q = fold(input.value).split(/\s+/).filter(Boolean);
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
