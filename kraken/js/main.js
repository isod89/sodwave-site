// SPDX-License-Identifier: GPL-3.0-only
// Kraken: a free DAW in the browser, with the SLOOP and Clipper engines of the M-VAVE FM-1 firmwares.
import { loadEngines, Audio } from './audio.js';
import { Store, demoProject, newProject, newTrack, newClip, newAudioClip, newReturn, validate, uid, COLORS, cutRange, APP_VERSION } from './project.js';
import { peaks, decode, storeAsset, loadAsset, detectBpm, stretch } from './assets.js';
import { autosaves, writeAutosave, emergencySave, addSnapshot, listSnapshots, getSnapshot, claimAutosave, askPersist, storageInfo } from './vault.js';
import { encodeWav } from './wav.js';
import { encodeFlac } from './flac.js';
import { encodeOpus, opusSupported } from './opus.js';
import { isFolder, addTake, renderFolder, setComp } from './comp.js';
import { saveFile, zip, unzip, exportMidi, parseMidi, hostedSave } from './io.js';
import { importSloopSong, presetDefaults } from './sloopsong.js';
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
import { diagnose, diagnosisText } from './ui/diagnostic.js';
import { reportDialog } from './ui/report.js';
import { welcome, startTour } from './ui/welcome.js';

const $ = (id) => document.getElementById(id);
const BOOTING = 'kraken.booting';        // set while a project opens: still there at the next start, it did not

const app = {
  view: { mode: 'arrange', selSlot: null, selTrack: null, selClip: null, snap: 0.25, autoOpen: new Set(), autoTarget: {}, tab: 'edit', follow: true },
  params: new Map(),          // track id -> the engine's parameter values after its preset loaded
  assets: new Map(),          // audio id -> { L, R, name, peaks }
  pos: 0, playing: false, recording: false, click: false,
  errors: [],                 // the last errors of this session (PROJECT > Report a problem)
  actions: [],                // and the last things done (the same report)
  canSave: false, dirty: false,
};
function logAct(what) { app.actions.push({ t: Date.now(), what }); if (app.actions.length > 40) app.actions.shift(); }
app.logAct = logAct;
// every error is kept for a report and said once in a while; the work is saved anyway
function noteError(msg, stack = '') {
  app.errors.push({ t: Date.now(), msg: String(msg).slice(0, 300), stack: String(stack || '').slice(0, 1200) });
  if (app.errors.length > 30) app.errors.shift();
  if (app.store && performance.now() - (noteError.last || -1e9) > 30000) {
    noteError.last = performance.now();
    toast(`Something went wrong (${String(msg).slice(0, 80)}). Your work is saved; ${matchMedia('(pointer: coarse)').matches ? '☰' : 'PROJECT'} > Report a problem helps fix it.`);
  }
}
window.addEventListener('error', (e) => noteError(e.message || 'error', e.error?.stack));
window.addEventListener('unhandledrejection', (e) => noteError(e.reason?.message || String(e.reason), e.reason?.stack));
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
  askPersist();                                                  // (the browser keeps Kraken's data: never cleared for room)
  // the last session: the newest good copy (a damaged one: the one before it)
  let project = null, from = null;
  let newer = null;
  for (const s of await autosaves()) {
    try { project = validate(JSON.parse(s.json)); from = s; break; } catch (e) { project = null; if (/newer Kraken/.test(e.message) && !newer) newer = s; }
  }
  if (newer) {                                                   // the last session was saved by a newer Kraken: kept aside, said
    await addSnapshot(newer.json, { name: 'Saved by a newer Kraken', why: 'Open it after reloading the page (the newer Kraken)', tracks: 0, keep: true });
    const pick = await bootChoice('Your last session was saved by a newer version of Kraken. Reload the page to get that version and your song.',
      [['reload', 'Reload the page'], ['go', project ? 'Open the older copy for now' : 'Start anyway']]);
    if (pick === 'reload') { location.reload(); return; }
  }
  let stuck = false;
  try { stuck = !!localStorage.getItem(BOOTING); } catch { /* */ }
  if (project && stuck) {                                       // it did not open last time: the person chooses
    const when = from.t ? new Date(from.t).toLocaleString() : 'earlier';
    const pick = await bootChoice(`Kraken did not finish opening last time. Your project "${project.name}" (saved ${when}) is safe.`,
      [['open', 'Open it'], ['demo', 'Start with the demo song (yours stays in PROJECT > Earlier versions)'], ['file', 'Download it first']]);
    if (pick === 'file') await saveFile(`${(project.name || 'kraken').replace(/[^\w\- ]+/g, '').trim() || 'kraken'}.kraken.json`, from.json);
    if (pick === 'demo') {
      const kept = await addSnapshot(from.json, { name: project.name, why: 'Kept when Kraken could not open it', tracks: project.tracks.length, keep: true });
      if (!kept) await saveFile(`${(project.name || 'kraken').replace(/[^\w\- ]+/g, '').trim() || 'kraken'}.kraken.json`, from.json);   // (no room to keep it here: a file)
      project = null;
    }
  }
  try { localStorage.setItem(BOOTING, String(Date.now())); } catch { /* */ }
  try {
    await openUi(project);
  } catch (err) {
    noteError(err.message, err.stack);
    $('boot').hidden = false;
    const pick = await bootChoice(`Kraken stopped while opening: ${err.message}. Your project is safe.`, [['again', 'Try again'], ['demo', 'Start with the demo song (yours stays in PROJECT > Earlier versions)']]);
    if (pick === 'demo' && from && !(await addSnapshot(from.json, { name: project?.name || 'Project', why: 'Kept when Kraken could not open it', tracks: project?.tracks.length || 0, keep: true }))) await saveFile('kraken-project.kraken.json', from.json);
    if (pick === 'demo') { try { localStorage.removeItem(BOOTING); } catch { /* */ } await writeAutosave(JSON.stringify(demoProject(app.lib))); }
    location.reload();
    return;
  }
}
// the boot screen asks: choices [[key, label]] -> the key picked
function bootChoice(text, choices) {
  $('boot-msg').textContent = text;
  $('boot-go').hidden = true;
  const box = $('boot-choices');
  return new Promise((resolve) => {
    box.replaceChildren(...choices.map(([key, label], i) => h('button', { class: 'key' + (i ? ' alt' : ''), onclick: () => { box.replaceChildren(); resolve(key); } }, label)));
    box.hidden = false;
    box.firstChild?.focus();
  });
}

async function openUi(project) {
  app.store = new Store(project || demoProject(app.lib));
  app.missingAtStart = 0;
  const change = app.store.change.bind(app.store);                // (each edit, once, for a problem report)
  app.store.change = (fn, tag = null) => { if (!tag || tag !== app.store.lastTag) logAct(`edit${tag ? ' ' + String(tag).slice(0, 40) : ''}`); return change(fn, tag); };
  app.missingAtStart = await restoreAssets(app.store.p);
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
  app.booting = true;
  app.store.emit('load');
  app.booting = false;
  app.audio.onRestart = () => resyncAll();                       // (the engines re-sent as bytes: the project again)
  $('boot').hidden = true;
  const opened = () => { try { localStorage.removeItem(BOOTING); } catch { /* */ } };
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(opened, 300)));   // (it opened and drew)
  window.addEventListener('pagehide', opened);
  // one tab writes the autosave: another one open asks first
  claimAutosave(() => { app.canSave = false; tabBanner(true); }, () => {
    app.canSave = true; $('save-banner').hidden = true; app.dirty = true; flushSave();
    toast('The other Kraken tab closed: this one saves your work now.');
  }).then((claim) => {   // (not waited for: the screen is ready now)
    app.canSave = claim.ok;
    app.takeOver = async () => {
      const other = (await autosaves())[0];
      if (other) await addSnapshot(other.json, { name: 'Saved by another tab', why: 'Replaced when this tab took over', tracks: 0 });
      await claim.take(); app.canSave = true; app.dirty = true; $('save-banner').hidden = true; flushSave();
      toast('This tab saves your work now.');
    };
    if (!claim.ok) tabBanner(false);
    else {
      if (project) addSnapshot(JSON.stringify(project), { name: project.name, why: 'Opened', tracks: project.tracks.length });
      if (app.dirty) flushSave();                                  // (changed before the claim came back)
    }
  });
  setTimeout(() => { if (!app.audio.lastTick) toast(`No sound engine running in this browser. ${matchMedia('(pointer: coarse)').matches ? '☰' : 'PROJECT'} > Check this device says why.`); }, 3000);
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault());   // (Safari: pinch zooms the clips, not the page)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') closingSave(); });
  window.addEventListener('pagehide', closingSave);
  if (window.innerWidth > 1180) $('app').classList.remove('no-lib');     // the library open where there is room for it
  const touch = matchMedia('(pointer: coarse)').matches;
  let welcomed = false;
  try { welcomed = !!localStorage.getItem('kraken.welcomed'); } catch { /* */ }
  // the first visit: the welcome (not under automation: the test suites start from the demo song)
  if (!project && !welcomed && !app.pendingFiles?.length && !navigator.webdriver) { welcome(app, { modal, first: true }); return; }
  if (app.missingAtStart) toast(`Your last session is back. ${missingText(app.missingAtStart)}`);
  else toast(project ? `Your last session is back. ${touch ? '☰' : 'PROJECT'} > Open demo song for the demo.` : touch ? 'Demo song loaded: tap ▶ to play. Hold a clip or a track for its menu.' : 'Demo song loaded: press Space to play.');
  if (app.pendingFiles?.length) openPending();
}

// -------------------------------------------------------------- the model ---
let syncQueued = false, saveTimer = 0, syncFull = false;
function onChange(p, why) {
  const v = app.view;
  if (!p.tracks.some((t) => t.id === v.selTrack)) v.selTrack = p.tracks[0]?.id ?? null;
  const t = app.store.track(v.selTrack);
  if (v.selClip && !p.tracks.some((tr) => tr.clips.some((c) => c.id === v.selClip) || tr.slots?.some((c) => c?.id === v.selClip))) v.selClip = null;
  if (why === 'load') syncFull = true;
  if (!syncQueued) {
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; const f = syncFull; syncFull = false; syncEngine(f); });
  }
  if (why !== 'select' && !app.booting) {                       // (only what changed the song is saved; what it opened with is there)
    app.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 800);
  }
  if ($('pname') !== document.activeElement) $('pname').value = p.name;
  if (p.bpm !== onChange.bpm) { onChange.bpm = p.bpm; if (why === 'change') restretchSoon(); }
  if ($('bpm') !== document.activeElement) $('bpm').value = String(+p.bpm.toFixed(2));
  $('bpm').previousElementSibling.textContent = p.tempo?.length ? 'BPM · MAP' : 'BPM';
  $('loop').classList.toggle('on', p.loop.on);
  $('countin').classList.toggle('on', !!p.countIn); $('punch').classList.toggle('on', !!p.punch?.on);
  if ($('swing') !== document.activeElement) $('swing').value = String(p.swing || 0);
  $('undo').disabled = !app.store.past.length; $('redo').disabled = !app.store.future.length;
  const clip = t?.clips.find((c) => c.id === v.selClip);
  $('tab-info').replaceChildren(...(t ? [h('span', { class: 'dot', '--c': t.color }), `${t.name}${clip ? ' · ' + clip.name : ''}`] : []));
  if (why === 'load' || why === 'history') app.arrange.redraw();
}

// ------------------------------------------------------------ the autosave ---
const projectJson = () => JSON.stringify({ ...app.store.p, savedWith: APP_VERSION });
let lastSnap = { t: Date.now(), json: '' };
async function flushSave() {
  clearTimeout(saveTimer);
  if (!app.dirty || !app.canSave || !app.store) return;
  app.dirty = false;
  const js = projectJson();
  const ok = await writeAutosave(js);
  saveBanner(!ok);
  // an earlier version every 5 minutes of work
  if (ok && Date.now() - lastSnap.t > 5 * 60000 && js !== lastSnap.json) {
    lastSnap = { t: Date.now(), json: js };
    addSnapshot(js, { name: app.store.p.name, why: 'While you worked', tracks: app.store.p.tracks.length });
  }
}
app.flushSave = flushSave;
function closingSave() {                                // the page is hidden or closing: written now, while it can
  if (!app.dirty || !app.canSave || !app.store) return;
  emergencySave(projectJson());
  flushSave();
}
function saveBanner(failed) {
  const b = $('save-banner');
  if (!failed) { if (b.dataset.kind === 'fail') b.hidden = true; return; }
  if ((!b.hidden && b.dataset.kind === 'fail') || Date.now() - (+b.dataset.snooze || 0) < 120000) return;
  b.dataset.kind = 'fail';
  b.replaceChildren(h('span', { text: 'Kraken cannot save in this browser right now (storage full or blocked). Keep your work in a file:' }),
    h('button', { class: 'key', onclick: () => fileAction('save') }, 'SAVE TO A FILE'), closeX(b));
  b.hidden = false;
}
const closeX = (b) => h('button', { class: 'x', title: 'Hide', 'aria-label': 'Hide', onclick: () => { b.hidden = true; b.dataset.snooze = String(Date.now()); } }, '×');
function tabBanner(lost) {
  const b = $('save-banner');
  b.dataset.kind = 'tab';
  b.replaceChildren(h('span', { text: lost ? 'Kraken was opened in another tab, which saves your work now. This tab no longer saves by itself.'
    : 'Kraken is already open in another tab. This one does not save by itself.' }),
  h('button', { class: 'key', onclick: () => app.takeOver() }, 'SAVE FROM THIS TAB'), closeX(b));
  b.hidden = false;
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
app.restartAudioQuiet = () => resyncAll();
app.restartAudio = () => { app.audio.restart(); resyncAll(); app.playing = false; $('play').classList.remove('on'); toast('Audio engine restarted.'); };

function onAudio(m) {
  if (m.t === 'tick') {
    if ((m.seq ?? 0) < (app.seekSeq || 0) && performance.now() - app.seekAt < 500) return;   // sent before our last seek reached the engine
    app.pos = m.pos;
    if (app.playing !== m.playing) { app.playing = m.playing; $('play').classList.toggle('on', m.playing); app.control.feedbackSoon(); }
    if (app.playing && app.view.follow) app.arrange.follow(m.pos);
    showPos();
    app.arrange.redraw();
    app.arrange.meters(m.tracks);
    if (app.view.tab === 'device') { app.device.gr(m.gr); app.device.mods(m.mods); }
    if (app.view.tab === 'edit') app.editor.canvas.redraw();
    if (app.view.tab === 'mixer') app.mixer.meters(m);
    app.session.update(m.sess);
    showMeters(m);
    const lv = (x) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(1e-5, x)) + 48) / 48)).toFixed(3);
    const [a, b] = $('mmeter').children;
    a.style.setProperty('--v', lv(m.master[0])); b.style.setProperty('--v', lv(m.master[1]));
  } else if (m.t === 'load') {
    const v = Math.round(m.v * 100), cell = $('cpu-cell');
    $('cpu').textContent = `${v} %`;
    cell.classList.toggle('hot', v >= 80);
    if (v >= 90 && app.playing && performance.now() - (onAudio.hotAt || -1e9) > 120000) {
      onAudio.hotAt = performance.now();
      toast(`The audio engine is at ${v} %: it may crackle. Freeze a heavy track (INSTRUMENT tab > FREEZE TRACK) or remove effects to lighten it.`);
    }
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
    tr.clips = cutRange(tr.clips, open.at, end, p.bpm);         // the take replaces what was there, only there
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
  if (persist) storeAsset(id, asset).then((ok) => { if (ok === null) toast(`${a.name || 'This audio'} could not be kept in the browser (storage full?): PROJECT > Save keeps it in the project's .zip.`); });
  return asset;
}
async function restoreAssets(p) {
  let missing = 0;
  for (const id of Object.keys(p.assets || {})) {
    if (app.assets.has(id)) { app.audio.send({ t: 'asset', id, L: app.assets.get(id).L, R: app.assets.get(id).R }); continue; }
    const a = await loadAsset(id);
    if (a?.L && a.R) addAsset(id, a, false); else missing++;
  }
  if (missing) toast(missingText(missing));
  return missing;
}
const missingText = (n) => `${n} audio file${n > 1 ? 's are' : ' is'} missing from this browser. Open the project's .zip to bring them back.`;
function usedAssets(p) {
  const out = {};
  const use = (id) => { const a = id && app.assets.get(id); if (a) out[id] = { L: a.L, R: a.R }; };
  for (const t of p.tracks) {
    for (const c of t.clips) { use(c.src); for (const k of c.takes || []) use(k.src); }
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

// a SLOOP song (.sloopsong, from SLOOP's web editor: Song & sections > Export this song): a project of its own, its
// sections in the arrangement (in the song's order) and as session scenes. The current project: one Ctrl+Z away
async function openSloopSong(file, json = null) {
  let res;
  try {
    json ??= JSON.parse(await file.text());
    res = importSloopSong(json, app.lib.sloop, (app.sloopDefaults ||= presetDefaults(app.modules.sloop)));
  } catch (e) { toast(e instanceof SyntaxError ? 'This file is not a SLOOP song.' : e.message); return; }
  const { project: p, warnings } = res;
  const go = () => {
    load(validate(p));
    const secs = p.markers.length ? [...new Set(p.markers.map((m) => m.name.replace('SECTION ', '')))].join(' ') : '';
    toast(`${p.name}: ${p.tracks.length} tracks${secs ? `, sections ${secs} in the song and as session scenes` : ''}.${warnings.length ? ' ' + warnings.join(' ') : ''}`);
  };
  if (app.store.p.tracks.some((t) => t.clips.length || t.slots?.some(Boolean))) confirmBox('Open the SLOOP song', `Open "${p.name}" in place of the current project? Ctrl+Z (or ↶) brings yours back.`, 'Open the song', go);
  else go();
}
const isSloopSong = (f) => /\.sloopsong$/i.test(f.name);

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
  const len = n / RATE / spb - offset / spb, id = uid('a'), name = `${t.name} take ${t.clips.length + 1}`;
  addAsset(id, { L, R, name });
  app.store.change((pp) => {
    pp.assets[id] = { name, frames: n };
    const tr = pp.tracks.find((x) => x.id === t.id);
    // recorded over audio already there (a loop pass, a punch, a second try): one more take in its folder
    const over = tr.clips.filter((c) => c.src && (!c.warp || c.warp === 'off') && c.start < begin + len - 0.01 && c.start + c.len > begin + 0.01)
      .sort((a, b) => (Math.min(b.start + b.len, begin + len) - Math.max(b.start, begin)) - (Math.min(a.start + a.len, begin + len) - Math.max(a.start, begin)));
    if (over.length) {
      const c = over[0], k = addTake(c, { src: id, offset, name: `TAKE ${(c.takes?.length || 1) + 1}` }, begin, len);
      c.name = `TAKES ${k + 1}`.slice(0, 18);
      app.view.takesOpen ??= new Set(); app.view.takesOpen.add(t.id);
      app.view.selClip = c.id;
    } else {
      const clip = newAudioClip(begin, len, id, `TAKE ${tr.clips.length + 1}`);
      clip.offset = offset;
      tr.clips.push(clip);
    }
  });
}
// the comp of a take folder rendered into one plain clip
function flattenComp(trackId, clipId) {
  const t = app.store.track(trackId), c = t?.clips.find((x) => x.id === clipId);
  if (!isFolder(c)) return;
  const { L, R } = renderFolder(c, app.assets, app.store.p.bpm, RATE);
  const id = uid('a'), name = `${t.name} comp`;
  addAsset(id, { L, R, name });
  app.store.change((p) => {
    p.assets[id] = { name, frames: L.length };
    const x = p.tracks.find((q) => q.id === trackId).clips.find((q) => q.id === clipId);
    delete x.takes; delete x.comp;
    Object.assign(x, { src: id, offset: 0, name: 'COMP', fadeIn: 0.002, fadeOut: 0.002 });
  });
  toast('Comp flattened into one clip. Undo brings the takes back.');
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
    if (name !== app.view.tab) logAct(`tab: ${name}`);
    app.view.tab = name;
    for (const b of document.querySelectorAll('#bot .tab[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
    for (const v of ['edit', 'device', 'mixer', 'ctl', 'keys']) $('v-' + v).hidden = v !== name;
    if (name === 'ctl') app.controllers.render();
    if (name === 'keys') app.keys.render();
    if (phone()) setMobile(name === 'keys' ? 'keys' : 'bot');
    if (name === 'device') app.device.refresh(true);
    if (name === 'edit') app.editor.refresh();
  },
  seek(beat) { app.pos = beat; app.seekSeq = (app.seekSeq || 0) + 1; app.seekAt = performance.now(); app.audio.send({ t: 'seek', beat, seq: app.seekSeq }); showPos(); app.arrange.redraw(); app.editor.canvas.redraw(); },
  play(on = !app.playing, countIn = false) {
    logAct(on ? 'play' : 'stop');
    if (app.audio.ctx.state !== 'running') app.audio.ctx.resume();
    if (!on) closeAllSessionTakes();
    app.audio.send({ t: on ? 'play' : 'stop', countIn });
    app.control?.feedbackSoon();
    if (!on && app.recording) app.setRecord(false);
    app.playing = on; $('play').classList.toggle('on', on);
  },
  setMode(mode) {
    logAct(`view: ${mode}`);
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
  // markers: N adds one at the playhead, , and . jump to the previous / next
  addMarker(at = Math.floor(app.pos + 1e-6)) {
    const p = app.store.p, names = ['INTRO', 'VERSE', 'CHORUS', 'BRIDGE', 'DROP', 'BREAK', 'OUTRO'];
    const used = new Set((p.markers || []).map((m) => m.name));
    const name = names.find((n) => !used.has(n)) || `MARKER ${(p.markers || []).length + 1}`;
    if ((p.markers || []).some((m) => Math.abs(m.t - at) < 1e-6)) return;
    app.store.change((pp) => { pp.markers ||= []; pp.markers.push({ id: uid('k'), t: at, name }); pp.markers.sort((a, b) => a.t - b.t); });
    toast(`Marker ${name} at bar ${+(at / p.sig + 1).toFixed(2)}. ${matchMedia('(pointer: coarse)').matches ? 'Double-tap' : 'Double-click'} it to rename it.`);
  },
  renameMarker(id) {
    const m = app.store.p.markers.find((x) => x.id === id);
    if (!m) return;
    const inp = h('input', { value: m.name, maxlength: 24, style: { width: '100%' }, 'aria-label': 'Marker name' });
    const ok = () => { const v = inp.value.trim().toUpperCase().slice(0, 24); if (v) app.store.change((pp) => { const x = pp.markers.find((q) => q.id === id); if (x) x.name = v; }); };
    modal('Rename marker', [inp], [['Delete', () => app.store.change((pp) => { pp.markers = pp.markers.filter((q) => q.id !== id); })], ['Cancel', null], ['Rename', ok, true]]);
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { ok(); document.querySelector('.modal-bg')?.remove(); } });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  },
  gotoMarker(dir) {
    const ms = [...(app.store.p.markers || [])].sort((a, b) => a.t - b.t), pos = app.pos;
    const m = dir > 0 ? ms.find((x) => x.t > pos + 0.01) : ms.reverse().find((x) => x.t < pos - (app.playing ? 0.5 : 0.01));
    if (m) { app.seek(m.t); toast(m.name); }
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
  // an external track sends its live notes straight out (lowest latency), unless note effects must shape them first
  noteOn(trackId, n, v = 100) { const t = app.store.track(trackId), direct = t?.kind === 'external' && !t.nfx?.some((d) => d.on !== false); if (direct) app.control.externalLive(t, true, n, v); app.audio.send({ t: 'note', track: trackId, n, v, on: true, silent: direct }); },
  noteOff(trackId, n) { const t = app.store.track(trackId), direct = t?.kind === 'external' && !t.nfx?.some((d) => d.on !== false); if (direct) app.control.externalLive(t, false, n, 0); app.audio.send({ t: 'note', track: trackId, n, v: 0, on: false, silent: direct }); },
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
    const used = (c) => p.tracks.filter((x) => x.color === c).length;          // the least used colour
    const color = opts.color || [...COLORS].sort((a, b) => used(a) - used(b))[0];
    const t = newTrack(kind, p.tracks.length, { ...opts, scenes: p.scenes.length, color });
    t.name = uniqueName(p, opts.name ? opts.name.slice(0, 16) : t.name);
    if (kind === 'synth' && opts.bank == null) {
      const cat = app.lib.clipper, e = cat.engines.findIndex((x) => x.name === 'HYBRID');
      Object.assign(t, { bank: 'clipper', engine: Math.max(0, e), preset: 0 });
    }
    app.store.change((pp) => pp.tracks.push(t));
    app.view.selTrack = t.id; app.view.selClip = null;
    app.store.emit('select');
    app.arrange.reveal(t.id);
    if (kind === 'drum') app.audition(t.id, [36, 42]); else if (kind === 'synth') app.audition(t.id, [60, 64, 67]);
    toast({ audio: `${t.name}: drop audio files on its lane, or arm it and press R to record.`, sampler: `${t.name}: load a sample in INSTRUMENT, then play it.`,
      external: `${t.name}: choose the MIDI device and channel in INSTRUMENT. Its clips play that device.`, group: `${t.name}: route tracks to it from the mixer (OUT).` }[kind]
      || `${t.name}: new track. ${matchMedia('(pointer: coarse)').matches ? 'Double-tap' : 'Double-click'} its lane to write a clip.`);
    return t;
  },
  // a group (bus) above the selected track, which it now feeds
  addGroup() {
    const p = app.store.p, sel = app.store.track(app.view.selTrack);
    const g = newTrack('group', p.tracks.length, { scenes: p.scenes.length, color: '#9aa0a6', name: uniqueName(p, 'GROUP') });
    app.store.change((pp) => {
      const i = sel ? pp.tracks.findIndex((x) => x.id === sel.id) : pp.tracks.length;
      pp.tracks.splice(Math.max(0, i), 0, g);
      if (sel) { const s2 = pp.tracks.find((x) => x.id === sel.id); g.out = s2.out; s2.out = g.id; }
    });
    app.selectTrack(g.id);
    toast(sel ? `${sel.name} now plays through ${g.name}. Route more tracks to it with OUT in the mixer.` : `${g.name}: route tracks to it with OUT in the mixer.`);
  },
  addReturn() {
    const add = (type, name) => { let k = app.store.p.returns.length + 1; while (app.store.p.returns.some((r) => r.name === `${name} ${k}`)) k++; const n = `${name} ${k}`; app.store.change((p) => { p.returns.push(newReturn(type, n)); }); app.showTab('mixer'); toast(`${n} added: every track has a send to it in the mixer.`); };
    modal('New return track', [h('p', { text: 'A return gets the tracks\' sends. Start it with an effect, or empty for your own rack.' })],
      [['Reverb', () => add('reverb', 'REVERB'), true], ['Delay', () => add('delay', 'DELAY')], ['Empty (rack only)', () => add('none', 'RETURN')], ['Cancel']]);
  },
  importAudio, pickAudio, importMidiFile, openSloopSong, warpClip, detectClipBpm, clipToSampler, flattenComp,
  // comping: take k plays from a to b (beats in the clip); the whole clip when a and b are left out
  compTake(trackId, clipId, k, a = null, b = null, tag) {
    app.store.change((p) => {
      const c = p.tracks.find((x) => x.id === trackId)?.clips.find((x) => x.id === clipId);
      if (!isFolder(c) || !c.takes[k]) return;
      c.comp = setComp(c.comp, a ?? 0, b ?? c.len, k);
    }, tag);
  },
  // a clip onto a track: what it lands on is cut away (it replaces it, as in a recording)
  placeClip(trackId, c) {
    app.store.change((p) => { const tr = p.tracks.find((x) => x.id === trackId); tr.clips = cutRange(tr.clips, c.start, c.start + c.len, p.bpm); tr.clips.push(c); });
  },
  toggleTakes(trackId) {
    const v = app.view; v.takesOpen ??= new Set();
    v.takesOpen.has(trackId) ? v.takesOpen.delete(trackId) : v.takesOpen.add(trackId);
    app.arrange.renderHeads(); app.arrange.redraw(); app.arrange.reveal(trackId, true);
  },
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
      toast(`${t.name} deleted. Undo (↶ or Ctrl+Z) brings it back.`);
    };
    if (!ask) return go();
    const n = t.clips.length, fx = t.fx?.length || 0;
    const what = [n ? `${n} clip${n > 1 ? 's' : ''}` : null, Object.keys(t.auto || {}).length ? 'its automation' : null, fx ? `${fx} effect${fx > 1 ? 's' : ''}` : null].filter(Boolean);
    confirmBox(`Delete ${t.name}?`, `${what.length ? `Its ${what.join(', ')} will be deleted with it. ` : ''}Undo (↶ or Ctrl+Z) brings it back.`, 'Delete track', go, true);
  },
  duplicateTrack(id) {
    const t = app.store.track(id);
    if (!t) return;
    const c = structuredClone(t);
    c.id = uid('t'); c.name = uniqueName(app.store.p, t.name); c.arm = false; c.solo = false;
    for (const cl of [...c.clips, ...(c.slots || []).filter(Boolean)]) cl.id = uid('c');
    // new ids for its effects, note effects and modulators, and every reference to them follows
    const ren = new Map();
    for (const f of [...(c.fx || []), ...(c.nfx || [])]) { const n = uid(f.id[0]); ren.set(f.id, n); f.id = n; }
    for (const m of c.mods || []) { m.id = uid('m'); if (m.src === t.id) m.src = c.id; }
    const rekey = (k) => k.replace(/^(n?fx):([^:]+):/, (all, kind, fid) => (ren.has(fid) ? `${kind}:${ren.get(fid)}:` : all));
    c.auto = Object.fromEntries(Object.entries(c.auto || {}).map(([k, v]) => [rekey(k), v]));
    for (const m of c.mods || []) for (const tg of m.to || []) tg.key = rekey(tg.key);
    for (const f of c.fx || []) if (f.p?.sc === t.id) f.p.sc = '';
    app.store.change((p) => { const i = p.tracks.findIndex((x) => x.id === id); p.tracks.splice(i + 1, 0, c); });
    app.selectTrack(c.id);
    toast(`${c.name}: a copy of ${t.name}.`);
  },
});

// ------------------------------------------------------------- the phone ---
const phone = () => window.matchMedia('(max-width: 700px), (max-height: 520px) and (pointer: coarse)').matches;
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
  $('click').onclick = () => { app.click = !app.click; $('click').classList.toggle('on', app.click); app.audio.send({ t: 'click', on: app.click }); if (phone()) toast(`Metronome ${app.click ? 'on' : 'off'}`); };
  $('pos').onclick = () => { if (phone()) transportSheet(); };
  $('countin').addEventListener('click', () => { if (phone()) setTimeout(() => toast(`Count-in ${app.store.p.countIn ? 'on: one bar of click before recording' : 'off'}`), 0); });
  $('undo').onclick = () => app.store.undo();
  $('learn').onclick = () => app.control.setLearning(!app.control.learning);
  $('redo').onclick = () => app.store.redo();
  $('libbtn').onclick = () => $('app').classList.toggle('no-lib');
  $('mode-arr').onclick = () => app.setMode('arrange');
  $('mode-ses').onclick = () => app.setMode('session');
  const addMenu = $('addmenu');
  popMenu($('addbtn'), addMenu, 'left');
  addMenu.addEventListener('click', (e) => { if (e.target.closest('button')) addMenu.hidden = true; });
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
  bpm.addEventListener('change', () => {
    const v = parseFloat(bpm.value);
    if (!(v > 0)) { bpm.value = String(+app.store.p.bpm.toFixed(2)); return; }   // not a number: back to the tempo
    setBpm(v);
    if (app.store.p.tempo?.length) {                                              // the tempo map has the last word
      app.view.tempoLane = true; app.arrange.renderHeads(); app.arrange.redraw();
      toast('This song has a tempo map: it sets the tempo. Edit it in the TEMPO lane, or CLEAR MAP there.');
    }
  });
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
  popMenu($('filebtn'), menu, 'right');
  menu.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; menu.hidden = true; fileAction(b.dataset.act); };
  $('openfile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (isSloopSong(f)) { await openSloopSong(f); return; }
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
      } else {
        const json = JSON.parse(new TextDecoder().decode(bytes));
        if (json?.format === 'sloop-song') { await openSloopSong(f, json); return; }
        load(validate(json));
      }
      await restoreAssets(app.store.p);
      toast(`${app.store.p.name} opened.`);
    } catch (err) { toast(err.message); }
  };
}

app.load = (p) => load(p);
function load(p) {
  const cur = app.store.p;                                       // the project replaced: an earlier version to go back to
  if (cur.tracks.some((t) => t.clips.length || t.slots?.some(Boolean))) addSnapshot(projectJson(), { name: cur.name, why: `Before opening ${p.name}`, tracks: cur.tracks.length });
  app.fileHandle = null;
  app.audio.send({ t: 'stop' }); app.audio.send({ t: 'panic' });
  app.params.clear();
  app.view.selTrack = p.tracks[0]?.id ?? null; app.view.selClip = null; app.view.autoOpen.clear();
  app.store.replace(p, true);
  app.seek(0);
}

// the project in a file: with audio, one .zip (the project and its files), else a .json. Where the browser lets a page
// write a file it was given (Chrome, Edge on a computer), the first save asks where, the next ones write there
async function saveProjectFile(as, base) {
  const p = { ...app.store.p, savedWith: APP_VERSION };
  const used = usedAssets(p), ids = Object.keys(used);
  const data = ids.length ? zip([{ name: 'project.json', data: JSON.stringify(p, null, 1) }, ...ids.map((id) => ({ name: `assets/${id}.wav`, data: encodeWav([used[id].L, used[id].R], RATE, 24) }))])
    : JSON.stringify(p, null, 1);
  const kind = ids.length ? 'zip' : 'json', name = `${base}.kraken.${kind}`;
  if (window.showSaveFilePicker && !(await hostedSave())) {
    try {
      let fh = !as && app.fileHandle?.kind === kind ? app.fileHandle.h : null;
      if (!fh) fh = await window.showSaveFilePicker({ suggestedName: name, types: [kind === 'zip' ? { description: 'Kraken project with audio', accept: { 'application/zip': ['.zip'] } } : { description: 'Kraken project', accept: { 'application/json': ['.json'] } }] });
      const w = await fh.createWritable();
      await w.write(new Blob([data]));
      await w.close();
      app.fileHandle = { h: fh, kind };
      toast(`Saved to ${fh.name}${as ? '' : '. Ctrl+S saves there again'}.`);
      return;
    } catch (e) { if (e.name === 'AbortError') return; }      // (cancelled; any other trouble: a download instead)
  }
  toast(`Saved ${await saveFile(name, data)}`);
}
// earlier versions of the work: every few minutes, and the project each time another one replaced it
async function recoverDialog() {
  await flushSave();
  const list = await listSnapshots();
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
  const rows = list.length ? list.map((x) => h('button', { class: 'add recover-row', onclick: async () => {
    m.close();
    const json = await getSnapshot(x.t);
    try { const p = validate(JSON.parse(json)); load(p); await restoreAssets(app.store.p); toast(`${p.name} from ${ago(x.t)} is back. Ctrl+Z returns to what you had.`); } catch (e) { toast(e.message); }
  } }, h('b', { text: x.name || 'Untitled' }), h('span', { text: `${ago(x.t)} · ${new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${x.tracks ? ` · ${x.tracks} tracks` : ''}` }), h('em', { text: x.why || '' })))
    : [h('p', { text: 'No earlier version yet: Kraken keeps one every five minutes of work, and each time another project replaces yours.' })];
  const m = modal('Earlier versions', [h('p', { class: 'hint', text: 'Kraken keeps the last 40 in this browser. Opening one keeps what you have now one Ctrl+Z away.' }), h('div', { class: 'recover-list' }, rows)], [['Close', null, true]]);
}

// what this device can do for Kraken, measured
async function checkDialog() {
  const wait = modal('Checking this device…', [h('p', { class: 'hint', text: 'Audio, engine speed, storage, MIDI, export: a few seconds.' })], []);
  await new Promise((r) => setTimeout(r, 50));
  let rows;
  try { rows = await diagnose(app); } finally { wait.close(); }
  const text = diagnosisText(rows);
  const list = h('div', { class: 'diag' }, rows.map((r) => h('div', { class: `diag-row ${r.s}` }, h('i', { text: r.s === 'ok' ? '✓' : r.s === 'warn' ? '!' : '✗' }), h('b', { text: r.k }), h('span', { text: r.v }))));
  const bad = rows.filter((r) => r.s !== 'ok').length;
  modal('This device', [h('p', { class: 'hint', text: bad ? `${bad} thing${bad > 1 ? 's' : ''} to know below.` : 'Everything Kraken needs is here.' }), list],
    [['Copy the report', () => { navigator.clipboard?.writeText(text).then(() => toast('Report copied.'), () => toast('Could not copy: select the text instead.')); }], ['Close', null, true]]);
}

async function fileAction(act) {
  logAct(`project: ${act}`);
  const p = app.store.p, base = (p.name || 'kraken').replace(/[^\w\- ]+/g, '').trim() || 'kraken';
  if (act === 'transport') return transportSheet();
  if (act === 'rename') {
    const inp = h('input', { value: p.name, maxlength: 40, style: { width: '100%' }, 'aria-label': 'Project name' });
    const ok = () => { const v = inp.value.trim().slice(0, 40); if (v) app.store.change((pp) => { pp.name = v; }); };
    modal('Rename the project', [inp], [['Cancel'], ['Rename', ok, true]]);
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { ok(); document.querySelector('.modal-bg')?.remove(); } });
    return;
  }
  try {
    if (act === 'new') confirmBox('New project', 'Start from an empty project? Ctrl+Z (or ↶) brings the current one back.', 'New project', () => {
      const np = newProject(); np.tracks = [newTrack('drum', 0, { kit: app.lib.sloop.kits.indexOf('909') }), newTrack('synth', 1, { bank: 'clipper', engine: app.lib.clipper.engines.findIndex((e) => e.name === 'HYBRID') })];
      load(np);
    });
    else if (act === 'demo') confirmBox('Open the demo song', 'Replace the current project with the demo song? Ctrl+Z (or ↶) brings yours back.', 'Open the demo', () => load(demoProject(app.lib)));
    else if (act === 'open') $('openfile').click();
    else if (act === 'save' || act === 'saveas') await saveProjectFile(act === 'saveas', base);
    else if (act === 'recover') await recoverDialog();
    else if (act === 'check') await checkDialog();
    else if (act === 'starter') welcome(app, { modal });
    else if (act === 'tour') startTour(app);
    else if (act === 'report') await reportDialog(app, { modal, toast });
    else if (act === 'sloop') { const inp = $('sloopfile'); inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) openSloopSong(f); }; inp.click(); }
    else if (act === 'importmidi') { const inp = $('midifile'); inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) importMidiFile(f).catch((e2) => toast(e2.message)); }; inp.click(); }
    else if (act === 'midi') { const name = await saveFile(`${base}.mid`, exportMidi(p), { zipWhenHosted: true }); toast(`Saved ${name}`); }
    else if (act === 'wav' || act === 'stems' || act === 'export') await exportDialog(act === 'stems', base);
    else if (act === 'help') help();
    else if (act === 'install') installApp();
    else if (act === 'palette') app.palette.open();
  } catch (err) {
    if (err?.code === 'declined') return;
    toast(err?.message || String(err));
  }
}

// export: the format, the mix alone or with stems, the whole song or the loop
const FORMATS = [['wav24', 'WAV · 24 bit', 'wav'], ['wav16', 'WAV · 16 bit (CD)', 'wav'], ['flac24', 'FLAC · 24 bit (lossless, smaller)', 'flac'],
  ['flac16', 'FLAC · 16 bit', 'flac'], ['opus', 'OPUS · 192 kbps (small, to share)', 'opus']];
async function exportDialog(stems, base) {
  const p = app.store.p;
  if (!p.tracks.some((t) => t.clips.length)) { toast('Nothing to export yet: add a clip first.'); return; }
  let last = {}; try { last = JSON.parse(localStorage.getItem('kraken.export') || '{}'); } catch { /* storage blocked */ }
  const opusOk = await opusSupported();
  const sel = (label, opts, value) => h('label', { class: 'exp-row' }, h('span', { text: label }),
    h('select', { 'aria-label': label }, opts.map(([v, l, , off]) => h('option', { value: v, selected: v === value ? true : null, disabled: off ? true : null }, l))));
  const fmt = sel('FORMAT', FORMATS.map((f) => (f[0] === 'opus' && !opusOk ? [f[0], `${f[1]}: not in this browser`, f[2], true] : f)), last.format && (last.format !== 'opus' || opusOk) ? last.format : 'wav24');
  const what = sel('WHAT', [['mix', 'The mix'], ['stems', 'The mix and one file a track (stems)']], stems ? 'stems' : 'mix');
  const range = sel('RANGE', [['song', 'The whole song (and its tail)'], ['loop', `The loop: bars ${+(p.loop.a / p.sig + 1).toFixed(2)} to ${+(p.loop.b / p.sig + 1).toFixed(2)}, no tail`]], last.range || 'song');
  modal('Export', [fmt, what, range, h('p', { class: 'ctl-note', text: 'Rendered by the same engines you hear, faster than real time.' })],
    [['Cancel'], ['Export', () => {
      const o = { format: fmt.querySelector('select').value, stems: what.querySelector('select').value === 'stems', range: range.querySelector('select').value };
      try { localStorage.setItem('kraken.export', JSON.stringify({ format: o.format, range: o.range })); } catch { /* storage blocked */ }
      exportAudio(o, base);
    }, true]]);
}
async function exportAudio({ format = 'wav24', stems = false, range = 'song' } = {}, base) {
  const p = structuredClone(app.store.p);
  const bar = h('div', { class: 'progress' }, h('i'));
  const msg = h('p', { text: 'Rendering the mix with the same engines you hear…' });
  const box = modal('Export', [msg, bar], []);
  const step = (i, n, what) => { bar.style.setProperty('--v', (i / n).toFixed(3)); msg.textContent = `Rendering ${what} (${i + 1}/${n})…`; };
  const ext = FORMATS.find((f) => f[0] === format)?.[2] || 'wav';
  const encode = async (L, R) => {
    if (format === 'wav16' || format === 'wav24') return encodeWav([L, R], RATE, format === 'wav16' ? 16 : 24, format === 'wav16');
    if (format === 'flac16' || format === 'flac24') return encodeFlac([L, R], RATE, format === 'flac16' ? 16 : 24, format === 'flac16');
    return encodeOpus(L, R, RATE, 192000);
  };
  try {
    const t0 = performance.now();
    const jobs = [{ name: 'MIX', solo: null }, ...(stems ? p.tracks.map((t, i) => ({ name: `${String(i + 1).padStart(2, '0')} ${t.name}`, solo: t.id })) : [])];
    const span = range === 'loop' ? { start: p.loop.a, end: p.loop.b, tail: 0 } : {};
    const files = [];
    for (let i = 0; i < jobs.length; i++) {
      step(i, jobs.length, jobs[i].name);
      const [L, R] = await app.audio.render(p, { soloTrack: jobs[i].solo, assets: usedAssets(p), ...span });
      msg.textContent = `Encoding ${jobs[i].name} (${ext.toUpperCase()})…`;
      await new Promise((r) => setTimeout(r, 0));
      files.push({ name: `${base} - ${jobs[i].name}.${ext}`, data: await encode(L, R) });
    }
    bar.style.setProperty('--v', 1);
    msg.textContent = `Rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s. Saving…`;
    const name = stems ? await saveFile(`${base} - stems.zip`, zip(files)) : await saveFile(files[0].name, files[0].data, { zipWhenHosted: true });
    box.close();
    toast(`Saved ${name}`);
    return files;
  } catch (err) {
    box.close();
    if (err?.code !== 'declined') toast(`Export failed: ${err?.message || err}`);
  }
}
app.exportAudio = exportAudio;

// ------------------------------------------------------------- dialogs ---
// a drop-down menu, laid over everything (never clipped by a panel), kept on screen
function popMenu(btn, list, align) {
  const place = () => {
    const r = btn.getBoundingClientRect(), w = list.offsetWidth, vw = window.innerWidth;
    const left = align === 'right' ? r.right - w : r.left;
    list.style.left = `${Math.max(8, Math.min(vw - w - 8, left))}px`;
    list.style.top = `${r.bottom + 6}px`;
    list.style.maxHeight = `${window.innerHeight - r.bottom - 16}px`;
  };
  list.classList.add('pop');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const m of document.querySelectorAll('.menu-list.pop')) if (m !== list) m.hidden = true;
    list.hidden = !list.hidden;
    if (!list.hidden) place();
  });
  document.addEventListener('pointerdown', (e) => { if (!list.hidden && !list.contains(e.target) && !btn.contains(e.target)) list.hidden = true; });
  window.addEventListener('resize', () => { list.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.hidden = true; });
}

function modal(title, body, buttons) {
  const bg = h('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h3', { text: title }), ...body,
    buttons.length ? h('div', { class: 'row' }, buttons.map(([label, fn, go]) => h('button', { class: 'add' + (go ? ' go' : ''), onclick: () => { close(); fn?.(); } }, label))) : null);
  bg.append(box);
  $('toast').hidden = true;                                      // no message over a dialog
  bg.addEventListener('pointerdown', (e) => { if (e.target === bg && buttons.length) close(); });
  bg.addEventListener('keydown', (e) => { e.stopPropagation(); });
  const esc = (e) => { if (e.key === 'Escape' && bg.isConnected && document.querySelector('.modal-bg:last-of-type') === bg) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  new MutationObserver((_m, o) => { if (!bg.isConnected) { document.removeEventListener('keydown', esc, true); o.disconnect(); } }).observe(document.body, { childList: true });
  document.body.append(bg);
  box.querySelector('.go')?.focus({ preventScroll: true });
  return { close, box };
}
// a menu of big buttons (a long press on a phone): [label, fn, 'danger'?]
// the transport keys a phone has no room for: a tap on the position shows them
function transportSheet() {
  const p = app.store.p, on = (x) => (x ? 'ON' : 'OFF');
  sheet('Transport & grid', [
    [`METRONOME · ${on(app.click)}`, () => $('click').click()],
    [`COUNT-IN · ${on(p.countIn)}`, () => $('countin').click()],
    [`PUNCH IN / OUT · ${on(p.punch?.on)}`, () => app.togglePunch()],
    ['BACK TO START', () => $('home').click()],
    ['REDO', () => app.store.redo()],
    [`GRID · ${$('snap').selectedOptions[0]?.text}`, () => { const s = $('snap'); s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event('change')); toast(`Grid: ${s.selectedOptions[0].text}`); }],
    [`SWING · ${$('swing').selectedOptions[0]?.text}`, () => { const s = $('swing'); s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event('change')); toast(`Swing: ${s.selectedOptions[0].text}`); }],
  ]);
}
app.transportSheet = transportSheet;
function sheet(title, items) {
  let m = null, armed = false;
  const box = h('div', { class: 'sheet', onpointerdown: () => { armed = true; } },
    items.map(([label, fn, kind]) => h('button', { class: 'add' + (kind ? ' ' + kind : ''), onclick: () => { if (!armed) return; m.close(); fn(); } }, label)));
  m = modal(title, [box], [['Cancel']]);
  const cancel = document.querySelector('.modal-bg:last-child .row .add');
  if (cancel) { cancel.addEventListener('pointerdown', () => { armed = true; }); cancel.addEventListener('click', (e) => { if (!armed) e.stopImmediatePropagation(); }, true); }
  return m;
}
// a name not yet taken: DRUMS, DRUMS 2…
function uniqueName(p, name) {
  const names = new Set(p.tracks.map((t) => t.name));
  if (!names.has(name)) return name;
  const base = name.replace(/ \d+$/, '');
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.slice(0, 16))) return `${base} ${i}`.slice(0, 16);
}
app.renameTrack = (id) => {
  const t = app.store.track(id); if (!t) return;
  const inp = h('input', { value: t.name, maxlength: 24, style: { width: '100%' }, 'aria-label': 'Track name' });
  const ok = () => { const v = inp.value.trim().toUpperCase().slice(0, 24); if (v && v !== t.name) app.store.change((p) => { p.tracks.find((x) => x.id === id).name = v; }); };
  modal('Rename track', [inp], [['Cancel'], ['Rename', ok, true]]);
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { ok(); document.querySelector('.modal-bg')?.remove(); } });
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
};
app.sheet = sheet;
function confirmBox(title, text, ok, fn, danger = false) { const m = modal(title, [h('p', { text })], [['Cancel'], [ok, fn, true]]); if (danger) document.querySelector('.modal .go')?.classList.add('danger'); return m; }
app.confirm = confirmBox;
function help() {
  const touch = matchMedia('(pointer: coarse)').matches;
  const TOUCH = [
    ['Tracks', 'One finger: scroll · two fingers: zoom · double-tap a lane: a new clip · double-tap a clip: edit it'],
    ['Hold a clip', 'It lifts: drag it to move it (its end: resize), or let go for its menu (open, duplicate, delete)'],
    ['Hold a track', 'Its menu: sound, rename, automation, duplicate, delete'],
    ['☰ menu', 'Earlier versions of your song · Check this device · Report a problem · Show me around'],
    ['Ruler', 'Top band: the LOOP · middle band: PUNCH · numbers: the playhead. Drag a zone\'s ends or middle, tap it on / off · double-tap the numbers: a marker'],
    ['Clip editor', 'Tap: a note or a hit · drag: move / length · double-tap a note: remove · two fingers: scroll · TOOL: SELECT, ACCENT, CHANCE, RATCHET'],
    ['The screen', 'Tap the position for the metronome, count-in, punch, back to start, redo, grid and swing'],
    ['Live (session)', 'Tap a clip: launch · double-tap an empty slot: a new clip · hold a slot: its menu · ■: stop'],
    ['Modulators', 'SOUND tab: MAP, then tap any knob of the track'],
  ];
  const KEYS = [
    ['Space', 'Play / stop'], ['R', 'Record into the armed (or selected) track'], ['L', 'Loop on / off'], ['M', 'Metronome'], ['Home', 'Back to start'],
    ['A W S E D F T G Y H U J K O', 'Play notes · Z / X octave · C / V velocity'], ['[ ]', 'Previous / next sound'],
    ['Ctrl Z · Ctrl Shift Z', 'Undo · redo'], ['Ctrl C · Ctrl V · Ctrl D', 'Copy, paste at the playhead, duplicate a clip'],
    ['Delete', 'The selected notes (in the editor) · the selected clip, or track (in the arrangement)'], ['Ctrl wheel', 'Zoom · Shift wheel: scroll sideways'],
    ['Arrangement', 'Drag on a lane: new clip · drag a clip: move (onto another clip: it cuts it) · its end: resize · Alt-drag: copy · right-click: its menu'],
    ['Track heads', 'Drag a head up or down: reorder · double-click the name: rename · right-click: its menu'],
    ['Piano roll', 'Click: note · drag: length · Shift-drag or TOOL SELECT: select · double-click: remove · ↑ ↓ transpose · Q quantize'],
    ['Ruler', 'Top band: the LOOP · middle band: PUNCH in / out · numbers: the playhead. Drag a zone\'s ends or middle, click it on / off'],
    ['N · , · .', 'A marker at the playhead · previous / next marker (double-click the ruler\'s numbers too)'],
    ['Tab', 'Arrangement / session · in the session: click a clip to launch it, ▶ a scene, ■ to stop'],
    ['Esc', 'All notes off, deselect'],
    ['Ctrl K', 'Command palette: every action, track, sound, kit, effect and marker'],
    ['Ctrl S · Ctrl Shift S', 'Save to a file (Chrome, Edge: the same file again) · save as. Kraken also saves by itself'],
    ['PROJECT menu', 'Earlier versions (your work every 5 minutes) · Check this device · Report a problem · Show me around'],
    ['Ctrl L · LEARN', 'MIDI Learn: click any knob, fader, button or action, then move a control (or press a key)'],
    ['Drop files', 'A .mid: tracks · a .sloopsong: the SLOOP song · audio files: audio clips'],
    ['Clip editor', 'The strip above the notes: drag the white handle for the clip length, the orange one for the loop'],
    ['Sound tab', 'NOTE FX before the sound · MODULATORS: pick a target or MAP and click a knob · EFFECTS after it'],
    ['Takes', 'Record over audio: each pass is a take. The TAKES badge opens the lanes: click or swipe a take to comp it'],
  ];
  const grid = (title, rows) => [h('h4', { style: { margin: '6px 0 0', font: '700 9px/1 var(--f-ui)', letterSpacing: '0.16em', color: 'var(--dim)' }, text: title }),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(70px, auto) 1fr', gap: '6px 14px', font: '500 11px/1.4 var(--f-ui)' } },
      rows.flatMap(([k, v]) => [h('span', { style: { font: '500 10px/1.4 var(--f-mono)', color: 'var(--accent)' }, text: k }), h('span', { text: v })]))];
  const hm = modal('Help', touch ? [...grid('FINGERS', TOUCH), ...grid('KEYBOARD & MOUSE', KEYS)] : [...grid('KEYBOARD & MOUSE', KEYS), ...grid('FINGERS (PHONE, TABLET)', TOUCH)], [['Close', null, true]]);
  hm.box.style.width = 'min(640px, 100%)';
}
let toastTimer = 0;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false; toast.at = performance.now();
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, Math.min(7000, Math.max(2600, text.length * 50)));
}
// the next touch or click anywhere puts a message away (it never takes the touch itself)
document.addEventListener('pointerdown', () => { const t = $('toast'); if (!t.hidden && performance.now() - (toast.at || 0) > 400) t.hidden = true; }, true);
app.toast = toast;

// -------------------------------------------------------------- keys ---
let clipboard = null;
function bindKeys() {
  // a list or a button keeps no focus after use: Space, Delete and the piano keys go back to the music
  document.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' && !e.target.closest('.modal')) e.target.blur(); });
  document.addEventListener('click', (e) => { const b = e.target.closest?.('button'); if (b && e.detail > 0 && !b.closest('.modal')) b.blur(); });
  // where the last click was: the arrangement / session, or the editors below (Delete acts there)
  document.addEventListener('pointerdown', (e) => { app.lastArea = e.target.closest?.('#bot') ? 'bot' : e.target.closest?.('#arr') ? 'arr' : app.lastArea; }, true);
  window.addEventListener('keydown', (e) => {
    if (typing(e) || document.querySelector('.modal-bg')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), v = app.view, p = app.store.p;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? app.store.redo() : app.store.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); app.store.redo(); return; }
    if (mod && k === 's') { e.preventDefault(); fileAction(e.shiftKey ? 'saveas' : 'save'); return; }
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
      if ((clipboard.kind === 'audio') !== (t.kind === 'audio') || (clipboard.kind === 'drum') !== (t.kind === 'drum') || t.kind === 'group') { toast(`That clip belongs on ${clipboard.kind === 'audio' ? 'an audio' : clipboard.kind === 'drum' ? 'a drum' : 'an instrument'} track.`); return; }
      const c = { ...structuredClone(clipboard.clip), id: uid('c'), start: Math.floor(app.pos / p.sig) * p.sig };
      app.placeClip(t.id, c); app.selectClip(c.id, t.id); return;
    }
    if (mod && k === 'd' && clip) {
      e.preventDefault();
      const c = { ...structuredClone(clip), id: uid('c'), start: clip.start + clip.len };
      app.placeClip(t.id, c); app.selectClip(c.id, t.id); return;
    }
    if (mod) return;
    if (e.key === 'Tab') { e.preventDefault(); app.setMode(v.mode === 'session' ? 'arrange' : 'session'); return; }
    if (e.code === 'Space') { e.preventDefault(); app.play(); }
    else if (k === 'r' && !e.repeat) app.setRecord(!app.recording);
    else if (k === 'l') $('loop').click();
    else if (k === 'm') $('click').click();
    else if (k === 'b') $('libbtn').click();
    else if (k === 'n' && !e.repeat) app.addMarker();
    else if (e.key === ',') app.gotoMarker(-1);
    else if (e.key === '.') app.gotoMarker(1);
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); $('home').click(); }
    else if (e.key === 'Escape') { app.audio.send({ t: 'panic' }); app.editor.sel.clear(); if (app.lastArea !== 'bot') app.selectClip(null); else app.editor.canvas.redraw(); }
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
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.lastArea === 'bot') {
      e.preventDefault();                                        // in the editors: the selected notes, never the clip or the track
      if (v.tab === 'edit') app.editor.deleteSelected();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && t && t.slots?.some((c) => c && c.id === v.selClip)) {
      e.preventDefault();                                        // a session clip: out of its slot
      app.store.change((pp) => { const tr = pp.tracks.find((x) => x.id === t.id); tr.slots = tr.slots.map((c) => (c && c.id === v.selClip ? null : c)); });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !clip && t) {
      e.preventDefault();
      app.deleteTrack(t.id);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && clip) {
      e.preventDefault();
      app.store.change((pp) => { const tr = pp.tracks.find((x) => x.id === t.id); tr.clips = tr.clips.filter((c) => c.id !== clip.id); });
    }
  });
}

// the bottom panel's height: drag its top edge (double-click: back to 300 px); remembered on this device
function bindResize() {
  const r = $('resize'), KEY = 'kraken.bottom-h';
  const apply = (px) => { $('app').style.setProperty('--bottom-h', `${px}px`); app.arrange?.redraw(); app.editor?.canvas.redraw(); };
  let saved = 0;
  try { saved = +localStorage.getItem(KEY); } catch { /* storage blocked */ }
  if (saved >= 140) apply(Math.min(saved, window.innerHeight - 220));
  else if (window.innerHeight > 1000) apply(Math.round(Math.min(560, window.innerHeight * 0.42)));   // a tall screen (a tablet upright): a taller editor
  r.addEventListener('pointerdown', (e) => {
    const y0 = e.clientY, h0 = $('bot').getBoundingClientRect().height;
    r.setPointerCapture(e.pointerId);
    let last = h0;
    const mv = (m) => { last = Math.max(140, Math.min(window.innerHeight - 220, h0 + y0 - m.clientY)); apply(last); };
    const up = () => { r.removeEventListener('pointermove', mv); r.removeEventListener('pointerup', up); try { localStorage.setItem(KEY, String(Math.round(last))); } catch { /* storage blocked */ } };
    r.addEventListener('pointermove', mv); r.addEventListener('pointerup', up);
  });
  r.addEventListener('dblclick', () => { apply(300); try { localStorage.removeItem(KEY); } catch { /* storage blocked */ } });
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
    else if (isSloopSong(f)) await openSloopSong(f);
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
