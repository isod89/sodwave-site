// SPDX-License-Identifier: GPL-3.0-only
// A grid controller for the session (Novation Launchpad: Mk2, Mini Mk3, X, Pro Mk3): its 8×8 pads are the slots
// (columns: tracks, rows: scenes), lit in each track's colour, green while playing, flashing while waiting; the right
// column launches scenes; the arrows move the 8×8 window; the last top button stops everything.
// Programmer layout: pad (row r from the bottom, column c) = note 10 (r + 1) + c + 1; the right column 19…89;
// the top row CC 91…98 (Mk3, X) or 104…111 (Mk2).
export const GRID_NAME = /launchpad/i;
const SYSEX = [                                                    // into programmer (or session) layout
  [/mini.*mk3|mini mk3|lpminimk3/i, [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x01, 0xf7]],
  [/launchpad x|lpx/i, [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x01, 0xf7]],
  [/pro.*mk3|lppromk3/i, [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x0e, 0x01, 0xf7]],
  [/mk2/i, [0xf0, 0x00, 0x20, 0x29, 0x02, 0x18, 0x22, 0x00, 0xf7]],
];
// the Launchpad palette, a few hues: the nearest to a track's colour
const PALETTE = [[5, 255, 40, 40], [9, 255, 120, 20], [13, 255, 220, 30], [17, 160, 230, 40], [21, 30, 220, 60], [33, 30, 220, 200], [37, 40, 170, 255],
  [45, 40, 70, 255], [49, 140, 70, 255], [53, 255, 70, 200], [57, 255, 60, 120], [3, 230, 230, 230], [1, 90, 90, 90]];
export function paletteOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 3;
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  let best = 3, d0 = Infinity;
  for (const [i, pr, pg, pb] of PALETTE) { const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2; if (d < d0) { d0 = d; best = i; } }
  return best;
}
// a message from the grid -> what it means: { pad: [col, row] } (row 0 at the top) | { scene: row } | { top: k } | null
export function decode(st, d1, d2) {
  const type = st & 0xf0, on = (type === 0x90 || type === 0xb0) && d2 > 0;
  if (!on) return null;
  if (type === 0xb0 && d1 >= 91 && d1 <= 98) return { top: d1 - 91 };
  if (type === 0xb0 && d1 >= 104 && d1 <= 111) return { top: d1 - 104 };
  const r = Math.floor(d1 / 10) - 1, c = (d1 % 10) - 1;
  if (r < 0 || r > 7) return null;
  if (c === 8) return { scene: 7 - r };
  if (c >= 0 && c < 8) return { pad: [c, 7 - r] };
  return null;
}
export const padNote = (col, row) => 10 * (8 - row) + col + 1;

export class Grid {
  constructor(app) { this.app = app; this.outs = new Map(); this.x = 0; this.y = 0; this.sent = new Map(); }
  attach(name, out) {
    if (!out) return;
    this.outs.set(name, out);
    const sx = SYSEX.find(([re]) => re.test(name));
    if (sx) try { out.send(sx[1]); } catch { /* sysex not granted: the default layout may still work */ }
    this.sent.clear();
    this.feedback();
  }
  clear() { this.outs.clear(); }
  message(st, d1, d2) {
    const m = decode(st, d1, d2), app = this.app, p = app.store.p;
    if (!m) return (st & 0xf0) === 0x80 || (st & 0xf0) === 0x90 || (st & 0xf0) === 0xb0;   // (a release: nothing to do)
    if (m.pad) {
      const t = p.tracks[this.x + m.pad[0]], slot = this.y + m.pad[1];
      if (!t) return true;
      if (t.slots?.[slot]) app.launch(t.id, slot);
      else if (app.session?.state[t.id]?.slot >= 0) app.launch(t.id, -1);
    } else if (m.scene != null) { if (this.y + m.scene < p.scenes.length) app.launchScene(this.y + m.scene); }
    else if (m.top != null) {
      if (m.top === 0) this.y = Math.max(0, this.y - 1);
      else if (m.top === 1) this.y = Math.max(0, Math.min(p.scenes.length - 8, this.y + 1));
      else if (m.top === 2) this.x = Math.max(0, this.x - 1);
      else if (m.top === 3) this.x = Math.max(0, Math.min(p.tracks.length - 8, this.x + 1));
      else if (m.top === 7) app.stopAll();
      this.feedback();
    }
    return true;
  }
  // the lights: changed ones only
  feedback() {
    if (!this.outs.size) return;
    const app = this.app, p = app.store.p, st = app.session?.state || {};
    const send = (k, bytes) => { const s = bytes.join(); if (this.sent.get(k) === s) return; this.sent.set(k, s); for (const o of this.outs.values()) try { o.send(bytes); } catch { /* */ } };
    for (let c = 0; c < 8; c++) {
      const t = p.tracks[this.x + c], s = t && st[t.id];
      for (let r = 0; r < 8; r++) {
        const slot = this.y + r, clip = t?.slots?.[slot], n = padNote(c, r);
        if (!clip) { send(`p${n}`, [0x90, n, 0]); continue; }
        if (s?.slot === slot) send(`p${n}`, [0x92, n, 21]);                           // playing: green, pulsing
        else if (s?.queued === slot) send(`p${n}`, [0x91, n, 21]);                    // waiting: flashing
        else send(`p${n}`, [0x90, n, paletteOf(t.color)]);
      }
    }
    for (let r = 0; r < 8; r++) { const n = 10 * (8 - r) + 9, v = this.y + r < p.scenes.length ? 1 : 0; send(`s${n}`, [0x90, n, v]); send(`S${n}`, [0xb0, n, v]); }   // (Mk2: a note; Mk3, X: a CC)
  }
}
