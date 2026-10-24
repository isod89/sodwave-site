// SPDX-License-Identifier: GPL-3.0-only
// Multi-core playback ("anticipative rendering"): the tracks that need not react at once are played AHEAD of the playhead
// (LOOK quanta, 64 ms) by Web Workers, each with its own KrakenEngine, into lock-free rings in shared memory; the
// audio thread (worklet.js) reads each such track's sound (after its effects, before its fader) and mixes as always:
// faders, pans, sends, groups, VCAs, returns, master. No DOM: the worklet, the workers (mc-worker.js), the page
// (multicore.js) and the tests (tests/multicore_test.mjs) share this file.
//
// Why it is exact. Every engine (the worklet's and each worker's) holds the whole project and runs the whole control
// side for every track, block for block: the sequencer, the note effects, the modulators, the macros, the automation,
// the chance of each note. They differ only in which tracks' instruments and racks they RENDER. Every message that
// changes the song (the project, an edit, play, stop, seek, a launch…) is a TIMELINE event: the worklet gives it a
// quantum Q = now + LOOK and every engine applies it right before rendering quantum Q. So a worker can render ahead,
// and a track's sound is the same as the single engine's (tests/multicore_test.mjs: bit for bit, but for the -480 dB
// that keeps denormal numbers out of a worker, engine-core.js antiDenormal). The mixer is not delayed: an edit of
// faders, pans, sends, mutes, solos, the master or the returns only changes what the worklet does, so it applies there
// at once (and on the timeline in the workers, which keep the project in step).
//
// Who plays what (the partition, an 'mc-part' timeline event): each track has an owner, the worklet (0) or a worker
// (1..n). Its owner renders it; every other engine keeps the track's control state but does not play its notes
// (Track.instOn is gated: tr.mc). A change of owner (a track armed, a plugin added, the setting turned off…) happens at
// a quantum Q in every engine at once: the old owner releases the notes it holds and keeps rendering only what still
// rings (releases, effect tails) until it has been silent for 3 s; the new owner plays every note that starts from Q.
// No note is ever started twice or left hanging; a note held across the change ends early (its release starts at Q).
//
// Live input never waits: keys and MIDI on a track played by a worker are played by the worklet's own copy of the track
// at once (an overlay, through its own copy of the rack), its sequenced part staying in the worker. A track whose note
// effects hold notes back (an arpeggiator) gets its live notes through the timeline instead (64 ms late). Knobs on a
// worker's track are heard on its sequenced notes 64 ms late, at once on the live ones. A live message for a track
// whose edit is still on its way (a new track's first audition) follows that edit on the timeline.
//
// In the worklet's thread, nothing waits on a worker: when a worker's sound for a block is not there (after 1 ms of
// grace), that block of its tracks is missing (a dropout, counted; multicore.js goes back to one thread if it repeats).
import { BLOCK, RATE, tempoAt } from './engine-core.js';

export const QUANTUM = 128;                 // the Web Audio render quantum
export const BPQ = QUANTUM / BLOCK;         // engine blocks per quantum (4)
export const LOOK = 22;                     // quanta played ahead (64 ms): also the delay of a timeline event
export const CAP = 128;                     // blocks a ring holds (93 ms): more than LOOK + 1 quanta
export const SLOTS = 48;                    // tracks a worker can hand over per block
export const SCHED = 4096;                  // schedule entries (mseq, Q) kept for the workers
const QUIET = Math.ceil(3 * RATE / BLOCK);  // a tail ends after 3 s under -100 dB
const FLOOR = 1e-5;
// shared control words (Int32): the horizon (quanta the workers may play, exclusive), the schedule's count, the
// blocks the worklet has consumed, then the schedule (mseq, Q pairs)
const H = 0, SC = 1, RD = 2, S0 = 16;

// The worklet's message classes. TIMELINE: every engine, at the same quantum. The rest reach the worklet alone, at
// once (a parameter of a worker's track also goes to the workers, on the timeline: see McRouter.route).
export const TIMELINE = new Set(['project', 'patch', 'play', 'stop', 'seek', 'launch', 'scene', 'stopAll', 'rec', 'capture', 'asset-drop', 'mc-part']);

export function makeShared(workers) {
  return {
    ctl: new SharedArrayBuffer(4 * (S0 + 2 * SCHED)),
    rings: Array.from({ length: workers }, () => new SharedArrayBuffer(64 + 4 * CAP + 4 * CAP * SLOTS + 4 * CAP * SLOTS * 2 * BLOCK)),
  };
}

// a worker's ring: per block, how many tracks, their keys, their sound (32 frames left, then 32 right); h[0]: the
// blocks written (absolute)
export class Ring {
  constructor(sab) {
    this.h = new Int32Array(sab, 0, 16);
    this.n = new Int32Array(sab, 64, CAP);
    this.keys = new Int32Array(sab, 64 + 4 * CAP, CAP * SLOTS);
    this.data = new Float32Array(sab, 64 + 4 * CAP + 4 * CAP * SLOTS, CAP * SLOTS * 2 * BLOCK);
  }
  get written() { return Atomics.load(this.h, 0); }
}

// a track's multicore state in one engine (tr.mc)
class McTrack {
  constructor(away) {
    this.key = 0;
    this.away = away;          // its notes are played by another engine
    this.hot = false;          // (away) still rendered here: a tail ringing out, or live notes (the overlay)
    this.quiet = 0;            // blocks under the floor, while hot
    this.live = new Set();     // (away) notes the keys started here
    this.accB = -1;            // (the worklet) the block the workers' sound below is for
    this.accL = new Float32Array(BLOCK); this.accR = new Float32Array(BLOCK);
  }
  // the gate of Track.instOn / instOff: a note is played here when the track is ours, or when it comes from the keys
  on(n, engine) {
    if (!this.away) return true;
    if (!engine.liveCall) return false;
    this.live.add(n); this.hot = true; this.quiet = 0;
    return true;
  }
  off(n) { return !this.away || this.live.delete(n); }
}

// engine.mc: which tracks this engine renders, and their sound in and out of the rings
export class Multi {
  constructor(engine, role) {
    this.e = engine;
    this.role = role;          // 0: the worklet; 1..n: a worker
    this.part = role > 0;      // a worker renders its tracks and mixes nothing (KrakenEngine.block)
    this.owner = {}; this.keys = {};
    this.byKey = new Map();
    this.rings = [];           // the worklet: every worker's ring; a worker: [its own]
    this.b = 0; this.cur = 0;  // the block being rendered (absolute: the same number in every engine)
    this.late = 0;             // (the worklet) blocks a worker had not delivered in time
  }
  setPart({ owner = {}, keys = {} } = {}, quiet = false) { this.owner = owner; this.keys = keys; this.attach(quiet); this.started = true; }
  // after the project changed (a track made again): every track's state, and the changes of owner. A track new to this
  // engine has played nothing: it starts where it belongs. At the start, the worklet lets go of what it played (quiet:
  // nothing has sounded for seconds, no tail to ring out)
  attach(quiet = false) {
    this.byKey.clear();
    for (const tr of this.e.order) {
      const st = tr.mc || (tr.mc = new McTrack(this.started ? (this.owner[tr.id] || 0) !== this.role : this.role !== 0));
      st.key = this.keys[tr.id] || 0;
      if (st.key) this.byKey.set(st.key, st);
      const away = (this.owner[tr.id] || 0) !== this.role;
      if (away && !st.away) this.release(tr, quiet);
      if (!away) { st.live.clear(); st.hot = false; }
      st.away = away;
    }
  }
  // this engine lets the track go: every note it plays released, what still rings rendered to its end
  release(tr, quiet = false) {
    if (tr.w || tr.sampler) for (let n = 0; n < 128; n++) tr.instEnd(this.e, n);
    const st = tr.mc;
    st.live.clear(); st.hot = !quiet; st.quiet = 0;
  }
  own(tr) { const st = tr.mc; return !st || !st.away ? 1 : st.hot ? 2 : 0; }
  begin() {
    const b = this.cur = this.b++, i = b % CAP;
    if (this.part) { this.rings[0].n[i] = 0; return; }
    // the worklet: the workers' sound for this block, by track (a track can come from two workers while one rings out)
    for (const r of this.rings) {
      if (Atomics.load(r.h, 0) <= b) { this.late++; continue; }   // (not there in time: that sound is missing here)
      const n = r.n[i], d = r.data;
      for (let k = 0; k < n; k++) {
        const st = this.byKey.get(r.keys[i * SLOTS + k]);
        if (!st) continue;
        const o = (i * SLOTS + k) * 2 * BLOCK, L = st.accL, R = st.accR;
        if (st.accB !== b) { st.accB = b; for (let j = 0; j < BLOCK; j++) { L[j] = d[o + j]; R[j] = d[o + BLOCK + j]; } }
        else for (let j = 0; j < BLOCK; j++) { L[j] += d[o + j]; R[j] += d[o + BLOCK + j]; }
      }
    }
  }
  // a track's sound, after its rack: a worker writes it to its ring (true: nothing more), the worklet adds the workers'
  take(tr, bL, bR, own) {
    const st = tr.mc;
    if (own === 2) {                                             // a tail (or the overlay): until it is silent
      let pk = 0;
      for (let i = 0; i < BLOCK; i++) { const a = bL[i] < 0 ? -bL[i] : bL[i], c = bR[i] < 0 ? -bR[i] : bR[i]; if (a > pk) pk = a; if (c > pk) pk = c; }
      if (pk >= FLOOR) st.quiet = 0;
      else if (++st.quiet >= QUIET && !st.live.size) st.hot = false;
    }
    if (this.part) {
      if (!own || !st?.key) return true;
      const r = this.rings[0], i = this.cur % CAP, k = r.n[i];
      if (k >= SLOTS) throw new Error(`multicore: more than ${SLOTS} tracks in one worker`);
      r.keys[i * SLOTS + k] = st.key;
      r.data.set(bL, (i * SLOTS + k) * 2 * BLOCK); r.data.set(bR, (i * SLOTS + k) * 2 * BLOCK + BLOCK);
      r.n[i] = k + 1;
      return true;
    }
    if (st && st.accB === this.cur) { const L = st.accL, R = st.accR; for (let i = 0; i < BLOCK; i++) { bL[i] += L[i]; bR[i] += R[i]; } }
    return false;
  }
}

// ------------------------------------------------------------ messages ---
// the engine's part of a message from the page, shared by the worklet and the workers. -> false: not an engine message
export function engineMsg(e, m) {
  switch (m.t) {
    case 'project': e.setProject(m.p); e.mc?.attach(); break;
    case 'patch': e.patch(m); e.mc?.attach(); break;
    case 'play': e.play(!!m.countIn); break;
    case 'launch': e.launch(m.track, m.slot); break;
    case 'scene': e.scene(m.slot); break;
    case 'stopAll': e.stopAll(); break;
    case 'raw': e.tracks.get(m.track)?.w?.k_midi_in(m.st, m.d1, m.d2); break;
    case 'stop': e.stop(); break;
    case 'seek': e.seek(m.beat); e.seekSeq = m.seq || 0; break;
    case 'rec': e.recording = m.on; if (m.on) e.recPass = 0; else e.flushRecording(); break;
    case 'click': e.click = m.on; break;
    case 'note': e.liveCall = true; try { e.liveNote(m.track, m.n, m.v, m.on, !!m.silent, !!m.preview); } finally { e.liveCall = false; } break;
    case 'param': { const tr = e.tracks.get(m.track); if (tr?.w) { tr.w.k_param(m.id, m.v); tr.params[m.id] = m.v; } break; }
    case 'midi': e.liveCtl(m.track, m.st, m.d1, m.d2); break;
    case 'asset': e.assets.set(m.id, { L: m.L, R: m.R }); break;
    case 'asset-drop': e.assets.delete(m.id); break;
    case 'panic': e.panic(); break;
    case 'meters': e.resetMeters(m.reset); break;
    case 'mc-part': e.mc?.setPart(m.part); break;
    default: return false;
  }
  return true;
}

// ------------------------------------------------------------ the worklet ---
// the worklet's side: gives each timeline message its quantum, applies it then, moves the horizon, reads the rings
export class McHost {
  // fresh: nothing rendered yet (a test); quiet: -> true when nothing has sounded for seconds (the worklet's own measure)
  constructor(engine, shared, handle, post, { fresh = false, quiet = () => false } = {}) {
    this.e = engine;
    this.quiet = quiet;
    this.ctl = new Int32Array(shared.ctl);
    this.multi = new Multi(engine, 0);
    this.multi.rings = shared.rings.map((s) => new Ring(s));
    this.handle = handle;      // applies a message to the worklet (its engine, its capture…)
    this.post = post;          // to the page
    this.q = 0;                // the next quantum to render
    this.fresh = fresh;        // nothing rendered yet (a fresh engine, the tests): multicore can start at once
    this.fifo = [];            // timeline messages waiting for their quantum
    this.minQ = 0;             // (none before the workers' start)
    this.due = [];             // { Q, m }: given their quantum, to apply here (m null: the workers' only)
    this.lateQ = 0;
  }
  get workers() { return this.e.mc ? this.multi.rings.length : 0; }
  // a message from the page: { t: 'mc', mseq, m, now } (m: here at its quantum; now: here at once) or { t: 'mc-go', part }
  receive(x) {
    if (x.t === 'mc' && x.now) this.handle(x.now);
    this.fifo.push(x);
  }
  // before a quantum: the waiting messages get their quantum, the due ones are applied, the workers may go further
  before() {
    while (this.fifo.length) {
      const x = this.fifo[0];
      if (x.t === 'mc-go') {
        if (this.due.length) break;                              // (the song still changing: it starts when it settles)
        this.fifo.shift();
        if (this.e.playing || this.e.counting) { this.post({ t: 'mc-reject' }); continue; }
        this.go(x);
        continue;
      }
      this.fifo.shift();
      const Q = Math.max(this.q + LOOK, this.minQ), c = this.ctl[SC], j = S0 + (c % SCHED) * 2;
      this.ctl[j] = x.mseq; this.ctl[j + 1] = Q;
      Atomics.store(this.ctl, SC, c + 1);
      this.due.push({ Q, m: x.m || null });
    }
    while (this.due.length && this.due[0].Q <= this.q) {
      const d = this.due.shift();
      if (d.m?.t === 'mc-go') this.start(d.m.part); else if (d.m) this.handle(d.m);
    }
    this.multi.b = this.q * BPQ;
    Atomics.store(this.ctl, H, this.q + LOOK + 1);
  }
  // multicore starts at quantum Q0 (the transport stopped: the song stands still until then, so its state then is known),
  // a quarter of a second away: time for the page to hand the start to the workers, and for them to get ahead
  go(x) {
    const e = this.e, Q0 = this.fresh ? this.q : this.q + LOOK * 4;
    this.minQ = Q0;
    let free = e.free;
    const dt = BLOCK / RATE * (e.project ? tempoAt(e.project, Math.max(0, e.pos)) : e.bpm) / 60;
    for (let k = 0; k < (Q0 - this.q) * BPQ; k++) free += dt;
    const sess = {};
    for (const tr of e.order) if (tr.sess) sess[tr.id] = { ...tr.sess };
    const snap = { pos: e.pos, free, recording: e.recording, recPass: e.recPass || 0, click: e.click, seekSeq: e.seekSeq || 0, sess };
    const start = { t: 'mc-start', Q0, schedStart: this.ctl[SC], snap, part: x.part };
    for (const port of this.ports || []) port.postMessage(start);   // (straight to the workers: the page may be busy)
    this.post(start);
    this.due.push({ Q: Q0, m: { t: 'mc-go', part: x.part } });
  }
  start(part) { this.e.mc = this.multi; this.multi.b = this.q * BPQ; this.multi.setPart(part, this.fresh || (!this.e.playing && this.quiet())); }
  // the workers' sound for this quantum: there, or waited for a little (spin: ms), else that worker is late
  ready(spin = 0, clock = null) {
    if (!this.e.mc) return true;
    const need = (this.q + 1) * BPQ;
    let t0 = -1, k = 0;
    for (const r of this.multi.rings) {
      while (Atomics.load(r.h, 0) < need) {
        if (!spin || !clock || ++k > 2e6) { this.lateQ++; return false; }   // (and never forever, whatever the clock)
        const t = clock();
        if (t0 < 0) t0 = t; else if (t - t0 > spin) { this.lateQ++; return false; }
      }
    }
    return true;
  }
  after() {
    this.q++; this.fresh = false;
    Atomics.store(this.ctl, RD, this.q * BPQ);
    Atomics.notify(this.ctl, RD);
  }
  // the transport the page sees: a play or a stop on its way counts as done (no flicker of the play button)
  fixTick(m) {
    for (let k = this.due.length - 1; k >= 0; k--) { const t = this.due[k].m?.t; if (t === 'play' || t === 'stop') { m.playing = t === 'play'; break; } }
    for (let k = this.fifo.length - 1; k >= 0; k--) { const t = this.fifo[k].m?.t; if (t === 'play' || t === 'stop') { m.playing = t === 'play'; break; } }
  }
  // back to one thread: what waits is applied now, every track played here from now on
  off() {
    for (const x of this.fifo) if (x.t === 'mc' && x.m) this.due.push({ Q: 0, m: x.m });
    this.fifo = [];
    for (const d of this.due) if (d.m && d.m.t !== 'mc-go') this.handle(d.m);
    this.due = [];
    this.e.mc = null;
    for (const tr of this.e.order) tr.mc = null;
    Atomics.store(this.ctl, H, -1);
  }
}

// ------------------------------------------------------------ a worker ---
// a worker's side: from Q0, each quantum's events applied (their bodies come from the page, their quantum from the
// worklet), its tracks rendered into its ring, as far ahead as the horizon and the ring allow
export class McFollower {
  constructor(engine, role, shared, handle = null) {
    this.e = engine;
    this.ctl = new Int32Array(shared.ctl);
    this.multi = new Multi(engine, role);
    this.multi.rings = [new Ring(shared.rings[role - 1])];
    engine.mc = this.multi;
    engine.antiDenormal = 1e-24;                                // (engine-core.js: no flush-to-zero in a worker)
    this.handle = handle || ((m) => engineMsg(engine, m));
    this.bodies = new Map();   // mseq -> message
    this.q = -1; this.sr = 0;
    this.L = new Float32Array(QUANTUM); this.R = new Float32Array(QUANTUM);
    this.waiting = '';
  }
  start({ Q0, schedStart, snap, part }) {
    this.q = Q0; this.sr = schedStart; this.snap = snap; this.part = part;
    Atomics.store(this.multi.rings[0].h, 0, Q0 * BPQ);
  }
  // render up to max quanta; -> how many (this.waiting: why it stopped: 'time', 'body')
  pump(max = 4) {
    const ctl = this.ctl, e = this.e;
    let n = 0;
    this.waiting = '';
    while (n < max) {
      if (this.q < 0 || this.q >= Atomics.load(ctl, H) || (this.q + 1) * BPQ - Atomics.load(ctl, RD) > CAP) { this.waiting = 'time'; break; }
      if (this.snap) { applySnap(e, this.snap); this.multi.setPart(this.part); this.snap = null; }
      const sc = Atomics.load(ctl, SC);
      let blocked = false;
      while (this.sr < sc) {
        const j = S0 + (this.sr % SCHED) * 2, mseq = ctl[j], Q = ctl[j + 1];
        if (Q > this.q) break;
        if (Q < this.q) throw new Error(`multicore: event ${mseq} for quantum ${Q} came after ${this.q}`);
        const m = this.bodies.get(mseq);
        if (!m) { blocked = true; break; }
        this.bodies.delete(mseq);
        this.handle(m);
        this.sr++;
      }
      if (blocked) { this.waiting = 'body'; break; }
      this.multi.b = this.q * BPQ;
      e.render(this.L, this.R);
      e.ext.length = 0; e.slotMsgs.length = 0; e.wamMidi.length = 0;
      this.q++;
      Atomics.store(this.multi.rings[0].h, 0, this.q * BPQ);
      n++;
    }
    return n;
  }
}

// a worker's engine joins: the song where the worklet's stands at Q0
export function applySnap(e, s) {
  e.seek(s.pos);
  e.free = s.free; e.recording = !!s.recording; e.recPass = s.recPass; e.click = !!s.click; e.seekSeq = s.seekSeq;
  for (const tr of e.order) tr.sess = s.sess[tr.id] ? { ...s.sess[tr.id] } : null;
}

// ------------------------------------------------------------ the page ---
// which tracks go to the workers, and where each message goes. Pure: multicore.js drives it, the tests too.
export function planParts(p, { workers, monitor = [], prev = {}, keys }) {
  const tracks = p.tracks || [];
  for (const t of tracks) if (!keys.has(t.id)) keys.set(t.id, keys.size + 1);
  const keyObj = {}; for (const t of tracks) keyObj[t.id] = keys.get(t.id);
  if (workers < 1) return { owner: {}, keys: keyObj };
  const wam = tracks.some((t) => t.kind === 'wam' || (t.fx || []).some((d) => d.type === 'wam'));
  const mon = new Set(monitor);
  const chancy = (a) => a === 'any' || a === 'other';
  const randomFollow = (t) => (t.slots || []).some((c) => c?.follow && ((c.follow.p ?? 1) < 1 || chancy(c.follow.a) || chancy(c.follow.b)));
  // in the worklet: what has to react at once (armed, monitored, plugins), costs nothing (frozen, groups) or depends on a
  // chance the worklet must share (a random follow action shown in the session view)
  const ok = (t) => ['synth', 'drum', 'sampler', 'audio'].includes(t.kind) && !t.frozen && !t.arm && !mon.has(t.id)
    && !(t.kind === 'audio' && t.monitor === 'in') && !(t.fx || []).some((d) => d.type === 'wam') && !randomFollow(t)
    && !(wam && (t.mods || []).some((m) => m.type === 'follow'));     // (with plugins, a follower hears a delayed key)
  // a sidechain or a follower ties two tracks: they play in the same thread (the key first, in the same block)
  const up = new Map(tracks.map((t) => [t.id, t.id]));
  const find = (x) => { while (up.get(x) !== x) x = up.get(x); return x; };
  const join = (a, b) => { if (up.has(a) && up.has(b)) up.set(find(a), find(b)); };
  for (const t of tracks) {
    for (const d of t.fx || []) if (d.type === 'comp' && d.p?.sc) join(t.id, d.p.sc);
    for (const m of t.mods || []) if (m.type === 'follow' && m.src) join(t.id, m.src);
  }
  const comps = new Map();
  for (const t of tracks) { const r = find(t.id); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(t); }
  const cost = (t) => ({ synth: 4, drum: 3, sampler: 2, audio: 1 }[t.kind] || 1) + (t.fx || []).filter((d) => d.on !== false).length;
  const load = new Array(workers + 1).fill(0), owner = {}, todo = [];
  for (const list of comps.values()) {
    if (!list.every(ok)) continue;
    const w = prev[list[0].id];
    const c = list.reduce((s, t) => s + cost(t), 0);
    if (w >= 1 && w <= workers && list.every((t) => prev[t.id] === w)) { for (const t of list) owner[t.id] = w; load[w] += c; } else todo.push({ list, c });
  }
  todo.sort((a, b) => b.c - a.c);
  for (const { list, c } of todo) {
    let w = 1; for (let k = 2; k <= workers; k++) if (load[k] < load[w]) w = k;
    for (const t of list) owner[t.id] = w;
    load[w] += c;
  }
  for (let w = 1; w <= workers; w++) {                           // (a ring holds SLOTS tracks a block)
    const mine = Object.keys(owner).filter((id) => owner[id] === w);
    for (const id of mine.slice(SLOTS - 8)) delete owner[id];
  }
  return { owner, keys: keyObj };
}

// the page's side: keeps what the engine was sent (to start a worker from it), and routes each message
export class McRouter {
  constructor(workers = 0) {
    this.n = workers;
    this.on = false;           // routing to the workers (from mc-go to mc-off)
    this.mseq = 0;
    this.keys = new Map();
    this.part = { owner: {}, keys: {} };
    this.sig = '';
    this.top = null; this.defs = new Map(); this.order = [];
    this.monitor = [];
    this.recent = new Map();   // track id ('' the track list, 'top' the rest) -> when an edit of its sound went on the timeline
    this.clock = () => Date.now();
  }
  // the project as the worklet holds it (the messages sent so far)
  observe(m) {
    if (m.t === 'project' || m.t === 'patch' || m.t === 'monitor') this.ver = (this.ver || 0) + 1;
    if (m.t === 'project') { const { tracks, ...top } = m.p; this.top = structuredClone(top); this.defs = new Map(tracks.map((t) => [t.id, structuredClone(t)])); this.order = tracks.map((t) => t.id); }
    else if (m.t === 'patch' && this.top) { this.top = structuredClone(m.top); for (const [id, d] of Object.entries(m.tracks || {})) this.defs.set(id, structuredClone(d)); this.order = [...m.order]; for (const id of [...this.defs.keys()]) if (!this.order.includes(id)) this.defs.delete(id); }
    else if (m.t === 'monitor') this.monitor = (m.tracks || []).map((x) => x.id);
  }
  project() { const v = this.view(); return v && structuredClone(v); }
  view() { return this.top ? { ...this.top, tracks: this.order.map((id) => this.defs.get(id)).filter(Boolean) } : null; }   // (not a copy: read only)
  // -> the new partition, or null when it did not change
  plan(force = false) {
    const p = this.view();
    if (!p) return null;
    const part = planParts(p, { workers: this.on || force ? this.n : 0, monitor: this.monitor, prev: this.part.owner, keys: this.keys });
    const sig = JSON.stringify(part.owner);
    if (!force && sig === this.sig) return null;
    this.sig = sig; this.part = part;
    return part;
  }
  remote(id) { return (this.part.owner[id] || 0) > 0; }
  // a message on the timeline: here (the worklet applies it at its quantum), now (the worklet applies it at once),
  // forWorkers (they apply it at its quantum). -> [[to, message]]: to 'w' the worklet, 'k' every worker
  timeline(here, now, forWorkers) { const mseq = ++this.mseq; return [['k', { t: 'ev', mseq, m: forWorkers }], ['w', { t: 'mc', mseq, m: here, now }]]; }
  // an edit of the mix only (faders, pans, sends, mutes, solos, routing; the master, the returns): the workers' sound
  // does not change, the worklet applies it at once (no lookahead on the mixer)
  mixOnly(m) {
    if (m.t !== 'patch' || !this.top) return false;
    const MIX = new Set(['vol', 'pan', 'mute', 'solo', 'sends', 'sendPre', 'out', 'vca', 'name', 'color']);
    const TOP = new Set(['master', 'returns', 'name', 'markers']);
    // (an edit of the sound still on its way, for the same tracks: this one waits its turn behind it)
    const t = this.clock(), soon = (x) => x != null && t - x < 300;
    if (soon(this.recent.get('')) || soon(this.recent.get('top')) || Object.keys(m.tracks || {}).some((id) => soon(this.recent.get(id)))) return false;
    for (const k of new Set([...Object.keys(this.top), ...Object.keys(m.top || {})])) if (!TOP.has(k) && JSON.stringify(this.top[k]) !== JSON.stringify(m.top?.[k])) return false;
    if (m.order.join() !== this.order.join()) return false;
    for (const [id, d] of Object.entries(m.tracks || {})) {
      const o = this.defs.get(id);
      if (!o) return false;
      for (const k of new Set([...Object.keys(o), ...Object.keys(d)])) if (!MIX.has(k) && JSON.stringify(o[k]) !== JSON.stringify(d[k])) return false;
    }
    return true;
  }
  route(m) {
    const mix = this.on && this.mixOnly(m);
    if (!mix && (m.t === 'project' || m.t === 'patch')) {
      const t = this.clock();
      if (m.t === 'project' || m.order.join() !== this.order.join()) this.recent.set('', t);   // (tracks added, removed, moved)
      for (const id of Object.keys(m.tracks || {})) this.recent.set(id, t);
      this.recent.set('top', t);
    }
    this.observe(m);
    if (!this.on) return [['w', m]];
    if (mix) return this.timeline(null, m, m);
    const out = [];
    // a message for a track whose edit (its creation…) is still on its way: on the timeline too, behind that edit (a new
    // track's audition is heard, 64 ms late, instead of reaching a track the worklet does not have yet)
    const t = this.clock(), soon = (x) => x != null && t - x < 300;
    const behind = m.track != null && !TIMELINE.has(m.t) && (soon(this.recent.get('')) || soon(this.recent.get(m.track)));
    const timeline = (here, now, forWorkers) => out.push(...(behind ? this.timeline(now || here, null, forWorkers || { t: 'noop' }) : this.timeline(here, now, forWorkers)));
    if (TIMELINE.has(m.t)) timeline(m, null, m);
    else if ((m.t === 'param' || m.t === 'midi' || m.t === 'raw') && this.remote(m.track)) timeline(null, m, m);
    else if (m.t === 'panic') timeline(null, m, m);
    else if (m.t === 'note' && this.remote(m.track) && (this.defs.get(m.track)?.nfx || []).some((d) => d.type === 'arp' && d.on !== false)) {
      timeline(null, { ...m, silent: true }, { ...m, preview: true });   // (an arpeggiator: through the worker's, recorded here)
    } else if (behind) timeline(m, null, null);
    else out.push(['w', m]);
    if (m.t === 'project' || m.t === 'patch' || m.t === 'monitor') {
      const part = this.plan();
      if (part) timeline({ t: 'mc-part', part }, null, { t: 'mc-part', part });
    }
    return out;
  }
}
