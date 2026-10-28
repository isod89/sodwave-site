// SPDX-License-Identifier: GPL-3.0-only
// The instrument device: the selected track's sound, every parameter of its SLOOP / Clipper
// engine on knobs. A drum track shows its kit and 16 pads.
import { missingNotice } from './packs.js';
import { h, knob, fmt } from './kit.js';
import { DEVICES, DEVICE_ORDER, defaults, fmtParam, toNorm, fromNorm } from '../fx.js';
import { uid } from '../project.js';
import { synthExtras, freezeModule, buildSampler, buildExternal, buildGroup, buildVca, pickAudio } from './instruments.js';
import { dragHasAudio, droppedAudio } from './samples.js';
import { fxPresetSheet, chainPresetSheet } from './presets.js';
import { noteFxModules, refreshNoteKnobs } from './notes.js';
import { modModules, refreshModKnobs, modMeters } from './mods.js';
import { wamFxModule, buildWamInstrument, wamDialog } from './wam.js';
import { buildLab, labFxButton } from './lab.js';
import { laneSound, drumMixer, drumSynthModule, synthKitIndex, newDrumSynth, drumSynthReady } from './drums.js';
import { newPatch } from '../lab-modules.js';

// the knobs of a sound, grouped; the two firmwares share ids 0..44 and 49..52 (core.h), Clipper adds its macros,
// a second envelope / LFO, a modulation matrix and moves the INSERT
const COMMON = [
  { title: 'ENVELOPE', ids: [1, 2, 3, 4, 5, 6, 7], cols: 4 },
  { title: 'LFO', ids: [9, 10, 11, 12, 13, 14, 15, 16], cols: 4 },
  { title: 'VOICE', ids: [37, 38, 44, 0], cols: 2 },
  { title: 'FX', ids: [33, 34, 35, 36, 50], cols: 3 },
];
const ARP = { title: 'ARP · CHORD', ids: [17, 18, 19, 20, 22, 24, 49, 51], cols: 4 };
const GROUPS = {
  sloop: [...COMMON, { title: 'INSERT', ids: [53, 54, 55, 56, 57], cols: 3 }, ARP],
  clipper: [{ title: 'MACROS', ids: [96, 97, 98, 99], cols: 2 }, ...COMMON,
    { title: 'ENV 2 · LFO 2', ids: [56, 57, 58, 59, 53, 54, 55], cols: 4 },
    { title: 'PLAYING', ids: [45, 46, 47, 48], cols: 2 },
    { title: 'MOD MATRIX', ids: [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71], cols: 6 },
    { title: 'MOD MATRIX 2', ids: [72, 73, 74, 75, 76, 77, 100, 101, 102, 103, 104, 105], cols: 6 },
    { title: 'INSERT', ids: [78, 79, 80, 81, 82], cols: 3 }, ARP],
};
const NICE = { 5: 'ENV>FLT', 6: 'ENV>PIT', 7: 'ENV>SHP', 13: '>PITCH', 14: '>FILTER', 15: '>SHAPE', 16: '>AMP', 0: 'LEVEL', 37: 'VOICE', 38: 'GLIDE', 44: 'DETUNE', 50: 'DJ FILT' };
const NICE_CLIPPER = { 53: 'LFO2 RATE', 54: 'LFO2 WAVE', 55: 'LFO2 MODE', 56: 'ENV2 ATK', 57: 'ENV2 DEC', 58: 'ENV2 SUS', 59: 'ENV2 REL' };

export class Device {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.wrap = h('div', { class: 'device' });
    root.append(this.wrap);
    this.knobs = new Map();
    this.fxKnobs = new Map();
    this.sig = '';
    app.store.on(() => this.refresh());
  }
  value(t, id) {
    if (t.params[id] != null) return t.params[id];
    if (t.kind === 'lab') return Math.round((t.lab?.macros?.[id]?.v ?? 0.5) * 127);   // (LAB: its macros)
    const v = this.app.params.get(t.id)?.[id];
    if (v != null) return v;
    const cat = this.app.lib[t.bank], e0 = cat.e0;
    return id >= e0 ? cat.engines[t.engine].edit[id - e0].def : cat.tp[id].def;
  }
  // whose rack is shown: a track, or a bus (a return, the master)
  owner() {
    const app = this.app, b = app.view.selBus, p = app.store.p;
    if (b === 'master') return { id: 'master', name: 'MASTER', fx: p.master.fx, edit: (fn) => app.store.change((pp) => fn(pp.master.fx), 'fxm') };
    if (/^ret\d+$/.test(b || '') && p.returns[+b.slice(3)]) { const i = +b.slice(3); return { id: b, name: `${p.returns[i].name} RETURN`, fx: p.returns[i].fx, edit: (fn) => app.store.change((pp) => fn(pp.returns[i].fx), 'fxr' + i) }; }
    const t = app.store.track(app.view.selTrack);
    return t ? { id: t.id, name: t.name, fx: t.fx, t, edit: (fn, tag) => app.store.change((pp) => fn(pp.tracks.find((x) => x.id === t.id).fx), tag) } : null;
  }
  refresh(force = false) {
    const t = this.app.store.track(this.app.view.selTrack), o = this.owner();
    const fxSig = o ? o.fx.map((d) => d.id + d.type + (d.on !== false) + (d.p.sc || '') + (d.lab ? d.lab.name + d.lab.macros.map((m) => m.name).join('') : '')).join(',') : '';
    const extra = t ? JSON.stringify([t.sample && [t.sample.src, t.sample.mode, t.sample.slices, t.sample.name, t.sample.loop, (t.sample.zones || []).map((z) => [z.src, z.root, z.lo, z.hi, z.vlo, z.vhi])], t.pads && Object.entries(t.pads).map(([k, x]) => k + x.src + x.choke), t.ext, t.frozen, t.mpe, t.dx7?.name, t.wam?.url, (t.nfx || []).map((d) => d.id + d.type + (d.on !== false)),
      (t.mods || []).map((m) => [m.id, m.type, m.on !== false, m.src, Math.round(m.p.sy ?? 1), (m.to || []).map((x) => x.key)]), (t.fx || []).length, t.kind === 'group' ? this.app.store.p.tracks.filter((x) => x.out === t.id).length : 0, t.lab && [t.lab.name, t.lab.mods.length, t.lab.voice, t.lab.macros.map((m) => m.name)], Object.keys(this.app.store.p.assets || {}).length]) : '';
    const sig = this.app.view.selBus ? `bus:${this.app.view.selBus}:${fxSig}:${this.app.store.p.tracks.length}`
      : t ? `${t.id}:${t.kind}:${t.bank}:${t.engine}:${t.preset}:${t.kit}:${this.app.params.has(t.id)}:${t.kind === 'audio' ? t.clips.length : ''}:${fxSig}:${this.app.store.p.tracks.length}:${extra}` : '';
    if (sig !== this.sig || force) { this.sig = sig; this.build(t); return; }
    if (t && !this.app.view.selBus) { for (const [id, k] of this.knobs) k.setValue(this.value(t, id)); refreshNoteKnobs(this, t); refreshModKnobs(this, t); }
    if (o) for (const d of o.fx) for (const p of DEVICES[d.type]?.params || []) this.fxKnobs.get(`${d.id}:${p.k}`)?.setValue(Math.round(toNorm(p, d.p[p.k] ?? p.def) * 1000));
  }
  mods(values) { const t = this.app.store.track(this.app.view.selTrack); if (t && !this.app.view.selBus) modMeters(this, values?.[t.id], t); }
  // the knobs a modulator moves wear a mark
  markModded(t) {
    const keys = new Set((t.mods || []).filter((m) => m.on !== false).flatMap((m) => (m.to || []).map((x) => x.key)));
    for (const el of this.wrap.querySelectorAll('[data-learn]')) {
      const id = el.dataset.learn, parts = id.split(':');
      const key = parts[0] === 'sel' && parts[1] === 'p' ? `p${parts[2]}` : (parts[0] === 'fx' || parts[0] === 'nfx') && parts[1] === t.id ? `${parts[0]}:${parts[2]}:${parts[3]}` : null;
      el.classList.toggle('modded', !!key && keys.has(key));
    }
  }
  gr(map) {                                                   // gain reduction readouts, from the engine's ticks
    for (const [id, el] of this.grEls || []) { const v = map?.[id] || 0; el.textContent = `GR ${v > 0.05 ? '-' + v.toFixed(1) : '0.0'} dB`; el.style.setProperty('--v', Math.min(1, v / 24).toFixed(3)); }
  }
  rackModules(o) {
    const app = this.app, color = o.t?.color || 'var(--accent)';
    this.grEls = new Map();
    const mods = o.fx.map((d, i) => {
      if (d.type === 'wam') return wamFxModule(this, o, d, i);      // a plugin (WAM): its own panel
      const spec = DEVICES[d.type];
      const knobs = spec.params.filter((p) => p.k !== 'sc').map((p) => {
        const k = knob({ label: d.type === 'lab' && /^m\d$/.test(p.k) ? (d.lab?.macros?.[+p.k[1]]?.name || p.l) : p.l, min: 0, max: 1000, value: Math.round(toNorm(p, d.p[p.k] ?? p.def) * 1000), def: Math.round(toNorm(p, p.def) * 1000), color,
          format: (v) => fmtParam(p, fromNorm(p, v / 1000)),
          onChange: (v) => o.edit((fx) => { const x = fx.find((y) => y.id === d.id); if (x) x.p[p.k] = fromNorm(p, v / 1000); }, `fx${d.id}${p.k}`),
          onEnd: () => app.store.endGesture() });
        k.dataset.learn = `fx:${o.id}:${d.id}:${p.k}`;
        this.fxKnobs.set(`${d.id}:${p.k}`, k);
        return k;
      });
      const extra = [];
      if (d.type === 'comp') {
        extra.push(h('label', { class: 'fx-sc' }, 'SIDECHAIN',
          h('select', { 'aria-label': 'Sidechain source', onchange: (e) => o.edit((fx) => { fx.find((y) => y.id === d.id).p.sc = e.target.value; }) },
            h('option', { value: '' }, 'OFF (ITSELF)'),
            app.store.p.tracks.filter((t) => t.id !== o.id).map((t) => h('option', { value: t.id, selected: d.p.sc === t.id ? true : null }, t.name)))));
      }
      if (['comp', 'limiter', 'gate', 'mband', 'deess'].includes(d.type)) { const g = h('span', { class: 'fx-gr', text: 'GR 0.0 dB' }); this.grEls.set(d.id, g); extra.push(g); }
      const move = (dir) => o.edit((fx) => { const j = fx.findIndex((y) => y.id === d.id), k2 = j + dir; if (k2 >= 0 && k2 < fx.length) [fx[j], fx[k2]] = [fx[k2], fx[j]]; });
      return h('div', { class: 'module fx' + (d.on === false ? ' off' : '') },
        h('h4', {}, h('span', { text: spec.name }), h('span', { class: 'fx-ctl' },
          h('button', { class: 'tb', title: 'Presets: factory and yours, save these settings', 'aria-label': `${spec.name} presets`, onclick: () => fxPresetSheet(app, o, d) }, '☰'),
          h('button', { class: 'tb' + (d.on !== false ? ' fxon' : ''), title: 'On / off', 'data-learn': `fxon:${o.id}:${d.id}`, onclick: () => o.edit((fx) => { const x = fx.find((y) => y.id === d.id); x.on = x.on === false; }) }, '⏻'),
          h('button', { class: 'tb', title: 'Move left', onclick: () => move(-1), disabled: i === 0 ? true : null }, '◀'),
          h('button', { class: 'tb', title: 'Move right', onclick: () => move(1), disabled: i === o.fx.length - 1 ? true : null }, '▶'),
          h('button', { class: 'tb', title: 'Remove', onclick: () => {
            if (o.t) app.store.change((pp) => {                       // a track's effect: its modulations go with it
              const tr = pp.tracks.find((x) => x.id === o.t.id);
              tr.fx = tr.fx.filter((y) => y.id !== d.id);
              for (const m of tr.mods || []) m.to = (m.to || []).filter((tg) => !tg.key.startsWith(`fx:${d.id}:`));
            });
            else o.edit((fx) => { const j = fx.findIndex((y) => y.id === d.id); fx.splice(j, 1); });
          } }, '×'))),
        d.type === 'lab' ? labFxButton(app, o, d) : null,
        h('div', { class: 'knobs', '--cols': spec.params.length > 8 ? 6 : 4 }, knobs), ...extra);
    });
    const add = h('div', { class: 'module fx-add' }, h('h4', {}, 'ADD EFFECT', h('em', { text: o.name })),
      h('div', { class: 'fx-list' }, DEVICE_ORDER.map((type) => h('button', { class: 'add', onclick: () => o.edit((fx) => { fx.push({ id: uid('f'), type, on: true, p: defaults(type), ...(type === 'lab' ? { lab: newPatch('fx') } : {}) }); }) }, DEVICES[type].name)),
        o.t ? h('button', { class: 'add wam-add', title: 'A Web Audio Module from its address', onclick: () => wamDialog(app, { trackId: o.t.id }) }, 'PLUGIN (WAM)…') : null));
    const head = h('div', { class: 'rack-head' }, 'EFFECTS', h('em', { text: `${o.name} · ${o.fx.length}` }),
      o.fx.length ? null : h('span', { style: { letterSpacing: '0.04em', fontWeight: 500 }, text: 'Signal flows left to right. Every knob is learnable and automatable.' }),
      h('button', { class: 'add small', title: 'Save this chain, or load one of yours', onclick: () => chainPresetSheet(app, o) }, 'CHAIN PRESETS'));
    return [head, ...mods, add];
  }
  setParam(t, id, v) {
    this.app.audio.send({ t: 'param', track: t.id, id, v });
    this.app.store.change((p) => { p.tracks.find((x) => x.id === t.id).params[id] = v; }, `knob${t.id}${id}`);
  }
  build(t) {
    // the view keeps its place; a module just added is brought into view
    const sx = this.wrap.scrollLeft, sy = this.wrap.scrollTop;
    const count = (sel) => this.wrap.querySelectorAll(sel).length, before = { fx: count('.module.fx:not(.nfx):not(.modm)'), nfx: count('.module.nfx'), mod: count('.module.modm') };
    const same = this.lastBuilt === (this.app.view.selBus || t?.id);
    this.lastBuilt = this.app.view.selBus || t?.id;
    requestAnimationFrame(() => {
      if (!same) return;
      this.wrap.scrollLeft = sx; this.wrap.scrollTop = sy;
      for (const [k, sel] of [['fx', '.module.fx:not(.nfx):not(.modm)'], ['nfx', '.module.nfx'], ['mod', '.module.modm']]) {
        const all = this.wrap.querySelectorAll(sel);
        if (all.length > before[k]) all[all.length - 1].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    });
    this.knobs.clear();
    this.fxKnobs.clear();
    const o = this.owner();
    if (this.app.view.selBus && o) {
      this.wrap.style.setProperty('--c', 'var(--accent)');
      this.wrap.replaceChildren(h('div', { class: 'module sound-lcd' }, h('h4', {}, 'BUS', h('em', { text: 'EFFECTS' })),
        h('div', { class: 'screen' }, h('span', { class: 'eng', text: o.id === 'master' ? 'BEFORE THE MASTER LIMITER' : 'AFTER THE RETURN' }), h('span', { class: 'pre', text: o.name })),
        h('button', { class: 'add', style: { height: '26px' }, onclick: () => { this.app.view.selBus = null; this.refresh(true); } }, 'BACK TO THE TRACK')),
      ...this.rackModules(o));
      return;
    }
    this.buildTrack(t);
    if (t) {
      const notes = noteFxModules(this, t);                        // notes > note effects > the instrument > modulators > effects
      if (notes.length && this.wrap.firstChild) this.wrap.firstChild.after(...notes);
      this.wrap.append(...modModules(this, t));
      this.markModded(t);
    }
    if (o) this.wrap.append(...this.rackModules(o));
  }
  buildTrack(t) {
    if (!t) { this.wrap.replaceChildren(h('div', { class: 'empty', style: { inset: 0 } }, h('b', { text: 'NO TRACK' }), h('p', { text: 'Select a track to see its instrument.' }))); return; }
    this.wrap.style.setProperty('--c', t.color);
    if (t.kind === 'drum') return this.buildDrums(t);
    if (t.kind === 'audio') return this.buildAudio(t);
    if (t.kind === 'sampler') return buildSampler(this, t);
    if (t.kind === 'external') return buildExternal(this, t);
    if (t.kind === 'group') return buildGroup(this, t);
    if (t.kind === 'vca') return buildVca(this, t);
    if (t.kind === 'wam') return buildWamInstrument(this, t);
    if (t.kind === 'lab') return buildLab(this, t);
    const app = this.app, cat = app.lib[t.bank];
    if (cat.missing || cat.error) { this.wrap.replaceChildren(missingNotice(app, t)); return; }   // (a community engine this version does not have, or could not load)
    const eng = cat.engines[t.engine], e0 = cat.e0;
    const mk = (id, d, label) => {
      const k = knob({ label: label || d.l, min: d.min, max: d.max, def: d.def, value: this.value(t, id), color: t.color,
        format: (v) => fmt(d, v), mod: t.params[id] != null, onChange: (v) => { k.classList.add('mod'); this.setParam(t, id, v); }, onEnd: () => app.store.endGesture() });
      k.title = `${label || d.l}: double-click resets · drag (Shift: fine) · LEARN maps it to a controller knob`;
      k.dataset.learn = `sel:p:${id}`;
      this.knobs.set(id, k);
      return k;
    };
    const lib = app.lib, ek = lib.engKey(t.bank, eng.name), list = lib.byEngine[ek] || [], cur = lib.soundOf(t);
    const at = Math.max(0, list.indexOf(cur));
    const go = (s) => s && app.setSound(t.id, { bank: s.bank, engine: s.engine, preset: s.preset });
    const step = (d) => go(list[(at + d + list.length) % list.length]);
    const sound = h('div', { class: 'module sound-lcd' },
      h('h4', {}, 'SOUND', h('em', { translate: cat.pack ? 'no' : null, text: cat.pack ? `◆ ${cat.pack.name.toUpperCase()}` : cur ? cur.kind : '' })),
      h('div', { class: 'screen' },
        h('span', { class: 'eng', text: `${eng.name} · ${at + 1}/${list.length}` }),
        h('span', { class: 'pre', text: cat.engines[t.engine].presets[t.preset] })),
      h('div', { class: 'row' },
        h('button', { class: 'add', onclick: () => step(-1), title: 'Previous sound ([)' }, '◀ PREV'),
        h('button', { class: 'add', onclick: () => step(1), title: 'Next sound (])' }, 'NEXT ▶')),
      h('select', { 'aria-label': 'Engine', translate: 'no', onchange: (e) => go(lib.byEngine[e.target.value][0]) },
        lib.engineNames.map((n) => h('option', { value: n, selected: n === ek ? true : null }, `${n} (${lib.byEngine[n].length})`))),
      h('select', { 'aria-label': 'Sound', translate: 'no', onchange: (e) => go(list[+e.target.value]) },
        list.map((s, i) => h('option', { value: i, selected: i === at ? true : null }, s.name))),
      h('div', { class: 'row' },
        h('button', { class: 'add', title: 'Back to the sound as it was loaded', onclick: () => app.setSound(t.id, {}, true) }, 'RESET SOUND')));
    const engMod = h('div', { class: 'module' }, h('h4', {}, eng.name, h('em', { text: 'ENGINE' })),
      h('div', { class: 'knobs', '--cols': 4 }, eng.edit.map((d, i) => mk(e0 + i, d))));
    const nice = (id) => (cat.pack ? null : (t.bank === 'clipper' && NICE_CLIPPER[id]) || NICE[id]);
    const groups = (cat.groups || GROUPS[t.bank] || GROUPS[cat.tp[96] ? 'clipper' : 'sloop']).map((g) => h('div', { class: 'module' }, h('h4', { text: g.title }),
      h('div', { class: 'knobs', '--cols': g.cols || 4 }, g.ids.filter((id) => cat.tp[id]).map((id) => mk(id, cat.tp[id], nice(id))))));
    this.wrap.replaceChildren(sound, engMod, ...groups, ...synthExtras(this, t));
  }
  buildAudio(t) {
    const app = this.app, input = app.audio.input, n = app.audio.inputChannels || 2;
    const files = t.clips.map((c) => app.assets.get(c.src)?.name).filter(Boolean);
    const set = (fn) => app.store.change((p) => fn(p.tracks.find((x) => x.id === t.id)));
    // the input device (filled when the browser lists them)
    const dev = h('select', { 'aria-label': 'Input device', title: 'The audio input: your interface, a microphone…', onchange: async (e) => { try { await app.audio.enableInput(e.target.value); app.syncMonitor(); this.refresh(true); app.toast(`Input: ${app.audio.inputName}.`); } catch (err) { app.toast(`That input could not open: ${err.message}`); } } },
      h('option', { value: '' }, input ? (app.audio.inputName || 'INPUT') : 'DEFAULT INPUT'));
    app.audio.inputs().then((list) => { if (list.length) dev.replaceChildren(...list.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === app.audio.inputId ? true : null }, d.label.slice(0, 40)))); });
    const pairs = [];
    for (let i = 0; i + 1 < Math.max(2, n); i += 2) pairs.push([`${i}:${i + 1}`, `${i + 1} + ${i + 2} (STEREO)`]);
    for (let i = 0; i < Math.max(2, n); i++) pairs.push([`${i}:m`, `${i + 1} (MONO)`]);
    const cur = `${t.input?.a ?? 0}:${t.input?.b === null ? 'm' : t.input?.b ?? 1}`;
    const ch = h('select', { 'aria-label': 'Input channels', title: 'Which input channels this track records (an interface with 4 or 8 inputs: one track per input)',
      onchange: (e) => { const [a, b] = e.target.value.split(':'); set((x) => { x.input = { a: +a, b: b === 'm' ? null : +b }; }); } },
      pairs.map(([v, l]) => h('option', { value: v, selected: v === cur ? true : null }, l)));
    const mon = h('select', { 'aria-label': 'Monitoring', title: 'Hear the input through this track (its effects included): AUTO when armed, IN always, OFF never (when your interface monitors itself)',
      onchange: (e) => set((x) => { x.monitor = e.target.value; }) },
      [['auto', 'AUTO (WHEN ARMED)'], ['in', 'IN (ALWAYS)'], ['off', 'OFF']].map(([v, l]) => h('option', { value: v, selected: (t.monitor || 'auto') === v ? true : null }, l)));
    let off = 0; try { off = +localStorage.getItem('kraken.recOffset') || 0; } catch { /* */ }
    const offIn = h('input', { type: 'number', min: -100, max: 300, step: 1, value: off, style: { width: '64px' }, 'aria-label': 'Recording offset in ms', title: 'Recorded audio lands this many milliseconds earlier (more) or later (less). Record a click (CLICK on) with the mic near the speaker: if the take is late, raise it',
      onkeydown: (e) => e.stopPropagation(), onchange: (e) => { try { localStorage.setItem('kraken.recOffset', String(+e.target.value || 0)); } catch { /* */ } app.toast(`Recordings now land ${(+e.target.value || 0)} ms ${+e.target.value >= 0 ? 'earlier' : 'later'} (this device).`); } });
    const row = (label, el) => h('label', { class: 'ctl-row' }, h('span', { text: label }), el);
    this.wrap.replaceChildren(
      h('div', { class: 'module sound-lcd' }, h('h4', {}, 'AUDIO', h('em', { text: 'TRACK' })),
        h('div', { class: 'screen' }, h('span', { class: 'eng', text: input ? `INPUT ON · ${n} CH` : 'INPUT OFF' }),
          h('span', { class: 'pre', text: input ? (app.audio.inputName || 'INPUT').toUpperCase().slice(0, 28) : 'NO INPUT' })),
        h('div', { class: 'row' },
          h('button', { class: 'add', onclick: () => app.pickAudio({ trackId: t.id, beat: Math.floor(app.pos) }) }, 'IMPORT FILE'),
          h('button', { class: 'add', onclick: async () => { try { await app.audio.enableInput(); app.syncMonitor(); this.refresh(true); app.toast('Input on. Arm the track (●) and press R to record.'); } catch (err) { app.toast(`No input: ${err.message}`); } } }, input ? 'INPUT READY' : 'ENABLE INPUT'))),
      h('div', { class: 'module audio-in' }, h('h4', {}, 'INPUT', h('em', { text: t.arm ? 'ARMED' : 'ARM ● TO RECORD' })),
        row('DEVICE', dev), row('CHANNELS', ch), row('MONITOR', mon), row('OFFSET MS', offIn),
        h('p', { class: 'ctl-note', text: 'Several audio tracks armed: each records its own channels at once. The track meter shows the input level while armed.' })),
      h('div', { class: 'module', style: { maxWidth: '360px' } }, h('h4', { text: 'HOW IT WORKS' }),
        h('p', { style: { margin: 0, font: '500 11px/1.5 var(--f-ui)', color: 'var(--dim)' },
          text: 'Drop audio files on the arrangement, or import one at the playhead. To record: arm this track (●), then R. Each pass of the loop is one take, placed where you played it (latency compensated).' }),
        files.length ? h('p', { style: { margin: 0, font: '500 10px/1.5 var(--f-mono)', color: 'var(--text)' }, text: [...new Set(files)].join(' · ') }) : null));
  }
  buildDrums(t) {
    const app = this.app, lib = app.lib.sloop;
    const syn = synthKitIndex(lib);
    const kits = lib.kits.map((n, i) => [n, i]).filter(([n]) => !/^USR|^SYN/.test(n));
    if (syn >= 0 && drumSynthReady(app)) kits.push(['DRUM SYNTH', syn]);   // (your synthesised kit: SYN1)
    const setKit = (k) => {
      if (k === syn && !app.store.track(t.id).dsyn) {                 // the first time: from the synth kit playing now (else 808)
        const cur = app.store.track(t.id).kit, nk = newDrumSynth(app, cur >= 5 && cur < 37 ? cur - 5 : 0);
        if (nk) app.store.change((p) => { p.tracks.find((x) => x.id === t.id).dsyn = nk; });
      }
      app.setKit(t.id, k);
    };
    const step = (d) => {
      const i = kits.findIndex(([, k]) => k === t.kit);
      setKit(kits[(i + d + kits.length) % kits.length][1]);
    };
    if (!lib.laneNotes.includes(app.view.padSel)) app.view.padSel = lib.laneNotes[0];
    const padBox = h('div', { class: 'module pad-edit', style: { width: '250px' } });
    const pads = lib.lanes.map((name, l) => {
      const n = lib.laneNotes[l], u = t.pads?.[n];
      const pad = h('button', { class: 'pad' + (u ? ' user' : '') + (t.lanes?.[l] ? ' tweak' : '') + (app.view.padSel === n ? ' sel' : ''), 'aria-label': `Play ${name}`, 'data-note': n,
        title: `${name}${u ? ` · ${u.name}` : ''}\nClick: play and edit · drop a sample here to replace its sound` }, name, u ? h('span', { class: 'pad-smp', text: u.name }) : null);
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault(); app.noteOn(t.id, n, e.shiftKey ? 127 : 100); pad.classList.add('hit'); setTimeout(() => pad.classList.remove('hit'), 120);
        if (app.view.padSel !== n) { app.view.padSel = n; for (const x of pads) x.classList.toggle('sel', x === pad); this.padPanel(t, padBox); }
      });
      pad.addEventListener('dragover', (e) => { if (dragHasAudio(e)) { e.preventDefault(); pad.classList.add('dropping'); } });
      pad.addEventListener('dragleave', () => pad.classList.remove('dropping'));
      pad.addEventListener('drop', async (e) => { e.preventDefault(); pad.classList.remove('dropping'); const fs = await droppedAudio(app, e); if (fs.length) { app.view.padSel = n; app.setPadSample(t.id, n, fs[0]); } });
      return pad;
    });
    this.padPanel(t, padBox);
    this.wrap.replaceChildren(
      h('div', { class: 'module sound-lcd' }, h('h4', {}, 'KIT', h('em', { text: 'SLOOP' })),
        h('div', { class: 'screen' }, h('span', { class: 'eng', text: `DRUMS · ${kits.findIndex(([, k]) => k === t.kit) + 1}/${kits.length}` }), h('span', { class: 'pre', text: t.kit === syn && t.dsyn ? `${t.dsyn.name} · DRUM SYNTH` : lib.kits[t.kit] })),
        h('div', { class: 'row' }, h('button', { class: 'add', onclick: () => step(-1) }, '◀ PREV'), h('button', { class: 'add', onclick: () => step(1) }, 'NEXT ▶')),
        h('select', { 'aria-label': 'Kit', onchange: (e) => setKit(+e.target.value) }, kits.map(([n, i]) => h('option', { value: i, selected: i === t.kit ? true : null }, n)))),
      h('div', { class: 'module' }, h('h4', {}, 'PADS', h('em', { text: 'SHIFT = ACCENT · DROP A SAMPLE' })), h('div', { class: 'pads' }, pads)), padBox,
      ...(t.kit === syn ? [drumSynthModule(this, t)] : []).filter(Boolean), drumMixer(this, t), freezeModule(this, t));
  }
  // the selected pad: the kit's sound, or your sample (load, gain, tune, decay, filter, choke group)
  padPanel(t, box) {
    const app = this.app, lib = app.lib.sloop, n = app.view.padSel, name = lib.lanes[lib.laneNotes.indexOf(n)] || String(n);
    const u = app.store.track(t.id)?.pads?.[n];
    const set = (fn, tag) => app.store.change((p) => { const pd = p.tracks.find((x) => x.id === t.id).pads?.[n]; if (pd) fn(pd); }, tag);
    const load = h('button', { class: 'add', style: { height: '26px' }, onclick: async () => { const f = await pickAudio(); if (f) app.setPadSample(t.id, n, f); } }, u ? 'REPLACE…' : 'LOAD SAMPLE…');
    const assets = Object.entries(app.store.p.assets || {});
    const proj = assets.length ? h('select', { 'aria-label': 'A project audio file', onchange: (e) => { const id = e.target.value; if (!id) return; app.store.change((p) => { const tt = p.tracks.find((x) => x.id === t.id); tt.pads ||= {}; tt.pads[n] = { ...(tt.pads[n] || {}), src: id, name: p.assets[id]?.name || 'SAMPLE', start: 0, end: 1 }; }); app.audition(t.id, [n], 300); } },
      h('option', { value: '' }, 'PROJECT AUDIO…'), assets.map(([id, m]) => h('option', { value: id, selected: u?.src === id ? true : null }, m.name))) : null;
    const kids = [h('h4', {}, `PAD · ${name}`, h('em', { text: u ? 'YOUR SAMPLE' : 'KIT SOUND' }))];
    if (!u) kids.push(...laneSound(this, t, n, t.color), h('p', { class: 'ctl-note', text: 'Or load a sample, drop one on the pad, or drag one from SOUNDS › SAMPLES: it plays instead of the kit.' }), h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, load, proj));
    else {
      const kn = (label, key, min, max, def, fmtf, step = 1) => knob({ label, min, max, def, step, value: u[key] ?? def, color: t.color, size: 30, format: fmtf, onChange: (v) => set((x) => { x[key] = v; }, `pad${n}${key}`), onEnd: () => app.store.endGesture() });
      kids.push(h('p', { class: 'ctl-note', style: { color: '#ffc21a' }, text: u.name }),
        h('div', { class: 'knobs', '--cols': 4 },
          kn('GAIN', 'gain', -24, 12, 0, (v) => `${v > 0 ? '+' : ''}${v}dB`), kn('TUNE', 'tune', -24, 24, 0, (v) => `${v > 0 ? '+' : ''}${v}st`),
          kn('DECAY', 'dec', 0, 4000, 0, (v) => (v ? `${Math.round(v)}ms` : 'FULL'), 5), kn('CUTOFF', 'cut', 30, 20000, 20000, (v) => (v >= 19900 ? 'OPEN' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`), 10)),
        h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
          h('label', { class: 'fx-sc', title: 'Pads of one group cut each other (a closed hat stops the open one)' }, 'CHOKE', h('select', { 'aria-label': 'Choke group', onchange: (e) => set((x) => { x.choke = +e.target.value; }) },
            [...Array(9)].map((_, i) => h('option', { value: i, selected: (u.choke || 0) === i ? true : null }, i ? `GROUP ${i}` : 'OFF')))),
          load, h('button', { class: 'add', style: { height: '26px' }, title: 'Back to the kit\'s sound', onclick: () => app.clearPad(t.id, n) }, 'KIT SOUND')));
    }
    box.replaceChildren(...kids);
  }
}
