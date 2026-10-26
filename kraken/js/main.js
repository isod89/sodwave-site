// SPDX-License-Identifier: GPL-3.0-only
// Kraken: a free DAW in the browser, with the SLOOP and Clipper engines of the M-VAVE FM-1 firmwares.
import { loadEngines, Audio } from './audio.js';
import { Store, demoProject, newProject, newTrack, newClip, newAudioClip, newReturn, validate, uid, COLORS, cutRange, APP_VERSION, trackSources, envAt } from './project.js';
import { peaks, decode, storeAsset, loadAsset, detectBpm, stretch } from './assets.js';
import { autosaves, writeAutosave, emergencySave, addSnapshot, listSnapshots, getSnapshot, claimAutosave, askPersist, storageInfo } from './vault.js';
import { encodeWav } from './wav.js';
import { encodeFlac } from './flac.js';
import { encodeOpus, opusSupported } from './opus.js';
import { encodeMp3Off, mp3Rate } from './mp3.js';
import { genSound } from './gensounds.js';
import { isFolder, addTake, renderFolder, setComp, isMidiFolder, compNotes, addMidiTake, expandFolder } from './comp.js';
import { split, join, copyRange, pasteRange, clearRange, deleteTime, insertTime, moveClips, reversed } from './edit.js';
import { saveFile, zip, unzip, exportMidi, parseMidi, hostedSave } from './io.js';
import { importSloopSong, presetDefaults } from './sloopsong.js';
import { exportDawproject, importDawproject } from './dawproject.js';
import { stretchWarp, detectTransients, beatAt, autoMarkers, cleanMarkers } from './warp.js';
import { meterList, barOf, barStart, floorBar, posLabel, barLabel, DENOMS } from './meter.js';
import { RATE, crossfaded } from './engine-core.js';
import { h } from './ui/kit.js';
import { Arrange } from './ui/arrange.js';
import { Editor } from './ui/editor.js';
import { Device } from './ui/device.js';
import { Mixer } from './ui/mixer.js';
import { Library } from './ui/library.js';
import { resample } from './resample.js';
import { Samples } from './ui/samples.js';
import { saveTemplate, managePresets, newTrackFromPreset } from './ui/presets.js';
import { AutoRec } from './ui/autorec.js';
import { Collab } from './collab.js';
import { collabDialog, collabMarks } from './ui/collab.js';
import { WamLive } from './wam-host.js';
import { wamDialog } from './ui/wam.js';
import { zonesFromNames } from './sampler.js';
import { Input, typing } from './input.js';
import { Control } from './control.js';
import { Controllers } from './ui/controllers.js';
import { Session } from './ui/session.js';
import { Palette } from './ui/palette.js';
import { Keys } from './ui/keys.js';
import { diagnose, diagnosisText } from './ui/diagnostic.js';
import { MultiCore, mcMode, mcSupported } from './multicore.js';
import { reportDialog } from './ui/report.js';
import { welcome, startTour } from './ui/welcome.js';
import { initI18n, toggleLang } from './i18n.js';
import { openLab, installLab, labPicker, labStart, labOpenPatch } from './ui/lab.js';
import { setLabEngines } from './lab-dsp.js';
import { initHub } from './ui/hub.js';                       // the community hub (ui/hub.js, hub.js, hub/api)

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
  if (/ResizeObserver loop/.test(String(msg))) return;           // (a browser notice that a layout settled a frame later: harmless)
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
    setLabEngines(modules);                                       // (the LAB's ENGINE module, in the editor: its test note, its settings)
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
    // multi-core playback: helper threads play ahead the tracks that need not react at once (multicore.js)
    app.mc = app.audio.mc = new MultiCore(app.audio, { stopped: () => !app.playing && !app.recording, toast: (m) => app.toast(m) });
    app.mc.onChange = () => cpuTitle();
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
  app.samples = new Samples(app);
  app.autorec = new AutoRec(app);
  app.collab = new Collab(app);
  app.collab.onChange = () => collabMarks(app);
  app.store.on(() => { if (app.collab.live) setTimeout(() => collabMarks(app), 0); });
  app.library = new Library(app);
  app.control = new Control(app);
  app.input = new Input(app);
  app.controllers = new Controllers(app, $('v-ctl'));
  app.control.start();
  // plugins (WAM): made, kept in step with the project, routed into the engine
  app.wam = new WamLive(app);
  app.wamChanged = () => app.device.refresh(true);
  app.audio.onWarn = (msg) => toast(msg);
  app.store.on((p) => app.wam.sync(p));
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
  const hubLink = initHub(app);                                  // (opened by a hub link, /?hub=ID or /?hub_login=…: the hub first)
  // /?lab (sodwave.com/lab, the hub's page): straight into the LAB's front door
  const q0 = new URLSearchParams(location.search), labLink = !hubLink && q0.has('lab');
  if (labLink) {
    q0.delete('lab');
    try { history.replaceState(null, '', location.pathname + (q0.size ? `?${q0}` : '') + location.hash); } catch { /* */ }
    setTimeout(() => labStart(app), 120);
  }
  // the first visit: the welcome (not under automation: the test suites start from the demo song)
  if (!project && !welcomed && !hubLink && !labLink && !app.pendingFiles?.length && !navigator.webdriver) { welcome(app, { modal, first: true }); return; }
  if (hubLink || labLink) { if (app.pendingFiles?.length) openPending(); return; }
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
  syncMonitor();
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
  $('takesbtn').classList.toggle('on', p.recTakes !== false);
  if ($('swing') !== document.activeElement) $('swing').value = String(p.swing || 0);
  $('undo').disabled = !app.store.past.length; $('redo').disabled = !app.store.future.length;
  const clip = t?.clips.find((c) => c.id === v.selClip);
  $('tab-info').replaceChildren(...(t ? [h('span', { class: 'dot', '--c': t.color }), `${t.name}${clip ? ' · ' + clip.name : ''}`] : []));
  if (why === 'load' || why === 'history') app.arrange.redraw();
}

// ------------------------------------------------------------ monitoring ---
// the armed audio tracks: their input channels, metered, and heard through the track (MONITOR AUTO or IN)
let monitorSig = '';
function syncMonitor() {
  if (!app.audio?.input) { if (monitorSig) { monitorSig = ''; app.audio?.send({ t: 'monitor', tracks: [] }); } return; }
  const list = app.store.p.tracks.filter((t) => t.kind === 'audio' && (t.arm || t.monitor === 'in')).map((t) => ({ id: t.id, a: t.input?.a ?? 0, b: t.input?.b === undefined ? 1 : t.input.b, listen: t.monitor !== 'off' }));
  const sig = JSON.stringify(list);
  if (sig !== monitorSig) {
    monitorSig = sig; app.audio.send({ t: 'monitor', tracks: list });
    if (list.some((x) => x.listen) && !syncMonitor.told) { syncMonitor.told = true; toast('You hear the input through the armed track. With speakers and a built-in mic: headphones, or MONITOR OFF (the track\'s INSTRUMENT tab), to avoid feedback.'); }
  }
}
app.syncMonitor = () => { monitorSig = ''; syncMonitor(); };

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
function resyncAll() { sync.top = ''; sync.tracks.clear(); for (const [id, a] of app.assets) app.audio.send({ t: 'asset', id, L: a.L, R: a.R }); syncEngine(true); app.wam?.restart(); }
app.restartAudioQuiet = () => resyncAll();
app.restartAudio = () => { app.audio.restart(); resyncAll(); app.playing = false; $('play').classList.remove('on'); toast('Audio engine restarted.'); };

// the CPU readout's tooltip: what it means, and how many cores play
function cpuTitle() {
  const cell = $('cpu-cell');
  if (!cell) return;
  cell.dataset.title ||= cell.title;
  cell.title = app.mc ? `${cell.dataset.title}\n${app.mc.describe()}` : cell.dataset.title;
}
function onAudio(m) {
  if (m.t === 'tick') {
    if (m.inputs) for (const id in m.inputs) { const x = m.inputs[id], tr = (m.tracks ||= {})[id] || [0, 0]; m.tracks[id] = [Math.max(tr[0], x), Math.max(tr[1], x)]; }   // (an armed track: its input level)
    if ((m.seq ?? 0) < (app.seekSeq || 0) && performance.now() - app.seekAt < 500) return;   // sent before our last seek reached the engine
    app.pos = m.pos;
    if (app.playing !== m.playing) { app.playing = m.playing; $('play').classList.toggle('on', m.playing); app.control.feedbackSoon(); }
    if (app.playing && app.view.follow) app.arrange.follow(m.pos);
    if (app.autorec.mode !== 'read') app.autorec.tick(m.pos);
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
    cpuTitle();
    cell.classList.toggle('hot', v >= 80);
    if (v >= 90 && app.playing && performance.now() - (onAudio.hotAt || -1e9) > 120000) {
      onAudio.hotAt = performance.now();
      toast(`The audio engine is at ${v} %: it may crackle. Freeze a heavy track (INSTRUMENT tab > FREEZE TRACK) or remove effects to lighten it.`);
    }
  } else if (m.t === 'params') {
    app.params.set(m.track, m.values);
    if (m.track === app.view.selTrack) app.device.refresh(true);
  } else if (m.t === 'recctl') {
    recordCtl(m.track, m.ev);
  } else if (m.t === 'rec') {
    if (m.slot != null) recordSlotNote(m.track, m.slot, m.note); else recordNote(m.track, m.note);
  } else if (m.t === 'slot') {
    for (const ev of m.ev) sessionToArrangement(ev);
  } else if (m.t === 'ext') {
    app.control.external(m.ev);
  } else if (m.t === 'cap') {
    app.takes ||= new Map();
    const k = m.track || app.takeTrack;
    if (!app.takes.has(k)) app.takes.set(k, []);
    app.takes.get(k).push([m.L, m.R]);
  } else if (m.t === 'capEnd') {
    finishTake(m.start, m.track || app.takeTrack);
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
  const p = app.store.p, pos = app.pos + 1e-6;
  if (pos < 0) { $('pos').textContent = `COUNT ${Math.ceil(-pos)}`; return; }
  $('pos').textContent = posLabel(p, app.pos);
  const b = barOf(p, pos), sg = `${b.n}/${b.d}`;
  if ($('sig').textContent !== sg) $('sig').textContent = sg;
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
// a controller played while recording (sustain, wheels, pressure): a point in the clip's lane there
function recordCtl(trackId, ev) {
  const t = app.store.track(trackId); if (!t || t.kind === 'audio' || (t.kind === 'group' || t.kind === 'vca')) return;
  const key = ev.st === 0xe0 ? 'pb' : ev.st === 0xd0 ? 'cp' : `cc:${ev.d1}`;
  const v = ev.st === 0xe0 ? ((ev.d2 << 7) | ev.d1) - 8192 : ev.st === 0xd0 ? ev.d1 : ev.d2;
  app.store.change((p) => {
    const tr = p.tracks.find((x) => x.id === trackId);
    let clip = tr.clips.find((c) => ev.t >= c.start - 1e-6 && ev.t < c.start + c.len);
    if (!clip) {
      const inLoop = p.loop.on && ev.t >= p.loop.a && ev.t < p.loop.b, b = barOf(p, ev.t);
      const start = inLoop ? p.loop.a : b.start;
      clip = newClip(start, inLoop ? p.loop.b - p.loop.a : barStart(p, b.bar + 4) - b.start, 'TAKE');
      tr.clips.push(clip);
    }
    const loop = clip.loop || clip.len, local = ((ev.t - clip.start) % loop + loop) % loop;
    clip.ctl ||= {};
    const pts = (clip.ctl[key] ||= []);
    const near = pts.findIndex((q) => Math.abs(q.t - local) < 1 / 96);   // (a dense stream: one point per 1/96 beat)
    if (near >= 0) pts[near].v = v; else { pts.push({ t: local, v }); pts.sort((a, b) => a.t - b.t); }
  }, 'rec');
}
function recordNote(trackId, n) {
  const t = app.store.track(trackId); if (!t) return;
  app.store.change((p) => {
    const tr = p.tracks.find((x) => x.id === trackId);
    let clip = tr.clips.find((c) => n.t >= c.start - 1e-6 && n.t < c.start + c.len);
    if (!clip) {
      const inLoop = p.loop.on && n.t >= p.loop.a && n.t < p.loop.b, b = barOf(p, n.t);
      const start = inLoop ? p.loop.a : b.start;
      clip = newClip(start, inLoop ? p.loop.b - p.loop.a : barStart(p, b.bar + 4) - b.start, 'TAKE');
      tr.clips.push(clip);
      app.view.selClip = clip.id;
    }
    const loop = clip.loop || clip.len;
    const local = ((n.t - clip.start) % loop + loop) % loop;
    const g = app.view.snap && app.recQuantize ? app.view.snap : 0;
    const note = { t: g ? Math.round(local / g) * g % loop : local, d: Math.min(n.d, loop), n: n.n, v: n.v };
    // looping, TAKES on (not on a drum track: its patterns build up): each pass a take of its own, to comp afterwards
    if (p.recTakes !== false && tr.kind !== 'drum' && p.loop.on && n.pass != null) {
      const key = `${clip.id}:${app.recSession}:${n.pass}`;
      let k = app.recTakes?.get(key);
      if (k == null || !clip.mtakes?.[k]) {
        let a = Math.max(0, p.loop.a - clip.start), b = Math.min(loop, p.loop.b - clip.start);
        if (!(b > a)) { a = 0; b = loop; }
        k = addMidiTake(clip, a, b);
        (app.recTakes ||= new Map()).set(key, k);
      }
      clip.mtakes[k].notes.push(note);
      clip.notes = compNotes(clip);
    } else clip.notes.push(note);
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
// audio files by id into this session (from this browser's storage), for presets and templates: -> how many are missing
app.ensureAssets = async (ids, quiet = false) => {
  let missing = 0;
  for (const id of ids) {
    if (app.assets.has(id)) continue;
    const a = await loadAsset(id);
    if (a?.L && a.R) addAsset(id, a, false); else missing++;
  }
  if (missing && !quiet) toast(missingText(missing));
  return missing;
};
// WAV files that come with presets: kept under their ids (one already here stays)
app.addAssetFiles = async (files) => {
  for (const f of files) {
    if (app.assets.has(f.id) || (await loadAsset(f.id))) continue;
    try { addAsset(f.id, { ...(await decode(app.audio.ctx, f.data.slice().buffer)), name: f.id }); } catch { /* not audio: skipped */ }
  }
};
app.addAudio = (id, a) => addAsset(id, a);
// LAB: open the editor (target: { track } or { track | bus, fx }); a patch from the hub or a file, kept and used
app.openLab = (target) => openLab(app, target);
app.installLab = (patch, meta) => installLab(app, patch, meta);
app.labStart = () => labStart(app);                              // (the LAB's front door: top bar, PROJECT, Ctrl+K, the hub)
app.labOpenPatch = (patch, meta) => labOpenPatch(app, patch, meta);
// the LAB patches of this project (its LAB tracks and LAB effects), for the hub's "Publish… > A LAB plugin"
app.hubLabs = async () => {
  const p = app.store.p, out = [];
  for (const t of p.tracks) { if (t.kind === 'lab' && t.lab) out.push({ name: t.lab.name, lab: t.lab }); for (const d of t.fx || []) if (d.type === 'lab' && d.lab) out.push({ name: d.lab.name, lab: d.lab }); }
  for (const d of [...p.master.fx, ...p.returns.flatMap((r) => r.fx)]) if (d.type === 'lab' && d.lab) out.push({ name: d.lab.name, lab: d.lab });
  return out;
};
app.restoreAssets = (p) => restoreAssets(p);
async function restoreAssets(p) {
  let missing = 0;
  for (const id of Object.keys(p.assets || {})) {
    if (app.assets.has(id)) { app.audio.send({ t: 'asset', id, L: app.assets.get(id).L, R: app.assets.get(id).R }); continue; }
    const a = await loadAsset(id);
    if (a?.L && a.R) addAsset(id, a, false); else if (genSound(id)) addAsset(id, genSound(id), false); else missing++;   // (a sound Kraken makes: made again)
  }
  if (missing) toast(missingText(missing));
  return missing;
}
const missingText = (n) => `${n} audio file${n > 1 ? 's are' : ' is'} missing from this browser. Open the project's .zip to bring them back.`;
function usedAssets(p) {
  const out = {};
  const use = (id) => { const a = id && app.assets.get(id); if (a) out[id] = { L: a.L, R: a.R }; };
  for (const t of p.tracks) for (const id of trackSources(t)) use(id);
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
    if (fresh) { p.bpm = Math.max(40, Math.min(240, m.bpm)); if (m.tempo?.length) p.tempo = m.tempo.map((q) => ({ t: q.t + beat, v: Math.max(20, Math.min(300, q.v)) })); if (m.meters?.length) { p.meters = m.meters.filter((x) => [1, 2, 4, 8, 16].includes(x.d)); p.sig = meterList(p)[0].len; } }
    for (const mt of m.tracks) {
      const drum = mt.ch === 9;
      const snd = drum ? null : app.lib.sounds.find((s) => s.kind === KIND(mt.program)) || app.lib.sounds[0];
      const t = newTrack(drum ? 'drum' : 'synth', p.tracks.length, { name: mt.name.toUpperCase().slice(0, 16), color: COLORS[p.tracks.length % COLORS.length],
        ...(drum ? { kit: app.lib.sloop.kits.indexOf('ACOUSTIC') } : { bank: snd.bank, engine: snd.engine, preset: snd.preset }) });
      const end = Math.max(...mt.notes.map((n) => n.t + n.d));
      const len = Math.max(p.sig, Math.ceil(end / p.sig) * p.sig);
      const c = newClip(beat, len, mt.name.toUpperCase().slice(0, 18) || 'MIDI');
      c.notes = mt.notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v }));
      if (mt.ctl) { c.ctl = {}; for (const k in mt.ctl) c.ctl[k] = mt.ctl[k].map((q) => ({ t: q.t, v: q.v })); }   // (sustain, wheels, bend, pressure)
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

// a DAWproject (Bitwig, Studio One, Cubase, Reaper with the extension…): a project of its own, its audio decoded
async function openDawproject(entries) {
  let r;
  try { r = importDawproject(entries, { lib: app.lib }); } catch (e) { toast(e.message); return; }
  const p = r.project, warnings = [...r.warnings];
  const go = async () => {
    for (const m of r.media) {
      try {
        const a = await decode(app.audio.ctx, m.bytes.slice().buffer), name = m.path.split('/').pop();
        addAsset(m.id, { ...a, name });
        p.assets[m.id] ||= { name, frames: a.L.length };
      } catch { warnings.push(`${m.path}: this audio could not be read.`); }
    }
    load(p);
    await restoreAssets(app.store.p);
    for (const w of r.warp) warpClip(w.track, w.clip, 'stretch', { bpm: w.bpm, ...(w.markers ? { markers: w.markers, keepLen: true } : {}) });
    toast(`${p.name}: ${p.tracks.length} tracks${r.kraken ? ', as it was in Kraken' : ''}.${warnings.length ? ' ' + warnings.slice(0, 3).join(' ') + (warnings.length > 3 ? ` (+${warnings.length - 3} more)` : '') : ''}`);
  };
  if (app.store.p.tracks.some((t) => t.clips.length || t.slots?.some(Boolean))) confirmBox('Open the DAWproject', `Open "${p.name}" in place of the current project? Ctrl+Z (or ↶) brings yours back.`, 'Open it', go);
  else await go();
}
app.openDawproject = openDawproject;

// ------------------------------------------------------------------ warp ---
const findClip = (p, trackId, clipId) => { const t = p.tracks.find((x) => x.id === trackId); return t?.clips.find((c) => c.id === clipId) || t?.slots?.find((c) => c && c.id === clipId); };
// OFF: as recorded · RE-PITCH: follows the tempo like tape · STRETCH: follows it, pitch kept (WSOLA)
// warping work in a worker (a long file never freezes the screen); in place where workers are missing
let warpWorker = null, warpSeq = 0;
const warpWaits = new Map();
function warpJob(op, L, R, opts = {}) {
  if (warpWorker === null) {
    try { warpWorker = new Worker(new URL('./warp-worker.js', import.meta.url), { type: 'module' }); warpWorker.onmessage = ({ data }) => { const w = warpWaits.get(data.id); warpWaits.delete(data.id); if (w) (data.error ? w.no(new Error(data.error)) : w.ok(data)); }; warpWorker.onerror = () => { warpWorker = false; for (const w of warpWaits.values()) w.no(new Error('worker')); warpWaits.clear(); }; }
    catch { warpWorker = false; }
  }
  if (!warpWorker) return Promise.resolve(op === 'stretch' ? stretchWarp(L, R, opts) : { t: detectTransients(L, R) });
  const id = ++warpSeq;
  return new Promise((ok, no) => { warpWaits.set(id, { ok, no }); warpWorker.postMessage({ id, op, L: L.slice(), R: (R || L).slice(), opts }); })
    .catch(() => (op === 'stretch' ? stretchWarp(L, R, opts) : { t: detectTransients(L, R) }));
}
const transientCache = new Map();
async function transientsOf(assetId) {
  if (!transientCache.has(assetId)) {
    const a = app.assets.get(assetId);
    transientCache.set(assetId, a ? warpJob('transients', a.L, a.R).then((r) => r.t) : Promise.resolve([]));
  }
  return transientCache.get(assetId);
}
app.transientsOf = transientsOf;
// OFF: as recorded · RE-PITCH: follows the tempo like tape · STRETCH: follows it, pitch kept, along its warp markers
const warpLatest = new Map();
async function warpClip(trackId, clipId, mode, opts = {}) {
  const p = app.store.p, c = findClip(p, trackId, clipId);
  if (!c) return;
  const origId = c.orig || c.src, a0 = app.assets.get(origId);
  if (!a0) { toast('The audio of this clip is missing.'); return; }
  const srcSec = a0.L.length / RATE, bpm = opts.bpm ?? c.bpm ?? p.bpm, st = opts.st ?? c.st ?? 0;
  const markers = cleanMarkers(opts.markers ?? c.wm ?? []);
  let newSrc = origId, extra = {};
  const seq = (warpLatest.get(clipId) || 0) + 1;
  warpLatest.set(clipId, seq);
  if (mode === 'stretch') {
    const tr = await transientsOf(origId);
    const songBpm = app.store.p.bpm;
    const { L, R } = await warpJob('stretch', a0.L, a0.R, { bpm, songBpm, markers, semis: st, transients: tr });
    if (warpLatest.get(clipId) !== seq || !findClip(app.store.p, trackId, clipId)) return;   // (a newer change came in, or it is gone)
    newSrc = uid('a');
    addAsset(newSrc, { L, R, name: `${a0.name} ${bpm}>${songBpm}` }, false);
    extra = { orig: origId, stretchBpm: songBpm, st };
  }
  const fileBeats = beatAt(srcSec, markers, bpm);
  app.store.change((pp) => {
    const x = findClip(pp, trackId, clipId), was = x.stretchBpm;
    if (opts.keepLen && mode === 'stretch' && was && extra.stretchBpm && was !== extra.stretchBpm) x.offset = (x.offset || 0) * was / extra.stretchBpm;   // (the same beat of the audio)
    delete x.orig; delete x.stretchBpm; delete x.st; delete x.wm;
    Object.assign(x, { warp: mode, bpm, src: newSrc, ...extra });
    if (markers.length && mode === 'stretch') x.wm = markers;
    if (mode === 'stretch') pp.assets[newSrc] = { name: `${a0.name} (stretched)`, frames: app.assets.get(newSrc).L.length, derived: origId };
    if (!opts.keepLen && (mode !== 'off' || opts.bpm == null)) { x.offset = 0; x.len = mode === 'stretch' ? fileBeats : srcSec * (mode === 'off' ? pp.bpm : bpm) / 60; if (x.start === undefined) x.loop = x.len; }
  }, opts.tag || null);
}
// AUTO WARP: the clip's tempo found, markers on the attacks that fall near its beats
async function autoWarp(trackId, clipId) {
  const c = findClip(app.store.p, trackId, clipId), id0 = c && (c.orig || c.src), a = id0 && app.assets.get(id0);
  if (!a) return;
  const bpm = c.bpm || detectBpm(a.L, a.R) || app.store.p.bpm;
  const markers = autoMarkers(await transientsOf(id0), bpm);
  if (markers.length < 2) { toast('Not enough clear attacks in this audio to warp it.'); return; }
  await warpClip(trackId, clipId, 'stretch', { bpm, markers });
  toast(`${markers.length} warp markers on the attacks: the audio follows the beat. Drag one to move a beat; double-click to add or remove one.`);
}
app.autoWarp = autoWarp;
// stretched clips follow tempo changes
let restretchTimer = 0;
function restretchSoon() {
  clearTimeout(restretchTimer);
  restretchTimer = setTimeout(() => {
    const p = app.store.p;
    for (const t of p.tracks) for (const c of [...t.clips, ...(t.slots || []).filter(Boolean)]) if (c.warp === 'stretch' && c.stretchBpm !== p.bpm) warpClip(t.id, c.id, 'stretch', { keepLen: true });
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
function finishTake(start, trackId) {
  const chunks = app.takes?.get(trackId) || []; app.takes?.delete(trackId);
  const n = chunks.reduce((a, [L]) => a + L.length, 0);
  const t = app.store.track(trackId);
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
  if (isMidiFolder(c)) {                                         // MIDI: the comp's notes stay, the takes go
    app.store.change((p) => { const x = p.tracks.find((q) => q.id === trackId).clips.find((q) => q.id === clipId); x.notes = compNotes(x); delete x.mtakes; delete x.comp; });
    toast('Comp flattened: its notes are the clip now. Undo brings the takes back.');
    return;
  }
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
  // add: Shift-click, the clip joins (or leaves) the selection; else it is the only one
  selectClip(id, trackId, add = false) {
    if (trackId) app.view.selTrack = trackId;
    const v = app.view; v.sel ||= new Set();
    if (add && id) { if (v.sel.has(id) && v.sel.size > 1) { v.sel.delete(id); id = [...v.sel].at(-1); } else v.sel.add(id); }
    else { v.sel.clear(); if (id) v.sel.add(id); }
    if (v.selClip && !v.sel.has(v.selClip) && v.sel.size) v.selClip = [...v.sel].at(-1);
    v.selClip = id ?? null;
    app.store.emit('select');
  },
  // the selected arrangement clips: [{ t, c }]
  selected() {
    const ids = app.view.sel?.size ? app.view.sel : new Set(app.view.selClip ? [app.view.selClip] : []);
    return app.store.p.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((c) => ({ t, c })));
  },
  // split at the playhead: the selected clips, or (none) every clip of the selected track under it
  splitAt(at = app.pos) {
    const sel = app.selected().filter(({ c }) => c.start < at - 1e-6 && c.start + c.len > at + 1e-6);
    const t = app.store.track(app.view.selTrack);
    if (!sel.length && !t?.clips.some((c) => c.start < at - 1e-6 && c.start + c.len > at + 1e-6)) { toast('No clip under the playhead to split: put the playhead over a clip.'); return; }
    let made = [];
    app.store.change((p) => { made = sel.length ? split(p, at, { ids: sel.map(({ c }) => c.id) }) : split(p, at, { tracks: [t.id] }); });
    toast(`Split in ${made.length * 2} part${made.length > 1 ? 's' : 's'}. Ctrl+J joins them back.`);
  },
  // join the selected MIDI clips of a track (Ctrl+J); audio: consolidated into one file
  joinSelected() {
    const sel = app.selected(), t = sel[0]?.t;
    if (sel.length < 2 || sel.some((x) => x.t.id !== t.id)) { toast('Select two clips or more on one track (Shift-click), then join them.'); return; }
    if (t.kind === 'audio') { app.consolidate(t.id, sel.map(({ c }) => c.id)); return; }
    let id = null;
    app.store.change((p) => { id = join(p, t.id, sel.map(({ c }) => c.id)); });
    if (id) { app.selectClip(id, t.id); toast('Joined into one clip.'); }
  },
  // audio clips of a track rendered into one file and one clip (what they play, with their fades and gains)
  consolidate(trackId, ids) {
    const t = app.store.track(trackId), cs = t.clips.filter((c) => ids.includes(c.id)).sort((a, b) => a.start - b.start);
    const start = cs[0].start, end = Math.max(...cs.map((c) => c.start + c.len)), spb = 60 / app.store.p.bpm;
    const n = Math.round((end - start) * spb * RATE), L = new Float32Array(n), R = new Float32Array(n);
    // as they play: take folders by their comp, crossfades overlapping, envelopes, re-pitched clips at their rate
    const flat = [];
    for (const c of cs) flat.push(...(isFolder(c) ? expandFolder(c, spb) : [c]));
    for (const s of crossfaded(flat, spb)) {
      const a = app.assets.get(s.src); if (!a) continue;
      const rate = s.warp === 'repitch' && s.bpm ? app.store.p.bpm / s.bpm : 1;
      const g = Math.pow(10, (s.gain || 0) / 20), f0 = Math.round((s.start - start) * spb * RATE), m = Math.round(s.len * spb * RATE), base = (s.offset || 0) * RATE;
      const fin = Math.max(1, (s.fadeIn ?? 0.005) * RATE), fout = Math.max(1, (s.fadeOut ?? 0.005) * RATE), AL = a.L, AR = a.R || a.L, per = Math.max(1, AL.length - 1 - base);
      for (let i = 0; i < m && f0 + i < n; i++) {
        if (f0 + i < 0) continue;
        let sp = base + i * rate;
        if (s.aloop) sp = base + ((i * rate) % per);
        const j = Math.floor(sp), fr = sp - j;
        if (j < 0 || j + 1 >= AL.length) continue;
        let k = g;                                                // (the fades as the engine makes them)
        if (i < fin) k *= i / fin;
        if (m - i < fout) k *= Math.max(0, (m - i) / fout);
        if (s.env) k *= Math.pow(10, envAt(s.env, i / RATE / spb - (s.envOff || 0)) / 20);
        L[f0 + i] += (AL[j] + (AL[j + 1] - AL[j]) * fr) * k; R[f0 + i] += (AR[j] + (AR[j + 1] - AR[j]) * fr) * k;
      }
    }
    const id = uid('a');
    addAsset(id, { L, R, name: `${t.name} consolidated` });
    app.store.change((p) => {
      p.assets[id] = { name: `${t.name} consolidated`, frames: n };
      const tr = p.tracks.find((x) => x.id === trackId);
      tr.clips = tr.clips.filter((c) => !ids.includes(c.id));
      tr.clips.push(newAudioClip(start, end - start, id, cs[0].name));
    });
    toast('Consolidated into one audio file.');
  },
  rangeSheet() {
    const p = app.store.p, bars = `${barOf(p, p.loop.a).bar + 1}–${barOf(p, p.loop.b - 1e-6).bar + 1}`;
    sheet(`The loop range · bars ${bars}`, [
      ['COPY IT (every track) · Ctrl+Shift+C', () => app.rangeAction('copy')], ['CUT IT · Ctrl+Shift+X', () => app.rangeAction('cut')],
      ...(rangeClip ? [['PASTE THE RANGE AT THE PLAYHEAD · Ctrl+Shift+V', () => app.rangeAction('paste')]] : []),
      ['DELETE THE TIME (what follows moves back)', () => app.rangeAction('delete'), 'danger'],
      ['INSERT TIME HERE (the length of the loop)', () => app.rangeAction('insert')],
      ['CLEAR IT (leave the gap)', () => app.rangeAction('clear')],
      ['SPLIT EVERY CLIP AT ITS EDGES', () => app.store.change((pp) => { split(pp, pp.loop.a); split(pp, pp.loop.b); })],
    ]);
  },
  // the loop range as a time selection, on every track
  rangeAction(act) {
    const p = app.store.p, a = p.loop.a, b = p.loop.b;
    if (!(b > a)) return;
    const bars = `${barOf(p, a).bar + 1}–${barOf(p, b - 1e-6).bar + 1}`;
    if (act === 'copy' || act === 'cut') { rangeClip = copyRange(p, a, b); if (act === 'cut') app.store.change((pp) => clearRange(pp, a, b)); toast(`${act === 'cut' ? 'Cut' : 'Copied'}: the loop range (bars ${bars}) of every track. Ctrl+Shift+V pastes it at the playhead.`); }
    else if (act === 'paste') { if (!rangeClip) { toast('Copy a range first (the loop range: PROJECT menu or Ctrl+Shift+C).'); return; } const at = floorBar(p, app.pos); app.store.change((pp) => pasteRange(pp, rangeClip, at)); toast(`Pasted ${rangeClip.len} beats at bar ${barOf(p, at).bar + 1}.`); }
    else if (act === 'delete') app.store.change((pp) => deleteTime(pp, a, b));
    else if (act === 'insert') app.store.change((pp) => insertTime(pp, a, b - a));
    else if (act === 'clear') app.store.change((pp) => clearRange(pp, a, b));
  },
  // an audio clip played backwards (a reversed copy of its file)
  reverseClip(trackId, clipId) {
    const c = app.store.track(trackId)?.clips.find((x) => x.id === clipId), a = c && app.assets.get(c.src);
    if (!a || isFolder(c)) { toast('Reverse works on a plain audio clip (flatten a take folder first).'); return; }
    const id = uid('a'), r = reversed(a), secs = c.len * 60 / app.store.p.bpm;
    addAsset(id, r);
    app.store.change((p) => {
      p.assets[id] = { name: r.name, frames: r.L.length };
      const x = p.tracks.find((q) => q.id === trackId).clips.find((q) => q.id === clipId);
      x.offset = Math.max(0, a.L.length / RATE - (x.offset || 0) - secs); x.src = id; x.reversed = !x.reversed;
      [x.fadeIn, x.fadeOut] = [x.fadeOut, x.fadeIn];
      if (x.env) x.env = x.env.map((q) => ({ ...q, t: x.len - q.t })).reverse();   // (the envelope turned round with the audio)
    });
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
    const p = app.store.p, on = !p.punch.on;
    let { a, b } = p.punch;
    if (on) {
      const ar = app.arrange, [w] = ar.ruler.size(), v0 = ar.beat(0), v1 = ar.beat(w);
      if (!(b > v0 && a < v1) || b <= a) {
        if (p.loop.on && p.loop.a >= v0 && p.loop.b <= v1 && p.loop.b - p.loop.a < v1 - v0) ({ a, b } = p.loop);   // a loop in view
        else { const bb = barOf(p, app.pos); a = bb.start; b = barStart(p, bb.bar + 4); }
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
    toast(`Marker ${name} at bar ${barLabel(p, at)}. ${matchMedia('(pointer: coarse)').matches ? 'Double-tap' : 'Double-click'} it to rename it.`);
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
    const p = app.store.p, bar = (x) => barLabel(p, x);
    toast(`PUNCH ON, bar ${bar(p.punch.a)} to bar ${bar(p.punch.b)}: press REC and play, only what falls inside the red zone is recorded. Drag the zone's ends in the ruler to move them.`);
  },
  async setRecord(on) {
    const target = app.playTarget();
    // every armed audio track records at once, each from its own input channels
    const armedAudio = app.store.p.tracks.filter((t) => t.arm && t.kind === 'audio');
    const recAudio = armedAudio.length ? armedAudio : target?.kind === 'audio' ? [target] : [];
    if (on && recAudio.length) {
      try { await app.audio.enableInput(); } catch (err) { toast(`Recording needs an audio input: ${err.message || 'access refused'}.`); return; }
      app.takeTrack = recAudio[0].id; app.takes = new Map();
      app.audio.send({ t: 'capture', on: true, tracks: recAudio.map((t) => ({ id: t.id, a: t.input?.a ?? 0, b: t.input?.b === undefined ? 1 : t.input.b })) });
    } else if (!on) app.audio.send({ t: 'capture', on: false });
    if (!on) closeAllSessionTakes();
    app.recording = on;
    if (on) { app.recSession = (app.recSession || 0) + 1; app.recTakes = new Map(); }   // (each loop pass: a take)
    $('rec').classList.toggle('on', on);
    app.audio.send({ t: 'rec', on, lag: on ? app.audio.latency() : 0 });   // (what you play lands where you heard it: engine-core.js recPos)
    app.store.endGesture();
    if (on) for (const [id, st] of Object.entries(app.session.state)) if (st.slot >= 0) sessRec.set(id, { slot: st.slot, at: app.pos });
    if (on && !app.playing) app.play(true, app.store.p.countIn);
  },
  // arm a track: audio tracks can be armed together (each records its own input); an instrument track alone
  async armTrack(id) {
    const t = app.store.track(id); if (!t) return;
    const on = !t.arm;
    app.store.change((p) => { for (const y of p.tracks) { if (y.id === id) y.arm = on; else if (on && (t.kind !== 'audio' || y.kind !== 'audio')) y.arm = false; } });
    if (on && t.kind === 'audio' && !app.audio.input) {
      try { await app.audio.enableInput(); app.syncMonitor(); app.device.refresh(true); } catch (err) { toast(`No audio input: ${err.message || 'access refused'}.`); }
    }
  },
  playTarget() {
    const p = app.store.p;
    return p.tracks.find((t) => t.arm) || app.store.track(app.view.selTrack) || null;
  },
  // an external track sends its live notes straight out (lowest latency), unless note effects must shape them first
  noteOn(trackId, n, v = 100, live = false, preview = false) { if (live && app.editor?.step.on && app.editor.ctx?.t.id === trackId && !app.playing) app.editor.stepNote(n, v); const t = app.store.track(trackId), direct = t?.kind === 'external' && !t.nfx?.some((d) => d.on !== false); if (direct) app.control.externalLive(t, true, n, v); app.audio.send({ t: 'note', track: trackId, n, v, on: true, silent: direct, preview }); },
  noteOff(trackId, n) { const t = app.store.track(trackId), direct = t?.kind === 'external' && !t.nfx?.some((d) => d.on !== false); if (direct) app.control.externalLive(t, false, n, 0); app.audio.send({ t: 'note', track: trackId, n, v: 0, on: false, silent: direct }); },
  audition(trackId, notes, ms = 450) {
    setTimeout(() => {                                         // after the new sound reaches the engine
      for (const n of notes) app.noteOn(trackId, n, 96, false, true);
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
      await app.wam?.captureAll();                               // (a plugin's latest settings, in the render)
      const [L, R] = await app.audio.render(app.store.p, { freezeTrack: id, assets: usedAssets(app.store.p) });
      const aid = uid('a');
      addAsset(aid, { L, R, name: `${t.name} frozen` });
      app.store.change((p) => { p.assets[aid] = { name: `${t.name} frozen`, frames: L.length }; p.tracks.find((x) => x.id === id).frozen = { src: aid, bpm: p.bpm }; });
      toast(`${t.name} frozen: its instrument rests. Unfreeze to edit it.`);
    } catch (err) { toast(`Freeze failed: ${err.message}`); }
  },
  unfreeze(id) { app.store.change((p) => { delete p.tracks.find((x) => x.id === id).frozen; }); },
  // several tracks frozen together: their renders side by side, one per spare core (Audio.render)
  freezeMany(ids) { return Promise.all(ids.map((id) => app.freeze(id))); },
  async loadSampleFile(f) {
    try {
      const { L, R } = await decode(app.audio.ctx, await f.arrayBuffer());
      const id = uid('a'), name = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
      addAsset(id, { L, R, name });
      app.store.change((p) => { p.assets[id] = { name, frames: L.length }; });
      return id;
    } catch { toast(`${f.name}: this file could not be read as audio.`); return null; }
  },
  // several files as project audio in one step: -> their ids (null for a file that is not audio)
  async loadSampleFiles(files) {
    const got = [];
    for (const f of files) {
      try { const { L, R } = await decode(app.audio.ctx, await f.arrayBuffer()); got.push({ id: uid('a'), name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), L, R }); }
      catch { got.push(null); toast(`${f.name}: this file could not be read as audio.`); }
    }
    for (const g of got) if (g) addAsset(g.id, { L: g.L, R: g.R, name: g.name });
    if (got.some(Boolean)) app.store.change((p) => { for (const g of got) if (g) p.assets[g.id] = { name: g.name, frames: g.L.length }; });
    return got.map((g) => g?.id || null);
  },
  // a sample onto a drum track's pad (note): it plays instead of the kit's sound
  async setPadSample(trackId, note, file) {
    const [id] = await app.loadSampleFiles([file]);
    if (!id) return;
    const name = app.assets.get(id).name;
    app.store.change((p) => { const t = p.tracks.find((x) => x.id === trackId); t.pads ||= {}; t.pads[note] = { ...(t.pads[note] || {}), src: id, name, start: 0, end: 1 }; });
    app.audition(trackId, [note], 300);
  },
  clearPad(trackId, note) { app.store.change((p) => { const t = p.tracks.find((x) => x.id === trackId); if (t.pads) { delete t.pads[note]; if (!Object.keys(t.pads).length) delete t.pads; } }); },
  // files into the sampler: one -> its sample; several -> zones (roots from their names: Piano_C4.wav, Pad-60.wav...)
  async setSamplerFiles(trackId, files) {
    const ids = await app.loadSampleFiles(files), ok = files.map((f, i) => ({ src: ids[i], name: app.assets.get(ids[i])?.name || f.name })).filter((x) => x.src);
    if (!ok.length) return;
    if (ok.length === 1) {
      app.store.change((p) => { const s = p.tracks.find((x) => x.id === trackId).sample; s.src = ok[0].src; s.name = ok[0].name.toUpperCase().slice(0, 18); s.start = 0; s.end = 1; delete s.zones; });
      app.audition(trackId, [60], 500);
      return;
    }
    let zones = zonesFromNames(ok);
    const named = new Set(zones.map((z) => z.src)), rest = ok.filter((x) => !named.has(x.src));
    if (rest.length) {           // names without a note: one a key from C3, after the named ones
      const from = zones.length ? Math.min(127, Math.max(...zones.map((z) => z.root)) + 1) : 48;
      rest.forEach((x, i) => { const n = Math.min(127, from + i); zones.push({ src: x.src, name: x.name, root: n, lo: n, hi: n, vlo: 1, vhi: 127, gain: 0, tune: 0 }); });
      if (!named.size) toast(`No note in the file names: ${rest.length} samples, one a key from C3.`);
    }
    app.store.change((p) => { const s = p.tracks.find((x) => x.id === trackId).sample; s.zones = zones; s.src = zones[0].src; s.name = `${zones.length} ZONES`; s.mode = 'keys'; s.start = 0; s.end = 1; });
    toast(`${zones.length} zones mapped across the keyboard.`);
    app.audition(trackId, [60], 500);
  },
  // USE (the SAMPLES list): on the selected track, where it fits
  async useSample(files) {
    const t = app.store.track(app.view.selTrack);
    if (t?.kind === 'sampler') return app.setSamplerFiles(t.id, files);
    if (t?.kind === 'drum') { const lib = app.lib.sloop, n = app.view.padSel ?? lib.laneNotes[0]; await app.setPadSample(t.id, n, files[0]); toast(`${files[0].name} on pad ${lib.lanes[lib.laneNotes.indexOf(n)] || n}.`); return; }
    return importAudio(files, { trackId: t?.kind === 'audio' ? t.id : null, beat: app.pos });
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
    if (kind === 'drum') app.audition(t.id, [36, 42]); else if (kind === 'synth' || kind === 'lab') app.audition(t.id, [60, 64, 67]);
    toast({ audio: `${t.name}: drop audio files on its lane, or arm it and press R to record.`, sampler: `${t.name}: load a sample in INSTRUMENT, then play it.`,
      external: `${t.name}: choose the MIDI device and channel in INSTRUMENT. Its clips play that device.`, group: `${t.name}: route tracks to it from the mixer (OUT).`,
      lab: `${t.name}: your own instrument. INSTRUMENT > OPEN THE LAB to see and change how it is made.` }[kind]
      || `${t.name}: new track. ${matchMedia('(pointer: coarse)').matches ? 'Double-tap' : 'Double-click'} its lane to write a clip.`);
    return t;
  },
  // BOUNCE: the track with its effects (before its fader) rendered to a new audio track; the original muted
  async bounceTrack(id) {
    const t = app.store.track(id);
    if (!t || t.kind === 'vca') return;
    toast(`Bouncing ${t.name}…`);
    try {
      const p = app.store.p, [L, R] = await app.audio.render(p, { bounceTrack: id, assets: usedAssets(p), tail: 4 });
      let n = L.length; while (n > 44100 && Math.abs(L[n - 1]) < 1e-4 && Math.abs(R[n - 1]) < 1e-4) n--;   // (the silence after it trimmed)
      const aid = uid('a'), name = `${t.name} BOUNCE`.slice(0, 40), L2 = L.slice(0, n), R2 = R.slice(0, n);
      addAsset(aid, { L: L2, R: R2, name });
      const nt = newTrack('audio', p.tracks.length, { name: uniqueName(p, `${t.name.slice(0, 9)} BNC`), color: t.color, sends: [...t.sends], out: t.out });
      nt.vol = t.vol; nt.pan = t.pan; if (t.vca) nt.vca = t.vca;
      nt.clips = [newAudioClip(0, n / 44100 * p.bpm / 60, aid, name)];
      app.store.change((pp) => {
        pp.assets[aid] = { name, frames: n };
        const i = pp.tracks.findIndex((x) => x.id === id);
        pp.tracks.splice(i + 1, 0, nt);
        pp.tracks[i].mute = true;
      });
      app.selectTrack(nt.id);
      toast(`${t.name} bounced to audio (its effects in, its fader and sends kept on the new track). The original is muted.`);
    } catch (err) { toast(`Bounce failed: ${err.message}`); }
  },
  // AUDIO TO MIDI: a clip's melody (one note at a time) or its beat (kick, snare, hat) as a MIDI clip on a new track
  async audioToMidi(trackId, clipId, mode) {
    const t = app.store.track(trackId), c = t?.clips.find((x) => x.id === clipId), a = c && app.assets.get(c.src);
    if (!a) { toast('This clip\'s audio is missing.'); return; }
    toast(mode === 'drums' ? 'Listening for the hits…' : 'Listening for the melody…');
    await new Promise((r) => setTimeout(r, 30));
    const p = app.store.p, spb = 60 / p.bpm, rate = c.warp === 'repitch' && c.bpm ? p.bpm / c.bpm : 1;
    const s0 = Math.floor((c.offset || 0) * 44100), s1 = Math.min(a.L.length, s0 + Math.ceil(c.len * spb * rate * 44100));
    const { melodyToNotes, drumsToNotes } = await import('./audio2midi.js');
    const found = (mode === 'drums' ? drumsToNotes : melodyToNotes)(a.L.subarray(s0, s1), a.R.subarray(s0, s1));
    const notes = found.map((n) => ({ t: n.t / rate / spb, d: Math.max(1 / 16, n.d / rate / spb), n: n.n, v: n.v })).filter((n) => n.t < c.len);
    if (!notes.length) { toast(mode === 'drums' ? 'No hit found in this clip.' : 'No clear melody found (one note at a time works best).'); return; }
    const nt = app.addTrack(mode === 'drums' ? 'drum' : 'synth', mode === 'drums' ? { kit: app.lib.sloop.kits.indexOf('909'), name: `${t.name.slice(0, 10)} MIDI` } : { name: `${t.name.slice(0, 10)} MIDI` });
    const clip = newClip(c.start, c.len, `${c.name.slice(0, 14)} MIDI`);
    clip.loop = c.len; clip.notes = notes;
    app.store.change((pp) => { const x = pp.tracks.find((q) => q.id === nt.id); x.clips.push(clip); }, 'a2m');
    app.selectClip(clip.id, nt.id); app.showTab('edit');
    toast(`${notes.length} ${mode === 'drums' ? 'hits' : 'notes'} found: a new track plays them.`);
  },
  // a VCA: one fader that moves (and mutes) the faders of the tracks given to it, without mixing their audio
  addVca() {
    const p = app.store.p, sel = app.store.track(app.view.selTrack);
    const v = newTrack('vca', p.tracks.length, { scenes: p.scenes.length, color: '#c9ccc9', name: uniqueName(p, 'VCA') });
    app.store.change((pp) => { pp.tracks.push(v); if (sel && sel.kind !== 'vca') pp.tracks.find((x) => x.id === sel.id).vca = v.id; });
    toast(sel && sel.kind !== 'vca' ? `${sel.name} now follows ${v.name}. Give it more tracks from their menu (VCA…).` : `${v.name}: give it tracks from their menu (VCA…).`);
  },
  setVca(trackId, vcaId) { app.store.change((p) => { const t = p.tracks.find((x) => x.id === trackId); if (vcaId) t.vca = vcaId; else delete t.vca; }); },
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
      if (isMidiFolder(c) && c.mtakes[k]) { c.comp = setComp(c.comp, a ?? 0, b ?? (c.loop || c.len), k); c.notes = compNotes(c); return; }
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
      app.store.change((p) => { for (const x of p.tracks) { if (x.out === id) x.out = t.out || 'master'; if (x.vca === id) delete x.vca; } p.tracks = p.tracks.filter((x) => x.id !== id); });
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
  $('labbtn').onclick = () => labStart(app);
  $('mode-arr').onclick = () => app.setMode('arrange');
  $('mode-ses').onclick = () => app.setMode('session');
  const addMenu = $('addmenu');
  popMenu($('addbtn'), addMenu, 'left');
  addMenu.addEventListener('click', (e) => { if (e.target.closest('button')) addMenu.hidden = true; });
  $('add-sampler').onclick = () => app.addTrack('sampler', { sends: [0.1, 0] });
  $('add-lab').onclick = () => labPicker(app, 'inst', (patch, name) => { const t = app.addTrack('lab', { lab: patch, name: String(name || 'LAB').toUpperCase().slice(0, 16), sends: [0.1, 0] }); app.audition(t.id, [60, 64, 67]); }, 'A LAB instrument: start from');
  $('add-ext').onclick = () => app.addTrack('external', { sends: [0, 0] });
  $('add-wam').onclick = () => wamDialog(app, { instrument: true });
  $('add-group').onclick = () => app.addGroup();
  $('add-return').onclick = () => app.addReturn();
  $('add-macros').onclick = () => app.showMacroLane(0);
  $('add-preset').onclick = () => newTrackFromPreset(app);
  $('add-vca').onclick = () => app.addVca();
  $('livebadge').onclick = () => collabDialog(app);
  app.syncAutoButton = () => { const b = $('autobtn'), m = app.autorec.mode; b.textContent = m === 'read' ? 'AUTO' : m.toUpperCase(); b.classList.toggle('on', m !== 'read'); };
  $('autobtn').onclick = () => { app.autorec.cycle(); toast({ read: 'Automation: READ (it plays, your moves are not recorded).', touch: 'Automation: TOUCH. While playing, hold any knob, fader or send: its moves are recorded.', latch: 'Automation: LATCH. Like TOUCH, and it keeps its last value until you stop.' }[app.autorec.mode]); };
  app.syncAutoButton();
  // the top bar on one row: the least needed things leave first while it does not fit (they stay in the menus)
  const FIT = ['#midi-cell', '#oct-cell', '.title-field', '#top > .sep', '#swing-cell', '#install', '#lufs-cell', '#sigbtn', '#countin', '#takesbtn', '#snap-cell', '#autobtn', '#learn', '#labbtn', '#punch', '#click'];
  const top = $('top'), one = () => { const ys = [...top.children].filter((e) => e.offsetParent && e.offsetWidth).map((e) => e.offsetTop + e.offsetHeight / 2); return !ys.length || Math.max(...ys) - Math.min(...ys) < 12; };
  let fitting = false;
  const fitTop = (fresh = true) => {
    if (fitting) return;
    fitting = true;
    if (fresh) for (const el of top.querySelectorAll('.fit-hide')) el.classList.remove('fit-hide');
    if (!matchMedia('(max-width: 700px)').matches) for (const sel of FIT) { if (one()) break; for (const el of top.querySelectorAll(sel)) el.classList.add('fit-hide'); }
    fitting = false;
  };
  app.fitTop = fitTop;
  let fitT = 0;
  window.addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fitTop, 60); });
  document.fonts?.ready.then(() => fitTop());
  // (a readout growing, a button appearing: if it wraps, more leave)
  new ResizeObserver(() => requestAnimationFrame(() => { if (!fitting && !one()) fitTop(false); })).observe(top);
  fitTop();
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
        if (entries.some((x) => x.name === 'project.xml')) { await openDawproject(entries); return; }   // a DAWproject
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
app.modal = (...a) => modal(...a);
// the macros' automation lane, on macro i
app.showMacroLane = (i = 0) => { app.view.macroLane = true; app.view.autoTarget.__macros = `m${i}`; app.setMode('arrange'); app.arrange.renderHeads(); app.arrange.redraw(); app.arrange.scrollTo?.(app.view.sx, 0); };
function load(p) {
  const cur = app.store.p;                                       // the project replaced: an earlier version to go back to
  if (cur.tracks.some((t) => t.clips.length || t.slots?.some(Boolean))) addSnapshot(projectJson(), { name: cur.name, why: `Before opening ${p.name}`, tracks: cur.tracks.length });
  app.fileHandle = null;
  app.audio.send({ t: 'stop' }); app.audio.send({ t: 'panic' });
  app.params.clear();
  app.view.selTrack = p.tracks[0]?.id ?? null; app.view.selClip = null; app.view.autoOpen.clear();
  app.store.replace(p, true);
  // the sounds Kraken makes itself (gensounds.js: a starter's log drum…), made here when this browser has not got them
  for (const t of p.tracks) for (const id of trackSources(t)) if (!app.assets.has(id) && genSound(id)) addAsset(id, genSound(id), false);
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

// a time signature from the bar holding `beat` on (the bars before it keep theirs; the notes stay where they are)
function signatureDialog(beat = app.pos) {
  const p = app.store.p, L = meterList(p), b = barOf(p, Math.max(0, beat), L);
  const here = L.find((m) => Math.abs(m.t - b.start) < 1e-9);
  const num = h('select', { 'aria-label': 'Beats in a bar' }, [...Array(16)].map((_, i) => h('option', { value: i + 1, selected: i + 1 === b.n ? true : null }, String(i + 1))));
  const den = h('select', { 'aria-label': 'Beat unit' }, DENOMS.filter((d) => d >= 2).map((d) => h('option', { value: d, selected: d === b.d ? true : null }, String(d))));
  const apply = (n, d) => app.store.change((pp) => {
    const list = meterList(pp).filter((m) => Math.abs(m.t - b.start) > 1e-9).map(({ t, n: nn, d: dd }) => ({ t, n: nn, d: dd }));
    if (n) list.push({ t: b.start, n, d });
    pp.meters = list.sort((x, y) => x.t - y.t);
    if (b.start < 1e-9 && n) pp.sig = (n * 4) / d;
    const L2 = meterList(pp);
    pp.sig = L2[0].len;
  });
  const buttons = [['Cancel']];
  if (here && b.start > 0) buttons.push(['Remove this change', () => apply(null)]);
  buttons.push([`From bar ${b.bar + 1}`, () => { apply(+num.value, +den.value); toast(`${num.value}/${den.value} from bar ${b.bar + 1}. The notes stay where they are; the bar lines follow.`); }, true]);
  modal('Time signature', [h('p', { class: 'hint', text: `Bar ${b.bar + 1} is in ${b.n}/${b.d}. The new signature runs from this bar until the next change.` }),
    h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, num, h('span', { text: '/' }), den)], buttons);
}
app.signatureDialog = signatureDialog;

// what this device can do for Kraken, measured
async function checkDialog() {
  const wait = modal('Checking this device…', [h('p', { class: 'hint', text: 'Audio, engine speed, storage, MIDI, export: a few seconds.' })], []);
  await new Promise((r) => setTimeout(r, 50));
  let rows;
  try { rows = await diagnose(app); } finally { wait.close(); }
  const text = diagnosisText(rows);
  const list = h('div', { class: 'diag' }, rows.map((r) => h('div', { class: `diag-row ${r.s}` }, h('i', { text: r.s === 'ok' ? '✓' : r.s === 'warn' ? '!' : '✗' }), h('b', { text: r.k }), h('span', { text: r.v }))));
  const bad = rows.filter((r) => r.s !== 'ok').length;
  // the multi-core setting (multicore.js): Auto or Off ('on', forced, is kept when it was set by hand)
  const mode = mcMode(), mcNow = h('p', { class: 'ctl-note', text: app.mc?.describe() || '' });
  const mcSel = h('select', { 'aria-label': 'Multi-core playback', disabled: mcSupported() ? null : true, onchange: (e) => { app.mc?.setMode(e.target.value); setTimeout(() => { mcNow.textContent = app.mc?.describe() || ''; }, 2500); } },
    [['auto', 'Auto'], ['off', 'Off'], ...(mode === 'on' ? [['on', 'On (forced)']] : [])].map(([v, l]) => h('option', { value: v, selected: v === mode ? true : null }, l)));
  const mc = h('div', { class: 'mc-setting' }, h('label', { class: 'exp-row' }, h('span', { text: 'MULTI-CORE' }), mcSel),
    h('p', { class: 'ctl-note', text: 'Plays the tracks that need not react at once on the other cores of the processor, 64 ms ahead of the playhead, so bigger songs play without crackles. What you play live, an armed track and plugins stay instant; a knob on a track played ahead is heard 64 ms later. Auto: on with 4 cores or more. Off: everything on one core.' }), mcNow);
  modal('This device', [h('p', { class: 'hint', text: bad ? `${bad} thing${bad > 1 ? 's' : ''} to know below.` : 'Everything Kraken needs is here.' }), list, mc],
    [['Copy the report', () => { navigator.clipboard?.writeText(text).then(() => toast('Report copied.'), () => toast('Could not copy: select the text instead.')); }], ['Close', null, true]]);
}

async function fileAction(act) {
  logAct(`project: ${act}`);
  if (act === 'lang') return toggleLang().then(() => { app.store.emit('select'); app.fitTop?.(); });   // (the views draw again, in the other language)
  const p = app.store.p, base = (p.name || 'kraken').normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\w\- ]+/g, '').trim() || 'kraken';   // (Démo été: Demo ete)
  if (act === 'transport') return transportSheet();
  if (act === 'template') return saveTemplate(app);
  if (act === 'collab') return collabDialog(app);
  if (act === 'presets') return managePresets(app);
  if (act === 'hub') return app.hub.open();
  if (act === 'publish') return app.hub.publish({ kind: 'song' });
  if (act === 'lab') return labStart(app);
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
    else if (act === 'signature') signatureDialog(app.pos);
    else if (act === 'starter') welcome(app, { modal });
    else if (act === 'tour') startTour(app);
    else if (act === 'report') await reportDialog(app, { modal, toast });
    else if (act === 'sloop') { const inp = $('sloopfile'); inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) openSloopSong(f); }; inp.click(); }
    else if (act === 'importmidi') { const inp = $('midifile'); inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) importMidiFile(f).catch((e2) => toast(e2.message)); }; inp.click(); }
    else if (act === 'dawexport') { const name = await saveFile(`${base}.dawproject`, zip(exportDawproject(p, { assets: app.assets, lib: app.lib })), { zipWhenHosted: true }); toast(`Saved ${name}: it opens in Bitwig, Studio One, Cubase and the other DAWs that read DAWproject.`); }
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
const FORMATS = [['wav24', 'WAV · 24 bit', 'wav'], ['wav16', 'WAV · 16 bit (CD)', 'wav'], ['wav32', 'WAV · 32 bit float (for mastering)', 'wav'], ['flac24', 'FLAC · 24 bit (lossless, smaller)', 'flac'],
  ['flac16', 'FLAC · 16 bit', 'flac'], ['mp3', 'MP3 · 320 kbps (plays everywhere)', 'mp3'], ['mp3192', 'MP3 · 192 kbps (smaller)', 'mp3'],
  ['opus', 'OPUS · 192 kbps (small, to share)', 'opus']];
async function exportDialog(stems, base) {
  const p = app.store.p;
  if (!p.tracks.some((t) => t.clips.length)) { toast('Nothing to export yet: add a clip first.'); return; }
  let last = {}; try { last = JSON.parse(localStorage.getItem('kraken.export') || '{}'); } catch { /* storage blocked */ }
  const opusOk = await opusSupported();
  const sel = (label, opts, value) => h('label', { class: 'exp-row' }, h('span', { text: label }),
    h('select', { 'aria-label': label }, opts.map(([v, l, , off]) => h('option', { value: v, selected: v === value ? true : null, disabled: off ? true : null }, l))));
  const fmt = sel('FORMAT', FORMATS.map((f) => (f[0] === 'opus' && !opusOk ? [f[0], `${f[1]}: not in this browser`, f[2], true] : f)), last.format && (last.format !== 'opus' || opusOk) ? last.format : 'wav24');
  const what = sel('WHAT', [['mix', 'The mix'], ['stems', 'The mix and one file a track (stems)'], ['stems+', 'The mix, the tracks dry, and each return (stems that add up to the mix)']], stems ? (last.what === 'stems+' ? 'stems+' : 'stems') : 'mix');
  const rate = sel('SAMPLE RATE', [['44100', '44.1 kHz (as played)'], ['48000', '48 kHz (video)'], ['88200', '88.2 kHz'], ['96000', '96 kHz']], String(last.rate || 44100));
  const range = sel('RANGE', [['song', 'The whole song (and its tail)'], ['loop', `The loop: bars ${barLabel(p, p.loop.a)} to ${barLabel(p, p.loop.b)}, no tail`]], last.range || 'song');
  modal('Export', [fmt, what, range, rate, h('p', { class: 'ctl-note', text: 'Rendered by the same engines you hear, faster than real time. Opus is always 48 kHz; MP3 is 44.1 or 48 kHz.' })],
    [['Cancel'], ['Export', () => {
      const w = what.querySelector('select').value;
      const o = { format: fmt.querySelector('select').value, stems: w !== 'mix', returns: w === 'stems+', range: range.querySelector('select').value, rate: +rate.querySelector('select').value };
      try { localStorage.setItem('kraken.export', JSON.stringify({ format: o.format, range: o.range, rate: o.rate, what: w })); } catch { /* storage blocked */ }
      exportAudio(o, base);
    }, true]]);
}
async function exportAudio({ format = 'wav24', stems = false, returns = false, range = 'song', rate = RATE } = {}, base) {
  await app.wam?.captureAll();                                   // (the plugins' latest settings, in the render)
  const p = structuredClone(app.store.p);
  const bar = h('div', { class: 'progress' }, h('i'));
  const msg = h('p', { text: 'Rendering the mix with the same engines you hear…' });
  const box = modal('Export', [msg, bar], []);
  const step = (i, n, what) => { bar.style.setProperty('--v', (i / n).toFixed(3)); msg.textContent = `Rendering ${what} (${i + 1}/${n})…`; };
  const ext = FORMATS.find((f) => f[0] === format)?.[2] || 'wav';
  const mp3 = ext === 'mp3';
  const out = format === 'opus' ? RATE : mp3 ? mp3Rate(rate) : rate;
  const encode = async (L, R, onProgress) => {
    if (out !== RATE) { L = resample(L, RATE, out); R = resample(R, RATE, out); }
    if (format === 'wav16' || format === 'wav24' || format === 'wav32') return encodeWav([L, R], out, format === 'wav16' ? 16 : format === 'wav32' ? 32 : 24, format === 'wav16');
    if (format === 'flac16' || format === 'flac24') return encodeFlac([L, R], out, format === 'flac16' ? 16 : 24, format === 'flac16');
    if (mp3) return encodeMp3Off(L, R, out, format === 'mp3192' ? 192 : 320, { title: p.name, onProgress });
    return encodeOpus(L, R, RATE, 192000);
  };
  try {
    const t0 = performance.now();
    const jobs = [{ name: 'MIX', solo: null }, ...(stems ? p.tracks.filter((t) => t.kind !== 'vca').map((t, i) => ({ name: `${String(i + 1).padStart(2, '0')} ${t.name}`, solo: t.id })) : []),
      ...(returns ? p.returns.map((r, i) => ({ name: `R${i + 1} ${r.name}`, ret: i })) : [])];
    const span = range === 'loop' ? { start: p.loop.a, end: p.loop.b, tail: 0 } : {};
    // each stem in its own offline render, several at once (one per spare core: Audio.render shares them out)
    const files = new Array(jobs.length), assets = usedAssets(p);
    let next = 0, done = 0;
    const one = async () => {
      while (next < jobs.length) {
        const i = next++;
        const [L, R] = await app.audio.render(p, { soloTrack: jobs[i].solo, soloReturn: jobs[i].ret ?? null, assets, ...span });
        msg.textContent = `Encoding ${jobs[i].name} (${ext.toUpperCase()}${out !== RATE ? `, ${out / 1000} kHz` : ''})…`;
        await new Promise((r) => setTimeout(r, 0));
        files[i] = { name: `${base} - ${jobs[i].name}.${ext}`, data: await encode(L, R, jobs.length === 1 ? (v) => bar.style.setProperty('--v', v.toFixed(3)) : null) };
        if (++done < jobs.length) step(done, jobs.length, jobs.filter((j, k) => !files[k]).map((j) => j.name).slice(0, 3).join(', '));
      }
    };
    step(0, jobs.length, jobs[0].name);
    await Promise.all(Array.from({ length: Math.min(jobs.length, app.audio.renderSlots(app.audio.renderSeconds(p, span))) }, one));
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
    [`TIME SIGNATURE · ${barOf(p, Math.max(0, app.pos)).n}/${barOf(p, Math.max(0, app.pos)).d}`, () => signatureDialog(app.pos)],
    [`LOOP RECORDING · ${p.recTakes === false ? 'OVERDUB' : 'TAKES'}`, () => $('takesbtn').click()],
    [`PUNCH IN / OUT · ${on(p.punch?.on)}`, () => app.togglePunch()],
    [`AUTOMATION · ${app.autorec.mode.toUpperCase()}`, () => $('autobtn').click()],
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
    ['Ctrl E · Ctrl J', 'Split the selected clips (or the track) at the playhead · join (MIDI) or consolidate (audio) the selected'],
    ['Shift click · Shift drag', 'Add a clip to the selection · a box around clips. Drag one of them: they all move; Delete, Ctrl C, Ctrl D'],
    ['Right-click the LOOP band', 'The loop range as a time selection: copy, cut, paste, delete or insert time on every track'],
    ['Audio clips', 'The white squares at the top corners: the fades. Right-click: split here, reverse, loop the audio'],
    ['Ctrl S · Ctrl Shift S', 'Save to a file (Chrome, Edge: the same file again) · save as. Kraken also saves by itself'],
    ['PROJECT menu', 'Earlier versions (your work every 5 minutes) · Check this device · Report a problem · Show me around'],
    ['Ctrl L · LEARN', 'MIDI Learn: click any knob, fader, button or action, then move a control (or press a key)'],
    ['Drop files', 'A .mid: tracks · a .sloopsong: the SLOOP song · audio files: audio clips'],
    ['Clip editor', 'The strip above the notes: drag the white handle for the clip length, the orange one for the loop'],
    ['Sound tab', 'NOTE FX before the sound · MODULATORS: pick a target or MAP and click a knob · EFFECTS after it'],
    ['Takes', 'Record over audio: each pass is a take. The TAKES badge opens the lanes: click or swipe a take to comp it'],
    ['Automation', 'A: the lane · ✎ PENCIL draws · Alt-drag a line: curve · right-click: curves, clear · AUTO (top bar): TOUCH or LATCH records what you move while playing'],
    ['Piano roll', 'KEY and SCALE light the song\'s notes, FOLD keeps only them · GHOST: another track behind · STEP: type notes in · QUANTIZE ▾: strength, swing, humanize'],
    ['Audio clips', 'Fade handle at a seam between two clips: a crossfade · ENVELOPE (clip editor): the clip\'s own volume line'],
    ['Track menu', 'Colour, height (or drag a head\'s bottom edge), VCA, bounce to audio, save or load a preset · a group folds with ▾'],
    ['Sounds', 'SAMPLES: your folders, click to hear, drag onto the arrangement, a drum pad or the sampler · ★ MY SOUNDS: your track presets'],
    ['Effects', '☰ on an effect: factory and your presets · CHAIN PRESETS: a whole chain · + TRACK > From a preset'],
    ['Play together', 'PROJECT > Play together: invite someone with a code, live, browser to browser'],
  ];
  const grid = (title, rows) => [h('h4', { style: { margin: '6px 0 0', font: '700 9px/1 var(--f-ui)', letterSpacing: '0.16em', color: 'var(--dim)' }, text: title }),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(70px, auto) 1fr', gap: '6px 14px', font: '500 11px/1.4 var(--f-ui)' } },
      rows.flatMap(([k, v]) => [h('span', { style: { font: '500 10px/1.4 var(--f-mono)', color: 'var(--accent)' }, text: k }), h('span', { text: v })]))];
  const lnk = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', text, style: { color: 'var(--accent)' } });
  const credits = [h('h4', { style: { margin: '10px 0 0', font: '700 9px/1 var(--f-ui)', letterSpacing: '0.16em', color: 'var(--dim)' }, text: 'CREDITS' }),
    h('p', { class: 'help-credits', style: { font: '500 11px/1.5 var(--f-ui)', margin: '4px 0 0' } },
      h('span', { text: 'Kraken is free software by Sodwave (GPL-3.0). Sound engines: SLOOP and Clipper, and Felucca by Leo Kuroshita (Hügelton Instruments). MP3: LAME, through lamejs (LGPL-3.0). Plugins: the Web Audio Modules SDK (MIT).' }), ' ', lnk('https://lame.sourceforge.io', 'lame.sourceforge.io'), ' · ', lnk('https://github.com/zhuker/lamejs', 'github.com/zhuker/lamejs'))];
  const hm = modal('Help', [...(touch ? [...grid('FINGERS', TOUCH), ...grid('KEYBOARD & MOUSE', KEYS)] : [...grid('KEYBOARD & MOUSE', KEYS), ...grid('FINGERS (PHONE, TABLET)', TOUCH)]), ...credits], [['Close', null, true]]);
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
let clipboard = null, rangeClip = null;
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
    if (mod && k === 'e' && app.lastArea !== 'bot') { e.preventDefault(); app.splitAt(); return; }
    if (mod && k === 'j') { e.preventDefault(); app.joinSelected(); return; }
    if (mod && e.shiftKey && (k === 'c' || k === 'x' || k === 'v')) { e.preventDefault(); app.rangeAction(k === 'c' ? 'copy' : k === 'x' ? 'cut' : 'paste'); return; }
    const many = app.selected();
    if (mod && (k === 'c' || k === 'x') && many.length > 1 && app.lastArea !== 'bot') {   // several clips: copied together, where they are
      e.preventDefault();
      const a = Math.min(...many.map(({ c }) => c.start));
      clipboard = { many: many.map(({ t: tt, c }) => ({ track: tt.id, kind: tt.kind, clip: { ...structuredClone(c), start: c.start - a } })), len: Math.max(...many.map(({ c }) => c.start + c.len)) - a };
      if (k === 'x') app.store.change((pp) => { const ids = new Set(many.map(({ c }) => c.id)); for (const tt of pp.tracks) tt.clips = tt.clips.filter((c) => !ids.has(c.id)); });
      toast(`${k === 'x' ? 'Cut' : 'Copied'} ${many.length} clips.`); return;
    }
    if (mod && k === 'v' && clipboard?.many && app.lastArea !== 'bot') {
      e.preventDefault();
      const at = floorBar(p, app.pos), ids = [];
      app.store.change((pp) => { for (const x of clipboard.many) { const tt = pp.tracks.find((q) => q.id === x.track); if (!tt) continue; const c = { ...structuredClone(x.clip), id: uid('c'), start: at + x.clip.start }; tt.clips = cutRange(tt.clips, c.start, c.start + c.len, pp.bpm); tt.clips.push(c); ids.push(c.id); } });
      v.sel = new Set(ids); v.selClip = ids.at(-1) ?? null; app.store.emit('select'); return;
    }
    if (mod && k === 'd' && many.length > 1 && app.lastArea !== 'bot') {
      e.preventDefault();
      const a = Math.min(...many.map(({ c }) => c.start)), len = Math.max(...many.map(({ c }) => c.start + c.len)) - a, ids = [];
      app.store.change((pp) => { for (const { t: tt, c } of many) { const x = pp.tracks.find((q) => q.id === tt.id); const d = { ...structuredClone(c), id: uid('c'), start: c.start + len }; x.clips = cutRange(x.clips, d.start, d.start + d.len, pp.bpm); x.clips.push(d); ids.push(d.id); } });
      v.sel = new Set(ids); v.selClip = ids.at(-1); app.store.emit('select'); return;
    }
    if (mod && k === 'a' && app.lastArea === 'arr') { e.preventDefault(); v.sel = new Set(p.tracks.flatMap((tt) => tt.clips.map((c) => c.id))); app.store.emit('select'); toast(`${v.sel.size} clips selected.`); return; }
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
      if ((clipboard.kind === 'audio') !== (t.kind === 'audio') || (clipboard.kind === 'drum') !== (t.kind === 'drum') || (t.kind === 'group' || t.kind === 'vca')) { toast(`That clip belongs on ${clipboard.kind === 'audio' ? 'an audio' : clipboard.kind === 'drum' ? 'a drum' : 'an instrument'} track.`); return; }
      const c = { ...structuredClone(clipboard.clip), id: uid('c'), start: floorBar(p, app.pos) };
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
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.selected().length > 1) {
      e.preventDefault();                                        // several clips selected: they go
      const ids = new Set(app.selected().map(({ c }) => c.id));
      app.store.change((pp) => { for (const tr of pp.tracks) tr.clips = tr.clips.filter((c) => !ids.has(c.id)); });
      v.sel.clear(); app.selectClip(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !clip && t) {
      e.preventDefault();
      app.deleteTrack(t.id);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && clip) {
      e.preventDefault();                                        // the selected clips (one or many)
      const ids = new Set(app.selected().map(({ c }) => c.id)); ids.add(clip.id);
      app.store.change((pp) => { for (const tr of pp.tracks) tr.clips = tr.clips.filter((c) => !ids.has(c.id)); });
      v.sel?.clear();
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
  $('sigbtn').onclick = () => signatureDialog(app.pos);
  $('takesbtn').onclick = () => { const on = app.store.p.recTakes === false; app.store.change((p) => { p.recTakes = on; }); toast(on ? 'Loop recording: each pass is a take; comp them in the take lanes (the TAKES badge on the clip).' : 'Loop recording: the passes add up (overdub).'); };
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
    else if (/\.dawproject$/i.test(f.name)) { try { await openDawproject(await unzip(new Uint8Array(await f.arrayBuffer()))); } catch (e) { toast(e.message); } }
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
initI18n().catch(() => {}).finally(boot);      // French on screen first when it is French (i18n.js)
