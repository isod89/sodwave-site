// SPDX-License-Identifier: GPL-3.0-only
// The arrangement: track heads, a bar ruler with the loop, clip lanes and automation lanes.
import { unzip } from '../io.js';
import { h, fitCanvas, dragPointer, ScrollBar } from './kit.js';
import { newClip, uid, cutRange, projectEnd, autoAt, curveOf, envAt } from '../project.js';
import { split, moveClips } from '../edit.js';
import { saveTrackPreset, loadTrackPresetSheet } from './presets.js';
import { DRAG_TYPE, dragHasAudio, droppedAudio } from './samples.js';
import { meterList, barOf, barStart, barLines, beatLines, barLabel } from '../meter.js';
import { DEVICES } from '../fx.js';
import { NOTE_FX, fmtNoteParam } from '../notefx.js';
import { isFolder, expandFolder, setComp, segmentAt, shiftFolder, isMidiFolder, compNotes } from '../comp.js';
// a fader's travel (as the mixer's: -60 dB at the bottom, +6 at the top, 0 dB about three quarters up)
const dbToPos = (db) => (db <= -60 ? 0 : Math.pow((db + 60) / 66, 2));
const posToDb = (q) => (q <= 0.0005 ? -60 : Math.sqrt(q) * 66 - 60);
const fmtDb = (db) => (db <= -60 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

// the ruler, top to bottom: the LOOP band, the PUNCH band, the bar numbers (click: playhead)
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;   // fingers: a taller ruler, bigger grips
const BAND = COARSE ? 16 : 12, LOOP_Y = 0, PUNCH_Y = BAND + 1, NUM_Y = 2 * BAND + 2, GRIP = COARSE ? 16 : 7;
const EDGE = 7;                            // px from a clip's end that resizes it
const TAKE_H = 34;                         // a take lane

export function autoTargets(app, t) {
  if (t.kind === 'tempo') return [{ key: 'tempo', label: 'TEMPO', min: 40, max: 240, def: 120, fmt: (v) => `${v.toFixed(1)} BPM` }];
  if (t.kind === 'macros') return app.store.p.macros.map((m, i) => ({ key: `m${i}`, label: m.name, min: 0, max: 1, def: 0, fmt: (v) => `${Math.round(v * 100)}%` }));
  const list = [
    { key: 'vol', label: 'VOLUME', min: -60, max: 6, def: 0, fmt: (v) => `${v.toFixed(1)} dB` },
    { key: 'pan', label: 'PAN', min: -1, max: 1, def: 0, fmt: (v) => (Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) },
    ...app.store.p.returns.map((r, i) => ({ key: `send${i}`, label: `SEND ${r.name}`, min: 0, max: 1, def: 0, fmt: (v) => `${Math.round(v * 100)}%` })),
  ];
  for (const d of t.fx || []) for (const p of DEVICES[d.type].params) {
    if (p.k === 'sc') continue;
    list.push({ key: `fx:${d.id}:${p.k}`, label: `${DEVICES[d.type].name} ${p.l}`, min: p.min, max: p.max, def: p.def, fmt: (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2)) });
  }
  for (const d of t.nfx || []) for (const p of NOTE_FX[d.type].params) {
    list.push({ key: `nfx:${d.id}:${p.k}`, label: `${NOTE_FX[d.type].name} ${p.l}`, min: p.min, max: p.max, def: p.def, fmt: (v) => fmtNoteParam(p, v) });
  }
  if (t.kind === 'lab') (t.lab?.macros || []).forEach((m, i) => list.push({ key: `p${i}`, label: `LAB ${m.name}`, min: 0, max: 127, def: Math.round(m.v * 127), fmt: (v) => `${Math.round(v / 1.27)}%` }));   // (its macros)
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
    Object.assign(v, { zoom: 22, sx: 0, sy: 0, trackH: COARSE ? 66 : 58, autoH: COARSE ? 76 : 64 });
    this.headsInner = document.getElementById('heads-inner');
    this.ruler = fitCanvas(document.getElementById('ruler'), (c, w, hh) => this.drawRuler(c, w, hh));
    this.lanesCv = document.getElementById('lanes-cv');
    this.lanes = fitCanvas(this.lanesCv, (c, w, hh) => this.drawLanes(c, w, hh));
    this.bindRuler();
    this.bindLanes();
    // scroll bars: the song sideways (to its end and 8 bars more), the tracks up and down
    const lanesBox = document.getElementById('lanes');
    this.hbar = new ScrollBar(lanesBox, 'h', () => {
      const v = this.app.view, [w] = this.lanes.size(), p = this.p;
      const end = Math.max(projectEnd(p), p.loop.on ? p.loop.b : 0, ...(p.markers || []).map((m) => m.t), this.app.pos) + 8 * p.sig;
      return { pos: v.sx, view: w, total: Math.max(end * v.zoom, v.sx + w) };
    }, (x) => this.scrollTo(x, this.app.view.sy));
    this.vbar = new ScrollBar(lanesBox, 'v', () => { const [, hh] = this.lanes.size(); return { pos: this.app.view.sy, view: hh, total: this.total + 40 }; },
      (y) => this.scrollTo(this.app.view.sx, y));
    document.getElementById('heads').addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    app.store.on(() => { this.renderHeads(); this.redraw(); });
  }
  get p() { return this.app.store.p; }
  redraw() { this.ruler.redraw(); this.lanes.redraw(); }
  x(beat) { return beat * this.app.view.zoom - this.app.view.sx; }
  beat(x) { return (x + this.app.view.sx) / this.app.view.zoom; }
  snap(b, floor = false) {
    const s = this.app.view.snap || 0;
    if (s !== 0 && this.app.view.zoom < 10) {                // zoomed far out: on the bar lines (whatever their signature)
      const bb = barOf(this.p, Math.max(0, b));
      return floor || b - bb.start < bb.len / 2 ? bb.start : bb.start + bb.len;
    }
    const g = s === 0 ? 1 / 64 : Math.max(s, this.app.view.zoom < 22 ? 1 : s);
    return (floor ? Math.floor(b / g) : Math.round(b / g)) * g;
  }
  rows() {
    const v = this.app.view, out = [];
    let y = 0;
    if (v.tempoLane) {                                       // the tempo map, as an automation lane
      out.push({ kind: 'auto', t: { id: '__tempo', kind: 'tempo', name: 'TEMPO', color: '#ff5b14', auto: { tempo: this.p.tempo } }, y, h: v.autoH });
      y += v.autoH;
    }
    if (v.macroLane) {                                       // the macros' automation, one lane for all eight (pick one)
      out.push({ kind: 'auto', t: { id: '__macros', kind: 'macros', name: 'MACROS', color: '#ffc21a', auto: this.p.macroAuto }, y, h: v.autoH });
      y += v.autoH;
    }
    // a folded group hides the tracks that play through it (and theirs)
    const hidden = (t) => { for (let g = this.p.tracks.find((x) => x.id === t.out), k = 0; g && k < 16; g = this.p.tracks.find((x) => x.id === g.out), k++) if (g.fold) return true; return false; };
    for (const t of this.p.tracks) {
      if (t.out !== 'master' && hidden(t)) continue;
      const th = t.h ? Math.round(t.h * (COARSE ? 1.14 : 1)) : v.trackH;
      out.push({ kind: 'track', t, y, h: th });
      y += th;
      if (v.takesOpen?.has(t.id)) {                                  // its take lanes, one a take (audio or MIDI)
        const n = Math.max(0, ...t.clips.filter(isFolder).map((c) => c.takes.length), ...t.clips.filter(isMidiFolder).map((c) => c.mtakes.length));
        for (let k = 0; k < n; k++) { out.push({ kind: 'take', t, k, y, h: TAKE_H }); y += TAKE_H; }
      }
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
      if (r.kind === 'take') {
        return h('div', { class: 'take-head', '--ah': TAKE_H + 'px', '--c': t.color },
          h('span', { text: `TAKE ${r.k + 1}` }),
          h('button', { class: 'tb', title: `Use take ${r.k + 1} everywhere on this track`, onclick: () => app.store.change((p) => {
            for (const c of p.tracks.find((x) => x.id === t.id).clips) {
              if (isFolder(c) && c.takes[r.k]) c.comp = setComp(c.comp, 0, c.len, r.k);
              else if (isMidiFolder(c) && c.mtakes[r.k]) { c.comp = setComp(c.comp, 0, c.loop || c.len, r.k); c.notes = compNotes(c); }
            }
          }) }, 'ALL'),
          r.k === 0 ? h('button', { class: 'tb', title: 'Hide the take lanes', onclick: () => app.toggleTakes(t.id) }, '×') : null);
      }
      if (r.kind === 'auto') {
        const targets = autoTargets(app, t);
        const cur = v.autoTarget[t.id] || 'vol';
        const sel = h('select', { 'aria-label': 'Automation target', onchange: (e) => { v.autoTarget[t.id] = e.target.value; this.redraw(); } },
          targets.map((a) => h('option', { value: a.key, selected: a.key === cur ? true : null }, (t.auto[a.key]?.length ? '● ' : '') + a.label)));
        if (t.kind === 'tempo') return h('div', { class: 'auto-head', '--ah': v.autoH + 'px' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', font: '700 10px/1 var(--f-ui)', letterSpacing: '0.12em', color: '#ff5b14' } }, 'TEMPO MAP',
            h('button', { class: 'tb', title: 'Hide the tempo lane', onclick: () => { v.tempoLane = false; this.renderHeads(); this.redraw(); } }, '×')),
          h('small', { text: this.p.tempo.length ? 'Points ramp to the next one.' : `${this.p.bpm} BPM all along: add points.` }),
          this.p.tempo.length ? h('button', { class: 'add', style: { height: '20px' }, title: 'Remove the tempo map: the BPM field sets the tempo again', onclick: () => app.store.change((p) => { p.tempo = []; }) }, 'CLEAR MAP') : null);
        if (t.kind === 'macros') return h('div', { class: 'auto-head', '--ah': v.autoH + 'px' },
          h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, sel, h('button', { class: 'tb', title: 'Hide the macro lane', onclick: () => { v.macroLane = false; this.renderHeads(); this.redraw(); } }, '×')),
          h('small', { text: 'MACROS: points move the macro (and all it turns)' }));
        return h('div', { class: 'auto-head', '--ah': v.autoH + 'px' }, h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, sel,
          h('button', { class: 'tb' + (v.pencil ? ' on' : ''), title: 'PENCIL: drag to draw the automation (on the grid)', 'aria-pressed': String(!!v.pencil), onclick: () => { v.pencil = !v.pencil; this.renderHeads(); } }, '✎')),
          h('small', { text: v.pencil ? 'Drag: draw · right-click: curves, clear' : COARSE ? 'Tap: a point · drag it: move · hold: curves, clear' : 'Click: a point · Alt-drag a line: curve · right-click: more' }));
      }
      const grp = t.out && t.out !== 'master' ? this.p.tracks.find((x) => x.id === t.out) : null;
      const snd = (t.frozen ? '❄ ' : '') + (grp ? `→ ${grp.name} · ` : '') + (t.kind === 'drum' ? `KIT ${app.lib.sloop.kits[t.kit] ?? ''}`
        : t.kind === 'audio' ? `AUDIO · ${t.clips.length} CLIP${t.clips.length === 1 ? '' : 'S'}`
        : t.kind === 'group' ? `GROUP · ${this.p.tracks.filter((x) => x.out === t.id).length} TRACKS`
        : t.kind === 'vca' ? `VCA · ${this.p.tracks.filter((x) => x.vca === t.id).length} TRACKS`
        : t.kind === 'wam' ? `PLUGIN · ${t.wam?.name || 'NONE'}`
        : t.kind === 'sampler' ? `SAMPLER · ${t.sample?.name || 'NO SAMPLE'}`
        : t.kind === 'lab' ? `LAB · ${t.lab?.name || ''}`
        : t.kind === 'external' ? `MIDI OUT · ${t.ext?.port || 'NO PORT'} CH ${t.ext?.ch || 1}`
        : `${app.lib[t.bank].engines[t.engine]?.name} · ${app.lib[t.bank].engines[t.engine]?.presets[t.preset] ?? ''}${t.dx7 ? ' · ' + t.dx7.name : ''}${t.mpe ? ' · MPE' : ''}`);
      const LEARN = { m: 'mute', s: 'solo', r: 'arm' };
      const tb = (cls, label, on, title, fn) => h('button', { class: `tb ${cls}${on ? ' on' : ''}`, title, 'aria-pressed': on ? 'true' : 'false', 'data-learn': LEARN[cls] ? `t:${t.id}:${LEARN[cls]}` : null, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
      const name = h('div', { class: 'name', text: t.name, title: 'Double-click to rename', onclick: () => {} });   // (a tap target of its own)
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        name.contentEditable = 'true'; name.focus();
        document.getSelection().selectAllChildren(name);
        let cancel = false;
        const done = () => {
          name.contentEditable = 'false';
          if (cancel) { name.textContent = t.name; return; }
          const nv = name.textContent.trim().slice(0, 24) || t.name;
          if (nv !== t.name) app.store.change((p) => { p.tracks.find((x) => x.id === t.id).name = nv; });
        };
        name.addEventListener('blur', done, { once: true });
        name.addEventListener('keydown', (k) => { if (k.key === 'Enter' || k.key === 'Escape') { cancel = k.key === 'Escape'; k.preventDefault(); name.blur(); } k.stopPropagation(); });
      });
      const depth = (() => { let k = 0; for (let g = this.p.tracks.find((x) => x.id === t.out); g && k < 6; g = this.p.tracks.find((x) => x.id === g.out)) k++; return k; })();
      const head = h('div', { class: 'head' + (t.id === v.selTrack ? ' sel' : '') + (depth ? ' kid' : '') + (t.kind === 'vca' ? ' vca' : '') + (t.kind === 'group' ? ' grp' : ''), '--h': r.h + 'px', '--c': t.color, '--depth': depth, 'data-id': t.id,
        oncontextmenu: (e) => { e.preventDefault(); this.trackSheet(t); },
        onpointerdown: (e) => {
          if (e.target.closest('button, [contenteditable="true"]')) return;
          const hb = e.currentTarget.getBoundingClientRect();
          if (e.pointerType !== 'touch' && e.button === 0 && e.clientY > hb.bottom - 6) { this.heightDrag(e, t, r.h); return; }   // its bottom edge: its height
          if (e.pointerType !== 'touch') { if (e.button === 0) { app.selectTrack(t.id); this.reorderDrag(e, t); } return; }
          const y0 = e.clientY, sy0 = v.sy; let moved = false;
          const timer = setTimeout(() => { if (!moved) { navigator.vibrate?.(12); this.trackSheet(t); } }, 500);
          const mv = (m) => { if (Math.abs(m.clientY - y0) > 8) { moved = true; clearTimeout(timer); } if (moved) this.scrollTo(v.sx, sy0 - (m.clientY - y0)); };
          const up = () => { clearTimeout(timer); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); if (!moved) app.selectTrack(t.id); };
          window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
        } },
        h('span', { class: 'chip' }), name,
        t.kind === 'group' ? h('button', { class: 'tb fold', title: t.fold ? 'Show the tracks of this group' : 'Fold: hide the tracks of this group', 'aria-expanded': String(!t.fold), onclick: (e) => { e.stopPropagation(); app.store.change((p) => { const g = p.tracks.find((x) => x.id === t.id); if (g.fold) delete g.fold; else g.fold = true; }); } }, t.fold ? '▸' : '▾') : null,
        h('div', { class: 'btns' },
          tb('m', 'M', t.mute, 'Mute', () => app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.mute = !x.mute; })),
          t.kind === 'vca' ? null : tb('s', 'S', t.solo, 'Solo', () => app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.solo = !x.solo; })),
          t.kind === 'vca' || t.kind === 'group' ? null : tb('r', '●', t.arm, t.kind === 'audio' ? 'Arm for recording (several audio tracks can record at once, each from its input)' : 'Arm for recording', () => app.armTrack(t.id)),
          tb('a', 'A', v.autoOpen.has(t.id), 'Automation', () => { v.autoOpen.has(t.id) ? v.autoOpen.delete(t.id) : v.autoOpen.add(t.id); this.renderHeads(); this.redraw(); }),
          tb('x', '×', false, 'Delete this track…', () => app.deleteTrack(t.id)),
          tb('d', '⧉', false, 'Duplicate this track', () => app.duplicateTrack(t.id))),
        h('div', { class: 'snd', text: snd, title: snd }),
        typeof t.vol === 'number' ? this.headVolume(t) : null,
        h('span', { class: 'meter' }, h('i')));
      return head;
    }));
    this.headsInner.style.transform = `translateY(${-v.sy}px)`;
  }
  meters(levels) {
    for (const el of this.headsInner.querySelectorAll('.head')) {
      const l = levels[el.dataset.id];
      if (!l) continue;
      const v = Math.min(1, Math.sqrt(Math.max(l[0], l[1]))).toFixed(3);
      el.querySelector('.meter').style.setProperty('--v', v);
      el.querySelector('.hvol')?.style.setProperty('--v', v);
    }
  }
  // a track's volume in its head: a thin fader over its level. Drag it (Shift: finely), double-click: 0 dB, arrows
  headVolume(t) {
    const app = this.app;
    const set = (db) => app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x) x.vol = Math.round(Math.max(-60, Math.min(6, db)) * 10) / 10; }, 'vol' + t.id);
    return h('div', { class: 'hvol', role: 'slider', tabindex: 0, 'aria-label': `${t.name} volume`, 'aria-valuemin': -60, 'aria-valuemax': 6, 'aria-valuenow': t.vol,
      title: `Volume ${fmtDb(t.vol)} dB · drag · double-click: 0 dB`, '--p': `${(dbToPos(t.vol) * 100).toFixed(2)}%`,
      onpointerdown: (e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        const el = e.currentTarget, w = el.getBoundingClientRect().width, x0 = e.clientX, q0 = dbToPos(t.vol);
        el.classList.add('drag');
        const mv = (m) => set(posToDb(Math.max(0, Math.min(1, q0 + (m.clientX - x0) / w * (m.shiftKey ? 0.2 : 1)))));
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); app.store.endGesture?.(); };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      },
      ondblclick: (e) => { e.stopPropagation(); set(0); app.store.endGesture?.(); },
      onkeydown: (e) => { const d = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5 }[e.key]; if (d) { e.preventDefault(); e.stopPropagation(); set(t.vol + d); app.store.endGesture?.(); } } },
    h('i'));
  }

  // --------------------------------------------------------------- ruler ---
  drawRuler(c, w, hh) {
    const p = this.p, v = this.app.view, hot = this.rulerHot;
    c.fillStyle = '#0b0c0d'; c.fillRect(0, 0, w, hh);
    c.fillStyle = '#131517'; c.fillRect(0, LOOP_Y, w, BAND); c.fillRect(0, PUNCH_Y, w, BAND);
    c.font = '700 8px "IBM Plex Mono", monospace'; c.textBaseline = 'middle'; c.textAlign = 'right';
    c.fillStyle = '#3d4248'; c.fillText('LOOP', w - 6, LOOP_Y + BAND / 2 + 0.5); c.fillText('PUNCH', w - 6, PUNCH_Y + BAND / 2 + 0.5);
    c.textAlign = 'left';
    const bars = (b) => barLabel(p, b);
    this.drawRegion(c, p.loop, LOOP_Y, p.loop.on ? '#ff5b14' : '#4a5057', p.loop.on ? 'LOOP' : 'LOOP OFF', hot?.key === 'loop' ? hot.mode : null, true);
    this.drawRegion(c, p.punch, PUNCH_Y, '#ff2f2f', p.punch.on ? `PUNCH IN ${bars(p.punch.a)} · OUT ${bars(p.punch.b)}` : (COARSE ? 'PUNCH OFF · tap to arm' : 'PUNCH OFF · click to arm'), hot?.key === 'punch' ? hot.mode : null, p.punch.on);
    const L = meterList(p), bar = p.sig, every = v.zoom * bar < 34 ? (v.zoom * bar < 14 ? 8 : 4) : 1;
    c.font = '500 10px "IBM Plex Mono", monospace';
    this.sigBoxes = [];
    for (const bl of barLines(p, Math.max(0, this.beat(0)), this.beat(w), L)) {
      const x = Math.round(this.x(bl.t)) + 0.5;
      const major = bl.bar % every === 0 || bl.change;
      c.strokeStyle = major ? '#5b6168' : '#2f343a';
      c.beginPath(); c.moveTo(x, major ? NUM_Y : hh - 6); c.lineTo(x, hh); c.stroke();
      if (major) { c.fillStyle = '#9aa0a6'; c.fillText(String(bl.bar + 1), x + 4, NUM_Y + (hh - NUM_Y) / 2); }
      if (bl.change || (bl.bar === 0 && (bl.n !== 4 || bl.d !== 4))) {          // a signature: a small tag under the number
        const label = `${bl.n}/${bl.d}`, nx = x + 4 + c.measureText(String(bl.bar + 1)).width + 4;   // (after the bar number)
        c.font = '700 8px "IBM Plex Mono", monospace';
        const tw = c.measureText(label).width + 6, ty = NUM_Y + (hh - NUM_Y) / 2;
        c.fillStyle = '#8a5cff'; c.fillRect(nx, ty - 6, tw, 12);
        c.fillStyle = '#0b0c0d'; c.fillText(label, nx + 3, ty + 0.5); c.font = '500 10px "IBM Plex Mono", monospace';
        this.sigBoxes.push({ t: bl.t, x0: nx - 2, x1: nx + tw });
      }
    }
    // markers: a yellow tag each, on the bar numbers
    this.markerBoxes = [];
    c.font = '700 8px "IBM Plex Mono", monospace';
    for (const m of [...(p.markers || [])].sort((a, b) => a.t - b.t)) {
      const x = Math.round(this.x(m.t)), tw = c.measureText(m.name).width + 8;
      if (x + tw < 0 || x > w) continue;
      const hot = this.markerHot === m.id;
      c.fillStyle = hot ? '#ffe066' : '#ffc400'; c.fillRect(x, NUM_Y + 1, tw, 11); c.fillRect(x, NUM_Y + 1, 1, hh - NUM_Y - 1);
      c.fillStyle = '#131415'; c.fillText(m.name, x + 4, NUM_Y + 7);
      this.markerBoxes.push({ id: m.id, x0: x - 2, x1: x + tw });
    }
    const px = this.x(this.app.pos);
    c.fillStyle = '#ff5b14';
    c.beginPath(); c.moveTo(px - 5, hh - 7); c.lineTo(px + 5, hh - 7); c.lineTo(px, hh); c.fill();
  }
  markerAt(x, y) { if (y < NUM_Y) return null; return (this.markerBoxes || []).findLast?.((b) => x >= b.x0 && x <= b.x1) ?? [...(this.markerBoxes || [])].reverse().find((b) => x >= b.x0 && x <= b.x1) ?? null; }
  // a region of the ruler (loop or punch) as a block with a handle at each end, like a clip
  drawRegion(c, R, y, col, label, hot, on) {
    const xa = this.x(R.a), xb = this.x(R.b), wd = xb - xa, top = y + 1, ht = BAND - 2;
    if (on) { c.fillStyle = col; c.globalAlpha = hot === 'move' ? 1 : 0.88; c.fillRect(xa, top, wd, ht); c.globalAlpha = 1; }
    else {                                                   // off: a quiet outline (it shows itself under the pointer)
      c.fillStyle = hot ? col + '22' : '#ffffff08'; c.fillRect(xa, top, wd, ht);
      if (hot) { c.strokeStyle = col + '99'; c.setLineDash([3, 2]); c.strokeRect(xa + 0.5, top + 0.5, wd - 1, ht - 1); c.setLineDash([]); }
    }
    for (const [x, m] of [[xa, 'a'], [xb - 5, 'b']]) {                         // the grips
      c.fillStyle = hot === m ? '#ffffff' : on ? '#ffe2d6' : hot ? col + 'aa' : '#ffffff22'; c.fillRect(x, top, on || hot ? 5 : 2, ht);
    }
    c.font = '700 8px "IBM Plex Mono", monospace';
    const tw = c.measureText(label).width;
    if (wd > tw + 16 && (on || hot)) { c.fillStyle = on ? '#0b0c0d' : col; c.fillText(label, xa + 8, y + BAND / 2 + 0.5); }
  }
  rulerHit(x, y) {
    const key = y < PUNCH_Y ? 'loop' : y < NUM_Y ? 'punch' : null;
    if (!key) return null;
    const R = this.p[key], xa = this.x(R.a), xb = this.x(R.b);
    const da = Math.abs(x - xa), db = Math.abs(x - xb);
    let mode = 'new';
    if (Math.min(da, db) <= GRIP) mode = da <= db ? 'a' : 'b';
    else if (x > xa && x < xb) mode = 'move';
    return { key, mode };
  }
  bindRuler() {
    const cv = document.getElementById('ruler'), app = this.app;
    cv.onclick = () => {};                                     // (a tap target of its own: a finger near its edge stays on it)
    const TIPS = {
      loop: 'LOOP: drag its ends to resize it, its middle to move it; click it to turn the loop on / off; drag on the empty band to draw a new one',
      punch: 'PUNCH IN / OUT: when on, recording only keeps what is played inside the red zone. Drag its ends to resize it, its middle to move it; click it to turn it on / off',
    };
    cv.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const r = cv.getBoundingClientRect(), hit = this.rulerHit(e.clientX - r.left, e.clientY - r.top);
      const mk = this.markerAt(e.clientX - r.left, e.clientY - r.top);
      cv.style.cursor = mk ? 'pointer' : !hit ? '' : hit.mode === 'move' ? 'grab' : hit.mode === 'new' ? 'crosshair' : 'ew-resize';
      cv.title = mk ? 'Marker: click to jump · drag to move · double-click to rename · right-click to delete' : hit ? TIPS[hit.key] : 'Click or drag: move the playhead · double-click: a marker here (N) · right-click: the time signature from this bar';
      if ((mk?.id ?? null) !== (this.markerHot ?? null)) { this.markerHot = mk?.id ?? null; this.ruler.redraw(); }
      const was = this.rulerHot;
      if (hit?.key !== was?.key || hit?.mode !== was?.mode) { this.rulerHot = hit; this.ruler.redraw(); }
    });
    cv.addEventListener('pointerleave', () => { if (this.rulerHot || this.markerHot) { this.rulerHot = null; this.markerHot = null; this.ruler.redraw(); } });
    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (y < NUM_Y) return;
      const mk = this.markerAt(x, y);
      if (mk) app.renameMarker(mk.id); else app.addMarker(Math.max(0, this.snap(this.beat(x))));
    });
    cv.addEventListener('contextmenu', (e) => {
      const r = cv.getBoundingClientRect(), mk = this.markerAt(e.clientX - r.left, e.clientY - r.top);
      if (!mk && e.clientY - r.top >= NUM_Y) { e.preventDefault(); app.signatureDialog(Math.max(0, this.beat(e.clientX - r.left))); return; }
      if (!mk) { e.preventDefault(); app.rangeSheet(); return; }          // the LOOP / PUNCH bands: the loop range's edits
      e.preventDefault();
      app.store.change((pp) => { pp.markers = pp.markers.filter((m) => m.id !== mk.id); });
    });
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const at = (m) => Math.max(0, this.beat(m.clientX - r.left));
      const hit = this.rulerHit(x, y), mk = e.button === 0 && this.markerAt(x, y);
      if (e.button !== 0) return;
      const sg = y >= NUM_Y && (this.sigBoxes || []).find((b) => x >= b.x0 && x <= b.x1);
      if (sg && !mk) { app.signatureDialog(sg.t); return; }        // a signature tag: change it
      if (mk) {                                                  // a marker: click to jump, drag to move
        const m0 = this.p.markers.find((m) => m.id === mk.id), t0 = m0.t, tag = 'mk' + Math.random();
        let moved = false;
        dragPointer(e, (m) => {
          if (!moved && Math.abs(m.clientX - e.clientX) < 3) return;
          moved = true;
          const t = Math.max(0, this.snap(t0 + (m.clientX - e.clientX) / app.view.zoom));
          app.store.change((pp) => { const x = pp.markers.find((q) => q.id === mk.id); if (x) x.t = t; }, tag);
        }, () => { if (!moved) app.seek(t0); app.store.endGesture(); });
        return;
      }
      if (!hit) {
        app.seek(this.snap(at(e)));
        dragPointer(e, (m) => app.seek(this.snap(at(m))));
        return;
      }
      const { key, mode } = hit, s = Math.max(1, app.view.snap || 1), start = at(e);
      const R0 = { ...this.p[key] }, tag = key + Math.random();
      let moved = false;
      const set = (a, b) => app.store.change((pp) => { pp[key] = { ...pp[key], a, b, on: true }; }, tag);
      if (mode === 'new') { const bb = barOf(this.p, start); set(bb.start, barStart(this.p, bb.bar + 4)); }
      cv.style.cursor = mode === 'move' ? 'grabbing' : cv.style.cursor;
      dragPointer(e, (m) => {
        if (!moved && Math.abs(m.clientX - e.clientX) < 3) return;
        moved = true;
        const cur = at(m), q = (b) => Math.round(b / s) * s;
        if (mode === 'a') set(Math.max(0, Math.min(q(cur), R0.b - s)), R0.b);
        else if (mode === 'b') set(R0.a, Math.max(q(cur), R0.a + s));
        else if (mode === 'move') { const a = Math.max(0, R0.a + q(cur - start)); set(a, a + R0.b - R0.a); }
        else { const lo = Math.min(start, cur), hi = Math.max(start, cur), a = Math.floor(lo / s) * s; set(a, Math.max(a + s, Math.ceil(hi / s) * s)); }
      }, () => {
        if (!moved && mode !== 'new') {                          // a click: on / off
          if (key === 'punch') app.togglePunch(); else app.store.change((pp) => { pp.loop.on = !pp.loop.on; }, tag);
        } else if (key === 'punch' && !R0.on) app.punchHint();
        app.store.endGesture(); cv.style.cursor = '';
      });
    });
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  // --------------------------------------------------------------- lanes ---
  drawLanes(c, w, hh) {
    const p = this.p, v = this.app.view, rows = this.rows();
    c.fillStyle = '#0b0c0d'; c.fillRect(0, 0, w, hh);
    // loop shade
    if (p.loop.on) { c.fillStyle = 'rgba(255,91,20,0.045)'; c.fillRect(this.x(p.loop.a), 0, this.x(p.loop.b) - this.x(p.loop.a), hh); }
    if (p.punch?.on) {                                       // punch: a red zone with its in / out lines
      const a = this.x(p.punch.a), b = this.x(p.punch.b);
      c.fillStyle = 'rgba(255,47,47,0.07)'; c.fillRect(a, 0, b - a, hh);
    }
    // grid
    const L = meterList(p), a0 = Math.max(0, this.beat(0)), a1 = this.beat(w);
    if (v.zoom >= 12) for (const bt of beatLines(p, a0, a1, L)) if (!bt.down) { c.fillStyle = '#141618'; c.fillRect(Math.round(this.x(bt.t)), 0, 1, hh); }
    for (const bl of barLines(p, a0, a1, L)) { c.fillStyle = bl.bar % 4 === 0 || bl.change ? '#2a2e33' : '#1c1f22'; c.fillRect(Math.round(this.x(bl.t)), 0, 1, hh); }
    this.badges = [];
    for (const r of rows) {
      const y = r.y - v.sy;
      if (y > hh || y + r.h < 0) continue;
      c.fillStyle = '#1a1d20'; c.fillRect(0, y + r.h - 1, w, 1);
      if (r.kind === 'track') this.drawClips(c, r.t, y, r.h, w);
      else if (r.kind === 'take') this.drawTake(c, r, y, r.h, w);
      else this.drawAuto(c, r.t, y, r.h, w);
    }
    if (this.box) {                                          // the selection box (Shift-drag)
      const b = this.box;
      c.fillStyle = '#ffffff14'; c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      c.strokeStyle = '#ffffffaa'; c.setLineDash([4, 3]); c.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0); c.setLineDash([]);
    }
    if (this.ghost) {
      const g = this.ghost;
      c.strokeStyle = '#ffffff88'; c.setLineDash([4, 3]);
      c.strokeRect(this.x(g.start) + 0.5, g.y + 3.5, (g.len) * v.zoom - 1, (g.h || v.trackH) - 8);
      c.setLineDash([]);
    }
    if (this.total - v.sy < hh && p.tracks.every((x) => !x.clips?.length)) {   // (the how-to, until there is a clip)
      c.fillStyle = '#8a9096'; c.font = '600 10px Archivo, sans-serif';
      const touch = matchMedia('(pointer: coarse)').matches;
      c.fillText(!p.tracks.length ? 'Add a track with + TRACK, or pick a sound in the library'
        : touch ? 'Double-tap: a clip · drag: scroll · pinch: zoom' : 'Double-click or drag on a lane to add a clip · + TRACK adds a track', 12, this.total - v.sy + 22);
    }
    c.fillStyle = 'rgba(255,196,0,0.35)';                    // the markers
    for (const m of p.markers || []) { const x = Math.round(this.x(m.t)); if (x >= 0 && x <= w) for (let y = 0; y < hh; y += 6) c.fillRect(x, y, 1, 3); }
    if (p.punch?.on) {                                       // the punch in / out lines, over the clips
      c.fillStyle = 'rgba(255,47,47,0.8)';
      c.fillRect(Math.round(this.x(p.punch.a)), 0, 1, hh); c.fillRect(Math.round(this.x(p.punch.b)) - 1, 0, 1, hh);
    }
    const px = Math.round(this.x(this.app.pos)) + 0.5;
    c.strokeStyle = '#ff5b14'; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, hh); c.stroke();
    const sess = this.app.view.mode === 'session';
    if (this.hbar) { this.hbar.update(); this.vbar.update(); if (sess) this.hbar.el.hidden = this.vbar.el.hidden = true; }
  }
  drawClips(c, t, y, rh, w) {
    const v = this.app.view;
    for (const clip of t.clips) {
      const x0 = this.x(clip.start), x1 = this.x(clip.start + clip.len);
      if (x1 < 0 || x0 > w) continue;
      const sel = clip.id === v.selClip || !!v.sel?.has(clip.id);
      const top = y + 3, ht = rh - 7, wd = Math.max(3, x1 - x0 - 1);
      c.fillStyle = t.color + '2e'; c.fillRect(x0, top, wd, ht);
      c.fillStyle = t.color; c.fillRect(x0, top, wd, 13);
      if (t.mute) { c.fillStyle = '#0b0c0d99'; c.fillRect(x0, top, wd, ht); }
      c.save(); c.beginPath(); c.rect(x0, top, wd, ht); c.clip();
      c.fillStyle = '#0b0c0d'; c.font = '700 9px Archivo, sans-serif'; c.textBaseline = 'middle';
      c.fillText(clip.name.toUpperCase(), x0 + 4, top + 7);
      if (t.kind === 'audio') {
        if (isFolder(clip)) {                                  // a take folder: its comp, a seam where takes meet
          for (const sg of expandFolder(clip, 60 / this.p.bpm)) {
            const sx = this.x(sg.start);
            this.drawWave(c, t, sg, sx, top + 14, sg.len * v.zoom, ht - 14);
            if (sg.start > clip.start + 1e-6) { c.fillStyle = '#0b0c0d'; c.fillRect(Math.round(sx), top + 13, 1, ht - 13); }
          }
        } else if (clip.aloop && this.app.assets.get(clip.src)) {   // a looped clip: the file drawn again each turn
          const per = (this.app.assets.get(clip.src).L.length / 44100 - (clip.offset || 0)) / (60 / this.p.bpm);
          for (let b = 0; b < clip.len - 1e-6; b += per) this.drawWave(c, t, clip, x0 + b * v.zoom, top + 14, Math.min(per, clip.len - b) * v.zoom, ht - 14);
        } else this.drawWave(c, t, clip, x0, top + 14, wd, ht - 14);
        // the fades: a shade over the wave, a handle at each top corner to drag
        const spbSec = 60 / this.p.bpm, fi = (clip.fadeIn ?? 0.005) / spbSec * v.zoom, fo = (clip.fadeOut ?? 0.005) / spbSec * v.zoom;
        c.fillStyle = '#0b0c0d88';
        if (fi > 1.5) { c.beginPath(); c.moveTo(x0, top + 13); c.lineTo(x0 + fi, top + 13); c.lineTo(x0, top + ht); c.fill(); }
        if (fo > 1.5) { c.beginPath(); c.moveTo(x0 + wd, top + 13); c.lineTo(x0 + wd - fo, top + 13); c.lineTo(x0 + wd, top + ht); c.fill(); }
        // a crossfade across a seam (this clip's start, or the next one's): an X over the overlap
        const xfAt = (seam, xf) => { const hw = xf / 2 * v.zoom, sx = this.x(seam); c.strokeStyle = '#ffffffcc'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(sx - hw, top + 13); c.lineTo(sx + hw, top + ht); c.moveTo(sx - hw, top + ht); c.lineTo(sx + hw, top + 13); c.stroke(); c.lineWidth = 1; };
        if (clip.xf) xfAt(clip.start, clip.xf);
        const nx = t.clips.find((q) => q.xf && Math.abs(q.start - clip.start - clip.len) < 1e-6);
        if (nx) xfAt(nx.start, nx.xf);
        if (wd > 40) { c.fillStyle = '#fff'; c.fillRect(clip.xf ? x0 + clip.xf / 2 * v.zoom - 2 : Math.min(x0 + wd - 6, x0 + fi), top + 14, 5, 5); c.fillRect(Math.max(x0 + 1, x0 + wd - fo - 5), top + 14, 5, 5); }
        if (clip.env) {                                          // its gain envelope, a thin line
          c.strokeStyle = '#ffc21a'; c.beginPath();
          const ey = (db) => top + 14 + (12 - Math.max(-36, db)) / 48 * (ht - 15);
          c.moveTo(x0, ey(clip.env[0].v)); for (const q of clip.env) c.lineTo(this.x(clip.start + q.t), ey(q.v)); c.lineTo(x0 + wd, ey(clip.env.at(-1).v)); c.stroke();
        }
        if (clip.aloop) { const a = this.app.assets.get(clip.src); if (a) { const per = (a.L.length / 44100 - (clip.offset || 0)) / spbSec; c.fillStyle = '#0b0c0d'; for (let b = per; b < clip.len - 1e-6; b += per) c.fillRect(Math.round(x0 + b * v.zoom), top + 13, 1, ht - 13); } }
        if (clip.reversed) { c.fillStyle = '#0b0c0d'; c.font = '700 8px "IBM Plex Mono", monospace'; c.fillText('◀ REV', x0 + wd - 40, top + 7); }
        c.restore();
        if (isFolder(clip)) {                                  // the TAKES badge: shows / hides the take lanes
          const label = `${clip.takes.length} TAKES ${v.takesOpen?.has(t.id) ? '▴' : '▾'}`;
          c.font = '700 8px "IBM Plex Mono", monospace';
          const bw = c.measureText(label).width + 8, bx = Math.max(x0 + 2, x0 + wd - bw - 2);
          c.fillStyle = '#0b0c0d'; c.fillRect(bx, top + 2, bw, 10); c.fillStyle = t.color; c.fillText(label, bx + 4, top + 7.5);
          (this.badges ||= []).push({ x0: bx, x1: bx + bw, y0: top + v.sy, y1: top + 12 + v.sy, track: t.id });
        }
        if (sel) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.strokeRect(x0 + 0.75, top + 0.75, wd - 1.5, ht - 1.5); c.lineWidth = 1; }
        continue;
      }
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
      if (isMidiFolder(clip) && clip.mtakes.length > 1) {       // the TAKES badge: shows / hides the take lanes
        const label = `${clip.mtakes.length} TAKES ${v.takesOpen?.has(t.id) ? '▴' : '▾'}`;
        c.font = '700 8px "IBM Plex Mono", monospace';
        const bw = c.measureText(label).width + 8, bx = Math.max(x0 + 2, x0 + wd - bw - 2);
        c.fillStyle = '#0b0c0d'; c.fillRect(bx, top + 2, bw, 10); c.fillStyle = t.color; c.fillText(label, bx + 4, top + 7.5);
        (this.badges ||= []).push({ x0: bx, x1: bx + bw, y0: top + v.sy, y1: top + 12 + v.sy, track: t.id });
      }
      if (sel) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.strokeRect(x0 + 0.75, top + 0.75, wd - 1.5, ht - 1.5); c.lineWidth = 1; }
      if (this.lifted === clip.id) { c.strokeStyle = t.color; c.lineWidth = 3; c.strokeRect(x0 - 1, top - 1, wd + 2, ht + 2); c.lineWidth = 1; }
    }
  }
  // a take lane: take k of each folder, the parts in the comp lit
  drawTake(c, r, y, rh, w) {
    const t = r.t, k = r.k, v = this.app.view, spbSec = 60 / this.p.bpm;
    c.fillStyle = '#0e1011'; c.fillRect(0, y, w, rh - 1);
    for (const clip of t.clips) {
      if (isMidiFolder(clip) && clip.mtakes[k]) { this.drawMidiTake(c, t, clip, k, y, rh); continue; }
      if (!isFolder(clip) || !clip.takes[k]) continue;
      const tk = clip.takes[k], a = this.app.assets.get(tk.src);
      const audio0 = clip.start + tk.at - tk.offset / spbSec, audio1 = a ? audio0 + a.L.length / 44100 / spbSec : audio0;
      const v0 = Math.max(clip.start, audio0), v1 = Math.min(clip.start + clip.len, audio1);
      const cx0 = this.x(clip.start), cx1 = this.x(clip.start + clip.len);
      c.fillStyle = '#16191c'; c.fillRect(cx0, y + 2, cx1 - cx0, rh - 5);
      if (v1 > v0) {
        c.save(); c.globalAlpha = 0.35;
        this.drawWave(c, t, { src: tk.src, offset: (v0 - audio0) * spbSec, gain: clip.gain }, this.x(v0), y + 3, (v1 - v0) * v.zoom, rh - 7);
        c.restore();
      }
      for (const sg of clip.comp) {                               // this take's part of the comp
        if (sg.k !== k) continue;
        const sx = this.x(clip.start + sg.a), sw = (sg.b - sg.a) * v.zoom;
        c.fillStyle = t.color + '30'; c.fillRect(sx, y + 2, sw, rh - 5);
        c.fillStyle = t.color; c.fillRect(sx, y + 2, sw, 2);
        const s0 = Math.max(clip.start + sg.a, v0), s1 = Math.min(clip.start + sg.b, v1);
        if (s1 > s0) this.drawWave(c, t, { src: tk.src, offset: (s0 - audio0) * spbSec, gain: clip.gain }, this.x(s0), y + 5, (s1 - s0) * v.zoom, rh - 9);
      }
      c.fillStyle = '#737980'; c.font = '700 8px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
      c.fillText(tk.name || `TAKE ${k + 1}`, Math.max(cx0, 0) + 4, y + 10);
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
    const pts = this.autoList(this.p, t, key) || [];
    const vy = (val) => y + 6 + (1 - (val - tgt.min) / (tgt.max - tgt.min)) * (rh - 13);
    c.strokeStyle = t.color; c.lineWidth = 1.5;
    if (!pts.length) {
      const base = key === 'tempo' ? this.p.bpm : t.kind === 'macros' ? this.p.macros[+key.slice(1)]?.v ?? 0 : key === 'vol' ? t.vol : key === 'pan' ? t.pan : key.startsWith('send') ? t.sends[+key.slice(4)] ?? 0 : null;
      if (base != null) { c.setLineDash([3, 4]); c.globalAlpha = 0.5; c.beginPath(); c.moveTo(0, vy(base)); c.lineTo(w, vy(base)); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; }
    } else {
      c.beginPath(); c.moveTo(0, vy(pts[0].v));
      pts.forEach((pt, i) => {
        const nx = pts[i + 1];
        c.lineTo(this.x(pt.t), vy(pt.v));
        if (pt.c && nx) for (let k = 1; k < 24; k++) { const f = k / 24; c.lineTo(this.x(pt.t + (nx.t - pt.t) * f), vy(pt.v + (nx.v - pt.v) * curveOf(pt.c, f))); }   // a curve
      });
      c.lineTo(w, vy(pts[pts.length - 1].v)); c.stroke();
      c.fillStyle = t.color + '22'; c.lineTo(w, y + rh); c.lineTo(0, y + rh); c.fill();
      for (const pt of pts) { c.fillStyle = '#0b0c0d'; c.beginPath(); c.arc(this.x(pt.t), vy(pt.v), 3.5, 0, 7); c.fill(); c.stroke(); }
    }
    c.lineWidth = 1;
    c.fillStyle = '#737980'; c.font = '500 9px "IBM Plex Mono", monospace';
    const now = pts.length ? autoAt(pts, this.app.pos)
      : key === 'tempo' ? this.p.bpm : key === 'vol' ? t.vol : key === 'pan' ? t.pan : key.startsWith('send') ? t.sends[+key.slice(4)] ?? 0
      : key.startsWith('fx:') || key.startsWith('nfx:') ? (() => { const [k0, id, pk] = key.split(':'); return (k0 === 'fx' ? t.fx : t.nfx)?.find((d) => d.id === id)?.p[pk] ?? tgt.def; })()
      : key[0] === 'p' ? t.params?.[+key.slice(1)] ?? this.app.params.get(t.id)?.[+key.slice(1)] ?? tgt.def : tgt.def;   // no points: the knob's own value
    c.fillText(`${tgt.label} · ${tgt.fmt(now)}`, 6, y + 12);
    this.autoGeom = this.autoGeom || {};
    this.autoGeom[t.id] = { vy, tgt, y, rh };
  }

  bindLanes() {
    const cv = this.lanesCv, app = this.app;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const hitClip = (t, x, edge = EDGE) => this.hitClip(t, x, edge);
    this.bindPinch(cv, this.lanes);
    cv.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const [x, y] = local(e), row = this.rowAt(y);
      let cur = 'default';
      if (row?.kind === 'track') { const hc = hitClip(row.t, x); if (hc) cur = hc.edge || hc.left ? 'ew-resize' : 'grab'; else cur = row.t.kind === 'audio' ? 'default' : 'crosshair'; }
      else if (row?.kind === 'auto') cur = 'crosshair';
      else if (row?.kind === 'take') cur = 'cell';
      cv.style.cursor = cur;
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [x, y] = local(e), row = this.rowAt(y);
      if (this.pinch) return;
      if (e.pointerType === 'touch' && (!row || row.kind === 'track')) return this.touchTrack(e, row, x, y);
      if (e.pointerType === 'touch' && row.kind === 'auto' && !this.autoPointAt(row, x, y)) return this.touchAuto(e, row, x, y);
      if (!row) { app.selectClip(null); return; }
      if (row.kind === 'auto') return this.autoDown(e, row, x, y);
      if (row.kind === 'take') return this.takeDown(e, row, x);
      const badge = (this.badges || []).find((b) => x >= b.x0 && x <= b.x1 && y + this.app.view.sy >= b.y0 && y + this.app.view.sy <= b.y1);
      if (badge) { app.selectTrack(badge.track); app.toggleTakes(badge.track); return; }
      const t = row.t;
      app.selectTrack(t.id);
      const hc = hitClip(t, x);
      if (e.shiftKey && hc) { app.selectClip(hc.clip.id, t.id, true); return; }   // Shift-click: in or out of the selection
      if (e.shiftKey && !hc) return this.boxSelect(e, x, y);                     // Shift-drag on empty space: a box
      const fh = t.kind === 'audio' && hc && !isFolder(hc.clip) && this.fadeHit(hc.clip, row, x, y);
      if (fh) return this.fadeDrag(e, t, hc.clip, fh);
      if (!hc) {                                             // drag on empty lane: draw a new clip
        app.selectClip(null);
        if (t.kind === 'audio' || (t.kind === 'group' || t.kind === 'vca')) return;
        const b0 = this.snap(this.beat(x), true);
        dragPointer(e, (m) => {
          const [mx] = local(m), b1 = this.snap(this.beat(mx));
          const len = Math.max(this.p.sig, b1 - b0);
          this.ghost = Math.abs(mx - x) > 6 ? { start: b0, len, y: row.y - this.app.view.sy, h: row.h } : null;
          this.lanes.redraw();
        }, () => {
          const g = this.ghost; this.ghost = null;
          if (g) this.createClip(t, g.start, g.len);
          this.lanes.redraw();
        });
        return;
      }
      if (!hc.edge && !hc.left && app.view.sel?.size > 1 && app.view.sel.has(hc.clip.id)) return this.groupDrag(e, x);   // the selection, together
      const d = this.startClipDrag(t, hc, x, e.altKey);
      cv.style.cursor = hc.edge || hc.left ? 'ew-resize' : 'grabbing';
      dragPointer(e, d.move, () => { d.up(); cv.style.cursor = ''; });
    });
    cv.addEventListener('dblclick', (e) => {
      const [x, y] = local(e), row = this.rowAt(y);
      if (!row || row.kind !== 'track') return;
      const hc = hitClip(row.t, x);
      if (hc) { app.selectClip(hc.clip.id, row.t.id); app.showTab('edit'); return; }
      const bb = barOf(this.p, Math.max(0, this.beat(x))), start = bb.start;
      if (row.t.kind === 'audio') { app.pickAudio({ trackId: row.t.id, beat: start }); return; }
      this.createClip(row.t, start, bb.len);
    });
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // audio files dropped on the lanes: on the audio track under them, or a new one
    const lanes = document.getElementById('lanes');
    lanes.addEventListener('dragover', (e) => { if (dragHasAudio(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    lanes.addEventListener('drop', async (e) => {
      e.preventDefault();
      const [x, y] = local(e), row = this.rowAt(y);
      if ([...(e.dataTransfer?.types || [])].includes(DRAG_TYPE)) {          // a sample from the SAMPLES list
        const fs = await droppedAudio(app, e);
        if (fs.length) app.importAudio(fs, { trackId: row?.t.kind === 'audio' ? row.t.id : null, beat: Math.max(0, this.snap(this.beat(x), true)) });
        return;
      }
      const song = [...e.dataTransfer.files].find((f) => /\.sloopsong$/i.test(f.name));
      if (song) { app.openSloopSong(song); return; }
      const daw = [...e.dataTransfer.files].find((f) => /\.dawproject$/i.test(f.name));
      if (daw) { daw.arrayBuffer().then((b) => unzip(new Uint8Array(b))).then((en) => app.openDawproject(en)).catch((err) => app.toast(err.message)); return; }
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
      if (row?.kind === 'auto') { this.autoSheet(row, x, y); return; }
      if (row?.kind !== 'track') return;
      const hc = hitClip(row.t, x);
      if (hc) { if (!app.view.sel?.has(hc.clip.id)) app.selectClip(hc.clip.id, row.t.id); this.clipSheet(row.t, hc.clip, this.beat(x)); }
    });
  }
  // ---------------------------------------------------------------- touch ---
  // the view by fingers: v.sx / v.sy scrolled, the zoom pinched (around the fingers)
  scrollTo(sx, sy) {
    const v = this.app.view, [, hh] = this.lanes.size();
    v.sx = Math.max(0, sx);
    v.sy = Math.max(0, Math.min(Math.max(0, this.total - hh + 40), sy));
    this.headsInner.style.transform = `translateY(${-v.sy}px)`;
    if (v.mode === 'session') this.app.session.render();
    this.redraw();
  }
  bindPinch(el) {
    const pts = new Map();
    const start = () => {
      const [a, b] = [...pts.values()], v = this.app.view, r = this.lanesCv.getBoundingClientRect();
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx0: (a.x + b.x) / 2 - r.left, cy0: (a.y + b.y) / 2, zoom0: v.zoom, sx0: v.sx, sy0: v.sy };
      this.app.store.endGesture();
    };
    el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) start(); });
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this.pinch || pts.size < 2) return;
      const [a, b] = [...pts.values()], g = this.pinch, v = this.app.view, r = this.lanesCv.getBoundingClientRect();
      const zoom = Math.max(3, Math.min(240, g.zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0)), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2;
      const beat = (g.cx0 + g.sx0) / g.zoom0;
      v.zoom = zoom;
      this.scrollTo(beat * zoom - cx, g.sy0 - (cy - g.cy0));
    });
    const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2 && this.pinch) setTimeout(() => { if (pts.size < 2) this.pinch = null; }, 0); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  // one finger on a lane: drag scrolls; a tap selects; a double tap opens the clip (or writes one);
  // held still, the clip lifts: then drag moves it (its end: resizes), or let go for its menu
  touchTrack(e, row, x, y) {
    const app = this.app, v = app.view, t = row?.t, hc = t ? this.hitClip(t, x, 16) : null;
    const badge = (this.badges || []).find((b) => x >= b.x0 - 8 && x <= b.x1 + 8 && y + v.sy >= b.y0 - 8 && y + v.sy <= b.y1 + 8);
    if (badge) { app.selectTrack(badge.track); app.toggleTakes(badge.track); return; }
    const x0 = e.clientX, y0 = e.clientY, sx0 = v.sx, sy0 = v.sy;
    let mode = 'wait', drag = null;
    const timer = hc ? setTimeout(() => {
      if (mode !== 'wait') return;
      mode = 'lift'; navigator.vibrate?.(12);
      app.selectClip(hc.clip.id, t.id);
      this.lifted = hc.clip.id; this.redraw();
    }, 380) : 0;
    dragPointer(e, (m) => {
      if (this.pinch) { mode = 'gone'; clearTimeout(timer); return; }
      const dx = m.clientX - x0, dy = m.clientY - y0;
      if (mode === 'wait' && Math.hypot(dx, dy) > 8) { mode = 'pan'; clearTimeout(timer); }
      if (mode === 'pan') this.scrollTo(sx0 - dx, sy0 - dy);
      else if (mode === 'lift' && Math.hypot(dx, dy) > 4) { mode = 'move'; drag = this.startClipDrag(t, hc, x); }
      if (mode === 'move') drag.move(m);
    }, () => {
      clearTimeout(timer);
      this.lifted = null;
      if (mode === 'wait') {                                   // a tap, or the second tap of a double tap
        const now = performance.now(), last = this.lastTap, dbl = last && now - last.at < 320 && Math.hypot(x0 - last.x, y0 - last.y) < 30;
        this.lastTap = dbl ? null : { at: now, x: x0, y: y0 };
        if (t) app.selectTrack(t.id);
        if (hc) { app.selectClip(hc.clip.id, t.id); if (dbl) app.showTab('edit'); }
        else { app.selectClip(null); if (dbl && t && t.kind !== 'audio' && t.kind !== 'group' && t.kind !== 'vca') { const bb = barOf(this.p, Math.max(0, this.beat(x))); this.createClip(t, bb.start, barStart(this.p, bb.bar + 4) - bb.start); } }
      } else if (mode === 'lift') this.clipSheet(t, hc.clip);
      else if (mode === 'move') drag.up();
      this.redraw();
    });
  }
  // scroll a track into view
  reveal(trackId, withLanes = false) {
    const rows = this.rows(), i = rows.findIndex((q) => q.kind === 'track' && q.t.id === trackId), [, hh] = this.lanes.size(), v = this.app.view;
    if (i < 0) return;
    const r = rows[i];
    let end = r.y + r.h;
    if (withLanes) for (let j = i + 1; j < rows.length && rows[j].kind !== 'track'; j++) end = rows[j].y + rows[j].h;
    if (r.y < v.sy) this.scrollTo(v.sx, r.y);
    else if (end > v.sy + hh) this.scrollTo(v.sx, Math.min(r.y, end - hh + 8));
  }
  // drag a head up or down: the track moves there (mouse; on a touch screen: its menu, MOVE UP / DOWN)
  reorderDrag(e, t) {
    const app = this.app, y0 = e.clientY;
    let moved = false, target = null;
    const mv = (m) => {
      if (!moved && Math.abs(m.clientY - y0) < 6) return;
      moved = true;
      const r = this.lanesCv.getBoundingClientRect(), row = this.rowAt(m.clientY - r.top);
      target = row?.kind === 'track' ? row.t.id : null;
      this.dropMark = target && target !== t.id ? { id: target, below: m.clientY > y0 } : null;
      document.body.style.cursor = 'grabbing';
      this.renderHeadsMark();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      document.body.style.cursor = ''; this.dropMark = null; this.renderHeadsMark();
      if (!moved || !target || target === t.id) return;
      app.store.change((p) => {
        const from = p.tracks.findIndex((x) => x.id === t.id), [tr] = p.tracks.splice(from, 1);
        const to = p.tracks.findIndex((x) => x.id === target);
        p.tracks.splice(to + (from <= to ? 1 : 0), 0, tr);
      });
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  renderHeadsMark() {
    for (const el of this.headsInner.querySelectorAll('.head')) el.classList.toggle('drop', this.dropMark?.id === el.dataset.id);
  }
  // the menus a long press (or a right-click) opens: a clip's, a track's
  clipSheet(t, clip, at = null) {
    const app = this.app, many = app.selected().length > 1;
    const inside = at != null && at > clip.start + 1e-3 && at < clip.start + clip.len - 1e-3;
    app.sheet(clip.name, [
      ['OPEN IN THE EDITOR', () => { app.selectClip(clip.id, t.id); app.showTab('edit'); }],
      ...(inside ? [['SPLIT HERE', () => app.store.change((p) => split(p, at, { ids: [clip.id] }))]] : []),
      ['SPLIT AT THE PLAYHEAD (Ctrl+E)', () => app.splitAt()],
      ...(many ? [[t.kind === 'audio' ? 'CONSOLIDATE THE SELECTED (Ctrl+J)' : 'JOIN THE SELECTED (Ctrl+J)', () => app.joinSelected()]] : []),
      ...(t.kind === 'audio' && !isFolder(clip) ? [['REVERSE', () => app.reverseClip(t.id, clip.id)],
        ['CONVERT TO MIDI: MELODY (one note at a time)', () => app.audioToMidi(t.id, clip.id, 'melody')], ['CONVERT TO MIDI: DRUMS (kick, snare, hat)', () => app.audioToMidi(t.id, clip.id, 'drums')],
        [clip.aloop ? 'STOP LOOPING THE AUDIO' : 'LOOP THE AUDIO (drag its end to repeat it)', () => app.store.change((p) => { const c = p.tracks.find((x) => x.id === t.id).clips.find((x) => x.id === clip.id); c.aloop = !c.aloop; })]] : []),
      ['DUPLICATE AFTER IT', () => { const c = { ...structuredClone(clip), id: uid('c'), start: clip.start + clip.len }; app.placeClip(t.id, c); app.selectClip(c.id, t.id); }],
      ...(isFolder(clip) || isMidiFolder(clip) ? [[app.view.takesOpen?.has(t.id) ? 'HIDE THE TAKES' : 'SHOW THE TAKES', () => app.toggleTakes(t.id)], ['FLATTEN THE COMP', () => app.flattenComp(t.id, clip.id)]] : []),
      ['DELETE', () => app.store.change((p) => { const tr = p.tracks.find((x) => x.id === t.id); tr.clips = tr.clips.filter((c) => c.id !== clip.id); }), 'danger'],
    ]);
  }
  trackSheet(t) {
    const app = this.app, v = app.view, i = this.p.tracks.findIndex((x) => x.id === t.id);
    const move = (d) => app.store.change((p) => { const j = p.tracks.findIndex((x) => x.id === t.id), k = j + d; if (k >= 0 && k < p.tracks.length) [p.tracks[j], p.tracks[k]] = [p.tracks[k], p.tracks[j]]; });
    app.sheet(t.name, [
      ...(i > 0 ? [['MOVE UP', () => move(-1)]] : []), ...(i < this.p.tracks.length - 1 ? [['MOVE DOWN', () => move(1)]] : []),
      [t.kind === 'audio' ? 'THE AUDIO TRACK' : 'INSTRUMENT & EFFECTS', () => { app.selectTrack(t.id); app.showTab('device'); }],
      ['RENAME', () => app.renameTrack(t.id)],
      [v.autoOpen.has(t.id) ? 'HIDE THE AUTOMATION' : 'SHOW THE AUTOMATION', () => { v.autoOpen.has(t.id) ? v.autoOpen.delete(t.id) : v.autoOpen.add(t.id); this.renderHeads(); this.redraw(); }],
      ['DUPLICATE', () => app.duplicateTrack(t.id)],
      ['COLOUR…', () => this.colourSheet(t)],
      [`HEIGHT · ${(t.h || app.view.trackH) <= 40 ? 'SMALL' : (t.h || 0) >= 110 ? 'LARGE' : (t.h || 0) >= 80 ? 'TALL' : 'NORMAL'}`, () => app.sheet(`${t.name} · height`, [['SMALL', 34], ['NORMAL', 0], ['TALL', 88], ['LARGE', 130]].map(([l, hh]) => [l, () => app.store.change((p) => { const x = p.tracks.find((q) => q.id === t.id); if (hh) x.h = hh; else delete x.h; })]))],
      ...(t.kind === 'vca' ? [] : [[`VCA · ${this.p.tracks.find((x) => x.id === t.vca)?.name || 'NONE'}`, () => app.sheet(`${t.name} follows`, [['NONE', () => app.setVca(t.id, null)], ...this.p.tracks.filter((x) => x.kind === 'vca').map((x) => [x.name, () => app.setVca(t.id, x.id)]), ['A NEW VCA', () => { app.selectTrack(t.id); app.addVca(); }]])]]),
      ...(t.kind === 'vca' || t.kind === 'group' ? [] : [['BOUNCE TO AUDIO (with its effects)', () => app.bounceTrack(t.id)]]),
      ...((t.kind === 'group' || t.kind === 'vca') ? [] : [['SAVE AS A PRESET…', () => saveTrackPreset(app, t.id)], ['LOAD A PRESET…', () => loadTrackPresetSheet(app, t.id)]]),
      ['DELETE…', () => app.deleteTrack(t.id), 'danger'],
    ]);
  }
  // a track's colour: the palette, or any colour
  colourSheet(t) {
    const app = this.app, set = (c) => app.store.change((p) => { p.tracks.find((x) => x.id === t.id).color = c; });
    const swatches = ['#ff5b14', '#ff2f5b', '#ff4fa3', '#c45bff', '#8a5cff', '#3d6bff', '#2fa8ff', '#1fd0c0', '#27c46b', '#9ad12f', '#ffc21a', '#ff9a1a', '#c9ccc9', '#8a9097', '#b07a52', '#ffffff'];
    const pick = h('input', { type: 'color', value: t.color.length === 7 ? t.color : '#ff5b14', 'aria-label': 'Any colour', oninput: (e) => set(e.target.value) });
    const m = app.modal(`${t.name} · colour`, [h('div', { class: 'swatches' }, swatches.map((c) => h('button', { class: 'swatch' + (c === t.color ? ' on' : ''), style: { background: c }, 'aria-label': c, onclick: () => { set(c); m.close(); } }))),
      h('label', { class: 'qz-row' }, h('span', { text: 'ANY COLOUR' }), pick)], [['Done', null, true]]);
  }
  // the bottom edge of a track's head: drag its height
  heightDrag(e, t, h0) {
    const app = this.app, y0 = e.clientY, tag = 'h' + uid();
    // (on the window: the head is drawn again as it grows)
    const mv = (m) => app.store.change((p) => { p.tracks.find((x) => x.id === t.id).h = Math.round(Math.max(30, Math.min(240, h0 + m.clientY - y0))); }, tag);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); app.store.endGesture(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  // a fade handle under the pointer (an audio clip's top corners): 'in', 'out' or null
  fadeHit(clip, row, x, y) {
    const v = this.app.view, spbSec = 60 / this.p.bpm, x0 = this.x(clip.start), x1 = this.x(clip.start + clip.len), top = row.y - v.sy + 3;
    if (x1 - x0 < 40 || y < top + 10 || y > top + 24) return null;
    const fi = clip.xf ? x0 + clip.xf / 2 * v.zoom - 2 : x0 + (clip.fadeIn ?? 0.005) / spbSec * v.zoom, fo = x1 - (clip.fadeOut ?? 0.005) / spbSec * v.zoom;
    if (Math.abs(x - Math.min(x1 - 6, fi) - 2) < 7) return 'in';
    if (Math.abs(x - Math.max(x0 + 1, fo - 5) - 2) < 7) return 'out';
    return null;
  }
  fadeDrag(e, t, clip, which) {
    const app = this.app, spbSec = 60 / this.p.bpm, tag = 'fade' + uid(), r = this.lanesCv.getBoundingClientRect();
    app.selectClip(clip.id, t.id);
    // the fade-in of a clip right after another: a crossfade between them (both ways across the seam)
    const prev = which === 'in' && !isFolder(clip) && t.clips.find((q) => q !== clip && q.src && !isFolder(q) && Math.abs(q.start + q.len - clip.start) < 1e-6);
    if (prev) {
      dragPointer(e, (m) => {
        const b = this.beat(m.clientX - r.left), xf = Math.max(0, Math.min(prev.len, clip.len, 16, 2 * (b - clip.start)));
        app.store.change((p) => { const c = p.tracks.find((x) => x.id === t.id).clips.find((x) => x.id === clip.id); if (xf < 1 / 64) delete c.xf; else c.xf = +xf.toFixed(4); }, tag);
      }, () => { app.store.endGesture(); const c = app.store.track(t.id)?.clips.find((x) => x.id === clip.id); if (c?.xf) app.toast(`Crossfade: ${(c.xf * spbSec * 1000).toFixed(0)} ms across the seam.`); });
      return;
    }
    dragPointer(e, (m) => {
      const b = this.beat(m.clientX - r.left), maxSec = clip.len * spbSec * 0.95;
      const sec = Math.max(0.001, Math.min(maxSec, (which === 'in' ? b - clip.start : clip.start + clip.len - b) * spbSec));
      app.store.change((p) => { const c = p.tracks.find((x) => x.id === t.id).clips.find((x) => x.id === clip.id); if (which === 'in') c.fadeIn = sec; else c.fadeOut = sec; }, tag);
    }, () => app.store.endGesture());
  }
  // a box drawn with Shift on empty space: the clips it touches are selected
  boxSelect(e, x, y) {
    const app = this.app, v = app.view, r = this.lanesCv.getBoundingClientRect();
    dragPointer(e, (m) => {
      const x1 = m.clientX - r.left, y1 = m.clientY - r.top;
      this.box = { x0: Math.min(x, x1), x1: Math.max(x, x1), y0: Math.min(y, y1), y1: Math.max(y, y1) };
      const b0 = this.beat(this.box.x0), b1 = this.beat(this.box.x1);
      v.sel = new Set(this.rows().filter((q) => q.kind === 'track' && q.y - v.sy + q.h > this.box.y0 && q.y - v.sy < this.box.y1)
        .flatMap((q) => q.t.clips.filter((c) => c.start < b1 && c.start + c.len > b0).map((c) => c.id)));
      v.selClip = [...v.sel].at(-1) ?? null;
      this.redraw();
    }, () => { this.box = null; app.store.emit('select'); if (v.sel.size) app.toast(`${v.sel.size} clip${v.sel.size > 1 ? 's' : ''} selected: drag one to move them all; Delete, Ctrl+C, Ctrl+D, Ctrl+J.`); this.redraw(); });
  }
  // the selected clips dragged together (on their own tracks); what they land on is cut, one undo
  groupDrag(e, x) {
    const app = this.app, v = app.view, r = this.lanesCv.getBoundingClientRect(), ids = [...v.sel], b0 = this.beat(x), tag = 'group' + uid();
    const starts = new Map(app.selected().map(({ c }) => [c.id, c.start])), first = Math.min(...starts.values());
    dragPointer(e, (m) => {
      const d = Math.max(-first, this.snap(first + this.beat(m.clientX - r.left) - b0) - first);
      app.store.change((p) => { for (const t of p.tracks) for (const c of t.clips) if (starts.has(c.id)) c.start = starts.get(c.id) + d; }, tag);
    }, () => {
      app.store.endGesture();
      app.store.amend((p) => moveClips(p, ids, 0));
    });
  }
  hitClip(t, x, edge = EDGE) {
    for (let i = t.clips.length - 1; i >= 0; i--) {
      const c = t.clips[i], x0 = this.x(c.start), x1 = this.x(c.start + c.len);
      if (x >= x0 && x <= x1) return { clip: c, edge: x > x1 - edge && x1 - x0 > edge * 2, left: t.kind === 'audio' && x < x0 + edge && x1 - x0 > edge * 3 };
    }
    return null;
  }
  // a clip moved, resized or trimmed (audio, from the left), by mouse or finger: { move(pointer), up() }
  startClipDrag(t, hc, x, alt = false) {
    const app = this.app, cv = this.lanesCv;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let clip = hc.clip;
    if (alt && !hc.edge) {                            // Alt-drag: a copy
      const copy = structuredClone(clip); copy.id = uid('c');
      app.store.change((p) => p.tracks.find((x2) => x2.id === t.id).clips.push(copy));
      clip = copy;
    }
    app.selectClip(clip.id, t.id);
    const start0 = clip.start, len0 = clip.len, off0 = clip.offset || 0, b0 = this.beat(x), id = clip.id;
    const spb = 60 / this.p.bpm, asset = t.kind === 'audio' ? app.assets.get(clip.src) : null;
    const maxLen = asset && !isFolder(clip) && !clip.aloop ? (asset.L.length / 44100 - off0) / spb : Infinity;
    const takes0 = isFolder(clip) ? structuredClone(clip.takes) : null, comp0 = takes0 ? structuredClone(clip.comp) : null, env0 = clip.env ? structuredClone(clip.env) : null;
    let trackId = t.id;
    const tag = 'clip' + uid();
    const move = (m) => {
      const [mx, my] = local(m), db = this.beat(mx) - b0;
      app.store.change((p) => {
        const tr = p.tracks.find((q) => q.id === trackId), c = tr.clips.find((q) => q.id === id);
        if (hc.edge) {
          c.len = Math.min(maxLen, Math.max(this.app.view.snap || 0.25, this.snap(start0 + len0 + db) - start0));
        } else if (hc.left) {                              // audio: trim the start
          const ns = Math.min(start0 + len0 - 0.25, Math.max(takes0 ? 0 : start0 - off0 / spb, this.snap(start0 + db)));
          c.start = Math.max(0, ns); c.offset = Math.max(0, off0 + (c.start - start0) * spb); c.len = start0 + len0 - c.start;
          if (takes0) shiftFolder(c, takes0, comp0, c.start - start0, c.len);
          if (env0) { const d = c.start - start0; c.env = [{ t: 0, v: envAt(env0, d) }, ...env0.filter((q) => q.t > d && q.t <= d + c.len).map((q) => ({ ...q, t: q.t - d }))]; }   // (the envelope stays on its audio)
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
    };
    const up = () => {
      app.store.endGesture();
      const tr = app.store.track(trackId), c = tr?.clips.find((q) => q.id === id);
      if (!c || !tr.clips.some((q) => q !== c && q.start < c.start + c.len - 1e-6 && q.start + q.len > c.start + 1e-6)) return;
      app.store.amend((p) => { const x = p.tracks.find((q) => q.id === trackId); x.clips = cutRange(x.clips, c.start, c.start + c.len, p.bpm, id); });   // one undo: the move and its cut
    };
    return { move, up };
  }
  // a MIDI take: its notes in the clip's loop, the parts in the comp lit
  drawMidiTake(c, t, clip, k, y, rh) {
    const v = this.app.view, tk = clip.mtakes[k], loop = clip.loop || clip.len;
    const cx0 = this.x(clip.start), cx1 = this.x(clip.start + Math.min(loop, clip.len));
    c.fillStyle = '#16191c'; c.fillRect(cx0, y + 2, cx1 - cx0, rh - 5);
    for (const sg of clip.comp) if (sg.k === k) { const sx = this.x(clip.start + sg.a); c.fillStyle = t.color + '30'; c.fillRect(sx, y + 2, (sg.b - sg.a) * v.zoom, rh - 5); c.fillStyle = t.color; c.fillRect(sx, y + 2, (sg.b - sg.a) * v.zoom, 2); }
    let lo = 127, hi = 0;
    for (const n of tk.notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    const span = Math.max(12, hi - lo + 1);
    for (const n of tk.notes) {
      const inComp = clip.comp.some((sg) => sg.k === k && n.t >= sg.a - 1e-9 && n.t < sg.b - 1e-9);
      c.fillStyle = t.color; c.globalAlpha = inComp ? 1 : 0.35;
      c.fillRect(this.x(clip.start + n.t), y + 5 + (1 - (n.n - lo + 0.5) / span) * (rh - 12), Math.max(1.5, n.d * v.zoom - 1), 2.5);
    }
    c.globalAlpha = 1;
    c.fillStyle = '#737980'; c.font = '700 8px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
    c.fillText(tk.name || `TAKE ${k + 1}`, Math.max(cx0, 0) + 4, y + 10);
  }
  // a take lane: click picks this take for the part under the pointer, a swipe picks it from here to there
  takeDown(e, row, x) {
    const app = this.app, t = row.t, k = row.k, b = this.beat(x);
    const clip = t.clips.find((c) => ((isFolder(c) && c.takes[k]) || (isMidiFolder(c) && c.mtakes[k])) && b >= c.start && b < c.start + c.len);
    if (!clip) return;
    const midi = isMidiFolder(clip), span = midi ? Math.min(clip.loop || clip.len, clip.len) : clip.len;
    app.selectClip(clip.id, t.id);
    const comp0 = structuredClone(clip.comp), a0 = this.snap(Math.min(b - clip.start, span)), tag = 'comp' + uid();
    let moved = false;
    dragPointer(e, (m) => {
      if (!moved && Math.abs(m.clientX - e.clientX) < 4) return;
      moved = true;
      const r = this.lanesCv.getBoundingClientRect(), b1 = Math.max(0, Math.min(span, this.snap(this.beat(m.clientX - r.left) - clip.start)));
      const lo = Math.max(0, Math.min(a0, b1)), hi = Math.min(span, Math.max(a0, b1));
      app.store.change((p) => { const c = p.tracks.find((q) => q.id === t.id).clips.find((q) => q.id === clip.id); c.comp = setComp(comp0, lo, hi, k); if (midi) c.notes = compNotes(c); }, tag);
    }, () => {
      if (!moved) { const sg = segmentAt(comp0, b - clip.start); if (sg) app.compTake(t.id, clip.id, k, sg.a, sg.b); }
      app.store.endGesture();
    });
  }
  createClip(t, start, len) {
    if ((t.kind === 'group' || t.kind === 'vca') || t.kind === 'audio') return;
    const c = newClip(start, len, t.kind === 'drum' ? 'BEAT' : 'CLIP');
    this.app.placeClip(t.id, c);
    this.app.selectClip(c.id, t.id);
    this.app.showTab('edit');
  }
  // the points of a lane: the tempo map, a macro's, or a track parameter's (create: an empty list made)
  autoList(p, t, key, create = false) {
    if (t.kind === 'tempo') return p.tempo;
    if (t.kind === 'macros') { p.macroAuto ||= {}; return create ? (p.macroAuto[key] ||= []) : p.macroAuto[key]; }
    const tr = p.tracks.find((q) => q.id === t.id);
    return create ? (tr.auto[key] ||= []) : tr?.auto[key];
  }
  autoPointAt(row, x, y) {
    const t = row.t, key = this.app.view.autoTarget[t.id] || 'vol', g = this.autoGeom?.[t.id];
    const pts = this.autoList(this.p, t, key) || [];
    return !!g && pts.some((pt) => Math.abs(this.x(pt.t) - x) < 16 && Math.abs(g.vy(pt.v) - y) < 16);
  }
  // a finger on an automation lane, off its points: a drag scrolls, a tap adds a point
  touchAuto(e, row, x, y) {
    const v = this.app.view, x0 = e.clientX, y0 = e.clientY, sx0 = v.sx, sy0 = v.sy;
    if (v.pencil) return this.autoDown(e, row, x, y);           // PENCIL: a finger draws
    let moved = false, held = false;
    const timer = setTimeout(() => { if (!moved) { held = true; navigator.vibrate?.(12); this.autoSheet(row, x, y); } }, 500);   // hold: the lane's menu
    dragPointer(e, (m) => { if (this.pinch) { moved = true; return; } if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) > 8) moved = true; if (moved) this.scrollTo(sx0 - (m.clientX - x0), sy0 - (m.clientY - y0)); },
      () => { clearTimeout(timer); if (!moved && !held) this.autoDown({ ...e, detail: 1, currentTarget: this.lanesCv, pointerId: e.pointerId, clientX: x0, clientY: y0 }, row, x, y, true); });
  }
  autoDown(e, row, x, y, tapOnly = false) {
    const app = this.app, t = row.t, key = app.view.autoTarget[t.id] || 'vol';
    const g = this.autoGeom?.[t.id];
    if (!g) return;
    const val = (yy) => {
      const k = 1 - (yy - (g.y + 6)) / (g.rh - 13);
      return Math.max(g.tgt.min, Math.min(g.tgt.max, g.tgt.min + k * (g.tgt.max - g.tgt.min)));
    };
    const tempo = t.kind === 'tempo' || t.kind === 'macros';
    const listOf = (p, create) => this.autoList(p, t, key, create);
    const pts = this.autoList(this.p, t, key) || [];
    if (e.button === 2) return;
    if (app.view.pencil && !tapOnly) return this.pencil(e, t, key, val, listOf);
    // Alt-drag on a line: its curve (the tempo map stays straight ramps)
    const seg = pts.findIndex((pt, i) => pts[i + 1] && this.beat(x) > pt.t && this.beat(x) < pts[i + 1].t);
    if (e.altKey && seg >= 0 && t.kind !== 'tempo') {
      const tag = 'curve' + uid(), y0 = e.clientY, c0 = pts[seg].c || 0, up = pts[seg + 1].v >= pts[seg].v ? 1 : -1;
      dragPointer(e, (m) => app.store.change((p) => { const pt = listOf(p)?.[seg]; if (!pt) return; const c = Math.max(-1, Math.min(1, c0 + (m.clientY - y0) / 80 * up)); if (Math.abs(c) < 0.04) delete pt.c; else pt.c = +c.toFixed(3); }, tag), () => app.store.endGesture());
      return;
    }
    const R = e.pointerType === 'touch' ? 16 : 7;
    let idx = pts.findIndex((pt) => Math.abs(this.x(pt.t) - x) < R && Math.abs(g.vy(pt.v) - y) < R);
    const tag = 'auto' + uid();
    const now = performance.now(), lc = this.lastAutoClick, again = idx >= 0 && lc && lc.t === t.id && lc.key === key && lc.idx === idx && now - lc.at < 420;
    this.lastAutoClick = idx >= 0 && !again ? { t: t.id, key, idx, at: now } : null;
    if (again) {                                              // a double click on a point: it goes (pointerdown has no click count)
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
    if (tapOnly) { app.store.endGesture(); return; }
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
  // PENCIL: a drag draws the automation, a point per grid step; what was under the stroke is replaced
  pencil(e, t, key, val, listOf) {
    const app = this.app, tag = 'pencil' + uid(), r = this.lanesCv.getBoundingClientRect(), step = Math.max(1 / 16, app.view.snap || 0.25);
    const b0 = Math.max(0, this.beat(e.clientX - r.left));
    let lo = b0, hi = b0;
    const drawn = new Map();                                   // grid step -> value
    const orig = structuredClone(listOf(this.p) || []);        // the lane before the stroke: kept outside it, joined at its edges
    const put = (m) => {
      const b = Math.max(0, this.beat(m.clientX - r.left)), v = val(m.clientY - r.top);
      const a = Math.min(b, this.lastPencil ?? b), z = Math.max(b, this.lastPencil ?? b);
      for (let k = Math.round(a / step); k <= Math.round(z / step); k++) drawn.set(k, v);
      this.lastPencil = b; lo = Math.min(lo, b); hi = Math.max(hi, b);
      app.store.change((p) => {
        const list = listOf(p, true), ks = [...drawn.keys()], k0 = Math.min(...ks) * step - 1e-6, k1 = Math.max(...ks) * step + 1e-6;
        const keep = orig.filter((q) => q.t < k0 - 1 / 64 || q.t > k1 + 1 / 64);
        const edges = orig.length ? [{ t: Math.max(0, k0 - 1 / 64), v: autoAt(orig, k0 - 1 / 64) }, { t: k1 + 1 / 64, v: autoAt(orig, k1 + 1 / 64) }].filter((q) => q.t < k0 - 1e-9 || q.t > k1) : [];
        list.splice(0, list.length, ...keep, ...edges, ...[...drawn].map(([k, x]) => ({ t: k * step, v: x })));
        list.sort((q1, q2) => q1.t - q2.t);
        // a point per step only where the value turns: the straight runs thinned
        for (let i = list.length - 2; i >= 1; i--) { const a = list[i - 1], m2 = list[i], z2 = list[i + 1]; if (m2.t > k0 && m2.t < k1 && !a.c && Math.abs((a.v + (z2.v - a.v) * (m2.t - a.t) / (z2.t - a.t)) - m2.v) < 1e-6) list.splice(i, 1); }
      }, tag);
    };
    this.lastPencil = null;
    put(e);
    dragPointer(e, put, () => { this.lastPencil = null; app.store.endGesture(); });
  }
  // right-click (hold on a phone) on an automation lane: the curve of the line there, the point, the lane
  autoSheet(row, x, y) {
    const app = this.app, t = row.t, key = app.view.autoTarget[t.id] || 'vol', g = this.autoGeom?.[t.id];
    const pts = this.autoList(this.p, t, key) || [], b = this.beat(x);
    const pi = g ? pts.findIndex((pt) => Math.abs(this.x(pt.t) - x) < 9 && Math.abs(g.vy(pt.v) - y) < 9) : -1;
    const seg = pts.findIndex((pt, i) => pts[i + 1] && b > pt.t && b < pts[i + 1].t);
    const edit = (fn) => app.store.change((p) => { const list = this.autoList(p, t, key); if (list) fn(list); });
    const setCurve = (c) => () => edit((list) => { if (c) list[seg].c = c; else delete list[seg].c; });
    const loop = this.p.loop;
    const items = [];
    if (seg >= 0 && t.kind !== 'tempo') items.push(['THIS LINE: STRAIGHT', setCurve(0)], ['THIS LINE: SLOW, THEN FAST', setCurve(0.6)], ['THIS LINE: FAST, THEN SLOW', setCurve(-0.6)]);
    if (pi >= 0) items.push(['DELETE THIS POINT', () => edit((list) => list.splice(pi, 1)), 'danger']);
    if (pts.length && loop.b > loop.a) items.push([`CLEAR THE LOOP RANGE (bars ${barOf(this.p, loop.a).bar + 1}–${barOf(this.p, loop.b - 1e-6).bar + 1})`, () => edit((list) => { const keep = list.filter((q) => q.t < loop.a - 1e-6 || q.t > loop.b + 1e-6); list.splice(0, list.length, ...keep); })]);
    if (pts.length) items.push(['CLEAR THE WHOLE LANE', () => app.store.change((p) => { if (t.kind === 'tempo') p.tempo = []; else if (t.kind === 'macros') delete p.macroAuto[key]; else delete p.tracks.find((q) => q.id === t.id).auto[key]; }), 'danger']);
    items.push([app.view.pencil ? 'PENCIL OFF' : 'PENCIL: DRAW WITH A DRAG', () => { app.view.pencil = !app.view.pencil; this.renderHeads(); }]);
    app.sheet(t.kind === 'tempo' ? 'Tempo map' : 'Automation', items);
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
