// SPDX-License-Identifier: GPL-3.0-only
// A multi-core helper (multicore.js starts one per spare core): its own KrakenEngine with the whole project, that plays
// the tracks the page gives it ahead of the audio thread, into its ring in shared memory (multicore-core.js).
import { KrakenEngine, RATE } from './engine-core.js';
import { McFollower, engineMsg, QUANTUM, LOOK } from './multicore-core.js';

let engine = null, f = null, modules = null, wake = null, running = false;
let busy = 0, since = performance.now();
const ctl = { i: null };
const fail = (err) => { postMessage({ t: 'error', message: String(err && err.stack || err) }); if (f) f.q = -1; running = false; };

// a turn of the event loop, without a timer's 4 ms (a message to ourselves): the page's messages get in
const ping = new MessageChannel();
let pong = null;
ping.port1.onmessage = () => { const r = pong; pong = null; r?.(); };
const yieldNow = () => new Promise((r) => { pong = r; ping.port2.postMessage(0); });
// until the audio thread moves on (it counts the blocks it consumed), or a few ms
const waitThread = () => {
  const i = ctl.i, v = Atomics.load(i, 2);
  if (Atomics.waitAsync) { const w = Atomics.waitAsync(i, 2, v, 6); return w.async ? w.value : Promise.resolve(); }
  return new Promise((r) => setTimeout(r, 1));
};

async function loop() {
  if (running) return;
  running = true;
  while (running && f && f.q >= 0) {
    let n = 0;
    const t0 = performance.now();
    try { n = f.pump(4); } catch (err) { fail(err); return; }
    const t = performance.now();
    if (n) busy += t - t0;
    if (t - since > 500) { postMessage({ t: 'load', v: busy / (t - since), ahead: f.q }); busy = 0; since = t; }
    if (n) await yieldNow();
    else if (f.waiting === 'body') await new Promise((r) => { wake = r; setTimeout(r, 20); });
    else await waitThread();
  }
  running = false;
}

// the code warmed up on a copy of the song, so the first real blocks are not slow
function warm(p) {
  const e = new KrakenEngine(modules, () => {});
  e.offline = true; e.setProject(structuredClone(p)); e.loop.on = false; e.play();
  const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM), end = performance.now() + 250;
  for (let k = 0; k < (RATE / QUANTUM) * 2 && performance.now() < end; k++) e.render(L, R);
}

// the start (from the audio thread, and again through the page): once, after the song as it stood at the start
let begun = false, based = false, pending = null;
function begin(m) {
  if (begun || !f) return;
  if (!based) { pending = m; return; }
  begun = true;
  try { f.start(m); loop(); } catch (err) { fail(err); }
}

onmessage = ({ data: m }) => {
  try {
    switch (m.t) {
      case 'init':
        modules = m.modules || Object.fromEntries(Object.entries(m.wasm || {}).map(([k, b]) => [k, new WebAssembly.Module(b)]));
        engine = new KrakenEngine(modules, () => {});
        engine.offline = true;                                    // (no meters, no messages to the page: the worklet does that)
        f = new McFollower(engine, m.role, m.shared, (x) => engineMsg(engine, x));
        ctl.i = new Int32Array(m.shared.ctl);
        if (m.port) m.port.onmessage = ({ data }) => { if (data.t === 'mc-start') begin(data); };   // (from the audio thread)
        break;
      case 'base':                                                // the song as the worklet holds it now
        if (m.warm) warm(m.p);
        engine.setProject(m.p); engine.mc.attach();
        if (m.final) { based = true; if (pending) begin(pending); }
        else postMessage({ t: 'ready', look: LOOK });
        break;
      case 'asset': engine.assets.set(m.id, { L: m.L, R: m.R }); break;
      case 'ev': f.bodies.set(m.mseq, m.m); if (wake) { const w = wake; wake = null; w(); } break;
      case 'start': begin(m); break;                              // (the same, through the page)
      case 'stop': running = false; if (f) f.q = -1; break;
    }
  } catch (err) { fail(err); }
};
