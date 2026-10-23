// SPDX-License-Identifier: GPL-3.0-only
// The session: clips in slots, launched live. Tracks stay rows (beside their heads), scenes are
// columns. A launch waits for the next bar (or beat, or nothing: the quantize); a scene launches
// its column; a track's stop button ends its clip. While recording, what is launched is written
// into the arrangement.
import { h } from './kit.js';
import { newClip, uid } from '../project.js';

const CELL = 116;

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
    this.bar.replaceChildren(h('div', { class: 'scenes', style: { width: `${scenes.length * CELL + 140}px` } },
      ...scenes.map((s, i) => h('div', { class: 'scene', style: { width: `${CELL}px` } },
        h('button', { class: 'launch', title: `Launch ${s.name} (all its clips)`, 'data-learn': `scene:${i}`, onclick: () => app.launchScene(i) }, '▶'),
        h('span', { class: 'sname', text: s.name, title: 'Double-click to rename', ondblclick: (e) => this.rename(e.target, i) }))),
      h('div', { class: 'scene tools' },
        h('button', { class: 'add', title: 'Add a scene', onclick: () => app.store.change((pp) => { pp.scenes.push({ id: uid('s'), name: `SCENE ${pp.scenes.length + 1}` }); for (const t of pp.tracks) t.slots.push(null); }) }, '+ SCENE'),
        h('button', { class: 'add', title: 'Stop every clip (at the quantize)', 'data-learn': 'act:stopAll', onclick: () => app.stopAll() }, '■ ALL'))));
    const W = scenes.length * CELL + 140;
    const kids = rows.map((r) => {
      const t = r.t;
      const row = h('div', { class: 'srow' + (r.kind === 'auto' ? ' auto' : ''), style: { top: `${r.y - v.sy}px`, height: `${r.h}px`, width: `${W}px` } });
      if (r.kind === 'auto' || t.kind === 'group') return row;
      const st = this.state[t.id] || {};
      scenes.forEach((s, i) => {
        const c = this.slotClip(t, i);
        const playing = st.slot === i, queued = st.queued === i;
        const sel = (c && c.id === v.selClip) || (!c && v.selSlot?.track === t.id && v.selSlot?.i === i);
        const cell = h('div', { class: 'slot' + (c ? ' full' : '') + (playing ? ' playing' : '') + (queued ? ' queued' : '') + (sel ? ' sel' : ''),
          style: { width: `${CELL - 4}px` }, '--c': t.color, 'data-learn': c ? `slot:${t.id}:${i}` : null, title: c ? `${c.name}: click to launch, double-click to edit` : 'Double-click: a new clip here · click: stop the track' });
        if (c) {
          cell.append(h('span', { class: 'tri', text: playing ? '▶' : queued ? '◷' : '▷' }), h('span', { class: 'cname', text: c.name }),
            h('span', { class: 'clen', text: `${+((c.loop || c.len) / p.sig).toFixed(2)}` }));
          if (playing) cell.append(h('i', { class: 'prog', style: { '--a': st.at } }));
        }
        cell.addEventListener('click', (e) => {
          if (e.detail > 1) return;
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
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (c) app.store.change((pp) => { pp.tracks.find((x) => x.id === t.id).slots[i] = null; });
        });
        cell.dataset.slot = `${t.id}:${i}`;
        row.append(cell);
      });
      row.append(h('button', { class: 'tstop' + (st.slot >= 0 ? ' on' : ''), title: 'Stop this track (back to the arrangement)', 'data-learn': `stoptrack:${t.id}`, onclick: () => app.launch(t.id, -1) }, '■'));
      return row;
    });
    this.root.replaceChildren(h('div', { class: 'sgrid', style: { height: `${Math.max(app.arrange.total, 10)}px`, width: `${W}px` } }, ...kids),
      ...(p.tracks.length ? [] : [h('div', { class: 'empty', style: { inset: 0 } }, h('b', { text: 'SESSION' }), h('p', { text: 'Add a track, then double-click a slot to write a clip, and click it to launch it.' }))]));
    this.bar.scrollLeft = this.root.scrollLeft;
    app.control?.markMapped();
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
    if (this.app.view.mode === 'session') this.render();
  }
}
