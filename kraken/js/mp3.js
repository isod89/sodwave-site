// SPDX-License-Identifier: GPL-3.0-only
// MP3 export: LAME (lamejs, LGPL-3.0, vendor/lame.js: a separate library, loaded on the first MP3 only), constant
// bit rate, joint stereo, at 44.1 or 48 kHz (MP3 has no 88.2 / 96 kHz: those export at 44.1 / 48). The song's
// name goes in an ID3v2 tag. The mix is turned to 16 bits with TPDF dither, as for a 16-bit WAV.

export const MP3_RATES = [32000, 44100, 48000];
// the rate an MP3 is made at, for the rate asked
export const mp3Rate = (rate) => (MP3_RATES.includes(rate) ? rate : rate % 48000 === 0 ? 48000 : 44100);

let lame = null;
const loadLame = () => (lame ||= import('./vendor/lame.js').catch((e) => { lame = null; throw e; }));

const FRAME = 1152, CHUNK = FRAME * 48;                        // (about a second of audio between two yields)

function toInt16(x, from, n, dither) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = x[from + i], s = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767 + (dither ? Math.random() - Math.random() : 0))));
  }
  return out;
}

// ID3v2.3: the title and the encoder (UTF-16 text, so any name reads right)
export function id3(title, tool = 'Kraken (LAME)') {
  const text = (id, s) => {
    const body = new Uint8Array(3 + s.length * 2);
    body[0] = 1; body[1] = 0xff; body[2] = 0xfe;                // UTF-16, little-endian BOM
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); body[3 + 2 * i] = c & 255; body[4 + 2 * i] = c >> 8; }
    const f = new Uint8Array(10 + body.length);
    for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
    new DataView(f.buffer).setUint32(4, body.length);
    f.set(body, 10);
    return f;
  };
  const frames = [title ? text('TIT2', String(title).slice(0, 200)) : null, text('TSSE', tool)].filter(Boolean);
  const size = frames.reduce((a, f) => a + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0], 0);                      // "ID3", version 2.3.0, no flags
  for (let i = 0; i < 4; i++) tag[6 + i] = (size >> (21 - 7 * i)) & 127;   // (syncsafe size)
  let o = 10;
  for (const f of frames) { tag.set(f, o); o += f.length; }
  return tag;
}

// L, R: Float32Array at `rate` (already one of MP3_RATES); kbps: 128 to 320. Returns the file's bytes.
export async function encodeMp3(L, R, rate, kbps = 320, { title = '', onProgress } = {}) {
  if (!MP3_RATES.includes(rate)) throw new Error(`MP3 cannot be made at ${rate} Hz`);
  const { Mp3Encoder } = await loadLame();
  const enc = new Mp3Encoder(2, rate, kbps);
  const parts = [id3(title)];
  const n = L.length;
  for (let at = 0; at < n; at += CHUNK) {
    const k = Math.min(CHUNK, n - at);
    const out = enc.encodeBuffer(toInt16(L, at, k, true), toInt16(R, at, k, true));
    if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
    onProgress?.(Math.min(1, (at + k) / n));
    if (at + k < n) await new Promise((r) => setTimeout(r, 0));   // (the page stays alive on a long song)
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end.buffer, end.byteOffset, end.length).slice());
  const total = parts.reduce((a, p) => a + p.length, 0), file = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { file.set(p, o); o += p.length; }
  return file;
}

// the same, in a worker when the browser can (else here, yielding to the page between seconds of audio).
export function encodeMp3Off(L, R, rate, kbps = 320, opts = {}) {
  let w;
  try { w = new Worker(new URL('./mp3-worker.js', import.meta.url), { type: 'module', name: 'kraken-mp3' }); } catch { return encodeMp3(L, R, rate, kbps, opts); }
  return new Promise((ok, no) => {
    let started = false;
    const here = () => { w.terminate(); encodeMp3(L, R, rate, kbps, opts).then(ok, no); };
    w.onmessage = ({ data }) => {
      started = true;
      if (data.progress != null) opts.onProgress?.(data.progress);
      else { w.terminate(); data.error ? no(new Error(data.error)) : ok(data.file); }
    };
    w.onerror = (e) => { e.preventDefault?.(); if (!started) here(); else { w.terminate(); no(new Error('the MP3 encoder stopped')); } };
    w.postMessage({ L, R, rate, kbps, title: opts.title || '' });     // (copied: a failed worker falls back here)
  });
}
