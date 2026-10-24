// SPDX-License-Identifier: GPL-3.0-only
// The master's meters in the mixer: peak and RMS bars on a dB scale with their clip lights, true peak and its
// maximum, loudness (momentary, short-term, integrated, range) with RESET, stereo correlation, and a spectrum
// analyser. The engine measures; this draws, and only while it is on screen.
import { h } from './kit.js';
import { RATE } from '../engine-core.js';

const TOP = 6, BOT = -60;                                           // the bars' scale, dBFS
export const barPos = (db) => (db <= BOT ? 0 : Math.pow((Math.min(TOP, db) - BOT) / (TOP - BOT), 1.5));
const toDb = (x) => (x > 1e-6 ? 20 * Math.log10(x) : -120);
const fmt = (db, d = 1) => (db > -99 && Number.isFinite(db) ? `${db > 0.05 ? '+' : ''}${db.toFixed(d)}` : '-∞');
const lu = (x) => (Number.isFinite(x) && x > -99 ? x.toFixed(1) : '—');
const F0 = 20, F1 = 20000, SPEC_TOP = -6, SPEC_BOT = -96, TILT = 3;   // the analyser: 20 Hz..20 kHz, +3 dB / octave about 1 kHz
let pal = null;                                                    // the page's colours, read once
const colors = () => (pal ||= (() => { const cs = getComputedStyle(document.documentElement), g = (n, d) => cs.getPropertyValue(n).trim() || d;
  return { line: g('--line', '#23272b'), dim: g('--dim', '#737980'), text: g('--text', '#dfe2de'), go: g('--go', '#19b765'), warn: g('--warn', '#ffc21a'), accent: g('--accent', '#ff5b14'), rec: g('--rec', '#ff2f2f') }; })());

export class MeterPanel {
  constructor(app) {
    this.app = app;
    this.vals = { pk: [0, 0], rms: [0, 0], tp: [0, 0], tpMax: 0, corr: null, clip: [false, false], lufs: [-Infinity, -Infinity, -Infinity, 0], gr: 0 };
    this.bars = { pk: [BOT, BOT], hold: [BOT, BOT], holdAt: [0, 0] };
    this.corr = 0; this.tpWin = 0; this.lastText = 0; this.lastTick = 0;
    this.visible = false; this.raf = 0; this.last = 0;
    const read = (label, title) => { const v = h('b', { text: '—' }); return [h('div', { class: 'mp-row', title }, h('span', { text: label }), v), v]; };
    const [tpRow, tp] = read('TRUE PEAK', 'True peak (dBTP, 4x oversampled, ITU-R BS.1770): the highest the wave goes between the samples, over the last moment');
    const [tmRow, tpMax] = read('TP MAX', 'The highest true peak since play or RESET. Over -1 dBTP: streaming services may distort it when they encode it');
    const [rmsRow, rms] = read('RMS', 'RMS level over 300 ms, left / right (dBFS)');
    const [mRow, mom] = read('MOMENTARY', 'Momentary loudness, 400 ms (LUFS, EBU R128)');
    const [sRow, short] = read('SHORT-TERM', 'Short-term loudness, 3 s (LUFS)');
    const [rRow, range] = read('RANGE', 'Loudness range (LU, EBU Tech 3342): how much the song\'s loudness moves, since play or RESET');
    const [gRow, gr] = read('LIMITER', 'The master limiter\'s gain reduction right now');
    this.integ = h('b', { class: 'mp-int', text: '—' });
    this.out = { tp, tpMax, rms, mom, short, range, gr };
    this.clipBtn = h('button', { class: 'mp-clip', title: 'Clip: the master went over 0 dBFS (left, right). It stays lit until you click it', 'aria-label': 'Clip lights: click to reset', onclick: () => this.resetClip() }, h('i'), h('i'));
    this.reset = h('button', { class: 'add mp-reset', title: 'Start the integrated loudness, its range and the true-peak maximum again', onclick: () => this.resetLoud() }, 'RESET');
    this.limTag = h('span', { class: 'mp-lim' });
    this.lvl = h('canvas', { class: 'mp-lvl', 'aria-label': 'Master level: peak and RMS, left and right' });
    this.spec = h('canvas', { class: 'mp-spec', 'aria-label': 'Spectrum analyser' });
    this.corrMark = h('i');
    this.corrVal = h('b', { text: '—' });
    this.el = h('div', { class: 'mpanel' },
      h('div', { class: 'mp-head' }, h('span', { class: 'mp-title', text: 'MASTER METERS' }), this.limTag, this.reset),
      h('div', { class: 'mp-bars' }, this.clipBtn, h('div', { class: 'mp-lvlbox' }, this.lvl)),
      h('div', { class: 'mp-read' },
        h('div', { class: 'mp-introw', title: 'Integrated loudness: the whole song since play or RESET (LUFS, gated, EBU R128). Streaming plays music at about -14 LUFS' }, h('span', { text: 'INTEGRATED' }), this.integ, h('small', { text: 'LUFS' })),
        mRow, sRow, rRow, tpRow, tmRow, rmsRow, gRow),
      h('div', { class: 'mp-specbox' }, this.spec),
      h('div', { class: 'mp-corr', title: 'Stereo correlation over 300 ms: +1 mono, 0 wide, below 0 out of phase (it thins out in mono)' },
        h('span', { text: 'CORR' }), h('div', { class: 'mp-ctrack' }, h('em', { text: '-1' }), h('em', { text: '0' }), h('em', { text: '+1' }), this.corrMark), this.corrVal));
    this.sizes = new Map();
    const ro = new ResizeObserver(() => { for (const c of [this.lvl, this.spec]) this.fit(c); this.cols = null; this.draw(0); });
    ro.observe(this.lvl.parentElement); ro.observe(this.spec.parentElement);
    new IntersectionObserver((es) => { this.visible = es[es.length - 1].isIntersecting; if (this.visible) this.wake(); }).observe(this.el);
  }
  fit(cv) {
    const r = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    const W = Math.round(w * dpr), H = Math.round(hh * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    this.sizes.set(cv, [w, hh, dpr]);
  }
  resetClip() {
    this.vals.clip = [false, false];
    this.clipBtn.classList.remove('on', 'l', 'r');
    this.clipQuiet = performance.now() + 150;                       // (a tick already on its way still has them lit)
    this.app.audio.send({ t: 'meters', reset: 'clip' });
  }
  resetLoud() {
    this.vals.tpMax = 0; this.vals.lufs = [-Infinity, -Infinity, -Infinity, 0];
    this.bars.hold = [BOT, BOT];
    this.app.audio.send({ t: 'meters', reset: 'loud' });
    this.text(true);
  }
  // the limiter's state, from the project
  limit(lim) {
    const on = lim?.on !== false;
    this.limTag.textContent = on ? `LIMIT ${fmt(lim?.ceil ?? -0.3)} dB` : 'LIMIT OFF';
    this.limTag.classList.toggle('off', !on);
  }
  // a tick from the engine (about 30 a second)
  tick(m) {
    const v = this.vals, mt = m.meter;
    this.lastTick = performance.now();
    v.pk = [m.master[0], m.master[1]]; v.gr = m.master[2];
    if (m.lufs) v.lufs = m.lufs;
    if (mt) {
      v.rms = mt.rms; v.tp = mt.tp; v.tpMax = mt.tpMax; v.corr = mt.corr;
      this.tpWin = Math.max(this.tpWin, mt.tp[0], mt.tp[1]);
      if ((mt.clip[0] !== v.clip[0] || mt.clip[1] !== v.clip[1]) && !(performance.now() < this.clipQuiet)) {
        v.clip = mt.clip;
        this.clipBtn.classList.toggle('on', mt.clip[0] || mt.clip[1]);
        this.clipBtn.classList.toggle('l', mt.clip[0]); this.clipBtn.classList.toggle('r', mt.clip[1]);
      }
    }
    if (!this.visible) return;
    this.corr = v.corr == null ? this.corr * 0.8 : this.corr + (v.corr - this.corr) * 0.35;
    this.corrMark.style.left = `${((this.corr + 1) / 2 * 100).toFixed(1)}%`;
    this.corrMark.classList.toggle('neg', this.corr < -0.05);
    this.corrMark.classList.toggle('none', v.corr == null);
    this.text();
    this.wake();
  }
  // the numbers, a few times a second (readable, and cheap)
  text(now = false) {
    const t = performance.now();
    if (!now && t - this.lastText < 200) return;
    this.lastText = t;
    const v = this.vals, o = this.out, set = (el, s) => { if (el.textContent !== s) el.textContent = s; };
    const tp = toDb(this.tpWin), tpm = toDb(v.tpMax);
    this.tpWin = 0;
    set(o.tp, fmt(tp)); o.tp.classList.toggle('hot', tp > 0);
    set(o.tpMax, fmt(tpm)); o.tpMax.classList.toggle('hot', tpm > 0); o.tpMax.classList.toggle('warm', tpm > -1 && tpm <= 0);
    set(o.rms, `${fmt(toDb(v.rms[0]))} ${fmt(toDb(v.rms[1]))}`);
    set(o.mom, lu(v.lufs[0])); set(o.short, lu(v.lufs[1])); set(this.integ, lu(v.lufs[2]));
    set(o.range, Number.isFinite(v.lufs[2]) ? `${(v.lufs[3] || 0).toFixed(1)} LU` : '—');
    set(o.gr, v.gr > 0.001 ? `${fmt(toDb(1 - v.gr))} dB` : this.app.store.p.master.limit?.on === false ? 'OFF' : '0.0 dB');
    set(this.corrVal, v.corr == null ? '—' : `${v.corr >= 0 ? '+' : ''}${v.corr.toFixed(2)}`);
  }
  // drawing runs while the panel is on screen and something moves; then it sleeps until the next tick
  wake() { if (!this.raf && this.visible) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.frame(t)); } }
  frame(t) {
    this.raf = 0;
    if (!this.visible || !this.el.isConnected) return;
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000)); this.last = t;
    const moving = this.draw(dt);
    if (moving || t - this.lastTick < 1000) this.raf = requestAnimationFrame((x) => this.frame(x));
  }
  draw(dt) {
    if (!this.sizes.size) return false;
    const a = this.drawBars(dt), b = this.drawSpectrum(dt);
    return a || b;
  }
  drawBars(dt) {
    const sz = this.sizes.get(this.lvl);
    if (!sz) return false;
    const [w, hh, dpr] = sz, ctx = this.lvl.getContext('2d'), v = this.vals, B = this.bars;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const top = 5, bot = hh - 4, H = bot - top, y = (db) => bot - barPos(db) * H;
    const sw = 24, bw = Math.max(8, Math.floor((w - sw - 4) / 2)), x0 = sw + 2, now = performance.now();
    const P = colors(), line = P.line, dim = P.dim;
    // the scale
    ctx.font = '500 8px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const d of [6, 0, -3, -6, -12, -18, -24, -36, -48, -60]) {
      if (H < 120 && d === -3) continue;
      const yy = Math.round(y(d)) + 0.5;
      ctx.fillStyle = d === 0 ? '#c9ccc8' : dim;
      ctx.fillText(d > 0 ? `+${d}` : String(d), sw - 3, yy);
      ctx.fillStyle = line; ctx.fillRect(sw - 1, yy - 0.5, 2, 1);
    }
    // the bars: peak (falls 20 dB/s, its hold line 2 s), RMS solid inside it
    const grad = ctx.createLinearGradient(0, bot, 0, top);
    const stop = (db) => barPos(db);
    grad.addColorStop(0, P.go); grad.addColorStop(stop(-12), P.go); grad.addColorStop(stop(-12) + 0.001, P.warn);
    grad.addColorStop(stop(-3), P.warn); grad.addColorStop(stop(-3) + 0.001, P.accent); grad.addColorStop(stop(0), P.accent);
    grad.addColorStop(stop(0) + 0.001, P.rec); grad.addColorStop(1, P.rec);
    let moving = false;
    for (let c = 0; c < 2; c++) {
      const x = x0 + c * (bw + 3), pk = toDb(v.pk[c]), rm = toDb(v.rms[c]);
      B.pk[c] = Math.max(pk, B.pk[c] - 20 * dt);
      if (pk >= B.hold[c]) { B.hold[c] = pk; B.holdAt[c] = now; } else if (now - B.holdAt[c] > 2000) B.hold[c] = Math.max(BOT, B.hold[c] - 30 * dt);
      if (B.pk[c] > BOT || B.hold[c] > BOT) moving = true;
      ctx.fillStyle = line; ctx.fillRect(x, top, bw, H);
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.42; const yp = y(B.pk[c]); ctx.fillRect(x, yp, bw, bot - yp);
      ctx.globalAlpha = 1; const yr = y(rm); ctx.fillRect(x, yr, bw, bot - yr);
      if (B.hold[c] > BOT) { ctx.fillStyle = B.hold[c] > 0 ? P.rec : P.text; ctx.fillRect(x, Math.round(y(B.hold[c])) - 1, bw, 2); }
    }
    ctx.fillStyle = '#ffffff55'; ctx.fillRect(x0, Math.round(y(0)), bw * 2 + 3, 1);       // 0 dBFS
    return moving;
  }
  drawSpectrum(dt) {
    const sz = this.sizes.get(this.spec), an = this.app.audio?.analyser;
    if (!sz) return false;
    const [w, hh, dpr] = sz, ctx = this.spec.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const fx = (f) => Math.log(f / F0) / Math.log(F1 / F0) * w, yv = (d) => (SPEC_TOP - d) / (SPEC_TOP - SPEC_BOT) * hh;
    // the grid
    const P = colors();
    ctx.font = '500 8px "IBM Plex Mono", ui-monospace, monospace'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff0d';
    for (const f of [30, 40, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000]) ctx.fillRect(Math.round(fx(f)), 0, 1, hh);
    ctx.fillStyle = '#ffffff1c';
    for (const d of [-12, -24, -36, -48, -60, -72, -84]) ctx.fillRect(0, Math.round(yv(d)), w, 1);
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) ctx.fillRect(Math.round(fx(f)), 0, 1, hh);
    ctx.fillStyle = P.dim; ctx.textAlign = 'left';
    for (const [f, s] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) ctx.fillText(s, Math.round(fx(f)) + 2, 3);
    ctx.textAlign = 'right';
    for (const d of [-24, -48, -72]) ctx.fillText(String(d), w - 3, yv(d) + 2);
    ctx.fillText(`+${TILT} dB/OCT`, w - 3, hh - 11);
    if (!an) return false;
    // the columns: each its bins (interpolated low down, the loudest of many up high), tilted, smoothed, held
    const n = Math.max(2, Math.floor(w / 2)), bins = an.frequencyBinCount, hz = RATE / an.fftSize;
    if (!this.cols || this.cols.n !== n || this.cols.bins !== bins) {
      const a = new Float32Array(n + 1), tilt = new Float32Array(n);
      for (let i = 0; i <= n; i++) a[i] = F0 * Math.pow(F1 / F0, i / n) / hz;
      for (let i = 0; i < n; i++) tilt[i] = TILT * Math.log2(F0 * Math.pow(F1 / F0, (i + 0.5) / n) / 1000);
      this.cols = { n, bins, a, tilt, raw: new Float32Array(n), disp: new Float32Array(n).fill(-200), hold: new Float32Array(n).fill(-200), buf: new Float32Array(bins) };
    }
    const C = this.cols, buf = C.buf;
    an.getFloatFrequencyData(buf);
    let moving = false;
    for (let i = 0; i < n; i++) {
      const b0 = C.a[i], b1 = C.a[i + 1];
      let d;
      if (b1 - b0 < 1) { const k = Math.min(bins - 2, Math.floor((b0 + b1) / 2)), fr = (b0 + b1) / 2 - k; d = buf[k] + (buf[k + 1] - buf[k]) * fr; }
      else { d = -1e9; for (let k = Math.floor(b0), e = Math.min(bins - 1, Math.ceil(b1)); k <= e; k++) if (buf[k] > d) d = buf[k]; }
      if (!(d > -200)) d = -200;
      C.raw[i] = d + C.tilt[i];
    }
    for (let i = 0; i < n; i++) {                                      // (a touch of smoothing across neighbours)
      const d = (C.raw[Math.max(0, i - 1)] + 2 * C.raw[i] + C.raw[Math.min(n - 1, i + 1)]) / 4;
      C.disp[i] = d > C.disp[i] ? d : Math.max(d, C.disp[i] - 48 * dt);
      C.hold[i] = Math.max(C.disp[i], C.hold[i] - 10 * dt);
      if (C.hold[i] > SPEC_BOT) moving = true;
    }
    const X = (i) => (i + 0.5) / n * w;
    // the held peaks
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const yy = Math.min(hh, yv(C.hold[i])); if (i) ctx.lineTo(X(i), yy); else ctx.moveTo(X(i), yy); }
    ctx.strokeStyle = '#dfe2de59'; ctx.lineWidth = 1; ctx.stroke();
    // the spectrum
    ctx.beginPath(); ctx.moveTo(0, hh);
    for (let i = 0; i < n; i++) ctx.lineTo(X(i), Math.min(hh, yv(C.disp[i])));
    ctx.lineTo(w, hh); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, hh); g.addColorStop(0, '#ff5b1466'); g.addColorStop(1, '#ff5b1408');
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const yy = Math.min(hh, yv(C.disp[i])); if (i) ctx.lineTo(X(i), yy); else ctx.moveTo(X(i), yy); }
    ctx.strokeStyle = '#ff5b14'; ctx.lineWidth = 1.25; ctx.stroke();
    this.specDrawn = (this.specDrawn || 0) + 1;
    return moving;
  }
}
