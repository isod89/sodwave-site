// SPDX-License-Identifier: GPL-3.0-only
// LAB, the editor: build an instrument or an effect from modules and cables, on a canvas you pan and zoom.
// Drag a module from the left (or double-click the canvas), drag from an output dot to an input dot to connect, click
// a cable for its amount, click a module to see everything about it on the right (its help, every knob, what each of
// its outputs does on a test note). Below: the eight MACROS (the knobs you automate and map), the voices and the
// effects after them. Every change is a project change: Ctrl+Z takes it back, it plays at once.
import { h, knob } from './kit.js';
import { MODULES, CATS, FX_TYPES, newModule, newPatch, validatePatch, LAB_VERSION } from '../lab-modules.js';
import { probe, formulaError } from '../lab-dsp.js';
import { LAB_FACTORY } from '../lab-presets.js';
import { DEVICES, defaults, fmtParam, toNorm, fromNorm } from '../fx.js';
import { listPresets, addPreset, removePreset } from '../presets.js';
import { saveFile } from '../io.js';
import { freezeModule } from './instruments.js';

const KIND_COLOR = { audio: '#4cb3ff', mod: '#ff9f3a', gate: '#3ddc84', pitch: '#c287ff' };
const CAT_COLOR = { io: '#9aa3ad', src: '#4cb3ff', flt: '#ff6b6b', mod: '#ff9f3a', util: '#3ddc84', fx: '#c287ff' };
const W = 196;                                            // a module's width on the canvas
const phone = () => matchMedia('(max-width: 760px)').matches;

// ------------------------------------------------------------------ where the patch lives
// target: { track } (an instrument) · { track, fx } (an effect of a track) · { bus: 'master' | 'ret<i>', fx }
function resolve(app, target) {
  const p = app.store.p;
  const rack = (pp) => (target.bus === 'master' ? pp.master.fx : target.bus ? pp.returns[+target.bus.slice(3)]?.fx : pp.tracks.find((x) => x.id === target.track)?.fx);
  if (target.fx) {
    const dev = () => rack(app.store.p)?.find((d) => d.id === target.fx);
    return {
      kind: 'fx', get: () => dev()?.lab, dev,
      edit: (fn, tag) => app.store.change((pp) => { const d = rack(pp)?.find((x) => x.id === target.fx); if (d) { d.lab ||= newPatch('fx'); fn(d.lab, d); } }, tag),
      macro: (i) => dev()?.p?.[`m${i}`] ?? 0.5,
      setMacro: (i, v, tag) => app.store.change((pp) => { const d = rack(pp)?.find((x) => x.id === target.fx); if (d) { d.p[`m${i}`] = v; if (d.lab?.macros?.[i]) d.lab.macros[i].v = v; } }, tag),
      owner: () => (target.bus ? (target.bus === 'master' ? 'MASTER' : p.returns[+target.bus.slice(3)]?.name) : app.store.track(target.track)?.name) || '',
    };
  }
  const tr = () => app.store.track(target.track);
  return {
    kind: 'inst', get: () => tr()?.lab, track: tr,
    edit: (fn, tag) => app.store.change((pp) => { const t = pp.tracks.find((x) => x.id === target.track); if (t?.lab) fn(t.lab, t); }, tag),
    macro: (i) => { const t = tr(); return t?.params?.[i] != null ? t.params[i] / 127 : (t?.lab?.macros?.[i]?.v ?? 0.5); },
    setMacro: (i, v, tag) => {
      app.audio.send({ t: 'param', track: target.track, id: i, v: Math.round(v * 127) });
      app.store.change((pp) => { const t = pp.tracks.find((x) => x.id === target.track); if (t) { t.params[i] = Math.round(v * 127); if (t.lab?.macros?.[i]) t.lab.macros[i].v = v; } }, tag);
    },
    owner: () => tr()?.name || '',
  };
}

// ------------------------------------------------------------------ the editor
let open = null;
export function openLab(app, target) {
  open?.close();
  const r = resolve(app, target);
  if (!r.get()) {                                          // an effect without a patch yet: start one
    if (r.kind === 'fx') r.edit(() => {}, null); else return;
  }
  open = new LabEditor(app, target, r);
  return open;
}
export const labOpen = () => open;

class LabEditor {
  constructor(app, target, r) {
    this.app = app; this.target = target; this.r = r;
    this.view = { x: 40, y: 30, z: 1 };
    this.sel = null;                                       // { mod: id } | { cable: index }
    this.knobs = new Map();
    this.root = h('div', { class: 'lab-ed', tabindex: -1, role: 'dialog', 'aria-label': 'LAB editor' });
    this.build();
    document.body.append(this.root);
    this.root.focus();
    this.off = app.store.on(() => this.sync());
    this.onKey = (e) => this.key(e);
    window.addEventListener('keydown', this.onKey, true);
    this.lastShape = '';
    this.render(true);
    requestAnimationFrame(() => this.fit());
  }
  get patch() { return this.r.get(); }
  close() {
    this.off?.(); window.removeEventListener('keydown', this.onKey, true);
    this.root.remove(); if (open === this) open = null;
    this.app.store.endGesture();
    this.app.device?.refresh(true);
  }
  edit(fn, tag = null) { this.r.edit(fn, tag); }

  // ---- the frame
  build() {
    const app = this.app, p = this.patch, isFx = this.r.kind === 'fx';
    const name = h('input', { class: 'lab-name', value: p.name, maxlength: 60, 'aria-label': 'Patch name', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); },
      onchange: (e) => this.edit((q) => { q.name = e.target.value.trim().slice(0, 60) || 'Untitled'; }) });
    this.nameEl = name;
    const btn = (text, title, onclick, cls = 'add') => h('button', { class: cls, title, onclick }, text);
    this.top = h('div', { class: 'lab-top' },
      h('b', { class: 'lab-logo', text: 'LAB' }), h('span', { class: 'lab-kind', text: isFx ? `EFFECT · ${this.r.owner()}` : `INSTRUMENT · ${this.r.owner()}` }), name,
      h('span', { class: 'lab-sp' }),
      phone() ? btn('+ MODULE', 'Add a module', () => this.paletteSheet()) : null,
      btn('PATCHES ▾', 'Factory patches and yours: start from one', () => this.patchSheet()),
      btn('SAVE', 'Keep this patch in MY PATCHES (this browser)', () => this.savePatch()),
      btn('FILE ▾', 'Export the patch to a file, or import one', () => this.fileSheet()),
      app.hub?.publishLab ? btn('☁ PUBLISH', 'Share it on the Kraken hub', () => app.hub.publishLab(validatePatch(this.patch, this.r.kind), this.patch.name)) : null,
      btn('FIT', 'Show the whole patch', () => this.fit()),
      btn('?', 'How LAB works', () => this.guide()),
      btn('CLOSE', 'Back to Kraken (Esc)', () => this.close(), 'add go'));
    this.pal = h('div', { class: 'lab-pal' });
    this.buildPalette(this.pal);
    this.cables = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.cables.setAttribute('class', 'lab-cables');
    this.world = h('div', { class: 'lab-world' }, this.cables);
    this.viewEl = h('div', { class: 'lab-view', 'aria-label': 'Patch canvas: drag the background to move, wheel or pinch to zoom, double-click to add a module' }, this.world,
      h('div', { class: 'lab-zoom' }, btn('−', 'Zoom out', () => this.zoomBy(1 / 1.2), 'tb'), btn('+', 'Zoom in', () => this.zoomBy(1.2), 'tb')),
      h('div', { class: 'lab-count' }));
    this.insp = h('div', { class: 'lab-insp' });
    this.bottom = h('div', { class: 'lab-bottom' });
    this.root.replaceChildren(this.top, h('div', { class: 'lab-main' }, this.pal, this.viewEl, this.insp), this.bottom);
    this.bindCanvas();
  }
  buildPalette(box, onPick = null) {
    const search = h('input', { class: 'lab-search', placeholder: 'Find a module…', 'aria-label': 'Find a module', onkeydown: (e) => e.stopPropagation(), oninput: () => fill() });
    const list = h('div', { class: 'lab-pal-list' });
    const kind = this.r.kind;
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...CATS.flatMap(([c, label]) => {
        const items = Object.entries(MODULES).filter(([t, d]) => d.cat === c && (!d.only || d.only === kind) && (!q || d.name.toLowerCase().includes(q) || d.help.toLowerCase().includes(q)));
        if (!items.length) return [];
        return [h('h6', { text: label, style: { color: CAT_COLOR[c] } }), ...items.map(([t, d]) => {
          const b = h('button', { class: 'lab-pal-item', draggable: 'true', title: d.help, onclick: () => (onPick ? onPick(t) : this.addModule(t)) }, h('b', { text: d.name }), h('span', { text: d.help.split(/[.:]/)[0] }));
          b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-kraken-lab', t); e.dataTransfer.effectAllowed = 'copy'; });
          return b;
        })];
      }));
    };
    fill();
    box.replaceChildren(search, list);
    return search;
  }

  // ---- drawing the patch
  shapeKey() { const p = this.patch; return JSON.stringify([p.mods.map((m) => [m.id, m.type, m.x, m.y, m.text, m.type === 'fx' ? m.p.dev : 0, m.type === 'steps' ? m.p.len : 0]), p.cables.map((c) => [c.from, c.to, c.amt]), this.sel, p.kind]); }
  sync() {
    if (!this.patch) { this.close(); return; }
    if (this.dragging) return;
    const key = this.shapeKey();
    if (key !== this.lastShape) this.render();
    else this.updateKnobs();
    if (this.nameEl !== document.activeElement && this.nameEl.value !== this.patch.name) this.nameEl.value = this.patch.name;
    this.renderBottom();
  }
  render(first = false) {
    const p = this.patch;
    this.lastShape = this.shapeKey();
    this.knobs.clear();
    const els = p.mods.map((m) => this.moduleEl(m));
    this.world.replaceChildren(this.cables, ...els);
    this.modEls = new Map(els.map((e) => [e.dataset.id, e]));
    this.applyView();
    requestAnimationFrame(() => this.drawCables());
    this.viewEl.querySelector('.lab-count').textContent = `${p.mods.length} modules · ${p.cables.length} cables`;
    this.renderInspector();
    if (first) this.renderBottom();
  }
  moduleEl(m) {
    const d = MODULES[m.type], sel = this.sel?.mod === m.id;
    const ins = d.ins.map((q) => h('div', { class: 'lab-port in', title: `${q.l} · ${KIND_LABEL[q.kind]}${q.range !== 1 ? ` · up to ${q.range}${q.unit ? ' ' + q.unit : ''}` : ''}` },
      h('i', { class: 'dot', 'data-port': `${m.id}.in.${q.k}`, style: { background: KIND_COLOR[q.kind] } }), h('span', { text: q.l })));
    const outs = d.outs.map((q) => h('div', { class: 'lab-port out', title: `${q.l} · ${KIND_LABEL[q.kind]}` }, h('span', { text: q.l }),
      h('i', { class: 'dot', 'data-port': `${m.id}.out.${q.k}`, style: { background: KIND_COLOR[q.kind] } })));
    const head = h('h5', { style: { '--c': CAT_COLOR[d.cat] } }, h('span', { text: m.type === 'macro' ? `MACRO ${m.p.n + 1} · ${this.patch.macros[m.p.n]?.name || ''}` : m.type === 'fx' ? `EFFECT · ${DEVICES[FX_TYPES[m.p.dev]]?.name || ''}` : d.name }),
      h('button', { class: 'lab-x', title: 'Remove (Delete)', 'aria-label': `Remove ${d.name}`, onclick: (e) => { e.stopPropagation(); this.removeModule(m.id); } }, '×'));
    const body = [];
    if (m.type === 'steps') body.push(this.stepsEl(m, 'small'));
    if (m.type === 'expr') body.push(this.formulaEl(m, true));
    const knobs = this.paramEls(m, d.params.filter((q) => !/^s\d+$/.test(q.k)), 28, 'm');
    const el = h('div', { class: 'lab-mod' + (sel ? ' sel' : ''), 'data-id': m.id, style: { left: `${m.x}px`, top: `${m.y}px`, width: `${W}px` } },
      head, h('div', { class: 'lab-ports' }, h('div', {}, ins), h('div', {}, outs)), knobs.length ? h('div', { class: 'lab-knobs' }, knobs) : null, ...body);
    el.addEventListener('pointerdown', (e) => { if (e.target.closest('.dot, .knob, select, textarea, input, button, canvas')) return; this.select({ mod: m.id }); });
    head.addEventListener('pointerdown', (e) => this.dragModule(e, m));
    return el;
  }
  // a module's knobs (names: a menu); where: 'm' on the canvas, 'i' in the inspector
  paramEls(m, params, size, where) {
    const color = CAT_COLOR[MODULES[m.type].cat];
    return params.map((q) => {
      const key = `${where}:${m.id}:${q.k}`;
      if (q.names && q.k !== 'n') {
        const s = h('select', { class: 'lab-sel', 'aria-label': q.l, title: q.l, onchange: (e) => this.edit((pp) => { const x = pp.mods.find((y) => y.id === m.id); if (x) x.p[q.k] = +e.target.value; }) },
          q.names.map((n, i) => (i < q.min ? null : h('option', { value: i, selected: Math.round(m.p[q.k]) === i ? true : null }, n))));
        this.knobs.set(key, { set: (v) => { if (document.activeElement !== s) s.value = String(Math.round(v)); } });
        return h('label', { class: 'lab-sel-w' }, h('span', { text: q.l }), s);
      }
      if (q.k === 'n') {                                   // MACRO: which of the eight
        const s = h('select', { class: 'lab-sel', 'aria-label': 'Macro', onchange: (e) => this.edit((pp) => { const x = pp.mods.find((y) => y.id === m.id); if (x) x.p.n = +e.target.value; }) },
          this.patch.macros.map((mc, i) => h('option', { value: i, selected: m.p.n === i ? true : null }, `${i + 1} · ${mc.name}`)));
        return h('label', { class: 'lab-sel-w wide' }, h('span', { text: 'KNOB' }), s);
      }
      const spec = { ...q, k: q.k === 'pa' ? 'pa_' : q.k };          // (fmtParam formats a 'pa' knob as a pan)
      const k = knob({ label: q.l, min: 0, max: 1000, size, value: Math.round(toNorm(q, m.p[q.k]) * 1000), def: Math.round(toNorm(q, q.def) * 1000), color,
        format: (v) => fmtParam(spec, fromNorm(q, v / 1000)),
        onChange: (v) => this.edit((pp) => { const x = pp.mods.find((y) => y.id === m.id); if (x) x.p[q.k] = fromNorm(q, v / 1000); }, `lab${m.id}${q.k}`),
        onEnd: () => { this.app.store.endGesture(); this.probeSoon(); } });
      this.knobs.set(key, { set: (v) => k.setValue(Math.round(toNorm(q, v) * 1000)) });
      return k;
    });
  }
  updateKnobs() {
    for (const m of this.patch.mods) for (const q of MODULES[m.type].params) for (const w of ['m', 'i']) this.knobs.get(`${w}:${m.id}:${q.k}`)?.set(m.p[q.k]);
    if (this.sel?.mod) this.probeSoon();
  }
  stepsEl(m, size) {
    const cv = h('canvas', { class: 'lab-steps ' + size, width: size === 'small' ? 360 : 520, height: size === 'small' ? 90 : 140, title: 'Draw the steps: click or drag (from -1 at the bottom to 1 at the top)' });
    const draw = () => {
      const x = cv.getContext('2d'), n = Math.round(m.p.len), w = cv.width / 16, H = cv.height;
      x.clearRect(0, 0, cv.width, H);
      x.fillStyle = '#ffffff10'; x.fillRect(0, H / 2, cv.width, 1);
      for (let i = 0; i < 16; i++) {
        const v = m.p[`s${i}`], y = H / 2 - v * (H / 2 - 4);
        x.fillStyle = i < n ? CAT_COLOR.mod : '#ffffff22';
        x.fillRect(i * w + 2, Math.min(y, H / 2), w - 4, Math.max(2, Math.abs(H / 2 - y)));
      }
    };
    draw();
    const at = (e) => { const r = cv.getBoundingClientRect(); return { i: Math.max(0, Math.min(15, Math.floor((e.clientX - r.left) / r.width * 16))), v: Math.max(-1, Math.min(1, 1 - 2 * (e.clientY - r.top) / r.height)) }; };
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); cv.setPointerCapture(e.pointerId);
      const set = (ev) => { const { i, v } = at(ev); m.p[`s${i}`] = Math.round(v * 100) / 100; draw(); this.edit((pp) => { const x = pp.mods.find((y) => y.id === m.id); if (x) x.p[`s${i}`] = Math.round(v * 100) / 100; }, `labsteps${m.id}`); };
      set(e);
      const mv = (ev) => set(ev), up = () => { cv.removeEventListener('pointermove', mv); this.app.store.endGesture(); };
      cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up, { once: true });
    });
    return cv;
  }
  formulaEl(m, small) {
    const err = h('div', { class: 'lab-err' });
    const show = (t) => { const e = formulaError(t); err.textContent = e ? `⚠ ${e}` : '✓'; err.classList.toggle('bad', !!e); };
    const ta = h('textarea', { class: 'lab-formula' + (small ? ' small' : ''), rows: small ? 2 : 4, spellcheck: 'false', 'aria-label': 'Formula', value: m.text || '',
      onkeydown: (e) => e.stopPropagation(), oninput: (e) => show(e.target.value),
      onchange: (e) => this.edit((pp) => { const x = pp.mods.find((y) => y.id === m.id); if (x) x.text = e.target.value.slice(0, 200); }) });
    ta.value = m.text || '';
    show(ta.value);
    return h('div', { class: 'lab-fwrap' }, ta, err);
  }
  // ---- cables
  portXY(key) {
    const dot = this.world.querySelector(`[data-port="${CSS.escape(key)}"]`);
    if (!dot) return null;
    const r = dot.getBoundingClientRect(), w = this.world.getBoundingClientRect(), z = this.view.z;
    return { x: (r.left + r.width / 2 - w.left) / z, y: (r.top + r.height / 2 - w.top) / z };
  }
  drawCables() {
    const p = this.patch, svg = this.cables, NS = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    p.cables.forEach((c, i) => {
      const a = this.portXY(`${c.from[0]}.out.${c.from[1]}`), b = this.portXY(`${c.to[0]}.in.${c.to[1]}`);
      if (!a || !b) return;
      const kind = MODULES[p.mods.find((m) => m.id === c.from[0])?.type]?.outs.find((o) => o.k === c.from[1])?.kind || 'audio';
      const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5), d = `M${a.x} ${a.y}C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
      const sel = this.sel?.cable === i;
      const hit = document.createElementNS(NS, 'path'); hit.setAttribute('d', d); hit.setAttribute('class', 'hit');
      hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.select({ cable: i }); });
      const line = document.createElementNS(NS, 'path'); line.setAttribute('d', d); line.setAttribute('class', 'wire' + (sel ? ' sel' : ''));
      line.setAttribute('stroke', KIND_COLOR[kind]); line.setAttribute('stroke-opacity', String(0.35 + 0.65 * Math.min(1, Math.abs(c.amt))));
      if (c.amt < 0) line.setAttribute('stroke-dasharray', '6 4');
      svg.append(hit, line);
      if (c.amt !== 1 || sel) {                           // the amount, at the middle of the cable
        const t = document.createElementNS(NS, 'text'); t.setAttribute('x', String((a.x + b.x) / 2)); t.setAttribute('y', String((a.y + b.y) / 2 - 6));
        t.setAttribute('class', 'amt'); t.textContent = `${Math.round(c.amt * 100)}%`; svg.append(t);
      }
    });
  }
  connect(from, to) {
    this.edit((pp) => {
      if (pp.cables.some((c) => c.from[0] === from[0] && c.from[1] === from[1] && c.to[0] === to[0] && c.to[1] === to[1])) return;
      const kind = MODULES[pp.mods.find((m) => m.id === to[0])?.type]?.ins.find((x) => x.k === to[1])?.kind;
      pp.cables.push({ from, to, amt: kind === 'mod' ? 0.5 : 1 });
    });
  }
  // ---- the canvas: pan, zoom, drag modules, draw cables, drop modules
  applyView() { const v = this.view; this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`; this.viewEl.style.backgroundPosition = `${v.x}px ${v.y}px`; this.viewEl.style.backgroundSize = `${20 * v.z}px ${20 * v.z}px`; }
  zoomBy(f, cx = null, cy = null) {
    const r = this.viewEl.getBoundingClientRect(), v = this.view;
    cx ??= r.width / 2; cy ??= r.height / 2;
    const z = Math.max(0.3, Math.min(2, v.z * f)), k = z / v.z;
    v.x = cx - (cx - v.x) * k; v.y = cy - (cy - v.y) * k; v.z = z;
    this.applyView();
  }
  fit() {
    const p = this.patch, r = this.viewEl.getBoundingClientRect();
    if (!p.mods.length || !r.width) return;
    const x0 = Math.min(...p.mods.map((m) => m.x)), y0 = Math.min(...p.mods.map((m) => m.y));
    const x1 = Math.max(...p.mods.map((m) => m.x + W)), y1 = Math.max(...p.mods.map((m) => m.y + (this.modEls?.get(m.id)?.offsetHeight || 200)));
    const z = Math.max(0.3, Math.min(1.1, Math.min((r.width - 40) / (x1 - x0), (r.height - 40) / (y1 - y0))));
    this.view = { z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z };
    this.applyView();
  }
  toWorld(cx, cy) { const r = this.viewEl.getBoundingClientRect(), v = this.view; return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z }; }
  bindCanvas() {
    const el = this.viewEl;
    const pointers = new Map();
    el.addEventListener('pointerdown', (e) => {
      const dot = e.target.closest('.dot');
      if (dot) { this.dragCable(e, dot.dataset.port); return; }
      if (e.target.closest('.lab-mod, .lab-zoom, .lab-amount')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      if (pointers.size === 1) { this.select(null); this.panStart = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y }; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.view.z }; }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && this.pinch) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), r = el.getBoundingClientRect();
        this.zoomBy(this.pinch.z * d / this.pinch.d / this.view.z, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      } else if (this.panStart) { this.view.x = this.panStart.vx + e.clientX - this.panStart.x; this.view.y = this.panStart.vy + e.clientY - this.panStart.y; this.applyView(); }
    });
    const end = (e) => { pointers.delete(e.pointerId); if (!pointers.size) { this.panStart = null; this.pinch = null; } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || !e.deltaX && Math.abs(e.deltaY) > 40 && !e.shiftKey) this.zoomBy(Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
      else { this.view.x -= e.shiftKey ? e.deltaY : e.deltaX; this.view.y -= e.shiftKey ? 0 : e.deltaY; this.applyView(); }
    }, { passive: false });
    el.addEventListener('dblclick', (e) => { if (e.target.closest('.lab-mod')) return; const w = this.toWorld(e.clientX, e.clientY); this.quickAdd(e.clientX, e.clientY, (t) => this.addModule(t, w.x, w.y)); });
    el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('application/x-kraken-lab')) e.preventDefault(); });
    el.addEventListener('drop', (e) => { const t = e.dataTransfer.getData('application/x-kraken-lab'); if (!t) return; e.preventDefault(); const w = this.toWorld(e.clientX, e.clientY); this.addModule(t, w.x - W / 2, w.y - 14); });
  }
  dragModule(e, m) {
    if (e.target.closest('button')) return;
    e.preventDefault(); e.stopPropagation();
    this.select({ mod: m.id });
    const el = this.modEls.get(m.id), x0 = m.x, y0 = m.y, sx = e.clientX, sy = e.clientY;
    let x = x0, y = y0;
    this.dragging = true;
    const mv = (ev) => {
      x = Math.round((x0 + (ev.clientX - sx) / this.view.z) / 10) * 10; y = Math.round((y0 + (ev.clientY - sy) / this.view.z) / 10) * 10;
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      this.drawCables();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      this.dragging = false;
      if (x !== x0 || y !== y0) this.edit((pp) => { const q = pp.mods.find((z) => z.id === m.id); if (q) { q.x = x; q.y = y; } }); else this.sync();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  dragCable(e, key) {
    e.preventDefault(); e.stopPropagation();
    const [id, dir, port] = key.split('.'), start = this.portXY(key), NS = 'http://www.w3.org/2000/svg';
    const tmp = document.createElementNS(NS, 'path'); tmp.setAttribute('class', 'wire tmp'); this.cables.append(tmp);
    // an input already plugged: dragging from it takes its cable away (to move it elsewhere)
    let from = dir === 'out' ? [id, port] : null, to = dir === 'in' ? [id, port] : null;
    if (to) {
      const c = this.patch.cables.find((x) => x.to[0] === id && x.to[1] === port);
      if (c) { from = [...c.from]; to = null; this.edit((pp) => { pp.cables = pp.cables.filter((x) => !(x.to[0] === id && x.to[1] === port && x.from[0] === c.from[0] && x.from[1] === c.from[1])); }); }
    }
    const anchor = from ? this.portXY(`${from[0]}.out.${from[1]}`) || start : start;
    this.world.classList.add(from ? 'want-in' : 'want-out');
    this.dragging = true;
    const mv = (ev) => {
      const w = this.toWorld(ev.clientX, ev.clientY), a = from ? anchor : w, b = from ? w : anchor, dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
      tmp.setAttribute('d', `M${a.x} ${a.y}C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      this.dragging = false; tmp.remove(); this.world.classList.remove('want-in', 'want-out');
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.dot');
      if (hit) {
        const [hid, hdir, hport] = hit.dataset.port.split('.');
        if (from && hdir === 'in') { this.connect(from, [hid, hport]); return; }
        if (to && hdir === 'out') { this.connect([hid, hport], to); return; }
        this.sync(); return;
      }
      if (ev.target.closest?.('.lab-view') || this.viewEl.contains(document.elementFromPoint(ev.clientX, ev.clientY))) {
        // let go on the canvas: a module to plug it into, there
        const w = this.toWorld(ev.clientX, ev.clientY);
        this.quickAdd(ev.clientX, ev.clientY, (t) => {
          const d = MODULES[t];
          if (from) { const inp = d.ins.find((x) => x.kind === this.kindOf(from, 'out')) || d.ins[0]; this.addModule(t, w.x, w.y - 30, (nid) => inp && this.connect(from, [nid, inp.k])); }
          else { const out = d.outs.find((x) => x.kind === this.kindOf(to, 'in')) || d.outs[0]; this.addModule(t, w.x - W, w.y - 30, (nid) => out && this.connect([nid, out.k], to)); }
        }, from ? 'ins' : 'outs');
        return;
      }
      this.sync();
    };
    mv(e);
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  kindOf([id, k], dir) { const m = this.patch.mods.find((x) => x.id === id); return MODULES[m?.type]?.[dir === 'out' ? 'outs' : 'ins'].find((x) => x.k === k)?.kind; }
  // a little searchable menu of modules at a point (need: only those with inputs / outputs)
  quickAdd(cx, cy, pick, need = null) {
    document.querySelector('.lab-quick')?.remove();
    const kind = this.r.kind;
    const box = h('div', { class: 'lab-quick', style: { left: `${Math.min(cx, innerWidth - 240)}px`, top: `${Math.min(cy, innerHeight - 320)}px` } });
    const list = h('div', { class: 'lab-quick-list' });
    const search = h('input', { placeholder: 'Add a module…', 'aria-label': 'Add a module', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Escape') box.remove(); if (e.key === 'Enter') list.querySelector('button')?.click(); }, oninput: () => fill() });
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...Object.entries(MODULES).filter(([, d]) => (!d.only || d.only === kind) && (!need || d[need].length) && (!q || d.name.toLowerCase().includes(q) || d.help.toLowerCase().includes(q)))
        .map(([t, d]) => h('button', { title: d.help, onclick: () => { box.remove(); pick(t); } }, h('i', { style: { background: CAT_COLOR[d.cat] } }), d.name)));
    };
    fill();
    box.append(search, list);
    document.body.append(box);
    search.focus();
    const away = (e) => { if (!box.contains(e.target)) { box.remove(); window.removeEventListener('pointerdown', away, true); } };
    setTimeout(() => window.addEventListener('pointerdown', away, true), 0);
  }
  // ---- editing
  addModule(type, x = null, y = null, then = null) {
    const d = MODULES[type];
    if (!d || this.patch.mods.length >= 64) { this.app.toast('A patch holds 64 modules at most.'); return; }
    if (x == null) { const r = this.viewEl.getBoundingClientRect(), w = this.toWorld(r.left + r.width / 2, r.top + r.height / 3); x = w.x - W / 2 + (Math.random() * 40 - 20); y = w.y + (Math.random() * 40 - 20); }
    const m = newModule(type, Math.round(x / 10) * 10, Math.round(y / 10) * 10);
    if (type === 'macro') { const used = new Set(this.patch.mods.filter((q) => q.type === 'macro').map((q) => q.p.n)); m.p.n = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => !used.has(i)) ?? 0; }
    this.edit((pp) => { pp.mods.push(m); });
    this.select({ mod: m.id });
    then?.(m.id);
  }
  removeModule(id) {
    this.edit((pp) => { pp.mods = pp.mods.filter((m) => m.id !== id); pp.cables = pp.cables.filter((c) => c.from[0] !== id && c.to[0] !== id); });
    if (this.sel?.mod === id) this.select(null);
  }
  duplicate(id) {
    const m = this.patch.mods.find((x) => x.id === id);
    if (!m) return;
    const c = { ...structuredClone(m), id: newModule(m.type).id, x: m.x + 30, y: m.y + 30 };
    this.edit((pp) => { pp.mods.push(c); });
    this.select({ mod: c.id });
  }
  select(s) { this.sel = s; this.sync(); }
  key(e) {
    if (!this.root.isConnected || document.querySelector('.modal-bg')) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (tag === 'SELECT' && e.key !== 'Escape')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (document.querySelector('.lab-quick')) document.querySelector('.lab-quick').remove(); else if (this.sel) this.select(null); else this.close(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.sel.mod) this.removeModule(this.sel.mod);
      else if (this.sel.cable != null) { const i = this.sel.cable; this.sel = null; this.edit((pp) => { pp.cables.splice(i, 1); }); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); return; }   // (never the song's clips from here)
    if (mod && e.key.toLowerCase() === 'd' && this.sel?.mod) { e.preventDefault(); e.stopImmediatePropagation(); this.duplicate(this.sel.mod); return; }
    if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'v' || e.key.toLowerCase() === 'a' || e.key.toLowerCase() === 'e' || e.key.toLowerCase() === 'j')) { e.stopImmediatePropagation(); }
  }

  // ---- the inspector: the selected module (or cable), all about it
  renderInspector() {
    const box = this.insp, p = this.patch;
    if (this.sel?.cable != null) {
      const c = p.cables[this.sel.cable];
      if (!c) { box.replaceChildren(); return; }
      const nm = (id, k, dir) => { const m = p.mods.find((x) => x.id === id); const d = MODULES[m?.type]; return `${d?.name || id} · ${d?.[dir].find((x) => x.k === k)?.l || k}`; };
      const inSpec = MODULES[p.mods.find((x) => x.id === c.to[0])?.type]?.ins.find((x) => x.k === c.to[1]);
      const k = knob({ label: 'AMOUNT', min: -100, max: 100, value: Math.round(c.amt * 100), def: 100, size: 46, color: KIND_COLOR[inSpec?.kind || 'audio'], format: (v) => `${v}%`,
        onChange: (v) => { const i = this.sel.cable; this.edit((pp) => { if (pp.cables[i]) pp.cables[i].amt = v / 100; }, `labamt${i}`); }, onEnd: () => this.app.store.endGesture() });
      box.replaceChildren(h('h4', { text: 'CABLE' }), h('p', { class: 'lab-help', text: `${nm(c.from[0], c.from[1], 'outs')} → ${nm(c.to[0], c.to[1], 'ins')}` }),
        h('div', { class: 'lab-knobs big' }, k),
        h('p', { class: 'lab-help', text: inSpec && inSpec.range !== 1 ? `At 100 %, a full signal moves ${inSpec.l} by ${inSpec.range}${inSpec.unit ? ' ' + inSpec.unit : ''}. Negative amounts turn it upside down.` : 'How much of the signal goes through; a negative amount turns it upside down.' }),
        h('button', { class: 'add danger', onclick: () => { const i = this.sel.cable; this.sel = null; this.edit((pp) => { pp.cables.splice(i, 1); }); } }, 'REMOVE THE CABLE'));
      return;
    }
    const m = this.sel?.mod && p.mods.find((x) => x.id === this.sel.mod);
    if (!m) {
      box.replaceChildren(h('h4', { text: this.r.kind === 'fx' ? 'YOUR EFFECT' : 'YOUR INSTRUMENT' }),
        h('p', { class: 'lab-help', text: 'Click a module to see what it does and all its knobs. Drag from an output dot (right) to an input dot (left) to connect; let go on empty canvas to add a module already connected. Click a cable to set how much goes through.' }),
        h('div', { class: 'lab-legend' }, Object.entries(KIND_LABEL).map(([k, l]) => h('span', {}, h('i', { style: { background: KIND_COLOR[k] } }), l))),
        this.r.kind === 'inst' ? h('p', { class: 'lab-help', text: 'Play it with your keyboard (A W S E D…), a MIDI keyboard, or the keys below. Each note plays the whole patch as a voice.' })
          : h('p', { class: 'lab-help', text: 'Play the song: the track\'s sound goes through AUDIO IN and comes out of OUTPUT.' }));
      return;
    }
    const d = MODULES[m.type];
    const extra = [];
    if (m.type === 'steps') extra.push(this.stepsEl(m, 'big'));
    if (m.type === 'expr') extra.push(this.formulaEl(m, false));
    if (m.type === 'fx') {
      const type = FX_TYPES[m.p.dev], spec = DEVICES[type];
      extra.push(h('h6', { text: spec.name }), h('div', { class: 'lab-knobs' }, spec.params.filter((q) => q.k !== 'sc').map((q) => knob({ label: q.l, min: 0, max: 1000, size: 34,
        value: Math.round(toNorm(q, m.fx?.p?.[q.k] ?? q.def) * 1000), def: Math.round(toNorm(q, q.def) * 1000), color: CAT_COLOR.fx, format: (v) => fmtParam(q, fromNorm(q, v / 1000)),
        onChange: (v) => this.edit((pp) => { const x = pp.mods.find((y) => y.id === m.id); if (x) { x.fx ||= { p: {} }; x.fx.p[q.k] = fromNorm(q, v / 1000); } }, `labfx${m.id}${q.k}`), onEnd: () => this.app.store.endGesture() }))));
    }
    this.scopes = h('div', { class: 'lab-scopes' });
    box.replaceChildren(h('h4', {}, h('span', { text: d.name }), h('em', { text: CATS.find(([c]) => c === d.cat)[1] })),
      h('p', { class: 'lab-help', text: d.help }),
      d.params.filter((q) => !/^s\d+$/.test(q.k)).length ? h('div', { class: 'lab-knobs big' }, this.paramEls(m, d.params.filter((q) => !/^s\d+$/.test(q.k)), 40, 'i')) : null,
      ...extra,
      d.outs.length ? h('h6', { text: this.r.kind === 'fx' ? 'ITS OUTPUTS ON A TEST SOUND' : 'ITS OUTPUTS ON A TEST NOTE' }) : null, this.scopes,
      h('div', { class: 'row' }, h('button', { class: 'add', onclick: () => this.duplicate(m.id) }, 'DUPLICATE'), h('button', { class: 'add danger', onclick: () => this.removeModule(m.id) }, 'REMOVE')));
    this.drawScopes(m);
  }
  probeSoon() { clearTimeout(this.pt); this.pt = setTimeout(() => { const m = this.sel?.mod && this.patch?.mods.find((x) => x.id === this.sel.mod); if (m) this.drawScopes(m); }, 120); }
  drawScopes(m) {
    if (!this.scopes) return;
    let r;
    try { r = probe(validatePatch(this.patch, this.r.kind), { note: 60, seconds: 0.6, held: 0.4, bpm: this.app.store.p.bpm }); } catch { return; }
    const d = MODULES[m.type];
    this.scopes.replaceChildren(...d.outs.map((o) => {
      const sig = r.sig.get(`${m.id}.${o.k}`), cv = h('canvas', { width: 520, height: 70, class: 'lab-scope' });
      const x = cv.getContext('2d'), H = cv.height;
      if (sig) {
        let lo = Infinity, hi = -Infinity;
        for (const v of sig) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (o.kind === 'audio') { const a = Math.max(Math.abs(lo), Math.abs(hi), 0.05); lo = -a; hi = a; }
        if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
        x.strokeStyle = KIND_COLOR[o.kind]; x.lineWidth = 1.2; x.beginPath();
        const n = sig.length, step = n / cv.width;
        for (let px = 0; px < cv.width; px++) {
          let a = Infinity, b = -Infinity;
          for (let i = Math.floor(px * step); i < Math.floor((px + 1) * step); i++) { if (sig[i] < a) a = sig[i]; if (sig[i] > b) b = sig[i]; }
          const ya = H - 4 - (a - lo) / (hi - lo) * (H - 8), yb = H - 4 - (b - lo) / (hi - lo) * (H - 8);
          x.moveTo(px + 0.5, ya); x.lineTo(px + 0.5, yb + 0.5);
        }
        x.stroke();
        x.fillStyle = '#ffffff66'; x.font = '10px monospace';
        x.fillText(`${hi.toFixed(2)}`, 4, 11); x.fillText(`${lo.toFixed(2)}`, 4, H - 3);
        x.fillStyle = '#ffffff22'; x.fillRect(cv.width * 0.4 / 0.6, 0, 1, H);
      }
      return h('div', { class: 'lab-scope-w' }, h('span', { text: o.l }), cv);
    }));
  }

  // ---- below: macros, voices, effects, a keyboard
  renderBottom() {
    const p = this.patch;
    if (!p) return;
    const sig = JSON.stringify([p.macros.map((m) => m.name), p.voice, (p.fx || []).map((f) => [f.id, f.type, f.on]), this.fxOpen]);
    if (sig === this.bottomSig) { this.macroKnobs?.forEach((k, i) => k.setValue(Math.round(this.r.macro(i) * 1000))); return; }
    this.bottomSig = sig;
    this.macroKnobs = p.macros.map((mc, i) => {
      const k = knob({ label: '', min: 0, max: 1000, size: 36, value: Math.round(this.r.macro(i) * 1000), def: 500, format: (v) => `${Math.round(v / 10)}%`,
        onChange: (v) => this.r.setMacro(i, v / 1000, `labmacro${i}`), onEnd: () => this.app.store.endGesture() });
      if (this.r.kind === 'inst') k.dataset.learn = `sel:p:${i}`;
      return k;
    });
    const macros = h('div', { class: 'lab-macros' }, h('h6', { text: 'MACROS', title: 'The plugin\'s eight knobs: automate them, map them (LEARN), modulate them. A MACRO module in the patch gives a knob\'s value.' }),
      h('div', { class: 'lab-mrow' }, p.macros.map((mc, i) => h('div', { class: 'lab-macro' }, this.macroKnobs[i],
        h('input', { value: mc.name, maxlength: 16, 'aria-label': `Macro ${i + 1} name`, onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); },
          onchange: (e) => this.edit((pp) => { pp.macros[i].name = e.target.value.trim().toUpperCase().slice(0, 16) || `MACRO ${i + 1}`; }) })))));
    const parts = [macros];
    if (this.r.kind === 'inst') {
      const v = p.voice;
      const sel = (label, value, opts, set) => h('label', { class: 'lab-sel-w' }, h('span', { text: label }),
        h('select', { class: 'lab-sel', 'aria-label': label, onchange: (e) => this.edit((pp) => set(pp.voice, e.target.value)) }, opts.map(([val, l]) => h('option', { value: val, selected: String(val) === String(value) ? true : null }, l))));
      const glide = knob({ label: 'GLIDE', min: 0, max: 2000, size: 30, value: v.glide, def: 0, format: (x) => `${Math.round(x)}ms`, onChange: (x) => this.edit((pp) => { pp.voice.glide = x; }, 'labglide'), onEnd: () => this.app.store.endGesture() });
      parts.push(h('div', { class: 'lab-voice' }, h('h6', { text: 'VOICES' }),
        sel('MODE', v.mode, [['poly', 'POLY'], ['mono', 'MONO'], ['legato', 'LEGATO']], (q, x) => { q.mode = x; }),
        v.mode === 'poly' ? sel('VOICES', v.poly, [1, 2, 3, 4, 6, 8, 10, 12, 16].map((n) => [n, String(n)]), (q, x) => { q.poly = +x; }) : null,
        sel('BEND', v.bend, [0, 1, 2, 3, 5, 7, 12, 24].map((n) => [n, `±${n}`]), (q, x) => { q.bend = +x; }), glide));
      const fxs = p.fx || [];
      parts.push(h('div', { class: 'lab-fxchain' }, h('h6', { text: 'EFFECTS AFTER THE VOICES' }),
        h('div', { class: 'lab-chips' }, fxs.map((f) => h('span', { class: 'lab-chip' + (f.on ? '' : ' off') + (this.fxOpen === f.id ? ' sel' : '') },
          h('button', { class: 'tb', onclick: () => { this.fxOpen = this.fxOpen === f.id ? null : f.id; this.renderBottom(); } }, DEVICES[f.type].name),
          h('button', { class: 'tb', title: 'On / off', onclick: () => this.edit((pp) => { const x = pp.fx.find((y) => y.id === f.id); if (x) x.on = !x.on; }) }, '⏻'),
          h('button', { class: 'tb', title: 'Remove', onclick: () => this.edit((pp) => { pp.fx = pp.fx.filter((y) => y.id !== f.id); }) }, '×'))),
        fxs.length < 8 ? h('select', { class: 'lab-sel', 'aria-label': 'Add an effect', onchange: (e) => { const type = e.target.value; e.target.value = ''; if (type) this.edit((pp) => { pp.fx.push({ id: `f${Math.random().toString(36).slice(2, 7)}`, type, on: true, p: defaults(type) }); }); } },
          h('option', { value: '' }, '+ EFFECT'), FX_TYPES.map((t) => h('option', { value: t }, DEVICES[t].name))) : null),
        this.fxOpen && fxs.find((f) => f.id === this.fxOpen) ? this.fxKnobs(fxs.find((f) => f.id === this.fxOpen)) : null));
      parts.push(this.keys());
    }
    this.bottom.replaceChildren(...parts);
  }
  fxKnobs(f) {
    const spec = DEVICES[f.type];
    return h('div', { class: 'lab-knobs' }, spec.params.filter((q) => q.k !== 'sc').map((q) => knob({ label: q.l, min: 0, max: 1000, size: 28, value: Math.round(toNorm(q, f.p[q.k] ?? q.def) * 1000),
      def: Math.round(toNorm(q, q.def) * 1000), format: (v) => fmtParam(q, fromNorm(q, v / 1000)),
      onChange: (v) => this.edit((pp) => { const x = pp.fx.find((y) => y.id === f.id); if (x) x.p[q.k] = fromNorm(q, v / 1000); }, `labpfx${f.id}${q.k}`), onEnd: () => this.app.store.endGesture() })));
  }
  keys() {
    const t = this.r.track?.();
    if (!t) return null;
    const app = this.app, base = 48;
    const keys = [];
    for (let n = base; n < base + 25; n++) {
      const black = [1, 3, 6, 8, 10].includes(n % 12);
      const k = h('button', { class: 'lab-key' + (black ? ' b' : ''), 'aria-label': `Note ${n}` });
      const on = (e) => { e.preventDefault(); k.setPointerCapture?.(e.pointerId); app.noteOn(t.id, n, 100, true); k.classList.add('on'); };
      const off = () => { if (!k.classList.contains('on')) return; app.noteOff(t.id, n, true); k.classList.remove('on'); };
      k.addEventListener('pointerdown', on); k.addEventListener('pointerup', off); k.addEventListener('pointercancel', off); k.addEventListener('pointerleave', off);
      keys.push(k);
    }
    return h('div', { class: 'lab-kb' }, h('h6', { text: 'PLAY' }), h('div', { class: 'lab-keys' }, keys));
  }

  // ---- patches: factory, yours, files
  async patchSheet() {
    const app = this.app, kind = this.r.kind;
    const mine = (await listPresets()).filter((q) => q.kind === 'lab' && q.type === kind);
    const use = (patch) => { m.close(); this.edit((pp, holder) => { const fresh = validatePatch(structuredClone(patch), kind); for (const k of Object.keys(pp)) delete pp[k]; Object.assign(pp, fresh); if (holder?.params) holder.params = {}; if (holder?.p) for (let i = 0; i < 8; i++) holder.p[`m${i}`] = fresh.macros[i].v; }); this.sel = null; requestAnimationFrame(() => this.fit()); app.toast(`${patch.name} loaded. Ctrl+Z brings the previous patch back.`); };
    const row = (q, del = null) => h('div', { class: 'lab-prow' }, h('button', { class: 'add', title: q.tags || '', onclick: () => use(q.patch || q.data) }, h('b', { text: q.name }), q.tags ? h('span', { text: q.tags }) : null),
      del ? h('button', { class: 'tb', title: 'Delete', 'aria-label': `Delete the patch ${q.name}`, onclick: async () => { await removePreset(q.id); m.close(); this.patchSheet(); } }, '×') : null);
    const m = app.modal('Patches', [
      h('p', { class: 'hint', text: kind === 'fx' ? 'Effects to start from: load one, play, then open its modules to see how it works.' : 'Instruments to start from: load one, play it, then open its modules to see how it works.' }),
      h('div', { class: 'lab-plist' }, h('h6', { text: 'FACTORY' }), ...LAB_FACTORY.filter((f) => f.kind === kind).map((f) => row(f)),
        h('h6', { text: 'MY PATCHES' }), ...(mine.length ? mine.map((q) => row(q, true)) : [h('p', { class: 'hint', text: 'SAVE keeps the patch here (in this browser).' })]),
        h('h6', { text: 'START OVER' }), row({ name: kind === 'fx' ? 'Empty effect (sound passes through)' : 'Basic synth (oscillator, filter, envelope)', patch: newPatch(kind) })),
    ], [['Close', null, true]]);
    m.box.classList.add('lab-psheet');
  }
  async savePatch() {
    const p = validatePatch(this.patch, this.r.kind);
    p.macros.forEach((mc, i) => { mc.v = this.r.macro(i); });
    const item = await addPreset({ kind: 'lab', type: this.r.kind, name: p.name, data: p });
    this.app.toast(item ? `${p.name} saved in MY PATCHES.` : 'This browser could not save it (storage full or blocked).');
  }
  fileSheet() {
    const app = this.app, kind = this.r.kind;
    const exp = () => { const p = validatePatch(this.patch, kind); p.macros.forEach((mc, i) => { mc.v = this.r.macro(i); }); m.close(); saveFile(`${p.name.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\w\- ]+/g, '').trim() || 'patch'}.krklab.json`, JSON.stringify({ kraken: 'lab', v: LAB_VERSION, patch: p }, null, 1)).then((n) => app.toast(`Saved ${n}`)).catch(() => {}); };
    const imp = () => {
      const inp = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
      inp.onchange = async () => {
        const f = inp.files[0]; inp.remove(); m.close();
        if (!f) return;
        try {
          const j = JSON.parse(await f.text()), raw = j.patch || j.lab || j;
          const p = validatePatch(raw, kind);
          if ((raw.kind || 'inst') !== kind) app.toast(`That file is ${raw.kind === 'fx' ? 'an effect' : 'an instrument'}: loaded as ${kind === 'fx' ? 'an effect' : 'an instrument'} (modules that do not fit were left out).`);
          this.edit((pp) => { for (const k of Object.keys(pp)) delete pp[k]; Object.assign(pp, p); });
          requestAnimationFrame(() => this.fit());
        } catch { app.toast('That file is not a LAB patch.'); }
      };
      document.body.append(inp); inp.click();
    };
    const m = app.modal('Patch file', [h('p', { class: 'hint', text: 'A patch is a small .json file: send it to anyone, they open it in their LAB.' })],
      [['Import a patch…', imp], ['Export this patch', exp, true]]);
  }
  paletteSheet() {
    const box = h('div', { class: 'lab-pal sheet' });
    const m = this.app.modal('Add a module', [box], [['Close', null, true]]);
    this.buildPalette(box, (t) => { m.close(); this.addModule(t); });
  }
  guide() {
    this.app.modal('How LAB works', [h('div', { class: 'lab-guide' },
      ...[['1 · Modules', 'Each box does one thing: an oscillator makes a tone, a filter shapes it, an envelope moves something over a note. Add them from the left, or double-click the canvas.'],
        ['2 · Cables', 'Drag from an output dot (right side of a box) to an input dot (left side). Colours: blue is sound, orange is movement (modulation), green is gates and triggers, purple is pitch. Any output can go to any input.'],
        ['3 · Amounts', 'Click a cable: its AMOUNT says how much goes through. Into a knob\'s input (CUTOFF, PITCH MOD…) it is how far it moves that knob. Negative turns it upside down.'],
        ['4 · Voices', 'In an instrument, every note plays the whole patch on its own (a voice). NOTE gives the note\'s pitch, gate and velocity; an ENVELOPE into a VCA makes notes start and end.'],
        ['5 · Macros', 'The eight knobs below are your plugin\'s controls. A MACRO module brings one into the patch: plug it into what it should move, name it, then automate it or map it to a controller like any knob.'],
        ['6 · Share', 'SAVE keeps the patch in this browser, FILE exports it, PUBLISH puts it on the Kraken hub. A patch is only settings: it is safe to share and to open.']]
        .map(([a, b]) => h('div', {}, h('b', { text: a }), h('p', { text: b }))))], [['Got it', null, true]]);
  }
}
const KIND_LABEL = { audio: 'Audio', mod: 'Modulation', gate: 'Gate', pitch: 'Pitch' };

// ------------------------------------------------------------------ the INSTRUMENT tab of a LAB track
export function buildLab(dev, t) {
  const app = dev.app, p = t.lab;
  const macro = (i) => (t.params?.[i] != null ? t.params[i] : Math.round((p?.macros?.[i]?.v ?? 0.5) * 127));
  const knobs = (p?.macros || []).map((mc, i) => {
    const k = knob({ label: mc.name, min: 0, max: 127, def: 64, value: macro(i), color: t.color, format: (v) => `${Math.round(v / 1.27)}%`, mod: t.params?.[i] != null,
      onChange: (v) => { k.classList.add('mod'); dev.setParam(t, i, v); }, onEnd: () => app.store.endGesture() });
    k.title = `${mc.name}: drag · LEARN maps it to a controller · automate it in the track's lanes`;
    k.dataset.learn = `sel:p:${i}`;
    dev.knobs.set(i, k);
    return k;
  });
  const v = p?.voice || {};
  dev.wrap.replaceChildren(
    h('div', { class: 'module sound-lcd' }, h('h4', {}, 'LAB', h('em', { text: 'YOUR INSTRUMENT' })),
      h('div', { class: 'screen' }, h('span', { class: 'eng', text: `${p?.mods.length || 0} MODULES · ${v.mode === 'poly' ? `${v.poly} VOICES` : v.mode?.toUpperCase()}` }), h('span', { class: 'pre', text: p?.name || '' })),
      h('div', { class: 'row' }, h('button', { class: 'add go', onclick: () => openLab(app, { track: t.id }), title: 'Build and change it: modules and cables' }, 'OPEN THE LAB'),
        h('button', { class: 'add', onclick: () => labPicker(app, 'inst', (patch) => app.store.change((pp) => { const x = pp.tracks.find((y) => y.id === t.id); x.lab = validatePatch(structuredClone(patch), 'inst'); x.params = {}; }), `Choose a patch for ${t.name}`) }, 'PATCHES ▾')),
      app.hub?.publishLab ? h('button', { class: 'add', onclick: () => app.hub.publishLab(validatePatch(p, 'inst'), p.name) }, '☁ PUBLISH ON THE HUB') : null),
    h('div', { class: 'module' }, h('h4', {}, 'MACROS', h('em', { text: 'AUTOMATE · LEARN · MODULATE' })), h('div', { class: 'knobs', '--cols': 4 }, knobs)),
    freezeModule(dev, t));
}
// a list of patches to pick from (factory, then yours)
export async function labPicker(app, kind, pick, title = 'Choose a patch') {
  const mine = (await listPresets()).filter((q) => q.kind === 'lab' && q.type === kind);
  const m = app.modal(title, [h('div', { class: 'lab-plist' }, h('h6', { text: 'FACTORY' }),
    ...LAB_FACTORY.filter((f) => f.kind === kind).map((f) => h('button', { class: 'add', onclick: () => { m.close(); pick(f.patch, f.name); } }, h('b', { text: f.name }), h('span', { text: f.tags }))),
    mine.length ? h('h6', { text: 'MY PATCHES' }) : null, ...mine.map((q) => h('button', { class: 'add', onclick: () => { m.close(); pick(q.data, q.name); } }, h('b', { text: q.name }))),
    h('h6', { text: 'START OVER' }), h('button', { class: 'add', onclick: () => { m.close(); pick(newPatch(kind), kind === 'fx' ? 'Empty effect' : 'Basic synth'); } }, h('b', { text: kind === 'fx' ? 'Empty effect' : 'Basic synth' })))], [['Cancel', null, true]]);
  m.box.classList.add('lab-psheet');
}
// a patch from outside (the hub, a file): kept in MY PATCHES, then used now if you like
export async function installLab(app, raw, meta = {}) {
  const kind = raw?.kind === 'fx' ? 'fx' : 'inst', patch = validatePatch(raw, kind), name = String(meta.name || patch.name).slice(0, 40);
  patch.name = name;
  await addPreset({ kind: 'lab', type: kind, name, data: patch, from: meta.from || null });
  const t = app.store.track(app.view.selTrack);
  app.modal(`${name} is in your patches`, [h('p', { class: 'hint', text: kind === 'fx' ? 'An effect: put it on a track now, or find it later in the LAB effect\'s PATCHES.' : 'An instrument: play it on a new track now, or find it later in PATCHES.' })],
    [['Later', null], kind === 'fx'
      ? [t ? `Add it to ${t.name}` : 'Add it to the master', () => app.store.change((pp) => { const fx = t ? pp.tracks.find((x) => x.id === t.id).fx : pp.master.fx; fx.push({ id: `f${Math.random().toString(36).slice(2, 8)}`, type: 'lab', on: true, p: { ...defaults('lab'), ...Object.fromEntries(patch.macros.map((m, i) => [`m${i}`, m.v])) }, lab: patch }); }), true]
      : ['New track with it', () => { const nt = app.addTrack('lab', { name: name.toUpperCase().slice(0, 16), lab: patch }); app.audition?.(nt.id, [60, 64, 67]); }, true]]);
  return patch;
}
// the effect of a rack that is a LAB: its button
export function labFxButton(app, o, d) {
  const target = o.id === 'master' ? { bus: 'master', fx: d.id } : /^ret\d+$/.test(o.id) ? { bus: o.id, fx: d.id } : { track: o.id, fx: d.id };
  return h('div', { class: 'row lab-fxrow' }, h('span', { class: 'lab-fxname', text: d.lab?.name || 'Empty effect' }),
    h('button', { class: 'add go', onclick: () => openLab(app, target) }, 'OPEN THE LAB'),
    h('button', { class: 'add', onclick: () => labPicker(app, 'fx', (patch) => o.edit((fx) => { const x = fx.find((y) => y.id === d.id); if (x) { x.lab = validatePatch(structuredClone(patch), 'fx'); patch.macros?.forEach((m, i) => { x.p[`m${i}`] = m.v; }); } }), 'Choose an effect patch') }, 'PATCHES ▾'));
}
