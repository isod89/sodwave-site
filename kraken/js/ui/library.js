// SPDX-License-Identifier: GPL-3.0-only
// The sound library: one list of every factory sound (SLOOP and Clipper together), by type or by
// engine, and the drum kits. Click: load it on the selected track and hear it. + TRACK: a new track.
import { h } from './kit.js';

const KIND_NAME = { BASS: 'BASS', KEYS: 'KEYS & PIANOS', ORGAN: 'ORGANS', PAD: 'PADS & STRINGS', LEAD: 'LEADS', PLUCK: 'PLUCKS & BELLS', STAB: 'STABS & CHORDS', FX: 'FX & TEXTURES' };

export class Library {
  constructor(app) {
    this.app = app;
    this.mode = 'type';
    this.open = new Set();
    this.list = document.getElementById('lib-list');
    this.search = document.getElementById('lib-search');
    this.foot = document.getElementById('lib-foot');
    for (const b of document.querySelectorAll('#lib [data-mode]')) {
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode;
        for (const x of document.querySelectorAll('#lib [data-mode]')) x.classList.toggle('on', x === b);
        this.render();
      });
    }
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.search.placeholder = `Search ${app.lib.sounds.length} sounds…`;
    app.store.on(() => this.mark());
    this.render();
  }
  render() {
    const app = this.app, lib = app.lib, q = this.search.value.trim().toUpperCase();
    const t = app.store.track(app.view.selTrack);
    const kids = [];
    if (this.mode === 'kits') {
      lib.sloop.kits.forEach((name, i) => {
        if (/^USR|^SYN/.test(name) || (q && !name.includes(q))) return;
        kids.push(this.item(name, '', { kit: i }));
      });
      this.foot.innerHTML = '<b>Click</b> a kit to load it on the drum track. <b>+ TRACK</b> (or Alt-click) makes a new drum track.';
    } else {
      const cur = t?.kind === 'synth' ? lib.soundOf(t) : null;
      const groups = this.mode === 'type'
        ? lib.kinds.map((k) => [k, KIND_NAME[k], lib.sounds.filter((s) => s.kind === k)])
        : lib.engineNames.map((e) => [e, e, lib.byEngine[e]]);
      for (const [key, label, all] of groups) {
        const hits = all.filter((s) => !q || s.name.includes(q) || s.eng.includes(q) || label.includes(q));
        if (!hits.length) continue;
        const open = q || this.open.has(this.mode + key) || (cur && (this.mode === 'type' ? cur.kind : cur.eng) === key);
        kids.push(h('div', { class: 'eng-h' + (open ? ' open' : ''), role: 'button', tabindex: 0,
          onclick: () => { const k = this.mode + key; this.open.has(k) ? this.open.delete(k) : this.open.add(k); this.render(); } },
          h('span', { text: `${open ? '▾' : '▸'} ${label}` }), h('span', { text: String(hits.length) })));
        if (open) for (const s of hits) kids.push(this.item(s.name, this.mode === 'type' ? s.eng : '', { bank: s.bank, engine: s.engine, preset: s.preset }));
      }
      this.foot.innerHTML = '<b>Click</b> a sound to load it on the selected track and hear it. <b>+ TRACK</b> (or Alt-click) makes a new track with it.';
    }
    this.list.replaceChildren(...kids);
    this.mark();
  }
  item(name, tag, snd) {
    const add = h('span', { class: 'tag plus', role: 'button', title: 'New track with this sound', text: '+ TRACK' });
    const el = h('button', { class: 'item', 'data-snd': JSON.stringify(snd) }, h('span', { text: name }), tag ? h('span', { class: 'tag', text: tag }) : null, add);
    el.addEventListener('click', (e) => this.pick(snd, e.target === add || e.altKey));
    return el;
  }
  pick(snd, asNew) {
    const app = this.app;
    let t = app.store.track(app.view.selTrack);
    if (snd.kit != null) {
      if (t?.kind !== 'drum') t = app.store.p.tracks.find((x) => x.kind === 'drum');
      if (asNew || !t) { app.addTrack('drum', { kit: snd.kit }); return; }
      app.selectTrack(t.id);
      app.setKit(t.id, snd.kit);
      app.audition(t.id, [36, 38, 42]);
      return;
    }
    if (asNew || !t || t.kind !== 'synth') { app.addTrack('synth', { ...snd, name: app.lib[snd.bank].engines[snd.engine].presets[snd.preset] }); return; }
    app.setSound(t.id, snd);
    app.audition(t.id, [60, 64, 67]);
  }
  mark() {
    const t = this.app.store.track(this.app.view.selTrack);
    for (const el of this.list.querySelectorAll('.item')) {
      const s = JSON.parse(el.dataset.snd);
      el.classList.toggle('cur', !!t && (s.kit != null ? t.kind === 'drum' && t.kit === s.kit
        : t.kind === 'synth' && t.bank === s.bank && t.engine === s.engine && t.preset === s.preset));
    }
  }
}
