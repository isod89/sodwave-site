// SPDX-License-Identifier: GPL-3.0-only
// The audio thread: one KrakenEngine, driven by messages from the UI. Its input (when the
// microphone or an interface is connected) is captured while an audio track records.
import { KrakenEngine } from './engine-core.js';

const CHUNK = 8192;

class KrakenProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.engine = new KrakenEngine(o.modules, (m) => this.port.postMessage(m));
    this.engine.offline = !!o.offline;
    for (const [id, a] of Object.entries(o.assets || {})) this.engine.assets.set(id, a);
    this.L = new Float32Array(128);
    this.R = new Float32Array(128);
    this.cap = null;                 // { start, L, R, n } while capturing
    this.capWanted = false;
    if (o.project) this.engine.setProject(o.project);
    if (o.soloTrack) this.engine.soloTrack = o.soloTrack;
    if (o.freezeTrack) this.engine.freezeTrack = o.freezeTrack;
    if (o.offline) { this.engine.seek(o.start || 0); this.engine.loop.on = false; this.engine.play(); }
    this.quiet = 0;                  // frames of silence while stopped: past 3 s the engine sleeps
    this.sleeping = false;
    this.failed = false;
    this.port.onmessage = ({ data: m }) => {
      const e = this.engine;
      this.sleeping = false; this.quiet = 0;
      if (this.failed && m.t !== 'project') return;
      try {
        switch (m.t) {
          case 'project': e.setProject(m.p); break;
          case 'patch': e.patch(m); break;
          case 'play': e.play(!!m.countIn); break;
          case 'launch': e.launch(m.track, m.slot); break;
          case 'scene': e.scene(m.slot); break;
          case 'stopAll': e.stopAll(); break;
          case 'raw': e.tracks.get(m.track)?.w?.k_midi_in(m.st, m.d1, m.d2); break;
          case 'stop': e.stop(); this.endCapture(); break;
          case 'seek': e.seek(m.beat); e.seekSeq = m.seq || 0; this.endCapture(); break;
          case 'rec': e.recording = m.on; if (!m.on) e.flushRecording(); break;
          case 'capture': this.capWanted = m.on; if (!m.on) this.endCapture(); break;
          case 'click': e.click = m.on; break;
          case 'note': e.liveNote(m.track, m.n, m.v, m.on, !!m.silent); break;
          case 'param': {
            const tr = e.tracks.get(m.track);
            if (tr?.w) { tr.w.k_param(m.id, m.v); tr.params[m.id] = m.v; }
            break;
          }
          case 'midi': e.tracks.get(m.track)?.w?.k_midi(m.st, m.d1, m.d2); break;
          case 'asset': e.assets.set(m.id, { L: m.L, R: m.R }); break;
          case 'asset-drop': e.assets.delete(m.id); break;
          case 'panic': e.panic(); break;
          case '__crash': this.crashNext = true; break;            // tests: a fault in the audio thread
        }
      } catch (err) { this.port.postMessage({ t: 'error', message: String(err && err.stack || err) }); }
    };
  }
  flushChunk() {
    const c = this.cap;
    if (!c || !c.n) return;
    const L = c.L.slice(0, c.n), R = c.R.slice(0, c.n);
    this.port.postMessage({ t: 'cap', L, R }, [L.buffer, R.buffer]);
    c.n = 0;
  }
  endCapture() {
    if (!this.cap) return;
    this.flushChunk();
    this.port.postMessage({ t: 'capEnd', start: this.cap.start });
    this.cap = null;
    this.capWanted = false;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (this.failed || this.sleeping) return true;             // silence: a crashed or resting engine
    try { return this.run(inputs, out, n); } catch (err) {
      this.failed = true;                                       // isolate the fault: silence, and tell the UI (it can restart)
      this.port.postMessage({ t: 'crash', message: String(err && err.stack || err) });
      return true;
    }
  }
  run(inputs, out, n) {
    if (this.crashNext) throw new Error('test fault in process()');
    if (this.capWanted && this.engine.playing && !this.engine.counting && this.engine.punchOpen() && inputs[0]?.length) {
      if (!this.cap) this.cap = { start: this.engine.pos, L: new Float32Array(CHUNK), R: new Float32Array(CHUNK), n: 0 };
      const c = this.cap, a = inputs[0][0], b = inputs[0][1] || a;
      for (let i = 0; i < a.length; i++) {
        c.L[c.n] = a[i]; c.R[c.n] = b[i];
        if (++c.n === CHUNK) this.flushChunk();
      }
    }
    if (this.L.length !== n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
    this.engine.render(this.L, this.R);
    if (this.cap && (this.engine.pos < this.cap.start || !this.engine.punchOpen())) {   // the loop wrapped, or the punch closed: one take
      const keep = this.capWanted && this.engine.pos < this.cap.start; this.endCapture(); this.capWanted = keep;
    }
    let peak = 0, bad = false;
    for (let i = 0; i < n; i++) {
      const l = this.L[i], r = this.R[i];
      if (l !== l || r !== r || l === Infinity || l === -Infinity || r === Infinity || r === -Infinity) { bad = true; break; }
      const a = l < 0 ? -l : l, b = r < 0 ? -r : r; if (a > peak) peak = a; if (b > peak) peak = b;
    }
    if (bad) {                                                  // never let a NaN reach the speakers
      this.L.fill(0); this.R.fill(0);
      if (!this.nanReported) { this.nanReported = true; this.port.postMessage({ t: 'error', message: 'An effect or instrument produced an invalid sample: muted that block.' }); }
    }
    out[0].set(this.L);
    if (out[1]) out[1].set(this.R);
    const e = this.engine;
    if (!e.playing && !e.offline && !this.capWanted && peak < 1e-5) { this.quiet += n; if (this.quiet > 44100 * 3) { this.sleeping = true; this.port.postMessage({ t: 'sleep' }); } }
    else this.quiet = 0;
    return true;
  }
}
registerProcessor('kraken', KrakenProcessor);
