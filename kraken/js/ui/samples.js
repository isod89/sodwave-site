// SPDX-License-Identifier: GPL-3.0-only
// Your own samples: the SAMPLES tab of the library. Add folders of your computer (they come back next time where the
// browser can keep a folder: Chrome, Edge), search them, hear a file with a click (arrow keys walk the list, each one
// heard), star favourites, and drag a file onto the arrangement, a drum pad or the sampler; USE puts it on the
// selected track (the sampler's sample, the drum track's selected pad, an audio clip at the playhead).
import { h } from './kit.js';
import { tx } from '../vault.js';

const AUDIO = /\.(wav|wave|aif|aiff|mp3|ogg|oga|flac|m4a|aac|opus|webm)$/i;
const MAX_FILES = 20000;
const FAVS = 'kraken.sampleFavs';
export const DRAG_TYPE = 'application/x-kraken-sample';
const DIRS_KEY = 'cfg:sampleDirs';

const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

// every audio file under a directory handle: [{ path, get: () => File }]
async function walk(dir, base, out) {
  for await (const [name, hd] of dir.entries()) {
    if (out.length >= MAX_FILES || name.startsWith('.')) continue;
    if (hd.kind === 'directory') await walk(hd, `${base}${name}/`, out);
    else if (AUDIO.test(name)) out.push({ path: base + name, name, get: () => hd.getFile() });
  }
  return out;
}

export class Samples {
  constructor(app) {
    this.app = app;
    this.roots = [];            // [{ id, name, handle?, files: [{ path, name, get }], need?: true (permission to ask) }]
    this.favs = new Set(lsGet(FAVS, []));
    this.onlyFavs = false;
    this.cur = null;            // the key of the file last heard
    this.preview = null;
    this.cache = new Map();     // key -> AudioBuffer (the last few heard)
    this.ready = this.restore();
  }
  key(root, f) { return `${root.id}/${f.path}`; }
  // a folder's id: its name, and a number when another folder has that name (favourites stay after a reload)
  rootId(name) { let id = name, k = 2; while (this.roots.some((r) => r.id === id)) id = `${name} (${k++})`; return id; }
  // the folders kept from last time (their permission is asked again on the first click)
  async restore() {
    const hs = (await tx('readonly', (s) => s.get(DIRS_KEY), 'projects')) || [];
    for (const handle of Array.isArray(hs) ? hs : []) {
      if (!handle?.name) continue;
      const root = { id: this.rootId(handle.name), name: handle.name, handle, files: [] };
      try { if ((await handle.queryPermission?.({ mode: 'read' })) === 'granted') root.files = await walk(handle, '', []); else root.need = true; } catch { root.need = true; }
      this.roots.push(root);
    }
  }
  async keep() { await tx('readwrite', (s) => s.put(this.roots.filter((r) => r.handle).map((r) => r.handle), DIRS_KEY), 'projects'); }
  async addFolder() {
    if (window.showDirectoryPicker) {
      let handle;
      try { handle = await window.showDirectoryPicker({ id: 'kraken-samples', mode: 'read' }); } catch { return; }
      if (this.roots.some((r) => r.name === handle.name && r.handle)) { const same = await Promise.all(this.roots.filter((r) => r.handle).map((r) => r.handle.isSameEntry?.(handle))); if (same.some(Boolean)) { this.app.toast(`${handle.name} is already in the list.`); return; } }
      const root = { id: this.rootId(handle.name), name: handle.name, handle, files: [] };
      this.app.toast(`Reading ${handle.name}…`);
      root.files = await walk(handle, '', []);
      this.roots.push(root);
      await this.keep();
      this.app.toast(`${handle.name}: ${root.files.length} audio file${root.files.length === 1 ? '' : 's'}${root.files.length >= MAX_FILES ? ' (the first ' + MAX_FILES + ')' : ''}.`);
      this.render();
      return;
    }
    // (Firefox, Safari: a folder input; the folder is not kept after a reload)
    const inp = h('input', { type: 'file', webkitdirectory: '', multiple: true, hidden: true });
    inp.onchange = () => {
      const all = [...inp.files].filter((f) => AUDIO.test(f.name)).slice(0, MAX_FILES);
      inp.remove();
      if (!all.length) { this.app.toast('No audio file in that folder.'); return; }
      const name = (all[0].webkitRelativePath || all[0].name).split('/')[0];
      this.roots.push({ id: this.rootId(name), name, files: all.map((f) => ({ path: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name, name: f.name, get: async () => f })) });
      this.app.toast(`${name}: ${all.length} audio files (add it again after a reload: this browser cannot keep a folder).`);
      this.render();
    };
    document.body.append(inp); inp.click();
  }
  async grant(root) {
    try {
      if ((await root.handle.requestPermission({ mode: 'read' })) !== 'granted') return;
      root.files = await walk(root.handle, '', []); root.need = false; this.render();
    } catch { this.app.toast(`${root.name} cannot be read any more: remove it and add it again.`); }
  }
  async remove(root) { this.roots = this.roots.filter((r) => r !== root); await this.keep(); this.render(); }
  // a file by its key (for a drag)
  async file(key) {
    for (const r of this.roots) for (const f of r.files) if (this.key(r, f) === key) return f.get();
    return null;
  }
  // hear a file (another click on it: stop)
  async hear(key) {
    const app = this.app, ctx = app.audio?.ctx;
    this.stop();
    if (this.cur === key && this.playing) { this.playing = false; return; }
    this.cur = key; this.mark();
    if (!ctx) return;
    try {
      let buf = this.cache.get(key);
      if (!buf) {
        const f = await this.file(key);
        if (!f || this.cur !== key) return;
        buf = await ctx.decodeAudioData(await f.arrayBuffer());
        this.cache.set(key, buf);
        if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
      }
      if (this.cur !== key) return;
      if (ctx.state !== 'running') await ctx.resume();
      const src = ctx.createBufferSource(), g = ctx.createGain();
      g.gain.value = 0.8; src.buffer = buf; src.connect(g).connect(ctx.destination); src.start();
      src.onended = () => { if (this.preview === src) { this.playing = false; this.mark(); } };
      this.preview = src; this.playing = true; this.mark();
    } catch { app.toast('This file could not be played.'); }
  }
  stop() { try { this.preview?.stop(); } catch { /* */ } this.preview = null; }
  fav(key) { this.favs.has(key) ? this.favs.delete(key) : this.favs.add(key); lsSet(FAVS, [...this.favs]); this.render(); }
  async use(key) { const f = await this.file(key); if (f) this.app.useSample([f]); }

  // the list (in the library's list element)
  render() {
    const lib = this.app.library;
    if (!lib || lib.mode !== 'samples') return;
    const q = lib.search.value.trim().toLowerCase();
    const kids = [h('div', { class: 'smp-bar' },
      h('button', { class: 'add', onclick: () => this.addFolder(), title: 'A folder of samples on this computer' }, '+ FOLDER'),
      h('button', { class: 'add' + (this.onlyFavs ? ' go' : ''), 'aria-pressed': String(this.onlyFavs), onclick: () => { this.onlyFavs = !this.onlyFavs; this.render(); } }, '★ FAVOURITES'))];
    const item = (root, f) => {
      const key = this.key(root, f), dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const el = h('div', { class: 'item smp-item', role: 'button', tabindex: 0, draggable: 'true', 'data-key': key, title: `${f.path}\nClick: hear it · drag it onto a track, a pad or the sampler` },
        h('span', { class: 'smp-play', text: '▶' }), h('span', { class: 'smp-name', text: f.name.replace(/\.[^.]+$/, '') }), dir ? h('span', { class: 'tag', text: dir.split('/').at(-1) }) : null,
        h('span', { class: 'tag star' + (this.favs.has(key) ? ' on' : ''), role: 'button', title: 'Favourite', text: '★', onclick: (e) => { e.stopPropagation(); this.fav(key); } }),
        h('span', { class: 'tag plus', role: 'button', title: 'Put it on the selected track', text: 'USE', onclick: (e) => { e.stopPropagation(); this.use(key); } }));
      el.addEventListener('click', () => this.hear(key));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); const n = e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling; if (n?.dataset.key) { n.focus(); this.hear(n.dataset.key); } }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.use(key); }
        else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.hear(key); }
      });
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData(DRAG_TYPE, key); e.dataTransfer.setData('text/plain', f.name); e.dataTransfer.effectAllowed = 'copy'; });
      return el;
    };
    // the project's own audio first (drag it to a pad or the sampler too)
    let shown = 0;
    for (const root of this.roots) {
      if (root.need) {
        kids.push(h('div', { class: 'eng-h open' }, h('span', { text: `▸ ${root.name}` }), h('span', { class: 'tag plus', role: 'button', text: 'ALLOW', onclick: () => this.grant(root) })));
        continue;
      }
      const hits = root.files.filter((f) => (!q || f.path.toLowerCase().includes(q)) && (!this.onlyFavs || this.favs.has(this.key(root, f))));
      kids.push(h('div', { class: 'eng-h open' }, h('span', { text: `▾ ${root.name}` }), h('span', {}, String(hits.length), ' ',
        h('span', { class: 'smp-x', role: 'button', title: `Remove ${root.name} from the list (nothing is deleted)`, text: '×', onclick: () => this.remove(root) }))));
      for (const f of hits.slice(0, 600)) { kids.push(item(root, f)); shown++; }
      if (hits.length > 600) kids.push(h('p', { class: 'lib-none', text: `…and ${hits.length - 600} more: search to narrow them.` }));
    }
    if (!this.roots.length) kids.push(h('p', { class: 'lib-none', text: 'Add a folder of samples (drum hits, loops, one-shots, a multi-sampled instrument): hear them here, drag them onto the arrangement, a drum pad or the sampler.' }));
    else if (!shown && (q || this.onlyFavs)) kids.push(h('p', { class: 'lib-none', text: this.onlyFavs ? 'No favourite yet: star a sample with ★.' : `No sample called "${q}".` }));
    lib.list.replaceChildren(...kids);
    const tap = matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click';
    lib.foot.replaceChildren(h('b', { text: tap }), ': hear it (↑ ↓ walk the list). ', h('b', { text: 'Drag' }), ' it onto the arrangement, a drum pad or the sampler. ', h('b', { text: 'USE' }), ': on the selected track.');
    this.mark();
  }
  mark() { for (const el of this.app.library?.list.querySelectorAll('.smp-item') || []) el.classList.toggle('cur', el.dataset.key === this.cur && !!this.playing); }
}

// the audio files of a drop: files from the computer, or a sample dragged from the SAMPLES list
export async function droppedAudio(app, e) {
  const key = e.dataTransfer?.getData(DRAG_TYPE);
  if (key) { const f = await app.samples?.file(key); return f ? [f] : []; }
  return [...(e.dataTransfer?.files || [])].filter((f) => /^audio\//.test(f.type) || AUDIO.test(f.name));
}
export const dragHasAudio = (e) => { const ty = [...(e.dataTransfer?.types || [])]; return ty.includes('Files') || ty.includes(DRAG_TYPE); };
