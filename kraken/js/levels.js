// SPDX-License-Identifier: GPL-3.0-only
// The master's meters, in the engine: true peak (4x oversampled with the ITU-R BS.1770-4 interpolator),
// RMS and stereo correlation over 300 ms, the clip lights. The engine feeds it each block; its report reads it.

// BS.1770-4 annex 2: the 48-tap interpolating filter, as its four phases of 12 taps
const TP = Float64Array.of(
  0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625,
  0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500,
  -0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250,
  0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000, -0.2003173828125, 0.7797851562500,
  0.4650878906250, -0.1665039062500, 0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875,
  -0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.1022949218750, 0.9721679687500,
  0.1373291015625, -0.0594482421875, 0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750);

export class Levels {
  constructor(block = 32, rate = 44100) {
    this.hl = new Float64Array(24); this.hr = new Float64Array(24); this.w = 0;   // the last 12 samples, twice over (no wrap in the filter)
    this.block = block; this.size = Math.round(0.3 * rate / block);              // 300 ms of blocks
    this.ll = new Float64Array(this.size); this.rr = new Float64Array(this.size); this.lr = new Float64Array(this.size); this.at = 0;
    this.quiet = false;
    this.clip = [false, false];
    this.tp = [0, 0]; this.tpMax = 0;
  }
  resetPeak() { this.tpMax = 0; }
  resetClip() { this.clip[0] = this.clip[1] = false; }
  push(L, R, n) {
    let ll = 0, rr = 0, lr = 0, pl = 0, pr = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      ll += l * l; rr += r * r; lr += l * r;
      if (l > pl) pl = l; else if (-l > pl) pl = -l;
      if (r > pr) pr = r; else if (-r > pr) pr = -r;
    }
    const k = this.at; this.ll[k] = ll; this.rr[k] = rr; this.lr[k] = lr; this.at = k + 1 === this.size ? 0 : k + 1;
    if (pl > 1) this.clip[0] = true;
    if (pr > 1) this.clip[1] = true;
    // true peak: each sample and the three between it and the next; silence twice in a row costs nothing
    const silent = pl < 1e-9 && pr < 1e-9;
    if (silent && this.quiet) return;
    this.quiet = silent;
    const h = this.hl, g = this.hr;
    let w = this.w, tl = this.tp[0], tr = this.tp[1];
    for (let i = 0; i < n; i++) {
      w = w === 11 ? 0 : w + 1;
      h[w] = h[w + 12] = L[i]; g[w] = g[w + 12] = R[i];
      for (let c = 0; c < 48; c += 12) {
        let a = 0, b = 0;
        for (let j = 0, x = w + 12; j < 12; j++, x--) { const q = TP[c + j]; a += q * h[x]; b += q * g[x]; }
        if (a < 0) a = -a; if (b < 0) b = -b;
        if (a > tl) tl = a; if (b > tr) tr = b;
      }
    }
    this.w = w; this.tp[0] = tl; this.tp[1] = tr;
  }
  // what the meters show: true peak since the last read (and its maximum since a reset), RMS, correlation (null: silence)
  read() {
    let ll = 0, rr = 0, lr = 0;
    for (let i = 0; i < this.size; i++) { ll += this.ll[i]; rr += this.rr[i]; lr += this.lr[i]; }
    const n = this.size * this.block, tp = [this.tp[0], this.tp[1]];
    this.tpMax = Math.max(this.tpMax, tp[0], tp[1]); this.tp[0] = this.tp[1] = 0;
    const eps = 1e-10 * n;
    const corr = ll < eps && rr < eps ? null : ll < eps || rr < eps ? 0 : Math.max(-1, Math.min(1, lr / Math.sqrt(ll * rr)));
    return { tp, tpMax: this.tpMax, rms: [Math.sqrt(ll / n), Math.sqrt(rr / n)], corr, clip: [this.clip[0], this.clip[1]] };
  }
}
