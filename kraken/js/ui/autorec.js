// SPDX-License-Identifier: GPL-3.0-only
// Recording automation by hand, like a mixing desk: AUTO in the top bar picks the mode.
// - READ: automation plays, knobs you move are not recorded;
// - TOUCH: while playing, a knob, fader or send you hold writes its moves at the playhead; let go, and the lane plays
//   what was there again;
// - LATCH: the same, but after you let go it keeps writing the last value until the playback stops.
import { learnTarget } from './macros.js';
import { autoAt } from '../project.js';

export const AUTO_MODES = ['read', 'touch', 'latch'];
const KEY = 'kraken.autoMode';

// the value a track's parameter has now (its knob), for a lane key: vol, pan, sendN, pN, fx:id:k, nfx:id:k
export function staticValue(app, t, key) {
  if (key === 'vol') return t.vol;
  if (key === 'pan') return t.pan;
  if (key.startsWith('send')) return t.sends?.[+key.slice(4)] ?? 0;
  if (key.startsWith('fx:') || key.startsWith('nfx:')) { const [k0, id, pk] = key.split(':'); return (k0 === 'fx' ? t.fx : t.nfx)?.find((d) => d.id === id)?.p?.[pk]; }
  if (key[0] === 'p') return t.params?.[+key.slice(1)] ?? app.params.get(t.id)?.[+key.slice(1)];
  return undefined;
}

export class AutoRec {
  constructor(app) {
    this.app = app;
    try { this.mode = AUTO_MODES.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'read'; } catch { this.mode = 'read'; }
    this.live = new Map();          // `${track}|${key}` -> { track, key, held, last }
    document.addEventListener('pointerdown', (e) => this.down(e), true);
    const up = () => { for (const [k, w] of this.live) { if (!w.held) continue; w.held = false; if (this.mode === 'touch') { this.release(w); this.live.delete(k); } } };
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  }
  setMode(m) {
    this.mode = AUTO_MODES.includes(m) ? m : 'read';
    try { localStorage.setItem(KEY, this.mode); } catch { /* */ }
    if (this.mode === 'read') this.stop();
    this.app.syncAutoButton?.();
  }
  cycle() { this.setMode(AUTO_MODES[(AUTO_MODES.indexOf(this.mode) + 1) % AUTO_MODES.length]); }
  down(e) {
    if (this.mode === 'read' || !this.app.playing || document.body.classList.contains('mapping')) return;
    const el = e.target.closest?.('[data-learn]');
    const tg = el && learnTarget(el.dataset.learn, this.app);
    const t = tg && this.app.store.track(tg.track);
    if (!t) return;
    const lane = t.auto?.[tg.key]?.length ? structuredClone(t.auto[tg.key]) : null;
    // a fader on a lane that plays: it starts where the lane is now (no jump), then follows the hand
    if (lane && /^(vol|pan|send\d+)$/.test(tg.key)) {
      const v = autoAt(lane, this.app.pos);
      this.app.store.amend((p) => { const x = p.tracks.find((q) => q.id === tg.track); if (tg.key.startsWith('send')) x.sends[+tg.key.slice(4)] = v; else x[tg.key] = v; });
    }
    this.live.set(`${tg.track}|${tg.key}`, { ...tg, held: true, last: null, orig: lane });
  }
  // TOUCH let go: the lane goes back to what it was, from just after the last point written
  release(w) {
    if (!w.last || !w.orig) return;
    const at = w.last.t + 1 / 64, v = autoAt(w.orig, at);
    this.app.store.amend((p) => {
      const tr = p.tracks.find((x) => x.id === w.track), list = tr?.auto[w.key];
      if (!list) return;
      const keep = list.filter((q) => q.t <= w.last.t + 1e-6 || q.t > at + 1e-6);
      keep.push({ t: at, v }); keep.sort((a, b) => a.t - b.t);
      tr.auto[w.key] = keep;
    });
  }
  // each tick while playing: what is held (or latched) written at the playhead
  tick(pos) {
    if (!this.live.size) return;
    if (!this.app.playing) { this.stop(); return; }
    const app = this.app, writes = [];
    for (const w of this.live.values()) {
      const t = app.store.track(w.track), v = t && staticValue(app, t, w.key);
      if (!Number.isFinite(v)) continue;
      if (w.last && pos < w.last.t - 1e-6) w.last = null;                         // the loop went round
      if (w.last && pos - w.last.t < 1 / 32 && Math.abs(v - w.last.v) < 1e-9) continue;   // nothing new
      writes.push([w, v]);
    }
    if (!writes.length) return;
    // one undo step for a whole pass of recording (the fader's own moves merge on their side)
    const write = (fn) => { if (this.stepMade) app.store.amend(fn); else { this.stepMade = true; app.store.change(fn, 'autorec'); } };
    write((p) => {
      for (const [w, v] of writes) {
        const tr = p.tracks.find((x) => x.id === w.track);
        if (!tr) continue;
        const list = tr.auto[w.key] || [];
        const from = w.last ? w.last.t : pos;
        // what was between the last write and now goes, a point now (the first write: the lane until here kept)
        const keep = list.filter((q) => q.t <= from + 1e-6 - (w.last ? 0 : 2e-6) || q.t > pos + 1e-6);
        if (!w.last && list.length) keep.push({ t: Math.max(0, pos - 1 / 64), v: autoAt(list, pos) });
        keep.push({ t: pos, v }); keep.sort((a, b) => a.t - b.t);
        tr.auto[w.key] = keep;
        w.last = { t: pos, v };
      }
    });
  }
  stop() {
    this.stepMade = false;
    if (!this.live.size) return;
    this.live.clear();
    this.app.store.endGesture();
  }
}
