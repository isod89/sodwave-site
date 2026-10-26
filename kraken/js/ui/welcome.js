// SPDX-License-Identifier: GPL-3.0-only
// The first minutes: a welcome that starts a song in a style (or the demo, or nothing), and a short tour that points
// at the six things to know, one at a time, on the screen itself.
import { h } from './kit.js';
import { STARTERS, FAMILIES, starterProject } from '../templates.js';
import { newProject, newTrack } from '../project.js';
import { listPresets } from '../presets.js';
import { openTemplate } from './presets.js';

const touch = () => matchMedia('(pointer: coarse)').matches;
const phone = () => matchMedia('(max-width: 700px), (max-height: 520px) and (pointer: coarse)').matches;

export function welcome(app, { modal, first = false }) {
  const tour = h('input', { type: 'checkbox', id: 'wel-tour', checked: first ? true : null });
  const go = (make) => () => {
    m.close();
    const p = make();
    if (p) {
      app.load(p);
      const t = p.tracks.find((x) => x.clips.length);              // its first clip open in the editor: ready to change
      if (t) { app.selectClip(t.clips[0].id, t.id); if (!phone()) app.showTab('edit'); }
    }
    try { localStorage.setItem('kraken.welcomed', '1'); } catch { /* */ }
    if (tour.checked) setTimeout(() => startTour(app), 350);
    else if (p) app.toast(touch() ? 'Tap ▶ to hear it, then change anything while it plays.' : 'Press Space to hear it, then change anything while it plays.');
  };
  const card = (title, sub, make, cls = '') => h('button', { class: 'wel-card ' + cls, onclick: go(make) }, h('b', { text: title }), h('span', { text: sub }));
  const fam = (name) => h('h4', { class: 'wel-fam', text: name });
  const cards = [
    ...FAMILIES.flatMap((f, i) => [fam(f), ...STARTERS.filter((s) => s.fam === i).map((s) => card(s.name, `${s.bpm} BPM · ${s.text}`, () => starterProject(app.lib, s.id), 'starter'))]),
    fam('Or start from'),
    card('The demo song', 'First Dive: hear what Kraken does', () => null, 'other'),
    card('Empty', 'A drum track and a synth, nothing written', () => {
      const p = newProject(); p.name = 'Untitled';
      p.tracks = [newTrack('drum', 0, { kit: app.lib.sloop.kits.indexOf('909') }), newTrack('synth', 1, { bank: 'clipper', engine: app.lib.clipper.engines.findIndex((e) => e.name === 'HYBRID') })];
      return p;
    }, 'other'),
  ];
  const m = modal(first ? 'Welcome to Kraken' : 'Start a song', [
    h('p', { class: 'hint', text: first ? 'The SLOOP and Clipper engines in a full studio, free. Pick a style: a song starts playing, ready for you to change it.' : 'A song in a style, ready to change. What you have now stays one Ctrl+Z away (and in PROJECT > Earlier versions).' }),
    h('div', { class: 'wel-grid' }, cards),
    h('label', { class: 'rep-check', for: 'wel-tour' }, tour, h('span', { text: 'Show me around (one minute)' })),
    h('p', { class: 'hint', text: `Already have a song? ${touch() ? '☰' : 'PROJECT'} > Open…, or a SLOOP song (.sloopsong).` }),
  ], [['Close', () => { try { localStorage.setItem('kraken.welcomed', '1'); } catch { /* */ } }]]);
  m.box.classList.add('wel');
  // your own templates first (PROJECT > Save as a template)
  listPresets().then((all) => {
    const mine = all.filter((x) => x.kind === 'template');
    const grid = m.box.querySelector('.wel-grid');
    if (!mine.length || !grid) return;
    grid.prepend(fam('Your templates'), ...mine.map((q) => h('button', { class: 'wel-card mine', onclick: () => { m.close(); try { localStorage.setItem('kraken.welcomed', '1'); } catch { /* */ } openTemplate(app, q).catch((e) => app.toast(e.message)); } },
      h('b', { text: `★ ${q.name}` }), h('span', { text: 'Your template' }))));
  });
  return m;
}

// ------------------------------------------------------------------- the tour ---
function steps() {
  const ph = phone();
  return [
    { sel: '#play', text: ph ? 'Tap ▶ to hear your song. It loops: change anything while it plays.' : 'Press ▶ (or Space) to hear your song. It loops: change anything while it plays.' },
    { sel: '#lanes', pre: ph ? () => document.querySelector('#mnav [data-m="arr"]')?.click() : null, text: ph ? 'Your song: one lane per track. Tap a clip to pick it, double-tap to edit it, hold it to move it or for its menu.'
      : 'Your song: one lane per track. Click a clip to edit it below, drag it to move it, double-click an empty spot for a new one.' },
    { sel: ph ? '#mnav [data-m="bot"]' : '#bot', text: ph ? 'EDIT: the clip you picked. Tap to add notes or hits, drag to make them longer, double-tap to remove one.'
      : 'The clip editor: click to add notes or hits, drag to make them longer, double-click to remove one. Try it while it plays.' },
    { sel: ph ? '#mnav [data-m="lib"]' : '#libbtn', text: 'SOUNDS: hundreds of SLOOP and Clipper sounds. Pick one: the selected track plays it at once.' },
    { sel: ph ? '#bot .tab[data-tab="device"]' : '#bot .tab[data-tab="mixer"]', pre: ph ? () => document.querySelector('#mnav [data-m="bot"]')?.click() : null, text: ph ? 'SOUND: every knob of the instrument, its note effects and audio effects. MIXER: levels, pan and sends.'
      : 'MIXER: levels, pan, sends and effects. INSTRUMENT: every knob of the sound, note effects, modulators.' },
    { sel: '#filebtn', text: `Kraken saves your work by itself. ${ph ? '☰' : 'PROJECT'}: save a file, export WAV, FLAC, MP3 or Opus, start another song, Help, and Report a problem if anything goes wrong.` },
  ];
}
let endTour = null;
export function startTour(app) {
  endTour?.();                                                     // (a tour already running: ended properly first)
  const list = steps();
  let i = 0;
  const hole = h('div', { class: 'tour-hole' }), tip = h('div', { class: 'tour-tip', role: 'dialog', 'aria-label': 'Tour' });
  const root = h('div', { class: 'tour' }, hole, tip);
  const end = () => { root.remove(); window.removeEventListener('resize', show); document.removeEventListener('keydown', key, true); endTour = null; app.logAct?.('tour: end'); };
  endTour = end;
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); end(); } else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); } };
  const next = () => { if (++i >= list.length) end(); else show(); };
  function show() {
    const st = list[i];
    if (st.pre && !st.done) { st.done = true; st.pre(); requestAnimationFrame(show); return; }   // (a phone: the view that has it first)
    const el = document.querySelector(st.sel);
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    if (r && r.width) Object.assign(hole.style, { display: 'block', left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
    else hole.style.display = 'none';
    tip.replaceChildren(h('small', { text: `${i + 1} / ${list.length}` }), h('p', { text: st.text }),
      h('div', { class: 'row' }, h('button', { class: 'add', onclick: end }, 'Skip'), h('button', { class: 'add go', onclick: next }, i === list.length - 1 ? 'Done' : 'Next')));
    // the bubble beside the spot, on screen
    const W = Math.min(320, innerWidth - 24);
    tip.style.width = `${W}px`;
    const th = tip.offsetHeight || 140;
    let x = r ? r.left + r.width / 2 - W / 2 : (innerWidth - W) / 2, y = r ? (r.bottom + 14 + th < innerHeight ? r.bottom + 14 : r.top - 14 - th) : (innerHeight - th) / 2;
    if (r && (y < 8 || r.height > innerHeight * 0.5)) y = Math.min(innerHeight - th - 12, Math.max(12, r.top + 20));
    x = Math.max(12, Math.min(innerWidth - W - 12, x));
    Object.assign(tip.style, { left: `${x}px`, top: `${Math.max(8, y)}px` });
    tip.querySelector('.go')?.focus({ preventScroll: true });
  }
  document.body.append(root);
  window.addEventListener('resize', show);
  document.addEventListener('keydown', key, true);
  app.logAct?.('tour: start');
  show();
}
