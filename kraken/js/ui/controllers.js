// SPDX-License-Identifier: GPL-3.0-only
// The Controllers view: devices and their mode, MIDI Learn and the mappings, every action as a
// learnable button, and which MIDI channel plays which track.
import { h } from './kit.js';
import { ACTIONS, ENCODINGS, sourceLabel } from '../control.js';

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');

export class Controllers {
  constructor(app, root) {
    this.app = app;
    this.wrap = h('div', { class: 'device ctl' });
    root.append(this.wrap);
    app.control.on((why) => { if (why === 'msg') this.monitor(); else this.render(); });
    app.store.on((_p, why) => { if (why !== 'change' || this.sigTracks() !== this.lastTracks) this.render(); });
    this.render();
  }
  sigTracks() { return this.app.store.p.tracks.map((t) => t.id + t.name + (t.midiCh || 0)).join('|'); }
  render() {
    if (this.app.view.tab !== 'ctl' && this.built) { this.dirty = true; return; }
    this.built = true; this.dirty = false;
    this.lastTracks = this.sigTracks();
    const app = this.app, c = app.control, cfg = c.cfg;
    const mod = (title, em, ...kids) => h('div', { class: 'module' }, h('h4', {}, title, em ? h('em', { text: em }) : null), ...kids);
    const small = (text) => h('p', { class: 'ctl-note', text });

    // devices
    const ins = c.inputs();
    const devRows = ins.length ? ins.map((i) => h('label', { class: 'ctl-row' }, h('span', { class: 'ctl-dev', text: i.name, title: i.name }),
      h('select', { 'aria-label': `${i.name} mode`, onchange: (e) => c.setMode(i.name, e.target.value) },
        [['keys', 'KEYS & CONTROLS'], ['mackie', 'MACKIE CONTROL'], ['grid', 'GRID (LAUNCHPAD): THE SESSION'], ['off', 'OFF']].map(([v, l]) => h('option', { value: v, selected: c.modeOf(i.name) === v ? true : null }, l)))))
      : [small(c.status || (c.access ? 'No MIDI device found. Plug one in: it appears here at once.' : 'Waiting for MIDI access…'))];
    const outs = c.outputs();
    const mon = c.lastMsg ? `${c.lastMsg.data.slice(0, 3).map(hex).join(' ')}  ${this.describe(c.lastMsg.data)}` : '—';
    const devices = mod('DEVICES', `${ins.length} IN · ${outs.length} OUT`,
      ...devRows,
      h('div', { class: 'ctl-mon' }, h('b', { text: 'LAST MESSAGE' }), (this.mon = h('span', { text: mon }))),
      h('label', { class: 'ctl-row' }, h('span', { class: 'ctl-dev', text: 'MIDI CLOCK OUT' }),
        h('select', { 'aria-label': 'MIDI clock output', onchange: (e) => { cfg.clockOut = e.target.value; c.save(); } },
          h('option', { value: '' }, 'OFF'), outs.map((o) => h('option', { value: o.name, selected: cfg.clockOut === o.name ? true : null }, o.name)))),
      h('label', { class: 'ctl-row' }, h('span', { class: 'ctl-dev', text: 'SOFT TAKEOVER' }),
        h('input', { type: 'checkbox', checked: cfg.pickup ? true : null, onchange: (e) => { cfg.pickup = e.target.checked; c.save(); } })),
      small('Mackie Control: faders, V-pots (pan), mute / solo / arm / select, transport, jog, bank and channel buttons, with motor faders, LEDs and scribble strips. Any device also takes MIDI Start / Stop, Song Position, MMC and Program Change (sounds).'));

    // learn + mappings
    const rows = cfg.maps.map((m, i) => {
      const t = c.target(m.target);
      return h('div', { class: 'ctl-map' },
        h('span', { class: 'src', text: sourceLabel(m.src) }),
        h('span', { class: 'dst', text: t?.label || m.target, title: t?.label || m.target }),
        h('select', { 'aria-label': 'How the control acts', onchange: (e) => { m.enc = e.target.value; c.pick.delete(i); c.save(); } },
          Object.entries(ENCODINGS).map(([v, l]) => h('option', { value: v, selected: m.enc === v ? true : null }, l))),
        h('button', { class: 'tb', title: 'Remove this mapping', onclick: () => c.unmap(i) }, '×'));
    });
    const learn = mod('MIDI LEARN', `${cfg.maps.length} MAPPED`,
      h('div', { class: 'row', style: { display: 'flex', gap: '6px' } },
        h('button', { class: 'add' + (c.learning ? ' go' : ''), style: { flex: 1, height: '28px' }, onclick: () => c.setLearning(!c.learning) }, c.learning ? 'LEARNING · CLICK TO STOP' : 'START LEARNING'),
        h('button', { class: 'add', style: { height: '28px' }, onclick: () => { cfg.maps = []; c.save(); c.markMapped(); } }, 'CLEAR ALL')),
      h('div', { class: 'ctl-maps' }, rows.length ? rows : small('Nothing mapped yet. Start learning, click any knob, fader, button or action, then move a control on your device.')));

    // actions, selected track, globals: all learnable; outside learning, a click runs it
    const chip = (id, label) => h('button', { class: 'lchip', 'data-learn': id, onclick: () => { if (!c.learning) { const t = c.target(id); t?.press?.(); } } }, label);
    const actions = mod('ACTIONS', 'LEARNABLE',
      h('div', { class: 'chips' }, ACTIONS.map(([a, l]) => chip(`act:${a}`, l))),
      h('h4', { text: 'SELECTED TRACK', style: { marginTop: '4px' } }),
      h('div', { class: 'chips' }, [...Array(8)].map((_, k) => chip(`sel:knob:${k}`, `Knob ${k + 1}`)),
        chip('sel:vol', 'Volume'), chip('sel:pan', 'Pan'), chip('sel:send0', 'Send reverb'), chip('sel:send1', 'Send delay'),
        chip('sel:mute', 'Mute'), chip('sel:solo', 'Solo'), chip('sel:arm', 'Arm')),
      h('h4', { text: 'GLOBAL', style: { marginTop: '4px' } }),
      h('div', { class: 'chips' }, chip('bpm', 'Tempo'), chip('master:vol', 'Master volume'), chip('ret:0:vol', 'Reverb return'), chip('ret:1:vol', 'Delay return'),
        [...Array(8)].map((_, k) => chip(`strip:${k}:vol`, `Fader ${k + 1}`))));

    // routing
    const routing = mod('MIDI CHANNELS', 'NOTES IN',
      ...app.store.p.tracks.filter((t) => t.kind !== 'audio').map((t) => h('label', { class: 'ctl-row' },
        h('span', { class: 'ctl-dev', style: { color: t.color }, text: t.name }),
        h('select', { 'aria-label': `${t.name} MIDI channel`, onchange: (e) => app.store.change((p) => { p.tracks.find((x) => x.id === t.id).midiCh = +e.target.value; }) },
          h('option', { value: 0 }, 'WHEN SELECTED'), [...Array(16)].map((_, i) => h('option', { value: i + 1, selected: t.midiCh === i + 1 ? true : null }, `CHANNEL ${i + 1}`))))),
      small('A track on a channel always plays what comes in on it (several keyboards, an external sequencer, an FM-1). Everything else plays the armed track, or the selected one. Bend, mod wheel, pressure, sustain and CCs 7 / 10 / 71–75 / 91 / 94 go to the instrument too.'));
    this.wrap.replaceChildren(devices, learn, actions, routing);
    c.markMapped();
  }
  monitor() {
    const m = this.app.control.lastMsg;
    if (!m || !this.mon || this.monQueued) return;
    this.monQueued = true;
    requestAnimationFrame(() => { this.monQueued = false; this.mon.textContent = `${m.data.slice(0, 3).map(hex).join(' ')}  ${this.describe(m.data)}`; });
  }
  describe(d) {
    const [st, a = 0, b = 0] = d, type = st & 0xf0, ch = (st & 15) + 1;
    if (st === 0xf8) return 'CLOCK';
    if (st === 0xfa) return 'START'; if (st === 0xfc) return 'STOP'; if (st === 0xfb) return 'CONTINUE';
    if (st === 0xf0) return 'SYSEX';
    if (type === 0x90 && b) return `NOTE ON ${a} VEL ${b} · CH ${ch}`;
    if (type === 0x80 || type === 0x90) return `NOTE OFF ${a} · CH ${ch}`;
    if (type === 0xb0) return `CC ${a} = ${b} · CH ${ch}`;
    if (type === 0xe0) return `BEND ${(a | (b << 7)) - 8192} · CH ${ch}`;
    if (type === 0xd0) return `PRESSURE ${a} · CH ${ch}`;
    if (type === 0xc0) return `PROGRAM ${a} · CH ${ch}`;
    return '';
  }
}
