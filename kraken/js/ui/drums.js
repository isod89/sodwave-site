// SPDX-License-Identifier: GPL-3.0-only
// The drum track, sound by sound: each of the kit's 16 sounds with its own LEVEL, PAN, TUNE, DECAY, filter, DRIVE,
// CHOKE and MUTE (the engine's k_lane, on any kit), a mixer of the 16, and the DRUM SYNTH: your own synthesised kit,
// sound by sound, as on SLOOP's DRUM SYNTH page (drum_synth.c dsnd_t, the same 22 bytes, the same kit files).
import { h, knob } from './kit.js';
import { LANE_DEF } from '../project.js';
import { saveFile } from '../io.js';

// ------------------------------------------------------------------ the synthesised sound (SLOOP web/editor.html DSYN)
export const DSYN = {
  LANES: 16, SIZE: 22,
  FIELDS: ['wave', 'src', 'pitch', 'fine', 'bend', 'btime', 'hold', 'decay', 'tlev', 't2', 't2lev', 'click',
    'nlev', 'nhold', 'ndec', 'flt', 'fcut', 'fenv', 'hpf', 'chip', 'drive', 'level'],
  // the synthesised lanes (drum_synth.c DS_MAP order) and the GM note each plays without an offset
  LANES_N: ['KICK', 'SNARE', 'CLAP', 'HAT', 'OPEN HAT', 'LOW TOM', 'HI TOM', 'CRASH', 'RIDE', 'SHAKER', 'CONGA', 'RIM', 'COWBELL', 'CLAVE', 'KICK 2', 'SNARE 2'],
  LANE_NOTE: [36, 38, 39, 42, 46, 43, 48, 49, 51, 70, 63, 37, 56, 75, 35, 40],
  WAVES: ['OFF', 'SINE', 'TRI', 'SQUARE', 'FM', 'BELL'],
  NOISES: ['OFF', 'WHITE', 'METAL', 'CYM', 'CHIP'],
  FMODES: ['OFF', 'LP', 'BP', 'HP'],
  STEPS_PER_OCT: 127 / Math.log2(16000 / 30),
  decode(b) {
    const g = (k) => b[DSYN.FIELDS.indexOf(k)] & 255;
    const f = g('flt'), src = g('src'), fe = g('fenv');
    return { wave: g('wave'), noise: src & 15, clap: (src >> 4) & 1, pitch: g('pitch'), fine: g('fine'), bend: g('bend'), btime: g('btime'), hold: g('hold'), decay: g('decay'),
      tlev: g('tlev'), t2: g('t2'), t2lev: g('t2lev'), click: g('click'), nlev: g('nlev'), nhold: g('nhold'), ndec: g('ndec'), fmode: f & 3, fall: (f >> 2) & 1, res: f >> 3,
      fcut: g('fcut'), fenv: fe > 127 ? fe - 256 : fe, hpf: g('hpf'), chip: g('chip'), drive: g('drive'), level: g('level') };
  },
  encode(o) {
    const c = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));
    const v = { wave: c(o.wave, 0, 5), src: c(o.noise, 0, 4) | (o.clap ? 16 : 0), pitch: c(o.pitch, 0, 127), fine: c(o.fine, 0, 15), bend: c(o.bend, 0, 96), btime: c(o.btime, 0, 127),
      hold: c(o.hold, 0, 255), decay: c(o.decay, 0, 127), tlev: c(o.tlev, 0, 127), t2: c(o.t2, 0, 255), t2lev: c(o.t2lev, 0, 127), click: c(o.click, 0, 127), nlev: c(o.nlev, 0, 127),
      nhold: c(o.nhold, 0, 255), ndec: c(o.ndec, 0, 127), flt: c(o.fmode, 0, 3) | (o.fall ? 4 : 0) | (c(o.res, 0, 31) << 3), fcut: c(o.fcut, 0, 127), fenv: c(o.fenv, -128, 127) & 255,
      hpf: c(o.hpf, 0, 127), chip: c(o.chip, 0, 127), drive: c(o.drive, 0, 127), level: c(o.level, 0, 255) };
    return DSYN.FIELDS.map((k) => v[k]);
  },
  hz: (note, fine = 0) => 440 * 2 ** ((note + fine / 16 - 69) / 12),
  decayMs: (i) => 5 * 800 ** (i / 127),
  cutHz: (i) => 30 * (16000 / 30) ** (i / 127),
  db: (level) => (level - 128) / 4,
  FORMAT: 'sloop-drumsynth',
};
// a GM note -> its synthesised lane (drum_synth.c DS_MAP; 83 up: the shaker)
const DS_MAP = [14, 0, 11, 1, 2, 15, 5, 3, 5, 3, 5, 4, 6, 6, 7, 6, 8, 7, 8, 9, 7, 12, 7, 9, 8, 10, 10, 10, 10, 10, 6, 6, 12, 12, 9, 9, 13, 13, 9, 9, 13, 13, 13, 10, 10, 8, 8, 9];
const dsLaneOf = (note) => (note < 35 ? 0 : note >= 83 ? 9 : DS_MAP[note - 35]);
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s` : `${Math.round(v)}ms`);
const khz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`);
const NOTE12 = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nn = (n) => `${NOTE12[n % 12]}${Math.floor(n / 12) - 1}`;
// [key, label, min, max, format, names?] by group
const DS_GROUPS = [
  ['TONE', [['wave', 'WAVE', 0, 5, null, DSYN.WAVES], ['pitch', 'PITCH', 0, 127, (v) => nn(v)], ['fine', 'FINE', 0, 15, (v) => `+${v}/16`], ['bend', 'BEND', 0, 96, (v) => `${v}st`],
    ['btime', 'B.TIME', 0, 127, (v) => ms(DSYN.decayMs(v))], ['hold', 'HOLD', 0, 255, (v) => `${v * 2}ms`], ['decay', 'DECAY', 0, 127, (v) => ms(DSYN.decayMs(v))], ['tlev', 'LEVEL', 0, 127, (v) => v],
    ['t2', '2ND', 0, 255, (v) => (v ? `×${(v / 32).toFixed(2)}` : 'OFF')], ['t2lev', '2ND LVL', 0, 127, (v) => v], ['click', 'CLICK', 0, 127, (v) => v]]],
  ['NOISE', [['noise', 'NOISE', 0, 4, null, DSYN.NOISES], ['clap', 'CLAP', 0, 1, null, ['OFF', 'ON']], ['nlev', 'LEVEL', 0, 127, (v) => v], ['nhold', 'HOLD', 0, 255, (v) => `${v * 2}ms`],
    ['ndec', 'DECAY', 0, 127, (v) => ms(DSYN.decayMs(v))], ['hpf', 'HPF', 0, 127, (v) => (v ? khz(DSYN.cutHz(v)) : 'OFF')], ['chip', 'CHIP', 0, 127, (v) => (v ? khz(DSYN.hz(v) * 8) : '-')]]],
  ['FILTER', [['fmode', 'FILTER', 0, 3, null, DSYN.FMODES], ['fall', 'ON', 0, 1, null, ['NOISE', 'ALL']], ['fcut', 'CUTOFF', 0, 127, (v) => khz(DSYN.cutHz(v))],
    ['res', 'RES', 0, 31, (v) => `${Math.round((v * 100) / 31)}%`], ['fenv', 'ENV', -128, 127, (v) => `${v > 0 ? '+' : ''}${(v / DSYN.STEPS_PER_OCT).toFixed(1)}oct`]]],
  ['OUT', [['drive', 'DRIVE', 0, 127, (v) => v], ['level', 'LEVEL', 0, 255, (v) => `${v >= 128 ? '+' : ''}${DSYN.db(v).toFixed(1)}dB`]]],
];

// the factory synthesised kits, read from the engine itself (a spare drum instance on this page)
let spare = null;
function factory(app) {
  if (spare) return spare;
  const mod = app.modules?.sloop;
  if (!mod) return null;
  const w = new WebAssembly.Instance(mod, {}).exports;
  if (!w.k_dskit) return null;                                    // (an engine from before the drum synth)
  w.k_init(1);
  const n = w.k_dsnkits(), mem = () => new Uint8Array(w.memory.buffer);
  spare = { n, kit: (i) => ({ crush: w.k_dskit_crush(i), sounds: [...Array(16)].map((_, l) => Array.from(mem().slice(w.k_dskit(i) + l * 22, w.k_dskit(i) + (l + 1) * 22))) }) };
  return spare;
}
// the synth kits' names: the catalogue's kits after the five sampled ones (808 909 …)
const synthNames = (lib) => lib.kits.slice(5, 5 + 32);
export const synthKitIndex = (lib) => lib.kits.indexOf('SYN1');
export function newDrumSynth(app, src = 0) {
  const f = factory(app);
  if (!f) return null;
  const k = f.kit(src % f.n), name = synthNames(app.lib.sloop)[src] || 'MY KIT';
  return { name: name.slice(0, 8), crush: k.crush, src, sounds: k.sounds };
}
export const drumSynthReady = (app) => !!factory(app);

// ------------------------------------------------------------------ a kit sound, its own settings
const LANE_KNOBS = [
  ['lv', 'LEVEL', -60, 12, 0, 0.5, (v) => (v <= -60 ? 'OFF' : `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`)],
  ['pan', 'PAN', -1, 1, 0, 0.02, (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)],
  ['tune', 'TUNE', -8, 7, 0, 1, (v) => `${v > 0 ? '+' : ''}${v}st`],
  ['dec', 'DECAY', -4, 3, 0, 1, (v) => (v ? `${v > 0 ? '+' : ''}${v}` : 'KIT')],
  ['cut', 'CUTOFF', 0, 1000, 1000, 1, null],
  ['res', 'RESO', 0, 1, 0, 0.01, (v) => `${Math.round(v * 100)}%`],
  ['lc', 'LOW CUT', 0, 1000, 0, 1, null],
  ['drv', 'DRIVE', 0, 1, 0, 0.01, (v) => `${Math.round(v * 100)}%`],
];
const cutTo = (n) => 20 * 1000 ** (n / 1000), cutFrom = (hz) => Math.round(1000 * Math.log(Math.max(20, hz) / 20) / Math.log(1000));
const lcTo = (n) => (n <= 0 ? 0 : 20 * 100 ** (n / 1000)), lcFrom = (hz) => (hz <= 0 ? 0 : Math.round(1000 * Math.log(Math.max(20, hz) / 20) / Math.log(100)));
// a pad shows at once whether its sound has settings of its own (the project keeps only what differs from the kit)
function markPad(dev, t, l) {
  const n = dev.app.lib.sloop.laneNotes[l], own = !!dev.app.store.track(t.id)?.lanes?.[l];
  dev.wrap?.querySelector(`.pad[data-note="${n}"]`)?.classList.toggle('tweak', own);
}
// the kit's sound on pad n: its knobs, its choke group, mute, back to the kit
export function laneSound(dev, t, n, color) {
  const app = dev.app, lib = app.lib.sloop, l = lib.laneNotes.indexOf(n);
  if (l < 0) return [];
  const cur = () => ({ ...LANE_DEF, ...(app.store.track(t.id)?.lanes?.[l] || {}) });
  const set = (fn, tag) => { app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.lanes ||= {}; const q = { ...LANE_DEF, ...(x.lanes[l] || {}) }; fn(q); x.lanes[l] = q; }, tag); markPad(dev, t, l); };
  const q = cur();
  const knobs = LANE_KNOBS.map(([key, label, min, max, def, step, fmt]) => {
    const log = key === 'cut' || key === 'lc', to = key === 'cut' ? cutTo : lcTo, from = key === 'cut' ? cutFrom : lcFrom;
    return knob({ label, min, max, def, step, size: 30, color, value: log ? from(q[key]) : q[key],
      format: log ? (v) => (key === 'cut' ? (v >= 1000 ? 'OPEN' : `${khz(cutTo(v))}Hz`) : v <= 0 ? 'OFF' : `${khz(lcTo(v))}Hz`) : fmt,
      onChange: (v) => set((x) => { x[key] = log ? (key === 'cut' && v >= 1000 ? 20000 : Math.round(to(v))) : v; }, `lane${t.id}${l}${key}`), onEnd: () => app.store.endGesture() });
  });
  const choke = h('select', { 'aria-label': 'Choke group', title: 'Sounds of one group stop each other (a closed hat stops the open one)', onchange: (e) => set((x) => { x.choke = +e.target.value; }) },
    [...Array(9)].map((_, i) => h('option', { value: i, selected: q.choke === i ? true : null }, i ? `GROUP ${i}` : 'OFF')));
  const mute = h('button', { class: 'add' + (q.mute ? ' on' : ''), style: { height: '26px' }, title: 'This sound does not play', onclick: () => { set((x) => { x.mute = !x.mute; }); mute.classList.toggle('on', cur().mute); } }, 'MUTE');
  return [h('div', { class: 'knobs', '--cols': 4 }, knobs),
    h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
      h('label', { class: 'fx-sc' }, 'CHOKE', choke), mute,
      h('button', { class: 'add', style: { height: '26px' }, title: 'This sound back to the kit as it is', onclick: () => { app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x.lanes) delete x.lanes[l]; }); dev.refresh(true); } }, 'RESET'))];
}

// ------------------------------------------------------------------ the 16 sounds side by side
export function drumMixer(dev, t) {
  const app = dev.app, lib = app.lib.sloop;
  const strips = lib.lanes.map((name, l) => {
    const n = lib.laneNotes[l], q = { ...LANE_DEF, ...(t.lanes?.[l] || {}) };
    const k = knob({ label: name, min: -60, max: 12, def: 0, step: 0.5, size: 26, color: t.color, value: q.lv, format: (v) => (v <= -60 ? 'OFF' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`),
      onChange: (v) => { app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.lanes ||= {}; x.lanes[l] = { ...LANE_DEF, ...(x.lanes[l] || {}), lv: v }; }, `lanemix${t.id}${l}`); markPad(dev, t, l); },
      onEnd: () => app.store.endGesture() });
    const m = h('button', { class: 'drm-m' + (q.mute ? ' on' : ''), title: `Mute ${name}`, onclick: () => {
      app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); x.lanes ||= {}; const c = { ...LANE_DEF, ...(x.lanes[l] || {}) }; c.mute = !c.mute; x.lanes[l] = c; });
      m.classList.toggle('on'); markPad(dev, t, l); } }, 'M');
    const s = h('div', { class: 'drm-strip' + (app.view.padSel === n ? ' sel' : '') }, k, m);
    s.addEventListener('pointerdown', (e) => { if (e.target.closest('.knob, button')) return; app.view.padSel = n; dev.refresh(true); });
    return s;
  });
  return h('div', { class: 'module drm-mix' }, h('h4', {}, 'KIT MIXER', h('em', { text: '16 SOUNDS · LEVEL · MUTE' })), h('div', { class: 'drm-strips' }, strips));
}

// ------------------------------------------------------------------ the drum synth
export function drumSynthModule(dev, t) {
  const app = dev.app, lib = app.lib.sloop, d = t.dsyn;
  if (!d) return null;
  const n = app.view.padSel ?? 36, ln = dsLaneOf(n), names = synthNames(lib), f = factory(app);
  const sound = () => DSYN.decode(app.store.track(t.id).dsyn.sounds[ln]);
  const put = (fn, tag) => app.store.change((p) => { const x = p.tracks.find((y) => y.id === t.id); if (x.dsyn) fn(x.dsyn); }, tag);
  const setField = (key, v, tag) => put((x) => { const o = DSYN.decode(x.sounds[ln]); o[key] = v; x.sounds[ln] = DSYN.encode(o); }, tag);
  const base = f ? DSYN.decode(f.kit(d.src).sounds[ln]) : null;          // (a double-click: the sound it started from)
  const o = DSYN.decode(d.sounds[ln]);
  const groups = DS_GROUPS.map(([title, ks]) => h('div', { class: 'dsyn-g' }, h('h6', { text: title }), h('div', { class: 'knobs', '--cols': 4 }, ks.map(([key, label, min, max, fmt, list]) => {
    if (list) {
      const s = h('select', { 'aria-label': label, title: label, onchange: (e) => { setField(key, +e.target.value); dev.app.noteOn?.(t.id, n, 110); } },
        list.map((x, i) => h('option', { value: i + min, selected: o[key] === i + min ? true : null }, x)));
      return h('label', { class: 'dsyn-sel' }, h('span', { text: label }), s);
    }
    return knob({ label, min, max, def: base ? base[key] : o[key], value: o[key], size: 30, color: '#ff8a3d', format: (v) => fmt(v, sound()),
      onChange: (v) => setField(key, v, `dsyn${t.id}${ln}${key}`), onEnd: () => { app.store.endGesture(); app.noteOn?.(t.id, n, 110); } });
  }))));
  const from = h('select', { 'aria-label': 'Start from a kit', title: 'Start again from a factory kit: every sound is replaced' },
    h('option', { value: '' }, 'START FROM…'), names.map((nm, i) => h('option', { value: i }, nm)));
  from.onchange = () => { const i = +from.value; if (from.value === '' ) return; const nk = newDrumSynth(app, i); if (nk) { put((x) => { Object.assign(x, nk); }); dev.refresh(true); } };
  const name = h('input', { value: d.name, maxlength: 8, 'aria-label': 'Kit name', spellcheck: 'false', translate: 'no', class: 'dsyn-name',
    onchange: (e) => { const v = e.target.value.replace(/[^\x20-\x7E]/g, '').slice(0, 8) || 'MY KIT'; put((x) => { x.name = v; }); } });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const bits = knob({ label: 'CRUSH', min: 0, max: 15, def: 0, value: d.crush & 15, size: 28, color: '#ff8a3d', format: (v) => (v ? `-${v}bit` : 'OFF'),
    onChange: (v) => put((x) => { x.crush = (x.crush & 0xf0) | v; }, `dsyncr${t.id}`), onEnd: () => app.store.endGesture() });
  const sh = knob({ label: 'S&H', min: 1, max: 16, def: 1, value: (d.crush >> 4) + 1, size: 28, color: '#ff8a3d', format: (v) => (v > 1 ? `1/${v}` : 'OFF'),
    onChange: (v) => put((x) => { x.crush = (x.crush & 15) | ((v - 1) << 4); }, `dsynsh${t.id}`), onEnd: () => app.store.endGesture() });
  const lanes = h('div', { class: 'dsyn-lanes' }, DSYN.LANES_N.map((nm, i) => h('button', { class: 'add' + (i === ln ? ' on' : ''), translate: 'no', onclick: () => { app.view.padSel = DSYN.LANE_NOTE[i]; app.noteOn?.(t.id, DSYN.LANE_NOTE[i], 110); dev.refresh(true); } }, nm)));
  const exp = h('button', { class: 'add', title: 'Save this kit as a file (SLOOP\'s DRUM SYNTH opens it too)', onclick: async () => {
    const k = app.store.track(t.id).dsyn;
    const name = await saveFile(`${k.name.trim() || 'kit'}.drumsynth.json`, JSON.stringify({ format: DSYN.FORMAT, version: 1, name: k.name, crush: k.crush, sounds: k.sounds }, null, 1), {});
    app.toast?.(`Saved ${name}`);
  } }, 'EXPORT');
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    const fl = file.files[0]; file.value = ''; if (!fl) return;
    try {
      const j = JSON.parse(await fl.text());
      if (j?.format !== DSYN.FORMAT || !Array.isArray(j.sounds) || j.sounds.length !== 16 || j.sounds.some((x) => !Array.isArray(x) || x.length !== 22)) throw new Error('bad');
      put((x) => { x.name = String(j.name || 'KIT').replace(/[^\x20-\x7E]/g, '').slice(0, 8); x.crush = (j.crush | 0) & 255; x.sounds = j.sounds.map((s) => DSYN.encode(DSYN.decode(s.map((v) => v & 255)))); });
      dev.refresh(true); app.toast?.(`Kit ${j.name || ''} loaded.`);
    } catch { app.toast?.('That file is not a SLOOP drum synth kit.'); }
  } });
  const imp = h('button', { class: 'add', title: 'Open a drum synth kit (a file from Kraken or SLOOP\'s DRUM SYNTH)', onclick: () => file.click() }, 'IMPORT');
  const shared = DSYN.LANE_NOTE[ln] !== n ? h('p', { class: 'ctl-note', text: `This pad plays the synth's ${DSYN.LANES_N[ln]} sound (shifted): you edit that sound.` }) : null;
  return h('div', { class: 'module dsyn' }, h('h4', {}, 'DRUM SYNTH', h('em', { text: 'YOUR SYNTHESISED KIT' })),
    h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } }, name, from, bits, sh, imp, exp, file),
    lanes, h('h5', { class: 'dsyn-now', translate: 'no', text: `${d.name.trim()} · ${DSYN.LANES_N[ln]}` }), shared, h('div', { class: 'dsyn-groups' }, groups),
    h('p', { class: 'ctl-note', text: 'Every change plays at once. Double-click a knob: the value of the kit it started from.' }));
}
