// SPDX-License-Identifier: GPL-3.0-only
// "Check this device": what this browser can do for Kraken, measured here, in plain words. The same text goes into
// a problem report, so a bug can be understood without the device at hand.
import { KrakenEngine, RATE } from '../engine-core.js';
import { demoProject, APP_VERSION } from '../project.js';
import { storageInfo, tx } from '../vault.js';
import { opusSupported } from '../opus.js';

const mb = (x) => (x == null ? '?' : x > 1e9 ? `${(x / 1e9).toFixed(1)} GB` : `${Math.round(x / 1e6)} MB`);

// the engine's speed on this device: seconds of the demo song rendered per second of work (1 = just in time)
export function engineSpeed(app, seconds = 4) {
  const p = demoProject(app.lib);
  const e = new KrakenEngine(app.modules, () => {});
  e.offline = true; e.setProject(p); e.loop.on = false; e.seek(16); e.play();
  const L = new Float32Array(128), R = new Float32Array(128), frames = seconds * RATE;
  for (let i = 0; i < 40; i++) e.render(L, R);                    // (warm up)
  const t0 = performance.now();
  for (let o = 0; o < frames; o += 128) e.render(L, R);
  return seconds / ((performance.now() - t0) / 1000);
}

// -> [{ k: label, v: value, s: 'ok' | 'warn' | 'bad' }]
export async function diagnose(app) {
  const rows = [], add = (k, v, s = 'ok') => rows.push({ k, v: String(v), s });
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
  const ver = (ua.match(/(?:Edg|OPR|Firefox|CriOS|Chrome|Version)\/(\d+)/) || [])[1] || '?';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  add('Kraken', `${APP_VERSION}${matchMedia('(display-mode: standalone)').matches ? ' · installed app' : ' · in the browser'}`);
  add('Browser', `${browser} ${ver} · ${ios ? 'iOS / iPadOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '?'}`);
  add('Screen', `${innerWidth} × ${innerHeight} · ×${devicePixelRatio}${matchMedia('(pointer: coarse)').matches ? ' · touch' : ''}`);
  add('Processor', `${navigator.hardwareConcurrency || '?'} cores${navigator.deviceMemory ? ` · ${navigator.deviceMemory} GB` : ''}`);
  if (app.mc) add('Multi-core', app.mc.describe().replace(/^Multi-core: /, ''), app.mc.failed ? 'warn' : 'ok');   // (multicore.js)
  // audio
  const ctx = app.audio?.ctx;
  if (!ctx) add('Audio', 'not started', 'bad');
  else {
    const lat = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
    add('Audio', `${ctx.state} · ${ctx.sampleRate} Hz · ${lat ? `${lat.toFixed(0)} ms out` : 'latency unknown'}`, ctx.state === 'running' ? 'ok' : 'warn');
    const ago = app.audio.lastTick ? (performance.now() - app.audio.lastTick) / 1000 : null;
    add('Audio engine', app.audio.useBytes ? 'running (compiled on the audio thread)' : 'running', ago == null ? 'bad' : 'ok');
    if (lat > 40) add('Latency', `${lat.toFixed(0)} ms: playing live will feel late. Wired headphones or a USB interface help (Bluetooth adds 150 ms or more)`, 'warn');
    // the sound card at its own rate: when it is not Kraken's, the browser converts, and its latency at that rate
    // tells what the conversion costs (Kraken's engines run at 44.1 kHz)
    if (!ios && typeof AudioContext === 'function') {
      try {
        const nat = new AudioContext({ latencyHint: 'interactive' });
        await Promise.race([nat.resume(), new Promise((r) => setTimeout(r, 300))]);
        await new Promise((r) => setTimeout(r, 250));
        const nl = ((nat.baseLatency || 0) + (nat.outputLatency || 0)) * 1000, nr = nat.sampleRate;
        nat.close().catch(() => {});
        if (nr !== ctx.sampleRate) add('Sound card', `${nr} Hz, converted to ${ctx.sampleRate} Hz by the browser${nl ? ` (${nl.toFixed(0)} ms at its own rate, ${lat.toFixed(0)} ms here)` : ''}`, nl && lat - nl > 8 ? 'warn' : 'ok');
        else add('Sound card', `${nr} Hz, as Kraken`);
      } catch { /* (no second context here) */ }
    }
  }
  if (ios) add('iPhone, iPad', navigator.audioSession ? 'sound plays with the silent switch on' : 'turn the silent switch off to hear Kraken (this iOS is older than 17)', navigator.audioSession ? 'ok' : 'warn');
  try {
    const x = engineSpeed(app, 2);
    add('Engine speed', `×${x.toFixed(1)} real time (demo song)${x < 2 ? ': big songs may crackle here; freeze tracks to lighten them' : ''}`, x < 1.3 ? 'bad' : x < 2 ? 'warn' : 'ok');
  } catch (e) { add('Engine speed', `could not measure: ${e.message}`, 'bad'); }
  // storage
  const probe = await tx('readwrite', (s) => s.put({ t: Date.now(), json: '{}' }, '__probe'), 'projects');
  await tx('readwrite', (s) => s.delete('__probe'), 'projects');
  const st = await storageInfo();
  add('Autosave', probe === null ? 'IndexedDB is blocked: Kraken can only keep a small copy. Save to a file often' : 'on', probe === null ? 'bad' : 'ok');
  add('Storage', `${mb(st.usage)} used of ${mb(st.quota)}${st.persisted ? ' · kept by the browser' : ' · may be cleared by the browser when space runs low'}`,
    st.quota && st.usage / st.quota > 0.85 ? 'bad' : st.persisted === false ? 'warn' : 'ok');
  add('This tab saves', app.canSave ? 'yes' : 'no: Kraken is open in another tab', app.canSave ? 'ok' : 'warn');
  // the rest
  add('MIDI', navigator.requestMIDIAccess ? `${app.control?.access ? `${[...app.control.access.inputs.values()].length} input(s)` : 'available'}` : 'not in this browser (Safari has none): use Chrome, Edge or Firefox for a MIDI keyboard', navigator.requestMIDIAccess ? 'ok' : 'warn');
  add('Audio input', navigator.mediaDevices?.getUserMedia ? 'available' : 'none', navigator.mediaDevices?.getUserMedia ? 'ok' : 'warn');
  let opus = false; try { opus = await opusSupported(); } catch { /* */ }
  add('Export', `WAV, FLAC, MP3${opus ? ', Opus' : ' (no Opus in this browser)'}`);
  add('Save to a file', window.showSaveFilePicker ? 'Ctrl+S writes the same file again' : 'each save is a download');
  add('Offline', navigator.serviceWorker?.controller ? 'ready' : 'not yet (open Kraken from its web address once more, or install it)', navigator.serviceWorker?.controller ? 'ok' : 'warn');
  if (app.errors?.length) add('Errors this session', `${app.errors.length}: ${app.errors.at(-1).msg}`, 'warn');
  return rows;
}
export const diagnosisText = (rows) => rows.map((r) => `${r.s === 'ok' ? '✓' : r.s === 'warn' ? '!' : '✗'} ${r.k}: ${r.v}`).join('\n');
