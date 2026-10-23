// SPDX-License-Identifier: GPL-3.0-only
// Note effects: what happens to the notes before they reach the instrument. A track has a chain of them
// (arpeggiator, chord, scale, velocity, pitch, note length), in the order shown. They act on everything
// the track plays: its clips, the session, the keys, MIDI, the controllers. Shared by the live engine,
// the offline export and the tests. No DOM.

const P = (k, l, min, max, def, names = null, unit = '') => ({ k, l, min, max, def, names, unit });
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const ARP_RATES = [1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];                   // beats
export const CHORDS = [
  ['OCTAVE', [0, 12]], ['FIFTH', [0, 7]], ['MAJOR', [0, 4, 7]], ['MINOR', [0, 3, 7]], ['SUS2', [0, 2, 7]], ['SUS4', [0, 5, 7]],
  ['MAJ7', [0, 4, 7, 11]], ['MIN7', [0, 3, 7, 10]], ['DOM7', [0, 4, 7, 10]], ['MIN9', [0, 3, 7, 10, 14]], ['MAJ9', [0, 4, 7, 11, 14]],
  ['ADD9', [0, 4, 7, 14]], ['DIM', [0, 3, 6]], ['AUG', [0, 4, 8]], ['POWER', [0, 7, 12]], ['STACK 4THS', [0, 5, 10, 15]],
];
export const SCALES = [
  ['MAJOR', [0, 2, 4, 5, 7, 9, 11]], ['MINOR', [0, 2, 3, 5, 7, 8, 10]], ['DORIAN', [0, 2, 3, 5, 7, 9, 10]], ['PHRYGIAN', [0, 1, 3, 5, 7, 8, 10]],
  ['LYDIAN', [0, 2, 4, 6, 7, 9, 11]], ['MIXOLYDIAN', [0, 2, 4, 5, 7, 9, 10]], ['LOCRIAN', [0, 1, 3, 5, 6, 8, 10]], ['HARM MINOR', [0, 2, 3, 5, 7, 8, 11]],
  ['MEL MINOR', [0, 2, 3, 5, 7, 9, 11]], ['PENTA MAJ', [0, 2, 4, 7, 9]], ['PENTA MIN', [0, 3, 5, 7, 10]], ['BLUES', [0, 3, 5, 6, 7, 10]],
  ['WHOLE TONE', [0, 2, 4, 6, 8, 10]], ['HIRAJOSHI', [0, 2, 3, 7, 8]], ['CHROMATIC', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
];

export const NOTE_FX = {
  arp: { name: 'ARPEGGIATOR', params: [
    P('mo', 'MODE', 0, 6, 0, ['UP', 'DOWN', 'UP-DOWN', 'DOWN-UP', 'RANDOM', 'AS PLAYED', 'CHORD']),
    P('ra', 'RATE', 0, 5, 3, ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32']),
    P('oc', 'OCTAVES', 1, 4, 1), P('ga', 'GATE', 0.05, 1, 0.6, null, '%'),
    P('ho', 'HOLD', 0, 1, 0, ['OFF', 'ON']), P('ac', 'ACCENT', 0, 1, 0, null, '%')] },
  chord: { name: 'CHORD', params: [
    P('sh', 'SHAPE', 0, CHORDS.length - 1, 2, CHORDS.map((c) => c[0])), P('iv', 'INVERT', 0, 3, 0),
    P('sp', 'SPREAD', 0, 1, 0, ['CLOSE', 'OPEN']), P('ve', 'VELOCITY', 0, 1, 0.85, null, '%')] },
  scale: { name: 'SCALE', params: [P('ro', 'ROOT', 0, 11, 0, NOTE), P('sc', 'SCALE', 0, SCALES.length - 1, 0, SCALES.map((s) => s[0])), P('di', 'SNAP', 0, 1, 0, ['NEAREST', 'UP'])] },
  velocity: { name: 'VELOCITY', params: [P('lo', 'OUT LOW', 1, 127, 1), P('hi', 'OUT HIGH', 1, 127, 127), P('cu', 'CURVE', -1, 1, 0), P('rn', 'RANDOM', 0, 64, 0)] },
  pitch: { name: 'PITCH', params: [P('st', 'SEMIS', -24, 24, 0), P('rr', 'RANDOM', 0, 24, 0), P('rc', 'CHANCE', 0, 1, 0.5, null, '%')] },
  length: { name: 'NOTE LENGTH', params: [P('le', 'LENGTH', 0, 5, 3, ['1/32', '1/16', '1/8', '1/4', '1/2', '1 BAR']), P('on', 'MODE', 0, 1, 0, ['FIXED', 'OFF AT RELEASE'])] },
};
export const NOTE_FX_ORDER = ['arp', 'chord', 'scale', 'pitch', 'velocity', 'length'];
const LENGTHS = [0.125, 0.25, 0.5, 1, 2, 4];

export function noteFxDefaults(type) { const o = {}; for (const p of NOTE_FX[type].params) o[p.k] = p.def; return o; }
export function fmtNoteParam(p, v) {
  if (p.names) return p.names[Math.round(v)] ?? String(v);
  if (p.unit === '%') return `${Math.round(v * 100)}%`;
  if (p.k === 'cu') return v === 0 ? 'LINEAR' : v > 0 ? `HARD ${Math.round(v * 100)}` : `SOFT ${Math.round(-v * 100)}`;
  if (p.k === 'st') return `${v > 0 ? '+' : ''}${Math.round(v)} st`;
  return String(Math.round(v));
}
const clampN = (n) => Math.max(0, Math.min(127, n));

// ------------------------------------------------------------- devices ---
// each device takes notes in (on / off) and passes notes on through emit(on, n, v); time-based ones tick
class Dev {
  constructor(def) { this.id = def.id; this.type = def.type; this.map = new Map(); this.set(def); }
  set(def) { this.p = { ...noteFxDefaults(def.type), ...def.p }; this.on = def.on !== false; }
  noteOn(n, v) { const outs = this.transform(n, v); if (!outs) return; this.map.set(n, outs.map((o) => o[0])); for (const [m, w] of outs) this.emit(true, m, w); }
  noteOff(n) { const outs = this.map.get(n); if (!outs) return; this.map.delete(n); for (const m of outs) this.emit(false, m, 0); }
  transform(n, v) { return [[n, v]]; }
  tick() {}
  reset() { for (const outs of this.map.values()) for (const m of outs) this.emit(false, m, 0); this.map.clear(); }
}

class Chord extends Dev {
  transform(n, v) {
    const p = this.p, iv = [...(CHORDS[Math.round(p.sh)] || CHORDS[0])[1]];
    for (let k = 0; k < Math.round(p.iv); k++) iv[k % iv.length] += 12;                     // inversions: the lowest goes up an octave
    if (Math.round(p.sp)) for (let k = 1; k < iv.length; k += 2) iv[k] += 12;               // open voicing
    const seen = new Set();
    return iv.map((d, k) => [clampN(n + d), k ? Math.max(1, Math.round(v * p.ve)) : v]).filter(([m]) => !seen.has(m) && seen.add(m));
  }
}
class Scale extends Dev {
  transform(n, v) {
    const p = this.p, set = (SCALES[Math.round(p.sc)] || SCALES[0])[1], root = Math.round(p.ro);
    const inScale = (m) => set.includes(((m - root) % 12 + 12) % 12);
    if (inScale(n)) return [[n, v]];
    for (let d = 1; d < 12; d++) {
      if (inScale(n + d)) return [[clampN(n + d), v]];
      if (!Math.round(p.di) && inScale(n - d)) return [[clampN(n - d), v]];
    }
    return [[n, v]];
  }
}
class Velocity extends Dev {
  transform(n, v) {
    const p = this.p;
    let x = v / 127;
    if (p.cu) x = p.cu > 0 ? Math.pow(x, 1 + p.cu * 2) : Math.pow(x, 1 / (1 - p.cu * 2));
    let out = p.lo + x * (p.hi - p.lo);
    if (p.rn) out += (Math.random() * 2 - 1) * p.rn;
    return [[n, Math.max(1, Math.min(127, Math.round(out)))]];
  }
}
class Pitch extends Dev {
  transform(n, v) {
    const p = this.p;
    let m = n + Math.round(p.st);
    if (p.rr && Math.random() < p.rc) m += Math.round((Math.random() * 2 - 1) * p.rr);
    return [[clampN(m), v]];
  }
}
// a fixed length: the note ends after its time, whatever the key does (or at release, whichever comes first)
class Length extends Dev {
  constructor(def) { super(def); this.ends = new Map(); this.clock = 0; }
  noteOn(n, v) {
    if (this.ends.has(n)) this.emit(false, n, 0);
    this.emit(true, n, v);
    this.ends.set(n, this.clock + LENGTHS[Math.round(this.p.le)]);
  }
  noteOff(n) { if (Math.round(this.p.on) && this.ends.has(n)) { this.ends.delete(n); this.emit(false, n, 0); } }
  tick(t0, t1) {
    this.clock = t1;
    for (const [n, e] of this.ends) if (e <= t1) { this.ends.delete(n); this.emit(false, n, 0); }
  }
  reset() { for (const n of this.ends.keys()) this.emit(false, n, 0); this.ends.clear(); }
}
// the arpeggiator: the held notes, played one a step on the song's grid (on a free clock when stopped)
class Arp extends Dev {
  constructor(def) { super(def); this.held = []; this.down = new Set(); this.step = 0; this.cur = []; this.offAt = -1; this.dir = 1; this.lastStep = null; }
  noteOn(n, v) {
    if (Math.round(this.p.ho) && this.down.size === 0) this.held = [];                    // HOLD: a new chord replaces the last
    this.down.add(n);
    if (!this.held.some((h) => h.n === n)) this.held.push({ n, v });
    if (this.held.length === 1) { this.step = 0; this.fresh = true; }
  }
  noteOff(n) {
    this.down.delete(n);
    if (!Math.round(this.p.ho)) this.held = this.held.filter((h) => h.n !== n);
  }
  seq() {
    const p = this.p, oct = Math.max(1, Math.round(p.oc)), mode = Math.round(p.mo);
    const base = mode === 5 ? this.held : [...this.held].sort((a, b) => a.n - b.n);
    const up = [];
    for (let o = 0; o < oct; o++) for (const h of base) up.push({ n: h.n + 12 * o, v: h.v });
    if (mode === 1) return up.reverse();
    if (mode === 2) return up.length > 2 ? [...up, ...up.slice(1, -1).reverse()] : up;
    if (mode === 3) { const d = [...up].reverse(); return d.length > 2 ? [...d, ...d.slice(1, -1).reverse()] : d; }
    return up;
  }
  play(k, rate, offAt) {
    if (this.cur.length) { for (const m of this.cur) this.emit(false, m, 0); this.cur = []; }
    this.lastStep = k;
    const list = this.seq(), mode = Math.round(this.p.mo);
    const notes = mode === 6 ? list : mode === 4 ? [list[Math.floor(Math.random() * list.length)]] : [list[this.step % list.length]];
    const accent = this.p.ac > 0 && this.step % 4 === 0;
    this.step++;
    for (const h of notes) { const n = clampN(h.n), v = accent ? Math.min(127, Math.round(h.v + this.p.ac * 40)) : h.v; this.emit(true, n, v); this.cur.push(n); }
    this.offAt = offAt;
  }
  tick(t0, t1) {
    const rate = ARP_RATES[Math.round(this.p.ra)] || 0.25, ga = this.p.ga;
    if (this.cur.length && this.offAt <= t1) { for (const m of this.cur) this.emit(false, m, 0); this.cur = []; }
    if (!this.held.length) { this.fresh = false; return; }
    const first = Math.ceil(t0 / rate - 1e-9);
    if (this.fresh) {                                            // the first note: now, unless a step falls in this block
      this.fresh = false;
      if (first * rate >= t1 - 1e-9) { const k = Math.floor(t0 / rate + 1e-9); this.play(k, rate, Math.min((k + 1) * rate, t0 + rate * ga)); }
    }
    for (let k = first; k * rate < t1 - 1e-9; k++) if (k !== this.lastStep) this.play(k, rate, k * rate + rate * ga);
  }
  reset() { for (const m of this.cur) this.emit(false, m, 0); this.cur = []; this.held = []; this.down.clear(); this.offAt = -1; this.lastStep = null; }
}
const KINDS = { chord: Chord, scale: Scale, velocity: Velocity, pitch: Pitch, length: Length, arp: Arp };

// ---------------------------------------------------------------- chain ---
// the sink counts the notes it holds, so two inputs landing on one note don't cut each other short
export class NoteChain {
  constructor(sink) { this.sink = sink; this.devs = []; this.sig = ''; this.count = new Map(); }
  get empty() { return !this.devs.length; }
  sync(defs = []) {
    const live = defs.filter((d) => d.on !== false && KINDS[d.type]);
    const sig = live.map((d) => d.id + d.type).join(',');
    if (sig !== this.sig) {
      this.reset();
      this.sig = sig;
      this.devs = live.map((d) => new KINDS[d.type](d));
      this.devs.forEach((dev, i) => { dev.emit = (on, n, v) => this.pass(i + 1, on, n, v); });
    } else live.forEach((d, i) => this.devs[i].set(d));
  }
  automate(fxId, k, v) { const d = this.devs.find((x) => x.id === fxId); if (d) d.p[k] = v; }
  pass(i, on, n, v) {
    if (i < this.devs.length) return on ? this.devs[i].noteOn(n, v) : this.devs[i].noteOff(n);
    const c = this.count.get(n) || 0;
    if (on) { if (c) this.sink(false, n, 0); this.count.set(n, c + 1); this.sink(true, n, v); }
    else if (c) { if (c === 1) { this.count.delete(n); this.sink(false, n, 0); } else this.count.set(n, c - 1); }
  }
  noteOn(n, v) { this.pass(0, true, n, v); }
  noteOff(n) { this.pass(0, false, n, 0); }
  tick(t0, t1) { for (const d of this.devs) d.tick(t0, t1); }
  reset() {
    for (const d of this.devs) d.reset();
    for (const n of this.count.keys()) this.sink(false, n, 0);
    this.count.clear();
  }
}
