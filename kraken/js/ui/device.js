// SPDX-License-Identifier: GPL-3.0-only
// The instrument device: the selected track's sound, every parameter of its SLOOP / Clipper
// engine on knobs. A drum track shows its kit and 16 pads.
import { h, knob, fmt } from './kit.js';
import { DEVICES, DEVICE_ORDER, defaults, fmtParam, toNorm, fromNorm } from '../fx.js';
import { uid } from '../project.js';
import { synthExtras, freezeModule, buildSampler, buildExternal, buildGroup } from './instruments.js';

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
    const v = this.app.params.get(t.id)?.[id];
    if (v != null) return v;
    const cat = this.app.lib[t.bank], e0 = cat.e0;
    return id >= e0 ? cat.engines[t.engine].edit[id - e0].def : cat.tp[id].def;
  }
  // whose rack is shown: a track, or a bus (a return, the master)
  owner() {
    const app = this.app, b = app.view.selBus, p = app.store.p;
    if (b === 'master') return { id: 'master', name: 'MASTER', fx: p.master.fx, edit: (fn) => app.store.change((pp) => fn(pp.master.fx), 'fxm') };
    if (b === 'ret0' || b === 'ret1') { const i = +b[3]; return { id: b, name: `${p.returns[i].name} RETURN`, fx: p.returns[i].fx, edit: (fn) => app.store.change((pp) => fn(pp.returns[i].fx), 'fxr' + i) }; }
    const t = app.store.track(app.view.selTrack);
    return t ? { id: t.id, name: t.name, fx: t.fx, t, edit: (fn, tag) => app.store.change((pp) => fn(pp.tracks.find((x) => x.id === t.id).fx), tag) } : null;
  }
  refresh(force = false) {
    const t = this.app.store.track(this.app.view.selTrack), o = this.owner();
    const fxSig = o ? o.fx.map((d) => d.id + d.type + (d.on !== false) + (d.p.sc || '')).join(',') : '';
    const extra = t ? JSON.stringify([t.sample, t.ext, t.frozen, t.mpe, t.dx7?.name, t.kind === 'group' ? this.app.store.p.tracks.filter((x) => x.out === t.id).length : 0, Object.keys(this.app.store.p.assets || {}).length]) : '';
    const sig = this.app.view.selBus ? `bus:${this.app.view.selBus}:${fxSig}:${this.app.store.p.tracks.length}`
      : t ? `${t.id}:${t.kind}:${t.bank}:${t.engine}:${t.preset}:${t.kit}:${this.app.params.has(t.id)}:${t.kind === 'audio' ? t.clips.length : ''}:${fxSig}:${this.app.store.p.tracks.length}:${extra}` : '';
    if (sig !== this.sig || force) { this.sig = sig; this.build(t); return; }
    if (t && !this.app.view.selBus) for (const [id, k] of this.knobs) k.setValue(this.value(t, id));
    if (o) for (const d of o.fx) for (const p of DEVICES[d.type].params) this.fxKnobs.get(`${d.id}:${p.k}`)?.setValue(Math.round(toNorm(p, d.p[p.k] ?? p.def) * 1000));
  }
  gr(map) {                                                   // gain reduction readouts, from the engine's ticks
    for (const [id, el] of this.grEls || []) { const v = map?.[id] || 0; el.textContent = `GR ${v > 0.05 ? '-' + v.toFixed(1) : '0.0'} dB`; el.style.setProperty('--v', Math.min(1, v / 24).toFixed(3)); }
  }
  rackModules(o) {
    const app = this.app, color = o.t?.color || 'var(--accent)';
    this.grEls = new Map();
    const mods = o.fx.map((d, i) => {
      const spec = DEVICES[d.type];
      const knobs = spec.params.filter((p) => p.k !== 'sc').map((p) => {
        const k = knob({ label: p.l, min: 0, max: 1000, value: Math.round(toNorm(p, d.p[p.k] ?? p.def) * 1000), def: Math.round(toNorm(p, p.def) * 1000), color,
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
      if (d.type === 'comp' || d.type === 'limiter' || d.type === 'gate') { const g = h('span', { class: 'fx-gr', text: 'GR 0.0 dB' }); this.grEls.set(d.id, g); extra.push(g); }
      const move = (dir) => o.edit((fx) => { const j = fx.findIndex((y) => y.id === d.id), k2 = j + dir; if (k2 >= 0 && k2 < fx.length) [fx[j], fx[k2]] = [fx[k2], fx[j]]; });
      return h('div', { class: 'module fx' + (d.on === false ? ' off' : '') },
        h('h4', {}, h('span', { text: spec.name }), h('span', { class: 'fx-ctl' },
          h('button', { class: 'tb' + (d.on !== false ? ' fxon' : ''), title: 'On / off', 'data-learn': `fxon:${o.id}:${d.id}`, onclick: () => o.edit((fx) => { const x = fx.find((y) => y.id === d.id); x.on = x.on === false; }) }, '⏻'),
          h('button', { class: 'tb', title: 'Move left', onclick: () => move(-1), disabled: i === 0 ? true : null }, '◀'),
          h('button', { class: 'tb', title: 'Move right', onclick: () => move(1), disabled: i === o.fx.length - 1 ? true : null }, '▶'),
          h('button', { class: 'tb', title: 'Remove', onclick: () => o.edit((fx) => { const j = fx.findIndex((y) => y.id === d.id); fx.splice(j, 1); }) }, '×'))),
        h('div', { class: 'knobs', '--cols': spec.params.length > 8 ? 6 : 4 }, knobs), ...extra);
    });
    const add = h('div', { class: 'module fx-add' }, h('h4', {}, 'ADD EFFECT', h('em', { text: o.name })),
      h('div', { class: 'fx-list' }, DEVICE_ORDER.map((type) => h('button', { class: 'add', onclick: () => o.edit((fx) => { fx.push({ id: uid('f'), type, on: true, p: defaults(type) }); }) }, DEVICES[type].name))));
    const head = h('div', { class: 'rack-head' }, 'EFFECTS', h('em', { text: `${o.name} · ${o.fx.length}` }),
      o.fx.length ? null : h('span', { style: { letterSpacing: '0.04em', fontWeight: 500 }, text: 'Signal flows left to right. Every knob is learnable and automatable.' }));
    return [head, ...mods, add];
  }
  setParam(t, id, v) {
    this.app.audio.send({ t: 'param', track: t.id, id, v });
    this.app.store.change((p) => { p.tracks.find((x) => x.id === t.id).params[id] = v; }, `knob${t.id}${id}`);
  }
  build(t) {
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
    const app = this.app, cat = app.lib[t.bank], eng = cat.engines[t.engine], e0 = cat.e0;
    const mk = (id, d, label) => {
      const k = knob({ label: label || d.l, min: d.min, max: d.max, def: d.def, value: this.value(t, id), color: t.color,
        format: (v) => fmt(d, v), mod: t.params[id] != null, onChange: (v) => { k.classList.add('mod'); this.setParam(t, id, v); }, onEnd: () => app.store.endGesture() });
      k.title = `${label || d.l}: double-click resets · drag (Shift: fine) · LEARN maps it to a controller knob`;
      k.dataset.learn = `sel:p:${id}`;
      this.knobs.set(id, k);
      return k;
    };
    const lib = app.lib, list = lib.byEngine[eng.name] || [], cur = lib.soundOf(t);
    const at = Math.max(0, list.indexOf(cur));
    const go = (s) => s && app.setSound(t.id, { bank: s.bank, engine: s.engine, preset: s.preset });
    const step = (d) => go(list[(at + d + list.length) % list.length]);
    const sound = h('div', { class: 'module sound-lcd' },
      h('h4', {}, 'SOUND', h('em', { text: cur ? cur.kind : '' })),
      h('div', { class: 'screen' },
        h('span', { class: 'eng', text: `${eng.name} · ${at + 1}/${list.length}` }),
        h('span', { class: 'pre', text: cat.engines[t.engine].presets[t.preset] })),
      h('div', { class: 'row' },
        h('button', { class: 'add', onclick: () => step(-1), title: 'Previous sound ([)' }, '◀ PREV'),
        h('button', { class: 'add', onclick: () => step(1), title: 'Next sound (])' }, 'NEXT ▶')),
      h('select', { 'aria-label': 'Engine', onchange: (e) => go(lib.byEngine[e.target.value][0]) },
        lib.engineNames.map((n) => h('option', { value: n, selected: n === eng.name ? true : null }, `${n} (${lib.byEngine[n].length})`))),
      h('select', { 'aria-label': 'Sound', onchange: (e) => go(list[+e.target.value]) },
        list.map((s, i) => h('option', { value: i, selected: i === at ? true : null }, s.name))),
      h('div', { class: 'row' },
        h('button', { class: 'add', title: 'Back to the sound as it was loaded', onclick: () => app.setSound(t.id, {}, true) }, 'RESET SOUND')));
    const engMod = h('div', { class: 'module' }, h('h4', {}, eng.name, h('em', { text: 'ENGINE' })),
      h('div', { class: 'knobs', '--cols': 4 }, eng.edit.map((d, i) => mk(e0 + i, d))));
    const nice = (id) => (t.bank === 'clipper' && NICE_CLIPPER[id]) || NICE[id];
    const groups = GROUPS[t.bank].map((g) => h('div', { class: 'module' }, h('h4', { text: g.title }),
      h('div', { class: 'knobs', '--cols': g.cols }, g.ids.filter((id) => cat.tp[id]).map((id) => mk(id, cat.tp[id], nice(id))))));
    this.wrap.replaceChildren(sound, engMod, ...groups, ...synthExtras(this, t));
  }
  buildAudio(t) {
    const app = this.app, input = app.audio.input;
    const files = t.clips.map((c) => app.assets.get(c.src)?.name).filter(Boolean);
    this.wrap.replaceChildren(
      h('div', { class: 'module sound-lcd' }, h('h4', {}, 'AUDIO', h('em', { text: 'TRACK' })),
        h('div', { class: 'screen' }, h('span', { class: 'eng', text: input ? 'INPUT ON' : 'INPUT OFF' }),
          h('span', { class: 'pre', text: input ? (app.audio.inputName || 'INPUT').toUpperCase().slice(0, 28) : 'NO INPUT' })),
        h('div', { class: 'row' },
          h('button', { class: 'add', onclick: () => app.pickAudio({ trackId: t.id, beat: Math.floor(app.pos) }) }, 'IMPORT FILE'),
          h('button', { class: 'add', onclick: async () => { try { await app.audio.enableInput(); this.refresh(true); app.toast('Input on. Arm the track (●) and press R to record.'); } catch (err) { app.toast(`No input: ${err.message}`); } } }, input ? 'INPUT READY' : 'ENABLE INPUT'))),
      h('div', { class: 'module', style: { maxWidth: '360px' } }, h('h4', { text: 'HOW IT WORKS' }),
        h('p', { style: { margin: 0, font: '500 11px/1.5 var(--f-ui)', color: 'var(--dim)' },
          text: 'Drop audio files on the arrangement, or import one at the playhead. To record: enable the input, arm this track (●), then R. Each pass of the loop is one take, placed where you played it (latency compensated).' }),
        files.length ? h('p', { style: { margin: 0, font: '500 10px/1.5 var(--f-mono)', color: 'var(--text)' }, text: [...new Set(files)].join(' · ') }) : null));
  }
  buildDrums(t) {
    const app = this.app, lib = app.lib.sloop;
    const kits = lib.kits.map((n, i) => [n, i]).filter(([n]) => !/^USR|^SYN/.test(n));
    const step = (d) => {
      const i = kits.findIndex(([, k]) => k === t.kit);
      app.setKit(t.id, kits[(i + d + kits.length) % kits.length][1]);
    };
    const pads = lib.lanes.map((name, l) => {
      const n = lib.laneNotes[l];
      const pad = h('button', { class: 'pad', text: name, 'aria-label': `Play ${name}` });
      pad.addEventListener('pointerdown', (e) => { e.preventDefault(); app.noteOn(t.id, n, e.shiftKey ? 127 : 100); pad.classList.add('hit'); setTimeout(() => pad.classList.remove('hit'), 120); });
      return pad;
    });
    this.wrap.replaceChildren(
      h('div', { class: 'module sound-lcd' }, h('h4', {}, 'KIT', h('em', { text: 'SLOOP' })),
        h('div', { class: 'screen' }, h('span', { class: 'eng', text: `DRUMS · ${kits.findIndex(([, k]) => k === t.kit) + 1}/${kits.length}` }), h('span', { class: 'pre', text: lib.kits[t.kit] })),
        h('div', { class: 'row' }, h('button', { class: 'add', onclick: () => step(-1) }, '◀ PREV'), h('button', { class: 'add', onclick: () => step(1) }, 'NEXT ▶')),
        h('select', { 'aria-label': 'Kit', onchange: (e) => app.setKit(t.id, +e.target.value) }, kits.map(([n, i]) => h('option', { value: i, selected: i === t.kit ? true : null }, n)))),
      h('div', { class: 'module' }, h('h4', {}, 'PADS', h('em', { text: 'SHIFT = ACCENT' })), h('div', { class: 'pads' }, pads)), freezeModule(this, t));
  }
}
