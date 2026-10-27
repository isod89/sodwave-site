// SPDX-License-Identifier: GPL-3.0-only
// SLOOP Pro on the M-VAVE SMK-37, in DAW mode: plug and play, no MIDI Learn needed.
// Over USB the keyboard is named "Felucca", as an FM-1 running SLOOP or Clipper is. Kraken asks it for its DAW map
// (SysEx DAW_GET, cmd 80 of the editor protocol: sloop-pro web/EDITOR_PROTOCOL.md, firmware src/editor_daw.c): an
// SMK-37 answers with its settings and its map, an FM-1 does not answer. From the map in use (DEFAULT or the USER one
// edited on the keyboard), each control gets a job here:
//   K1–K8          bank A: the selected instrument's 8 knobs; bank B: the project's macros 1–8
//   FADER 1–4      bank A: the volumes of tracks 1–4; bank B: tracks 5–8
//   the 16 pads    (NOTE) the drums: a track on their channel, else the selected drum track, else the first one
//   the 13 buttons the transport and the main actions (BUTTONS below); an MMC button: Kraken's MMC, as before
//   keys, wheels   the selected track, as any keyboard (not claimed here)
// Mappings made with MIDI Learn come first. The keyboard is asked again every few seconds: switching SYNTH ↔ DAW
// (< + >) or editing the map on the keyboard is followed without unplugging.
export const FELUCCA = /felucca/i;
const HDR = [0xf0, 0x7d, 0x46, 0x4c], DAW_GET = 80;
// the map's order (firmware src/smk_daw.h)
const KNOB0 = 0, FADER0 = 16, PAD0 = 24, BTN0 = 56, PITCH = 69, N = 71;
const OFF = 0, CC = 1, TOG = 2, NOTE = 3, MMC = 4, BEND = 5;
const BTN_CC = [110, 111, 115, 117, 112, 113, 114, 118, 119, 85, 86, 87, 88];
export const BUTTONS = [
  ['<', 'prevTrack'], ['>', 'nextTrack'], ['SEQ PLAY', 'playstop'], ['SEQ REC', 'record'], ['SEQ', 'loop'],
  ['FX', 'tabMixer'], ['PARA', 'tabInst'], ['ARP', 'click'], ['NOTE REPEAT', 'countIn'], ['SCALE', 'undo'],
  ['CHORD', 'redo'], ['GLOBE', 'toggleView'], ['BT', 'tap'],
];
// the DEFAULT map (firmware daw_default): knobs CC 70–77 (B 102–109), faders CC 20–23 (B 24–27), pads notes on
// channel 10 (A 36–51, B 52–67, 36 bottom left), buttons CC, the pitch wheel bend, the mod wheel CC 1
export function defaultEntry(i) {
  if (i < FADER0) return { type: CC, num: i < 8 ? 70 + i : 102 + i - 8, ch: 0 };
  if (i < PAD0) return { type: CC, num: 20 + i - FADER0, ch: 0 };
  if (i < BTN0) { const p = (i - PAD0) % 16, b = Math.floor((i - PAD0) / 16); return { type: NOTE, num: 36 + 16 * b + (p >= 8 ? p - 8 : p + 8), ch: 10 }; }
  if (i < PITCH) return { type: CC, num: BTN_CC[i - BTN0], ch: 0 };
  if (i === PITCH) return { type: BEND, num: 0, ch: 0 };
  return { type: CC, num: 1, ch: 0 };
}
const defaults = (ch = 1) => ({ on: 1, ch, local: 0, user: 0, rel: 0, map: [...Array(N)].map((_, i) => defaultEntry(i)) });

export class SloopPro {
  constructor(control) {
    this.c = control;
    this.dev = new Map();               // input name -> { state: 'asking' | 'smk' | 'none' | 'assumed', s: settings, keys: Map }
    this.last = new Map();              // `${name}:${cc key}` -> last absolute knob value (encoders: turned into steps)
    this.timer = 0;
  }
  enabled(name) { return this.c.cfg.devices[name]?.sloopPro !== false; }
  setEnabled(name, on) { (this.c.cfg.devices[name] ||= {}).sloopPro = on; this.c.save(); }
  // ---------------------------------------------------------------- asking the keyboard
  attach(inputs) {
    const names = new Set();
    for (const input of inputs) {
      if (!FELUCCA.test(input.name)) continue;
      names.add(input.name);
      if (!this.dev.has(input.name)) { this.dev.set(input.name, { state: 'asking' }); this.ask(input.name, true); }
    }
    for (const name of [...this.dev.keys()]) if (!names.has(name)) this.dev.delete(name);
    clearInterval(this.timer);
    if (names.size) this.timer = setInterval(() => { if (document.visibilityState === 'visible') for (const n of this.dev.keys()) this.ask(n); }, 5000);
  }
  ask(name, first = false) {
    const d = this.dev.get(name), o = this.c.outFor(name);
    if (!d || !o) return;
    try { o.send([...HDR, DAW_GET, 1, 0xf7]); }
    catch {                                                       // no SysEx in this browser: the DEFAULT map, assumed
      if (d.state !== 'assumed') { this.use(name, d, 'assumed', defaults()); }
      return;
    }
    if (first) setTimeout(() => { if (d.state === 'asking') { d.state = 'none'; this.c.emit(); } }, 1500);   // an FM-1: no answer
  }
  // the answer: F0 7D 46 4C 50 which format MODE CHANNEL LOCAL CCMAP KNOBS N N×(type, number, channel) F7
  reply(input, data) {
    if (data.length < 14 || data[1] !== 0x7d || data[2] !== 0x46 || data[3] !== 0x4c || data[4] !== DAW_GET) return false;
    const d = this.dev.get(input.name) || { state: 'asking' };
    this.dev.set(input.name, d);
    const [, , , , , , , on, ch, local, user, rel, n] = data;
    const s = { on, ch: ch >= 1 && ch <= 16 ? ch : 1, local, user, rel, map: [] };
    for (let i = 0; i < N; i++) {
      const k = 13 + 3 * i;
      s.map.push(user && i < n && k + 2 < data.length - 1 ? { type: data[k], num: data[k + 1], ch: data[k + 2] } : defaultEntry(i));
    }
    this.use(input.name, d, 'smk', s);
    return true;
  }
  use(name, d, state, s) {
    const sig = JSON.stringify(s), was = d.state, wasOn = d.s?.on;
    d.state = state;
    if (d.sig === sig) return;
    d.sig = sig; d.s = s;
    // what each message does: `cc:ch:num` / `note:ch:num` -> { i: entry, type }
    d.keys = new Map();
    s.map.forEach((e, i) => {
      if (e.type === OFF || e.type === MMC || e.type === BEND || i >= PITCH) return;   // (wheels: the instrument's, as any keyboard)
      const ch = (e.ch || s.ch) - 1;
      d.keys.set(`${e.type === NOTE ? 'note' : 'cc'}:${ch}:${e.num}`, { i, type: e.type });
    });
    if (this.enabled(name)) {
      if (was !== 'smk' && was !== 'assumed' || wasOn !== s.on) {
        this.c.app.toast?.(s.on
          ? 'SLOOP Pro (SMK-37) is ready, in DAW mode: K1–K8 turn the selected instrument, the faders set the volumes of tracks 1–4, the pads play the drums, SEQ PLAY plays and SEQ REC records. Details: the CONTROLLERS tab.'
          : 'SLOOP Pro (SMK-37) found, in SYNTH mode: press < and > together for DAW mode, and its knobs, faders, pads and buttons control Kraken.');
      }
    }
    this.c.emit();
  }
  // ---------------------------------------------------------------- the messages
  // a message from a SLOOP Pro: true when it did its job here
  message(input, key, value, press, type) {
    const d = this.dev.get(input.name);
    if (!d?.keys || !d.s.on || !this.enabled(input.name)) return false;
    const hit = d.keys.get(key);
    if (!hit) return false;
    const { i } = hit;
    if (i >= PAD0 && i < BTN0) return false;                      // the pads: notes, routed by padTracks
    if (i >= BTN0) {                                              // a button: its action, once a press
      const fire = hit.type === TOG ? true : press || (type === 0xb0 && value > 0);
      if (fire) this.c.run(BUTTONS[i - BTN0][1]);
      return true;
    }
    if (i >= FADER0) {                                            // a fader: a track's volume (soft takeover as set)
      const n = i - FADER0, t = this.c.app.store.p.tracks[n];
      if (t) this.c.apply({ target: `t:${t.id}:vol`, enc: 'abs' }, value, false, 0xb0, 1000 + n);
      return true;
    }
    // a knob: an encoder. RELATIVE: 64 ± the steps; ABSOLUTE: the steps since its last value (no jump, no takeover)
    const target = i < 8 ? `sel:knob:${i}` : `macro:${i - 8}`;
    const t = this.c.target(target);
    if (!t || t.kind !== 'cont') return true;
    let steps;
    if (d.s.rel) steps = value - 64;
    else {
      const lk = `${input.name}:${key}`, last = this.last.get(lk);
      this.last.set(lk, value);
      if (last == null) return true;
      steps = value === 127 && last === 127 ? 1 : value === 0 && last === 0 ? -1 : value - last;   // (at the ends: still a step)
    }
    if (!steps) return true;
    t.set(Math.max(0, Math.min(1, t.get() + steps / 127)));
    this.c.recordAuto(t);
    return true;
  }
  // a pad's note: the drum track it plays (null: not a pad, the usual routing)
  padTracks(input, ch, note) {
    const d = this.dev.get(input.name);
    if (!d?.keys || !d.s.on || !this.enabled(input.name)) return null;
    const hit = d.keys.get(`note:${ch}:${note}`);
    if (!hit || hit.i < PAD0 || hit.i >= BTN0) return null;
    if (ch === d.s.ch - 1) return null;                          // (pads on the keys' channel: no telling them apart)
    const p = this.c.app.store.p, on = p.tracks.filter((t) => t.midiCh === ch + 1);
    if (on.length) return on.map((t) => t.id);
    const sel = this.c.app.store.track(this.c.app.view.selTrack);
    const drum = sel?.kind === 'drum' ? sel : p.tracks.find((t) => t.kind === 'drum');
    return drum ? [drum.id] : null;
  }
  // ---------------------------------------------------------------- for the Controllers view
  list() { return [...this.dev.entries()].filter(([, d]) => d.state === 'smk' || d.state === 'assumed'); }
  describe(d) {
    const s = d.s, rows = [];
    const ent = (i) => s.map[i], src = (e) => (e.type === OFF ? 'OFF' : e.type === MMC ? `MMC ${e.num}` : `${e.type === NOTE ? 'NOTE' : 'CC'} ${e.num}${e.ch ? ` · CH ${e.ch}` : ''}`);
    rows.push(['K1–K8', 'Knobs 1–8 of the selected track']);
    rows.push(['K1–K8 (BANK B)', 'Project macros 1–8']);
    rows.push(['FADER 1–4', 'Volume of tracks 1–4']);
    rows.push(['FADER 1–4 (BANK B)', 'Volume of tracks 5–8']);
    rows.push(['PADS', 'The drums (the selected drum track, else the first one)']);
    BUTTONS.forEach(([b, act], k) => {
      const e = ent(BTN0 + k);
      if (e.type === OFF) return;
      rows.push([b, e.type === MMC ? `MMC (${src(e)})` : this.c.actionLabel(act)]);
    });
    return rows;
  }
}
