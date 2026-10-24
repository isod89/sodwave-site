// SPDX-License-Identifier: GPL-3.0-only
// The interface in French (or English), switched at any time, without touching the UI modules: they keep writing
// English, and this layer translates what reaches the screen.
//  - The DOM: a MutationObserver translates text nodes and the title, placeholder, aria-label and label attributes
//    (and the value of input buttons) as they appear or change, dialogs, menus and toasts included. The English
//    stays beside each node (WeakMaps), so going back to English needs no reload.
//  - Canvases: fillText / strokeText / measureText translate the labels they draw (LOOP, LENGTH, hints…) through a
//    small canvas-only dictionary: one Map lookup per call, a cache in front of the few dynamic patterns.
//  - Only whole strings are translated: a text is French when it is exactly in the dictionary, or matches one of
//    its pattern rules (or is made of such parts joined by " · "). Everything else, the names people type
//    included, is left alone. Names are also protected by place (track, clip, scene, sound, preset, sample names,
//    inputs, editable text, translate="no"): a track called "LOOP" stays "LOOP". The few words that are both a
//    label and a likely name (KEYS, BASS, LOOP…) are only translated where they are a label (fr.js `scoped`).
//    On a canvas there is no place to tell: the canvas dictionary is kept to the labels the canvases draw, and on
//    the arrangement's lanes (which draw clip names) the ones a clip could be called stay as they are.
// The audio thread never imports this (it has no DOM).

const KEY = 'kraken.lang';
let lang = 'en', tr = null, trCanvas = null, observer = null, ready = null;
const listeners = new Set();

// ---------------------------------------------------------------- the translator (pure: also used in Node) ---
// d: fr.js. rules: [[/^…$/, (m, t) => string | null]], t translates a part (or gives it back as it is).
export function translator(d, { canvasOnly = false } = {}) {
  const map = new Map(Object.entries(canvasOnly ? d.canvas || {} : d.dict));            // (two separate worlds: a canvas
  const rules = canvasOnly ? d.canvasRules || [] : d.rules || [];                       //  label is not an interface word)
  const keep = new Set(d.keep || []), keepRules = d.keepRules || [];
  const scoped = canvasOnly ? new Map() : new Map(Object.entries(d.scoped || {}));
  const cache = new Map();
  const part = (s) => one(s) ?? s;
  function one(s) {                                               // s: trimmed; French, or null when unknown
    const v = map.get(s);
    if (v !== undefined) return v;
    if (keep.has(s)) return null;
    for (const [re, fn] of rules) {
      const m = re.exec(s);
      if (m) { const r = fn(m, part); if (r != null) return r; }
    }
    if (s.includes(' ') && !/[a-z]/.test(s)) {                   // a phrase put in capitals by the code: as written
      const low = map.get(s.toLowerCase()) ?? map.get(s[0] + s.slice(1).toLowerCase());
      if (low !== undefined) return low.toUpperCase();
    }
    if (s.includes(' · ')) {                                     // LABEL · VALUE · …: each part on its own
      let changed = false;
      const out = s.split(' · ').map((p) => { const r = one(p.trim()); if (r != null && r !== p.trim()) { changed = true; return r; } return p; });
      if (changed) return out.join(' · ');
    }
    return null;
  }
  // French typography: a no-break space before : ; ! ? and inside « »
  const typo = (s) => s.replace(/ ([:;!?»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
  // the French of a whole string (the spaces around it kept), or null; el: where it shows (for the scoped words)
  function french(s, el = null) {
    if (typeof s !== 'string' || s.length < 2) return null;
    if (el && scoped.size) {
      const sc = scoped.get(s.trim());
      if (sc) for (const [sel, fr] of sc) if (el.closest(sel)) return s.replace(s.trim(), fr);   // (elsewhere: the dictionary, if at all)
    }
    let r = cache.get(s);
    if (r !== undefined) return r;
    const t = s.trim();
    r = null;
    if (t && /[A-Za-z]/.test(t)) {
      const f = one(t);
      if (f != null && f !== t) { const i = s.indexOf(t); r = typo(s.slice(0, i) + f + s.slice(i + t.length)); }
    }
    if (cache.size > 5000) cache.clear();
    cache.set(s, r);
    return r;
  }
  // covered: French, or deliberately the same (a name, an abbreviation); for compound strings, every worded part
  function covers(s) {
    const t = s.trim();
    if (!/[A-Za-z]{2}/.test(t) || keep.has(t) || scoped.has(t) || keepRules.some((re) => re.test(t)) || one(t) != null) return true;
    if (t.includes(' · ')) return t.split(' · ').every((p) => covers(p));
    return false;
  }
  const slots = new Set(d.slots || []);
  return { french, text: (s) => french(s) ?? s, covers, one, slot: (s) => slots.has(s.trim()) };
}

// ---------------------------------------------------------------- the language ---
// the saved choice, else French when the browser speaks French, else English
export function chosenLang() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* blocked storage */ }
  if (saved === 'en' || saved === 'fr') return saved;
  const nav = (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || '';
  return /^fr\b/i.test(nav) ? 'fr' : 'en';
}
export const getLang = () => lang;
// a string for code that builds text itself (most code needs nothing: the DOM is translated as it changes)
export const t = (s) => (lang === 'fr' && tr ? tr.text(s) : s);
export const onLang = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// ---------------------------------------------------------------- the DOM ---
const ATTRS = ['title', 'placeholder', 'aria-label', 'label', 'value'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);
// names a person types or picks (tracks, clips, scenes, sounds, presets, samples, devices), and the knobs' own
// labels (parameter names stay as on the hardware): never translated, wherever they show
// a plugin's own panel (a Web Audio Module's GUI): someone else's page, never touched (not even looked at)
const FOREIGN = '.wam-gui';
const USER = [
  '[translate="no"]', '.notranslate', '[contenteditable="true"]', '[contenteditable=""]',
  '.head .name', '.strip .sname', '.slot .cname', '#scene-bar .sname', '.sound-lcd .pre', '.rack-head em',
  '.item > span:first-child', '.smp-name', '.preset-row > span:first-child', '.recover-row b', '.ctl-dev[title]', '.tab-info', '.knob .lbl',
  '.collab-people span', '.wam-known .add', '.wam-param span', '.wam-screen .pre', FOREIGN,
].join(',');
const textOrig = new WeakMap();                                  // text node -> { en, fr }
const attrOrig = new WeakMap();                                  // element -> { [attr]: { en, fr } }

function doText(node) {
  const s = node.data, o = textOrig.get(node);
  if (o && s === o.fr) return;                                   // ours
  const el = node.parentElement;
  const f = el && /[A-Za-z]/.test(s) ? tr.french(s, el) : null;  // (a cached lookup first: most text is not in the dictionary)
  if (f == null || SKIP_TAGS.has(el.tagName) || (el.closest(USER) && !tr.slot(s))) { if (o) textOrig.delete(node); return; }
  textOrig.set(node, { en: s, fr: f });
  node.data = f;
}
function doAttr(el, a) {
  if (a === 'value' && !(el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type))) return;
  if (a === 'label' && el.tagName !== 'OPTGROUP' && el.tagName !== 'OPTION') return;
  const s = el.getAttribute(a);
  if (s == null || s.length < 2) return;
  let o = attrOrig.get(el);
  if (o?.[a] && s === o[a].fr) return;                            // ours
  const f = tr.french(s, el);
  if (f == null || el.closest('[translate="no"], .notranslate, .knob, ' + FOREIGN)) { if (o?.[a]) delete o[a]; return; }
  const name = el.closest(USER)?.textContent.trim();               // a name's own tooltip (the name, maybe more): left alone
  if (name && s.includes(name)) return;
  if (!o) attrOrig.set(el, (o = {}));
  o[a] = { en: s, fr: f };
  el.setAttribute(a, f);
}
function doElement(el) {
  if (el.hasAttributes()) for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a);
}
const SKIP_TREE = { acceptNode: (n) => (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.tagName === 'STYLE' || n.matches(FOREIGN)) ? 2 /* reject */ : 1) };
function doTree(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType === 1) { if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return; doElement(root); }
  else if (root.nodeType !== 9 && root.nodeType !== 11) return;
  const w = document.createTreeWalker(root, 5 /* elements and text */, SKIP_TREE);
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) doText(n); else doElement(n); }
}
function undoTree(root) {
  const w = document.createTreeWalker(root, 5);
  for (let n = w.currentNode; n; n = w.nextNode()) {
    if (n.nodeType === 3) { const o = textOrig.get(n); if (o) { if (n.data === o.fr) n.data = o.en; textOrig.delete(n); } continue; }
    if (n.nodeType !== 1) continue;
    const o = attrOrig.get(n);
    if (o) { for (const [a, v] of Object.entries(o)) if (n.getAttribute(a) === v.fr) n.setAttribute(a, v.en); attrOrig.delete(n); }
  }
}
function onMutations(list) {
  for (const m of list) {
    const at = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    if (at?.closest(FOREIGN)) continue;
    if (m.type === 'characterData') doText(m.target);
    else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
    else for (const n of m.addedNodes) if (n.isConnected) doTree(n);
  }
}
function observe(on) {
  if (!observer) observer = new MutationObserver(onMutations);
  if (on) observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  else { onMutations(observer.takeRecords()); observer.disconnect(); }
}

// ---------------------------------------------------------------- canvases ---
// one Map lookup per call (a cache in front of the few patterns); the arrangement's lanes also draw clip names:
// there, the labels a clip could be called (LOOP…) stay as they are
let canvasOn = false, lanesKeep = new Set();
const canvasText = (ctx, s) => (canvasOn && typeof s === 'string' && !(lanesKeep.has(s) && ctx.canvas?.id === 'lanes-cv') ? trCanvas.french(s) ?? s : s);
function patchCanvas() {
  for (const C of [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]) {
    const P = C?.prototype;
    if (!P || P.fillText.i18n) continue;
    const fill = P.fillText, stroke = P.strokeText, measure = P.measureText;
    P.fillText = function (s, x, y, w) { return w === undefined ? fill.call(this, canvasText(this, s), x, y) : fill.call(this, canvasText(this, s), x, y, w); };
    P.strokeText = function (s, x, y, w) { return w === undefined ? stroke.call(this, canvasText(this, s), x, y) : stroke.call(this, canvasText(this, s), x, y, w); };
    P.measureText = function (s) { return measure.call(this, canvasText(this, s)); };
    P.fillText.i18n = true;
  }
}
// the canvases draw again (each view redraws when the window resizes)
function redrawCanvases() { try { window.dispatchEvent(new Event('resize')); } catch { /* not in a page */ } }

async function load() {
  if (!ready) ready = import('./i18n/fr.js').then((d) => { tr = translator(d); trCanvas = translator(d, { canvasOnly: true }); lanesKeep = new Set(d.lanesKeep || []); });
  return ready;
}

// at start, before the interface is built: the language, and French on screen when it is French
export async function initI18n() {
  lang = chosenLang();
  document.documentElement.lang = lang;
  patchCanvas();
  if (lang === 'fr') await apply('fr', false);
  return lang;
}
async function apply(l, redraw = true) {
  if (l === 'fr') {
    await load();
    lang = 'fr'; canvasOn = true;
    doTree(document.documentElement);
    observe(true);
  } else {
    lang = 'en'; canvasOn = false;
    if (observer) observe(false);
    undoTree(document.documentElement);
  }
  document.documentElement.lang = lang;
  if (redraw) redrawCanvases();
  for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
}
// switch now (no reload), and next time
export async function setLang(l) {
  l = l === 'fr' ? 'fr' : 'en';
  try { localStorage.setItem(KEY, l); } catch { /* blocked storage: for this visit only */ }
  if (l !== lang) await apply(l);
  return lang;
}
export const toggleLang = () => setLang(lang === 'fr' ? 'en' : 'fr');
