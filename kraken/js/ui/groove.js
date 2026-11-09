// SPDX-License-Identifier: GPL-3.0-only
// GROOVE: Kraken as a groovebox, made for a phone first (and for a tablet or a desk). The same project, tracks, sounds
// and engines as the DAW; only the way in changes:
//   PADS   sixteen pads per track (Koala, an MPC): a kit's sounds, or a synth's notes in its scale; sample the mic onto a pad
//   STEPS  sixteen steps a page, four pages (an Elektron box): per step its velocity, length, chance, a trig condition,
//          a retrig, a nudge, and parameter locks (any of the sound's knobs, for that step alone)
//   CLIPS  the session: a clip per track per scene, launched (Ableton Note); a scene is a pattern of every track
//   SOUND  the track's sound and its main knobs; MIX levels, mutes, sends; FX live effects on everything (held)
// A pattern is a scene: each track's clip in that scene's slot. Steps and pads write into it; PLAY launches it.
import { h, noteName, fmt } from './kit.js';
import { newClip, uid } from '../project.js';
import { SCALES } from '../notefx.js';
import { barOf } from '../meter.js';

const STEP = 0.25;                                                 // a step: a 16th
const PLAYABLE = ['drum', 'synth', 'sampler', 'lab', 'wam', 'external'];
// the General MIDI drum keys, for a synth track whose engine is a drum machine (X0X's TR-909, FOMAJAM…)
const GM = [[36, 'KICK'], [38, 'SNARE'], [42, 'CL HAT'], [46, 'OP HAT'], [39, 'CLAP'], [37, 'RIM'], [41, 'LO TOM'], [45, 'MID TOM'],
  [48, 'HI TOM'], [49, 'CRASH'], [51, 'RIDE'], [56, 'COWBELL'], [54, 'TAMB'], [70, 'SHAKER'], [63, 'CONGA'], [75, 'CLAVE']];
export const CONDS = ['', '1:2', '2:2', '1:3', '2:3', '3:3', '1:4', '2:4', '3:4', '4:4', 'fill', '!fill', 'first', '!first', 'pre', '!pre'];
const COND_NAME = { '': 'ALWAYS', fill: 'FILL', '!fill': 'NOT FILL', first: 'FIRST', '!first': 'NOT FIRST', pre: 'PRE', '!pre': 'NOT PRE' };
const REPEAT = [[0, 'OFF'], [1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32']];
const TABS = [['pads', 'PADS'], ['steps', 'STEPS'], ['clips', 'CLIPS'], ['sound', 'SOUND'], ['mix', 'MIX'], ['fx', 'FX']];
const ICON = {
  pads: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
  steps: '<rect x="2" y="9" width="4" height="6" rx="1"/><rect x="7.3" y="9" width="4" height="6" rx="1" opacity=".35"/><rect x="12.6" y="9" width="4" height="6" rx="1"/><rect x="18" y="9" width="4" height="6" rx="1" opacity=".35"/>',
  clips: '<rect x="3" y="4" width="8" height="5" rx="1.2"/><rect x="13" y="4" width="8" height="5" rx="1.2" opacity=".35"/><rect x="3" y="11" width="8" height="5" rx="1.2" opacity=".35"/><rect x="13" y="11" width="8" height="5" rx="1.2"/><rect x="3" y="18" width="18" height="2" rx="1" opacity=".5"/>',
  sound: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12 16.5 7.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  mix: '<path d="M6 3v18M12 3v18M18 3v18" stroke="currentColor" stroke-width="1.6" opacity=".45"/><rect x="3.5" y="12" width="5" height="3" rx="1"/><rect x="9.5" y="6" width="5" height="3" rx="1"/><rect x="15.5" y="15" width="5" height="3" rx="1"/>',
  fx: '<path d="M3 15c3 0 3-6 6-6s3 9 6 9 3-12 6-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const svg = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[name]; s.setAttribute('fill', 'currentColor'); return s; };

// while a finger holds a slider or a pad, GROOVE does not redraw (a redraw would take the element from under it):
// it redraws when the finger lets go
let holding = 0, afterHold = null;
const hold = () => { holding++; };
const letGo = () => { holding = Math.max(0, holding - 1); if (!holding) afterHold?.(); };

// a press that becomes a long press (held 380 ms without moving): tap() or long()
function press(el, { tap, long, down, up }) {
  let timer = 0, x0 = 0, y0 = 0, fired = true;                     // (a release here without a press here: nothing)
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    fired = false; x0 = e.clientX; y0 = e.clientY;
    down?.(e);
    if (long) timer = setTimeout(() => { fired = true; long(e); }, 380);
  });
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) { clearTimeout(timer); timer = 0; } });
  const end = (e, cancel) => { clearTimeout(timer); timer = 0; up?.(e); if (!fired && !cancel) tap?.(e); fired = true; };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// a slider for a thumb: drag sideways anywhere on it (relative: precise), a double tap resets it
export function slider({ label, min, max, value, def = min, format = (v) => String(v), onChange, onEnd, color, step = 1, locked = false }) {
  let v = value;
  const fill = h('i'), val = h('b', { class: 'gv' }), el = h('div', { class: 'gs' + (locked ? ' lock' : ''), role: 'slider', tabindex: 0, 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max },
    fill, h('span', { class: 'gl', text: label }), val);
  if (color) el.style.setProperty('--c', color);
  const draw = () => {
    const bip = min < 0 && max > 0, k = (v - min) / (max - min || 1), z = bip ? (0 - min) / (max - min) : 0;
    fill.style.left = `${Math.min(k, z) * 100}%`; fill.style.width = `${Math.abs(k - z) * 100}%`;
    val.textContent = format(v); el.setAttribute('aria-valuenow', v);
  };
  const set = (nv) => { nv = Math.max(min, Math.min(max, Math.round(nv / step) * step)); if (nv !== v) { v = nv; draw(); onChange?.(v); } };
  let last = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    hold();
    const now = performance.now();
    if (now - last < 300) { set(def); onEnd?.(v); last = 0; letGo(); return; }
    last = now;
    const x0 = e.clientX, v0 = v, w = el.getBoundingClientRect().width, range = max - min;
    const move = (m) => set(v0 + ((m.clientX - x0) / Math.max(120, w)) * range * (m.shiftKey ? 0.2 : 1));
    const upf = () => { for (const [k, f] of [['pointermove', move], ['pointerup', upf], ['pointercancel', upf], ['lostpointercapture', upf]]) el.removeEventListener(k, f); onEnd?.(v); letGo(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', upf); el.addEventListener('pointercancel', upf); el.addEventListener('lostpointercapture', upf);
  });
  el.addEventListener('keydown', (e) => { const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (d) { e.preventDefault(); set(v + d * step * (e.shiftKey ? 10 : 1)); onEnd?.(v); } });
  el.setValue = (nv) => { v = nv; draw(); };
  draw();
  return el;
}

export class Groove {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('groove');
    document.body.append(this.root);                                // (outside #app, which hides under it)
    this.g = { tab: 'pads', scene: 0, page: 0, oct: {}, lane: {}, note: {}, sel: new Set(), rec: false, quant: true, repeat: 0, fullVel: false, chord: false, sample: false, latch: false };
    this.perf = { stutter: 0, x: 0, y: 0, tape: false, crush: 0 };
    this.held = new Map();                                         // pointer id -> { t, notes, timer }
    this.flash = new Map();
    try { Object.assign(this.g, JSON.parse(localStorage.getItem('kraken.groove') || '{}'), { sel: new Set(), sample: false, rec: false }); } catch { /* */ }
    app.grooveQuant = this.g.quant;
    app.store.on(() => { if (this.open) this.renderSoon(); });
    afterHold = () => { if (this.open) this.renderSoon(); };
    addEventListener('resize', () => { if (this.open) this.renderSoon(); });
  }
  get p() { return this.app.store.p; }
  save() { try { const { tab, scene, quant, repeat, fullVel, chord, latch } = this.g; localStorage.setItem('kraken.groove', JSON.stringify({ tab, scene, quant, repeat, fullVel, chord, latch })); } catch { /* */ } }
  get open() { return !this.root.hidden; }
  show(on = true) {
    this.root.hidden = !on;
    document.body.classList.toggle('groove-on', on);
    this.app.view.groove = on;
    try { localStorage.setItem('kraken.grooveOn', on ? '1' : '0'); } catch { /* */ }
    if (on) {
      this.track(); this.render();
      let seen = true; try { seen = !!localStorage.getItem('kraken.grooveSeen'); localStorage.setItem('kraken.grooveSeen', '1'); } catch { /* */ }
      if (!seen) setTimeout(() => this.app.toast('GROOVE: play the pads, write a beat in STEPS, ▶ plays the pattern. DAW takes you to the full studio.'), 400);
    }
    else { this.setPerf({ stutter: 0, x: 0, y: 0, tape: false, crush: 0 }); this.app.audio.send({ t: 'fill', on: false }); }
  }
  // ---------------------------------------------------------------- model ---
  tracks() { return this.p.tracks.filter((t) => PLAYABLE.includes(t.kind)); }
  track() {
    const app = this.app, list = this.tracks();
    let t = list.find((x) => x.id === app.view.selTrack);
    if (!t && list[0]) { t = list[0]; app.view.selTrack = t.id; }
    return t || null;
  }
  scene() { return Math.min(this.g.scene, this.p.scenes.length - 1); }
  clip(t = this.track(), s = this.scene()) { return t?.slots?.[s] || null; }
  drumMap(t) {
    if (!t) return null;
    if (t.kind === 'drum') { const lib = this.app.lib.sloop; return lib.laneNotes.map((n, i) => [n, lib.lanes[i] || noteName(n)]); }
    if (t.kind === 'synth') { const e = this.app.lib[t.bank]?.engines?.[t.engine]; if (e && /DRUM|KIT|TR-|PERC/i.test(e.name)) return GM; }
    return null;
  }
  // the 16 notes a synth's pads play: its SCALE (NOTE FX), else the song's KEY, else chromatic, from its octave
  padNotes(t) {
    const d = t.nfx?.find((x) => x.type === 'scale' && x.on !== false), key = d ? { root: d.p.ro | 0, sc: d.p.sc | 0 } : this.p.key;
    const steps = key ? (SCALES[key.sc] || SCALES[0])[1] : SCALES[SCALES.length - 1][1], root = key?.root || 0;
    const base = 12 * ((this.g.oct[t.id] ?? 3) + 1) + root, out = [];
    for (let i = 0; out.length < 16; i++) out.push(base + 12 * Math.floor(i / steps.length) + steps[i % steps.length]);
    return out.filter((n) => n <= 127);
  }
  loopOf(c) { return c ? (c.loop || c.len) : this.p.sig * 4 || 4; }
  // the pattern being edited: this track's clip in this scene, made (one bar) when it is not there yet
  ensureClip(t = this.track(), s = this.scene()) {
    if (!t) return null;
    if (t.slots[s]) return t.slots[s];
    const nc = newClip(0, (barOf(this.p, 0).len || 4), t.kind === 'drum' || this.drumMap(t) ? 'BEAT' : 'PATTERN');
    delete nc.start;
    this.app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); while (x.slots.length <= s) x.slots.push(null); x.slots[s] = nc; });
    this.app.view.selClip = nc.id;
    return this.track().slots[s];
  }
  edit(fn, tag) { this.app.store.change((p) => { const t = p.tracks.find((x) => x.id === this.app.view.selTrack); const c = t?.slots[this.scene()]; if (c) fn(c, t, p); }, tag); }
  // ---------------------------------------------------------------- notes ---
  playing() { return this.app.playing; }
  stepNow(t = this.track()) {
    const st = this.app.session.state[t?.id], c = this.clip(t);
    if (!this.app.playing || !st || st.slot !== this.scene() || st.at == null || !c) return -1;
    const loop = this.loopOf(c);
    return Math.floor((((this.app.pos - st.at) % loop) + loop) % loop / STEP);
  }
  hit(t, n, v) {
    const app = this.app;
    if (this.g.rec && app.playing) { const s = this.scene(); if (!t.slots[s]) { this.ensureClip(t, s); } if (app.session.state[t.id]?.slot !== s) app.launch(t.id, s); }
    app.noteOn(t.id, n, v, true);
  }
  // ------------------------------------------------------------ transport ---
  play() {
    const app = this.app, s = this.scene();
    if (app.playing) { app.play(false); return; }
    const any = this.p.tracks.some((t) => t.slots?.[s]);
    if (!any) this.ensureClip();
    app.audio.send({ t: 'scene', slot: s });
    app.play(true);
  }
  record() {
    const app = this.app;
    this.g.rec = !this.g.rec;
    app.grooveRec = this.g.rec;
    if (this.g.rec) { this.ensureClip(); if (!app.playing) this.play(); else app.launch(this.track().id, this.scene()); }
    app.setRecord(this.g.rec);
    this.renderSoon();
  }
  pickScene(i) {
    this.g.scene = i; this.g.page = 0; this.g.sel.clear(); this.save();
    if (this.app.playing) this.app.launchScene(i);
    const c = this.clip(); if (c) this.app.view.selClip = c.id;
    this.render();
  }
  setPerf(o) { Object.assign(this.perf, o); this.app.audio.send({ t: 'perf', ...this.perf }); }
  // --------------------------------------------------------------- render ---
  renderSoon() { if (holding || this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  wide() { return innerWidth >= 900 && innerWidth > innerHeight * 1.1; }
  render() {
    if (!this.open) return;
    const t = this.track(), g = this.g, wide = this.wide();
    if (wide && g.tab === 'pads') g.tab = 'steps';
    this.root.classList.toggle('wide', wide);
    this.root.style.setProperty('--tc', t?.color || 'var(--accent)');
    const page = t ? this[`page_${g.tab}`](t) : this.emptyPage();
    const main = wide ? h('div', { class: 'gw-split' }, h('section', { class: 'gw-left' }, t ? this.page_pads(t) : null), h('section', { class: 'gw-right' }, page)) : h('section', { class: 'gw-page' }, page);
    this.root.replaceChildren(this.topBar(t), this.trackBar(t), this.sceneBar(), main, this.tabBar(wide));
  }
  emptyPage() { return h('div', { class: 'gw-empty' }, h('b', { text: 'No instrument yet' }), h('button', { class: 'gw-btn go', onclick: () => this.addTrackSheet() }, 'Add a track')); }
  topBar(t) {
    const app = this.app, p = this.p;
    return h('header', { class: 'gw-top' },
      h('button', { class: 'gw-ic', title: 'Back to the full DAW', 'aria-label': 'Back to the DAW', onclick: () => this.show(false) }, h('span', { text: 'DAW' })),
      h('button', { class: 'gw-play' + (app.playing ? ' on' : ''), 'aria-label': app.playing ? 'Stop' : 'Play', onclick: () => { this.play(); setTimeout(() => this.renderSoon(), 50); } }, h('span', { class: app.playing ? 'sq' : 'tri' })),
      h('button', { class: 'gw-rec' + (this.g.rec ? ' on' : ''), 'aria-label': 'Record', title: 'Record what you play on the pads into the pattern', onclick: () => this.record() }, h('span')),
      h('button', { class: 'gw-lcd', title: 'Tempo and swing', onclick: () => this.tempoSheet() }, h('b', { text: String(Math.round(p.bpm)) }), h('small', { text: 'BPM' })),
      h('button', { class: 'gw-lcd', title: 'Metronome', onclick: () => { app.click = !app.click; app.audio.send({ t: 'click', on: app.click }); this.renderSoon(); } }, h('b', { class: app.click ? 'lit' : '', text: app.click ? 'ON' : 'OFF' }), h('small', { text: 'CLICK' })),
      h('span', { class: 'gw-fill' }),
      h('button', { class: 'gw-ic', 'aria-label': 'Undo', title: 'Undo', onclick: () => app.store.undo?.() }, '↶'),
      h('button', { class: 'gw-ic', 'aria-label': 'Menu', onclick: () => this.menu() }, '⋯'));
  }
  trackBar(t) {
    const app = this.app;
    return h('nav', { class: 'gw-tracks', 'aria-label': 'Tracks' },
      this.tracks().map((x) => {
        const b = h('button', { class: 'gw-trk' + (x.id === t?.id ? ' on' : '') + (x.mute ? ' muted' : ''), style: { '--c': x.color }, translate: 'no' },
          h('i'), h('span', { text: x.name }));
        press(b, { tap: () => { app.selectTrack(x.id); const c = this.clip(x); if (c) app.view.selClip = c.id; this.g.sel.clear(); this.render(); }, long: () => this.trackSheet(x) });
        return b;
      }),
      h('button', { class: 'gw-trk add', 'aria-label': 'Add a track', onclick: () => this.addTrackSheet() }, '+'));
  }
  sceneBar() {
    const p = this.p, s = this.scene(), st = this.app.session.state;
    const playingScene = (i) => Object.values(st).some((x) => x.slot === i);
    return h('nav', { class: 'gw-scenes', 'aria-label': 'Patterns' },
      h('span', { class: 'gw-cap', text: 'PATTERN' }),
      p.scenes.map((sc, i) => {
        const has = p.tracks.some((t) => t.slots?.[i]), b = h('button', { class: 'gw-sc' + (i === s ? ' on' : '') + (playingScene(i) ? ' play' : '') + (has ? '' : ' none'), translate: 'no', title: sc.name }, String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''));
        press(b, { tap: () => this.pickScene(i), long: () => this.sceneSheet(i) });
        return b;
      }),
      h('button', { class: 'gw-sc add', 'aria-label': 'Add a pattern', onclick: () => this.addScene(true) }, '+'));
  }
  tabBar(wide) {
    return h('footer', { class: 'gw-tabs', role: 'tablist' },
      TABS.filter(([k]) => !(wide && k === 'pads')).map(([k, l]) => h('button', { class: 'gw-tab' + (this.g.tab === k ? ' on' : ''), role: 'tab', 'aria-selected': String(this.g.tab === k),
        onclick: () => { this.g.tab = k; this.g.sel.clear(); this.save(); this.render(); } }, svg(k), h('span', { text: l }))));
  }

  // ----------------------------------------------------------------- PADS ---
  page_pads(t) {
    const g = this.g, drums = this.drumMap(t), notes = drums ? drums.map(([n]) => n) : this.padNotes(t);
    const names = drums ? drums.map(([, l]) => l) : notes.map((n) => noteName(n));
    const c = this.clip(t), used = new Set((c?.notes || []).map((x) => x.n)), sel = drums ? (g.lane[t.id] ?? notes[0]) : g.note[t.id];
    const tools = h('div', { class: 'gw-tools' },
      drums ? null : h('div', { class: 'gw-seg' },
        h('button', { class: 'gw-btn', 'aria-label': 'Octave down', onclick: () => { g.oct[t.id] = Math.max(0, (g.oct[t.id] ?? 3) - 1); this.render(); } }, 'OCT −'),
        h('span', { class: 'gw-val', text: `C${g.oct[t.id] ?? 3}` }),
        h('button', { class: 'gw-btn', 'aria-label': 'Octave up', onclick: () => { g.oct[t.id] = Math.min(8, (g.oct[t.id] ?? 3) + 1); this.render(); } }, 'OCT +')),
      drums ? null : h('button', { class: 'gw-btn' + (g.chord ? ' on' : ''), title: 'Each pad plays a chord of the scale', onclick: () => { g.chord = !g.chord; this.save(); this.render(); } }, 'CHORDS'),
      h('button', { class: 'gw-btn' + (g.repeat ? ' on' : ''), title: 'Note repeat: a held pad repeats in time', onclick: () => this.pickSheet('Note repeat', REPEAT, g.repeat, (v) => { g.repeat = v; this.save(); this.render(); }) }, g.repeat ? `REPEAT ${REPEAT.find(([v]) => v === g.repeat)?.[1]}` : 'NOTE REPEAT'),
      h('button', { class: 'gw-btn' + (g.fullVel ? ' on' : ''), title: 'Every hit at full velocity (off: higher on the pad is louder)', onclick: () => { g.fullVel = !g.fullVel; this.save(); this.render(); } }, 'FULL VEL'),
      t.kind === 'drum' ? h('button', { class: 'gw-btn' + (g.sample ? ' on rec' : ''), title: 'Sample: tap a pad, record with the microphone, tap again to stop', onclick: () => { g.sample = !g.sample; this.render(); if (g.sample) this.app.toast('Tap a pad to record into it. Tap it again to stop.'); } }, g.sample ? 'TAP A PAD' : 'SAMPLE') : null);
    const pads = h('div', { class: 'gw-pads' + (g.sample ? ' sampling' : ''), style: { '--c': t.color } },
      notes.map((n, i) => {
        const pad = h('button', { class: 'gw-pad' + (n === sel ? ' sel' : '') + (used.has(n) ? ' used' : '') + (t.pads?.[n] ? ' smp' : ''), 'data-n': n, 'aria-label': names[i], translate: 'no' },
          h('span', { class: 'pl', text: names[i] }), t.pads?.[n] ? h('em', { text: (t.pads[n].name || 'SAMPLE').replace(/\.\w+$/, '').slice(0, 10) }) : null);
        this.padEvents(pad, t, n, notes, drums);
        return pad;
      }));
    return h('div', { class: 'gw-padpage' }, tools, pads);
  }
  padEvents(pad, t, n, notes, drums) {
    const g = this.g;
    pad.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault(); pad.setPointerCapture(e.pointerId);
      if (g.sample) { this.samplePad(t, n, pad); return; }
      hold();
      const r = pad.getBoundingClientRect(), v = g.fullVel ? 127 : Math.round(127 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 70);
      const chord = !drums && g.chord ? this.chordOf(notes, notes.indexOf(n)) : [n];
      for (const x of chord) this.hit(t, x, v);
      pad.classList.add('down'); pad.style.setProperty('--v', (v / 127).toFixed(2));
      if (drums) g.lane[t.id] = n; else g.note[t.id] = n;
      const held = { notes: chord, timer: 0 };
      if (g.repeat) {
        const tick = () => { for (const x of chord) { this.app.noteOff(t.id, x); this.hit(t, x, v); } held.timer = setTimeout(tick, g.repeat * 60000 / this.p.bpm); };
        held.timer = setTimeout(tick, g.repeat * 60000 / this.p.bpm);
      }
      this.held.set(e.pointerId, held);
      pad.parentElement.querySelectorAll('.gw-pad.sel').forEach((x) => x.classList.toggle('sel', x === pad));
      pad.classList.add('sel');
    });
    const up = (e) => {
      const held = this.held.get(e.pointerId);
      if (!held) return;
      clearTimeout(held.timer);
      for (const x of held.notes) this.app.noteOff(t.id, x);
      this.held.delete(e.pointerId);
      pad.classList.remove('down');
      letGo();
    };
    pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
    pad.addEventListener('contextmenu', (e) => { e.preventDefault(); if (t.kind === 'drum') this.padSheet(t, n); });
  }
  chordOf(notes, i) { return [notes[i], notes[i + 2], notes[i + 4]].filter((x) => x != null); }
  // the microphone onto a pad: a tap starts, a tap stops; the silence before the sound is cut
  async samplePad(t, n, pad) {
    const app = this.app;
    if (this.sampling) {
      const s = this.sampling; this.sampling = null; s.rec.stop(); return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (err) { app.toast(`The microphone is not available: ${err.message || 'access refused'}.`); this.g.sample = false; this.render(); return; }
    const chunks = [], rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((x) => x.stop());
      pad.classList.remove('recording');
      try {
        const buf = await app.audio.ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
        const file = trimmedWav(buf, `PAD ${noteName(n)}.wav`);
        if (!file) { app.toast('Nothing was heard: try closer to the microphone.'); return; }
        await app.setPadSample(t.id, n, file);
        app.toast('Sampled onto the pad.');
      } catch (err) { app.toast(`That recording could not be used (${err.message}).`); }
      this.g.sample = false; this.render();
    };
    this.sampling = { rec };
    rec.start();
    pad.classList.add('recording');
    setTimeout(() => { if (this.sampling?.rec === rec) { this.sampling = null; rec.stop(); } }, 20000);   // (20 s at most)
  }
  padSheet(t, n) {
    const app = this.app, has = !!t.pads?.[n];
    app.sheet(`Pad ${this.drumMap(t)?.find(([x]) => x === n)?.[1] || noteName(n)}`, [
      ['SAMPLE FROM THE MICROPHONE', () => { this.g.sample = true; this.render(); app.toast('Tap the pad to start, tap again to stop.'); }],
      ['LOAD A SOUND FILE…', () => { const inp = h('input', { type: 'file', accept: 'audio/*', hidden: true }); inp.onchange = () => { if (inp.files[0]) app.setPadSample(t.id, n, inp.files[0]); inp.remove(); }; document.body.append(inp); inp.click(); }],
      ...(has ? [['BACK TO THE KIT SOUND', () => app.clearPad(t.id, n), 'danger']] : []),
    ]);
  }

  // ---------------------------------------------------------------- STEPS ---
  page_steps(t) {
    const app = this.app, g = this.g, drums = this.drumMap(t), c = this.clip(t), loop = this.loopOf(c), nSteps = Math.round(loop / STEP);
    const pages = Math.max(1, Math.ceil(nSteps / 16)); if (g.page >= pages) g.page = 0;
    const lane = drums ? (g.lane[t.id] ?? drums[0][0]) : null, stepNote = g.note[t.id] ?? this.padNotes(t)[0];
    const notesAt = (i) => (c?.notes || []).filter((x) => Math.abs(x.t - i * STEP) < STEP / 2 - 1e-6 && (lane == null || x.n === lane));
    const now = this.stepNow(t);
    const head = h('div', { class: 'gw-tools' },
      drums ? h('div', { class: 'gw-lanes', translate: 'no' }, drums.map(([n, l]) => {
        const has = (c?.notes || []).some((x) => x.n === n);
        return h('button', { class: 'gw-lane' + (n === lane ? ' on' : '') + (has ? ' has' : ''), onclick: () => { g.lane[t.id] = n; g.sel.clear(); this.render(); app.noteOn(t.id, n, 100, false, true); setTimeout(() => app.noteOff(t.id, n), 120); } }, l);
      })) : h('div', { class: 'gw-seg' }, h('span', { class: 'gw-cap', text: 'NEW STEPS PLAY' }),
        h('button', { class: 'gw-btn', onclick: () => { g.note[t.id] = Math.max(0, stepNote - 1); this.render(); } }, '−'),
        h('span', { class: 'gw-val', translate: 'no', text: noteName(stepNote) }),
        h('button', { class: 'gw-btn', onclick: () => { g.note[t.id] = Math.min(127, stepNote + 1); this.render(); } }, '+')));
    const pagesRow = h('div', { class: 'gw-tools' },
      h('div', { class: 'gw-seg' }, [...Array(4)].map((_, i) => h('button', { class: 'gw-pg' + (i === g.page ? ' on' : '') + (i < pages ? '' : ' off'), disabled: i >= pages ? true : null, onclick: () => { g.page = i; g.sel.clear(); this.render(); } }, String(i + 1)))),
      h('button', { class: 'gw-btn', title: 'The pattern\'s length, in steps', onclick: () => this.lengthSheet(t) }, `${nSteps} STEPS`),
      h('button', { class: 'gw-btn', title: 'Copy the pattern after itself: twice as long', disabled: nSteps * 2 > 64 || !c ? true : null, onclick: () => this.doublePattern() }, '×2'),
      h('button', { class: 'gw-btn', title: 'Clear this pattern (or this sound\'s steps)', disabled: !c?.notes.length ? true : null, onclick: () => this.edit((cl) => { cl.notes = lane == null ? [] : cl.notes.filter((x) => x.n !== lane); }) }, 'CLEAR'));
    const steps = h('div', { class: 'gw-steps', style: { '--c': t.color } },
      [...Array(16)].map((_, k) => {
        const i = g.page * 16 + k, here = i < nSteps ? notesAt(i) : [], on = here.length > 0, nt = here[0];
        const b = h('button', { class: 'gw-step' + (on ? ' on' : '') + (i >= nSteps ? ' out' : '') + (g.sel.has(i) ? ' sel' : '') + (i === now ? ' now' : '') + (k % 4 === 0 ? ' beat' : ''), 'data-i': i, disabled: i >= nSteps ? true : null,
          style: on ? { '--v': (nt.v / 127).toFixed(2) } : null, 'aria-label': `Step ${i + 1}`, 'aria-pressed': String(on) },
          h('span', { class: 'sn', text: String(i + 1) }),
          on && !drums ? h('span', { class: 'snote', translate: 'no', text: here.map((x) => noteName(x.n)).join(' ') }) : null,
          on ? h('span', { class: 'sx' }, nt.l ? h('i', { class: 'lk', title: 'Parameter locks' }) : null, nt.q ? h('em', { text: COND_NAME[nt.q] || nt.q }) : nt.p != null && nt.p < 1 ? h('em', { text: `${Math.round(nt.p * 100)}%` }) : null, nt.r > 1 ? h('em', { text: `×${nt.r}` }) : null) : null);
        press(b, { tap: () => this.tapStep(t, i, lane, stepNote, drums), long: () => { if (!notesAt(i).length) this.tapStep(t, i, lane, stepNote, drums, true); g.sel = new Set([i]); this.render(); } });
        return b;
      }));
    const editor = g.sel.size ? this.stepEditor(t, lane, drums) : h('p', { class: 'gw-hint', text: drums ? 'Tap a step to add a hit, again to remove it. Hold a step to edit it: velocity, chance, conditions, and locks on any knob for that step alone.' : 'Tap a step to add the note shown above, again to remove it. Hold a step to edit it. Play a pad to choose the note.' });
    return h('div', { class: 'gw-steppage' }, head, pagesRow, steps, editor);
  }
  tapStep(t, i, lane, stepNote, drums, add = false) {
    const g = this.g;
    if (g.sel.size && !add) { g.sel.has(i) ? g.sel.delete(i) : g.sel.add(i); this.ensureStep(t, i, lane, stepNote, drums); this.render(); return; }
    this.ensureClip(t);
    const at = i * STEP, n = lane ?? stepNote;
    let added = false;
    this.edit((c) => {
      const here = c.notes.filter((x) => Math.abs(x.t - at) < STEP / 2 - 1e-6 && (lane == null || x.n === lane));
      if (here.length && !add) { c.notes = c.notes.filter((x) => !here.includes(x)); return; }
      if (here.length) return;
      const ns = !drums && g.chord ? this.chordOf(this.padNotes(t), Math.max(0, this.padNotes(t).indexOf(n))) : [n];
      for (const x of ns) c.notes.push({ t: at, d: drums ? STEP : STEP * (g.len || 1), n: x, v: 100 });
      added = true;
    }, 'gstep');
    this.app.store.endGesture();
    if (added && !this.app.playing) { this.app.noteOn(t.id, n, 100, false, true); setTimeout(() => this.app.noteOff(t.id, n), 140); }
  }
  ensureStep(t, i, lane, stepNote, drums) {
    const c = this.clip(t), at = i * STEP;
    if (c && c.notes.some((x) => Math.abs(x.t - at) < STEP / 2 - 1e-6 && (lane == null || x.n === lane))) return;
    this.tapStep(t, i, lane, stepNote, drums, true);
  }
  // the selected steps: their notes (this lane's, for a drum track)
  selNotes(c, lane) { const sel = this.g.sel; return (c?.notes || []).filter((x) => [...sel].some((i) => Math.abs(x.t - i * STEP) < STEP / 2 - 1e-6) && (lane == null || x.n === lane)); }
  stepEditor(t, lane, drums) {
    const app = this.app, g = this.g, c = this.clip(t), ns = this.selNotes(c, lane), first = ns[0];
    if (!first) { g.sel.clear(); return h('div'); }
    // change every selected step's note: fn(note) inside the project
    const each = (fn, tag) => this.edit((cl) => { for (const x of this.selNotes(cl, lane)) fn(x); }, tag);
    const sl = (label, val, min, max, format, set, def, step = 1) => slider({ label, min, max, value: val, def, step, format, color: t.color, onChange: (v) => each((x) => set(x, v), `gsel${label}`), onEnd: () => app.store.endGesture() });
    const cond = first.q || '';
    const rows = [
      sl('VELOCITY', first.v, 1, 127, (v) => String(v), (x, v) => { x.v = v; }, 100),
      sl('LENGTH', Math.round(first.d / STEP * 4) / 4, 0.25, 16, (v) => `${v} ${v === 1 ? 'step' : 'steps'}`, (x, v) => { x.d = v * STEP; }, 1, 0.25),
      ...(drums ? [] : [sl('NOTE', first.n, 0, 127, (v) => noteName(v), (x, v) => { x.n = v; }, first.n)]),
      sl('CHANCE', Math.round((first.p ?? 1) * 100), 0, 100, (v) => `${v}%`, (x, v) => { if (v >= 100) delete x.p; else x.p = v / 100; }, 100, 5),
      sl('RETRIG', first.r || 1, 1, 8, (v) => (v === 1 ? 'OFF' : `×${v}`), (x, v) => { if (v > 1) x.r = v; else delete x.r; }, 1),
      sl('NUDGE', Math.round((first.m || 0) / STEP * 100), -50, 50, (v) => `${v > 0 ? '+' : ''}${v}%`, (x, v) => { if (v) x.m = v / 100 * STEP; else delete x.m; }, 0, 5),
    ];
    const condBtn = h('button', { class: 'gw-btn wide' + (cond ? ' on' : ''), onclick: () => this.pickSheet('Trig condition: when this step plays', CONDS.map((q) => [q, condLabel(q)]), cond, (q) => { each((x) => { if (q) x.q = q; else delete x.q; }); app.store.endGesture(); }) },
      h('span', { class: 'gw-cap', text: 'CONDITION' }), h('b', { text: condLabel(cond) }));
    const locks = this.lockSliders(t, ns, each);
    return h('div', { class: 'gw-editor' },
      h('div', { class: 'gw-edhead' }, h('b', { text: g.sel.size > 1 ? `${g.sel.size} steps` : `Step ${[...g.sel][0] + 1}` }),
        h('span', { class: 'gw-hint', text: 'tap other steps to edit them together' }),
        h('button', { class: 'gw-btn', onclick: () => { g.sel.clear(); this.render(); } }, 'DONE')),
      h('div', { class: 'gw-grid2' }, rows), condBtn,
      locks.length ? h('div', { class: 'gw-locks' }, h('div', { class: 'gw-edhead' }, h('b', { text: 'Locks' }), h('span', { class: 'gw-hint', text: 'the sound\'s knobs, for these steps alone' }),
        h('button', { class: 'gw-btn', disabled: ns.some((x) => x.l) ? null : true, onclick: () => { each((x) => { delete x.l; }); app.store.endGesture(); } }, 'CLEAR LOCKS')), h('div', { class: 'gw-grid2' }, locks)) : null);
  }
  // the knobs a step can lock: the engine's own, then the filter / envelope ones the catalogue has
  lockable(t) {
    const cat = this.app.lib[t.bank];
    if (!cat || !cat.engines || t.kind !== 'synth' && t.kind !== 'drum') return [];
    if (t.kind === 'drum') return [];
    const e = cat.engines[t.engine], out = (e?.edit || []).map((d, i) => [cat.e0 + i, d]);
    for (const l of ['CUTOFF', 'RESO', 'ATK', 'DEC', 'REL', 'DIST']) { const i = cat.tp.findIndex((q) => q.l === l); if (i >= 0) out.push([i, cat.tp[i]]); }
    return out.slice(0, 16);
  }
  value(t, id) {
    if (t.params[id] != null) return t.params[id];
    const v = this.app.params.get(t.id)?.[id]; if (v != null) return v;
    const cat = this.app.lib[t.bank]; return id >= cat.e0 ? cat.engines[t.engine].edit[id - cat.e0]?.def ?? 0 : cat.tp[id]?.def ?? 0;
  }
  lockSliders(t, ns, each) {
    const app = this.app;
    return this.lockable(t).map(([id, d]) => {
      const locked = ns[0].l?.[id] != null;
      const sl = slider({ label: d.l, min: d.min, max: d.max, def: this.value(t, id), value: locked ? ns[0].l[id] : this.value(t, id), format: (v) => fmt(d, v), color: t.color, locked,
        onChange: (v) => { each((x) => { x.l ||= {}; x.l[id] = v; }, `glock${id}`); sl.classList.add('lock'); app.audio.send({ t: 'param', track: t.id, id, v }); },
        onEnd: () => { app.store.endGesture(); app.audio.send({ t: 'param', track: t.id, id, v: this.value(t, id) }); } });
      return sl;
    });
  }
  lengthSheet(t) {
    const app = this.app, c = this.clip(t), cur = Math.round(this.loopOf(c) / STEP);
    this.pickSheet('Pattern length (steps)', [8, 12, 16, 24, 32, 48, 64].map((n) => [n, `${n} steps${n % 16 === 0 ? ` · ${n / 16} ${n === 16 ? 'bar' : 'bars'}` : ''}`]), cur, (n) => {
      this.ensureClip(t);
      this.edit((cl) => { cl.len = n * STEP; cl.loop = n * STEP; cl.notes = cl.notes.filter((x) => x.t < n * STEP); });
      app.store.endGesture();
    });
  }
  doublePattern() {
    this.edit((c) => { const L = c.loop || c.len; c.notes = [...c.notes, ...c.notes.map((x) => ({ ...x, t: x.t + L }))]; c.len = L * 2; c.loop = L * 2; });
    this.app.store.endGesture();
  }

  // ---------------------------------------------------------------- CLIPS ---
  page_clips() {
    const app = this.app, p = this.p, tracks = this.tracks(), st = app.session.state, s = this.scene();
    const grid = h('div', { class: 'gw-clips', style: { '--n': tracks.length } },
      h('span'), tracks.map((t) => h('button', { class: 'gw-ch', style: { '--c': t.color }, translate: 'no', onclick: () => { app.selectTrack(t.id); this.render(); } }, t.name)),
      p.scenes.flatMap((sc, i) => [
        h('button', { class: 'gw-rh' + (i === s ? ' on' : ''), title: `Launch ${sc.name}`, onclick: () => this.pickScene(i) }, h('b', { text: String.fromCharCode(65 + (i % 26)) }), h('span', { class: 'tri' })),
        ...tracks.map((t) => {
          const c = t.slots?.[i], play = st[t.id]?.slot === i, q = st[t.id]?.queued === i;
          const cell = h('button', { class: 'gw-cell' + (c ? ' has' : '') + (play ? ' play' : '') + (q ? ' queued' : ''), style: { '--c': t.color }, translate: 'no' },
            c ? [h('span', { text: c.name }), miniNotes(c)] : h('span', { class: 'plus', text: '+' }));
          press(cell, {
            tap: () => {
              if (c) { if (play && app.playing) app.launch(t.id, -1); else app.launch(t.id, i); }
              else { app.selectTrack(t.id); this.g.scene = i; this.ensureClip(t, i); this.g.tab = 'steps'; this.save(); }
              setTimeout(() => this.renderSoon(), 60);
            },
            long: () => this.clipSheet(t, i),
          });
          return cell;
        }),
      ]));
    return h('div', { class: 'gw-clippage' }, grid,
      h('div', { class: 'gw-tools' }, h('button', { class: 'gw-btn', onclick: () => app.stopAll() }, 'STOP ALL'), h('button', { class: 'gw-btn', onclick: () => this.addScene(false) }, '+ PATTERN'),
        h('span', { class: 'gw-hint', text: 'Tap a clip to launch it, hold it for more.' })));
  }
  clipSheet(t, i) {
    const app = this.app, c = t.slots[i], next = i + 1;
    const set = (fn) => { app.store.change((p) => fn(p.tracks.find((x) => x.id === t.id), p)); app.store.endGesture(); };
    app.sheet(`${t.name} · pattern ${String.fromCharCode(65 + i)}`, c ? [
      ['EDIT ITS STEPS', () => { app.selectTrack(t.id); this.g.scene = i; this.g.tab = 'steps'; this.save(); this.render(); }],
      ['COPY TO THE NEXT PATTERN', () => set((x, p) => { if (next >= p.scenes.length) { p.scenes.push({ id: uid('s'), name: `SCENE ${p.scenes.length + 1}` }); for (const y of p.tracks) y.slots.push(null); } x.slots[next] = { ...structuredClone(c), id: uid('c') }; })],
      ['DOUBLE IT', () => set((x) => { const cl = x.slots[i], L = cl.loop || cl.len; cl.notes = [...cl.notes, ...cl.notes.map((n) => ({ ...n, t: n.t + L }))]; cl.len = L * 2; cl.loop = L * 2; })],
      ['DELETE THE CLIP', () => set((x) => { x.slots[i] = null; }), 'danger'],
    ] : [['NEW PATTERN HERE', () => { app.selectTrack(t.id); this.g.scene = i; this.ensureClip(t, i); this.g.tab = 'steps'; this.render(); }]]);
  }
  addScene(go) {
    const app = this.app;
    app.store.change((p) => { p.scenes.push({ id: uid('s'), name: `SCENE ${p.scenes.length + 1}` }); for (const t of p.tracks) t.slots.push(null); });
    app.store.endGesture();
    if (go) this.pickScene(this.p.scenes.length - 1);
  }
  sceneSheet(i) {
    const app = this.app, p = this.p;
    app.sheet(`Pattern ${String.fromCharCode(65 + i)}`, [
      ['PLAY IT', () => { this.g.scene = i; app.launchScene(i); this.render(); }],
      ['DUPLICATE IT', () => { app.store.change((pp) => { pp.scenes.splice(i + 1, 0, { id: uid('s'), name: `SCENE ${pp.scenes.length + 1}` }); for (const t of pp.tracks) t.slots.splice(i + 1, 0, t.slots[i] ? { ...structuredClone(t.slots[i]), id: uid('c') } : null); }); app.store.endGesture(); this.pickScene(i + 1); }],
      ...(p.scenes.length > 1 ? [['DELETE IT', () => { app.store.change((pp) => { pp.scenes.splice(i, 1); for (const t of pp.tracks) t.slots.splice(i, 1); }); app.store.endGesture(); this.g.scene = Math.max(0, i - 1); this.render(); }, 'danger']] : []),
    ]);
  }

  // ---------------------------------------------------------------- SOUND ---
  page_sound(t) {
    const app = this.app, lib = app.lib, cat = lib[t.bank];
    if (t.kind === 'drum') {
      const kits = lib.sloop.kits.map((k, i) => [i, k]).filter(([, k]) => !/^USR|^SYN/.test(k));
      const at = kits.findIndex(([i]) => i === t.kit);
      const go = (d) => { const [i] = kits[(at + d + kits.length) % kits.length]; app.setKit(t.id, i); app.audition(t.id, [36, 42, 38], 260); };
      return h('div', { class: 'gw-soundpage' }, this.lcd(t, 'KIT', lib.sloop.kits[t.kit] || '', go, () => this.pickSheet('Drum kit', kits, t.kit, (i) => { app.setKit(t.id, i); app.audition(t.id, [36, 42, 38], 260); })),
        h('p', { class: 'gw-hint', text: 'Each pad\'s own tune, decay and level, and your own synthesised kits: in the full DAW (INSTRUMENT).' }), this.trackSliders(t));
    }
    if (t.kind !== 'synth' || !cat?.engines) return h('div', { class: 'gw-soundpage' }, h('p', { class: 'gw-hint', text: 'This instrument is edited in the full DAW (INSTRUMENT).' }), this.trackSliders(t));
    const eng = cat.engines[t.engine], ek = lib.engKey(t.bank, eng.name), list = lib.byEngine[ek] || [], cur = lib.soundOf(t), at = Math.max(0, list.indexOf(cur));
    const go = (d) => { const s = list[(at + d + list.length) % list.length]; if (s) { app.setSound(t.id, { bank: s.bank, engine: s.engine, preset: s.preset }); app.audition(t.id, [60, 64, 67]); } };
    const knobs = [...eng.edit.map((d, i) => [cat.e0 + i, d]), ...['CUTOFF', 'RESO', 'ATK', 'DEC', 'SUS', 'REL'].map((l) => [cat.tp.findIndex((q) => q.l === l), null]).filter(([i]) => i >= 0).map(([i]) => [i, cat.tp[i]])].slice(0, 14);
    return h('div', { class: 'gw-soundpage' },
      this.lcd(t, cat.pack ? `◆ ${cat.pack.name.toUpperCase()} · ${eng.name}` : eng.name, cat.engines[t.engine].presets[t.preset] || '', go, () => this.browse(t)),
      h('div', { class: 'gw-grid2' }, knobs.map(([id, d]) => slider({ label: d.l, min: d.min, max: d.max, def: d.def, value: this.value(t, id), format: (v) => fmt(d, v), color: t.color,
        onChange: (v) => { app.audio.send({ t: 'param', track: t.id, id, v }); app.store.change((p) => { p.tracks.find((x) => x.id === t.id).params[id] = v; }, `gk${t.id}${id}`); }, onEnd: () => app.store.endGesture() }))),
      this.trackSliders(t));
  }
  lcd(t, top, name, go, browse) {
    return h('div', { class: 'gw-lcdbox', style: { '--c': t.color } },
      h('button', { class: 'gw-arrow', 'aria-label': 'Previous sound', onclick: () => go(-1) }, '‹'),
      h('button', { class: 'gw-lcdname', translate: 'no', onclick: browse, title: 'Browse the sounds' }, h('small', { text: top }), h('b', { text: name })),
      h('button', { class: 'gw-arrow', 'aria-label': 'Next sound', onclick: () => go(1) }, '›'));
  }
  // every sound of the library a synth track can take, by kind, with a search
  browse(t) {
    const app = this.app, lib = app.lib;
    const box = h('div', { class: 'gw-browse' }), q = h('input', { type: 'search', placeholder: `Search ${lib.sounds.length} sounds`, 'aria-label': 'Search sounds' });
    const fill = () => {
      const s = q.value.trim().toUpperCase(), list = lib.sounds.filter((x) => !s || x.name.includes(s) || x.eng.toUpperCase().includes(s) || (lib.kindNames[x.kind] || x.kind).includes(s)).slice(0, 300);
      box.replaceChildren(...list.map((x) => h('button', { class: 'gw-snd', translate: 'no', onclick: () => { app.setSound(t.id, { bank: x.bank, engine: x.engine, preset: x.preset }); app.audition(t.id, [60, 64, 67]); m.close(); } },
        h('b', { text: x.name }), h('small', { text: `${lib.kindNames[x.kind] || x.kind} · ${x.eng}` }))));
    };
    q.addEventListener('input', fill);
    const m = app.modal('Sounds', [q, box], [['Close']]);
    fill();
    setTimeout(() => q.focus(), 50);
  }
  trackSliders(t) {
    const app = this.app, set = (fn, tag) => app.store.change((p) => fn(p.tracks.find((x) => x.id === t.id)), tag), end = () => app.store.endGesture();
    return h('div', { class: 'gw-grid2' },
      slider({ label: 'VOLUME', min: -60, max: 6, def: -6, value: Math.round(t.vol), format: (v) => (v <= -60 ? '−∞' : `${v} dB`), color: t.color, onChange: (v) => set((x) => { x.vol = v; }, `gv${t.id}`), onEnd: end }),
      slider({ label: 'PAN', min: -100, max: 100, def: 0, value: Math.round((t.pan || 0) * 100), format: (v) => (v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`), color: t.color, onChange: (v) => set((x) => { x.pan = v / 100; }, `gp${t.id}`), onEnd: end }),
      slider({ label: 'REVERB', min: 0, max: 100, def: 15, value: Math.round((t.sends?.[0] || 0) * 100), format: (v) => `${v}%`, color: t.color, onChange: (v) => set((x) => { x.sends[0] = v / 100; }, `gs0${t.id}`), onEnd: end }),
      slider({ label: 'DELAY', min: 0, max: 100, def: 0, value: Math.round((t.sends?.[1] || 0) * 100), format: (v) => `${v}%`, color: t.color, onChange: (v) => set((x) => { x.sends[1] = v / 100; }, `gs1${t.id}`), onEnd: end }));
  }

  // ------------------------------------------------------------------ MIX ---
  page_mix() {
    const app = this.app, p = this.p, set = (id, fn, tag) => app.store.change((pp) => fn(pp.tracks.find((x) => x.id === id)), tag), end = () => app.store.endGesture();
    return h('div', { class: 'gw-mixpage' },
      this.tracks().map((t) => h('div', { class: 'gw-strip', style: { '--c': t.color } },
        h('button', { class: 'gw-sname', translate: 'no', onclick: () => { app.selectTrack(t.id); this.render(); } }, t.name),
        h('button', { class: 'gw-ms' + (t.mute ? ' on m' : ''), 'aria-pressed': String(!!t.mute), onclick: () => { set(t.id, (x) => { x.mute = !x.mute; }); end(); } }, 'M'),
        h('button', { class: 'gw-ms' + (t.solo ? ' on s' : ''), 'aria-pressed': String(!!t.solo), onclick: () => { set(t.id, (x) => { x.solo = !x.solo; }); end(); } }, 'S'),
        slider({ label: '', min: -60, max: 6, def: -6, value: Math.round(t.vol), format: (v) => (v <= -60 ? '−∞' : `${v} dB`), color: t.color, onChange: (v) => set(t.id, (x) => { x.vol = v; }, `gv${t.id}`), onEnd: end }))),
      h('div', { class: 'gw-strip master' }, h('span', { class: 'gw-sname', text: 'MASTER' }),
        slider({ label: '', min: -30, max: 6, def: 0, value: Math.round(p.master.vol || 0), format: (v) => `${v} dB`, onChange: (v) => app.store.change((pp) => { pp.master.vol = v; }, 'gmv'), onEnd: end })));
  }

  // ------------------------------------------------------------------- FX ---
  page_fx() {
    const g = this.g, perf = this.perf;
    const xy = h('div', { class: 'gw-xy', 'aria-label': 'Filter: left low-pass, right high-pass, up resonance' }, h('i', { class: 'dot' }), h('span', { class: 'xl', text: 'LOW-PASS' }), h('span', { class: 'xr', text: 'HIGH-PASS' }), h('span', { class: 'xt', text: 'RESONANCE' }));
    const place = () => { const d = xy.querySelector('.dot'); d.style.left = `${(perf.x + 1) * 50}%`; d.style.top = `${(1 - perf.y) * 100}%`; d.classList.toggle('on', Math.abs(perf.x) > 0.02); };
    xy.addEventListener('pointerdown', (e) => {
      e.preventDefault(); xy.setPointerCapture(e.pointerId);
      const r = xy.getBoundingClientRect();
      const mv = (m) => { this.setPerf({ x: Math.max(-1, Math.min(1, ((m.clientX - r.left) / r.width) * 2 - 1)), y: Math.max(0, Math.min(1, 1 - (m.clientY - r.top) / r.height)) }); place(); };
      const upf = () => { xy.removeEventListener('pointermove', mv); xy.removeEventListener('pointerup', upf); if (!g.latch) { this.setPerf({ x: 0, y: 0 }); place(); } };
      mv(e); xy.addEventListener('pointermove', mv); xy.addEventListener('pointerup', upf);
    });
    setTimeout(place, 0);
    const holdBtn = (label, on, off, cls = '') => {
      const b = h('button', { class: 'gw-perf ' + cls }, label);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); if (g.latch && b.classList.contains('on')) { off(); b.classList.remove('on'); return; } on(); b.classList.add('on'); });
      const up = () => { if (!g.latch) { off(); b.classList.remove('on'); } };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
      return b;
    };
    const stut = [[1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32']].map(([d, l]) => holdBtn(`STUTTER ${l}`, () => this.setPerf({ stutter: d }), () => this.setPerf({ stutter: 0 })));
    return h('div', { class: 'gw-fxpage' }, xy,
      h('div', { class: 'gw-perfs' }, ...stut,
        holdBtn('TAPE STOP', () => this.setPerf({ tape: true }), () => this.setPerf({ tape: false })),
        holdBtn('CRUSH', () => this.setPerf({ crush: 0.7 }), () => this.setPerf({ crush: 0 })),
        holdBtn('FILL', () => this.app.audio.send({ t: 'fill', on: true }), () => this.app.audio.send({ t: 'fill', on: false }), 'fill')),
      h('div', { class: 'gw-tools' }, h('button', { class: 'gw-btn' + (g.latch ? ' on' : ''), onclick: () => { g.latch = !g.latch; this.save(); this.render(); } }, 'LATCH'),
        h('span', { class: 'gw-hint', text: 'Hold an effect, let go to come back. LATCH keeps them on until tapped again. FILL plays the steps set to FILL.' })));
  }

  // --------------------------------------------------------------- sheets ---
  pickSheet(title, items, cur, pick) { this.app.sheet(title, items.map(([v, l]) => [l, () => pick(v), v === cur ? 'cur' : ''])); }   // (the one in use: ticked by CSS)
  tempoSheet() {
    const app = this.app, p = this.p, taps = [];
    const bpm = slider({ label: 'TEMPO', min: 40, max: 240, def: 120, value: Math.round(p.bpm), format: (v) => `${v} BPM`, onChange: (v) => app.store.change((pp) => { pp.bpm = v; }, 'gbpm'), onEnd: () => app.store.endGesture() });
    const sw = slider({ label: 'SWING', min: 0, max: 100, def: 0, value: Math.round((p.swing || 0) * 100), format: (v) => `${Math.round(50 + v / 4)}%`, onChange: (v) => app.store.change((pp) => { pp.swing = v / 100; }, 'gsw'), onEnd: () => app.store.endGesture() });
    const tap = h('button', { class: 'gw-btn wide', onclick: () => {
      const now = performance.now(); taps.push(now); while (taps.length > 5) taps.shift();
      if (taps.length >= 2 && now - taps[taps.length - 2] < 2000) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1), v = Math.round(60000 / iv); if (v >= 40 && v <= 240) { app.store.change((pp) => { pp.bpm = v; }); app.store.endGesture(); bpm.setValue(v); } } else taps.splice(0, taps.length - 1);
    } }, 'TAP TEMPO');
    app.modal('Tempo', [h('div', { class: 'gw-grid1' }, bpm, sw, tap)], [['Done']]);
  }
  menu() {
    const app = this.app;
    app.sheet('Groove', [
      ['QUANTIZE WHAT YOU RECORD (1/16)', () => { this.g.quant = !this.g.quant; app.grooveQuant = this.g.quant; this.save(); app.toast(this.g.quant ? 'What you record lands on the 16ths.' : 'What you record lands where you played it.'); }, this.g.quant ? 'cur' : ''],
      ['ADD A TRACK…', () => this.addTrackSheet()],
      ['START A SONG IN A STYLE…', () => app.fileAction('starter')],
      ['NEW PROJECT…', () => app.fileAction('new')],
      ['SAVE A COPY…', () => app.fileAction('saveas')],
      ['EXPORT AUDIO…', () => app.fileAction('export')],
      ['PUBLISH TO THE HUB…', () => app.fileAction('publish')],
      ['Language: English / Français', () => app.fileAction('lang')],
      ['THE FULL DAW', () => this.show(false)],
    ]);
  }
  addTrackSheet() {
    const app = this.app, done = (t) => { if (t) { app.selectTrack(t.id); this.g.tab = 'pads'; this.render(); } };
    app.sheet('Add a track', [
      ['DRUMS', () => done(app.addTrack('drum', { sends: [0.08, 0] }))],
      ['SYNTH', () => done(app.addTrack('synth', { sends: [0.15, 0] }))],
      ['A SOUND FROM THE LIBRARY…', () => { const t = app.addTrack('synth', { sends: [0.15, 0] }); done(t); this.browse(t); }],
      ['SAMPLER', () => done(app.addTrack('sampler', { sends: [0.1, 0] }))],
    ]);
  }
  trackSheet(t) {
    const app = this.app;
    app.sheet(t.name, [
      ['SOUND', () => { app.selectTrack(t.id); this.g.tab = 'sound'; this.render(); }],
      [t.mute ? 'UNMUTE' : 'MUTE', () => { app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.mute = !x.mute; }); app.store.endGesture(); }],
      ['RENAME…', () => app.renameTrack(t.id)],
      ['DUPLICATE', () => app.duplicateTrack(t.id)],
      ['DELETE', () => app.deleteTrack(t.id), 'danger'],
    ]);
  }
  // ----------------------------------------------------------------- tick ---
  // the playhead on the steps, the pads the pattern plays now, the patterns playing
  tick() {
    if (!this.open) return;
    const t = this.track(); if (!t) return;
    const now = this.stepNow(t);
    if (now !== this.lastNow) {
      this.lastNow = now;
      this.root.querySelectorAll('.gw-step.now').forEach((x) => x.classList.remove('now'));
      if (now >= 0) this.root.querySelector(`.gw-step[data-i="${now}"]`)?.classList.add('now');
      const c = this.clip(t);
      if (now >= 0 && c) for (const nt of c.notes) if (Math.abs(nt.t - now * STEP) < STEP / 2 - 1e-6) {
        const pad = this.root.querySelector(`.gw-pad[data-n="${nt.n}"]`);
        if (pad) { pad.classList.remove('seq'); void pad.offsetWidth; pad.classList.add('seq'); }
      }
    }
    const key = JSON.stringify(this.app.session.state) + this.app.playing;
    if (key !== this.lastState) { this.lastState = key; if (this.g.tab === 'clips' || this.root.querySelector('.gw-scenes')) this.renderSoon(); }
  }
}

const condLabel = (q) => COND_NAME[q] || (q ? `${q.split(':')[0]} of every ${q.split(':')[1]}` : 'ALWAYS');

// a clip's notes as dots (the clips grid)
function miniNotes(c) {
  const L = c.loop || c.len || 4, ns = c.notes.slice(0, 64), lo = Math.min(...ns.map((x) => x.n), 60), hi = Math.max(...ns.map((x) => x.n), lo + 1);
  return h('i', { class: 'mini' }, ns.map((x) => h('b', { style: { left: `${(x.t / L) * 100}%`, top: `${(1 - (x.n - lo) / (hi - lo)) * 80}%`, width: `${Math.max(3, (x.d / L) * 100)}%` } })));
}

// a recording as a WAV file, the silence before it cut (and a short fade in)
export function trimmedWav(buf, name) {
  const ch = Math.min(2, buf.numberOfChannels), L = buf.getChannelData(0), R = ch > 1 ? buf.getChannelData(1) : L;
  let a = 0; while (a < L.length && Math.max(Math.abs(L[a]), Math.abs(R[a])) < 0.02) a++;
  let b = L.length - 1; while (b > a && Math.max(Math.abs(L[b]), Math.abs(R[b])) < 0.005) b--;
  a = Math.max(0, a - Math.round(buf.sampleRate * 0.005));
  const n = b - a + 1; if (n < buf.sampleRate * 0.02) return null;
  const out = new DataView(new ArrayBuffer(44 + n * 4)), rate = buf.sampleRate;
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const f = Math.min(1, i / (rate * 0.003));
    out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[a + i] * f)) * 32767, true);
    out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[a + i] * f)) * 32767, true);
  }
  return new File([out.buffer], name, { type: 'audio/wav' });
}
