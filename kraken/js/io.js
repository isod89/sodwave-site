// SPDX-License-Identifier: GPL-3.0-only
// Files out: a save that works both inside claude.ai (the downloads capability) and on its own
// (a plain download), a stored ZIP writer, and Standard MIDI Files.
import { clipEvents, ctlEvents } from './engine-core.js';
import { meterList } from './meter.js';

let downloads;
async function downloadsCap() {
  if (downloads !== undefined) return downloads;
  try { downloads = window.claude?.use ? await window.claude.use('downloads') : null; } catch { downloads = null; }
  return downloads;
}

// inside claude.ai: the hosted save (a page there cannot write files itself)
export const hostedSave = async () => !!(await downloadsCap());

// .wav and .mid are not accepted by the hosted save, so inside claude.ai they travel in a .zip
export async function saveFile(filename, data, { zipWhenHosted = false } = {}) {
  const cap = await downloadsCap();
  if (cap) {
    let name = filename, payload = data;
    if (zipWhenHosted) { payload = zip([{ name: filename, data }]); name = filename.replace(/\.[^.]+$/, '') + '.zip'; }
    await cap.save({ filename: name, data: payload instanceof Uint8Array ? new Blob([payload]) : payload });
    return name;
  }
  const blob = data instanceof Blob ? data : new Blob([data]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return filename;
}

// ------------------------------------------------------------------------- zip ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (d) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);   // (names in UTF-8)
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

// ------------------------------------------------------------------------ MIDI ---
// Type 1, 480 ticks a beat: a tempo track, then one track per instrument (drums on channel 10).
export function exportMidi(p) {
  const PPQ = 480, chunks = [];
  const vlq = (n) => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
  const track = (events) => {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const bytes = []; let last = 0;
    for (const e of events) { bytes.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
    bytes.push(0, 0xff, 0x2f, 0);
    return bytes;
  };
  const setTempo = (beat, bpm) => { const us = Math.round(60000000 / bpm); return { tick: Math.round(beat * PPQ), order: 0, data: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] }; };
  // the tempo map: each point, and its ramps in steps of a 16th
  const tm = (p.tempo || []).filter((q) => Number.isFinite(q.t) && q.v > 0).sort((a, b) => a.t - b.t), tempos = [setTempo(0, tm.length ? tm[0].v : p.bpm)];
  for (let i = 0; i < tm.length; i++) {
    const a = tm[i], b = tm[i + 1];
    if (a.t > 0) tempos.push(setTempo(a.t, a.v));
    if (b && Math.abs(b.v - a.v) > 0.01) for (let t = a.t + 0.25; t < b.t - 1e-6; t += 0.25) tempos.push(setTempo(t, a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t)));
  }
  chunks.push(track([
    ...tempos,
    ...meterList(p).map((m) => ({ tick: Math.round(m.t * PPQ), order: 1, data: [0xff, 0x58, 4, m.n, Math.round(Math.log2(m.d)), 24, 8] })),
    ...(p.markers || []).map((m) => { const b = new TextEncoder().encode(m.name); return { tick: Math.round(m.t * PPQ), order: 2, data: [0xff, 0x06, ...vlq(b.length), ...b] }; }),
  ]));
  let next = 0;
  const chan = () => { if (next % 16 === 9) next++; return next++ % 16; };
  for (const t of p.tracks) {
    if (t.kind === 'audio') continue;
    const c = t.kind === 'drum' ? 9 : chan();
    const name = new TextEncoder().encode(t.name);
    const ev = [{ tick: 0, order: 0, data: [0xff, 0x03, name.length, ...name] }];
    const notes = [], ctl = []; for (const clip of t.clips) { clipEvents(clip, notes); ctlEvents(clip, ctl); }
    for (const e of ctl) ev.push({ tick: Math.round(e.t * PPQ), order: 1.5, data: e.c[0] === 0xd0 ? [0xd0 | c, e.c[1]] : [e.c[0] | c, e.c[1], e.c[2]] });
    for (const n of notes) {
      ev.push({ tick: Math.round(n.t * PPQ), order: 2, data: [0x90 | c, n.n & 127, Math.max(1, n.v & 127)] });
      ev.push({ tick: Math.round((n.t + n.d) * PPQ), order: 1, data: [0x80 | c, n.n & 127, 0] });
    }
    chunks.push(track(ev));
  }
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, chunks.length, PPQ >> 8, PPQ & 255];
  const out = [...head];
  for (const c of chunks) out.push(0x4d, 0x54, 0x72, 0x6b, (c.length >>> 24) & 255, (c.length >> 16) & 255, (c.length >> 8) & 255, c.length & 255, ...c);
  return new Uint8Array(out);
}

// read a ZIP (stored or deflated entries)
export async function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This is not a ZIP file.');
  const count = v.getUint16(e + 10, true);
  let o = v.getUint32(e + 16, true);
  const dec = new TextDecoder(), out = [];
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(o + 10, true), csize = v.getUint32(o + 20, true);
    const nlen = v.getUint16(o + 28, true), xlen = v.getUint16(o + 30, true), clen = v.getUint16(o + 32, true);
    const local = v.getUint32(o + 42, true);
    const name = dec.decode(bytes.subarray(o + 46, o + 46 + nlen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    let data = bytes.subarray(start, start + csize);
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else if (method !== 0) throw new Error(`Unsupported compression in ${name}.`);
    out.push({ name, data });
    o += 46 + nlen + xlen + clen;
  }
  return out;
}

// read a Standard MIDI File (type 0 or 1): tempo, and the notes per track and channel
export function parseMidi(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (str(0) !== 'MThd') throw new Error('This is not a MIDI file.');
  const ntrk = v.getUint16(10), div = v.getUint16(12);
  if (div & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported.');
  const tempos = [];
  let o = 8 + v.getUint32(4), bpm = 120, sig = 4;
  const meters = [];                                     // every time signature: [{ t: beat, n, d }]
  const out = [];
  for (let k = 0; k < ntrk && o < bytes.length; k++) {
    if (str(o) !== 'MTrk') break;
    const end = o + 8 + v.getUint32(o + 4);
    let p = o + 8, tick = 0, run = 0, name = '';
    const open = new Map(), byCh = new Map();
    const vlq = () => { let x = 0, b; do { b = bytes[p++]; x = (x << 7) | (b & 127); } while (b & 128); return x; };
    while (p < end) {
      tick += vlq();
      let st = bytes[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xff) {
        const type = bytes[p++], len = vlq();
        if (type === 0x51 && len === 3) { const b2 = 60000000 / ((bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]); tempos.push({ t: tick / div, v: Math.round(b2 * 100) / 100 }); if (tick === 0 || tempos.length === 1) bpm = b2; }
        else if (type === 0x58) { const n = bytes[p] || 4, d = 2 ** (bytes[p + 1] ?? 2); if (!meters.length && tick === 0) sig = n * 4 / d; meters.push({ t: tick / div, n, d }); }
        else if (type === 0x03) name = new TextDecoder().decode(bytes.subarray(p, p + len)).trim();
        p += len; continue;
      }
      if (st === 0xf0 || st === 0xf7) { p += vlq(); continue; }
      run = st;
      const type = st & 0xf0, ch = st & 15;
      const a = bytes[p++], b = type === 0xc0 || type === 0xd0 ? 0 : bytes[p++];
      const notes = byCh.get(ch) || { notes: [], program: 0 };
      byCh.set(ch, notes);
      if (type === 0xc0) notes.program = a;
      else if (type === 0xb0 || type === 0xe0 || type === 0xd0) {        // controllers, bend, pressure: the clip's lanes
        const key = type === 0xe0 ? 'pb' : type === 0xd0 ? 'cp' : `cc:${a}`, v = type === 0xe0 ? ((b << 7) | a) - 8192 : type === 0xd0 ? a : b;
        ((notes.ctl ||= {})[key] ||= []).push({ t: tick / div, v });
      }
      else if (type === 0x90 && b > 0) open.set(ch * 128 + a, { t: tick / div, n: a, v: b });
      else if (type === 0x80 || type === 0x90) {
        const s = open.get(ch * 128 + a);
        if (s) { open.delete(ch * 128 + a); notes.notes.push({ ...s, d: Math.max(1 / 64, tick / div - s.t) }); }
      }
    }
    for (const [ch, x] of byCh) if (x.notes.length) out.push({ name: name || `TRACK ${k + 1}`, ch, program: x.program, notes: x.notes, ...(x.ctl ? { ctl: x.ctl } : {}) });
    o = end;
  }
  tempos.sort((a, b) => a.t - b.t);
  return { bpm: Math.round(bpm * 100) / 100, sig, meters, tracks: out, tempo: tempos.length > 1 ? tempos : [] };
}
