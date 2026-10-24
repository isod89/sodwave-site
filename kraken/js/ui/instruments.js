// SPDX-License-Identifier: GPL-3.0-only
// The instrument panels of the newer track kinds: the sampler, external MIDI (hardware, the FM-1),
// the group; and for the SLOOP / Clipper synths: DX7 banks on FM6, MPE, freeze.
import { h, knob, noteName } from './kit.js';
import { dragHasAudio, droppedAudio } from './samples.js';

// ------------------------------------------------------------------- DX7 ---
// a 32-voice bank: F0 43 0n 09 20 00 + 4096 bytes + checksum F7 (or the 4096 bytes alone)
export function parseDx7Bank(bytes) {
  let data = null;
  if (bytes[0] === 0xf0 && bytes[1] === 0x43 && bytes[3] === 0x09 && bytes.length >= 4104) data = bytes.subarray(6, 6 + 4096);
  else if (bytes.length === 4096) data = bytes;
  if (!data) throw new Error('Not a DX7 32-voice bank (.syx of 4104 bytes).');
  return [...Array(32)].map((_, i) => {
    const v = data.subarray(i * 128, i * 128 + 128);
    const name = String.fromCharCode(...v.subarray(118, 128)).replace(/[^\x20-\x7e]/g, ' ').trim() || `VOICE ${i + 1}`;
    return { name, data: btoa(String.fromCharCode(...v)) };
  });
}

function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, hidden: true, multiple: multiple || null });
    inp.onchange = () => { resolve(multiple ? [...inp.files] : inp.files[0] || null); inp.remove(); };
    document.body.append(inp); inp.click();
  });
}
const AUDIO_ACCEPT = 'audio/*,.wav,.aif,.aiff,.mp3,.flac,.ogg,.m4a';
export const pickAudio = (multiple = false) => pickFile(AUDIO_ACCEPT, multiple);

// extras for a SLOOP / Clipper synth: DX7 voices on FM6, MPE (Clipper), freeze
export function synthExtras(dev, t) {
  const app = dev.app, cat = app.lib[t.bank], fm6 = cat.engines.findIndex((e) => e.name === 'FM6');
  const mods = [];
  const dx7 = h('div', { class: 'module', style: { width: '220px' } }, h('h4', {}, 'DX7 VOICES', h('em', { text: 'FM6' })),
    h('p', { class: 'ctl-note', text: t.dx7 ? `Playing ${t.dx7.name} from a DX7 bank.` : 'Load a DX7 bank (.syx): its 32 voices play on the FM6 engine.' }),
    h('button', { class: 'add', style: { height: '26px' }, onclick: async () => {
      const f = await pickFile('.syx,application/octet-stream');
      if (!f) return;
      try {
        const voices = parseDx7Bank(new Uint8Array(await f.arrayBuffer()));
        app.dx7Bank = { name: f.name, voices };
        dev.refresh(true);
        app.toast(`${voices.length} DX7 voices: pick one.`);
      } catch (err) { app.toast(err.message); }
    } }, 'LOAD .SYX BANK'),
    app.dx7Bank ? h('select', { 'aria-label': 'DX7 voice', onchange: (e) => {
      const v = app.dx7Bank.voices[+e.target.value];
      app.setSound(t.id, { bank: 'clipper', engine: app.lib.clipper.engines.findIndex((x) => x.name === 'FM6'), preset: 0, dx7: v });
      app.audition(t.id, [60, 64, 67], 600);
    } }, h('option', { value: '' }, `${app.dx7Bank.name}…`), app.dx7Bank.voices.map((v, i) => h('option', { value: i, selected: t.dx7?.name === v.name ? true : null }, `${String(i + 1).padStart(2, '0')} ${v.name}`))) : null);
  if (fm6 >= 0) mods.push(dx7);
  if (t.bank === 'clipper') {
    mods.push(h('div', { class: 'module', style: { width: '180px' } }, h('h4', {}, 'MPE', h('em', { text: 'CLIPPER' })),
      h('p', { class: 'ctl-note', text: 'Per-note bend, pressure and slide from an MPE controller (Seaboard, LinnStrument, Osmose…).' }),
      h('select', { 'aria-label': 'MPE', onchange: (e) => app.store.change((p) => { p.tracks.find((x) => x.id === t.id).mpe = +e.target.value; }) },
        ['OFF', '48 ST', '2 ST', '12 ST', '24 ST', '96 ST'].map((n, i) => h('option', { value: i, selected: (t.mpe || 0) === i ? true : null }, i ? `ON · BEND ${n}` : 'OFF')))));
  }
  mods.push(freezeModule(dev, t));
  return mods;
}

export function freezeModule(dev, t) {
  const app = dev.app;
  return h('div', { class: 'module', style: { width: '180px' } }, h('h4', {}, 'FREEZE', h('em', { text: t.frozen ? 'FROZEN' : 'CPU' })),
    h('p', { class: 'ctl-note', text: t.frozen ? 'The track plays its rendered audio: its instrument rests. Its effects stay live.' : 'Render the instrument to audio to free the CPU. Its effects stay live.' }),
    h('button', { class: 'add' + (t.frozen ? ' go' : ''), style: { height: '26px' }, onclick: () => (t.frozen ? app.unfreeze(t.id) : app.freeze(t.id)) }, t.frozen ? 'UNFREEZE' : 'FREEZE TRACK'));
}

// ---------------------------------------------------------------- sampler ---
export function buildSampler(dev, t) {
  const app = dev.app, s = t.sample || {}, a = s.src ? app.assets.get(s.src) : null;
  const set = (fn, tag) => app.store.change((p) => fn(p.tracks.find((x) => x.id === t.id).sample), tag);
  const cv = h('canvas', { class: 'smp-wave', width: 520, height: 110 });
  const draw = () => {
    const s = app.store.track(t.id)?.sample || {};                // (the current values: the panel is not rebuilt while dragging)
    const c = cv.getContext('2d'), W = cv.width, H = cv.height;
    c.fillStyle = '#0b0c0d'; c.fillRect(0, 0, W, H);
    if (!a) { c.fillStyle = '#737980'; c.font = '600 12px Archivo, sans-serif'; c.fillText('NO SAMPLE: LOAD A FILE, DROP ONE HERE (SEVERAL: A MULTI-SAMPLE)', 14, H / 2); return; }
    const pk = a.peaks, x0 = (s.start ?? 0) * W, x1 = (s.end ?? 1) * W;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor(x / W * pk.length), i1 = Math.max(i0 + 1, Math.floor((x + 1) / W * pk.length));
      let m = 0; for (let i = i0; i < i1; i++) m = Math.max(m, pk[i]);
      c.fillStyle = x >= x0 && x <= x1 ? t.color : '#2f343a';
      c.fillRect(x, H / 2 - m * H / 2, 1, Math.max(1, m * H));
    }
    c.fillStyle = '#ff5b14'; c.fillRect(x0, 0, 2, H); c.fillRect(x1 - 2, 0, 2, H);
    if (s.mode === 'slice') { c.fillStyle = '#ffffff55'; for (let k = 1; k < (s.slices || 16); k++) c.fillRect(x0 + (x1 - x0) * k / (s.slices || 16), 0, 1, H); }
  };
  draw();
  const zoned = !!s.zones?.length;
  cv.addEventListener('dragover', (e) => { if (dragHasAudio(e)) { e.preventDefault(); cv.classList.add('dropping'); } });
  cv.addEventListener('dragleave', () => cv.classList.remove('dropping'));
  cv.addEventListener('drop', async (e) => { e.preventDefault(); cv.classList.remove('dropping'); const fs = await droppedAudio(app, e); if (fs.length) app.setSamplerFiles(t.id, fs); });
  cv.addEventListener('pointerdown', (e) => {             // drag the nearer of start / end
    if (zoned) return;
    const r = cv.getBoundingClientRect(), pos = (m) => Math.max(0, Math.min(1, (m.clientX - r.left) / r.width));
    const k = Math.abs(pos(e) - (s.start ?? 0)) < Math.abs(pos(e) - (s.end ?? 1)) ? 'start' : 'end';
    const mv = (m) => { set((x) => { x[k] = k === 'start' ? Math.min(pos(m), (x.end ?? 1) - 0.005) : Math.max(pos(m), (x.start ?? 0) + 0.005); }, 'smp' + k); draw(); };
    cv.setPointerCapture(e.pointerId); mv(e);
    cv.onpointermove = (m) => { if (m.buttons) mv(m); };
    cv.onpointerup = () => { cv.onpointermove = null; app.store.endGesture(); };
  });
  const assets = Object.entries(app.store.p.assets || {});
  const load = h('div', { class: 'module', style: { width: '560px' } }, h('h4', {}, 'SAMPLER', h('em', { text: s.name || 'EMPTY' })), cv,
    h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'add', style: { height: '26px' }, onclick: async () => { const f = await pickAudio(); if (f) app.setSamplerFiles(t.id, [f]); } }, 'LOAD FILE'),
      h('button', { class: 'add', style: { height: '26px' }, title: 'Several files, one a zone: their notes from their names (Piano_C4.wav, Rhodes-A#2-soft.wav)', onclick: async () => { const fs = await pickAudio(true); if (fs?.length) app.setSamplerFiles(t.id, fs); } }, 'MULTI-SAMPLE…'),
      assets.length ? h('select', { 'aria-label': 'A project audio file', onchange: (e) => { const id = e.target.value; if (id) set((x) => { x.src = id; x.name = (app.store.p.assets[id]?.name || '').toUpperCase().slice(0, 18); delete x.zones; }); } },
        h('option', { value: '' }, 'PROJECT AUDIO…'), assets.map(([id, m]) => h('option', { value: id, selected: s.src === id ? true : null }, m.name))) : null,
      zoned ? null : h('select', { 'aria-label': 'Mode', onchange: (e) => set((x) => { x.mode = e.target.value; }) },
        h('option', { value: 'keys', selected: s.mode !== 'slice' ? true : null }, 'KEYS: PITCHED'), h('option', { value: 'slice', selected: s.mode === 'slice' ? true : null }, 'SLICE: ONE A KEY FROM C2')),
      zoned ? null : h('label', { class: 'fx-sc' }, 'ROOT', h('select', { 'aria-label': 'Root note', onchange: (e) => set((x) => { x.root = +e.target.value; }) },
        [...Array(61)].map((_, i) => i + 36).map((n) => h('option', { value: n, selected: (s.root ?? 60) === n ? true : null }, noteName(n))))),
      zoned || s.mode !== 'slice' ? null : h('label', { class: 'fx-sc' }, 'SLICES', h('select', { 'aria-label': 'Slices', onchange: (e) => set((x) => { x.slices = +e.target.value; }) },
        [4, 8, 16, 32].map((n) => h('option', { value: n, selected: (s.slices || 16) === n ? true : null }, n)))),
      h('label', { class: 'fx-sc' }, 'LOOP', h('input', { type: 'checkbox', checked: s.loop ? true : null, onchange: (e) => set((x) => { x.loop = e.target.checked; }) }))));
  const kn = (label, key, min, max, def, fmtf, step = 1) => knob({ label, min, max, def, step, value: s[key] ?? def, color: t.color, format: fmtf, onChange: (v) => set((x) => { x[key] = v; }, 'smp' + key), onEnd: () => app.store.endGesture() });
  const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`);
  const env = h('div', { class: 'module' }, h('h4', { text: 'AMP' }), h('div', { class: 'knobs', '--cols': 3 },
    kn('ATTACK', 'att', 0, 2000, 2, ms), kn('DECAY', 'dec', 0, 5000, 0, (v) => (v ? ms(v) : 'OFF'), 5), kn('SUSTAIN', 'sus', 0, 1, 1, (v) => `${Math.round(v * 100)}%`, 0.01),
    kn('RELEASE', 'rel', 5, 4000, 150, ms), kn('GAIN', 'gain', -24, 12, 0, (v) => `${v > 0 ? '+' : ''}${v}dB`), kn('TUNE', 'tune', -100, 100, 0, (v) => `${v > 0 ? '+' : ''}${v}c`)));
  const hz = (v) => (v >= 19900 ? 'OPEN' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}Hz`);
  const filt = h('div', { class: 'module' }, h('h4', {}, 'FILTER', h('em', { text: 'LOW-PASS' })), h('div', { class: 'knobs', '--cols': 3 },
    kn('CUTOFF', 'cut', 30, 20000, 20000, hz, 10), kn('RES', 'res', 0, 0.95, 0, (v) => `${Math.round(v / 0.95 * 100)}%`, 0.01),
    kn('ENV', 'fenv', 0, 8, 0, (v) => (v ? `+${v.toFixed(1)}oct` : 'OFF'), 0.1)));
  const pads = s.mode === 'slice' ? h('div', { class: 'module' }, h('h4', {}, 'SLICES', h('em', { text: 'C2 UP' })),
    h('div', { class: 'pads' }, [...Array(Math.min(32, s.slices || 16))].map((_, k) => {
      const pad = h('button', { class: 'pad', text: `${k + 1} · ${noteName(36 + k)}` });
      pad.addEventListener('pointerdown', (e) => { e.preventDefault(); app.noteOn(t.id, 36 + k, 110); setTimeout(() => app.noteOff(t.id, 36 + k), 300); });
      return pad;
    }))) : null;
  dev.wrap.replaceChildren(...[load, zoned ? zonesModule(dev, t) : null, env, filt, pads, freezeModule(dev, t)].filter(Boolean));
}

// the zones of a multi-sample: a map of the keyboard (key ranges across, velocity up), and each zone's numbers
function zonesModule(dev, t) {
  const app = dev.app, zs = t.sample.zones;
  const set = (j, fn) => app.store.change((p) => fn(p.tracks.find((x) => x.id === t.id).sample.zones[j]));
  const map = h('canvas', { class: 'zone-map', width: 520, height: 46 });
  const c = map.getContext('2d'), W = map.width, H = map.height;
  c.fillStyle = '#0b0c0d'; c.fillRect(0, 0, W, H);
  for (let n = 0; n < 128; n++) if ([1, 3, 6, 8, 10].includes(n % 12)) { c.fillStyle = '#16191c'; c.fillRect(n / 128 * W, 0, W / 128, H); }
  zs.forEach((z, j) => {
    const x0 = z.lo / 128 * W, x1 = (z.hi + 1) / 128 * W, y0 = H - z.vhi / 127 * H, y1 = H - (z.vlo - 1) / 127 * H;
    c.fillStyle = t.color + (j % 2 ? '55' : '88'); c.fillRect(x0 + 1, y0 + 1, Math.max(1, x1 - x0 - 2), Math.max(1, y1 - y0 - 2));
    c.strokeStyle = t.color; c.lineWidth = 1; c.strokeRect(x0 + 1.5, y0 + 1.5, Math.max(1, x1 - x0 - 3), Math.max(1, y1 - y0 - 3));
    c.fillStyle = '#ff5b14'; c.fillRect((z.root + 0.5) / 128 * W - 1, y0 + 1, 2, y1 - y0 - 2);
  });
  c.fillStyle = '#737980'; c.font = '500 8px monospace';
  for (let o = 0; o <= 10; o++) c.fillText(`C${o - 1}`, o * 12 / 128 * W + 1, 8);
  const note = (j, key, z) => h('select', { 'aria-label': `${z.name} ${key}`, onchange: (e) => set(j, (x) => { x[key] = +e.target.value; if (x.lo > x.hi) [x.lo, x.hi] = [x.hi, x.lo]; }) },
    [...Array(128)].map((_, n) => h('option', { value: n, selected: z[key] === n ? true : null }, noteName(n))));
  const vel = (j, key, z) => h('input', { type: 'number', min: 1, max: 127, value: z[key], 'aria-label': `${z.name} ${key}`, onkeydown: (e) => e.stopPropagation(),
    onchange: (e) => set(j, (x) => { x[key] = Math.max(1, Math.min(127, Math.round(+e.target.value) || 1)); if (x.vlo > x.vhi) [x.vlo, x.vhi] = [x.vhi, x.vlo]; }) });
  const rows = zs.slice(0, 96).map((z, j) => h('div', { class: 'zone-row' },
    h('span', { text: z.name || `ZONE ${j + 1}`, title: z.name, role: 'button', style: { cursor: 'pointer' }, onclick: () => app.audition(t.id, [z.root], 400) }),
    note(j, 'root', z), note(j, 'lo', z), note(j, 'hi', z), vel(j, 'vlo', z), vel(j, 'vhi', z),
    h('button', { class: 'tb', title: 'Remove this zone', onclick: () => app.store.change((p) => { const s = p.tracks.find((x) => x.id === t.id).sample; s.zones.splice(j, 1); if (!s.zones.length) delete s.zones; }) }, '×')));
  return h('div', { class: 'module', style: { width: '560px' } }, h('h4', {}, 'ZONES', h('em', { text: `${zs.length} SAMPLES` })), map,
    h('div', { class: 'zone-list' }, h('div', { class: 'zone-row head' }, h('span', { text: 'SAMPLE' }), h('span', { text: 'ROOT' }), h('span', { text: 'FROM' }), h('span', { text: 'TO' }), h('span', { text: 'VEL ≥' }), h('span', { text: 'VEL ≤' }), h('span')), rows),
    h('button', { class: 'add', style: { height: '24px', marginTop: '6px' }, title: 'Back to one sample (the first zone)', onclick: () => app.store.change((p) => { const s = p.tracks.find((x) => x.id === t.id).sample; s.name = (s.zones?.[0]?.name || '').toUpperCase().slice(0, 18); delete s.zones; }) }, 'ONE SAMPLE'));
}

// ------------------------------------------------------------ external MIDI ---
export function buildExternal(dev, t) {
  const app = dev.app, x = t.ext || {}, outs = app.control.outputs();
  const set = (fn, tag) => app.store.change((p) => fn(p.tracks.find((y) => y.id === t.id).ext), tag);
  dev.wrap.replaceChildren(
    h('div', { class: 'module sound-lcd' }, h('h4', {}, 'EXTERNAL', h('em', { text: 'MIDI OUT' })),
      h('div', { class: 'screen' }, h('span', { class: 'eng', text: `CHANNEL ${x.ch || 1}` }), h('span', { class: 'pre', text: x.port || 'NO DEVICE' })),
      h('select', { 'aria-label': 'MIDI output', onchange: (e) => set((y) => { y.port = e.target.value; }) },
        h('option', { value: '' }, outs.length ? 'CHOOSE A DEVICE…' : 'NO MIDI OUTPUT FOUND'), outs.map((o) => h('option', { value: o.name, selected: x.port === o.name ? true : null }, o.name))),
      h('select', { 'aria-label': 'MIDI channel', onchange: (e) => set((y) => { y.ch = +e.target.value; }) },
        [...Array(16)].map((_, i) => h('option', { value: i + 1, selected: (x.ch || 1) === i + 1 ? true : null }, `CHANNEL ${i + 1}`))),
      h('button', { class: 'add', style: { height: '26px' }, onclick: () => { for (const o of outs.filter((y) => y.name === x.port)) try { o.send([0xb0 | ((x.ch || 1) - 1), 123, 0]); } catch { /* */ } } }, 'ALL NOTES OFF')),
    h('div', { class: 'module' }, h('h4', { text: 'TIMING' }), h('div', { class: 'knobs', '--cols': 1 },
      knob({ label: 'OFFSET', min: -50, max: 200, def: 0, value: x.latency || 0, color: t.color, format: (v) => `${v}ms`, onChange: (v) => set((y) => { y.latency = v; }, 'extlat'), onEnd: () => app.store.endGesture() }))),
    h('div', { class: 'module', style: { maxWidth: '340px' } }, h('h4', { text: 'HOW IT WORKS' }),
      h('p', { class: 'ctl-note', text: 'This track\'s clips and keys play the MIDI device: an FM-1 running SLOOP or Clipper, any synth or drum machine. Notes leave on time with the audio (raise OFFSET if the device answers late). To hear it in the mix and export it, record its audio output on an audio track; to sync its sequencer, send MIDI clock from the Controllers tab.' })));
}

// ------------------------------------------------------------------- group ---
export function buildGroup(dev, t) {
  const app = dev.app, kids = app.store.p.tracks.filter((x) => x.out === t.id);
  dev.wrap.replaceChildren(h('div', { class: 'module sound-lcd' }, h('h4', {}, 'GROUP', h('em', { text: 'BUS' })),
    h('div', { class: 'screen' }, h('span', { class: 'eng', text: `${kids.length} TRACK${kids.length === 1 ? '' : 'S'}` }), h('span', { class: 'pre', text: t.name })),
    h('p', { class: 'ctl-note', text: kids.length ? kids.map((k) => k.name).join(' · ') : 'Route tracks here with OUT in the mixer. Their sum gets this group\'s effects, fader and sends.' })));
}

// --------------------------------------------------------------------- VCA ---
export function buildVca(dev, t) {
  const app = dev.app, kids = app.store.p.tracks.filter((x) => x.vca === t.id);
  dev.wrap.replaceChildren(h('div', { class: 'module sound-lcd' }, h('h4', {}, 'VCA', h('em', { text: 'FADER GROUP' })),
    h('div', { class: 'screen' }, h('span', { class: 'eng', text: `${kids.length} TRACK${kids.length === 1 ? '' : 'S'}` }), h('span', { class: 'pre', text: t.name })),
    h('p', { class: 'ctl-note', text: kids.length ? `Its fader moves ${kids.map((k) => k.name).join(' · ')} together (their own faders keep their balance); its mute mutes them. Automate it like any fader.` : 'Give it tracks from their menu (right-click a track, or hold it) > VCA. It moves their faders together without mixing their sound.' })));
}
