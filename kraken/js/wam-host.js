// SPDX-License-Identifier: GPL-3.0-only
// The plugin host of the page: Web Audio Modules 2.0 loaded from their address, their instances, and their routing
// in and out of the Kraken worklet (wam.js), live and in an offline render (export, freeze). A plugin that cannot
// load leaves its track as it was (an effect passes the sound, an instrument is silent) and says why.
import { initializeWamHost } from './vendor/wam-env.js';
import { wamPlan, renderLatency, unpackState, cleanState, nameFromUrl } from './wam.js';

const RATE = 44100;
// the WAM host environment of an audio context (its group in the audio thread): once per context
const hosts = new WeakMap();
export function wamGroup(ctx) {
  let h = hosts.get(ctx);
  if (!h) {
    const key = globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2) + String(Date.now());
    h = initializeWamHost(ctx, `kraken-${key.slice(0, 8)}`, key);
    hosts.set(ctx, h);
    h.catch(() => hosts.delete(ctx));
  }
  return h;
}
const within = (pr, ms, what) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error(what)), ms))]);
// a plugin's class, from its ES module (the browser keeps the module: one download per address)
// (bust: an address tried again after a failure, which the browser would otherwise remember as failed)
// the sites whose plugins may run here: Kraken's own, and those you allowed (choosing a plugin allows its site; a
// plugin that came in a project, a preset or from someone you play with waits for your yes)
const TRUST = 'kraken.trustedPlugins';
export const pluginOrigin = (url) => { try { return new URL(url, globalThis.location?.href).origin; } catch { return ''; } };
export function trusted(url) {
  const o = pluginOrigin(url);
  if (!o) return false;
  if (o === globalThis.location?.origin) return true;
  try { return JSON.parse(globalThis.localStorage?.getItem(TRUST) || '[]').includes(o); } catch { return false; }
}
export function trust(url) {
  const o = pluginOrigin(url);
  if (!o) return;
  try { const l = JSON.parse(localStorage.getItem(TRUST) || '[]'); if (!l.includes(o)) { l.push(o); localStorage.setItem(TRUST, JSON.stringify(l)); } } catch { /* storage blocked */ }
}
export async function loadWamClass(url, bust = 0) {
  if (!trusted(url)) { const e = new Error(`not allowed yet: it runs code from ${pluginOrigin(url) || 'an unknown site'}`); e.untrusted = true; throw e; }
  const u = new URL(url, globalThis.location?.href);
  if (bust) u.searchParams.set('kraken-retry', String(bust));
  const abs = u.href;
  let mod;
  try { mod = await within(import(abs), 30000, 'its address did not answer'); } catch (e) { throw new Error(/import|fetch|module/i.test(e.message) ? 'it could not be downloaded (address, network or the site refuses)' : e.message); }
  const W = [mod.default, ...Object.values(mod)].find((x) => typeof x?.createInstance === 'function');
  if (!W) throw new Error('that file is not a Web Audio Module (no createInstance)');
  return W;
}
// an instance in an audio context, with its saved settings (state: as saved, see wam.js packState)
export async function createWam(ctx, url, state = null, bust = 0) {
  const [group] = await within(wamGroup(ctx), 15000, 'the plugin host did not start');
  const W = await loadWamClass(url, bust);
  const st = state == null ? undefined : unpackState(state);
  const wam = await within(W.createInstance(group, ctx, st), 30000, 'the plugin did not start');
  if (!wam?.audioNode) throw new Error('the plugin gave no audio node');
  if (st !== undefined) await within(Promise.resolve(wam.audioNode.setState?.(st)), 10000, 'the plugin did not take its settings').catch(() => {});
  return wam;
}
const instanceId = (wam) => wam.audioNode?.instanceId ?? wam.instanceId;
export function dropWam(wam) {
  try { wam.audioNode.disconnect(); } catch { /* */ }
  try { wam.audioNode.destroy?.(); } catch { /* */ }
}

// the plugins a project uses: { key, url, name, state, fx } (key 'i:<track>' or 'f:<device>', as wamPlan)
export function wamsOf(p, all = true) {
  const out = [];
  for (const t of p.tracks || []) {
    if (t.kind === 'wam' && t.wam?.url && (all || !t.frozen)) out.push({ key: `i:${t.id}`, url: t.wam.url, name: t.wam.name, state: t.wam.state, track: t.id });
    for (const d of t.fx || []) if (d.type === 'wam' && d.url && (all || d.on !== false)) out.push({ key: `f:${d.id}`, url: d.url, name: d.name, state: d.state, track: t.id, fx: d.id });
  }
  return out;
}

// the instances of each chain of a plan: { key: [instance ids] } (how the engine finds their processors)
export function planIds(plan, inst) {
  const ids = {};
  for (const x of Object.values(plan.tracks)) {
    if (x.inst) ids[x.inst.key] = [instanceId(inst(x.inst.key))];
    for (const r of x.runs) ids[r.key] = r.ids.map((id) => instanceId(inst(`f:${id}`)));
  }
  return ids;
}
// the graph of a plan, between the engine's node and the plugins: a run of effects from its slot's output through each
// plugin and back into its slot's input past a delay (Web Audio lets a loop through only with one, of at least a render
// quantum: the round trip); an instrument straight into its slot. Every return is made stereo (a mono plugin: both
// sides). -> undo()
export function wireWams(ctx, node, plan, inst) {
  const links = [];
  const link = (a, b, o = 0, i = 0) => { a.connect(b, o, i); links.push(() => { try { a.disconnect(b, o, i); } catch { /* */ } }); };
  const stereo = (n) => Object.assign(n, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  for (const x of Object.values(plan.tracks)) {
    if (x.inst) {
      const w = inst(x.inst.key), g = stereo(new GainNode(ctx));
      link(w.audioNode, g); link(g, node, 0, 1 + x.inst.slot);
    }
    for (const r of x.runs) {
      const ws = r.ids.map((id) => inst(`f:${id}`)), back = stereo(new DelayNode(ctx, { delayTime: 0, maxDelayTime: 1 }));
      link(node, ws[0].audioNode, 1 + r.slot, 0);
      for (let k = 1; k < ws.length; k++) link(ws[k - 1].audioNode, ws[k].audioNode);
      link(ws[ws.length - 1].audioNode, back); link(back, node, 0, 1 + r.slot);
    }
  }
  return () => { for (const u of links) u(); };
}

// the plugins of a project in an offline context (an export, a freeze), with their saved settings: only those heard
// (a stem: its track, its groups, a group's tracks). -> { plan, slots, group, key, ids, latency (frames), failed: [names], connect(node) }
export async function offlineWams(ctx, p, { freezeTrack = null, soloTrack = null } = {}) {
  const heard = freezeTrack ? new Set([freezeTrack]) : soloTrack ? related(p, soloTrack) : null;
  const want = wamsOf(p, false).filter((w) => !heard || heard.has(w.track));
  if (heard) p = { ...p, tracks: p.tracks.map((t) => (heard.has(t.id) ? t : { ...t, fx: t.fx.filter((d) => d.type !== 'wam'), wam: null })) };
  const [group, key] = await wamGroup(ctx);
  const inst = new Map(), failed = [];
  await Promise.all(want.map(async (w) => {
    // (once more on a failure, fetched anew: the page remembers an address that failed once)
    try { inst.set(w.key, await createWam(ctx, w.url, w.state).catch(() => createWam(ctx, w.url, w.state, Date.now()))); } catch (e) { failed.push(`${w.name || nameFromUrl(w.url)} (${e.message})`); }
  }));
  const plan = wamPlan(p, { ok: (k) => inst.has(k) });
  for (const k of plan.dropped) failed.push(`${want.find((w) => w.key === k)?.name || k} (more than 8 plugin chains at once)`);
  const slots = Math.max(0, ...Object.values(plan.slots).map((s) => s + 1)), get = (k) => inst.get(k);
  return { plan, slots, group, key, failed, ids: planIds(plan, get), latency: renderLatency(p, plan, { freezeTrack }), connect: (node) => wireWams(ctx, node, plan, get) };
}

// a track, the groups it plays through, and (a group) the tracks that play through it
function related(p, id) {
  const by = new Map(p.tracks.map((t) => [t.id, t])), out = new Set([id]);
  for (let x = by.get(by.get(id)?.out), k = 0; x && k < 8; x = by.get(x.out), k++) out.add(x.id);
  let grew = true;
  while (grew) { grew = false; for (const t of p.tracks) if (!out.has(t.id) && out.has(t.out) && by.get(t.out)?.kind === 'group' && isBelow(by, t, id)) { out.add(t.id); grew = true; } }
  return out;
}
const isBelow = (by, t, id) => { for (let x = by.get(t.out), k = 0; x && k < 8; x = by.get(x.out), k++) if (x.id === id) return true; return false; };

// ------------------------------------------------------------------- live ---
// the plugins of the open project in the live context: created and dropped as the project changes, their settings
// kept in the project (each change in a plugin's own panel: an undo step), routed into the engine's node
export class WamLive {
  constructor(app) {
    this.app = app;
    this.inst = new Map();       // key -> { url, wam, status: 'loading' | 'ok' | 'failed', error, json, ref, gui }
    this.retried = new Map();    // url -> when it was tried again
    this.prev = new Map();       // key -> slot: a playing chain keeps its slot
    this.wired = null; this.node = null; this.sig = '';
    this.latency = 0;            // seconds the master comes out later (plugin delay compensation)
  }
  get ctx() { return this.app.audio?.ctx; }
  entry(key) { return this.inst.get(key); }
  // the project changed: plugins created, updated (an undo), dropped; then the routing
  sync(p) {
    if (!this.ctx) return;
    const want = wamsOf(p), keep = new Set();
    for (const w of want) {
      keep.add(w.key);
      let e = this.inst.get(w.key);
      if (e && e.url !== w.url) { this.drop(w.key); e = null; }
      if (!e) { this.create(w, JSON.stringify(w.state ?? null)); this.inst.get(w.key).ref = w.state; continue; }
      e.name = w.name;
      if (e.ref === w.state) continue;                           // (the same settings object: nothing new)
      e.ref = w.state;
      const js = JSON.stringify(w.state ?? null);
      if (e.status === 'ok' && js !== e.json) {               // its settings changed in the project (undo, a preset): to the plugin
        e.json = js;
        Promise.resolve(e.wam.audioNode.setState?.(unpackState(w.state))).catch(() => {});
      }
    }
    for (const k of [...this.inst.keys()]) if (!keep.has(k)) this.drop(k);
    this.route();
  }
  create(w, js) {
    const e = { url: w.url, name: w.name, status: 'loading', error: '', json: js, wam: null, gui: null };
    this.inst.set(w.key, e);
    createWam(this.ctx, w.url, w.state, this.retried.get(w.url) || 0).then(async (wam) => {
      if (this.inst.get(w.key) !== e) { dropWam(wam); return; }  // (gone while it loaded)
      e.wam = wam; e.status = 'ok';
      // its own name, when the project only had one made from its address
      const own = String(wam.name || wam.descriptor?.name || '').trim().toUpperCase().slice(0, 40);
      if (own && w.name === nameFromUrl(w.url).toUpperCase().slice(0, 40) && own !== w.name) this.rename(w.key, own);
      if (w.state == null) await this.capture(w.key, false);   // its first settings, kept with the project (no undo step)
      this.route();
      this.app.wamChanged?.(w.key);
    }, (err) => {
      if (this.inst.get(w.key) !== e) return;
      e.status = 'failed'; e.error = err.message || String(err);
      this.app.toast?.(`Plugin ${w.name || nameFromUrl(w.url)} did not load: ${e.error}. Its track plays without it.`);
      this.app.wamChanged?.(w.key);
    });
  }
  // a plugin that failed, loaded again
  retry(key) {
    const e = this.inst.get(key);
    if (!e) return;
    this.retried.set(e.url, Date.now());
    this.drop(key);
    this.sync(this.app.store.p);
  }
  drop(key) {
    const e = this.inst.get(key);
    if (!e) return;
    this.inst.delete(key);
    if (e.wam) { try { if (e.gui) e.wam.destroyGui?.(e.gui); } catch { /* */ } e.gui?.remove?.(); dropWam(e.wam); }
  }
  // the routing of the project's plugins that are ready, sent to the engine; rebuilt when it changes
  route(force = false) {
    const app = this.app, node = app.audio?.node, p = app.store?.p;
    if (!node || !p) return;
    const ready = (k) => this.inst.get(k)?.status === 'ok';
    const plan = wamPlan(p, { ok: ready, prev: this.prev }), get = (k) => this.inst.get(k).wam;
    const ids = planIds(plan, get);
    this.latency = renderLatency(p, plan) / RATE;
    app.audio.pdc = this.latency;
    const sig = JSON.stringify([plan.tracks, ids]);
    if (!force && node === this.node && sig === this.sig) return;
    this.wired?.();
    this.wired = null;
    this.node = node; this.sig = sig;
    this.prev = new Map(Object.entries(plan.slots));
    const outs = node.numberOfOutputs - 1;
    if (Object.values(plan.slots).some((s) => s >= outs)) { app.toast?.('This audio engine has no room for plugins: restart it (PROJECT > Check this device).'); return; }
    wamGroup(this.ctx).then(([group, key]) => {
      if (this.node !== node || this.sig !== sig) return;    // (changed meanwhile)
      app.audio.send({ t: 'wam', plan: Object.keys(plan.tracks).length ? plan : null, group, key, ids });
      this.wired = wireWams(this.ctx, node, plan, get);
    });
    if (plan.dropped.length && !this.toldDropped) { this.toldDropped = true; app.toast?.('Kraken plays up to 8 plugin chains at once: the others are bypassed.'); }
  }
  // a plugin's own panel (made once, kept while the plugin lives)
  async gui(key) {
    const e = this.inst.get(key);
    if (!e?.wam) return null;
    if (!e.gui) e.gui = await e.wam.createGui?.() || null;
    return e.gui;
  }
  rename(key, name) {
    const [kind, id] = [key[0], key.slice(2)];
    this.inst.get(key).name = name;
    this.app.store.amend((p) => { for (const t of p.tracks) { if (kind === 'i' && t.id === id && t.wam) t.wam.name = name; if (kind === 'f') for (const d of t.fx) if (d.id === id) d.name = name; } });
  }
  // its settings now, into the project (undoable: a change made in its panel)
  async capture(key, undoable = true) {
    const e = this.inst.get(key);
    if (!e?.wam) return;
    let s;
    try { s = cleanState(await within(Promise.resolve(e.wam.audioNode.getState?.()), 5000, 'state')); } catch { return; }
    const js = JSON.stringify(s ?? null);
    if (js === e.json || this.inst.get(key) !== e) return;
    e.json = js; e.ref = s;
    const set = (p) => {
      const [kind, id] = [key[0], key.slice(2)];
      for (const t of p.tracks) {
        if (kind === 'i' && t.id === id && t.wam) t.wam.state = s;
        if (kind === 'f') for (const d of t.fx) if (d.id === id) d.state = s;
      }
    };
    if (undoable) this.app.store.change(set, `wamstate${key}`); else this.app.store.amend(set);
  }
  // every plugin's settings into the project (before an export, a save)
  async captureAll() { await Promise.all([...this.inst.keys()].map((k) => this.capture(k, false))); }
  // its parameters: [{ id, label, min, max, value, type, choices }]
  async params(key) {
    const n = this.inst.get(key)?.wam?.audioNode;
    if (!n?.getParameterInfo) return [];
    const info = await within(Promise.resolve(n.getParameterInfo()), 5000, 'params'), vals = await within(Promise.resolve(n.getParameterValues?.(false) || {}), 5000, 'values');
    return Object.values(info || {}).map((x) => ({ id: x.id, label: x.label || x.id, min: x.minValue ?? 0, max: x.maxValue ?? 1, step: x.discreteStep || 0,
      type: x.type, choices: x.choices || [], value: vals?.[x.id]?.value ?? x.defaultValue ?? 0, units: x.units || '' }));
  }
  async setParam(key, id, value) {
    const n = this.inst.get(key)?.wam?.audioNode;
    if (!n?.setParameterValues) return;
    await n.setParameterValues({ [id]: { id, value, normalized: false } });
    clearTimeout(this.pt); this.pt = setTimeout(() => this.capture(key), 250);
  }
  // after the engine restarted (a new node): the same plugins, wired to it
  restart() { this.sig = ''; this.route(true); }
}
