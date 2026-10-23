// SPDX-License-Identifier: GPL-3.0-only
// Play with fingers or the mouse: a two-octave keyboard (velocity from where a key is touched, multi-touch,
// slide across keys), or 16 pads on a drum track. Plays the armed or selected track; records like keys.
import { h, noteName } from './kit.js';

const WHITE = [0, 2, 4, 5, 7, 9, 11], BLACKS = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };

export class Keys {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.oct = 4;
    this.wrap = h('div', { class: 'keys-view' });
    root.append(this.wrap);
    this.down = new Map();                         // pointer id -> [track, note]
    app.store.on((_p, why) => { if (why !== 'change' && app.view.tab === 'keys') this.render(); });
  }
  render() {
    const app = this.app;
    let t = app.playTarget();
    if (!t || t.kind === 'audio' || t.kind === 'group') {        // nothing to play on the selected track: the first that can
      t = app.store.p.tracks.find((x) => !['audio', 'group'].includes(x.kind)) || null;
      if (t && !app.store.p.tracks.some((x) => x.arm)) app.view.selTrack = t.id;
    }
    // which track the keys play: picked here (it moves the arm, if a track is armed)
    const playable = app.store.p.tracks.filter((x) => !['audio', 'group'].includes(x.kind));
    const pick = h('select', { class: 'kpick', 'aria-label': 'Track the keys play', style: { color: t?.color }, onchange: (e) => {
      const id = e.target.value, armed = app.store.p.tracks.some((x) => x.arm);
      if (armed) app.store.change((p) => { for (const x of p.tracks) x.arm = x.id === id; });
      app.selectTrack(id); this.render();
    } }, playable.map((x) => h('option', { value: x.id, selected: x.id === t?.id ? true : null }, `${x.name}${x.arm ? ' ●' : ''}`)));
    const span = (this.wrap.clientWidth || window.innerWidth) < 560 ? 1 : 2;   // a phone held upright: one octave, wider keys
    this.span = span;
    const bar = h('div', { class: 'keys-bar' },
      playable.length ? pick : h('span', { class: 'kt dim', text: 'NO TRACK TO PLAY' }),
      t?.kind === 'drum' ? null : h('button', { class: 'add', onclick: () => { this.oct = Math.max(0, this.oct - 1); this.render(); } }, 'OCT −'),
      t?.kind === 'drum' ? null : h('span', { class: 'kt', text: `C${this.oct}–C${this.oct + span}` }),
      t?.kind === 'drum' ? null : h('button', { class: 'add', onclick: () => { this.oct = Math.min(7, this.oct + 1); this.render(); } }, 'OCT +'),
      h('span', { class: 'kt dim', text: 'High on a key: soft · low: hard' }));
    const surface = t?.kind === 'drum' ? this.pads(t) : this.piano(t);
    this.wrap.replaceChildren(bar, surface);
  }
  play(e, el, n) {
    const t = this.app.playTarget();
    if (!t || t.kind === 'audio' || t.kind === 'group') return;
    const r = el.getBoundingClientRect(), v = Math.max(20, Math.min(127, Math.round(30 + ((e.clientY - r.top) / r.height) * 97)));
    const prev = this.down.get(e.pointerId);
    if (prev && prev[1] === n) return;
    if (prev) this.app.noteOff(prev[0], prev[1], true);
    this.down.set(e.pointerId, [t.id, n]);
    this.app.noteOn(t.id, n, v, true);
    el.classList.add('hit');
  }
  release(e) {
    const d = this.down.get(e.pointerId);
    if (d) { this.app.noteOff(d[0], d[1], true); this.down.delete(e.pointerId); }
    for (const x of this.wrap.querySelectorAll('.hit')) if (![...this.down.values()].some(([, n]) => +x.dataset.n === n)) x.classList.remove('hit');
  }
  bind(surface) {
    surface.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('[data-n]'); if (!el) return;
      e.preventDefault(); surface.setPointerCapture(e.pointerId);
      this.play(e, el, +el.dataset.n);
    });
    surface.addEventListener('pointermove', (e) => {            // slide across keys (glissando)
      if (!this.down.has(e.pointerId)) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-n]');
      if (el && surface.contains(el)) this.play(e, el, +el.dataset.n);
    });
    for (const ev of ['pointerup', 'pointercancel']) surface.addEventListener(ev, (e) => this.release(e));
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  piano(t) {
    const surface = h('div', { class: 'piano', style: { '--c': t?.color || 'var(--accent)' } });
    const base = (this.oct + 1) * 12;
    const whites = [];
    const span = this.span || 2;
    for (let o = 0; o < span; o++) for (const w of WHITE) whites.push(base + o * 12 + w);
    whites.push(base + 12 * span);
    whites.forEach((n, i) => surface.append(h('div', { class: 'wk', 'data-n': n, style: { left: `${(i / whites.length) * 100}%`, width: `${100 / whites.length}%` } },
      n % 12 === 0 ? h('span', { text: noteName(n) }) : null)));
    for (let o = 0; o < span; o++) for (const [b, wi] of Object.entries(BLACKS)) {
      const n = base + o * 12 + +b, i = o * 7 + wi;
      surface.append(h('div', { class: 'bk', 'data-n': n, style: { left: `${((i + 0.68) / whites.length) * 100}%`, width: `${(0.64 / whites.length) * 100}%` } }));
    }
    this.bind(surface);
    return surface;
  }
  pads(t) {
    const lib = this.app.lib.sloop;
    const surface = h('div', { class: 'tpads', style: { '--c': t.color } },
      [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3].map((l) => h('div', { class: 'tpad', 'data-n': lib.laneNotes[l] }, h('span', { text: lib.lanes[l] }))));
    this.bind(surface);
    return surface;
  }
}
