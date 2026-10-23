// SPDX-License-Identifier: GPL-3.0-only
// The mixer: a strip per track (sends, pan, fader, meter, mute / solo), the two returns, the master.
import { h, knob, dragPointer } from './kit.js';

export const dbToPos = (db) => (db <= -60 ? 0 : Math.pow((db + 60) / 66, 2));
export const posToDb = (p) => (p <= 0.0005 ? -60 : Math.sqrt(p) * 66 - 60);
const fmtDb = (db) => (db <= -60 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);
const pct = (v) => `${Math.round(v * 100)}`;
const panFmt = (v) => (Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
const DELAYS = [[0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8.'], [1, '1/4'], [1.5, '1/4.'], [2, '1/2']];

// a send's short name: the return's, told apart from the others (DELAY, DELAY 3 > DELAY, DELA3)
function sendName(p, s) {
  const n = p.returns[s].name, short = n.replace(/\s+/g, '').slice(0, 5);
  return p.returns.some((r, j) => j !== s && r.name.replace(/\s+/g, '').slice(0, 5) === short) ? short.slice(0, 4) + (s + 1) : short;
}

export class Mixer {
  constructor(app, root) {
    this.app = app;
    this.wrap = h('div', { class: 'mixer' });
    root.append(this.wrap);
    this.strips = new Map();
    this.sig = '';
    app.store.on(() => this.refresh());
  }
  refresh() {
    const p = this.app.store.p;
    const sig = p.tracks.map((t) => t.id + t.color + t.name + (t.fx?.length || 0) + t.out + JSON.stringify(t.sendPre || [])).join('|') + this.app.view.selTrack + p.returns.map((r) => r.id + r.name + (r.fx?.length || 0)).join() + (p.master.fx?.length || 0);
    if (sig !== this.sig) { this.sig = sig; this.build(); return; }
    for (const s of this.strips.values()) s.update?.();
  }
  fader(get, set, label, learn) {
    const capEl = h('div', { class: 'cap' }), unity = h('div', { class: 'unity' });
    const track = h('div', { class: 'track', role: 'slider', tabindex: 0, 'aria-label': label, 'data-learn': learn }, unity, capEl);
    const meter = h('div', { class: 'vm' }, h('i'), h('i'));
    const place = () => {
      const pos = dbToPos(get());
      capEl.style.top = `${(1 - pos) * 100}%`;
      unity.style.top = `${(1 - dbToPos(0)) * 100}%`;
      track.setAttribute('aria-valuenow', get().toFixed(1));
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault(); track.focus();
      const r = track.getBoundingClientRect(), y0 = e.clientY, p0 = dbToPos(get());
      dragPointer(e, (m) => set(posToDb(Math.max(0, Math.min(1, p0 + (y0 - m.clientY) / r.height * (m.shiftKey ? 0.2 : 1))))), () => this.app.store.endGesture());
    });
    track.addEventListener('dblclick', () => set(0));
    track.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 0.5, ArrowDown: -0.5 }[e.key];
      if (d) { e.preventDefault(); e.stopPropagation(); set(Math.max(-60, Math.min(6, get() + d))); }
    });
    track.addEventListener('wheel', (e) => { e.preventDefault(); set(Math.max(-60, Math.min(6, get() - Math.sign(e.deltaY) * 0.5))); }, { passive: false });
    const el = h('div', { class: 'fader' }, track, meter);
    el.place = place; el.meter = meter;
    place();
    return el;
  }
  build() {
    const app = this.app, p = app.store.p, store = app.store;
    this.strips.clear();
    const kids = [];
    const edit = (id, fn, tag) => store.change((pp) => fn(pp.tracks.find((t) => t.id === id)), tag);
    for (const t of p.tracks) {
      const id = t.id, cur = () => store.track(id);
      const db = h('span', { class: 'db' });
      const fader = this.fader(() => cur().vol, (v) => edit(id, (x) => { x.vol = v; }, 'vol' + id), `${t.name} volume`, `t:${id}:vol`);
      // a send to every return; a click on its name: pre / post fader
      const sendK = p.returns.map((r, s) => {
        const k = knob({ label: `${t.sendPre?.[s] ? '◆' : ''}${sendName(p, s)}`, min: 0, max: 1, step: 0.01, value: t.sends[s] || 0, def: 0, size: 26, color: t.color,
          format: pct, onChange: (v) => edit(id, (x) => { x.sends[s] = v; }, `send${s}${id}`), onEnd: () => store.endGesture() });
        k.dataset.learn = `t:${id}:send${s}`;
        k.querySelector('.lbl').title = `Send to ${r.name}: click for pre / post fader (◆ = pre)`;
        k.querySelector('.lbl').addEventListener('click', (e) => {
          e.stopPropagation();
          const pre = !!cur().sendPre?.[s], setPre = (v) => edit(id, (x) => { x.sendPre ||= []; x.sendPre[s] = v; });
          app.sheet(`${t.name} → ${r.name}`, [[`${pre ? '✓ ' : ''}PRE-FADER (the fader does not change it)`, () => setPre(true)], [`${!pre ? '✓ ' : ''}POST-FADER (follows the fader)`, () => setPre(false)]]);
        });
        k.querySelector('.lbl').addEventListener('pointerdown', (e) => e.stopPropagation());
        return k;
      });
      const feeds = (gid) => { let x = p.tracks.find((q) => q.id === gid), k = 0; while (x && k++ < 16) { if (x.id === id) return true; x = p.tracks.find((q) => q.id === x.out); } return false; };
      const groups = p.tracks.filter((g) => g.kind === 'group' && g.id !== id && !feeds(g.id));   // a group that ends in this one would make a loop
      const outSel = h('select', { class: 'out', title: 'Output: the master or a group', 'aria-label': `${t.name} output`, onpointerdown: (e) => e.stopPropagation(),
        onchange: (e) => edit(id, (x) => { x.out = e.target.value; }) },
        h('option', { value: 'master' }, 'MASTER'), groups.map((g) => h('option', { value: g.id, selected: t.out === g.id ? true : null }, g.name)));
      const panK = knob({ label: 'PAN', min: -1, max: 1, step: 0.01, value: t.pan, def: 0, size: 28, color: t.color, format: panFmt,
        onChange: (v) => edit(id, (x) => { x.pan = v; }, 'pan' + id), onEnd: () => store.endGesture() });
      panK.dataset.learn = `t:${id}:pan`;
      const m = h('button', { class: 'tb m', 'data-learn': `t:${id}:mute`, onclick: () => edit(id, (x) => { x.mute = !x.mute; }) }, 'M');
      const s = h('button', { class: 'tb s', 'data-learn': `t:${id}:solo`, onclick: () => edit(id, (x) => { x.solo = !x.solo; }) }, 'S');
      const strip = h('div', { class: 'strip' + (id === app.view.selTrack ? ' sel' : '') + (t.kind === 'group' ? ' grp' : ''), '--c': t.color, onpointerdown: () => app.selectTrack(id) },
        h('div', { class: 'sname', text: t.name, title: t.name }), h('div', { class: 'kcol' }, panK, sendK), fader, db, h('div', { class: 'ms' }, m, s), outSel,
        h('button', { class: 'add fxb', title: 'This track\'s effects', onclick: (e) => { e.stopPropagation(); app.selectTrack(id); app.showTab('device'); } }, `FX ${t.fx?.length || 0}`));
      strip.update = () => {
        const x = cur(); if (!x) return;
        fader.place(); db.textContent = x.auto?.vol?.length ? 'AUTO' : fmtDb(x.vol); db.title = x.auto?.vol?.length ? 'The volume follows its automation lane' : '';
        sendK.forEach((k, i) => k.setValue(x.sends[i] || 0)); panK.setValue(x.pan);
        m.classList.toggle('on', x.mute); s.classList.toggle('on', x.solo);
      };
      strip.update();
      strip.meter = fader.meter;
      this.strips.set(id, strip);
      kids.push(strip);
    }
    // returns
    p.returns.forEach((r, i) => {
      const cur = () => store.p.returns[i];
      const set = (fn, tag) => store.change((pp) => fn(pp.returns[i]), tag);
      const db = h('span', { class: 'db' });
      const fader = this.fader(() => cur().vol, (v) => set((x) => { x.vol = v; }, 'rvol' + i), `${r.name} return`, `ret:${i}:vol`);
      const ks = r.type === 'none' ? [] : r.type === 'reverb'
        ? [knob({ label: 'SIZE', min: 0, max: 1, step: 0.01, value: r.size, def: 0.82, size: 28, format: pct, onChange: (v) => set((x) => { x.size = v; }, 'rs'), onEnd: () => store.endGesture() }),
          knob({ label: 'DAMP', min: 0, max: 1, step: 0.01, value: r.damp, def: 0.35, size: 28, format: pct, onChange: (v) => set((x) => { x.damp = v; }, 'rd'), onEnd: () => store.endGesture() })]
        : [knob({ label: 'TIME', min: 0, max: DELAYS.length - 1, value: Math.max(0, DELAYS.findIndex(([b]) => b === r.time)), def: 2, size: 28,
          format: (v) => DELAYS[v][1], onChange: (v) => set((x) => { x.time = DELAYS[v][0]; }, 'dt'), onEnd: () => store.endGesture() }),
          knob({ label: 'FDBK', min: 0, max: 0.9, step: 0.01, value: r.fb, def: 0.42, size: 28, format: pct, onChange: (v) => set((x) => { x.fb = v; }, 'df'), onEnd: () => store.endGesture() })];
      const m = h('button', { class: 'tb m', onclick: () => set((x) => { x.mute = !x.mute; }) }, 'M');
      const del = h('button', { class: 'tb x', title: 'Delete this return', onclick: () => {
        if (store.p.returns.length <= 1) { app.toast('Keep at least one return.'); return; }
        app.confirm(`Delete ${r.name}?`, `Every track's send to it goes with it. Undo (↶) brings it back.`, 'Delete', () =>
          store.change((pp) => { pp.returns.splice(i, 1); for (const t of pp.tracks) { t.sends?.splice(i, 1); t.sendPre?.splice(i, 1); } }), true);
      } }, '×');
      const strip = h('div', { class: 'strip ret', '--c': '#9aa0a6' }, h('div', { class: 'sname', text: r.name }), h('div', { class: 'kcol' }, h('span', { class: 'db', text: `RET ${String.fromCharCode(65 + i)}`, style: { color: 'var(--dim)', fontSize: '8px' } }), ks), fader, db, h('div', { class: 'ms' }, m, del),
        h('button', { class: 'add fxb', onclick: () => { app.view.selBus = 'ret' + i; app.showTab('device'); } }, `FX ${r.fx?.length || 0}`));
      strip.update = () => { fader.place(); db.textContent = fmtDb(cur().vol); m.classList.toggle('on', !!cur().mute); };
      strip.update(); strip.meter = fader.meter;
      this.strips.set('ret' + i, strip);
      kids.push(strip);
    });
    const mdb = h('span', { class: 'db' }), gr = h('span', { class: 'db', style: { color: 'var(--dim)' } });
    const mf = this.fader(() => store.p.master.vol, (v) => store.change((pp) => { pp.master.vol = v; }, 'mvol'), 'Master volume', 'master:vol');
    const lufs = h('span', { class: 'db', style: { color: 'var(--warn)', fontSize: '9px' }, text: 'LUFS —' });
    const master = h('div', { class: 'strip master', '--c': 'var(--accent)' }, h('div', { class: 'sname', text: 'MASTER' }), h('div', { class: 'kcol' }, h('span', { class: 'db', text: 'LIMIT', style: { color: 'var(--dim)', fontSize: '8px' } }), gr, lufs), mf, mdb, h('div', { class: 'ms' }),
      h('button', { class: 'add fxb', onclick: () => { app.view.selBus = 'master'; app.showTab('device'); } }, `FX ${p.master.fx?.length || 0}`));
    master.update = () => { mf.place(); mdb.textContent = fmtDb(store.p.master.vol); };
    master.update(); master.meter = mf.meter; master.gr = gr; master.lufs = lufs;
    this.strips.set('master', master);
    kids.push(master);
    this.wrap.replaceChildren(...kids);
  }
  meters(tick) {
    const lv = (x) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(1e-5, x)) + 60) / 63));
    const set = (strip, l) => { if (!strip || !l) return; const [a, b] = strip.meter.children; a.style.setProperty('--v', lv(l[0]).toFixed(3)); b.style.setProperty('--v', lv(l[1]).toFixed(3)); };
    for (const [id, l] of Object.entries(tick.tracks)) set(this.strips.get(id), l);
    tick.returns?.forEach((l, i) => set(this.strips.get('ret' + i), l));
    const m = this.strips.get('master');
    set(m, tick.master);
    if (m) m.gr.textContent = tick.master[2] > 0.01 ? `GR ${(20 * Math.log10(1 - tick.master[2])).toFixed(1)}` : 'GR 0.0';
    if (m && tick.lufs) m.lufs.textContent = Number.isFinite(tick.lufs[2]) ? `${tick.lufs[2].toFixed(1)} LUFS` : 'LUFS —';
  }
}
