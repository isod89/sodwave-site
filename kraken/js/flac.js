// SPDX-License-Identifier: GPL-3.0-only
// A FLAC encoder (lossless), written for Kraken: fixed predictors (orders 0 to 4) with partitioned Rice
// coding, left / side, right / side, mid / side or independent stereo, whichever is smallest each block.
// Float channels in, a .flac file out (16 or 24 bits). Spec: https://xiph.org/flac/format.html

const BLOCK = 4096;

class Bits {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.pos = 0; this.acc = 0; this.n = 0; }
  grow(need) { if (this.pos + need < this.buf.length) return; const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + need + 1024)); b.set(this.buf); this.buf = b; }
  // up to 32 bits at a time (values are written big-endian, most significant bit first)
  put(v, bits) {
    if (bits > 24) { this.put(Math.floor(v / 65536) & ((1 << (bits - 16)) - 1), bits - 16); this.put(v & 0xffff, 16); return; }
    this.grow(8);
    this.acc = (this.acc << bits) | (v & ((1 << bits) - 1)); this.n += bits;
    while (this.n >= 8) { this.n -= 8; this.buf[this.pos++] = (this.acc >>> this.n) & 255; }
    this.acc &= (1 << this.n) - 1;
  }
  signed(v, bits) { this.put(v < 0 ? v + 2 ** bits : v, bits); }
  unary(q) { while (q >= 24) { this.put(0, 24); q -= 24; } this.put(1, q + 1); }
  align() { if (this.n) this.put(0, 8 - this.n); }
  bytes() { return this.buf.subarray(0, this.pos); }
}

const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; CRC8[i] = c;
  let d = i << 8; for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d;
}
const crc8 = (b, a, e) => { let c = 0; for (let i = a; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = (b, a, e) => { let c = 0; for (let i = a; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

// the residual of fixed predictor `order` (the spec's polynomials), from sample `order` on
function residual(x, n, order, out) {
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: out[i] = x[i]; break;
      case 1: out[i] = x[i] - x[i - 1]; break;
      case 2: out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }
}
const zig = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
// Rice bits for n values summing to `sum` (folded), parameter k: an estimate, close enough to choose with
const riceBits = (n, sum, k) => n * (k + 1) + Math.floor(sum / 2 ** k);
function bestK(n, sum) {
  const mean = n ? sum / n : 0;
  let k = mean > 1 ? Math.min(14, Math.floor(Math.log2(mean))) : 0, best = riceBits(n, sum, k);
  for (const kk of [k - 1, k + 1]) if (kk >= 0 && kk <= 14) { const c = riceBits(n, sum, kk); if (c < best) { best = c; k = kk; } }
  return [k, best];
}
// partition orders 0..6: the cheapest split of the block's residuals (sums of the finest split, added up)
function planResidual(r, n, order) {
  let maxPo = 0;
  while (maxPo < 6 && n % (1 << (maxPo + 1)) === 0 && (n >> (maxPo + 1)) > order) maxPo++;
  const fine = 1 << maxPo, size = n >> maxPo, sums = new Float64Array(fine);
  for (let p = 0; p < fine; p++) { let s = 0; for (let i = Math.max(order, p * size), e = (p + 1) * size; i < e; i++) s += zig(r[i]); sums[p] = s; }
  let best = null;
  for (let po = maxPo; po >= 0; po--) {
    const parts = [], step = 1 << (maxPo - po), psize = n >> po;
    let bits = 6;
    for (let p = 0; p < 1 << po; p++) {
      let s = 0; for (let q = p * step; q < (p + 1) * step; q++) s += sums[q];
      const cnt = psize - (p === 0 ? order : 0), [k, c] = bestK(cnt, s);
      parts.push(k); bits += 4 + c;
    }
    if (!best || bits < best.bits) best = { po, parts, bits };
  }
  return best;
}
// fixed predictor order by the smallest sum of residuals (one pass for all five), then its Rice plan
function planSubframe(x, n, bps) {
  let same = true; for (let i = 1; i < n; i++) if (x[i] !== x[0]) { same = false; break; }
  if (same) return { type: 'const', bits: 8 + bps };
  let best = { type: 'verbatim', bits: 8 + bps * n };
  if (n < 5) return best;
  let e0 = 0, e1 = 0, e2 = 0, e3 = 0, e4 = 0;
  for (let i = 4; i < n; i++) {
    const a = x[i], b = x[i - 1], c = x[i - 2], d = x[i - 3], f = x[i - 4];
    e0 += Math.abs(a); e1 += Math.abs(a - b); e2 += Math.abs(a - 2 * b + c); e3 += Math.abs(a - 3 * b + 3 * c - d); e4 += Math.abs(a - 4 * b + 6 * c - 4 * d + f);
  }
  const es = [e0, e1, e2, e3, e4];
  const order = es.indexOf(Math.min(...es));
  const r = new Int32Array(n);
  residual(x, n, order, r);
  const plan = planResidual(r, n, order);
  const bits = 8 + order * bps + plan.bits;
  if (bits < best.bits) best = { type: 'fixed', order, plan, r, bits };
  return best;
}
function writeSubframe(w, x, n, bps, sf) {
  if (sf.type === 'const') { w.put(0, 8); w.signed(x[0], bps); return; }
  if (sf.type === 'verbatim') { w.put(1 << 1, 8); for (let i = 0; i < n; i++) w.signed(x[i], bps); return; }
  w.put((8 | sf.order) << 1, 8);
  for (let i = 0; i < sf.order; i++) w.signed(x[i], bps);
  const { po, parts } = sf.plan, size = n >> po;
  w.put(0, 2); w.put(po, 4);
  for (let p = 0; p < parts.length; p++) {
    const k = parts[p], a = p === 0 ? sf.order : p * size, e = (p + 1) * size;
    w.put(k, 4);
    for (let i = a; i < e; i++) { const u = zig(sf.r[i]), q = Math.floor(u / 2 ** k); w.unary(q); if (k) w.put(u - q * 2 ** k, k); }
  }
}
function utf8num(v) {                                         // the frame number, "UTF-8" coded
  if (v < 0x80) return [v];
  const out = []; let lim = 0x3f, n = 0;
  while (v > lim) { out.unshift(0x80 | (v & 0x3f)); v = Math.floor(v / 64); n++; lim >>= 1; }
  out.unshift(((0xff00 >> (n + 1)) & 0xff) | v);
  return out;
}

export function encodeFlac(channels, rate = 44100, bps = 24, dither = false) {
  const ch = channels.length, total = channels[0].length, max = 2 ** (bps - 1) - 1;
  const ints = channels.map((c) => { const o = new Int32Array(total); for (let i = 0; i < total; i++) o[i] = Math.max(-max - 1, Math.min(max, Math.round(c[i] * max + (dither ? Math.random() - Math.random() : 0)))); return o; });
  const w = new Bits(total * ch * (bps / 8) / 2 + 4096);
  // "fLaC", STREAMINFO (last metadata block)
  for (const c of 'fLaC') w.put(c.charCodeAt(0), 8);
  w.put(0x80, 8); w.put(34, 24);
  w.put(BLOCK, 16); w.put(BLOCK, 16); w.put(0, 24); w.put(0, 24);
  w.put(rate, 20); w.put(ch - 1, 3); w.put(bps - 1, 5);
  w.put(Math.floor(total / 2 ** 32), 4); w.put(total >>> 0, 32);
  for (let i = 0; i < 16; i++) w.put(0, 8);                  // MD5: not computed (allowed: 0 = unknown)
  const rateCode = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 }[rate] ?? 0;
  const sizeCode = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 }[bps];
  let frame = 0;
  for (let at = 0; at < total; at += BLOCK, frame++) {
    const n = Math.min(BLOCK, total - at);
    const sub = ints.map((c) => c.subarray(at, at + n));
    // stereo: pick the cheapest of independent, left / side, side / right, mid / side
    let assign = ch - 1, subs = sub.map((x) => [x, bps]);
    if (ch === 2) {
      const L = sub[0], R = sub[1], S = new Int32Array(n), M = new Int32Array(n);
      for (let i = 0; i < n; i++) { S[i] = L[i] - R[i]; M[i] = (L[i] + R[i]) >> 1; }
      const pl = planSubframe(L, n, bps), pr = planSubframe(R, n, bps), ps = planSubframe(S, n, bps + 1), pm = planSubframe(M, n, bps);
      const opts = [[1, pl.bits + pr.bits, [[L, bps, pl], [R, bps, pr]]], [8, pl.bits + ps.bits, [[L, bps, pl], [S, bps + 1, ps]]],
        [9, ps.bits + pr.bits, [[S, bps + 1, ps], [R, bps, pr]]], [10, pm.bits + ps.bits, [[M, bps, pm], [S, bps + 1, ps]]]];
      opts.sort((a, b) => a[1] - b[1]);
      assign = opts[0][0]; subs = opts[0][2];
    } else subs = sub.map((x) => [x, bps, planSubframe(x, n, bps)]);
    const start = w.pos;
    w.put(0xfff8, 16);
    w.put(n === BLOCK ? 12 : 7, 4); w.put(rateCode, 4);
    w.put(assign, 4); w.put(sizeCode, 3); w.put(0, 1);
    for (const b of utf8num(frame)) w.put(b, 8);
    if (n !== BLOCK) w.put(n - 1, 16);
    w.put(crc8(w.buf, start, w.pos), 8);
    for (const [x, b, plan] of subs) writeSubframe(w, x, n, b, plan);
    w.align();
    w.put(crc16(w.buf, start, w.pos), 16);
  }
  return w.bytes().slice();
}
