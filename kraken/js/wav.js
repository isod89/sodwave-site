// SPDX-License-Identifier: GPL-3.0-only
// WAV files: 16 / 24-bit PCM or 32-bit float, interleaved from planar channels.
// dither: TPDF noise of one 16-bit step, for 16-bit files (masks the rounding distortion of quiet tails)
export function encodeWav(channels, rate, bits = 24, dither = false) {
  const ch = channels.length, frames = channels[0].length;
  const bytes = bits / 8, fmt = bits === 32 ? 3 : 1;
  const data = frames * ch * bytes;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, fmt, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * bytes, true); v.setUint16(32, ch * bytes, true);
  v.setUint16(34, bits, true); str(36, 'data'); v.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const raw = channels[c][i], x = Math.max(-1, Math.min(1, raw));
      if (bits === 32) { v.setFloat32(o, Number.isFinite(raw) ? raw : 0, true); o += 4; }   // (float: overs kept, for mastering)
      else if (bits === 24) {
        const s = Math.round(x * 8388607);
        v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
      } else { v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x * 32767 + (dither ? Math.random() - Math.random() : 0)))), true); o += 2; }
    }
  }
  return new Uint8Array(buf);
}
