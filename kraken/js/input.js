// SPDX-License-Identifier: GPL-3.0-only
// Playing Kraken from the computer keyboard: a piano by key position (any layout). MIDI is control.js.
const PIANO = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13 };

export function typing(e) {
  const el = e.target;
  return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

export class Input {
  constructor(app) {
    this.app = app;
    this.octave = 4;
    this.vel = 100;
    this.down = new Map();                     // code -> [track, note]
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => { for (const [, [t, n]] of this.down) app.noteOff(t, n); this.down.clear(); });
    this.show();
  }
  show(tell = false) {
    document.getElementById('oct').textContent = `OCT ${this.octave} · V${this.vel}`;
    if (tell) this.app.toast?.(`Keys: octave ${this.octave} (C${this.octave}), velocity ${this.vel}`);
  }
  key(e, on) {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (on && this.app.control?.key(e)) { e.stopImmediatePropagation(); return; }
    if (on && e.code === 'KeyZ') { this.octave = Math.max(0, this.octave - 1); this.show(true); return; }
    if (on && e.code === 'KeyX') { this.octave = Math.min(8, this.octave + 1); this.show(true); return; }
    if (on && e.code === 'KeyC') { this.vel = Math.max(10, this.vel - 15); this.show(true); return; }
    if (on && e.code === 'KeyV') { this.vel = Math.min(127, this.vel + 15); this.show(true); return; }
    const off = PIANO[e.code];
    if (off == null) return;
    e.preventDefault();
    if (on) {
      if (e.repeat || this.down.has(e.code)) return;
      const t = this.app.playTarget();
      if (!t) return;
      const n = t.kind === 'drum' ? this.app.lib.sloop.laneNotes[off % 16] : Math.min(127, (this.octave + 1) * 12 + off);
      this.down.set(e.code, [t.id, n]);
      this.app.noteOn(t.id, n, this.vel, true);
    } else {
      const d = this.down.get(e.code);
      if (d) { this.app.noteOff(d[0], d[1], true); this.down.delete(e.code); }
    }
  }
}
