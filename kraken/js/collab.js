// SPDX-License-Identifier: GPL-3.0-only
// Playing together, live, browser to browser (WebRTC), with no server of ours: the one who invites gives a code, the
// guest answers with a code, and the two are linked. Then every change travels as small operations (patch.js); the
// host relays between guests; audio files travel on demand; each one sees where the others are.
// Undo stays yours: what the others change is written into your history too, so Ctrl+Z only takes back your steps.
// One order for everyone: the host numbers every change and sends it to all, its author included; a change of yours
// not yet back from the host wins over another's to the same thing (the host heard yours later).
import { diff, patch, safeOps, overlaps, structural } from './patch.js';
import { validate, uid } from './project.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];     // (a public address finder; the audio and the project go browser to browser)
const PREFIX = 'KRK1-';
const CHUNK = 16384;                                         // frames of audio a message

// ------------------------------------------------------------------ codes ---
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
export async function encodeCode(obj) { return PREFIX + b64(await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('deflate-raw'))); }
export async function decodeCode(code) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  if (!s.startsWith(PREFIX)) throw new Error('This is not a Kraken code.');
  try { return JSON.parse(new TextDecoder().decode(await pipe(unb64(s.slice(PREFIX.length)), new DecompressionStream('deflate-raw')))); } catch { throw new Error('This code is incomplete or damaged: copy all of it.'); }
}
// the offer or answer once its addresses are found (or after a few seconds: those found so far)
function gathered(pc, ms = 3000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
  });
}
const MAX_FRAMES = 44100 * 60 * 30;                          // (an audio file over 30 minutes is not taken)

export class Collab {
  constructor(app) {
    this.app = app;
    this.peers = new Map();        // id -> { id, pc, dc, name, color, sel, pos, host }
    this.host = false;
    this.base = null;              // the project as the others last heard it
    this.applying = false;
    this.flushT = 0;
    this.incoming = new Map();     // asset transfers: seq -> { id, name, frames, L, R, got }
    this.outQ = Promise.resolve();
    this.asked = new Map();        // asset id -> when it was asked for
    this.pending = [];             // my changes not yet back from the host: { seq, paths }
    this.seq = 0;
    this.wantedBy = new Map();     // (host) asset id -> peers waiting for it
    let name = 'ME'; try { name = localStorage.getItem('kraken.name') || 'ME'; } catch { /* */ }
    this.me = { id: uid('u'), name, color: ['#ff5b14', '#2fa8ff', '#27c46b', '#c45bff', '#ffc21a', '#ff4fa3'][Math.floor(Math.random() * 6)] };
    app.store.on((_p, why) => this.local(why));
    this.helloT = setInterval(() => this.hello(), 1000);
    this.onChange = () => {};     // the UI's: someone came, left, moved
  }
  get open() { return [...this.peers.values()].filter((x) => x.dc?.readyState === 'open'); }
  get live() { return this.open.length > 0; }
  setName(n) { this.me.name = String(n || 'ME').slice(0, 16).toUpperCase(); try { localStorage.setItem('kraken.name', this.me.name); } catch { /* */ } this.hello(true); }

  // ------------------------------------------------------------ linking ---
  // invite: -> { code, accept(answer) }
  async invite() {
    const pc = new RTCPeerConnection({ iceServers: ICE }), peer = { id: uid('p'), pc, name: '…', color: '#8a9097' };
    const dc = pc.createDataChannel('kraken', { ordered: true });
    this.host = true;
    this.wire(peer, dc);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const code = await encodeCode({ k: 'offer', sdp: pc.localDescription.sdp, from: this.me.name });
    return { code, accept: async (answer) => { const a = await decodeCode(answer); if (a.k !== 'answer') throw new Error('That is an invitation code: paste the code your guest sent back.'); await pc.setRemoteDescription({ type: 'answer', sdp: a.sdp }); }, cancel: () => { pc.close(); this.peers.delete(peer.id); } };
  }
  // join with an invitation: -> the answer code to send back
  async join(code) {
    const o = await decodeCode(code);
    if (o.k !== 'offer') throw new Error('That is an answer code: paste the invitation you received.');
    const pc = new RTCPeerConnection({ iceServers: ICE }), peer = { id: uid('p'), pc, name: o.from || 'HOST', color: '#8a9097', host: true };
    this.host = false;
    pc.ondatachannel = (e) => this.wire(peer, e.channel);
    this.peers.set(peer.id, peer);
    await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return encodeCode({ k: 'answer', sdp: pc.localDescription.sdp, from: this.me.name });
  }
  leave() {
    for (const x of this.peers.values()) { try { x.pc.close(); } catch { /* */ } }
    this.peers.clear(); this.host = false; this.base = null;
    this.onChange();
  }
  wire(peer, dc) {
    peer.dc = dc;
    dc.binaryType = 'arraybuffer';
    this.peers.set(peer.id, peer);
    dc.onopen = () => {
      this.base = structuredClone(this.app.store.p);
      this.hello(true);
      if (this.host) this.send(peer, { t: 'state', p: JSON.stringify(this.app.store.p) });   // the song, to the newcomer
      this.app.toast(this.host ? 'Someone joined: you now play together.' : 'Linked: you play together.');
      this.onChange();
    };
    dc.onclose = () => {
      this.peers.delete(peer.id);
      for (const [k, r] of this.incoming) if (r.peer === peer.id) { this.incoming.delete(k); this.asked.delete(r.id); }   // (a file half sent: asked again of the others)
      if (this.host === false) this.pending = [];
      this.app.toast(`${peer.name} left.`); this.onChange(); this.fetchMissing();
    };
    dc.onmessage = (e) => { try { this.receive(peer, e.data); } catch (err) { console.warn('collab', err); } };
  }
  send(peer, msg) { if (peer.dc?.readyState === 'open') peer.dc.send(typeof msg === 'string' || msg instanceof ArrayBuffer ? msg : JSON.stringify(msg)); }
  broadcast(msg, except = null) { const s = JSON.stringify(msg); for (const x of this.open) if (x !== except) x.dc.send(s); }

  // ------------------------------------------------------------ changes ---
  local(why) {
    if (!this.live || this.applying) return;
    if (why === 'select') return;
    if (why === 'load') { this.base = structuredClone(this.app.store.p); this.broadcast({ t: 'state', p: JSON.stringify(this.app.store.p) }); return; }
    clearTimeout(this.flushT);
    this.flushT = setTimeout(() => this.flush(), 40);              // (a drag: its moves gathered)
  }
  flush() {
    if (!this.live || !this.base) return;
    const cur = this.app.store.p, ops = diff(this.base, cur);
    if (!ops.length) return;
    this.base = structuredClone(cur);
    const msg = { t: 'ops', ops, from: this.me.id, seq: ++this.seq };
    if (this.host) this.broadcast(msg);                                   // (the host's order is the order)
    else { this.pending.push({ seq: msg.seq, paths: ops.filter((o) => !structural(o)).map((o) => o.p) }); this.broadcast(msg); }
  }
  // operations from someone: into the song, into your history (so undo only takes back yours), and on to the others
  applyOps(ops) {
    const store = this.app.store;
    // (a change of mine still on its way to the host is newer: the same thing changed by another is left as mine)
    const mine = this.pending.flatMap((x) => x.paths);
    ops = ops.filter((o) => structural(o) || !mine.some((q) => overlaps(q, o.p)));
    if (!ops.length) return;
    this.applying = true;
    try {
      // into a copy first: what it gives must be a sound project (else it is not taken)
      const next = structuredClone(store.p);
      patch(next, ops);
      validate(next);
      patch(store.p, ops);
      validate(store.p);
      for (const s of store.past) patch(s, ops);
      for (const s of store.future) patch(s, ops);
      if (this.base) patch(this.base, ops);
      store.emit('change');
    } catch (err) { console.warn('collab: a change was refused', err); }
    finally { this.applying = false; }
    this.fetchMissing();
  }
  receive(peer, data) {
    if (data instanceof ArrayBuffer) return this.chunk(data);
    const m = JSON.parse(data);
    if (m.t === 'ops' && safeOps(m.ops)) {
      this.flush();                                              // (yours first)
      if (!this.host && m.from === this.me.id) { this.pending = this.pending.filter((x) => x.seq !== m.seq); return; }   // mine, back: now in order
      this.applyOps(m.ops);
      if (this.host) this.broadcast(m);                          // to everyone, its author too (that is its place in the order)
    } else if (m.t === 'state') {
      const p = validate(JSON.parse(m.p));
      this.applying = true;
      try { this.app.store.replace(p, true); } finally { this.applying = false; }
      this.base = structuredClone(this.app.store.p);
      this.app.restoreAssets?.(p);
      this.fetchMissing();
      if (this.host) this.broadcast({ t: 'state', p: m.p }, peer);
      this.app.toast(`${peer.name}'s song is open: what you had is one Ctrl+Z away.`);
    } else if (m.t === 'hello') {
      Object.assign(peer, { name: String(m.name || 'GUEST').slice(0, 16), color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#8a9097', sel: m.sel, pos: m.pos, uid: m.id });
      if (this.host) this.broadcast({ ...m }, peer);
      this.onChange();
    } else if (m.t === 'need') this.sendAsset(peer, m.id);
    else if (m.t === 'asset' && Number.isInteger(m.frames) && m.frames > 0 && m.frames <= MAX_FRAMES && typeof m.id === 'string') this.incoming.set(m.seq, { id: m.id, name: String(m.name || '').slice(0, 80), frames: m.frames, L: new Float32Array(m.frames), R: new Float32Array(m.frames), got: 0, peer: peer.id });
  }
  hello(force = false) {
    if (!this.live) return;
    const v = this.app.view, sel = v.selTrack || null, pos = Math.round((this.app.pos || 0) * 4) / 4;
    if (!force && this.lastHello && this.lastHello.sel === sel && this.lastHello.pos === pos) return;
    this.lastHello = { sel, pos };
    this.broadcast({ t: 'hello', id: this.me.id, name: this.me.name, color: this.me.color, sel, pos });
  }
  // who has which track selected (the others): trackId -> [peer…]
  where() {
    const out = new Map();
    for (const x of this.peers.values()) if (x.sel) { if (!out.has(x.sel)) out.set(x.sel, []); out.get(x.sel).push(x); }
    return out;
  }

  // ------------------------------------------------------------ audio files ---
  // the audio files the song plays that this browser has not got: asked for (again after 20 s if they did not come)
  fetchMissing() {
    const app = this.app, now = Date.now();
    for (const id of Object.keys(app.store.p.assets || {})) if (!app.assets.has(id) && !(now - (this.asked.get(id) || 0) < 20000)) {
      this.asked.set(id, now);
      app.ensureAssets?.([id], true).then((miss) => { if (miss) for (const x of this.open) this.send(x, { t: 'need', id }); }).catch(() => {});
    }
    clearTimeout(this.retryT);
    if (Object.keys(app.store.p.assets || {}).some((id) => !app.assets.has(id))) this.retryT = setTimeout(() => this.fetchMissing(), 21000);
  }
  sendAsset(peer, id) {
    const a = this.app.assets.get(id);
    if (!a) {                                                    // (the host has not got it yet: asked of the others, sent on when it comes)
      if (!this.host) return;
      if (!this.wantedBy.has(id)) this.wantedBy.set(id, new Set());
      this.wantedBy.get(id).add(peer.id);
      for (const x of this.open) if (x !== peer) this.send(x, { t: 'need', id });
      return;
    }
    this.outQ = this.outQ.then(async () => {
      const seq = Math.floor(Math.random() * 2 ** 31);
      this.send(peer, { t: 'asset', seq, id, name: a.name, frames: a.L.length });
      for (let off = 0; off < a.L.length; off += CHUNK) {
        for (const [ch, X] of [[0, a.L], [1, a.R || a.L]]) {
          const part = X.subarray(off, off + CHUNK), buf = new ArrayBuffer(12 + part.length * 4), h = new Uint32Array(buf, 0, 3);
          h[0] = seq; h[1] = ch; h[2] = off; new Float32Array(buf, 12).set(part);
          while (peer.dc?.readyState === 'open' && peer.dc.bufferedAmount > 4e6) await new Promise((r) => setTimeout(r, 20));
          if (peer.dc?.readyState !== 'open') return;
          peer.dc.send(buf);
        }
      }
    });
  }
  chunk(buf) {
    const h = new Uint32Array(buf, 0, 3), r = this.incoming.get(h[0]);
    if (!r) return;
    const data = new Float32Array(buf, 12);
    (h[1] ? r.R : r.L).set(data.subarray(0, Math.max(0, Math.min(data.length, r.frames - h[2]))), h[2]);
    r.got += data.length;
    if (r.got >= r.frames * 2) {
      this.incoming.delete(h[0]);
      if (this.app.assets.has(r.id)) return;
      this.app.addAudio?.(r.id, { L: r.L, R: r.R, name: r.name });
      for (const pid of this.wantedBy.get(r.id) || []) { const x = this.peers.get(pid); if (x) this.sendAsset(x, r.id); }
      this.wantedBy.delete(r.id);
      this.app.store.emit('select');                                // (drawn again, with its waveform)
    }
  }
}
