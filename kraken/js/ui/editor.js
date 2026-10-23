// SPDX-License-Identifier: GPL-3.0-only
// The clip editor: a piano roll for instrument clips, a step grid for drum clips.
import { h, fitCanvas, dragPointer, noteName, ScrollBar } from './kit.js';
import { isFolder } from '../comp.js';

// a piano roll: synths, samplers, external MIDI (drums have their grid, audio its waveform)
const isRoll = (t) => !!t && t.kind !== 'drum' && t.kind !== 'audio';
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const KEYW = 46, VELH = 46, CRUL = 26, BLACK = [1, 3, 6, 8, 10];

export class Editor {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.bar = h('div', { class: 'ebar' });
    this.cv = h('canvas', { class: 'ecanvas', tabindex: 0, 'aria-label': 'Clip editor' });
    this.empty = h('div', { class: 'empty' }, h('b', { text: 'NO CLIP' }),
      h('p', { text: 'Double-click a lane in the arrangement to make a clip, or click a clip to edit it here. Play notes with your computer keyboard (A W S E D F T G Y H U J K) or a MIDI keyboard.' }));
    root.append(this.bar, this.cv, this.empty);
    this.pr = { zoom: 0, top: 84, rowH: 12, sx: 0, len: 0.25 };
    this.sel = new Set();
    this.canvas = fitCanvas(this.cv, (c, w, hh) => this.draw(c, w, hh));
    // scroll bars: along the clip (its length and loop, and a bar more), and up and down the keys
    this.hbar = new ScrollBar(root, 'h', () => {
      const cx = this.ctx, g = this.geomCache; if (!cx || !g || cx.t.kind === 'audio') return { pos: 0, view: 1, total: 1 };
      const span = (g.drum ? (cx.clip.loop || cx.clip.len) : Math.max(cx.clip.len, cx.clip.loop || 0) + 4) * this.pr.zoom, view = g.w - g.gx;
      return { pos: this.pr.sx, view, total: Math.max(span, this.pr.sx + view) };
    }, (x) => { this.pr.sx = x; this.canvas.redraw(); });
    this.vbar = new ScrollBar(root, 'v', () => {
      const cx = this.ctx, g = this.geomCache; if (!cx || !g || g.drum || cx.t.kind === 'audio') return { pos: 0, view: 1, total: 1 };
      const rows = g.gh / this.pr.rowH;
      return { pos: 127 - this.pr.top, view: rows, total: 128 };
    }, (y) => { this.pr.top = Math.round(127 - y); this.canvas.redraw(); });
    this.bind();
    app.store.on((_p, why) => { if (why !== 'change') this.sel.clear(); this.refresh(); });
  }
  get ctx() {
    const t = this.app.store.track(this.app.view.selTrack);
    const clip = t?.clips.find((c) => c.id === this.app.view.selClip) || t?.slots?.find((c) => c && c.id === this.app.view.selClip);
    return clip ? { t, clip } : null;
  }
  refresh() {
    const c = this.ctx;
    this.empty.hidden = !!c;
    this.cv.hidden = !c;
    if (c && c.clip.id !== this.lastClip) { this.lastClip = c.clip.id; this.sel.clear(); this.fit(); }
    this.renderBar();
    this.canvas.redraw();
  }
  fit() {
    const c = this.ctx;
    if (!c) return;
    const [w] = this.canvas.size();
    this.pr.rowH = w < 600 ? 18 : 12;                                        // rows a finger can hit
    const span = Math.min(Math.max(c.clip.loop || c.clip.len, c.clip.len), w < 600 ? 8 : w < 1000 ? 16 : 64);   // both handles in view (a narrow screen: two bars, the strip scrolls)
    this.pr.zoom = Math.max(12, Math.min(160, (w - KEYW - 48) / span));
    this.pr.sx = 0;
    if (isRoll(c.t) && c.clip.notes.length) {
      const avg = c.clip.notes.reduce((a, n) => a + n.n, 0) / c.clip.notes.length;
      const [, hh] = this.canvas.size(), rows = Math.floor((hh - CRUL - VELH) / this.pr.rowH);
      this.pr.top = Math.min(127, Math.round(avg + rows / 2));
    }
  }
  change(fn, tag) {
    const { t, clip } = this.ctx;
    this.app.store.change((p) => { const tr = p.tracks.find((x) => x.id === t.id); fn(tr.clips.find((x) => x.id === clip.id) || tr.slots.find((x) => x && x.id === clip.id)); }, tag);
  }

  // ---------------------------------------------------------------- bar ---
  renderBar() {
    const c = this.ctx;
    if (!c) { this.bar.replaceChildren(h('label', { text: 'CLIP' })); return; }
    const { t, clip } = c, sig = this.app.store.p.sig;
    const num = (label, value, set, step = 1, title) => {
      const signed = label.startsWith('GAIN') || label.startsWith('FADE');
      const inp = h('input', { type: 'number', value, step, min: signed ? null : step, title, 'aria-label': label,
        onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && (signed || v > 0)) set(signed && label.startsWith('FADE') ? Math.max(0, v) : v); }, onkeydown: (e) => e.stopPropagation() });
      return h('label', {}, label, inp);
    };
    const name = h('input', { value: clip.name, style: { width: '8em' }, 'aria-label': 'Clip name', onkeydown: (e) => e.stopPropagation(),
      onchange: (e) => this.change((cl) => { cl.name = e.target.value.slice(0, 20) || cl.name; }) });
    const lenSel = h('select', { 'aria-label': 'Note length', onchange: (e) => { this.pr.len = +e.target.value; } },
      [[1 / 8, '1/32'], [0.25, '1/16'], [0.5, '1/8'], [1, '1/4'], [2, '1/2'], [4, '1 BAR']].map(([v, l]) => h('option', { value: v, selected: v === this.pr.len ? true : null }, l)));
    const btn = (label, title, fn) => h('button', { class: 'add', title, onclick: fn }, label);
    if (t.kind === 'audio') {
      const a = this.app.assets.get(clip.src);
      const peak = a ? a.peaks.reduce((m, x) => Math.max(m, x), 0) : 0;
      this.bar.replaceChildren(...[h('label', {}, h('span', { style: { color: t.color }, text: '■' }), name),
        num('GAIN dB', +(clip.gain || 0).toFixed(1), (v) => this.change((cl) => { cl.gain = v; }), 0.5, 'Clip gain'),
        num('FADE IN ms', Math.round((clip.fadeIn || 0) * 1000), (v) => this.change((cl) => { cl.fadeIn = v / 1000; }), 1),
        num('FADE OUT ms', Math.round((clip.fadeOut || 0) * 1000), (v) => this.change((cl) => { cl.fadeOut = v / 1000; }), 1),
        h('button', { class: 'add', title: 'Raise the gain so the loudest peak reaches -1 dB', onclick: () => { if (peak > 0) this.change((cl) => { cl.gain = Math.round((-1 - 20 * Math.log10(peak)) * 10) / 10; }); } }, 'NORMALIZE'),
        ...(isFolder(clip) ? this.takeBar(t, clip) : this.warpBar(t, clip, a, num))].filter(Boolean));
      return;
    }
    this.renderNotesBar(c, name, lenSel, btn, num, sig);
  }
  // a take folder: which take plays, the take lanes, flatten
  takeBar(t, clip) {
    const app = this.app;
    return [
      h('label', { title: 'Play one take over the whole clip' }, 'TAKE', h('select', { 'aria-label': 'Take', onchange: (e) => { if (e.target.value !== '') app.compTake(t.id, clip.id, +e.target.value); } },
        h('option', { value: '' }, clip.comp.length > 1 ? `COMP · ${clip.comp.length} PARTS` : `TAKE ${clip.comp[0].k + 1}`),
        clip.takes.map((tk, i) => h('option', { value: i }, `${tk.name || 'TAKE ' + (i + 1)} EVERYWHERE`)))),
      h('button', { class: 'add' + (app.view.takesOpen?.has(t.id) ? ' on' : ''), title: 'Show the takes under the track: click or swipe a take to put it in the comp', onclick: () => app.toggleTakes(t.id) }, 'TAKE LANES'),
      h('button', { class: 'add', title: 'Render the comp into one plain clip (undo brings the takes back)', onclick: () => app.flattenComp(t.id, clip.id) }, 'FLATTEN'),
      h('label', { style: { color: 'var(--dim)' }, text: `${clip.takes.length} takes · swipe across a take lane to comp` }),
    ];
  }
  warpBar(t, clip, a, num) {
    return [
        h('label', {}, 'WARP', h('select', { 'aria-label': 'Warp', title: 'OFF: the audio as recorded · RE-PITCH: follows the tempo, like tape · STRETCH: follows the tempo, pitch kept',
          onchange: (e) => this.app.warpClip(t.id, clip.id, e.target.value) },
          [['off', 'OFF'], ['repitch', 'RE-PITCH'], ['stretch', 'STRETCH']].map(([v, l]) => h('option', { value: v, selected: (clip.warp || 'off') === v ? true : null }, l)))),
        num('BPM', +(clip.bpm || this.app.store.p.bpm).toFixed(2), (v) => this.app.warpClip(t.id, clip.id, clip.warp || 'off', { bpm: v }), 0.01, 'The tempo the audio was played at'),
        h('button', { class: 'add', title: 'Find the audio\'s tempo', onclick: () => this.app.detectClipBpm(t.id, clip.id) }, 'DETECT'),
        clip.warp === 'stretch' ? num('PITCH st', clip.st || 0, (v) => this.app.warpClip(t.id, clip.id, 'stretch', { st: v }), 1, 'Transpose, length kept') : null,
        h('button', { class: 'add', title: 'A new sampler track with this audio, sliced to pads', onclick: () => this.app.clipToSampler(t.id, clip.id) }, '→ SAMPLER'),
        h('label', { style: { color: 'var(--dim)' }, text: a ? `${a.name} · ${(a.L.length / 44100).toFixed(2)} s · from ${(clip.offset || 0).toFixed(2)} s` : 'Audio missing' })];
  }
  renderNotesBar({ t, clip }, name, lenSel, btn, num, sig) {
    const kids = [h('label', {}, h('span', { style: { color: t.color }, text: '■' }), name),
      num('BARS', +(clip.len / sig).toFixed(3), (v) => this.change((cl) => { const linked = Math.abs((cl.loop || cl.len) - cl.len) < 1e-9; cl.len = v * sig; if (linked || cl.loop > cl.len) cl.loop = cl.len; }), 0.25, 'Clip length in bars'),
      num('LOOP', +((clip.loop || clip.len) / sig).toFixed(3), (v) => this.change((cl) => { cl.loop = v * sig; if (cl.len < cl.loop) cl.len = cl.loop; }), 0.25, 'The notes repeat every this many bars')];
    // the SLOOP sequencer's tools: a click on a note cycles its chance or its ratchets
    const tool = h('select', { 'aria-label': 'Tool', title: 'DRAW notes · SELECT: drag a box around notes · ACCENT: a hit cycles normal, accent, ghost · CHANCE (100 > 75 > 50 > 25 %) · RATCHETS (1 > 2 > 3 > 4)', onchange: (e) => { this.tool = e.target.value; e.target.blur(); } },
      [['draw', t.kind === 'drum' ? 'HITS' : 'DRAW'], ...(t.kind === 'drum' ? [['accent', 'ACCENT']] : [['select', 'SELECT']]), ['chance', 'CHANCE'], ['ratchet', 'RATCHET']].map(([v, l]) => h('option', { value: v, selected: (this.tool || 'draw') === v ? true : null }, l)));
    kids.push(h('label', {}, 'TOOL', tool));
    if (isRoll(t)) {
      kids.push(h('label', {}, 'DRAW', lenSel),
        btn('QUANTIZE', 'Snap note starts to the grid (Q)', () => this.quantize()),
        btn('−12', 'Transpose down an octave', () => this.transpose(-12)),
        btn('+12', 'Transpose up an octave', () => this.transpose(12)),
        btn('×2', 'Double the loop: copy its notes after it', () => this.doubleLoop()),
        btn('LEGATO', 'Stretch each note to the next', () => this.legato()));
      if (this.sel.size) kids.push(...this.inspector(t));
    } else {
      kids.push(btn('×2', 'Double the loop: copy its steps after it', () => this.doubleLoop()),
        btn('CLEAR', 'Remove every hit', () => this.change((cl) => { cl.notes = []; })),
        h('label', { style: { color: 'var(--dim)' }, text: COARSE ? 'Tap: hit · drag: paint · TOOL ACCENT: accent / ghost' : 'Click: hit · Shift-click or TOOL ACCENT: accent / ghost · drag: paint' }));
    }
    this.bar.replaceChildren(...kids);
    if (this.sel.size && this.bar.scrollWidth > this.bar.clientWidth + 20) this.bar.querySelector('.insp-sep')?.scrollIntoView({ block: 'nearest', inline: 'start' });   // the note settings in view
  }
  // the selected notes: chance, ratchets, micro-timing, parameter locks (SLOOP's step options)
  inspector(t) {
    const ns = [...this.sel], one = ns[0];
    const setAll = (fn) => this.change(() => { for (const n of ns) fn(n); }, 'insp');
    const sel = (label, value, opts, fn) => h('label', {}, label, h('select', { onchange: (e) => setAll((n) => fn(n, +e.target.value)) },
      opts.map(([v, l]) => h('option', { value: v, selected: Math.abs(v - value) < 1e-6 ? true : null }, l))));
    const micro = (v) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) / 0.25 * 100)}% STEP`);
    if (t.kind !== 'synth') return [                           // no engine parameters to lock on a sampler or an external synth
      h('span', { class: 'insp-sep', text: `${ns.length} NOTE${ns.length > 1 ? 'S' : ''}` }),
      sel('CHANCE', one.p ?? 1, [[1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%'], [0.125, '12%']], (n, v) => { if (v >= 1) delete n.p; else n.p = v; }),
      sel('RATCH', one.r || 1, [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [6, '6'], [8, '8']], (n, v) => { if (v <= 1) delete n.r; else n.r = v; }),
      sel('MICRO', one.m || 0, [-0.0625, -0.03125, -0.015625, 0, 0.015625, 0.03125, 0.0625].map((v) => [v, micro(v)]), (n, v) => { if (!v) delete n.m; else n.m = v; })];
    const cat = this.app.lib[t.bank], e0 = cat.e0, eng = cat.engines[t.engine];
    const lockables = [...eng.edit.map((d, i) => [e0 + i, d.l]), [5, 'ENV>FLT'], [33, 'DRIVE'], [34, 'CHORUS'], [35, 'DELAY'], [36, 'REVERB'], [50, 'DJ FILT'], [0, 'LEVEL']];
    this.lockId ??= lockables[0][0];
    const lockDesc = this.lockId >= e0 ? eng.edit[this.lockId - e0] : cat.tp[this.lockId];
    const val = h('input', { type: 'number', min: lockDesc?.min, max: lockDesc?.max, value: one.l?.[this.lockId] ?? lockDesc?.def ?? 0, style: { width: '4.5em' }, onkeydown: (e) => e.stopPropagation(), 'aria-label': 'Lock value' });
    return [
      h('span', { class: 'insp-sep', text: `${ns.length} NOTE${ns.length > 1 ? 'S' : ''}` }),
      sel('CHANCE', one.p ?? 1, [[1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%'], [0.125, '12%']], (n, v) => { if (v >= 1) delete n.p; else n.p = v; }),
      sel('RATCH', one.r || 1, [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [6, '6'], [8, '8']], (n, v) => { if (v <= 1) delete n.r; else n.r = v; }),
      sel('MICRO', one.m || 0, [-0.0625, -0.03125, -0.015625, 0, 0.015625, 0.03125, 0.0625].map((v) => [v, micro(v)]), (n, v) => { if (!v) delete n.m; else n.m = v; }),
      h('label', { title: 'Parameter lock: this value while the note plays (SLOOP p-lock)' }, 'LOCK',
        h('select', { onchange: (e) => { this.lockId = +e.target.value; this.renderBar(); } }, lockables.map(([id, l]) => h('option', { value: id, selected: id === this.lockId ? true : null }, l))), val),
      h('button', { class: 'add', onclick: () => { const v = Math.max(lockDesc.min, Math.min(lockDesc.max, Math.round(+val.value))); setAll((n) => { n.l = { ...(n.l || {}), [this.lockId]: v }; }); } }, 'SET'),
      h('button', { class: 'add', title: 'Remove every lock of these notes', onclick: () => setAll((n) => { delete n.l; }) }, 'CLEAR'),
    ];
  }
  cycle(n, tool) {
    if (tool === 'chance') { const steps = [1, 0.75, 0.5, 0.25]; const i = steps.findIndex((x) => Math.abs(x - (n.p ?? 1)) < 1e-6); const v = steps[(i + 1) % steps.length]; if (v >= 1) delete n.p; else n.p = v; }
    else if (tool === 'ratchet') { const v = ((n.r || 1) % 4) + 1; if (v <= 1) delete n.r; else n.r = v; }
  }
  targets() { const { clip } = this.ctx; return this.sel.size ? clip.notes.filter((n) => this.sel.has(n)) : clip.notes; }
  quantize() {
    const g = this.app.view.snap || 0.25;
    this.change((cl) => { for (const n of cl.notes) if (!this.sel.size || this.sel.has(n)) n.t = Math.round(n.t / g) * g; });
  }
  transpose(d) { this.change((cl) => { for (const n of cl.notes) if (!this.sel.size || this.sel.has(n)) n.n = Math.max(0, Math.min(127, n.n + d)); }, 'tr'); }
  doubleLoop() {
    this.change((cl) => {
      const loop = cl.loop || cl.len, extra = cl.notes.filter((n) => n.t < loop).map((n) => ({ ...n, t: n.t + loop }));
      cl.notes.push(...extra); cl.loop = loop * 2; if (cl.len < cl.loop) cl.len = cl.loop;
    });
    this.fit();
  }
  legato() {
    this.change((cl) => {
      const ns = [...cl.notes].sort((a, b) => a.t - b.t), loop = cl.loop || cl.len;
      for (const n of ns) { const nx = ns.find((m) => m.t > n.t + 1e-6); n.d = (nx ? nx.t : loop) - n.t; }
    });
  }

  // ----------------------------------------------------------- geometry ---
  geom() {
    const [w, h0] = this.canvas.size(), drum = this.ctx?.t.kind === 'drum', hh = h0 - CRUL;   // below the length strip
    const lanes = this.app.lib.sloop.lanes;
    return drum ? { w, hh, gx: w < 600 ? 54 : 70, gh: hh, rowH: Math.max(10, Math.min(28, hh / lanes.length)), drum }
      : { w, hh, gx: KEYW, gh: hh - VELH, rowH: this.pr.rowH, drum };
  }
  tx(t) { return this.geomCache.gx + t * this.pr.zoom - this.pr.sx; }
  xt(x) { return (x - this.geomCache.gx + this.pr.sx) / this.pr.zoom; }
  ny(n) { return (this.pr.top - n) * this.pr.rowH; }
  yn(y) { return this.pr.top - Math.floor(y / this.pr.rowH); }
  snapT(t, floor) { const g = this.app.view.snap || 1 / 64; return (floor ? Math.floor(t / g) : Math.round(t / g)) * g; }

  // --------------------------------------------------------------- draw ---
  draw(c, w, hh) {
    const cx = this.ctx;
    c.fillStyle = '#0b0c0d'; c.fillRect(0, 0, w, hh);
    if (!cx) { this.hbar?.update(); this.vbar?.update(); return; }
    const g = (this.geomCache = this.geom());
    if (!this.pr.zoom) this.fit();
    if (cx.t.kind === 'audio') { this.drawAudio(c, cx, w, hh); this.hbar.update(); this.vbar.update(); return; }
    c.save(); c.translate(0, CRUL); c.beginPath(); c.rect(0, 0, w, g.hh); c.clip();
    if (g.drum) this.drawDrums(c, cx, g); else this.drawRoll(c, cx, g);
    c.restore();
    this.drawStrip(c, cx, g);
    this.hbar.update(); this.vbar.update();
  }
  // the length strip, above the grid: the clip as a block with two handles to drag, like the arrangement's clips.
  // Orange, on top: the LOOP (the notes repeat every…). White, below: the clip's LENGTH.
  drawStrip(c, { t, clip }, g) {
    const sig = this.app.store.p.sig, loop = clip.loop || clip.len, len = clip.len;
    const x0 = this.tx(0), lx = this.tx(loop), ex = this.tx(len), hot = this.stripHot;
    const bars = (v) => { const b = +(v / sig).toFixed(2); return `${b} BAR${b === 1 ? '' : 'S'}`; };
    c.fillStyle = '#131517'; c.fillRect(0, 0, g.w, CRUL);
    c.fillStyle = '#2a2e33'; c.fillRect(0, CRUL - 1, g.w, 1);
    c.font = '700 8px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
    c.fillStyle = '#ff5b14'; c.fillText('LOOP', 5, 6);
    c.fillStyle = '#c9ccc9'; c.fillText('LENGTH', 5, 18);
    c.save(); c.beginPath(); c.rect(g.gx, 0, g.w - g.gx, CRUL); c.clip();
    // the clip block, its bars numbered
    c.globalAlpha = 0.32; c.fillStyle = t.color; c.fillRect(x0, 13, ex - x0, CRUL - 15); c.globalAlpha = 1;
    c.font = '500 9px "IBM Plex Mono", monospace';
    for (let b = 0; b * sig < len; b++) {
      const x = this.tx(b * sig); if (x > g.w) break;
      c.fillStyle = '#4a5057'; c.fillRect(Math.round(x), 13, 1, CRUL - 15);
      c.fillStyle = '#c9ccc9'; c.fillText(String(b + 1), x + 3, 19);
    }
    // the loop brace
    c.fillStyle = hot === 'loop' ? '#ff8a52' : '#ff5b14'; c.fillRect(x0, 1, lx - x0, 10);
    c.fillStyle = '#0b0c0d'; c.font = '700 8px "IBM Plex Mono", monospace';
    if (lx - x0 > 70) c.fillText(`LOOP ${bars(loop)}`, x0 + 4, 6.5);
    c.fillStyle = '#ffd9c4'; c.fillRect(lx - 6, 1, 6, 10);                   // its handle
    c.fillStyle = '#0b0c0d'; c.fillRect(lx - 4, 3, 1, 6); c.fillRect(lx - 2, 3, 1, 6);
    // the length handle
    c.fillStyle = hot === 'len' ? '#ffffff' : '#d6d7d4'; c.fillRect(ex - 6, 12, 6, CRUL - 13);
    c.fillStyle = '#0b0c0d'; c.fillRect(ex - 4, 15, 1, CRUL - 19); c.fillRect(ex - 2, 15, 1, CRUL - 19);
    const lab = `${bars(len)}`, lw = c.measureText(lab).width + 8;
    if (ex - x0 > lw + 30) { c.fillStyle = '#0b0c0d'; c.fillRect(ex - 8 - lw, 13, lw, CRUL - 15); c.fillStyle = '#fff'; c.fillText(lab, ex - 4 - lw, 19); }
    if (this.stripDrag) { c.fillStyle = '#fff'; c.font = '700 9px "IBM Plex Mono", monospace'; const x = this.stripDrag === 'loop' ? lx : ex; c.fillText(this.stripDrag === 'loop' ? `LOOP ${bars(loop)}` : `LENGTH ${bars(len)}`, Math.min(x + 6, g.w - 110), this.stripDrag === 'loop' ? 6.5 : 19); }
    c.restore();
  }
  stripHit(clip, x, y) {
    const lx = this.tx(clip.loop || clip.len), ex = this.tx(clip.len), R = 9;
    const nearL = x > lx - R && x < lx + R - 3, nearE = x > ex - R && x < ex + R - 3;
    if (nearL && (y < 12 || !nearE)) return 'loop';
    if (nearE) return 'len';
    return null;
  }
  // drag a handle: snaps to beats (Shift: 1/16). The loop follows the length while they are equal.
  stripDown(e, { clip }, g, x, y, local) {
    const what = this.stripHit(clip, x, y);
    if (!what) {                                                 // no handle here: the strip scrolls the view
      const sx0 = this.pr.sx, x0 = e.clientX;
      dragPointer(e, (m) => { this.pr.sx = Math.max(0, sx0 - (m.clientX - x0)); this.canvas.redraw(); });
      return;
    }
    const linked = Math.abs((clip.loop || clip.len) - clip.len) < 1e-9, tag = 'cliplen' + Math.random();
    this.stripDrag = what;
    dragPointer(e, (m) => {
      const [mx] = local(m), step = m.shiftKey ? 0.25 : 1;
      const v = Math.max(step, Math.round(this.xt(mx) / step) * step);
      this.change((cl) => {
        if (what === 'len') { cl.len = v; if (linked || (cl.loop || 0) > v) cl.loop = v; }
        else { cl.loop = v; if (cl.len < v) cl.len = v; }
      }, tag);
    }, () => {
      this.stripDrag = null; this.app.store.endGesture();
      const cx = this.ctx, [w] = this.canvas.size();
      if (cx && (this.tx(Math.max(cx.clip.len, cx.clip.loop || 0)) > w - 24 || this.tx(Math.max(cx.clip.len, cx.clip.loop || 0)) < w * 0.5)) this.fit();
      this.canvas.redraw(); this.renderBar();
    });
  }
  gridLines(c, g, loop, len, top, bottom) {
    const sig = this.app.store.p.sig, step = this.pr.zoom >= 60 ? 0.25 : this.pr.zoom >= 24 ? 0.5 : 1;
    for (let t = 0; t <= len + 1e-9; t += step) {
      const x = Math.round(this.tx(t)) + 0.5;
      if (x < g.gx || x > g.w) continue;
      c.fillStyle = t % sig === 0 ? '#353a40' : t % 1 === 0 ? '#22262a' : '#16191b';
      c.fillRect(x, top, 1, bottom - top);
    }
    const lx = this.tx(loop);
    if (loop < len && lx < g.w) { c.fillStyle = '#0b0c0dbb'; c.fillRect(Math.max(g.gx, lx), top, g.w - lx, bottom - top); c.fillStyle = '#ff5b14'; c.fillRect(lx, top, 2, bottom - top); }
  }
  playhead(c, g, clip, top, bottom) {
    let pos = this.app.pos - clip.start;
    if (clip.start === undefined) {                           // a session clip: from its launch
      const t = this.ctx?.t, st = t && this.app.session?.state[t.id], i = t?.slots.indexOf(clip);
      if (!st || st.slot !== i || st.at === undefined) return;
      pos = this.app.pos - st.at;
      const loop = clip.loop || clip.len;
      if (pos < 0) return;
      pos %= loop;
    }
    if (pos < 0 || pos > clip.len) return;
    const loop = clip.loop || clip.len, x = this.tx(pos % loop);
    c.fillStyle = '#ff5b14'; c.fillRect(Math.round(x), top, 1, bottom - top);
  }
  drawRoll(c, { t, clip }, g) {
    const loop = clip.loop || clip.len, len = clip.len, rh = this.pr.rowH;
    // rows
    for (let n = 127; n >= 0; n--) {
      const y = this.ny(n);
      if (y + rh < 0 || y > g.gh) continue;
      c.fillStyle = BLACK.includes(n % 12) ? '#0f1113' : '#14171a';
      c.fillRect(g.gx, y, g.w - g.gx, rh);
      if (n % 12 === 0) { c.fillStyle = '#262a2f'; c.fillRect(g.gx, y + rh - 1, g.w - g.gx, 1); }
    }
    this.gridLines(c, g, loop, len, 0, g.gh);
    // notes (ghosts after the loop)
    c.font = '600 8px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
    for (let base = 0; base < len; base += loop) {
      for (const n of clip.notes) {
        if (n.t >= loop || base + n.t >= len) continue;
        const x = this.tx(base + n.t), y = this.ny(n.n), wd = Math.max(3, Math.min(n.d, loop - n.t) * this.pr.zoom - 1);
        if (x > g.w || x + wd < g.gx || y > g.gh || y + rh < 0) continue;
        const ghost = base > 0, sel = this.sel.has(n);
        c.globalAlpha = ghost ? 0.3 : 0.45 + (n.v / 127) * 0.55;
        c.fillStyle = sel ? '#ffffff' : t.color;
        c.fillRect(x, y + 1, wd, rh - 2);
        c.globalAlpha = 1;
        if (!ghost) this.marks(c, n, x, y + 1, wd, rh - 2);
        if (!ghost) { c.fillStyle = '#0b0c0d'; c.fillRect(x + wd - 2, y + 3, 1, rh - 6); if (wd > 26 && rh >= 10) c.fillText(noteName(n.n), x + 3, y + rh / 2); }
      }
    }
    if (this.band) {
      const b = this.band; c.strokeStyle = '#fff'; c.setLineDash([3, 3]);
      c.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0)); c.setLineDash([]);
    }
    this.playhead(c, g, clip, 0, g.hh);
    // keyboard
    for (let n = 127; n >= 0; n--) {
      const y = this.ny(n);
      if (y + rh < 0 || y > g.gh) continue;
      const black = BLACK.includes(n % 12);
      c.fillStyle = this.held === n ? t.color : black ? '#1d2023' : '#d6d7d4';
      c.fillRect(0, y, KEYW - 2, rh - (black ? 1 : 0));
      if (!black) { c.fillStyle = '#9b9e9b'; c.fillRect(0, y + rh - 1, KEYW - 2, 1); }
      if (n % 12 === 0) { c.fillStyle = '#131415'; c.font = '600 8px "IBM Plex Mono", monospace'; c.fillText(noteName(n), 4, y + rh / 2); }
    }
    // velocity lane
    const vy = g.gh;
    c.fillStyle = '#0e1011'; c.fillRect(0, vy, g.w, VELH);
    c.fillStyle = '#23272b'; c.fillRect(0, vy, g.w, 1);
    c.fillStyle = '#737980'; c.font = '700 8px Archivo, sans-serif'; c.fillText('VEL', 10, vy + VELH / 2);
    for (const n of clip.notes) {
      if (n.t >= loop) continue;
      const x = this.tx(n.t); if (x < g.gx || x > g.w) continue;
      const hgt = (n.v / 127) * (VELH - 8);
      c.fillStyle = this.sel.has(n) ? '#fff' : t.color;
      c.fillRect(x, vy + VELH - 3 - hgt, 3, hgt);
      c.fillRect(x - 1, vy + VELH - 3 - hgt, 5, 2);
    }
  }
  // a take folder: the comp along the clip, each part from its take, named
  drawFolder(c, t, clip, w, hh) {
    const spb = 60 / this.app.store.p.bpm, x = (b) => 12 + (b / clip.len) * (w - 24), mid = hh / 2, amp = hh / 2 - 22, g = Math.pow(10, (clip.gain || 0) / 20);
    c.font = '700 9px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
    for (const sg of clip.comp) {
      const tk = clip.takes[sg.k], a = this.app.assets.get(tk?.src), x0 = x(sg.a), x1 = x(Math.min(sg.b, clip.len));
      c.fillStyle = sg.k % 2 ? '#15181b' : '#121417'; c.fillRect(x0, 8, x1 - x0, hh - 16);
      c.fillStyle = t.color; c.fillRect(x0, 8, x1 - x0, 2);
      if (a) {
        for (let px = Math.ceil(x0); px < x1; px++) {
          const b0 = ((px - 12) / (w - 24)) * clip.len, b1 = ((px - 11) / (w - 24)) * clip.len;
          const s0 = tk.offset + (b0 - tk.at) * spb, s1 = tk.offset + (b1 - tk.at) * spb;
          let m = 0;
          for (let i = Math.floor(s0 * 44100 / 256); i <= Math.floor(s1 * 44100 / 256) && i < a.peaks.length; i++) if (i >= 0) m = Math.max(m, a.peaks[i]);
          const hg = Math.min(1, m * g) * amp; c.fillRect(px, mid - hg, 1, hg * 2 || 1);
        }
      }
      c.fillStyle = '#fff'; if (x1 - x0 > 50) c.fillText(tk?.name || `TAKE ${sg.k + 1}`, x0 + 4, 18);
      c.fillStyle = '#0b0c0d'; c.fillRect(Math.round(x0), 8, 1, hh - 16);
    }
    const pos = this.app.pos - clip.start;
    if (pos >= 0 && pos <= clip.len) { c.fillStyle = '#fff'; c.fillRect(Math.round(x(pos)), 8, 1, hh - 16); }
    c.fillStyle = '#9aa0a6'; c.font = '500 9px "IBM Plex Mono", monospace';
    c.fillText('The comp: each part plays from its take. Open TAKE LANES to change it.', 14, hh - 4);
  }
  drawAudio(c, { t, clip }, w, hh) {
    if (isFolder(clip)) return this.drawFolder(c, t, clip, w, hh);
    const a = this.app.assets.get(clip.src);
    if (!a) return;
    const total = a.L.length / 44100, spb = 60 / this.app.store.p.bpm;
    const x = (sec) => 12 + (sec / total) * (w - 24);
    const mid = hh / 2, amp = hh / 2 - 14, g = Math.pow(10, (clip.gain || 0) / 20);
    const s0 = clip.offset || 0, s1 = s0 + clip.len * spb;
    c.fillStyle = '#131517'; c.fillRect(x(s0), 8, x(Math.min(total, s1)) - x(s0), hh - 16);
    for (let px = 12; px < w - 12; px++) {
      const t0 = ((px - 12) / (w - 24)) * total, t1 = ((px - 11) / (w - 24)) * total;
      let m = 0;
      for (let i = Math.floor(t0 * 44100 / 256); i < Math.max(Math.floor(t0 * 44100 / 256) + 1, Math.floor(t1 * 44100 / 256)) && i < a.peaks.length; i++) m = Math.max(m, a.peaks[i]);
      const inside = t0 >= s0 && t0 < s1;
      c.fillStyle = inside ? t.color : '#2f343a';
      const hgt = Math.min(1, m * (inside ? g : 1)) * amp;
      c.fillRect(px, mid - hgt, 1, hgt * 2 || 1);
    }
    c.fillStyle = '#ff5b14'; c.fillRect(x(s0), 8, 2, hh - 16); c.fillRect(x(Math.min(total, s1)) - 2, 8, 2, hh - 16);
    const pos = this.app.pos - clip.start;
    if (pos >= 0 && pos <= clip.len) { c.fillStyle = '#fff'; c.fillRect(Math.round(x(s0 + pos * spb)), 8, 1, hh - 16); }
    c.fillStyle = '#9aa0a6'; c.font = '500 9px "IBM Plex Mono", monospace';
    c.fillText('Grey: outside the clip. Drag the clip edges in the arrangement to trim.', 14, hh - 4);
  }
  // chance (a dotted top and its %), ratchets (ticks), locks (a dot), micro-timing (an arrow)
  marks(c, n, x, y, w, hh) {
    c.fillStyle = '#0b0c0d';
    if ((n.r || 1) > 1) for (let k = 1; k < n.r; k++) c.fillRect(x + (w * k) / n.r, y + 1, 1.5, hh - 2);
    if (n.l) { c.fillStyle = '#fff'; c.beginPath(); c.arc(x + 4, y + hh - 4, 2.2, 0, 7); c.fill(); }
    if ((n.p ?? 1) < 1) {
      c.fillStyle = '#0b0c0d';
      for (let i = 0; i < w; i += 4) c.fillRect(x + i, y, 2, 2);
      if (w > 22 && hh >= 9) { c.font = '600 8px "IBM Plex Mono", monospace'; c.fillText(`${Math.round(n.p * 100)}`, x + w - 15, y + hh / 2 + 1); }
    }
    if (n.m) { c.fillStyle = '#fff'; c.fillRect(n.m > 0 ? x : x + w - 2, y, 2, hh); }
  }
  drawDrums(c, { t, clip }, g) {
    const lib = this.app.lib.sloop, loop = clip.loop || clip.len, rh = g.rowH;
    const steps = Math.round(loop * 4);
    const view = Math.max(4, Math.min(loop, g.w < 600 ? 4 : g.w < 1000 ? 8 : 16));      // the pattern, a bar (phone) to four bars at a time
    this.pr.zoom = Math.max(14, (g.w - g.gx - (g.w < 600 ? 14 : 40)) / view);
    for (let l = 0; l < lib.lanes.length; l++) {
      const y = l * rh;
      c.fillStyle = l % 2 ? '#111315' : '#14171a'; c.fillRect(0, y, g.w, rh);
      c.fillStyle = this.held === lib.laneNotes[l] ? t.color : '#737980';
      c.font = '700 9px Archivo, sans-serif'; c.textBaseline = 'middle';
      c.fillText(lib.lanes[l].toUpperCase(), 10, y + rh / 2);
    }
    this.gridLines(c, g, loop, loop, 0, lib.lanes.length * rh);
    const cw = this.pr.zoom / 4;
    for (let s = 0; s < steps; s++) {
      const x = this.tx(s / 4);
      if (x > g.w) break;
      for (let l = 0; l < lib.lanes.length; l++) {
        c.fillStyle = (Math.floor(s / 4) % 2 ? '#1d2124' : '#24292d');
        c.fillRect(x + 2, l * rh + 2, cw - 4, rh - 4);
      }
    }
    for (const n of clip.notes) {
      const l = lib.laneNotes.indexOf(n.n);
      if (l < 0 || n.t >= loop) continue;
      const x = this.tx(n.t);
      c.fillStyle = t.color; c.globalAlpha = 0.35 + (n.v / 127) * 0.65;
      c.fillRect(x + 2, l * rh + 2, cw - 4, rh - 4);
      if (n.v >= 120) { c.globalAlpha = 1; c.fillStyle = '#fff'; c.fillRect(x + 2, l * rh + 2, cw - 4, 2); }
      c.globalAlpha = 1;
      this.marks(c, n, x + 2, l * rh + 2, cw - 4, rh - 4);
    }
    this.playhead(c, g, clip, 0, lib.lanes.length * rh);
  }

  // -------------------------------------------------------------- input ---
  bind() {
    const cv = this.cv;
    const raw = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const local = (e) => { const [x, y] = raw(e); return [x, y - CRUL]; };      // grid coordinates, under the length strip
    this.bindPinch(cv, local);
    cv.addEventListener('pointerdown', (e) => {
      const cx = this.ctx; if (!cx || e.button !== 0 || this.pinch) return;
      cv.focus();
      const g = (this.geomCache = this.geom());
      if (cx.t.kind === 'audio') return;
      const [x, y] = local(e);
      if (y < 0) return this.stripDown(e, cx, g, x, y + CRUL, local);
      // a finger: wait a moment, in case a second one comes (two fingers scroll and zoom, they don't draw)
      if (e.pointerType === 'touch' && !e.synthetic) {
        const fake = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, shiftKey: false, altKey: false, button: 0, detail: 1, pointerType: 'touch', synthetic: true, currentTarget: cv, preventDefault() {}, stopPropagation() {} };
        const go = () => { this.deferT = 0; if (!this.pinch) handle(fake); };
        this.deferT = setTimeout(go, 70);
        const early = (u) => {
          if (u.pointerId !== e.pointerId) return;
          cv.removeEventListener('pointerup', early);
          if (!this.deferT) return;
          clearTimeout(this.deferT); go();
          cv.dispatchEvent(new PointerEvent('pointerup', { pointerId: e.pointerId, clientX: u.clientX, clientY: u.clientY, bubbles: true }));
        };
        cv.addEventListener('pointerup', early);
        return;
      }
      handle(e);
    });
    const handle = (e) => {
      const cx = this.ctx; if (!cx) return;
      const g = (this.geomCache = this.geom()), [x, y] = local(e);
      if (g.drum) return this.drumDown(e, cx, g, x, y, local);
      if (x < KEYW && y < g.gh) { this.audition(this.yn(y), e); return; }
      if (y >= g.gh) return this.velDown(e, cx, local);
      if (e.pointerType === 'touch') {                            // a finger: a double tap on a note removes it
        const hit = this.hitNote(cx.clip, x, y), now = performance.now();
        if (hit && this.lastTap?.n === hit.n && now - this.lastTap.at < 380) {
          this.lastTap = null; this.sel.delete(hit.n);
          this.change((cl) => { cl.notes = cl.notes.filter((n) => n !== hit.n); });
          return;
        }
        this.lastTap = hit ? { n: hit.n, at: now } : null;
      }
      this.rollDown(e, cx, g, x, y, local);
    };
    cv.addEventListener('dblclick', (e) => {
      const cx = this.ctx; if (!cx || !isRoll(cx.t)) return;
      const [x, y] = local(e), hit = this.hitNote(cx.clip, x, y);
      if (hit) { this.change((cl) => { cl.notes = cl.notes.filter((n) => n !== hit.n); }); this.sel.delete(hit.n); }
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const cx = this.ctx; if (!cx || !isRoll(cx.t)) return;
      const [x, y] = local(e), hit = this.hitNote(cx.clip, x, y);
      if (hit) { this.change((cl) => { cl.notes = cl.notes.filter((n) => n !== hit.n); }); this.sel.delete(hit.n); }
    });
    cv.addEventListener('pointermove', (e) => {
      const cx = this.ctx; if (!cx || e.buttons) return;
      const [x, y] = local(e), g = this.geomCache || this.geom();
      const hot = cx.t.kind !== 'audio' && y < 0 ? this.stripHit(cx.clip, x, y + CRUL) : null;
      if (hot !== (this.stripHot || null)) { this.stripHot = hot; this.canvas.redraw(); }
      cv.title = y < 0 && cx.t.kind !== 'audio' ? 'Drag the white handle to change the clip length, the orange one to change the loop (Shift: finer)' : '';
      if (y < 0 && cx.t.kind !== 'audio') { cv.style.cursor = hot ? 'ew-resize' : 'default'; return; }
      if (cx.t.kind === 'audio' || g.drum || y >= g.gh || x < KEYW) { cv.style.cursor = g.drum ? 'pointer' : 'default'; return; }
      const hit = this.hitNote(cx.clip, x, y);
      cv.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'move') : 'crosshair';
    });
    cv.addEventListener('pointerleave', () => { if (this.stripHot) { this.stripHot = null; this.canvas.redraw(); } });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cx = this.ctx; if (!cx) return;
      if (e.ctrlKey || e.metaKey) {
        const [x] = local(e), t = this.xt(x);
        this.pr.zoom = Math.max(8, Math.min(400, this.pr.zoom * Math.pow(1.0018, -e.deltaY)));
        this.pr.sx = Math.max(0, t * this.pr.zoom - (x - this.geomCache.gx));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.pr.sx = Math.max(0, this.pr.sx + (e.deltaX || e.deltaY));
      else if (isRoll(cx.t)) this.pr.top = Math.max(20, Math.min(127, this.pr.top - Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 30))));
      this.canvas.redraw();
    }, { passive: false });
    cv.addEventListener('keydown', (e) => this.key(e));
  }
  // two fingers: scroll (and zoom the piano roll)
  bindPinch(cv, local) {
    const pts = new Map();
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || e.synthetic) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size !== 2) return;
      clearTimeout(this.deferT); this.deferT = 0;
      const [a, b] = [...pts.values()], r = cv.getBoundingClientRect();
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx0: (a.x + b.x) / 2 - r.left, cy0: (a.y + b.y) / 2, zoom0: this.pr.zoom, sx0: this.pr.sx, top0: this.pr.top };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = this.pinch; if (!g || pts.size < 2) return;
      const [a, b] = [...pts.values()], r = cv.getBoundingClientRect(), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2;
      const gx = this.geomCache?.gx ?? KEYW, drum = this.ctx?.t.kind === 'drum';
      const zoom = drum ? this.pr.zoom : Math.max(8, Math.min(400, g.zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0));
      const beat = (g.cx0 - gx + g.sx0) / g.zoom0;
      this.pr.zoom = zoom; this.pr.sx = Math.max(0, beat * zoom - (cx - gx));
      if (!drum) this.pr.top = Math.max(20, Math.min(127, g.top0 + Math.round((cy - g.cy0) / this.pr.rowH)));
      this.canvas.redraw();
    });
    const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) this.pinch = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  }
  hitNote(clip, x, y) {
    const loop = clip.loop || clip.len;
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      if (n.t >= loop) continue;
      const x0 = this.tx(n.t), x1 = x0 + Math.max(3, Math.min(n.d, loop - n.t) * this.pr.zoom), y0 = this.ny(n.n);
      const ez = COARSE ? Math.max(6, Math.min(16, (x1 - x0) * 0.4)) : 6;
      if (x >= x0 - (COARSE ? 4 : 0) && x <= x1 + (COARSE ? 4 : 0) && y >= y0 && y < y0 + this.pr.rowH) return { n, edge: x > x1 - ez && x1 - x0 > (COARSE ? 8 : 10) };
    }
    return null;
  }
  audition(n, e) {
    const cx = this.ctx; if (!cx) return;
    this.app.noteOn(cx.t.id, n, 100);
    this.held = n; this.canvas.redraw();
    const up = () => { this.app.noteOff(cx.t.id, n); this.held = null; this.canvas.redraw(); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointerup', up);
  }
  rollDown(e, { t, clip }, g, x, y, local) {
    const hit = this.hitNote(clip, x, y);
    const tag = 'roll' + Math.random();
    if (!hit) {
      if (e.shiftKey || this.tool === 'select') {             // rubber band
        this.band = { x0: x, y0: y, x1: x, y1: y };
        dragPointer(e, (m) => { const [mx, my] = local(m); this.band.x1 = mx; this.band.y1 = my; this.canvas.redraw(); }, () => {
          const b = this.band; this.band = null;
          const t0 = this.xt(Math.min(b.x0, b.x1)), t1 = this.xt(Math.max(b.x0, b.x1)), n1 = this.yn(Math.min(b.y0, b.y1)), n0 = this.yn(Math.max(b.y0, b.y1));
          for (const n of clip.notes) if (n.t + n.d > t0 && n.t < t1 && n.n >= n0 && n.n <= n1) this.sel.add(n);
          this.canvas.redraw(); this.renderBar();
        });
        return;
      }
      const nt = { t: Math.max(0, this.snapT(this.xt(x), true)), d: this.pr.len, n: this.yn(y), v: 100 };
      if (nt.t >= (clip.loop || clip.len)) return;
      this.change((cl) => cl.notes.push(nt), tag);
      this.sel.clear(); this.sel.add(nt);
      this.app.noteOn(t.id, nt.n, 100);
      const t0 = nt.t;
      dragPointer(e, (m) => {
        const [mx] = local(m);
        this.change(() => { nt.d = Math.max(this.app.view.snap || 1 / 32, this.snapT(this.xt(mx)) - t0); this.pr.len = nt.d; }, tag);
      }, () => { this.app.noteOff(t.id, nt.n); this.app.store.endGesture(); this.renderBar(); });
      return;
    }
    let n = hit.n;
    if (this.tool === 'select') { this.sel.has(n) ? this.sel.delete(n) : this.sel.add(n); this.canvas.redraw(); this.renderBar(); return; }
    if ((this.tool || 'draw') !== 'draw') { this.change(() => this.cycle(n, this.tool)); return; }
    if (e.shiftKey) { this.sel.has(n) ? this.sel.delete(n) : this.sel.add(n); this.canvas.redraw(); this.renderBar(); return; }
    if (!this.sel.has(n)) { this.sel.clear(); this.sel.add(n); this.renderBar(); }
    if (e.altKey) {                                            // Alt-drag: copies
      const copies = [...this.sel].map((s) => ({ ...s }));
      this.change((cl) => cl.notes.push(...copies), tag);
      const map = new Map([...this.sel].map((s, i) => [s, copies[i]]));
      n = map.get(n); this.sel = new Set(copies);
    }
    const start = [...this.sel].map((s) => ({ s, t: s.t, n: s.n, d: s.d }));
    const t0 = this.xt(x), n0 = this.yn(y);
    let lastPitch = n.n;
    this.app.noteOn(t.id, n.n, n.v);
    const loop = clip.loop || clip.len;
    dragPointer(e, (m) => {
      const [mx, my] = local(m);
      const dt = this.xt(mx) - t0, dn = this.yn(my) - n0;
      this.change(() => {
        for (const o of start) {
          if (hit.edge) o.s.d = Math.max(this.app.view.snap || 1 / 32, this.snapT(o.t + o.d + dt) - o.t);
          else {
            o.s.t = Math.max(0, Math.min(loop - 1 / 64, this.snapT(o.t + dt)));
            o.s.n = Math.max(0, Math.min(127, o.n + dn));
          }
        }
      }, tag);
      if (!hit.edge && n.n !== lastPitch) { this.app.noteOff(t.id, lastPitch); lastPitch = n.n; this.app.noteOn(t.id, n.n, n.v); }
    }, () => { this.app.noteOff(t.id, lastPitch); this.app.store.endGesture(); });
  }
  velDown(e, { clip }, local) {
    const tag = 'vel' + Math.random(), g = this.geomCache;
    const apply = (m) => {
      const [mx, my] = local(m);
      const v = Math.max(1, Math.min(127, Math.round((1 - (my - g.gh - 3) / (VELH - 8)) * 127)));
      const loop = clip.loop || clip.len;
      this.change((cl) => {
        for (const n of cl.notes) {
          if (n.t >= loop) continue;
          const nx = this.tx(n.t);
          if (Math.abs(nx - mx) < (COARSE ? 12 : 5)) n.v = v;
        }
      }, tag);
    };
    apply(e);
    dragPointer(e, apply, () => this.app.store.endGesture());
  }
  drumDown(e, { t, clip }, g, x, y, local) {
    const lib = this.app.lib.sloop, rh = g.rowH;
    const laneAt = (yy) => Math.floor(yy / rh);
    const l = laneAt(y);
    if (l < 0 || l >= lib.lanes.length) return;
    if (x < g.gx) { this.audition(lib.laneNotes[l], e); return; }
    const loop = clip.loop || clip.len, tag = 'drum' + Math.random();
    const stepAt = (xx) => Math.floor(this.xt(xx) * 4);
    const find = (cl, s, lane) => cl.notes.find((n) => n.n === lib.laneNotes[lane] && Math.abs(n.t - s / 4) < 0.125);
    const s0 = stepAt(x);
    if (s0 < 0 || s0 / 4 >= loop) return;
    const exists = find(clip, s0, l);
    if (this.tool === 'accent') {                             // normal > accent > ghost, or a new accent
      this.change((cl) => { const n = find(cl, s0, l); if (n) n.v = n.v >= 120 ? 50 : n.v < 80 ? 100 : 127; else cl.notes.push({ t: s0 / 4, d: 0.25, n: lib.laneNotes[l], v: 127 }); });
      return;
    }
    if ((this.tool || 'draw') !== 'draw') { if (exists) this.change((cl) => this.cycle(find(cl, s0, l), this.tool)); return; }
    if (e.shiftKey && exists) {                                 // velocity cycle: normal > accent > ghost
      this.change((cl) => { const n = find(cl, s0, l); n.v = n.v >= 120 ? 50 : n.v < 80 ? 100 : 127; });
      return;
    }
    const mode = !exists;
    const touched = new Set();
    const paint = (xx, yy) => {
      const s = stepAt(xx), lane = laneAt(yy), key = s + ':' + lane;
      if (s < 0 || s / 4 >= loop || lane < 0 || lane >= lib.lanes.length || touched.has(key)) return;
      touched.add(key);
      this.change((cl) => {
        const n = find(cl, s, lane);
        if (mode && !n) cl.notes.push({ t: s / 4, d: 0.25, n: lib.laneNotes[lane], v: 100 });
        else if (!mode && n) cl.notes = cl.notes.filter((q) => q !== n);
      }, tag);
      if (mode) { this.app.noteOn(t.id, lib.laneNotes[lane], 100); }
    };
    paint(x, y);
    dragPointer(e, (m) => { const [mx, my] = local(m); paint(mx, my); }, () => this.app.store.endGesture());
  }
  deleteSelected() {
    if (!this.ctx || !this.sel.size) return;
    this.change((cl) => { cl.notes = cl.notes.filter((n) => !this.sel.has(n)); }); this.sel.clear(); this.renderBar();
  }
  key(e) {
    const cx = this.ctx; if (!cx || !isRoll(cx.t)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!this.sel.size) return;
      e.preventDefault(); e.stopPropagation();
      this.change((cl) => { cl.notes = cl.notes.filter((n) => !this.sel.has(n)); }); this.sel.clear();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault(); e.stopPropagation(); for (const n of cx.clip.notes) this.sel.add(n); this.canvas.redraw(); this.renderBar();
    } else if (mod && e.key.toLowerCase() === 'd' && this.sel.size) {
      e.preventDefault(); e.stopPropagation();
      const ns = [...this.sel], t0 = Math.min(...ns.map((n) => n.t)), t1 = Math.max(...ns.map((n) => n.t + n.d)), span = Math.ceil((t1 - t0) / (this.app.view.snap || 0.25)) * (this.app.view.snap || 0.25);
      const copies = ns.map((n) => ({ ...n, t: n.t + span }));
      this.change((cl) => cl.notes.push(...copies)); this.sel = new Set(copies);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.sel.size) return;
      e.preventDefault(); e.stopPropagation();
      this.transpose((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && this.sel.size) {
      e.preventDefault(); e.stopPropagation();
      const d = (e.key === 'ArrowRight' ? 1 : -1) * (this.app.view.snap || 0.25);
      this.change((cl) => { for (const n of cl.notes) if (this.sel.has(n)) n.t = Math.max(0, n.t + d); }, 'nudge');
    } else if (e.key === 'q' || e.key === 'Q') { e.stopPropagation(); this.quantize(); }
    else if (e.key === 'Escape') { this.sel.clear(); this.canvas.redraw(); this.renderBar(); }
  }
}
