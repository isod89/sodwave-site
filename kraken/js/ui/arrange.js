// SPDX-License-Identifier: GPL-3.0-only
// The arrangement: track heads, a bar ruler with the loop, clip lanes and automation lanes.
import { h, fitCanvas, dragPointer } from './kit.js';
import { newClip, uid } from '../project.js';
import { DEVICES } from '../fx.js';

const RULER_LOOP = 11;                     // the ruler's top band: the loop region
const EDGE = 7;                            // px from a clip's end that resizes it

export function autoTargets(app, t) {
  if (t.kind === 'tempo') return [{ key: 'tempo', label: 'TEMPO', min: 40, max: 240, def: 120, fmt: (v) => `${v.toFixed(1)} BPM` }];
  const list = [
    { key: 'vol', label: 'VOLUME', min: -60, max: 6, def: 0, fmt: (v) => `${v.toFixed(1)} dB` },
    { key: 'pan', label: 'PAN', min: -1, max: 1, def: 0, fmt: (v) => (Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) },
    ...app.store.p.returns.map((r, i) => ({ key: `send${i}`, label: `SEND ${r.name}`, min: 0, max: 1, def: 0, fmt: (v) => `${Math.round(v * 100)}%` })),
  ];
  for (const d of t.fx || []) for (const p of DEVICES[d.type].params) {
    if (p.k === 'sc') continue;
    list.push({ key: `fx:${d.id}:${p.k}`, label: `${DEVICES[d.type].name} ${p.l}`, min: p.min, max: p.max, def: p.def, fmt: (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2)) });
  }
  if (t.kind === 'synth') {
    const cat = app.lib[t.bank], e = cat.engines[t.engine], e0 = cat.e0;
    e.edit.forEach((d, i) => list.push({ key: `p${e0 + i}`, label: `${e.name} ${d.l}`, min: d.min, max: d.max, def: d.def, fmt: (v) => String(Math.round(v)) }));
    const NAMES = { 5: 'ENV > FILTER', 9: 'LFO RATE', 13: 'LFO > PITCH', 14: 'LFO > FILTER', 33: 'DRIVE', 34: 'CHORUS', 35: 'INST DELAY', 36: 'INST REVERB', 50: 'DJ FILTER' };
    for (const id of Object.keys(NAMES).map(Number)) {
      const d = cat.tp[id];
      list.push({ key: `p${id}`, label: NAMES[id], min: d.min, max: d.max, def: d.def, fmt: (v) => String(Math.round(v)) });
    }
  }
  return list;
}

export class Arrange {
  constructor(app) {
    this.app = app;
    const v = app.view;
    Object.assign(v, { zoom: 22, sx: 0, sy: 0, trackH: 58, autoH: 64 });
    this.headsInner = document.getElementById('heads-inner');
    this.ruler = fitCanvas(document.getElementById('ruler'), (c, w, hh) => this.drawRuler(c, w, hh));
    this.lanesCv = document.getElementById('lanes-cv');
    this.lanes = fitCanvas(this.lanesCv, (c, w, hh) => this.drawLanes(c, w, hh));
    this.bindRuler();
    this.bindLanes();
    document.getElementById('heads').addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    app.store.on(() => { this.renderHeads(); this.redraw(); });
  }
  get p() { return this.app.store.p; }
  redraw() { this.ruler.redraw(); this.lanes.redraw(); }
  x(beat) { return beat * this.app.view.zoom - this.app.view.sx; }
  beat(x) { return (x + this.app.view.sx) / this.app.view.zoom; }
  snap(b, floor = false) {
    const s = this.app.view.snap || 0;
    const g = s === 0 ? 1 / 64 : Math.max(s, this.app.view.zoom < 10 ? this.p.sig : this.app.view.zoom < 22 ? 1 : s);
    return (floor ? Math.floor(b / g) : Math.round(b / g)) * g;
  }
  rows() {
    const v = this.app.view, out = [];
    let y = 0;
    if (v.tempoLane) {                                       // the tempo map, as an automation lane
      out.push({ kind: 'auto', t: { id: '__tempo', kind: 'tempo', name: 'TEMPO', color: '#ff5b14', auto: { tempo: this.p.tempo } }, y, h: v.autoH });
      y += v.autoH;
    }
    for (const t of this.p.tracks) {
      out.push({ kind: 'track', t, y, h: v.trackH });
      y += v.trackH;
      if (v.autoOpen?.has(t.id)) { out.push({ kind: 'auto', t, y, h: v.autoH }); y += v.autoH; }
    }
    this.total = y;
    return out;
  }
  rowAt(y) { return this.rows().find((r) => y + this.app.view.sy >= r.y && y + this.app.view.sy < r.y + r.h); }

  // --------------------------------------------------------------- heads ---
  renderHeads() {
    const app = this.app, v = app.view;
    this.headsInner.replaceChildren(...this.rows().map((r) => {
      const t = r.t;
      if (r.kind === 'auto') {
        const targets = autoTargets(app, t);
        const cur = v.autoTarget[t.id] || 'vol';
        const sel = h('select', { 'aria-label': 'Automation target', onchange: (e) => { v.autoTarget[t.id] = e.target.value; this.redraw(); } },
          targets.map((a) => h('option', { value: a.key, selected: a.key === cur ? true : null }, (t.auto[a.key]?.length ? '● ' : '') + a.label)));
        if (t.kind === 'tempo') return h('div', { class: 'auto-head', '--ah': v.autoH + 'px' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', font: '700 10px/1 var(--f-ui)', letterSpacing: '0.12em', color: '#ff5b14' } }, 'TEMPO MAP',
            h('button', { class: 'tb', title: 'Hide the tempo lane', onclick: () => { v.tempoLane = false; this.renderHeads(); this.redraw(); } }, '×')),
          h('small', { text: this.p.tempo.length ? 'Points ramp from one to the next.' : `No map: ${this.p.bpm} BPM all along. Click to add points.` }));
        return h('div', { class: 'auto-head', '--ah': v.autoH + 'px' }, sel,
          h('small', { text: 'Click: add a point. Drag: move. Double-click: remove.' }));
      }
      const grp = t.out && t.out !== 'master' ? this.p.tracks.find((x) => x.id === t.out) : null;
      const snd = (t.frozen ? '❄ ' : '') + (grp ? `→ ${grp.name} · ` : '') + (t.kind === 'drum' ? `KIT ${app.lib.sloop.kits[t.kit] ?? ''}`
        : t.kind === 'audio' ? `AUDIO · ${t.clips.length} CLIP${t.clips.length === 1 ? '' : 'S'}`
        : t.kind === 'group' ? `GROUP · ${this.p.tracks.filter((x) => x.out === t.id).length} TRACKS`
        : t.kind === 'sampler' ? `SAMPLER · ${t.sample?.name || 'NO SAMPLE'}`
        : t.kind === 'external' ? `MIDI OUT · ${t.ext?.port || 'NO PORT'} CH ${t.ext?.ch || 1}`
        : `${app.lib[t.bank].engines[t.engine]?.name} · ${app.lib[t.bank].engines[t.engine]?.presets[t.preset] ?? ''}${t.dx7 ? ' · ' + t.dx7.name : ''}${t.mpe ? ' · MPE' : ''}`);
      const LEARN = { m: 'mute', s: 'solo', r: 'arm' };
      const tb = (cls, label, on, title, fn) => h('button', { class: `tb ${cls}${on ? ' on' : ''}`, title, 'aria-pressed': on ? 'true' : 'false', 'data-learn': LEARN[cls] ? `t:${t.id}:${LEARN[cls]}` : null, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
      const name = h('div', { class: 'name', text: t.name, title: 'Double-click to rename' });
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        name.contentEditable = 'true'; name.focus();
        document.getSelection().selectAllChildren(name);
        const done = () => {
          name.contentEditable = 'false';
          const nv = name.textContent.trim().slice(0, 24) || t.name;
          if (nv !== t.name) app.store.change((p) => { p.tracks.find((x) => x.id === t.id).name = nv; });
        };
        name.addEventListener('blur', done, { once: true });
        name.addEventListener('keydown', (k) => { if (k.key === 'Enter' || k.key === 'Escape') { k.preventDefault(); name.blur(); } k.stopPropagation(); });
      });
      const head = h('div', { class: 'head' + (t.id === v.selTrack ? ' sel' : ''), '--h': v.trackH + 'px', '--c': t.color, 'data-id': t.id,
        onpointerdown: (e) => { if (!e.target.closest('button, [contenteditable="true"]')) app.selectTrack(t.id); } },
        h('span', { class: 'chip' }), name,
        h('div', { class: 'btns' },
          tb('m', 'M', t.mute, 'Mute', () => app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.mute = !x.mute; })),
          tb('s', 'S', t.solo, 'Solo', () => app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.solo = !x.solo; })),
          tb('r', '●', t.arm, 'Arm for recording', () => app.store.change((p) => { for (const y of p.tracks) y.arm = y.id === t.id ? !y.arm : false; })),
          tb('a', 'A', v.autoOpen.has(t.id), 'Automation', () => { v.autoOpen.has(t.id) ? v.autoOpen.delete(t.id) : v.autoOpen.add(t.id); this.renderHeads(); this.redraw(); }),
          tb('x', '×', false, 'Delete this track…', () => app.deleteTrack(t.id)),
          tb('d', '⧉', false, 'Duplicate this track', () => app.duplicateTrack(t.id))),
        h('div', { class: 'snd', text: snd, title: snd }),
        h('span', { class: 'meter' }, h('i')));
      return head;
    }));
    this.headsInner.style.transform = `translateY(${-v.sy}px)`;
  }
  meters(levels) {
    for (const el of this.headsInner.querySelectorAll('.head')) {
      const l = levels[el.dataset.id];
      if (l) el.querySelector('.meter').style.setProperty('--v', Math.min(1, Math.sqrt(Math.max(l[0], l[1]))).toFixed(3));
    }
  }

  // --------------------------------------------------------------- ruler ---
  drawRuler(c, w, hh) {
    const p = this.p, v = this.app.view;
    c.fillStyle = '#0b0c0d'; c.fillRect(0, 0, w, hh);
    c.fillStyle = '#131517'; c.fillRect(0, 0, w, RULER_LOOP);
    const la = this.x(p.loop.a), lb = this.x(p.loop.b);
    c.fillStyle = p.loop.on ? '#ff5b14' : '#3a3f45';
    c.fillRect(la, 2, lb - la, RULER_LOOP - 4);
    if (p.punch?.on) {                                       // punch in / out: the red band under the loop
      c.fillStyle = '#ff2f2f'; c.fillRect(this.x(p.punch.a), RULER_LOOP - 3, (p.punch.b - p.punch.a) * this.app.view.zoom, 3);
    }
    const bar = p.sig, every = v.zoom * bar < 34 ? (v.zoom * bar < 14 ? 8 : 4) : 1;
    c.font = '500 10px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
    const b0 = Math.floor(this.beat(0) / bar), b1 = Math.ceil(this.beat(w) / bar);
    for (let b = Math.max(0, b0); b <= b1; b++) {
      const x = Math.round(this.x(b * bar)) + 0.5;
      const major = b % every === 0;
      c.strokeStyle = major ? '#5b6168' : '#2f343a';
      c.beginPath(); c.moveTo(x, major ? RULER_LOOP : hh - 6); c.lineTo(x, hh); c.stroke();
      if (major) { c.fillStyle = '#9aa0a6'; c.fillText(String(b + 1), x + 4, RULER_LOOP + (hh - RULER_LOOP) / 2); }
    }
    const px = this.x(this.app.pos);
    c.fillStyle = '#ff5b14';
    c.beginPath(); c.moveTo(px - 5, hh - 7); c.lineTo(px + 5, hh - 7); c.lineTo(px, hh); c.fill();
  }
  bindRuler() {
    const cv = document.getElementById('ruler');
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect(), y = e.clientY - r.top;
      const at = (m) => Math.max(0, this.beat(m.clientX - r.left));
      if (y < RULER_LOOP + 2 && e.shiftKey) {                // Shift-drag: the punch region
        const s = Math.max(1, this.app.view.snap || 1), start = at(e);
        const set = (m) => { const cur = at(m), lo = Math.min(start, cur), hi = Math.max(start, cur);
          this.app.store.change((pp) => { pp.punch = { on: true, a: Math.floor(lo / s) * s, b: Math.max(Math.floor(lo / s) * s + s, Math.ceil(hi / s) * s) }; }, 'punch'); };
        set(e); dragPointer(e, set, () => this.app.store.endGesture());
        return;
      }
      if (y < RULER_LOOP + 2) {
        const p = this.p, b = at(e), s = Math.max(1, this.app.view.snap || 1);
        const inside = b > p.loop.a && b < p.loop.b;
        const a0 = p.loop.a, b0 = p.loop.b, start = b;
        dragPointer(e, (m) => {
          const cur = at(m);
          this.app.store.change((pp) => {
            if (inside && Math.abs(cur - start) > 0) {
              const d = Math.round((cur - start) / s) * s, len = b0 - a0;
              pp.loop.a = Math.max(0, a0 + d); pp.loop.b = pp.loop.a + len;
            } else {
              const lo = Math.min(start, cur), hi = Math.max(start, cur);
              pp.loop.a = Math.floor(lo / s) * s; pp.loop.b = Math.max(pp.loop.a + s, Math.ceil(hi / s) * s);
            }
            pp.loop.on = true;
          }, 'loop');
        }, () => this.app.store.endGesture());
        if (!inside) this.app.store.change((pp) => { pp.loop.a = Math.floor(b / s) * s; pp.loop.b = pp.loop.a + this.p.sig * 4; pp.loop.on = true; }, 'loop');
      } else {
        this.app.seek(this.snap(at(e)));
        dragPointer(e, (m) => this.app.seek(this.snap(at(m))));
      }
    });
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  // --------------------------------------------------------------- lanes ---
  drawLanes(c, w, hh) {
    const p = this.p, v = this.app.view, rows = this.rows();
    c.fillStyle = '#0b0c0d'; c.fillRect(0, 0, w, hh);
    // loop shade
    if (p.loop.on) { c.fillStyle = 'rgba(255,91,20,0.045)'; c.fillRect(this.x(p.loop.a), 0, this.x(p.loop.b) - this.x(p.loop.a), hh); }
    // grid
    const bar = p.sig;
    const b0 = Math.max(0, Math.floor(this.beat(0))), b1 = Math.ceil(this.beat(w));
    for (let b = b0; b <= b1; b++) {
      const isBar = b % bar === 0;
      if (!isBar && v.zoom < 12) continue;
      c.fillStyle = isBar ? ((b / bar) % 4 === 0 ? '#2a2e33' : '#1c1f22') : '#141618';
      c.fillRect(Math.round(this.x(b)), 0, 1, hh);
    }
    for (const r of rows) {
      const y = r.y - v.sy;
      if (y > hh || y + r.h < 0) continue;
      c.fillStyle = '#1a1d20'; c.fillRect(0, y + r.h - 1, w, 1);
      if (r.kind === 'track') this.drawClips(c, r.t, y, r.h, w);
      else this.drawAuto(c, r.t, y, r.h, w);
    }
    if (this.ghost) {
      const g = this.ghost;
      c.strokeStyle = '#ffffff88'; c.setLineDash([4, 3]);
      c.strokeRect(this.x(g.start) + 0.5, g.y + 3.5, (g.len) * v.zoom - 1, v.trackH - 8);
      c.setLineDash([]);
    }
    if (this.total - v.sy < hh) {
      c.fillStyle = '#5b616866'; c.font = '600 10px Archivo, sans-serif';
      c.fillText(p.tracks.length ? 'Double-click or drag on a lane to add a clip · + TRACK in the sound library adds a track' : 'Add a track with + SYNTH or + DRUMS, or pick a sound in the library', 12, this.total - v.sy + 22);
    }
    const px = Math.round(this.x(this.app.pos)) + 0.5;
    c.strokeStyle = '#ff5b14'; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, hh); c.stroke();
  }
  drawClips(c, t, y, rh, w) {
    const v = this.app.view;
    for (const clip of t.clips) {
      const x0 = this.x(clip.start), x1 = this.x(clip.start + clip.len);
      if (x1 < 0 || x0 > w) continue;
      const sel = clip.id === v.selClip;
      const top = y + 3, ht = rh - 7, wd = Math.max(3, x1 - x0 - 1);
      c.fillStyle = t.color + '2e'; c.fillRect(x0, top, wd, ht);
      c.fillStyle = t.color; c.fillRect(x0, top, wd, 13);
      if (t.mute) { c.fillStyle = '#0b0c0d99'; c.fillRect(x0, top, wd, ht); }
      c.save(); c.beginPath(); c.rect(x0, top, wd, ht); c.clip();
      c.fillStyle = '#0b0c0d'; c.font = '700 9px Archivo, sans-serif'; c.textBaseline = 'middle';
      c.fillText(clip.name.toUpperCase(), x0 + 4, top + 7);
      if (t.kind === 'audio') { this.drawWave(c, t, clip, x0, top + 14, wd, ht - 14); c.restore(); if (sel) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.strokeRect(x0 + 0.75, top + 0.75, wd - 1.5, ht - 1.5); c.lineWidth = 1; } continue; }
      // the notes, repeated over the clip's loop
      const loop = clip.loop || clip.len;
      let lo = 127, hi = 0;
      for (const n of clip.notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
      if (clip.notes.length) {
        const span = Math.max(12, hi - lo + 1), area = ht - 18;
        c.fillStyle = t.color;
        for (let base = 0; base < clip.len; base += loop) {
          for (const n of clip.notes) {
            if (n.t >= loop || base + n.t >= clip.len) continue;
            const nx = this.x(clip.start + base + n.t), nw = Math.max(1.5, Math.min(n.d, loop - n.t) * v.zoom - 1);
            const ny = top + 16 + (1 - (n.n - lo + 0.5) / span) * area - 1.5;
            c.globalAlpha = base > 0 ? 0.55 : 1;
            c.fillRect(nx, ny, nw, 2.5);
          }
          if (base > 0) { c.globalAlpha = 1; c.fillStyle = '#0b0c0d88'; c.fillRect(this.x(clip.start + base), top + 13, 1, ht - 13); c.fillStyle = t.color; }
        }
        c.globalAlpha = 1;
      }
      c.restore();
      if (sel) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.strokeRect(x0 + 0.75, top + 0.75, wd - 1.5, ht - 1.5); c.lineWidth = 1; }
    }
  }
  drawWave(c, t, clip, x0, top, wd, ht) {
    const a = this.app.assets.get(clip.src);
    if (!a) { c.fillStyle = '#737980'; c.font = '600 9px Archivo, sans-serif'; c.fillText('MISSING AUDIO', x0 + 4, top + ht / 2); return; }
    const pk = a.peaks, spb = 60 / this.p.bpm * 44100, mid = top + ht / 2, g = Math.pow(10, (clip.gain || 0) / 20);
    c.fillStyle = t.color;
    const [w] = this.lanes.size();
    for (let px = Math.max(0, Math.floor(x0)); px < Math.min(w, x0 + wd); px++) {
      const b0 = (px - x0) / this.app.view.zoom, b1 = (px + 1 - x0) / this.app.view.zoom;
      const i0 = Math.floor(((clip.offset || 0) * 44100 + b0 * spb) / 256), i1 = Math.max(i0 + 1, Math.floor(((clip.offset || 0) * 44100 + b1 * spb) / 256));
      let m = 0;
      for (let i = i0; i < i1 && i < pk.length; i++) if (pk[i] > m) m = pk[i];
      const hh = Math.min(1, m * g) * (ht / 2 - 1);
      c.fillRect(px, mid - hh, 1, hh * 2 || 1);
    }
  }
  drawAuto(c, t, y, rh, w) {
    const v = this.app.view, key = v.autoTarget[t.id] || 'vol';
    const tgt = autoTargets(this.app, t).find((a) => a.key === key) || autoTargets(this.app, t)[0];
    c.fillStyle = '#0e1011'; c.fillRect(0, y, w, rh - 1);
    const pts = (t.kind === 'tempo' ? this.p.tempo : t.auto[key]) || [];
    const vy = (val) => y + 6 + (1 - (val - tgt.min) / (tgt.max - tgt.min)) * (rh - 13);
    c.strokeStyle = t.color; c.lineWidth = 1.5;
    if (!pts.length) {
      const base = key === 'tempo' ? this.p.bpm : key === 'vol' ? t.vol : key === 'pan' ? t.pan : key.startsWith('send') ? t.sends[+key.slice(4)] ?? 0 : null;
      if (base != null) { c.setLineDash([3, 4]); c.globalAlpha = 0.5; c.beginPath(); c.moveTo(0, vy(base)); c.lineTo(w, vy(base)); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; }
    } else {
      c.beginPath(); c.moveTo(0, vy(pts[0].v));
      for (const pt of pts) c.lineTo(this.x(pt.t), vy(pt.v));
      c.lineTo(w, vy(pts[pts.length - 1].v)); c.stroke();
      c.fillStyle = t.color + '22'; c.lineTo(w, y + rh); c.lineTo(0, y + rh); c.fill();
      for (const pt of pts) { c.fillStyle = '#0b0c0d'; c.beginPath(); c.arc(this.x(pt.t), vy(pt.v), 3.5, 0, 7); c.fill(); c.stroke(); }
    }
    c.lineWidth = 1;
    c.fillStyle = '#737980'; c.font = '500 9px "IBM Plex Mono", monospace';
    c.fillText(`${tgt.label} ${tgt.fmt(tgt.max)}`, 6, y + 12);
    this.autoGeom = this.autoGeom || {};
    this.autoGeom[t.id] = { vy, tgt, y, rh };
  }

  bindLanes() {
    const cv = this.lanesCv, app = this.app;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const hitClip = (t, x) => {
      for (let i = t.clips.length - 1; i >= 0; i--) {
        const c = t.clips[i], x0 = this.x(c.start), x1 = this.x(c.start + c.len);
        if (x >= x0 && x <= x1) return { clip: c, edge: x > x1 - EDGE && x1 - x0 > EDGE * 2, left: t.kind === 'audio' && x < x0 + EDGE && x1 - x0 > EDGE * 3 };
      }
      return null;
    };
    cv.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const [x, y] = local(e), row = this.rowAt(y);
      let cur = 'default';
      if (row?.kind === 'track') { const hc = hitClip(row.t, x); if (hc) cur = hc.edge || hc.left ? 'ew-resize' : 'grab'; else cur = row.t.kind === 'audio' ? 'default' : 'crosshair'; }
      else if (row?.kind === 'auto') cur = 'crosshair';
      cv.style.cursor = cur;
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [x, y] = local(e), row = this.rowAt(y);
      if (!row) { app.selectClip(null); return; }
      if (row.kind === 'auto') return this.autoDown(e, row, x, y);
      const t = row.t;
      app.selectTrack(t.id);
      const hc = hitClip(t, x);
      if (!hc) {                                             // drag on empty lane: draw a new clip
        app.selectClip(null);
        if (t.kind === 'audio') return;
        const b0 = this.snap(this.beat(x), true);
        dragPointer(e, (m) => {
          const [mx] = local(m), b1 = this.snap(this.beat(mx));
          const len = Math.max(this.p.sig, b1 - b0);
          this.ghost = Math.abs(mx - x) > 6 ? { start: b0, len, y: row.y - this.app.view.sy } : null;
          this.lanes.redraw();
        }, () => {
          const g = this.ghost; this.ghost = null;
          if (g) this.createClip(t, g.start, g.len);
          this.lanes.redraw();
        });
        return;
      }
      let clip = hc.clip;
      if (e.altKey && !hc.edge) {                            // Alt-drag: a copy
        const copy = structuredClone(clip); copy.id = uid('c');
        app.store.change((p) => p.tracks.find((x2) => x2.id === t.id).clips.push(copy));
        clip = copy;
      }
      app.selectClip(clip.id, t.id);
      const start0 = clip.start, len0 = clip.len, off0 = clip.offset || 0, b0 = this.beat(x), id = clip.id;
      const spb = 60 / this.p.bpm, asset = t.kind === 'audio' ? app.assets.get(clip.src) : null;
      const maxLen = asset ? (asset.L.length / 44100 - off0) / spb : Infinity;
      let trackId = t.id;
      const tag = 'clip' + uid();
      cv.style.cursor = hc.edge || hc.left ? 'ew-resize' : 'grabbing';
      dragPointer(e, (m) => {
        const [mx, my] = local(m), db = this.beat(mx) - b0;
        app.store.change((p) => {
          const tr = p.tracks.find((q) => q.id === trackId), c = tr.clips.find((q) => q.id === id);
          if (hc.edge) {
            c.len = Math.min(maxLen, Math.max(this.app.view.snap || 0.25, this.snap(start0 + len0 + db) - start0));
          } else if (hc.left) {                              // audio: trim the start
            const ns = Math.min(start0 + len0 - 0.25, Math.max(start0 - off0 / spb, this.snap(start0 + db)));
            c.start = Math.max(0, ns); c.offset = Math.max(0, off0 + (c.start - start0) * spb); c.len = start0 + len0 - c.start;
          } else {
            c.start = Math.max(0, this.snap(start0 + db));
            const over = this.rowAt(my);
            if (over?.kind === 'track' && over.t.id !== trackId && over.t.kind === tr.kind) {
              tr.clips = tr.clips.filter((q) => q !== c);
              p.tracks.find((q) => q.id === over.t.id).clips.push(c);
              trackId = over.t.id;
              this.app.view.selTrack = trackId;
            }
          }
        }, tag);
      }, () => { app.store.endGesture(); cv.style.cursor = ''; });
    });
    cv.addEventListener('dblclick', (e) => {
      const [x, y] = local(e), row = this.rowAt(y);
      if (!row || row.kind !== 'track') return;
      const hc = hitClip(row.t, x);
      if (hc) { app.selectClip(hc.clip.id, row.t.id); app.showTab('edit'); return; }
      const start = Math.floor(this.beat(x) / this.p.sig) * this.p.sig;
      if (row.t.kind === 'audio') { app.pickAudio({ trackId: row.t.id, beat: start }); return; }
      this.createClip(row.t, start, this.p.sig);
    });
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // audio files dropped on the lanes: on the audio track under them, or a new one
    const lanes = document.getElementById('lanes');
    lanes.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    lanes.addEventListener('drop', (e) => {
      e.preventDefault();
      const [x, y] = local(e), row = this.rowAt(y);
      const mids = [...e.dataTransfer.files].filter((f) => /\.midi?$/i.test(f.name));
      for (const f of mids) app.importMidiFile(f, Math.max(0, this.snap(this.beat(x), true))).catch((err) => app.toast(err.message));
      if (mids.length) return;
      const files = [...e.dataTransfer.files].filter((f) => /^audio\/|\.(wav|aiff?|mp3|ogg|flac|m4a)$/i.test(f.type + ' ' + f.name));
      if (!files.length) { app.toast('Drop audio files (WAV, MP3, FLAC, OGG…) here.'); return; }
      app.importAudio(files, { trackId: row?.t.kind === 'audio' ? row.t.id : null, beat: Math.max(0, this.snap(this.beat(x), true)) });
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = local(e), row = this.rowAt(y);
      if (row?.kind !== 'track') return;
      const hc = hitClip(row.t, x);
      if (hc) app.store.change((p) => { const tr = p.tracks.find((q) => q.id === row.t.id); tr.clips = tr.clips.filter((c) => c.id !== hc.clip.id); });
    });
  }
  createClip(t, start, len) {
    const c = newClip(start, len, t.kind === 'drum' ? 'BEAT' : 'CLIP');
    this.app.store.change((p) => p.tracks.find((x) => x.id === t.id).clips.push(c));
    this.app.selectClip(c.id, t.id);
    this.app.showTab('edit');
  }
  autoDown(e, row, x, y) {
    const app = this.app, t = row.t, key = app.view.autoTarget[t.id] || 'vol';
    const g = this.autoGeom?.[t.id];
    if (!g) return;
    const val = (yy) => {
      const k = 1 - (yy - (g.y + 6)) / (g.rh - 13);
      return Math.max(g.tgt.min, Math.min(g.tgt.max, g.tgt.min + k * (g.tgt.max - g.tgt.min)));
    };
    const tempo = t.kind === 'tempo';
    const listOf = (p, create) => { if (tempo) return p.tempo; const tr = p.tracks.find((q) => q.id === t.id); return create ? (tr.auto[key] ||= []) : tr.auto[key]; };
    const pts = (tempo ? this.p.tempo : t.auto[key]) || [];
    let idx = pts.findIndex((pt) => Math.abs(this.x(pt.t) - x) < 7 && Math.abs(g.vy(pt.v) - y) < 7);
    const tag = 'auto' + uid();
    if (e.detail >= 2 && idx >= 0) {
      app.store.change((p) => { const list = listOf(p); list.splice(idx, 1); if (!tempo && !list.length) delete p.tracks.find((q) => q.id === t.id).auto[key]; });
      return;
    }
    if (idx < 0) {
      const pt = { t: Math.max(0, this.snap(this.beat(x))), v: val(y) };
      app.store.change((p) => {
        const list = listOf(p, true);
        list.push(pt); list.sort((a, b) => a.t - b.t);
        idx = list.indexOf(pt);
      }, tag);
    }
    dragPointer(e, (m) => {
      const r = this.lanesCv.getBoundingClientRect();
      const mx = m.clientX - r.left, my = m.clientY - r.top;
      app.store.change((p) => {
        const list = listOf(p);
        const pt = list?.[idx];
        if (!pt) return;
        pt.t = Math.max(0, this.snap(this.beat(mx))); pt.v = val(my);
        list.sort((a, b) => a.t - b.t); idx = list.indexOf(pt);
      }, tag);
    }, () => app.store.endGesture());
  }
  wheel(e) {
    e.preventDefault();
    const v = this.app.view;
    if (e.ctrlKey || e.metaKey) {
      const r = this.lanesCv.getBoundingClientRect(), mx = e.clientX - r.left, b = this.beat(mx);
      v.zoom = Math.max(3, Math.min(240, v.zoom * Math.pow(1.0018, -e.deltaY)));
      v.sx = Math.max(0, b * v.zoom - mx);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      v.sx = Math.max(0, v.sx + (e.deltaX || e.deltaY));
    } else {
      const [, hh] = this.lanes.size();
      v.sy = Math.max(0, Math.min(Math.max(0, this.total - hh + 40), v.sy + e.deltaY));
      this.headsInner.style.transform = `translateY(${-v.sy}px)`;
      if (v.mode === 'session') this.app.session.render();
    }
    this.redraw();
  }
  follow(pos) {                                              // keep the playhead in view while playing
    const v = this.app.view, [w] = this.lanes.size(), x = this.x(pos);
    if (x > w - 40 || x < 0) { v.sx = Math.max(0, pos * v.zoom - 40); }
  }
}
