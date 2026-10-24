// SPDX-License-Identifier: GPL-3.0-only
// An offline render (a stem, a freeze, a bounce) in a Web Worker: the very engine the worklet runs in an
// OfflineAudioContext (worklet.js, offline), quantum by quantum, sample for sample the same. Browsers run the audio
// worklets of all offline contexts on one thread; workers run side by side, one per core (Audio.render). Songs with
// plugins (WAM: they need Web Audio) still render in an OfflineAudioContext.
import { KrakenEngine } from './engine-core.js';

onmessage = ({ data: m }) => {
  try {
    const modules = m.modules || Object.fromEntries(Object.entries(m.wasm || {}).map(([k, b]) => [k, new WebAssembly.Module(b)]));
    const e = new KrakenEngine(modules, () => {});
    e.offline = true;
    e.antiDenormal = 1e-24;                                      // (engine-core.js: no flush-to-zero in a worker)
    for (const [id, a] of Object.entries(m.assets || {})) e.assets.set(id, a);
    e.setProject(m.project);
    if (m.soloTrack) e.soloTrack = m.soloTrack;
    if (m.freezeTrack) e.freezeTrack = m.freezeTrack;
    if (m.bounceTrack) e.bounceTrack = m.bounceTrack;
    if (m.soloReturn != null) e.soloReturn = m.soloReturn;
    e.seek(m.start || 0); e.loop.on = false; e.play();
    const n = m.frames, L = new Float32Array(n), R = new Float32Array(n), qL = new Float32Array(128), qR = new Float32Array(128);
    for (let o = 0; o < n; o += 128) {
      e.render(qL, qR);
      let bad = false;                                           // (as the worklet: never a NaN in the file)
      for (let i = 0; i < 128; i++) { const l = qL[i], r = qR[i]; if (l !== l || r !== r || l === Infinity || l === -Infinity || r === Infinity || r === -Infinity) { bad = true; break; } }
      if (bad) { qL.fill(0); qR.fill(0); }
      const k = Math.min(128, n - o);
      L.set(k === 128 ? qL : qL.subarray(0, k), o); R.set(k === 128 ? qR : qR.subarray(0, k), o);
    }
    postMessage({ L, R }, [L.buffer, R.buffer]);
  } catch (err) { postMessage({ error: String(err?.stack || err) }); }
};
