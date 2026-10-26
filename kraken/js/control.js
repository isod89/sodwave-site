// SPDX-License-Identifier: GPL-3.0-only
// Kraken under your hands: every control of the app reachable from a MIDI controller (or the computer
// keyboard). MIDI Learn on any knob, fader, button or action; soft takeover; relative encoders; Mackie
// Control surfaces (faders, V-pots, transport, LEDs, scribble strips); MIDI Start / Stop and MMC; MIDI
// clock out to sync hardware (an FM-1 running SLOOP); notes, bend, pressure and CCs to the instruments,
// routed by channel; controller moves recorded as automation.
import { barOf, barStart, prevBar, nextBar } from './meter.js';
import { dbToPos, posToDb } from './ui/mixer.js';
import { NOTE_FX } from './notefx.js';
import { DEVICES, toNorm, fromNorm } from './fx.js';

const STORE = 'kraken.control.v1';
const MCU_NAME = /mackie|mcu|x-touch|xtouch|faderport|icon |qcon|platform ?m|v1-m|cmc-|launch control xl|nano ?kontrol studio/i;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

import { Grid, GRID_NAME } from './launchpad.js';

export const ACTIONS = [
  ['playstop', 'Play / stop'], ['play', 'Play'], ['stop', 'Stop'], ['record', 'Record'], ['loop', 'Loop on / off'],
  ['click', 'Metronome'], ['home', 'Back to start'], ['rewind', 'Back one bar'], ['forward', 'Forward one bar'],
  ['undo', 'Undo'], ['redo', 'Redo'], ['prevTrack', 'Previous track'], ['nextTrack', 'Next track'],
  ['prevSound', 'Previous sound'], ['nextSound', 'Next sound'], ['octDown', 'Keys octave down'], ['octUp', 'Keys octave up'],
  ['arm', 'Arm selected track'], ['mute', 'Mute selected track'], ['solo', 'Solo selected track'],
  ['newClip', 'New clip at the playhead'], ['dupClip', 'Duplicate selected clip'], ['delClip', 'Delete selected clip'],
  ['quantize', 'Quantize selected clip'], ['tap', 'Tap tempo'], ['panic', 'All notes off'],
  ['tabClip', 'Show clip editor'], ['tabInst', 'Show instrument'], ['tabMixer', 'Show mixer'], ['tabCtl', 'Show controllers'],
  ['library', 'Show / hide sounds'], ['zoomIn', 'Zoom in'], ['zoomOut', 'Zoom out'], ['save', 'Save project'],
  ['toggleView', 'Arrangement / session'], ['stopAll', 'Stop all clips'], ['countIn', 'Count-in on / off'], ['punch', 'Punch in / out on / off'],
  ['scene1', 'Launch scene 1'], ['scene2', 'Launch scene 2'], ['scene3', 'Launch scene 3'], ['scene4', 'Launch scene 4'],
  ['scene5', 'Launch scene 5'], ['scene6', 'Launch scene 6'], ['scene7', 'Launch scene 7'], ['scene8', 'Launch scene 8'],
  ['palette', 'Command palette'], ['addMarker', 'Marker at the playhead'], ['prevMarker', 'Previous marker'], ['nextMarker', 'Next marker'],
  ['newSynth', 'New synth track'], ['newDrums', 'New drum track'], ['dupTrack', 'Duplicate selected track'], ['delTrack', 'Delete selected track (asks first)'],
];
const ENC = { abs: 'ABSOLUTE', rel2c: 'RELATIVE (2s compl.)', relbin: 'RELATIVE (64 = 0)', relsign: 'RELATIVE (sign bit)', toggle: 'TOGGLE', momentary: 'MOMENTARY' };
export const ENCODINGS = ENC;

export function sourceLabel(key) {
  const [type, ch, n] = key.split(':');
  if (type === 'cc') return `CC ${n} · CH ${+ch + 1}`;
  if (type === 'note') return `NOTE ${n} · CH ${+ch + 1}`;
  if (type === 'pb') return `BEND · CH ${+ch + 1}`;
  if (type === 'key') return `KEY ${ch.replace(/^Key|^Digit/, '')}`;
  return key;
}

export class Control {
  constructor(app) {
    this.app = app;
    this.access = null;
    this.learning = false;
    this.armed = null;                 // target id waiting for a MIDI message
    this.cfg = { maps: [], devices: {}, clockOut: '', pickup: true };
    try { Object.assign(this.cfg, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { /* none yet */ }
    this.pick = new Map();             // map index -> { picked, last }
    this.autoLast = new Map();         // automation key -> last written beat
    this.held = new Map();             // `${ch}:${note}` -> [track ids]
    this.listeners = new Set();
    this.mcu = { bank: 0, outs: new Set(), lastSent: new Map() };
    this.grid = new Grid(app);                 // a Launchpad: the session's slots
    this.taps = [];
    this.clock = { next: 0, running: false, sentStart: false };
    document.addEventListener('pointerdown', (e) => this.learnClick(e), true);
    document.addEventListener('click', (e) => { if (this.learning && e.target.closest('[data-learn]') && !e.target.closest('#v-ctl')) { e.preventDefault(); e.stopPropagation(); } }, true);
    app.store.on(() => this.feedbackSoon());
  }
  save() { try { localStorage.setItem(STORE, JSON.stringify(this.cfg)); } catch { /* storage blocked */ } this.emit(); }
  on(fn) { this.listeners.add(fn); }
  emit(why = 'cfg') { for (const fn of this.listeners) fn(why); }

  // ------------------------------------------------------------- devices ---
  async start() {
    if (!navigator.requestMIDIAccess) { this.status = 'This browser has no Web MIDI: use Chrome, Edge or Firefox.'; this.emit(); return; }
    try {
      try { this.access = await navigator.requestMIDIAccess({ sysex: true }); } catch { this.access = await navigator.requestMIDIAccess(); }
      this.access.onstatechange = () => this.attach();
      this.attach();
      this.status = null;
    } catch {
      this.status = 'MIDI access was refused, or is not allowed in this page. Run Kraken locally (python3 serve.py) to use controllers.';
    }
    this.emit();
    this.clockLoop();
  }
  inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  outputs() { return this.access ? [...this.access.outputs.values()] : []; }
  modeOf(name) { return this.cfg.devices[name]?.mode || (MCU_NAME.test(name) ? 'mackie' : GRID_NAME.test(name) ? 'grid' : 'keys'); }
  setMode(name, mode) { (this.cfg.devices[name] ||= {}).mode = mode; this.save(); this.attach(); }
  outFor(name) { const base = name.replace(/\s*(in|input|midiin)\b.*$/i, '').trim(); return this.outputs().find((o) => o.name === name || o.name.startsWith(base)); }
  attach() {
    this.mcu.outs.clear();
    this.grid.clear();
    for (const input of this.inputs()) {
      const mode = this.modeOf(input.name);
      input.onmidimessage = mode === 'off' ? null : ({ data }) => this.message(input, mode, data);
      if (mode === 'mackie') { const o = this.outFor(input.name); if (o) this.mcu.outs.add(o); }
      if (mode === 'grid') this.grid.attach(input.name, this.outFor(input.name));
    }
    const names = this.inputs().filter((i) => this.modeOf(i.name) !== 'off').map((i) => i.name);
    const label = document.getElementById('midi');
    label.textContent = names.length ? (names.length > 1 ? `${names.length} DEVICES` : names[0].slice(0, 14).toUpperCase()) : 'NO INPUT';
    label.title = names.join(', ') || 'Connect a MIDI keyboard or controller';
    this.mcu.lastSent.clear();
    this.feedbackSoon();
    this.emit();
  }

  // ------------------------------------------------------------- messages ---
  message(input, mode, data) {
    const [st, d1 = 0, d2 = 0] = data, type = st & 0xf0, ch = st & 15;
    this.lastMsg = { dev: input.name, data: [...data] }; this.emit('msg');
    if (st === 0xfa || st === 0xfb) return this.app.play(true);
    if (st === 0xfc) return this.app.play(false);
    if (st === 0xf2) return this.app.seek((d1 | (d2 << 7)) / 4);                 // song position: 16ths
    if (st === 0xf0) return this.sysex(data);
    if (st >= 0xf8) return;
    let key = null, value = 0, press = false;
    if (type === 0xb0) { key = `cc:${ch}:${d1}`; value = d2; }
    else if (type === 0x90 && d2 > 0) { key = `note:${ch}:${d1}`; value = d2; press = true; }
    else if (type === 0x80 || type === 0x90) { key = `note:${ch}:${d1}`; value = 0; }
    else if (type === 0xe0) { key = `pb:${ch}`; value = (d1 | (d2 << 7)) / 128; }
    // learning: the first CC, note or bend binds the armed control
    if (this.learning && this.armed && key && (type !== 0x80 && !(type === 0x90 && d2 === 0))) { this.bind(key, type); return; }
    if (mode === 'mackie' && this.mackie(st, d1, d2)) return;
    if (mode === 'grid' && this.grid.message(st, d1, d2)) return;
    if (key && this.mapped(key, value, press, type)) return;
    // what nothing claims plays the instruments; an MPE track gets every channel raw (Clipper's MPE)
    const mpe = this.app.store.p.tracks.find((t) => t.mpe && t.kind === 'synth' && (t.midiCh === 0 ? t.id === this.app.playTarget()?.id : true));
    if (mpe && type >= 0x80 && type <= 0xe0 && type !== 0xc0) {
      this.app.audio.send({ t: 'raw', track: mpe.id, st, d1, d2 });
      if (type === 0x90 || type === 0x80) this.app.audio.send({ t: 'note', track: mpe.id, n: d1, v: d2, on: type === 0x90 && d2 > 0, silent: true });
      return;
    }
    if (type === 0x90 && d2 > 0) {
      this.lagHint();
      const ids = this.routeTracks(ch);
      this.held.set(`${ch}:${d1}`, ids);
      for (const id of ids) this.app.noteOn(id, d1, d2, true);
    } else if (type === 0x80 || type === 0x90) {
      const ids = this.held.get(`${ch}:${d1}`) || [];
      this.held.delete(`${ch}:${d1}`);
      for (const id of ids) this.app.noteOff(id, d1, true);
    } else if (type === 0xe0 || type === 0xd0 || type === 0xa0 || type === 0xb0) {
      for (const id of this.routeTracks(ch)) this.app.audio.send({ t: 'midi', track: id, st, d1, d2 });
    } else if (type === 0xc0) {
      this.programChange(d1);
    }
  }
  // the first key of the session, when the sound card is slow: why the sound comes late, and what helps (once)
  lagHint() {
    if (this.lagShown) return;
    this.lagShown = true;
    const ms = Math.round((this.app.audio?.latency?.() || 0) * 1000);
    if (ms > 40) this.app.toast?.(`Your sound output adds ${ms} ms between a key and its sound. Wired headphones or a USB audio interface play sooner than Bluetooth or a screen's speakers. Recordings are placed where you heard them. Details: PROJECT > Check this device.`);
  }
  // a channel's notes: the tracks listening on it, else the armed or selected track
  routeTracks(ch) {
    const p = this.app.store.p;
    const on = p.tracks.filter((t) => t.midiCh === ch + 1);
    if (on.length) return on.map((t) => t.id);
    const t = this.app.playTarget();
    return t && t.kind !== 'audio' ? [t.id] : [];
  }
  programChange(n) {
    const app = this.app, t = app.store.track(app.view.selTrack);
    if (!t) return;
    if (t.kind === 'drum') {
      const kits = app.lib.sloop.kits.map((k, i) => [k, i]).filter(([k]) => !/^USR|^SYN/.test(k));
      app.setKit(t.id, kits[n % kits.length][1]);
    } else if (t.kind === 'synth') {
      const s = app.lib.sounds[n % app.lib.sounds.length];
      app.setSound(t.id, { bank: s.bank, engine: s.engine, preset: s.preset });
    }
  }
  sysex(data) {
    // MMC: F0 7F <dev> 06 <cmd> F7
    if (data[1] === 0x7f && data[3] === 0x06) {
      const cmd = data[4];
      if (cmd === 0x01 || cmd === 0x09) this.app.play(false);
      else if (cmd === 0x02 || cmd === 0x03) this.app.play(true);
      else if (cmd === 0x05) this.run('home');
      else if (cmd === 0x04) this.run('forward');
      else if (cmd === 0x06) { if (!this.app.recording) this.app.setRecord(true); }
      else if (cmd === 0x07) { if (this.app.recording) this.app.setRecord(false); }
    }
  }

  // ------------------------------------------------------------- learning ---
  setLearning(on) {
    this.learning = on; this.armed = null;
    document.body.classList.toggle('learning', on);
    this.markMapped();
    this.banner();
    this.emit();
  }
  learnClick(e) {
    if (!this.learning) return;
    const el = e.target.closest('[data-learn]');
    if (!el || el.closest('#v-ctl .ctl-maps')) return;
    if (el.id === 'learn') return;
    e.preventDefault(); e.stopPropagation();
    this.arm(el.dataset.learn);
  }
  arm(id) {
    this.armed = id;
    for (const x of document.querySelectorAll('.learn-armed')) x.classList.remove('learn-armed');
    for (const x of document.querySelectorAll(`[data-learn="${CSS.escape(id)}"]`)) x.classList.add('learn-armed');
    this.banner();
    this.emit();
  }
  bind(key, type) {
    const t = this.target(this.armed);
    if (!t) return;
    const enc = type === 0x90 ? (t.kind === 'cont' ? 'momentary' : 'toggle') : type === 0xe0 ? 'abs' : (t.kind === 'cont' ? 'abs' : 'toggle');
    this.cfg.maps = this.cfg.maps.filter((m) => m.src !== key && m.target !== this.armed);
    this.cfg.maps.push({ src: key, target: this.armed, enc });
    this.save();
    this.app.toast(`${sourceLabel(key)} → ${t.label}`);
    this.armed = null;
    for (const x of document.querySelectorAll('.learn-armed')) x.classList.remove('learn-armed');
    this.markMapped();
    this.banner();
  }
  unmap(i) { this.cfg.maps.splice(i, 1); this.save(); this.markMapped(); }
  markMapped() {
    const ids = new Set(this.cfg.maps.map((m) => m.target));
    for (const el of document.querySelectorAll('[data-learn]')) el.classList.toggle('learn-mapped', ids.has(el.dataset.learn));
  }
  banner() {
    const b = document.getElementById('learn-banner');
    if (!b) return;
    b.hidden = !this.learning;
    b.textContent = !this.armed ? 'MIDI LEARN · click any knob, fader, button or action, then move a control or press a key on your controller (or a computer key). Esc to leave.'
      : `MIDI LEARN · ${this.target(this.armed)?.label}: now move a knob, fader or pad on your controller, or press a computer key.`;
    document.getElementById('learn')?.classList.toggle('on', this.learning);
  }
  // the computer keyboard as a controller too: a learned key runs its target
  key(e) {
    if (this.learning && this.armed && !e.repeat && !/^(Shift|Control|Alt|Meta|Escape)/.test(e.key)) {
      e.preventDefault(); this.bind(`key:${e.code}`, 0x90); return true;
    }
    if (this.learning && e.key === 'Escape') { this.setLearning(false); return true; }
    const m = this.cfg.maps.find((x) => x.src === `key:${e.code}`);
    if (!m) return false;
    e.preventDefault();
    if (!e.repeat) this.apply(m, 127, true, 0x90, -1);
    return true;
  }

  // --------------------------------------------------------------- mapped ---
  mapped(key, value, press, type) {
    let hit = false;
    this.cfg.maps.forEach((m, i) => { if (m.src === key) { hit = true; this.apply(m, value, press, type, i); } });
    return hit;
  }
  apply(m, value, press, type, i) {
    const t = this.target(m.target);
    if (!t) return;
    if (t.kind !== 'cont') {                                      // buttons: on press (toggle), or follow (momentary)
      if (m.enc === 'momentary' && t.kind === 'toggle') { t.setOn(value > 0); return; }
      if (type === 0xb0 && m.enc === 'abs') { if (value >= 64) t.press(); return; }
      if (type === 0xb0 && m.enc === 'toggle' && value === 0) return;
      if (press || (type === 0xb0 && value > 0)) t.press();
      return;
    }
    let v;
    const cur = t.get();
    if (m.enc === 'rel2c') v = cur + (value < 64 ? value : value - 128) / 127 * 0.5;
    else if (m.enc === 'relbin') v = cur + (value - 64) / 127 * 0.5;
    else if (m.enc === 'relsign') v = cur + (value & 64 ? -(value & 63) : value & 63) / 127 * 0.5;
    else if (m.enc === 'momentary' || m.enc === 'toggle') v = press ? value / 127 : (m.enc === 'toggle' ? cur : 0);
    else {
      v = value / 127;
      if (this.cfg.pickup && i >= 0 && type !== 0xe0) {          // soft takeover: wait for the knob to reach the value
        const pk = this.pick.get(i) || { picked: false, last: v };
        if (!pk.picked) {
          const crossed = (pk.last - cur) * (v - cur) <= 0 || Math.abs(v - cur) < 0.03;
          pk.last = v; this.pick.set(i, pk);
          if (!crossed) return;
          pk.picked = true;
        }
      }
    }
    t.set(clamp01(v));
    this.recordAuto(t);
  }
  // knobs and faders moved while recording write automation
  recordAuto(t) {
    const app = this.app;
    if (!t.autoKey || !app.recording || !app.playing) return;
    const [trackId, key] = t.autoKey(), pos = app.pos, raw = t.raw();
    const k = trackId + key, last = this.autoLast.get(k);
    app.store.change((p) => {
      const tr = p.tracks.find((x) => x.id === trackId);
      if (!tr) return;
      const list = (tr.auto[key] ||= []);
      const from = last != null && last < pos ? last : pos - 1e-6;
      for (let j = list.length - 1; j >= 0; j--) if (list[j].t > from && list[j].t <= pos + 1e-6) list.splice(j, 1);
      list.push({ t: pos, v: raw }); list.sort((a, b) => a.t - b.t);
    }, 'autorec');
    this.autoLast.set(k, pos);
  }

  // -------------------------------------------------------------- targets ---
  // id -> { label, kind: 'cont' | 'trig' | 'toggle', get(): 0..1, set(0..1), press(), setOn(bool), autoKey(), raw() }
  target(id) {
    if (!id) return null;
    const app = this.app, store = app.store;
    const sel = () => store.track(app.view.selTrack);
    const parts = id.split(':');
    if (parts[0] === 'act') {
      const label = ACTIONS.find(([a]) => a === parts[1])?.[1] || parts[1];
      return { label, kind: 'trig', press: () => this.run(parts[1]) };
    }
    if (parts[0] === 'macro') {
      const i = +parts[1];
      return { label: store.p.macros?.[i]?.name || `Macro ${i + 1}`, kind: 'cont', get: () => store.p.macros?.[i]?.v ?? 0,
        set: (v) => store.change((p) => { if (p.macros[i]) p.macros[i].v = v; }, 'midimacro' + i) };
    }
    if (parts[0] === 'scene') { const i = +parts[1]; return { label: `Launch ${store.p.scenes[i]?.name || 'scene ' + (i + 1)}`, kind: 'trig', press: () => app.launchScene(i) }; }
    if (parts[0] === 'slot') { const [, tid, i] = parts; const t = store.track(tid); return t ? { label: `${t.name} slot ${+i + 1}`, kind: 'trig', press: () => app.launch(tid, +i) } : null; }
    if (parts[0] === 'stoptrack') { const t = store.track(parts[1]); return t ? { label: `Stop ${t.name}`, kind: 'trig', press: () => app.launch(t.id, -1) } : null; }
    if (id === 'swing') return { label: 'Swing', kind: 'cont', get: () => store.p.swing || 0, set: (v) => store.change((p) => { p.swing = Math.round(v * 20) / 20; }, 'midiswing') };
    if (id === 'bpm') return { label: 'Tempo', kind: 'cont', get: () => (store.p.bpm - 40) / 200, set: (v) => store.change((p) => { p.bpm = Math.round(40 + v * 200); }, 'midibpm') };
    if (parts[0] === 'fx' || parts[0] === 'fxon') {        // an effect's knob, or its on / off: fx:<owner>:<fxId>:<param>
      const [, owner, fxId, pk] = parts;
      const list = (p) => (owner === 'master' ? p.master.fx : owner.startsWith('ret') ? p.returns[+owner.slice(3)]?.fx : p.tracks.find((x) => x.id === owner)?.fx) || [];
      const dev = () => list(store.p).find((d) => d.id === fxId);
      const d0 = dev(); if (!d0) return null;
      const edit = (fn, tag) => store.change((p) => { const d = list(p).find((x) => x.id === fxId); if (d) fn(d); }, tag);
      if (parts[0] === 'fxon') return { label: `${DEVICES[d0.type].name} on / off`, kind: 'toggle', press: () => edit((d) => { d.on = d.on === false; }), setOn: (on) => edit((d) => { d.on = on; }) };
      const spec = DEVICES[d0.type].params.find((x) => x.k === pk);
      if (!spec) return null;
      return { label: `${DEVICES[d0.type].name} ${spec.l}`, kind: 'cont', get: () => toNorm(spec, dev()?.p[pk] ?? spec.def), set: (v) => edit((d) => { d.p[pk] = fromNorm(spec, v); }, 'midifx' + fxId + pk),
        autoKey: owner.startsWith('t') && !owner.startsWith('ret') ? () => [owner, `fx:${fxId}:${pk}`] : null, raw: () => dev()?.p[pk] };
    }
    if (parts[0] === 'nfx') {                              // a note effect's knob: nfx:<track>:<fxId>:<param>
      const [, tid, fxId, pk] = parts;
      const dev = () => store.track(tid)?.nfx?.find((d) => d.id === fxId);
      const d0 = dev(); if (!d0) return null;
      const spec = NOTE_FX[d0.type].params.find((x) => x.k === pk);
      if (!spec) return null;
      const norm = (v) => (v - spec.min) / (spec.max - spec.min), denorm = (v) => { const x = spec.min + v * (spec.max - spec.min); return spec.names || spec.unit !== '%' && Number.isInteger(spec.min + spec.max) ? Math.round(x) : x; };
      return { label: `${NOTE_FX[d0.type].name} ${spec.l}`, kind: 'cont', get: () => norm(dev()?.p[pk] ?? spec.def),
        set: (v) => store.change((p) => { const d = p.tracks.find((x) => x.id === tid)?.nfx?.find((x) => x.id === fxId); if (d) d.p[pk] = denorm(v); }, 'midinfx' + fxId + pk),
        autoKey: () => [tid, `nfx:${fxId}:${pk}`], raw: () => dev()?.p[pk] };
    }
    if (id === 'master:vol') return this.volTarget('Master volume', () => store.p.master, (fn) => store.change((p) => fn(p.master), 'midimv'));
    if (parts[0] === 'ret') {
      const i = +parts[1];
      return this.volTarget(`${store.p.returns[i]?.name} return`, () => store.p.returns[i], (fn) => store.change((p) => fn(p.returns[i]), 'midiret' + i));
    }
    // a track: by id ("t:<id>"), the selected one ("sel"), or a mixer bank strip ("strip:<n>")
    let getT, label, prefix;
    if (parts[0] === 't') { const tid = parts[1]; getT = () => store.track(tid); label = getT()?.name || 'Track'; prefix = parts.splice(0, 2, 'x').join(':'); }
    else if (parts[0] === 'sel') { getT = sel; label = 'Selected track'; prefix = parts.splice(0, 1, 'x').join(':'); }
    else if (parts[0] === 'strip') { const n = +parts[1]; getT = () => store.p.tracks[this.mcu.bank + n]; label = `Strip ${n + 1}`; prefix = parts.splice(0, 2, 'x').join(':'); }
    else return null;
    const what = parts[1];
    const edit = (fn, tag) => { const t = getT(); if (t) store.change((p) => fn(p.tracks.find((x) => x.id === t.id)), tag + t.id); };
    if (what === 'vol') return { ...this.volTarget(`${label} volume`, getT, (fn) => edit(fn, 'midivol')), autoKey: () => [getT().id, 'vol'], raw: () => getT().vol };
    if (what === 'pan') return { label: `${label} pan`, kind: 'cont', get: () => ((getT()?.pan ?? 0) + 1) / 2, set: (v) => edit((t) => { t.pan = Math.round((v * 2 - 1) * 100) / 100; }, 'midipan'), autoKey: () => [getT().id, 'pan'], raw: () => getT().pan };
    if (/^send\d+$/.test(what)) {
      const s = +what.slice(4);
      return { label: `${label} send ${store.p.returns[s]?.name.toLowerCase() || s + 1}`, kind: 'cont', get: () => getT()?.sends[s] ?? 0, set: (v) => edit((t) => { t.sends[s] = Math.round(v * 100) / 100; }, 'midisend' + s), autoKey: () => [getT().id, what], raw: () => getT().sends[s] ?? 0 };
    }
    if (what === 'mute' || what === 'solo' || what === 'arm') {
      const flip = (on) => edit((t) => {
        if (what === 'arm') { const v = on ?? !t.arm; for (const x of store.p.tracks) x.arm = false; t.arm = v; } else t[what] = on ?? !t[what];
      }, 'midi' + what + Math.random());
      return { label: `${label} ${what}`, kind: 'toggle', press: () => flip(), setOn: (on) => flip(on) };
    }
    if (what === 'select') return { label: `Select ${label.toLowerCase()}`, kind: 'trig', press: () => { const t = getT(); if (t) app.selectTrack(t.id); } };
    if (what === 'p') {
      const pid = +parts[2];
      const desc = () => { const t = getT(); if (t?.kind === 'lab') return pid < 8 ? { l: t.lab?.macros?.[pid]?.name || `MACRO ${pid + 1}`, min: 0, max: 127, def: 64 } : null; if (!t || t.kind !== 'synth') return null; const cat = app.lib[t.bank]; return pid >= cat.e0 ? cat.engines[t.engine].edit[pid - cat.e0] : cat.tp[pid]; };
      const cur = () => { const t = getT(); return t?.params[pid] ?? app.params.get(t?.id)?.[pid] ?? desc()?.def ?? 0; };
      const d0 = desc();
      return { label: `${label} ${d0?.l || 'param ' + pid}`, kind: 'cont',
        get: () => { const d = desc(); return d ? (cur() - d.min) / (d.max - d.min || 1) : 0; },
        set: (v) => { const t = getT(), d = desc(); if (!t || !d) return; const val = Math.round(d.min + v * (d.max - d.min)); if (val === cur()) return; app.audio.send({ t: 'param', track: t.id, id: pid, v: val }); edit((x) => { x.params[pid] = val; }, 'midip' + pid); },
        autoKey: () => [getT().id, 'p' + pid], raw: () => cur() };
    }
    if (what === 'knob') {                                         // the selected instrument's 8 engine knobs
      const k = +parts[2], t = getT(), cat = t && t.kind === 'synth' ? app.lib[t.bank] : null;
      if (t?.kind === 'lab') return { ...this.target(`${prefix}:p:${k}`), label: `${label} knob ${k + 1}` };   // (a LAB: its macros)
      if (!cat) return { label: `${label} knob ${k + 1}`, kind: 'cont', get: () => 0, set: () => {} };
      return { ...this.target(`${prefix}:p:${cat.e0 + k}`), label: `${label} knob ${k + 1}` };
    }
    return null;
  }
  volTarget(label, get, change) {
    return { label, kind: 'cont', get: () => dbToPos(get()?.vol ?? 0), set: (v) => change((o) => { o.vol = Math.round(posToDb(v) * 10) / 10; }) };
  }

  // -------------------------------------------------------------- actions ---
  run(name) {
    const app = this.app, store = app.store, $ = (id) => document.getElementById(id);
    const t = store.track(app.view.selTrack), p = store.p;
    const tracks = p.tracks, ti = tracks.findIndex((x) => x.id === app.view.selTrack);
    const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: opts.code || '', ctrlKey: !!opts.ctrl, shiftKey: !!opts.shift, bubbles: true }));
    if (/^scene\d$/.test(name)) { app.launchScene(+name.slice(5) - 1); return; }
    switch (name) {
      case 'playstop': app.play(); break;
      case 'play': app.play(true); break;
      case 'stop': app.play(false); break;
      case 'record': app.setRecord(!app.recording); break;
      case 'loop': $('loop').click(); break;
      case 'click': $('click').click(); break;
      case 'home': $('home').click(); break;
      case 'rewind': app.seek(prevBar(p, app.pos)); break;
      case 'forward': app.seek(nextBar(p, app.pos)); break;
      case 'undo': store.undo(); break;
      case 'redo': store.redo(); break;
      case 'prevTrack': if (ti > 0) app.selectTrack(tracks[ti - 1].id); break;
      case 'nextTrack': if (ti < tracks.length - 1) app.selectTrack(tracks[ti + 1].id); break;
      case 'prevSound': key('['); break;
      case 'nextSound': key(']'); break;
      case 'octDown': app.input.octave = Math.max(0, app.input.octave - 1); app.input.show(); break;
      case 'octUp': app.input.octave = Math.min(8, app.input.octave + 1); app.input.show(); break;
      case 'arm': case 'mute': case 'solo': this.target(`sel:${name}`)?.press(); break;
      case 'newClip': if (t && t.kind !== 'audio') { const b = barOf(p, app.pos); app.arrange.createClip(t, b.start, barStart(p, b.bar + 4) - b.start); } break;
      case 'dupClip': key('d', { ctrl: true }); break;
      case 'delClip': key('Delete'); break;
      case 'quantize': app.editor.quantize?.(); break;
      case 'tap': this.tap(); break;
      case 'panic': app.audio.send({ t: 'panic' }); break;
      case 'tabClip': app.showTab('edit'); break;
      case 'tabInst': app.showTab('device'); break;
      case 'tabMixer': app.showTab('mixer'); break;
      case 'tabCtl': app.showTab('ctl'); break;
      case 'library': $('libbtn').click(); break;
      case 'zoomIn': app.view.zoom = Math.min(240, app.view.zoom * 1.25); app.arrange.redraw(); break;
      case 'zoomOut': app.view.zoom = Math.max(3, app.view.zoom / 1.25); app.arrange.redraw(); break;
      case 'save': key('s', { ctrl: true }); break;
      case 'newSynth': $('add-synth').click(); break;
      case 'newDrums': $('add-drum').click(); break;
      case 'toggleView': app.setMode(app.view.mode === 'session' ? 'arrange' : 'session'); break;
      case 'stopAll': app.stopAll(); break;
      case 'countIn': $('countin').click(); break;
      case 'punch': $('punch').click(); break;
      case 'addMarker': app.addMarker(); break;
      case 'prevMarker': app.gotoMarker(-1); break;
      case 'nextMarker': app.gotoMarker(1); break;
      case 'palette': app.palette?.open(); break;
      case 'dupTrack': if (t) app.duplicateTrack(t.id); break;
      case 'delTrack': if (t) app.deleteTrack(t.id); break;
    }
  }
  tap() {
    const now = performance.now();
    this.taps = this.taps.filter((x) => now - x < 2500); this.taps.push(now);
    if (this.taps.length >= 3) {
      const d = (this.taps.at(-1) - this.taps[0]) / (this.taps.length - 1);
      const bpm = Math.round(60000 / d * 10) / 10;
      if (bpm >= 40 && bpm <= 240) this.app.store.change((p) => { p.bpm = bpm; }, 'tap');
    }
  }

  // --------------------------------------------------------------- Mackie ---
  mackie(st, d1, d2) {
    const type = st & 0xf0, ch = st & 15, app = this.app, tracks = app.store.p.tracks;
    const strip = (n) => tracks[this.mcu.bank + n];
    if (type === 0xe0) {                                            // faders: one bend channel each, 8 = master
      const v = (d1 | (d2 << 7)) / 16383;
      if (ch === 8) this.target('master:vol').set(v);
      else if (strip(ch)) { const t = this.target(`t:${strip(ch).id}:vol`); t.set(v); this.recordAuto(t); }
      return true;
    }
    if (type === 0xb0 && d1 >= 0x10 && d1 <= 0x17) {                // V-pots: pan, relative
      const s = strip(d1 - 0x10);
      if (s) { const t = this.target(`t:${s.id}:pan`); t.set(clamp01(t.get() + (d2 & 64 ? -(d2 & 63) : d2 & 63) / 64)); this.recordAuto(t); }
      return true;
    }
    if (type === 0xb0 && d1 === 0x3c) {                            // jog wheel: the playhead, by 16ths
      app.seek(Math.max(0, app.pos + (d2 & 64 ? -(d2 & 63) : d2 & 63) * 0.25));
      return true;
    }
    if (type !== 0x90 || d2 === 0) return type === 0x90 || type === 0x80;
    const n = d1;
    if (n <= 0x1f) {
      const s = strip(n & 7);
      if (!s) return true;
      const what = ['arm', 'solo', 'mute', 'select'][n >> 3];
      this.target(`t:${s.id}:${what}`)?.press();
      return true;
    }
    const BTN = { 0x5b: 'rewind', 0x5c: 'forward', 0x5d: 'stop', 0x5e: 'play', 0x5f: 'record', 0x56: 'loop', 0x59: 'click',
      0x51: 'undo', 0x50: 'save', 0x54: 'newClip', 0x57: 'redo', 0x60: 'prevTrack', 0x61: 'nextTrack', 0x62: 'zoomOut', 0x63: 'zoomIn',
      0x4a: 'tabMixer', 0x4b: 'tabInst', 0x4c: 'tabClip', 0x46: 'prevSound', 0x47: 'nextSound' };
    if (n === 0x2e || n === 0x2f) { this.mcu.bank = Math.max(0, Math.min(Math.max(0, tracks.length - 8), this.mcu.bank + (n === 0x2e ? -8 : 8))); this.feedbackSoon(true); return true; }
    if (n === 0x30 || n === 0x31) { this.mcu.bank = Math.max(0, Math.min(Math.max(0, tracks.length - 1), this.mcu.bank + (n === 0x30 ? -1 : 1))); this.feedbackSoon(true); return true; }
    if (BTN[n]) { this.run(BTN[n]); return true; }
    return n >= 0x68 && n <= 0x70;                                  // fader touch: nothing to do
  }
  feedbackSoon(force = false) {
    if (this.grid.outs.size) { clearTimeout(this.gridT); this.gridT = setTimeout(() => this.grid.feedback(), 30); }
    if (force) this.mcu.lastSent.clear();
    if (this.fbQueued || !this.mcu.outs.size) return;
    this.fbQueued = true;
    setTimeout(() => { this.fbQueued = false; this.feedback(); }, 30);
  }
  feedback() {
    const app = this.app, tracks = app.store.p.tracks;
    const out = (k, bytes) => {
      const sig = bytes.join(',');
      if (this.mcu.lastSent.get(k) === sig) return;
      this.mcu.lastSent.set(k, sig);
      for (const o of this.mcu.outs) try { o.send(bytes); } catch { /* sysex not granted */ }
    };
    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
    let top = '', bottom = '';
    for (let n = 0; n < 8; n++) {
      const t = tracks[this.mcu.bank + n];
      const v = t ? Math.round(dbToPos(t.vol) * 16383) : 0;
      out(`f${n}`, [0xe0 | n, v & 127, v >> 7]);
      for (const [i, on] of [[0, t?.arm], [8, t?.solo], [16, t?.mute], [24, t && t.id === app.view.selTrack]]) out(`l${i + n}`, [0x90, i + n, on ? 127 : 0]);
      const pan = t ? Math.round((t.pan + 1) * 5.5) + 1 : 0;
      out(`v${n}`, [0xb0, 0x30 + n, t ? 0x10 + Math.min(11, pan) : 0]);
      top += pad(t ? t.name : '', 6) + ' ';
      bottom += pad(t ? (t.vol <= -60 ? '-inf' : `${t.vol.toFixed(1)}`) : '', 6) + ' ';
    }
    const mv = Math.round(dbToPos(app.store.p.master.vol) * 16383);
    out('fm', [0xe8, mv & 127, mv >> 7]);
    out('play', [0x90, 0x5e, app.playing ? 127 : 0]);
    out('stop', [0x90, 0x5d, app.playing ? 0 : 127]);
    out('rec', [0x90, 0x5f, app.recording ? 127 : 0]);
    out('cyc', [0x90, 0x56, app.store.p.loop.on ? 127 : 0]);
    out('clk', [0x90, 0x59, app.click ? 127 : 0]);
    const lcd = (pos, text) => [0xf0, 0x00, 0x00, 0x66, 0x14, 0x12, pos, ...[...text].map((c) => c.charCodeAt(0) & 127), 0xf7];
    out('lcd0', lcd(0, top.slice(0, 56)));
    out('lcd1', lcd(56, bottom.slice(0, 56)));
  }

  // ------------------------------------------------- external MIDI tracks ---
  // the engine's notes for hardware (an FM-1, any synth), sent so they sound when the audio does
  external(events) {
    const app = this.app, now = performance.now(), lat = app.audio.latency() * 1000;
    for (const [id, st, n, v] of events) {
      const t = app.store.track(id);
      const o = t?.ext?.port && this.outputs().find((x) => x.name === t.ext.port);
      if (!o) continue;
      try { o.send([st | ((t.ext.ch || 1) - 1), n & 127, v & 127], now + lat + (t.ext.latency || 0)); } catch { /* port gone */ }
    }
  }
  // live notes on an external track go straight out
  externalLive(t, on, n, v) {
    const o = t?.ext?.port && this.outputs().find((x) => x.name === t.ext.port);
    if (o) try { o.send([(on ? 0x90 : 0x80) | ((t.ext.ch || 1) - 1), n & 127, on ? v & 127 : 0]); } catch { /* ignore */ }
  }

  // ----------------------------------------------------------- MIDI clock ---
  // 24 clocks a beat, scheduled ahead with timestamps on the audio clock: hardware follows the tempo
  clockLoop() {
    const step = () => {
      const app = this.app, o = this.outputs().find((x) => x.name === this.cfg.clockOut);
      if (o && app.audio?.ctx) {
        if (app.playing) {
          const nowPerf = performance.now();
          const spc = 60 / app.store.p.bpm / 24;                  // seconds per clock
          if (!this.clock.running) {
            this.clock.running = true;
            const spp = Math.round(app.pos * 4);
            try { o.send([0xf2, spp & 127, (spp >> 7) & 127]); o.send([spp ? 0xfb : 0xfa]); } catch { /* ignore */ }
            this.clock.next = nowPerf + (app.audio.latency() * 1000);
          }
          while (this.clock.next < nowPerf + 120) { try { o.send([0xf8], this.clock.next); } catch { /* ignore */ } this.clock.next += spc * 1000; }
        } else if (this.clock.running) {
          this.clock.running = false;
          try { o.send([0xfc]); } catch { /* ignore */ }
        }
      }
      setTimeout(step, 25);
    };
    step();
  }
}
