// SPDX-License-Identifier: GPL-3.0-only
// Kraken: a free DAW in the browser, with the SLOOP and Clipper engines of the M-VAVE FM-1 firmwares.
import { loadEngines, Audio } from './audio.js';
import { Store, demoProject, newProject, newTrack, newClip, newAudioClip, newReturn, validate, uid, COLORS } from './project.js';
import { peaks, decode, storeAsset, loadAsset, detectBpm, stretch, saveProject, loadProject } from './assets.js';
import { encodeWav } from './wav.js';
import { saveFile, zip, unzip, exportMidi, parseMidi } from './io.js';
import { RATE } from './engine-core.js';
import { h } from './ui/kit.js';
import { Arrange } from './ui/arrange.js';
import { Editor } from './ui/editor.js';
import { Device } from './ui/device.js';
import { Mixer } from './ui/mixer.js';
import { Library } from './ui/library.js';
import { Input, typing } from './input.js';
import { Control } from './control.js';
import { Controllers } from './ui/controllers.js';
import { Session } from './ui/session.js';
import { Palette } from './ui/palette.js';
import { Keys } from './ui/keys.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE = 'kraken.autosave.v1';

const app = {
  view: { mode: 'arrange', selSlot: null, selTrack: null, selClip: null, snap: 0.25, autoOpen: new Set(), autoTarget: {}, tab: 'edit', follow: true },
  params: new Map(),          // track id -> the engine's parameter values after its preset loaded
  assets: new Map(),          // audio id -> { L, R, name, peaks }
  pos: 0, playing: false, recording: false, click: false,
};
window.kraken = app;           // handy in the console

// ------------------------------------------------------------------ boot ---
async function boot() {
  try {
    const { modules, lib } = await loadEngines();
    app.modules = modules; app.lib = lib;
    $('st-eng').firstChild.textContent = String(lib.engineNames.length);
    $('st-snd').firstChild.textContent = String(lib.sounds.length);
    $('st-kit').firstChild.textContent = String(lib.sloop.kits.filter((k) => !/^USR|^SYN/.test(k)).length);
    $('boot-msg').textContent = 'The real firmware engines, compiled to WebAssembly, ready to play. Sound starts when you press the button.';
    $('boot-go').hidden = false;
    $('boot-go').onclick = start;
    $('boot-go').focus();
  } catch (err) {
    $('boot-msg').textContent = `Kraken could not load its engines: ${err.message}. Serve the web folder over http (python3 serve.py) and open it in a recent Chrome, Edge or Firefox.`;
  }
}

async function start() {
  $('boot-go').disabled = true;
  $('boot-msg').textContent = 'Starting audio…';
  try {
    app.audio = new Audio(app.modules);
    await app.audio.start();
  } catch (err) {
    $('boot-msg').textContent = `Audio could not start: ${err.message}`;
    $('boot-go').disabled = false;
    return;
  }
  let project = null;
  for (const read of [() => loadProject(AUTOSAVE), () => loadProject(AUTOSAVE + '.prev'), () => localStorage.getItem(AUTOSAVE)]) {
    try { const s = await read(); if (s) { project = validate(JSON.parse(s)); break; } } catch { project = null; }   // a damaged save: the one before it
  }
  app.store = new Store(project || demoProject(app.lib));
  await restoreAssets(app.store.p);
  app.view.selTrack = app.store.p.tracks[0]?.id ?? null;
  app.view.selClip = app.store.p.tracks[0]?.clips[0]?.id ?? null;
  app.arrange = new Arrange(app);
  app.session = new Session(app);
  app.palette = new Palette(app);
  app.keys = new Keys(app, $('v-keys'));
  app.fileAction = fileAction;
  app.editor = new Editor(app, $('v-edit'));
  app.device = new Device(app, $('v-device'));
  app.mixer = new Mixer(app, $('v-mixer'));
  app.library = new Library(app);
  app.control = new Control(app);
  app.input = new Input(app);
  app.controllers = new Controllers(app, $('v-ctl'));
  app.control.start();
  app.audio.on(onAudio);
  app.store.on(onChange);
  bindTop();
  bindKeys();
  bindResize();
  app.store.emit('load');
  $('boot').hidden = true;
  if (window.innerWidth > 860) $('app').classList.remove('no-lib');
  toast(project ? 'Your last session is back. PROJECT > Open demo song for the demo.' : 'Demo song loaded: press Space to play.');
  if (app.pendingFiles?.length) openPending();
}

// -------------------------------------------------------------- the model ---
let syncQueued = false, saveTimer = 0, syncFull = false;
function onChange(p, why) {
  const v = app.view;
  if (!p.tracks.some((t) => t.id === v.selTrack)) v.selTrack = p.tracks[0]?.id ?? null;
  const t = app.store.track(v.selTrack);
  if (v.selClip && !p.tracks.some((tr) => tr.clips.some((c) => c.id === v.selClip))) v.selClip = null;
  if (why === 'load') syncFull = true;
  if (!syncQueued) {
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; const f = syncFull; syncFull = false; syncEngine(f); });
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const js = JSON.stringify(app.store.p);
    saveProject(AUTOSAVE, js).then((ok) => { if (ok === null) try { localStorage.setItem(AUTOSAVE, js); } catch { /* storage full or blocked */ } });
  }, 800);
  if ($('pname') !== document.activeElement) $('pname').value = p.name;
  if (p.bpm !== onChange.bpm) { onChange.bpm = p.bpm; if (why === 'change') restretchSoon(); }
  if ($('bpm') !== document.activeElement) $('bpm').value = String(+p.bpm.toFixed(2));
  $('loop').classList.toggle('on', p.loop.on);
  $('countin').classList.toggle('on', !!p.countIn); $('punch').classList.toggle('on', !!p.punch?.on);
  if ($('swing') !== document.activeElement) $('swing').value = String(p.swing || 0);
  $('undo').disabled = !app.store.past.length; $('redo').disabled = !app.store.future.length;
  const clip = t?.clips.find((c) => c.id === v.selClip);
  $('tab-info').replaceChildren(...(t ? [h('span', { class: 'dot', '--c': t.color }), `${t.name}${clip ? ' · ' + clip.name : ''}`] : []));
  if (why === 'load' || why === 'history') app.arrange.redraw();
}

// the engine gets only what changed: the tracks whose content moved, and the top of the project
const sync = { top: '', tracks: new Map(), order: '' };
function syncEngine(full = false) {
  const p = app.store.p;
  const { tracks, ...topObj } = p;
  const top = JSON.stringify(topObj), order = tracks.map((t) => t.id);
  const changed = {};
  let n = 0;
  for (const t of tracks) { const js = JSON.stringify(t); if (sync.tracks.get(t.id) !== js) { sync.tracks.set(t.id, js); changed[t.id] = t; n++; } }
  for (const id of [...sync.tracks.keys()]) if (!order.includes(id)) sync.tracks.delete(id);
  const swingMoved = JSON.parse(sync.top || '{}').swing !== p.swing;
  if (full || !sync.top || swingMoved || n > tracks.length / 2) app.audio.send({ t: 'project', p });
  else if (n || top !== sync.top || order.join() !== sync.order) app.audio.send({ t: 'patch', top: topObj, tracks: changed, order });
  sync.top = top; sync.order = order.join();
}
function resyncAll() { sync.top = ''; sync.tracks.clear(); for (const [id, a] of app.assets) app.audio.send({ t: 'asset', id, L: a.L, R: a.R }); syncEngine(true); }
app.restartAudio = () => { app.audio.restart(); resyncAll(); app.playing = false; $('play').classList.remove('on'); toast('Audio engine restarted.'); };

function onAudio(m) {
  if (m.t === 'tick') {
    app.pos = m.pos;
    if (app.playing !== m.playing) { app.playing = m.playing; $('play').classList.toggle('on', m.playing); app.control.feedbackSoon(); }
    if (app.playing && app.view.follow) app.arrange.follow(m.pos);
    showPos();
    app.arrange.redraw();
    app.arrange.meters(m.tracks);
    if (app.view.tab === 'device') app.device.gr(m.gr);
    if (app.view.tab === 'edit') app.editor.canvas.redraw();
    if (app.view.tab === 'mixer') app.mixer.meters(m);
    app.session.update(m.sess);
    showMeters(m);
    const lv = (x) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(1e-5, x)) + 48) / 48)).toFixed(3);
    const [a, b] = $('mmeter').children;
    a.style.setProperty('--v', lv(m.master[0])); b.style.setProperty('--v', lv(m.master[1]));
  } else if (m.t === 'params') {
    app.params.set(m.track, m.values);
    if (m.track === app.view.selTrack) app.device.refresh(true);
  } else if (m.t === 'rec') {
    if (m.slot != null) recordSlotNote(m.track, m.slot, m.note); else recordNote(m.track, m.note);
  } else if (m.t === 'slot') {
    for (const ev of m.ev) sessionToArrangement(ev);
  } else if (m.t === 'ext') {
    app.control.external(m.ev);
  } else if (m.t === 'cap') {
    (app.take ||= []).push([m.L, m.R]);
  } else if (m.t === 'capEnd') {
    finishTake(m.start);
  } else if (m.t === 'crash') {
    console.error(m.message);
    modal('The audio engine stopped', [h('p', { text: 'Something in the audio thread failed, so Kraken muted it to protect your ears and your project. Your project is safe. Restart the engine to play again.' }),
      h('pre', { style: { margin: 0, maxHeight: '90px', overflow: 'auto', font: '500 9px/1.4 var(--f-mono)', color: 'var(--dim)', whiteSpace: 'pre-wrap' }, text: String(m.message).slice(0, 600) })],
      [['Restart audio', () => app.restartAudio(), true]]);
  } else if (m.t === 'error') {
    console.error(m.message);
    toast('Audio engine error: see the console.');
  }
}

function showPos() {
  const p = app.store.p, sig = p.sig, pos = app.pos + 1e-6;
  if (pos < 0) { $('pos').textContent = `COUNT ${Math.ceil(-pos)}`; return; }
  const bar = Math.floor(pos / sig) + 1, beat = Math.floor(pos % sig) + 1, six = Math.floor((pos % 1) * 4) + 1;
  $('pos').textContent = `${String(bar).padStart(3, '0')}.${beat}.${six}`;
}
// loudness (LUFS: momentary, integrated) and the tempo the map is at
function showMeters(m) {
  const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
  if (m.lufs) $('lufs').textContent = `${f(m.lufs[0])} · ${f(m.lufs[2])}`;
  if (m.bpm && app.store.p.tempo?.length && $('bpm') !== document.activeElement) $('bpm').value = m.bpm.toFixed(1);
}

// a note overdubbed into a playing session clip
function recordSlotNote(trackId, slot, n) {
  app.store.change((p) => {
    const c = p.tracks.find((x) => x.id === trackId)?.slots[slot];
    if (!c) return;
    const loop = c.loop || c.len;
    c.notes.push({ t: n.t % loop, d: Math.min(n.d, loop), n: n.n, v: n.v });
  }, 'rec');
}
// while recording, what the session launches is written into the arrangement
const sessRec = new Map();                                       // track id -> { slot, at }
function sessionToArrangement(ev) {
  if (!app.recording) return;
  closeSessionTake(ev.track, ev.at);
  if (ev.slot >= 0) sessRec.set(ev.track, { slot: ev.slot, at: ev.at });
}
function closeSessionTake(trackId, end) {
  const open = sessRec.get(trackId);
  if (!open) return;
  sessRec.delete(trackId);
  if (end - open.at < 0.05) return;
  app.store.change((p) => {
    const tr = p.tracks.find((x) => x.id === trackId), src = tr?.slots[open.slot];
    if (!src) return;
    const c = { ...structuredClone(src), id: uid('c'), start: open.at, len: end - open.at, loop: src.loop || src.len };
    tr.clips = tr.clips.filter((x) => x.start >= end || x.start + x.len <= open.at);    // the take replaces what was there
    tr.clips.push(c);
  }, 'sessrec');
}
function closeAllSessionTakes() { for (const id of [...sessRec.keys()]) closeSessionTake(id, app.pos); }

// a note played while recording lands in the clip under it, or in a new clip
function recordNote(trackId, n) {
  const t = app.store.track(trackId); if (!t) return;
  app.store.change((p) => {
    const tr = p.tracks.find((x) => x.id === trackId);
    let clip = tr.clips.find((c) => n.t >= c.start - 1e-6 && n.t < c.start + c.len);
    if (!clip) {
      const sig = p.sig, inLoop = p.loop.on && n.t >= p.loop.a && n.t < p.loop.b;
      const start = inLoop ? p.loop.a : Math.floor(n.t / sig) * sig;
      clip = newClip(start, inLoop ? p.loop.b - p.loop.a : sig * 4, 'TAKE');
      tr.clips.push(clip);
      app.view.selClip = clip.id;
    }
    const loop = clip.loop || clip.len;
    const local = ((n.t - clip.start) % loop + loop) % loop;
    const g = app.view.snap && app.recQuantize ? app.view.snap : 0;
    clip.notes.push({ t: g ? Math.round(local / g) * g % loop : local, d: Math.min(n.d, loop), n: n.n, v: n.v });
  }, 'rec');
}

// --------------------------------------------------------------- audio ---
function addAsset(id, a, persist = true) {
  const asset = { L: a.L, R: a.R, name: a.name, peaks: peaks(a.L, a.R) };
  app.assets.set(id, asset);
  app.audio.send({ t: 'asset', id, L: a.L, R: a.R });
  if (persist) storeAsset(id, asset);
  return asset;
}
async function restoreAssets(p) {
  let missing = 0;
  for (const id of Object.keys(p.assets || {})) {
    if (app.assets.has(id)) { app.audio.send({ t: 'asset', id, L: app.assets.get(id).L, R: app.assets.get(id).R }); continue; }
    const a = await loadAsset(id);
    if (a) addAsset(id, a, false); else missing++;
  }
  if (missing) toast(`${missing} audio file${missing > 1 ? 's are' : ' is'} missing from this browser. Open the project's .zip to bring them back.`);
}
function usedAssets(p) {
  const out = {};
  const use = (id) => { const a = id && app.assets.get(id); if (a) out[id] = { L: a.L, R: a.R }; };
  for (const t of p.tracks) {
    for (const c of t.clips) use(c.src);
    for (const c of t.slots || []) use(c?.src);
    use(t.sample?.src); use(t.frozen?.src);
  }
  return out;
}
// audio files onto a track (or a new one), one after the other from beat
async function importAudio(files, { trackId = null, beat = 0 } = {}) {
  let at = beat, made = 0;
  for (const f of files) {
    try {
      const { L, R } = await decode(app.audio.ctx, await f.arrayBuffer());
      const id = uid('a'), name = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
      addAsset(id, { L, R, name });
      const len = L.length / RATE * app.store.p.bpm / 60;
      const clip = newAudioClip(at, len, id, name.toUpperCase().slice(0, 18));
      app.store.change((p) => {
        p.assets[id] = { name, frames: L.length };
        let t = p.tracks.find((x) => x.id === trackId);
        if (!t) { t = newTrack('audio', p.tracks.length, { name: name.toUpperCase().slice(0, 16), color: COLORS[p.tracks.length % COLORS.length], sends: [0, 0] }); p.tracks.push(t); trackId = t.id; }
        t.clips.push(clip);
      });
      app.view.selTrack = trackId; app.view.selClip = clip.id;
      at += len; made++;
    } catch (err) {
      toast(`${f.name}: this file could not be read as audio.`);
    }
  }
  if (made) { app.store.emit('select'); toast(`${made} audio file${made > 1 ? 's' : ''} imported.`); }
}
function pickAudio(where) {
  const inp = $('audiofile');
  inp.onchange = () => { const files = [...inp.files]; inp.value = ''; if (files.length) importAudio(files, where); };
  inp.click();
}
// a MIDI file: one track per MIDI track and channel, with a sound of the right kind (General MIDI program)
async function importMidiFile(file, beat = 0) {
  const m = parseMidi(new Uint8Array(await file.arrayBuffer()));
  if (!m.tracks.length) { toast('This MIDI file has no notes.'); return; }
  const KIND = (pg) => (pg < 8 ? 'KEYS' : pg < 16 ? 'PLUCK' : pg < 24 ? 'ORGAN' : pg < 32 ? 'PLUCK' : pg < 40 ? 'BASS' : pg < 56 ? 'PAD' : pg < 64 ? 'STAB' : pg < 80 ? 'LEAD' : pg < 88 ? 'LEAD' : pg < 96 ? 'PAD' : pg < 104 ? 'FX' : 'PLUCK');
  const fresh = !app.store.p.tracks.some((t) => t.clips.length);
  app.store.change((p) => {
    if (fresh) p.bpm = Math.max(40, Math.min(240, m.bpm));
    for (const mt of m.tracks) {
      const drum = mt.ch === 9;
      const snd = drum ? null : app.lib.sounds.find((s) => s.kind === KIND(mt.program)) || app.lib.sounds[0];
      const t = newTrack(drum ? 'drum' : 'synth', p.tracks.length, { name: mt.name.toUpperCase().slice(0, 16), color: COLORS[p.tracks.length % COLORS.length],
        ...(drum ? { kit: app.lib.sloop.kits.indexOf('ACOUSTIC') } : { bank: snd.bank, engine: snd.engine, preset: snd.preset }) });
      const end = Math.max(...mt.notes.map((n) => n.t + n.d));
      const len = Math.max(p.sig, Math.ceil(end / p.sig) * p.sig);
      const c = newClip(beat, len, mt.name.toUpperCase().slice(0, 18) || 'MIDI');
      c.notes = mt.notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v }));
      t.clips.push(c);
      p.tracks.push(t);
    }
  });
  toast(`${m.tracks.length} MIDI track${m.tracks.length > 1 ? 's' : ''} imported${fresh ? ` at ${m.bpm} BPM` : ''}.`);
}

// ------------------------------------------------------------------ warp ---
const findClip = (p, trackId, clipId) => { const t = p.tracks.find((x) => x.id === trackId); return t?.clips.find((c) => c.id === clipId) || t?.slots?.find((c) => c && c.id === clipId); };
// OFF: as recorded · RE-PITCH: follows the tempo like tape · STRETCH: follows it, pitch kept (WSOLA)
function warpClip(trackId, clipId, mode, opts = {}) {
  const p = app.store.p, c = findClip(p, trackId, clipId);
  if (!c) return;
  const origId = c.orig || c.src, a0 = app.assets.get(origId);
  if (!a0) { toast('The audio of this clip is missing.'); return; }
  const srcSec = a0.L.length / RATE, bpm = opts.bpm ?? c.bpm ?? p.bpm, st = opts.st ?? c.st ?? 0;
  let newSrc = origId, extra = {};
  if (mode === 'stretch') {
    const { L, R } = stretch(a0.L, a0.R, bpm / p.bpm, st);
    newSrc = uid('a');
    addAsset(newSrc, { L, R, name: `${a0.name} ${bpm}>${p.bpm}` }, false);
    extra = { orig: origId, stretchBpm: p.bpm, st };
  }
  app.store.change((pp) => {
    const x = findClip(pp, trackId, clipId);
    delete x.orig; delete x.stretchBpm; delete x.st;
    Object.assign(x, { warp: mode, bpm, src: newSrc, ...extra });
    if (mode === 'stretch') pp.assets[newSrc] = { name: `${a0.name} (stretched)`, frames: app.assets.get(newSrc).L.length, derived: origId };
    if (mode !== 'off' || opts.bpm == null) { x.offset = 0; x.len = srcSec * (mode === 'off' ? pp.bpm : bpm) / 60; if (x.start === undefined) x.loop = x.len; }
  });
}
// stretched clips follow tempo changes
let restretchTimer = 0;
function restretchSoon() {
  clearTimeout(restretchTimer);
  restretchTimer = setTimeout(() => {
    const p = app.store.p;
    for (const t of p.tracks) for (const c of [...t.clips, ...(t.slots || []).filter(Boolean)]) if (c.warp === 'stretch' && c.stretchBpm !== p.bpm) warpClip(t.id, c.id, 'stretch');
  }, 700);
}
function detectClipBpm(trackId, clipId) {
  const c = findClip(app.store.p, trackId, clipId), a = c && app.assets.get(c.orig || c.src);
  if (!a) return;
  const bpm = detectBpm(a.L, a.R);
  if (!bpm) { toast('No clear tempo in this audio.'); return; }
  warpClip(trackId, clipId, c.warp || 'off', { bpm });
  toast(`Tempo found: ${bpm} BPM.${(c.warp || 'off') === 'off' ? ' Choose RE-PITCH or STRETCH to follow the song.' : ''}`);
}
function clipToSampler(trackId, clipId) {
  const c = findClip(app.store.p, trackId, clipId);
  if (!c) return;
  const src = c.orig || c.src, name = (app.store.p.assets[src]?.name || c.name).toUpperCase().slice(0, 18);
  const t = app.addTrack('sampler', { src, sampleName: name, mode: 'slice', name: `${name.slice(0, 10)} SLICES`, sends: [0.1, 0] });
  if (t) app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.sample.name = name; });
  app.showTab('device');
}

// a recorded take: chunks from the worklet, placed where it was heard (latency compensated)
function finishTake(start) {
  const chunks = app.take || []; app.take = null;
  const n = chunks.reduce((a, [L]) => a + L.length, 0);
  const t = app.store.track(app.takeTrack);
  if (!n || !t) return;
  const L = new Float32Array(n), R = new Float32Array(n);
  let o = 0; for (const [a, b] of chunks) { L.set(a, o); R.set(b, o); o += a.length; }
  const p = app.store.p, spb = 60 / p.bpm;
  let begin = start - app.audio.roundTrip() / spb, offset = 0;
  if (begin < 0) { offset = -begin * spb; begin = 0; }
  const id = uid('a'), name = `${t.name} take ${t.clips.length + 1}`;
  addAsset(id, { L, R, name });
  const clip = newAudioClip(begin, n / RATE / spb - offset / spb, id, `TAKE ${t.clips.length + 1}`);
  clip.offset = offset;
  app.store.change((pp) => { pp.assets[id] = { name, frames: n }; pp.tracks.find((x) => x.id === t.id).clips.push(clip); });
}

// ------------------------------------------------------------- actions ---
Object.assign(app, {
  selectTrack(id) {
    if (app.view.selTrack === id && !app.view.selBus) return;
    app.view.selTrack = id;
    app.view.selBus = null;
    app.store.emit('select');
  },
  selectClip(id, trackId) {
    if (trackId) app.view.selTrack = trackId;
    app.view.selClip = id;
    app.store.emit('select');
  },
  showTab(name) {
    app.view.tab = name;
    for (const b of document.querySelectorAll('#bot .tab[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
    for (const v of ['edit', 'device', 'mixer', 'ctl', 'keys']) $('v-' + v).hidden = v !== name;
    if (name === 'ctl') app.controllers.render();
    if (name === 'keys') app.keys.render();
    if (phone()) setMobile(name === 'keys' ? 'keys' : 'bot');
    if (name === 'device') app.device.refresh(true);
    if (name === 'edit') app.editor.refresh();
  },
  seek(beat) { app.pos = beat; app.audio.send({ t: 'seek', beat }); showPos(); app.arrange.redraw(); app.editor.canvas.redraw(); },
  play(on = !app.playing, countIn = false) {
    if (app.audio.ctx.state !== 'running') app.audio.ctx.resume();
    if (!on) closeAllSessionTakes();
    app.audio.send({ t: on ? 'play' : 'stop', countIn });
    app.control?.feedbackSoon();
    if (!on && app.recording) app.setRecord(false);
    app.playing = on; $('play').classList.toggle('on', on);
  },
  setMode(mode) {
    app.view.mode = mode;
    $('mode-arr').classList.toggle('on', mode === 'arrange'); $('mode-ses').classList.toggle('on', mode === 'session');
    $('session').hidden = mode !== 'session'; $('scene-bar').hidden = mode !== 'session';
    $('ruler').style.visibility = mode === 'session' ? 'hidden' : '';
    if (mode === 'session') app.session.render(); else app.arrange.redraw();
  },
  launch(trackId, slot) { app.audio.send({ t: 'launch', track: trackId, slot }); if (!app.playing && slot >= 0) { app.playing = true; $('play').classList.add('on'); } },
  launchScene(i) { app.audio.send({ t: 'scene', slot: i }); if (!app.playing) { app.playing = true; $('play').classList.add('on'); } },
  stopAll() { app.audio.send({ t: 'stopAll' }); },
  // PUNCH: on, the zone is brought into view (the loop, or 4 bars from the playhead) and explained
  togglePunch() {
    const p = app.store.p, sig = p.sig, on = !p.punch.on;
    let { a, b } = p.punch;
    if (on) {
      const ar = app.arrange, [w] = ar.ruler.size(), v0 = ar.beat(0), v1 = ar.beat(w);
      if (!(b > v0 && a < v1) || b <= a) {
        if (p.loop.on && p.loop.a >= v0 && p.loop.b <= v1 && p.loop.b - p.loop.a < v1 - v0) ({ a, b } = p.loop);   // a loop in view
        else { a = Math.floor(app.pos / sig) * sig; b = a + 4 * sig; }
      }
    }
    app.store.change((pp) => { pp.punch = { on, a, b }; });
    if (on) app.punchHint(); else toast('PUNCH OFF: recording keeps everything you play.');
  },
  punchHint() {
    const p = app.store.p, bar = (x) => +(x / p.sig + 1).toFixed(2);
    toast(`PUNCH ON, bar ${bar(p.punch.a)} to bar ${bar(p.punch.b)}: press REC and play, only what falls inside the red zone is recorded. Drag the zone's ends in the ruler to move them.`);
  },
  async setRecord(on) {
    const target = app.playTarget();
    if (on && target?.kind === 'audio') {
      try { await app.audio.enableInput(); } catch (err) { toast(`Recording needs an audio input: ${err.message || 'access refused'}.`); return; }
      app.takeTrack = target.id; app.take = null;
      app.audio.send({ t: 'capture', on: true });
    } else if (!on) app.audio.send({ t: 'capture', on: false });
    if (!on) closeAllSessionTakes();
    app.recording = on;
    $('rec').classList.toggle('on', on);
    app.audio.send({ t: 'rec', on });
    app.store.endGesture();
    if (on) for (const [id, st] of Object.entries(app.session.state)) if (st.slot >= 0) sessRec.set(id, { slot: st.slot, at: app.pos });
    if (on && !app.playing) app.play(true, app.store.p.countIn);
  },
  playTarget() {
    const p = app.store.p;
    return p.tracks.find((t) => t.arm) || app.store.track(app.view.selTrack) || null;
  },
  noteOn(trackId, n, v = 100) { const t = app.store.track(trackId); if (t?.kind === 'external') app.control.externalLive(t, true, n, v); app.audio.send({ t: 'note', track: trackId, n, v, on: true, silent: t?.kind === 'external' }); },
  noteOff(trackId, n) { const t = app.store.track(trackId); if (t?.kind === 'external') app.control.externalLive(t, false, n, 0); app.audio.send({ t: 'note', track: trackId, n, v: 0, on: false, silent: t?.kind === 'external' }); },
  audition(trackId, notes, ms = 450) {
    setTimeout(() => {                                         // after the new sound reaches the engine
      for (const n of notes) app.noteOn(trackId, n, 96);
      setTimeout(() => { for (const n of notes) app.noteOff(trackId, n); }, ms);
    }, 60);
  },
  setSound(trackId, snd, reset = false) {
    app.store.change((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!('dx7' in snd)) delete t.dx7;                         // another sound: the DX7 voice goes
      Object.assign(t, snd);
      t.params = {};
      if (reset) t.rev = (t.rev || 0) + 1;
      if (t.engine >= app.lib[t.bank].engines.length) t.engine = 0;
    });
    app.params.delete(trackId);
  },
  // freeze: the instrument rendered to audio (pre-effects), played instead of the instrument
  async freeze(id) {
    const t = app.store.track(id);
    if (!t) return;
    toast(`Freezing ${t.name}…`);
    try {
      const [L, R] = await app.audio.render(app.store.p, { freezeTrack: id, assets: usedAssets(app.store.p) });
      const aid = uid('a');
      addAsset(aid, { L, R, name: `${t.name} frozen` });
      app.store.change((p) => { p.assets[aid] = { name: `${t.name} frozen`, frames: L.length }; p.tracks.find((x) => x.id === id).frozen = { src: aid, bpm: p.bpm }; });
      toast(`${t.name} frozen: its instrument rests. Unfreeze to edit it.`);
    } catch (err) { toast(`Freeze failed: ${err.message}`); }
  },
  unfreeze(id) { app.store.change((p) => { delete p.tracks.find((x) => x.id === id).frozen; }); },
  async loadSampleFile(f) {
    try {
      const { L, R } = await decode(app.audio.ctx, await f.arrayBuffer());
      const id = uid('a'), name = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
      addAsset(id, { L, R, name });
      app.store.change((p) => { p.assets[id] = { name, frames: L.length }; });
      return id;
    } catch { toast(`${f.name}: this file could not be read as audio.`); return null; }
  },
  setKit(trackId, kit) { app.store.change((p) => { p.tracks.find((x) => x.id === trackId).kit = kit; }); },
  addTrack(kind, opts = {}) {
    const p = app.store.p;
    const t = newTrack(kind, p.tracks.length, { ...opts, scenes: p.scenes.length, color: COLORS[p.tracks.length % COLORS.length] });
    if (kind === 'synth' && opts.bank == null) {
      const cat = app.lib.clipper, e = cat.engines.findIndex((x) => x.name === 'HYBRID');
      Object.assign(t, { bank: 'clipper', engine: Math.max(0, e), preset: 0 });
    }
    if (opts.name) t.name = opts.name.slice(0, 16);
    app.store.change((pp) => pp.tracks.push(t));
    app.view.selTrack = t.id; app.view.selClip = null;
    app.store.emit('select');
    if (kind === 'drum') app.audition(t.id, [36, 42]); else if (kind === 'synth') app.audition(t.id, [60, 64, 67]);
    toast({ audio: `${t.name}: drop audio files on its lane, or arm it and press R to record.`, sampler: `${t.name}: load a sample in INSTRUMENT, then play it.`,
      external: `${t.name}: choose the MIDI device and channel in INSTRUMENT. Its clips play that device.`, group: `${t.name}: route tracks to it from the mixer (OUT).` }[kind]
      || `${t.name}: new track. Double-click its lane to write a clip.`);
    return t;
  },
  // a group (bus) above the selected track, which it now feeds
  addGroup() {
    const p = app.store.p, sel = app.store.track(app.view.selTrack);
    const g = newTrack('group', p.tracks.length, { scenes: p.scenes.length, color: '#9aa0a6', name: 'GROUP' });
    app.store.change((pp) => {
      const i = sel ? pp.tracks.findIndex((x) => x.id === sel.id) : pp.tracks.length;
      pp.tracks.splice(Math.max(0, i), 0, g);
      if (sel) { const s2 = pp.tracks.find((x) => x.id === sel.id); g.out = s2.out; s2.out = g.id; }
    });
    app.selectTrack(g.id);
    toast(sel ? `${sel.name} now plays through ${g.name}. Route more tracks to it with OUT in the mixer.` : `${g.name}: route tracks to it with OUT in the mixer.`);
  },
  addReturn() {
    const add = (type, name) => { app.store.change((p) => { p.returns.push(newReturn(type, `${name} ${p.returns.length + 1}`)); }); app.showTab('mixer'); toast(`${name} return added: every track has a send to it in the mixer.`); };
    modal('New return track', [h('p', { text: 'A return gets the tracks\' sends. Start it with an effect, or empty for your own rack.' })],
      [['Reverb', () => add('reverb', 'REVERB'), true], ['Delay', () => add('delay', 'DELAY')], ['Empty (rack only)', () => add('none', 'RETURN')], ['Cancel']]);
  },
  importAudio, pickAudio, importMidiFile, warpClip, detectClipBpm, clipToSampler,
  // delete a track, after asking: its clips, automation and effects go with it (Ctrl+Z brings it back)
  deleteTrack(id, ask = true) {
    const t = app.store.track(id);
    if (!t) return;
    const go = () => {
      for (let n = 0; n < 128; n++) app.noteOff(id, n);
      const i = app.store.p.tracks.findIndex((x) => x.id === id);
      app.store.change((p) => { for (const x of p.tracks) if (x.out === id) x.out = t.out || 'master'; p.tracks = p.tracks.filter((x) => x.id !== id); });
      const next = app.store.p.tracks[Math.min(i, app.store.p.tracks.length - 1)];
      app.view.selTrack = next?.id ?? null; app.view.selClip = null; app.view.autoOpen.delete(id);
      app.store.emit('select');
      toast(`${t.name} deleted. Ctrl+Z brings it back.`);
    };
    if (!ask) return go();
    const n = t.clips.length, fx = t.fx?.length || 0;
    const what = [n ? `${n} clip${n > 1 ? 's' : ''}` : null, Object.keys(t.auto || {}).length ? 'its automation' : null, fx ? `${fx} effect${fx > 1 ? 's' : ''}` : null].filter(Boolean);
    confirmBox(`Delete ${t.name}?`, `${what.length ? `Its ${what.join(', ')} will be deleted with it. ` : ''}You can still undo it with Ctrl+Z.`, 'Delete track', go, true);
  },
  duplicateTrack(id) {
    const t = app.store.track(id);
    if (!t) return;
    const c = structuredClone(t);
    c.id = uid('t'); c.name = `${t.name} 2`.slice(0, 16); c.arm = false; c.solo = false;
    for (const cl of c.clips) cl.id = uid('c');
    for (const f of c.fx || []) f.id = uid('f');
    app.store.change((p) => { const i = p.tracks.findIndex((x) => x.id === id); p.tracks.splice(i + 1, 0, c); });
    app.selectTrack(c.id);
    toast(`${c.name}: a copy of ${t.name}.`);
  },
});

// ------------------------------------------------------------- the phone ---
const phone = () => window.matchMedia('(max-width: 860px)').matches;
function setMobile(m) {
  $('app').dataset.m = m === 'keys' ? 'bot' : m;
  for (const b of document.querySelectorAll('#mnav button')) b.classList.toggle('on', b.dataset.m === m);
}

// ---------------------------------------------------------- the top rail ---
function bindTop() {
  $('app').dataset.m = 'arr';
  for (const b of document.querySelectorAll('#mnav button')) {
    b.onclick = () => {
      const m = b.dataset.m;
      if (m === 'keys') app.showTab('keys');
      else if (m === 'bot') app.showTab(app.view.tab === 'keys' ? 'edit' : app.view.tab);
      else setMobile(m);
    };
  }
  $('play').onclick = () => app.play();
  $('rec').onclick = () => app.setRecord(!app.recording);
  $('home').onclick = () => app.seek(app.store.p.loop.on ? app.store.p.loop.a : 0);
  $('loop').onclick = () => app.store.change((p) => { p.loop.on = !p.loop.on; });
  $('click').onclick = () => { app.click = !app.click; $('click').classList.toggle('on', app.click); app.audio.send({ t: 'click', on: app.click }); };
  $('undo').onclick = () => app.store.undo();
  $('learn').onclick = () => app.control.setLearning(!app.control.learning);
  $('redo').onclick = () => app.store.redo();
  $('libbtn').onclick = () => $('app').classList.toggle('no-lib');
  $('mode-arr').onclick = () => app.setMode('arrange');
  $('mode-ses').onclick = () => app.setMode('session');
  const addMenu = $('addmenu');
  $('addbtn').onclick = (e) => { e.stopPropagation(); addMenu.hidden = !addMenu.hidden; };
  document.addEventListener('pointerdown', (e) => { if (!addMenu.contains(e.target) && e.target !== $('addbtn')) addMenu.hidden = true; });
  addMenu.addEventListener('click', () => { addMenu.hidden = true; });
  $('add-sampler').onclick = () => app.addTrack('sampler', { sends: [0.1, 0] });
  $('add-ext').onclick = () => app.addTrack('external', { sends: [0, 0] });
  $('add-group').onclick = () => app.addGroup();
  $('add-return').onclick = () => app.addReturn();
  $('add-tempo').onclick = () => { app.view.tempoLane = true; if (!app.store.p.tempo.length) app.store.change((p) => { p.tempo = [{ t: 0, v: p.bpm }]; }); app.arrange.renderHeads(); app.arrange.redraw(); app.setMode('arrange'); };
  $('countin').onclick = () => app.store.change((p) => { p.countIn = !p.countIn; });
  $('punch').onclick = () => app.togglePunch();
  $('swing').onchange = (e) => app.store.change((p) => { p.swing = +e.target.value; });
  $('add-synth').onclick = () => app.addTrack('synth');
  $('add-audio').onclick = () => app.addTrack('audio', { sends: [0, 0] });
  $('add-drum').onclick = () => app.addTrack('drum', { kit: app.lib.sloop.kits.indexOf('909') });
  $('snap').onchange = (e) => { app.view.snap = +e.target.value; app.arrange.redraw(); };
  $('pname').addEventListener('change', (e) => app.store.change((p) => { p.name = e.target.value.trim().slice(0, 40) || 'Untitled'; }));
  $('pname').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
  const bpm = $('bpm');
  const setBpm = (v) => app.store.change((p) => { p.bpm = Math.max(40, Math.min(240, Math.round(v * 100) / 100)); }, 'bpm');
  bpm.addEventListener('change', () => { const v = parseFloat(bpm.value); if (v) setBpm(v); });
  bpm.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') bpm.blur(); });
  bpm.addEventListener('pointerdown', (e) => {
    if (document.activeElement === bpm) return;
    e.preventDefault();
    const y0 = e.clientY, v0 = app.store.p.bpm;
    let moved = false;
    const mv = (m) => { moved = true; setBpm(Math.round(v0 + (y0 - m.clientY) / 3)); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); app.store.endGesture(); if (!moved) { bpm.focus(); bpm.select(); } };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  for (const b of document.querySelectorAll('#bot .tab[data-tab]')) b.onclick = () => app.showTab(b.dataset.tab);
  const menu = $('filemenu');
  $('filebtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && e.target !== $('filebtn')) menu.hidden = true; });
  menu.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; menu.hidden = true; fileAction(b.dataset.act); };
  $('openfile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {                // a .zip: project.json + the audio
        const entries = await unzip(bytes);
        const pj = entries.find((x) => x.name.endsWith('project.json'));
        if (!pj) throw new Error('This ZIP holds no Kraken project.');
        const p = validate(JSON.parse(new TextDecoder().decode(pj.data)));
        for (const en of entries) {
          const m = en.name.match(/assets\/([^/]+)\.wav$/);
          if (m && p.assets[m[1]]) addAsset(m[1], { ...(await decode(app.audio.ctx, en.data.slice().buffer)), name: p.assets[m[1]].name });
        }
        load(p);
      } else load(validate(JSON.parse(new TextDecoder().decode(bytes))));
      await restoreAssets(app.store.p);
      toast(`${app.store.p.name} opened.`);
    } catch (err) { toast(err.message); }
  };
}

function load(p) {
  app.audio.send({ t: 'stop' }); app.audio.send({ t: 'panic' });
  app.params.clear();
  app.view.selTrack = p.tracks[0]?.id ?? null; app.view.selClip = null; app.view.autoOpen.clear();
  app.store.replace(p);
  app.seek(0);
}

async function fileAction(act) {
  const p = app.store.p, base = (p.name || 'kraken').replace(/[^\w\- ]+/g, '').trim() || 'kraken';
  try {
    if (act === 'new') confirmBox('New project', 'Start from an empty project? The current one stays in the undo history until you close the page.', 'New project', () => {
      const np = newProject(); np.tracks = [newTrack('drum', 0, { kit: app.lib.sloop.kits.indexOf('909') }), newTrack('synth', 1, { bank: 'clipper', engine: app.lib.clipper.engines.findIndex((e) => e.name === 'HYBRID') })];
      load(np);
    });
    else if (act === 'demo') load(demoProject(app.lib));
    else if (act === 'open') $('openfile').click();
    else if (act === 'save') {
      const used = usedAssets(p);
      const ids = Object.keys(used);
      let name;
      if (ids.length) {                                          // with audio: one .zip, the project and its files
        const files = [{ name: 'project.json', data: JSON.stringify(p, null, 1) },
          ...ids.map((id) => ({ name: `assets/${id}.wav`, data: encodeWav([used[id].L, used[id].R], RATE, 24) }))];
        name = await saveFile(`${base}.kraken.zip`, zip(files));
      } else name = await saveFile(`${base}.kraken.json`, JSON.stringify(p, null, 1));
      toast(`Saved ${name}`);
    }
    else if (act === 'importmidi') { const inp = $('midifile'); inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) importMidiFile(f).catch((e2) => toast(e2.message)); }; inp.click(); }
    else if (act === 'midi') { const name = await saveFile(`${base}.mid`, exportMidi(p), { zipWhenHosted: true }); toast(`Saved ${name}`); }
    else if (act === 'wav' || act === 'stems') await exportAudio(act === 'stems', base);
    else if (act === 'help') help();
    else if (act === 'install') installApp();
    else if (act === 'palette') app.palette.open();
  } catch (err) {
    if (err?.code === 'declined') return;
    toast(err?.message || String(err));
  }
}

async function exportAudio(stems, base) {
  const p = structuredClone(app.store.p);
  if (!p.tracks.some((t) => t.clips.length)) { toast('Nothing to export yet: add a clip first.'); return; }
  const bar = h('div', { class: 'progress' }, h('i'));
  const msg = h('p', { text: 'Rendering the mix with the same engines you hear…' });
  const box = modal('Export', [msg, bar], []);
  const step = (i, n, what) => { bar.style.setProperty('--v', (i / n).toFixed(3)); msg.textContent = `Rendering ${what} (${i + 1}/${n})…`; };
  try {
    const t0 = performance.now();
    const jobs = [{ name: 'MIX', solo: null }, ...(stems ? p.tracks.map((t, i) => ({ name: `${String(i + 1).padStart(2, '0')} ${t.name}`, solo: t.id })) : [])];
    const files = [];
    for (let i = 0; i < jobs.length; i++) {
      step(i, jobs.length, jobs[i].name);
      const [L, R] = await app.audio.render(p, { soloTrack: jobs[i].solo, assets: usedAssets(p) });
      files.push({ name: `${base} - ${jobs[i].name}.wav`, data: encodeWav([L, R], RATE, 24) });
    }
    bar.style.setProperty('--v', 1);
    msg.textContent = `Rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s. Saving…`;
    const name = stems ? await saveFile(`${base} - stems.zip`, zip(files)) : await saveFile(files[0].name, files[0].data, { zipWhenHosted: true });
    box.close();
    toast(`Saved ${name}`);
  } catch (err) {
    box.close();
    if (err?.code !== 'declined') toast(`Export failed: ${err?.message || err}`);
  }
}

// ------------------------------------------------------------- dialogs ---
function modal(title, body, buttons) {
  const bg = h('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h3', { text: title }), ...body,
    buttons.length ? h('div', { class: 'row' }, buttons.map(([label, fn, go]) => h('button', { class: 'add' + (go ? ' go' : ''), onclick: () => { close(); fn?.(); } }, label))) : null);
  bg.append(box);
  bg.addEventListener('pointerdown', (e) => { if (e.target === bg && buttons.length) close(); });
  bg.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  document.body.append(bg);
  box.querySelector('.go')?.focus();
  return { close };
}
function confirmBox(title, text, ok, fn, danger = false) { const m = modal(title, [h('p', { text })], [['Cancel'], [ok, fn, true]]); if (danger) document.querySelector('.modal .go')?.classList.add('danger'); return m; }
function help() {
  const rows = [
    ['Space', 'Play / stop'], ['R', 'Record into the armed (or selected) track'], ['L', 'Loop on / off'], ['M', 'Metronome'],
    ['A W S E D F T G Y H U J K O', 'Play notes · Z / X octave · C / V velocity'], ['[ ]', 'Previous / next sound'],
    ['Ctrl Z · Ctrl Shift Z', 'Undo · redo'], ['Ctrl C · Ctrl V · Ctrl D', 'Copy, paste at the playhead, duplicate a clip'],
    ['Delete', 'Remove the selected clip or notes'], ['Ctrl wheel', 'Zoom · Shift wheel: scroll sideways'],
    ['Arrangement', 'Drag on a lane: new clip · drag a clip: move · its end: resize · Alt-drag: copy · right-click: remove'],
    ['Piano roll', 'Click: note · drag: length · Shift-drag: select · double-click: remove · ↑ ↓ transpose · Q quantize'],
    ['Ruler', 'Click: move the playhead · top band: set or drag the loop'], ['Esc', 'All notes off'],
    ['Ctrl L · LEARN', 'MIDI Learn: click any knob, fader, button or action, then move a control (or press a key)'],
    ['Controllers tab', 'Devices, Mackie Control, MIDI clock out, mappings, actions, channel routing'],
    ['Drop a .mid', 'Import a MIDI file as tracks · drop audio files to make audio tracks'],
    ['Ctrl K', 'Command palette: every action, track, sound, kit and effect'],
    ['Tab', 'Arrangement / session'],
    ['Ruler', 'Top band: the LOOP · middle band: PUNCH in / out · bottom: the playhead. Drag a zone\'s ends to resize it, its middle to move it, click it to turn it on / off'],
    ['Clip editor', 'The strip above the notes: drag the white handle for the clip length, the orange one for the loop'],
  ];
  modal('Keys & mouse', [h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', font: '500 11px/1.4 var(--f-ui)' } },
    rows.flatMap(([k, v]) => [h('span', { style: { font: '500 10px/1.4 var(--f-mono)', color: 'var(--accent)' }, text: k }), h('span', { text: v })]))], [['Close', null, true]]);
}
let toastTimer = 0;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, Math.max(3200, text.length * 60));
}
app.toast = toast;

// -------------------------------------------------------------- keys ---
let clipboard = null;
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (typing(e) || document.querySelector('.modal-bg')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), v = app.view, p = app.store.p;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? app.store.redo() : app.store.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); app.store.redo(); return; }
    if (mod && k === 's') { e.preventDefault(); fileAction('save'); return; }
    if (mod && k === 'o') { e.preventDefault(); fileAction('open'); return; }
    if (mod && k === 'l') { e.preventDefault(); app.control.setLearning(!app.control.learning); return; }
    if (mod && k === 'k') { e.preventDefault(); app.palette.open(); return; }
    const t = app.store.track(v.selTrack), clip = t?.clips.find((c) => c.id === v.selClip);
    if (mod && k === 'c' && clip) { e.preventDefault(); clipboard = { kind: t.kind, clip: structuredClone(clip) }; toast(`Copied ${clip.name}`); return; }
    if (mod && k === 'v' && clipboard && v.mode === 'session' && v.selSlot) {      // into the selected session slot
      e.preventDefault();
      const { track, i } = v.selSlot, tr = app.store.track(track);
      if (!tr || clipboard.kind !== tr.kind) { toast('That clip belongs on another kind of track.'); return; }
      const c = { ...structuredClone(clipboard.clip), id: uid('c') }; delete c.start;
      if (!c.loop) c.loop = c.len;
      app.store.change((pp) => { pp.tracks.find((x) => x.id === track).slots[i] = c; });
      app.selectClip(c.id, track); return;
    }
    if (mod && k === 'v' && clipboard && t) {
      e.preventDefault();
      if (clipboard.kind !== t.kind) { toast(`That clip belongs on a ${clipboard.kind === 'drum' ? 'drum' : 'synth'} track.`); return; }
      const c = { ...structuredClone(clipboard.clip), id: uid('c'), start: Math.floor(app.pos / p.sig) * p.sig };
      app.store.change((pp) => pp.tracks.find((x) => x.id === t.id).clips.push(c)); app.selectClip(c.id, t.id); return;
    }
    if (mod && k === 'd' && clip) {
      e.preventDefault();
      const c = { ...structuredClone(clip), id: uid('c'), start: clip.start + clip.len };
      app.store.change((pp) => pp.tracks.find((x) => x.id === t.id).clips.push(c)); app.selectClip(c.id, t.id); return;
    }
    if (mod) return;
    if (e.key === 'Tab') { e.preventDefault(); app.setMode(v.mode === 'session' ? 'arrange' : 'session'); return; }
    if (e.code === 'Space') { e.preventDefault(); app.play(); }
    else if (k === 'r' && !e.repeat) app.setRecord(!app.recording);
    else if (k === 'l') $('loop').click();
    else if (k === 'm') $('click').click();
    else if (k === 'b') $('libbtn').click();
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); $('home').click(); }
    else if (e.key === 'Escape') { app.audio.send({ t: 'panic' }); }
    else if ((e.key === '[' || e.key === ']') && t) {
      const d = e.key === ']' ? 1 : -1;
      if (t.kind === 'drum') {
        const kits = app.lib.sloop.kits.map((n, i) => [n, i]).filter(([n]) => !/^USR|^SYN/.test(n));
        const i = kits.findIndex(([, x]) => x === t.kit); app.setKit(t.id, kits[(i + d + kits.length) % kits.length][1]);
      } else {
        const cur = app.lib.soundOf(t), list = app.lib.byEngine[cur?.eng] || [];
        const s = list[(Math.max(0, list.indexOf(cur)) + d + list.length) % list.length];
        if (s) { app.setSound(t.id, { bank: s.bank, engine: s.engine, preset: s.preset }); app.audition(t.id, [60, 64, 67]); }
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !clip && t) {
      e.preventDefault();
      app.deleteTrack(t.id);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && clip) {
      e.preventDefault();
      app.store.change((pp) => { const tr = pp.tracks.find((x) => x.id === t.id); tr.clips = tr.clips.filter((c) => c.id !== clip.id); });
    }
  });
}

function bindResize() {
  const r = $('resize');
  r.addEventListener('pointerdown', (e) => {
    const y0 = e.clientY, h0 = $('bot').getBoundingClientRect().height;
    r.setPointerCapture(e.pointerId);
    const mv = (m) => $('app').style.setProperty('--bottom-h', `${Math.max(140, Math.min(window.innerHeight - 220, h0 + y0 - m.clientY))}px`);
    const up = () => { r.removeEventListener('pointermove', mv); r.removeEventListener('pointerup', up); };
    r.addEventListener('pointermove', mv); r.addEventListener('pointerup', up);
  });
}

// ----------------------------------------------------- installed app (PWA) ---
// offline once loaded (sw.js precaches everything), installable on a computer or a phone
let installEvent = null;
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
function setupPwa() {
  const framed = window.top !== window.self;
  if ('serviceWorker' in navigator && !framed && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* no offline mode here */ });
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('install').hidden = false; });
  window.addEventListener('appinstalled', () => { $('install').hidden = true; installEvent = null; toast('Kraken is installed: open it from your apps, even offline.'); });
  $('install').onclick = () => installApp();
  // files opened with the installed app (projects, MIDI files)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const fh of params.files || []) {
        const f = await fh.getFile();
        app.pendingFiles = [...(app.pendingFiles || []), f];
      }
      if (app.store) openPending();
    });
  }
}
async function openPending() {
  const files = app.pendingFiles || []; app.pendingFiles = [];
  for (const f of files) {
    if (/\.midi?$/i.test(f.name)) await importMidiFile(f).catch((e) => toast(e.message));
    else { const dt = new DataTransfer(); dt.items.add(f); $('openfile').files = dt.files; $('openfile').dispatchEvent(new Event('change')); }
  }
}
async function installApp() {
  if (installEvent) {
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === 'accepted') $('install').hidden = true;
    installEvent = null;
    return;
  }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const framed = window.top !== window.self;
  const steps = standalone() ? ['Kraken is already running as an installed app on this device.']
    : framed ? ['This page is embedded, so it cannot be installed from here.', 'Open Kraken on its own site (or run python3 serve.py on your computer), then use INSTALL or the browser menu.']
    : ios ? ['In Safari, tap the Share button.', 'Choose "Add to Home Screen", then "Add".', 'Open Kraken from the home screen: it runs offline. (iPhone and iPad have no Web MIDI: play with the screen, or a computer for MIDI controllers.)']
    : ['Chrome or Edge: click the install icon at the right of the address bar, or menu ⋮ > "Install Kraken".', 'Android: menu ⋮ > "Install app" (or "Add to Home screen").', 'Once installed, Kraken opens in its own window and works offline, engines included.'];
  modal('Install Kraken', [h('ol', { style: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '6px', font: '500 12px/1.45 var(--f-ui)' } }, steps.map((x) => h('li', { text: x })))], [['OK', null, true]]);
}

setupPwa();
boot();
