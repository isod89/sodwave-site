// SPDX-License-Identifier: GPL-3.0-only
// The project's macros, in the mixer: eight knobs, each one turning any number of parameters of any tracks at once
// (a filter here, a send there, a reverb mix elsewhere), each over its own range. MAP, then a click on any knob, fader
// or send of any track adds a target; a macro is automated in its lane (+ TRACK > Macro lane) and MIDI-learnable.
import { h, knob } from './kit.js';
import { autoTargets } from './arrange.js';

// a learn id (a knob's data-learn) as a macro target { track, key }, or null
export function learnTarget(id, app) {
  const [a, b, c, d] = String(id).split(':');
  const sel = app.view.selTrack;
  if (a === 'sel' && b === 'p') return sel ? { track: sel, key: `p${c}` } : null;
  if (a === 'sel' && /^(vol|pan|send\d+)$/.test(b)) return sel ? { track: sel, key: b } : null;
  if (a === 't' && /^(vol|pan|send\d+)$/.test(c)) return { track: b, key: c };
  if (a === 't' && c === 'p') return { track: b, key: `p${d}` };
  if ((a === 'fx' || a === 'nfx') && b && c && d) return { track: b, key: `${a}:${c}:${d}` };
  return null;
}
const targetInfo = (app, tg) => {
  const t = app.store.track(tg.track);
  const spec = t && autoTargets(app, t).find((x) => x.key === tg.key);
  return { t, spec, label: `${t?.name || '?'} · ${spec?.label || tg.key}` };
};

export function macrosStrip(app) {
  const p = app.store.p, store = app.store;
  const knobs = p.macros.slice(0, 8).map((m, i) => {
    const k = knob({ label: m.name, min: 0, max: 1, step: 0.005, value: m.v, def: 0, size: 30, color: m.to.length ? '#ffc21a' : '#5b6066',
      format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => store.change((pp) => { pp.macros[i].v = v; }, `macro${i}`), onEnd: () => store.endGesture() });
    k.dataset.learn = `macro:${i}`;
    k.title = `${m.name}: ${m.to.length ? `${m.to.length} target${m.to.length > 1 ? 's' : ''}` : 'no target yet'} · click its name to set it up`;
    const lbl = k.querySelector('.lbl');
    lbl.style.cursor = 'pointer';
    lbl.addEventListener('pointerdown', (e) => e.stopPropagation());
    lbl.addEventListener('click', (e) => { e.stopPropagation(); macroDialog(app, i); });
    if (m.to.length) k.append(h('i', { class: 'macro-n', text: String(m.to.length) }));
    return k;
  });
  const strip = h('div', { class: 'strip macros', '--c': '#ffc21a' },
    h('div', { class: 'sname', text: 'MACROS', title: 'Eight knobs for the whole project: each one turns many parameters at once' }),
    h('div', { class: 'macro-grid' }, knobs),
    h('button', { class: 'add', title: 'The macros\' automation lane in the arrangement', onclick: () => app.showMacroLane(0) }, 'LANE'));
  strip.update = () => p.macros.slice(0, 8).forEach((m, i) => knobs[i].setValue(app.store.p.macros[i].v));
  return strip;
}

// one macro: its name, its targets with their ranges, MAP to add one, its lane
export function macroDialog(app, i) {
  const store = app.store, m = store.p.macros[i];
  const name = h('input', { value: m.name, maxlength: 16, 'aria-label': 'Macro name', onkeydown: (e) => e.stopPropagation(),
    onchange: (e) => { const v = e.target.value.trim().toUpperCase().slice(0, 16); if (v) store.change((p) => { p.macros[i].name = v; }); } });
  const rows = m.to.map((tg, j) => {
    const { spec, label } = targetInfo(app, tg);
    const lo = spec?.min ?? 0, hi = spec?.max ?? 1, step = spec && hi - lo > 20 ? 1 : 0.01;
    const num = (field) => h('input', { type: 'number', step, min: Math.min(lo, hi), max: Math.max(lo, hi), value: +tg[field].toFixed(3), 'aria-label': `${label} ${field === 'lo' ? 'at 0 %' : 'at 100 %'}`,
      onkeydown: (e) => e.stopPropagation(), onchange: (e) => { const v = +e.target.value; if (Number.isFinite(v)) store.change((p) => { p.macros[i].to[j][field] = v; }); } });
    return h('div', { class: 'macro-tgt' }, h('span', { text: label, title: label }), h('label', {}, '0 %', num('lo')), h('label', {}, '100 %', num('hi')),
      h('button', { class: 'tb', title: 'Remove this target', onclick: () => { store.change((p) => { p.macros[i].to.splice(j, 1); }); md.close(); macroDialog(app, i); } }, '×'));
  });
  const md = app.modal(`Macro ${i + 1}`, [
    h('label', { class: 'macro-name' }, 'NAME', name),
    h('p', { class: 'hint', text: rows.length ? 'Each target goes from its 0 % value to its 100 % value as the macro turns (set 100 % lower than 0 % to turn it the other way).' : 'No target yet: MAP, then click any knob, fader or send of any track.' }),
    h('div', { class: 'macro-tgts' }, rows),
  ], [['Automate', () => app.showMacroLane(i)], ['Map a knob…', () => mapMacro(app, i)], ['Done', null, true]]);
  md.box.classList.add('macro-dlg');
}

// MAP: the next click on a knob of any track becomes a target of macro i
export function mapMacro(app, i) {
  const banner = document.getElementById('learn-banner');
  const done = () => { document.removeEventListener('pointerdown', grab, true); document.removeEventListener('keydown', esc, true); banner.hidden = true; document.body.classList.remove('mapping'); };
  const grab = (e) => {
    if (e.target.closest('#learn-banner')) { done(); return; }
    const el = e.target.closest('[data-learn]');
    if (!el) { if (e.target.closest('.tab, #mnav button, .mixer, .device, .strip')) return; done(); return; }
    const tg = learnTarget(el.dataset.learn, app);
    if (!tg) { if (el.closest('.tab, #mnav')) return; e.preventDefault(); e.stopPropagation(); app.toast('That one cannot follow a macro: pick a knob, a fader or a send of a track.'); return; }
    e.preventDefault(); e.stopPropagation();
    done();
    const t = app.store.track(tg.track), spec = t && autoTargets(app, t).find((x) => x.key === tg.key);
    if (!spec) { app.toast('That one cannot follow a macro.'); return; }
    app.store.change((p) => { const m = p.macros[i]; if (!m.to.some((x) => x.track === tg.track && x.key === tg.key)) m.to.push({ track: tg.track, key: tg.key, lo: spec.min, hi: spec.max }); });
    app.toast(`${app.store.p.macros[i].name} now turns ${t.name} · ${spec.label}. Click its name to set the range.`);
  };
  const esc = (e) => { if (e.key === 'Escape') done(); };
  document.addEventListener('pointerdown', grab, true);
  document.addEventListener('keydown', esc, true);
  banner.textContent = `MAP ${app.store.p.macros[i].name}: ${matchMedia('(pointer: coarse)').matches ? 'tap' : 'click'} a knob, fader or send of any track · Esc or here to stop`;
  banner.hidden = false;
  document.body.classList.add('mapping');
}
