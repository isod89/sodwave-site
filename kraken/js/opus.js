// SPDX-License-Identifier: GPL-3.0-only
// Opus export: the browser's own encoder (WebCodecs AudioEncoder), packed into an Ogg file here
// (RFC 7845). Opus runs at 48 kHz: the mix is resampled by the browser first (OfflineAudioContext).

export const opusSupported = async () => {
  if (typeof AudioEncoder === 'undefined') return false;
  try { return (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported; } catch { return false; }
};

const CRC = (() => {                                          // Ogg's CRC-32: polynomial 0x04c11db7, not reflected
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
  return t;
})();
const crc = (b) => { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 255]) >>> 0; return c; };

// packets -> Ogg pages: [{ data: Uint8Array, granule, page? }]; page: end the page after this packet.
// A packet is never split (Opus packets are small), so no page continues another.
export function oggPages(packets, serial = 0x4b52414b) {
  const pages = [];
  let seq = 0, segs = [], body = [], granule = 0;
  const flush = (last) => {
    if (!segs.length) return;
    const size = body.reduce((s, x) => s + x.length, 0), page = new Uint8Array(27 + segs.length + size), v = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53, 0], 0);
    page[5] = (seq === 0 ? 2 : 0) | (last ? 4 : 0);
    v.setUint32(6, granule >>> 0, true); v.setUint32(10, Math.floor(granule / 2 ** 32), true);
    v.setUint32(14, serial, true); v.setUint32(18, seq++, true);
    page[26] = segs.length; page.set(segs, 27);
    let o = 27 + segs.length; for (const x of body) { page.set(x, o); o += x.length; }
    v.setUint32(22, crc(page), true);
    pages.push(page);
    segs = []; body = [];
  };
  packets.forEach((pk, i) => {
    const lace = [...Array(Math.floor(pk.data.length / 255)).fill(255), pk.data.length % 255];
    if (segs.length + lace.length > 255) flush(false);
    segs.push(...lace); body.push(pk.data);
    if (pk.granule != null) granule = pk.granule;
    const last = i === packets.length - 1;
    if (pk.page || last || segs.length > 200) flush(last);
  });
  return pages;
}

function opusHead(channels, preSkip, rate) {
  const b = new Uint8Array(19), v = new DataView(b.buffer);
  b.set([...'OpusHead'].map((c) => c.charCodeAt(0)));
  b[8] = 1; b[9] = channels; v.setUint16(10, preSkip, true); v.setUint32(12, rate, true); v.setInt16(16, 0, true); b[18] = 0;
  return b;
}
function opusTags(vendor = 'Kraken by Sodwave') {
  const enc = new TextEncoder(), ven = enc.encode(vendor), b = new Uint8Array(8 + 4 + ven.length + 4), v = new DataView(b.buffer);
  b.set([...'OpusTags'].map((c) => c.charCodeAt(0))); v.setUint32(8, ven.length, true); b.set(ven, 12); v.setUint32(12 + ven.length, 0, true);
  return b;
}

// a stereo mix at `rate` -> an .opus file (Ogg); bitrate in bits per second
export async function encodeOpus(L, R, rate = 44100, bitrate = 192000, onProgress = () => {}) {
  // 1. resample to 48 kHz with the browser
  const frames48 = Math.ceil(L.length * 48000 / rate);
  const off = new OfflineAudioContext(2, frames48, 48000);
  const buf = off.createBuffer(2, L.length, rate); buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const res = await off.startRendering();
  const a = res.getChannelData(0), b = res.getChannelData(1);
  // 2. encode, 20 ms at a time
  const chunks = [];
  let head = null, err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
      chunks.push(d);
      const desc = meta?.decoderConfig?.description;
      if (desc && !head) { const u = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength); if (u.length >= 19 && String.fromCharCode(...u.subarray(0, 8)) === 'OpusHead') head = u.slice(); }
    },
    error: (e) => { err = e; },
  });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate });
  const F = 960 * 50, padded = frames48 + 1920;                 // one second at a time; the padding lets the encoder's look-ahead out
  for (let i = 0; i < padded; i += F) {
    const n = Math.min(F, padded - i), planar = new Float32Array(n * 2);
    if (i < frames48) { const m = Math.min(n, frames48 - i); planar.set(a.subarray(i, i + m), 0); planar.set(b.subarray(i, i + m), n); }
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / 48 * 1000), data: planar }));
    if (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
    onProgress(Math.min(1, i / frames48));
  }
  await enc.flush(); enc.close();
  if (err) throw err;
  // 3. into Ogg: the header, the tags, the audio (granule: 48 kHz samples, pre-skip included)
  const preSkip = head ? new DataView(head.buffer, head.byteOffset).getUint16(10, true) : 312;
  const packets = [{ data: head || opusHead(2, preSkip, rate), granule: 0, page: true }, { data: opusTags(), granule: 0, page: true }];
  let g = 0;                                                    // granule: every decoded sample, the pre-skip's included
  chunks.forEach((d, i) => {
    g += 960;                                                   // 20 ms frames
    const last = i === chunks.length - 1;
    packets.push({ data: d, granule: last ? preSkip + frames48 : Math.min(g, preSkip + frames48), page: (i + 1) % 50 === 0 });
  });
  const pages = oggPages(packets);
  const out = new Uint8Array(pages.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of pages) { out.set(p, o); o += p.length; }
  return out;
}
