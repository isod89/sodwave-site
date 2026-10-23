// SPDX-License-Identifier: GPL-3.0-only
// Small UI kit: elements, knobs, value formats, a canvas that follows its box.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('--')) el.style.setProperty(k, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => `${NOTE[n % 12]}${Math.floor(n / 12) - 1}`;

// firmware formats (core.h): F_INT F_PCT F_BIPCT F_TIME F_LFOHZ F_CUTOFF F_DB F_SEMI F_ENUM F_BPM F_NOTE F_ONOFF F_OCT F_STEPS F_SWING F_FILT
export function fmt(d, v) {
  if (!d) return String(v);
  switch (d.f) {
    case 1: return `${Math.round((v / (d.max || 127)) * 100)}%`;
    case 2: return `${v > 0 ? '+' : ''}${Math.round((v / Math.max(Math.abs(d.min), d.max || 1)) * 100)}%`;
    case 7: return `${v > 0 ? '+' : ''}${v}st`;
    case 8: return d.n ? (d.n[v - d.min] ?? v) : v;
    case 10: return noteName(v);
    case 11: return v ? 'ON' : 'OFF';
    case 12: return `${v > 0 ? '+' : ''}${v}`;
    case 14: return `${v}%`;
    case 15: return v === 0 ? 'OFF' : v < 0 ? `LP ${-v}` : `HP ${v}`;
    default: return d.u ? `${v}${d.u}` : String(v);
  }
}

// a knob: vertical drag (Shift: fine), wheel, double-click resets, arrow keys
export function knob({ label, min, max, value, def = min, format = (v) => v, onChange, onEnd, color, size, mod = false, step = 1 }) {
  const bip = min < 0 && max > 0;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-20 -20 40 40');
  const arc = (a0, a1, r) => {
    const p = (a) => [Math.cos(a) * r, Math.sin(a) * r];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > Math.PI ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
  svg.innerHTML = `<path d="${arc(A0, A1, 16)}" fill="none" stroke="#2f343a" stroke-width="3.2" stroke-linecap="round"/>
    <path class="v" fill="none" stroke="${color || 'var(--accent)'}" stroke-width="3.2" stroke-linecap="round"/>
    <circle r="11" fill="#d6d7d4"/><circle r="11" fill="none" stroke="#0006"/>
    <line class="p" x1="0" y1="0" x2="0" y2="-9" stroke="#131415" stroke-width="2.4" stroke-linecap="round"/>`;
  const val = h('span', { class: 'val' });
  const el = h('div', { class: 'knob' + (mod ? ' mod' : ''), tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max },
    svg, h('span', { class: 'lbl', text: label, title: label }), val);
  if (size) { svg.style.width = svg.style.height = size + 'px'; }
  let v = value;
  const draw = () => {
    const k = (v - min) / (max - min || 1), a = A0 + (A1 - A0) * k;
    const z = bip ? A0 + (A1 - A0) * ((0 - min) / (max - min)) : A0;
    const path = svg.querySelector('.v');
    path.setAttribute('d', Math.abs(a - z) < 0.01 ? '' : arc(Math.min(a, z), Math.max(a, z), 16));
    svg.querySelector('.p').setAttribute('transform', `rotate(${(a + Math.PI / 2) * 180 / Math.PI})`);
    val.textContent = format(v);
    el.setAttribute('aria-valuenow', v);
  };
  const set = (nv, end = false) => {
    nv = Math.max(min, Math.min(max, step < 1 ? Math.round(nv / step) * step : Math.round(nv)));
    if (nv !== v) { v = nv; draw(); onChange?.(v); }
    if (end) onEnd?.(v);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); el.focus();
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = v, range = max - min;
    const move = (m) => set(v0 + ((y0 - m.clientY) / (m.shiftKey ? 600 : 160)) * range);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onEnd?.(v); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  el.addEventListener('dblclick', () => set(def, true));
  el.addEventListener('wheel', (e) => { e.preventDefault(); set(v + Math.sign(-e.deltaY) * (step < 1 ? step * 4 : Math.max(1, (max - min) / 64))); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); set(v + d * (step < 1 ? step : 1) * (e.shiftKey ? 10 : 1), true); }
  });
  el.setValue = (nv) => { v = nv; draw(); };
  draw();
  return el;
}

// a canvas sized to its parent box at device pixel ratio; draw(ctx, w, h)
export function fitCanvas(cv, draw) {
  const parent = cv.parentElement;
  let w = 0, hh = 0, dpr = 1, queued = false;
  const resize = () => {
    const r = cv.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    w = Math.max(1, Math.round(r.width)); hh = Math.max(1, Math.round(r.height));
    cv.width = w * dpr; cv.height = hh * dpr;
    paint();
  };
  const paint = () => {
    queued = false;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, hh);
  };
  new ResizeObserver(resize).observe(parent);
  return { redraw() { if (!queued) { queued = true; requestAnimationFrame(paint); } }, now: paint, size: () => [w, hh] };
}

export function dragPointer(e, move, up) {
  const t = e.currentTarget;
  try { t.setPointerCapture?.(e.pointerId); } catch { /* the pointer is already up (a quick tap handled late) */ }
  const mv = (m) => move(m);
  const u = (m) => { t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', u); t.removeEventListener('pointercancel', u); up?.(m); };
  t.addEventListener('pointermove', mv); t.addEventListener('pointerup', u); t.addEventListener('pointercancel', u);
}

// a scroll bar laid over a canvas view: get() -> { pos, view, total } (in any unit), set(pos).
// Drag the thumb, or touch / click the bar to jump there. Hidden when everything is in view.
export class ScrollBar {
  constructor(parent, dir, get, set) {
    this.dir = dir; this.get = get; this.set = set;
    this.thumb = h('i');
    this.el = h('div', { class: `sbar ${dir}`, role: 'scrollbar', 'aria-orientation': dir === 'h' ? 'horizontal' : 'vertical' }, this.thumb);
    parent.append(this.el);
    const along = (e) => { const r = this.el.getBoundingClientRect(); return dir === 'h' ? [e.clientX - r.left, r.width] : [e.clientY - r.top, r.height]; };
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const { pos, view, total } = this.get(), [p0, len] = along(e), tl = Math.max(28, len * view / total), t0 = (pos / total) * len;
      let grab = p0 - t0;
      if (grab < 0 || grab > tl) { grab = tl / 2; this.jump(p0 - grab, len, tl); }        // on the bar: there
      try { this.el.setPointerCapture(e.pointerId); } catch { /* gone */ }
      const mv = (m) => { const [p] = along(m); this.jump(p - grab, len, tl); };
      const up = () => { this.el.removeEventListener('pointermove', mv); this.el.removeEventListener('pointerup', up); this.el.removeEventListener('pointercancel', up); this.el.classList.remove('drag'); };
      this.el.addEventListener('pointermove', mv); this.el.addEventListener('pointerup', up); this.el.addEventListener('pointercancel', up);
      this.el.classList.add('drag');
    });
  }
  jump(thumbStart, len, tl) {
    const { view, total } = this.get(), max = Math.max(0, total - view);
    this.set(Math.max(0, Math.min(max, (thumbStart / Math.max(1, len - tl)) * max)));
  }
  update() {
    const { pos, view, total } = this.get();
    const show = total > view + 1e-6;
    this.el.hidden = !show;
    if (!show) return;
    const len = this.dir === 'h' ? this.el.clientWidth : this.el.clientHeight, tl = Math.max(28, len * view / total);
    const at = (Math.min(pos, total - view) / Math.max(1e-9, total - view)) * (len - tl);
    Object.assign(this.thumb.style, this.dir === 'h' ? { left: `${at}px`, width: `${tl}px` } : { top: `${at}px`, height: `${tl}px` });
  }
}
