// SPDX-License-Identifier: GPL-3.0-only
// The session: clips in slots, launched live. Tracks stay rows (beside their heads), scenes are
// columns. A launch waits for the next bar (or beat, or nothing: the quantize); a scene launches
// its column; a track's stop button ends its clip. While recording, what is launched is written
// into the arrangement.
import { h } from './kit.js';
import { newClip, uid } from '../project.js';

const CELL = 116, LEAD = 76;                       // a slot's width; the first column: the stop keys

const FOLLOW_NAME = { next: 'NEXT', prev: 'PREVIOUS', first: 'FIRST', last: 'LAST', any: 'ANY', other: 'ANOTHER', again: 'AGAIN', stop: 'STOP', none: 'NOTHING' };
const FOLLOW_ICON = { next: '↓', prev: '↑', first: '⤒', last: '⤓', any: '⚄', other: '⚄', again: '↻', stop: '■', none: '' };
export class Session {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('session');
    this.bar = document.getElementById('scene-bar');
    this.state = {};                                   // track id -> { slot, queued } from the engine
    this.root.addEventListener('scroll', () => { this.bar.scrollLeft = this.root.scrollLeft; });
    this.root.addEventListener('wheel', (e) => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault(); app.arrange.wheel(e);
    }, { passive: false });
    app.store.on(() => { if (app.view.mode === 'session') this.render(); });
  }
  get p() { return this.app.store.p; }
  slotClip(t, i) { return t.slots?.[i] || null; }
  render() {
    const app = this.app, p = this.p, v = app.view, rows = app.arrange.rows();
    const scenes = p.scenes;
    // scene bar: launch a column, stop everything, the launch quantize
    const Q = [[0, 'NOW'], [0.25, '1/16'], [1, 'BEAT'], [p.sig, 'BAR'], [p.sig * 2, '2 BARS'], [p.sig * 4, '4 BARS']];
    let lastTap = 0;
    this.bar.replaceChildren(h('div', { class: 'scenes', style: { width: `${LEAD + scenes.length * CELL + 190}px` } },
      h('div', { class: 'scene lead', style: { width: `${LEAD}px` } },
        h('button', { class: 'add stopall', title: 'Stop every clip (at the quantize)', 'data-learn': 'act:stopAll', onclick: () => app.stopAll() }, '■ ALL'),
        h('button', { class: 'add stopall', title: 'Launch quantize, add a scene', onclick: () => app.sheet('Session', [
          ...Q.map(([v, l]) => [`${Math.abs((p.launchQ ?? 4) - v) < 1e-9 ? '✓ ' : ''}LAUNCH ON ${l === 'NOW' ? 'THE SPOT' : l === 'BEAT' ? 'THE BEAT' : l === 'BAR' ? 'THE BAR' : l}`, () => app.store.change((pp) => { pp.launchQ = v; })]),
          ['+ A SCENE', () => app.store.change((pp) => { pp.scenes.push({ id: uid('s'), name: `SCENE ${pp.scenes.length + 1}` }); for (const t of pp.tracks) t.slots.push(null); })]]) }, '⋯')),
      ...scenes.map((s, i) => h('div', { class: 'scene', style: { width: `${CELL}px` } },
        h('button', { class: 'launch', title: `Launch ${s.name} (all its clips)`, 'data-learn': `scene:${i}`, onclick: () => app.launchScene(i) }, '▶'),
        h('span', { class: 'sname', text: s.name, title: 'Double-click (or double-tap) to rename',
          onclick: (e) => { const now = performance.now(); if (now - lastTap < 350) this.rename(e.target, i); lastTap = now; } }))),
      h('div', { class: 'scene tools' },
        h('button', { class: 'add', title: 'Add a scene', onclick: () => app.store.change((pp) => { pp.scenes.push({ id: uid('s'), name: `SCENE ${pp.scenes.length + 1}` }); for (const t of pp.tracks) t.slots.push(null); }) }, '+ SCENE'),
        h('label', { class: 'lq', title: 'A launch waits for this (Ableton\'s launch quantize)' }, 'Q',
          h('select', { 'aria-label': 'Launch quantize', onchange: (e) => { app.store.change((pp) => { pp.launchQ = +e.target.value; }); e.target.blur(); } },
            Q.map(([v, l]) => h('option', { value: v, selected: Math.abs((p.launchQ ?? 4) - v) < 1e-9 ? true : null }, l)))))));
    const W = LEAD + scenes.length * CELL + 190;
    const kids = rows.map((r) => {
      const t = r.t;
      const row = h('div', { class: 'srow' + (r.kind !== 'track' ? ' auto' : ''), style: { top: `${r.y - v.sy}px`, height: `${r.h}px`, width: `${W}px` } });
      if (r.kind !== 'track' || (t.kind === 'group' || t.kind === 'vca')) return row;
      const st = this.state[t.id] || {};
      row.append(h('button', { class: 'tstop' + (st.slot >= 0 ? ' on' : ''), style: { width: `${LEAD - 8}px` }, title: 'Stop this track (back to the arrangement)', 'data-learn': `stoptrack:${t.id}`, onclick: () => app.launch(t.id, -1) }, '■'));
      scenes.forEach((s, i) => {
        const c = this.slotClip(t, i);
        const playing = st.slot === i, queued = st.queued === i;
        const sel = (c && c.id === v.selClip) || (!c && v.selSlot?.track === t.id && v.selSlot?.i === i);
        const cell = h('div', { class: 'slot' + (c ? ' full' : '') + (playing ? ' playing' : '') + (queued ? ' queued' : '') + (sel ? ' sel' : ''),
          style: { width: `${CELL - 4}px` }, '--c': t.color, 'data-learn': c ? `slot:${t.id}:${i}` : null, title: c ? `${c.name}: click to launch, double-click to edit` : 'Double-click: a new clip here · click: stop the track' });
        if (c) {
          cell.append(h('span', { class: 'tri', text: playing ? '▶' : queued ? '◷' : '▷' }), h('span', { class: 'cname', text: c.name }),
            h('span', { class: 'clen', text: `${c.follow ? FOLLOW_ICON[c.follow.a] + ' ' : ''}${+((c.loop || c.len) / p.sig).toFixed(2)}` }));
          if (playing) cell.append(h('i', { class: 'prog', style: { '--a': st.at } }));
        }
        // a long press (or a right-click): the slot's menu
        let held = false;
        cell.addEventListener('pointerdown', (e) => {
          if (e.pointerType !== 'touch') return;
          held = false; const x0 = e.clientX, y0 = e.clientY;
          const timer = setTimeout(() => { held = true; navigator.vibrate?.(12); this.slotSheet(t, i, c); }, 500);
          const stop = (m) => { if (m.type !== 'pointermove' || Math.hypot(m.clientX - x0, m.clientY - y0) > 8) { clearTimeout(timer); cell.removeEventListener('pointermove', stop); cell.removeEventListener('pointerup', stop); cell.removeEventListener('pointercancel', stop); } };
          cell.addEventListener('pointermove', stop); cell.addEventListener('pointerup', stop); cell.addEventListener('pointercancel', stop);
        });
        cell.addEventListener('click', (e) => {
          if (e.detail > 1 || held) { held = false; return; }
          app.view.selSlot = { track: t.id, i };
          app.selectClip(c ? c.id : null, t.id);
          if (c) app.launch(t.id, i); else if (this.state[t.id]?.slot >= 0) app.launch(t.id, -1);
        });
        cell.addEventListener('dblclick', () => {
          if (c) { app.selectClip(c.id, t.id); app.showTab('edit'); return; }
          if (t.kind === 'audio') { app.toast('Drop an audio clip from the arrangement: select it, Ctrl+C, then click this slot and Ctrl+V.'); return; }
          const nc = newClip(0, p.sig * 4, t.kind === 'drum' ? 'BEAT' : 'CLIP');
          delete nc.start;
          app.store.change((pp) => { pp.tracks.find((x) => x.id === t.id).slots[i] = nc; });
          app.selectClip(nc.id, t.id); app.showTab('edit');
        });
        cell.addEventListener('contextmenu', (e) => { e.preventDefault(); this.slotSheet(t, i, c); });
        cell.dataset.slot = `${t.id}:${i}`;
        row.append(cell);
      });
      return row;
    });
    this.root.replaceChildren(h('div', { class: 'sgrid', style: { height: `${Math.max(app.arrange.total, 10)}px`, width: `${W}px` } }, ...kids),
      ...(p.tracks.length ? [] : [h('div', { class: 'empty', style: { inset: 0 } }, h('b', { text: 'SESSION' }), h('p', { text: 'Add a track, then double-click a slot to write a clip, and click it to launch it.' }))]));
    this.bar.scrollLeft = this.root.scrollLeft;
    app.control?.markMapped();
  }
  slotSheet(t, i, c) {
    const app = this.app, p = this.p;
    if (!c) {
      if (t.kind === 'audio' || (t.kind === 'group' || t.kind === 'vca')) return;
      app.sheet(`${t.name} · slot ${i + 1}`, [['NEW CLIP HERE', () => { const nc = newClip(0, p.sig * 4, t.kind === 'drum' ? 'BEAT' : 'CLIP'); delete nc.start; app.store.change((pp) => { pp.tracks.find((x) => x.id === t.id).slots[i] = nc; }); app.selectClip(nc.id, t.id); app.showTab('edit'); }]]);
      return;
    }
    const next = t.slots.findIndex((x, j) => j > i && !x);
    app.sheet(c.name, [
      ['OPEN IN THE EDITOR', () => { app.selectClip(c.id, t.id); app.showTab('edit'); }],
      ['LAUNCH', () => app.launch(t.id, i)],
      [c.follow ? `FOLLOW ACTION · ${FOLLOW_NAME[c.follow.a]} AFTER ${c.follow.n}` : 'FOLLOW ACTION…', () => this.followDialog(t, i, c)],
      ...(next >= 0 ? [[`DUPLICATE TO SLOT ${next + 1}`, () => app.store.change((pp) => { const x = structuredClone(c); x.id = uid('c'); pp.tracks.find((q) => q.id === t.id).slots[next] = x; })]] : []),
      ['DELETE', () => app.store.change((pp) => { pp.tracks.find((x) => x.id === t.id).slots[i] = null; }), 'danger'],
    ]);
  }
  // what happens after the clip has played: the next one, another one at random, stop… (a second action by chance)
  followDialog(t, i, c) {
    const app = this.app, f = c.follow || { n: 1, a: 'next', b: 'none', p: 1 };
    const sel = (label, value, opts) => h('label', { class: 'qz-row' }, h('span', { text: label }), h('select', { 'aria-label': label }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) ? true : null }, l))));
    const acts = Object.entries(FOLLOW_NAME);
    const n = sel('AFTER (TIMES IT PLAYS)', f.n, [1, 2, 3, 4, 6, 8, 12, 16].map((x) => [x, `${x} × ${+((c.loop || c.len) / this.p.sig).toFixed(2)} BAR${(c.loop || c.len) / this.p.sig === 1 && x === 1 ? '' : 'S'}`]));
    const a = sel('THEN', f.a, acts.filter(([v]) => v !== 'none'));
    const pc = sel('CHANCE', f.p, [[1, '100 %'], [0.75, '75 %'], [0.5, '50 %'], [0.25, '25 %']]);
    const b = sel('OTHERWISE', f.b, acts);
    const get = (el) => el.querySelector('select').value;
    app.modal(`${c.name} · follow action`, [h('p', { class: 'hint', text: 'Once launched, the clip plays this many times, then launches another slot of the track by itself (on its beat): a set that plays itself, or never twice the same.' }), n, a, pc, b],
      [['Remove', () => app.store.change((pp) => { delete pp.tracks.find((x) => x.id === t.id).slots[i].follow; })], ['Cancel'],
        ['Set', () => app.store.change((pp) => { pp.tracks.find((x) => x.id === t.id).slots[i].follow = { n: +get(n), a: get(a), p: +get(pc), b: get(b) }; }), true]]).box.classList.add('qz-dlg');
  }
  rename(el, i) {
    el.contentEditable = 'true'; el.focus(); document.getSelection().selectAllChildren(el);
    const done = () => { el.contentEditable = 'false'; const n = el.textContent.trim().slice(0, 16) || this.p.scenes[i].name; this.app.store.change((pp) => { pp.scenes[i].name = n.toUpperCase(); }); };
    el.addEventListener('blur', done, { once: true });
    el.addEventListener('keydown', (k) => { k.stopPropagation(); if (k.key === 'Enter' || k.key === 'Escape') { k.preventDefault(); el.blur(); } });
  }
  // engine state, from its ticks: what plays, what waits
  update(sess) {
    const key = JSON.stringify(sess);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.state = {};
    for (const [id, s] of Object.entries(sess || {})) this.state[id] = s;
    this.app.control?.feedbackSoon();                            // (a grid controller's lights)
    if (this.app.view.mode === 'session') this.render();
  }
}
