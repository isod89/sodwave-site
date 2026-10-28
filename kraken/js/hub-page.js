// SPDX-License-Identifier: GPL-3.0-only
// The hub's own page (hub.html, www.sodwave.com/hub): the Kraken hub without opening the DAW. Browse, search, listen,
// sign in, like, follow, install presets and plugins (they land in this browser's Kraken), and the way into the LAB.
// The same hub as in Kraken (ui/hub.js), given a small stand-in for the app: what needs the DAW (open a song, publish)
// opens Kraken; LISTEN renders with the same engines, in a worker, as Kraken does.
import { h } from './ui/kit.js';
import { initI18n, toggleLang, getLang, onLang } from './i18n.js';
import { initHub } from './ui/hub.js';
import { session, toOfficialHost } from './hub.js';
import { landing } from './hub-landing.js';
import { loadEngines } from './audio.js';
import { RATE, beatsToSeconds } from './engine-core.js';
import { wamPlan } from './wam.js';
import { validatePatch } from './lab-modules.js';
import { addPreset } from './presets.js';

const $ = (id) => document.getElementById(id);
const KRAKEN = './';                                             // the DAW, beside this page
const go = (q = '') => { location.href = KRAKEN + q; };

// ------------------------------------------------------------------ messages and dialogs (as in Kraken)
let toastTimer = 0;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false; toast.at = performance.now();
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, Math.min(7000, Math.max(2600, text.length * 50)));
}
document.addEventListener('pointerdown', () => { const t = $('toast'); if (!t.hidden && performance.now() - (toast.at || 0) > 400) t.hidden = true; }, true);
function modal(title, body, buttons) {
  const bg = h('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h3', { text: title }), ...body,
    buttons.length ? h('div', { class: 'row' }, buttons.map(([label, fn, primary]) => h('button', { class: 'add' + (primary ? ' go' : ''), onclick: () => { close(); fn?.(); } }, label))) : null);
  bg.append(box);
  $('toast').hidden = true;
  bg.addEventListener('pointerdown', (e) => { if (e.target === bg && buttons.length) close(); });
  bg.addEventListener('keydown', (e) => { e.stopPropagation(); });
  const esc = (e) => { if (e.key === 'Escape' && bg.isConnected && document.querySelector('.modal-bg:last-of-type') === bg) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  new MutationObserver((_m, o) => { if (!bg.isConnected) { document.removeEventListener('keydown', esc, true); o.disconnect(); } }).observe(document.body, { childList: true });
  document.body.append(bg);
  box.querySelector('.go')?.focus({ preventScroll: true });
  return { close, box };
}
function confirmBox(title, text, ok, fn, danger = false) {
  modal(title, [h('p', { text })], [['Cancel'], [ok, fn, true]]);
  if (danger) document.querySelector('.modal-bg:last-child .go')?.classList.add('danger');
}
function sheet(title, items) {
  return modal(title, [h('div', { class: 'sheet' }, items.map(([label, fn, kind]) => h('button', { class: 'add' + (kind ? ' ' + kind : ''), onclick: () => { document.querySelector('.modal-bg:last-child')?.remove(); fn(); } }, label)))], [['Cancel']]);
}

// ------------------------------------------------------------------ LISTEN: the same engines, in a worker
const audio = {
  ctx: null,
  mods: null,
  wake() {                                                       // (made on a click: browsers let it play)
    if (!this.ctx) { try { this.ctx = new AudioContext(); } catch { /* no Web Audio */ } }
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
  },
  async render(project, { end = null, tail = 1, assets = {} } = {}) {
    if (Object.keys(wamPlan(project).tracks).length) throw new Error('This song uses web plugins: listen to it in Kraken.');
    this.mods ||= (await loadEngines()).modules;
    const seconds = beatsToSeconds(project, end) + tail, exact = Math.round(seconds * RATE), frames = Math.ceil(seconds * RATE / 128) * 128;
    const [L, R] = await new Promise((resolve, reject) => {
      const w = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module', name: 'kraken-render' });
      const done = (f) => { try { w.terminate(); } catch { /* */ } f(); };
      w.onmessage = ({ data }) => done(() => (data.error ? reject(new Error(data.error)) : resolve([data.L, data.R])));
      w.onerror = (e) => { e.preventDefault?.(); done(() => reject(new Error(e.message || 'render worker failed'))); };
      const job = { project, assets, start: 0, frames };
      try { w.postMessage({ ...job, modules: { sloop: this.mods.sloop, clipper: this.mods.clipper } }); }
      catch { w.postMessage({ ...job, wasm: this.mods.bytes }); }
    });
    this.wake();
    return [L.subarray(0, exact), R.subarray(0, exact)];
  },
};
document.addEventListener('pointerdown', () => audio.wake(), { capture: true, passive: true });

// ------------------------------------------------------------------ the stand-in for Kraken
const app = {
  standalone: true,
  toast, modal, confirm: confirmBox, sheet,
  logAct: () => {},
  audio,
  assets: new Map(),                                             // (the songs' own samples live in Kraken: generated sounds still play)
  playing: false,
  play() {},
  store: { p: null },
  // the LAB: in Kraken (it plays through the DAW's engine)
  labStart: () => go('?lab'),
  // a plugin installed here is in this browser's Kraken (MY PATCHES), the same storage
  async installLab(raw, meta = {}) {
    const kind = raw?.kind === 'fx' ? 'fx' : 'inst', patch = validatePatch(structuredClone(raw), kind), name = String(meta.name || patch.name).slice(0, 40);
    patch.name = name;
    await addPreset({ kind: 'lab', type: kind, name, data: patch, from: meta.from || null });
    modal(`${name} is in your patches`, [h('p', { class: 'hint', text: 'It is in Kraken now, in the LAB\'s patches: open the LAB to play it, change it, or see how it is made.' })],
      [['Later'], ['◈ Open the LAB', () => go('?lab'), true]]);
    return patch;
  },
  async labOpenPatch(raw, meta = {}) { await app.installLab(raw, meta); },
};

// ------------------------------------------------------------------ the page
if (toOfficialHost()) await new Promise(() => {});                 // (sodwave.com/…: on its way to www.sodwave.com/…)
await initI18n().catch(() => {});
const langBtn = $('lang');
const showLang = () => { langBtn.textContent = getLang() === 'fr' ? 'EN' : 'FR'; langBtn.title = getLang() === 'fr' ? 'Switch to English' : 'Passer en français'; };
langBtn.onclick = () => toggleLang().then(showLang);
onLang(showLang);
showLang();
$('lab').onclick = () => go('?lab');

const linked = initHub(app);                                    // (opened by the email's link: signing in, the hub shown)
const hub = app.hub;
// what needs the DAW: Kraken opens, on this item
hub.openSong = (it) => go(`?hub=${encodeURIComponent(it.id)}`);
hub.publish = () => modal('Publish from Kraken', [h('p', { class: 'hint', text: 'Songs, presets and plugins are published from Kraken, where they are made: PROJECT > Publish to the hub, or ☁ PUBLISH in the LAB. You stay signed in.' })],
  [['Cancel'], ['Open Kraken', () => go(), true]]);
hub.publishLab = hub.publish;
// a link to one item or one person: /hub.html?item=ID, ?user=ID (the share links open Kraken; these stay here)
const q = new URLSearchParams(location.search);
const item = q.get('item'), user = q.get('user'), tab = q.get('tab'), kind = q.get('kind');
if (kind && ['song', 'preset', 'plugin', 'template'].includes(kind)) hub.filters.kind = kind;
const target = /^\d{1,9}$/.test(item || '') ? { item: +item } : /^\d{1,9}$/.test(user || '') ? { user: +user } : ['discover', 'following', 'people', 'world', 'me'].includes(tab) ? tab : null;
// someone not signed in, on the plain address: the front page first (hub-landing.js); else the hub itself
const front = landing({ open: (t) => showHub(t), openKraken: () => go(), signedIn: (r) => hub.signedIn(r) });
front.hidden = true;
document.body.append(front);
async function showHub(t = null) {
  front.hidden = true;
  document.body.classList.remove('landing');
  await hub.open(t || 'discover');
}
function showFront() {
  hub.bg && (hub.bg.hidden = true);
  front.hidden = false;
  document.body.classList.add('landing');
  front.scrollTop = 0;
}
$('explore').onclick = () => showHub('discover');
$('signin').onclick = () => (session.token ? showHub('me') : (showFront(), setTimeout(() => front.querySelector('#lp-email-1')?.focus({ preventScroll: false }), 50)));
document.querySelector('.site-bar .brand').addEventListener('click', (e) => { if (!session.token) { e.preventDefault(); showFront(); } });
const signLabel = () => { $('signin').textContent = session.token ? 'MY PROFILE' : 'SIGN IN'; };
signLabel(); setInterval(signLabel, 2000);                          // (signed in or out from the hub itself)
hub.onSignedIn = () => { front.hidden = true; document.body.classList.remove('landing'); signLabel(); };
if (!linked) await hub.ready;                                     // (a session the page lost, given back by the API's cookie)
signLabel();
if (linked) { front.hidden = true; document.body.classList.remove('landing'); }
else if (target || session.token) await showHub(target); else showFront();
document.body.classList.add('ready');
