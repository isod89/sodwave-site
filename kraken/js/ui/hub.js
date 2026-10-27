// SPDX-License-Identifier: GPL-3.0-only
// The hub: where people publish their songs, presets, templates and plugins (LAB patches), like them, download them,
// follow each other and earn XP. A large window over Kraken (the whole screen on a phone) with five tabs: DISCOVER
// (every item: kinds, genres, tags, search, trending / new / top), FOLLOWING, WORLD (by country), MY PROFILE and,
// for the moderators, MODERATION. An item's page plays it (LISTEN: its first 16 bars, rendered by the same engines,
// the song you are working on untouched), opens it (OPEN IN KRAKEN: one Ctrl+Z brings yours back) or installs it.
// Publishing: PROJECT > Publish to the hub…, ☁ in the preset menus, PUBLISH… in the hub. Only data is published,
// never code and never audio files (the dialog says so). The API is hub/api; ../hub.js speaks to it.
// Browsing, listening and downloading need no account; publishing, liking, following and reporting need one (an
// email gets a sign-in link: /?hub_login=…). An item's public link (/api/s.php?id=…) opens Kraken at /?hub=ID.
import { h } from './kit.js';
import {
  api, session, resumeSession, available, hubInfo, officialSite, setHubUrl, shareUrl, thumbUrl, youtubeUrl, youtubeId, youtubeChannel, COUNTRIES, flag, countryName,
  LEVELS, LEVEL_ICONS, levelOf, BADGES, XP, MAX_DATA, audioIds, KIND_ICONS, ERRORS,
} from '../hub.js';
import { STARTERS, FAMILIES } from '../templates.js';
import { validate, trackSources, projectEnd, APP_VERSION } from '../project.js';
import { listPresets, addPreset } from '../presets.js';
import { DEVICES } from '../fx.js';
import { genSound } from '../gensounds.js';
import { barStart } from '../meter.js';
import { RATE } from '../engine-core.js';
import { getLang, t } from '../i18n.js';
import { HUB_CSS, PRESET_ROW_CSS } from './hub-style.js';
import { saveFile } from '../io.js';
import { cover } from '../hub-art.js';

const KIND = { song: 'Song', preset: 'Preset', plugin: 'Plugin', template: 'Template' };
const KINDS = [['', 'All'], ['song', 'Songs'], ['preset', 'Presets'], ['plugin', 'Plugins'], ['template', 'Templates']];
const SUBKIND = { fx: 'Effect', chain: 'Effect chain', track: 'Track' };
const SORTS = [['trending', 'Trending'], ['new', 'New'], ['top', 'Top']];
const REASONS = [['spam', 'Spam or advertising'], ['offensive', 'Offensive or hateful'], ['copyright', 'Someone else\'s work'], ['broken', 'Broken: it does not open'], ['other', 'Something else']];
const phone = () => matchMedia('(max-width: 700px), (max-height: 520px) and (pointer: coarse)').matches;
const errText = (e) => e?.message || ERRORS.server;
const plural = (n, one, many) => (n === 1 ? one : many);
const hue = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
const grad = (s) => `linear-gradient(135deg, hsl(${hue(s)} 55% 30%), hsl(${(hue(s) + 60) % 360} 60% 12%))`;
const NAME = { translate: 'no' };                                  // (names and texts people typed: never translated)
const levelName = (lv) => LEVELS[lv.level - 1][1];

// ---------------------------------------------------------------------------------------------- the setup ---
// once the interface is up: the HUB button, app.hub, and the links that open it (/?hub=ID, /?hub_login=TOKEN).
// -> true when the page was opened by such a link (the welcome then waits)
export function initHub(app) {
  if (!document.getElementById('hub-css')) document.head.append(h('style', { id: 'hub-css' }, HUB_CSS + PRESET_ROW_CSS));
  const ui = new Hub(app);
  app.hub = ui;
  ui.publishLab = (lab, name) => ui.publish({ lab, name });   // (the LAB editor's ☁ PUBLISH)
  document.getElementById('hubbtn')?.addEventListener('click', () => ui.open());
  ui.ready = resumeSession().then((back) => { if (back && ui.bg) ui.drawTabs(); return back; });   // (still signed in, months later)
  const q = new URLSearchParams(location.search);
  const login = q.get('hub_login'), item = q.get('hub');
  if (login || item) {
    q.delete('hub_login'); q.delete('hub');
    try { history.replaceState(null, '', location.pathname + (q.size ? `?${q}` : '') + location.hash); } catch { /* */ }
    if (login && /^[a-f0-9]{64}$/.test(login)) ui.signIn(login);
    else if (item && /^\d{1,9}$/.test(item)) ui.open({ item: +item });
    else ui.open();
    return true;
  }
  return false;
}

// after the email is sent: the 6-digit code to type, and this window waiting for the link to be opened anywhere (the
// phone's mail app, another browser): it signs in by itself. Polls every 3 s (at once when the page comes back) for 16 min.
export function codeBox(wait, onIn) {
  const code = h('input', { class: 'hub-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123 456', 'aria-label': 'The code of the email', spellcheck: 'false' });
  const ok = h('button', { class: 'hub-btn go', type: 'button' }, 'Sign in');
  const note = h('p', { class: 'hub-wait', role: 'status', text: 'Waiting for the link… or type the code of the email:' });
  const box = h('div', { class: 'hub-codebox' }, note, h('div', { class: 'hub-coderow' }, code, ok));
  let done = false, timer = 0;
  const t0 = Date.now();
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); onIn(r); };
  const send = async () => {
    const v = code.value.replace(/\D+/g, '');
    if (v.length !== 6) { note.textContent = 'The code has 6 digits.'; code.focus(); return; }
    ok.disabled = true;
    try { finish(await api.loginCode(wait, v)); } catch (e) { note.textContent = errText(e); ok.disabled = false; if (e.code === 'bad_code') { code.select(); } }
  };
  ok.onclick = send;
  code.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') send(); });
  code.addEventListener('input', () => { if (code.value.replace(/\D+/g, '').length === 6) send(); });
  const poll = async () => {
    timer = 0;
    if (done || session.token) return;                       // (signed in another way meanwhile)
    if (Date.now() - t0 > 16 * 60 * 1000) { note.textContent = 'This email has expired: ask for a new one.'; return; }
    try { const r = await api.loginWait(wait); if (r.token) { finish(r); return; } } catch (e) { if (e.code === 'bad_token') return; }
    if (!done) timer = setTimeout(poll, 3000);
  };
  const wake = () => { if (document.visibilityState === 'visible' && !done) { clearTimeout(timer); poll(); } };
  document.addEventListener('visibilitychange', wake);
  timer = setTimeout(poll, 3000);
  return box;
}

class Hub {
  constructor(app) {
    this.app = app;
    this.tab = 'discover';
    this.filters = { kind: '', sort: 'trending', genre: '', tag: '', country: '', q: '' };
    this.stack = [];                                             // the views before this one (BACK)
    this.view = null;
    this.preview = null;                                         // LISTEN: { id, src, stop }
    this.lastShare = null;
    this.seq = 0;                                                // (a view drawn late, after another was asked for: dropped)
  }

  // ------------------------------------------------------------------------------------------ the window ---
  build() {
    if (this.bg) return;
    this.search = h('input', { class: 'hub-search', type: 'search', placeholder: 'Search songs, presets, plugins, creators…', 'aria-label': 'Search the hub', spellcheck: 'false', enterkeyhint: 'search' });
    let st = 0;
    this.search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { this.filters.q = this.search.value.trim(); this.go('discover', null, true); }, 380); });
    this.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(st); this.filters.q = this.search.value.trim(); this.go('discover', null, true); } });
    this.meBox = h('div', { class: 'hub-mewrap' });
    this.tabs = h('div', { class: 'hub-tabs', role: 'tablist' });
    this.body = h('div', { class: 'hub-body', translate: null });
    const head = h('div', { class: 'hub-head' },
      h('div', { class: 'hub-logo' }, h('b', { text: 'HUB' }), h('small', { text: 'Songs, sounds and plugins from Kraken users everywhere' })),
      this.search, h('div', { class: 'spacer' }),
      this.app.labStart && !this.app.standalone ? h('button', { class: 'key hub-lab', title: 'LAB: build your own plugin, an instrument or an effect', onclick: () => this.lab() }, '◈ LAB') : null,
      this.meBox,
      this.app.standalone ? null : h('button', { class: 'key hub-x', title: 'Close the hub (Esc)', 'aria-label': 'Close the hub', onclick: () => this.close() }, '×'));
    this.box = h('div', { class: 'hub', role: 'dialog', 'aria-label': 'Kraken hub', tabindex: '-1' }, head, this.tabs, this.body);   // (focusable: the keys stay in it)
    this.bg = h('div', { class: 'hub-bg', hidden: true }, this.box);
    this.bg.addEventListener('pointerdown', (e) => { if (e.target === this.bg) this.close(); });
    // the keys stay in the hub (Space, Delete… are not the song's while it is open); Esc closes it
    this.bg.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-bg')) { e.preventDefault(); this.close(); } e.stopPropagation(); });
    document.body.append(this.bg);
  }
  get isOpen() { return !!this.bg && !this.bg.hidden; }
  // open on a tab ('discover', 'following', 'world', 'me', 'mod'), or { item: id }, or { user: id }
  async open(target = null) {
    this.build();
    this.bg.hidden = false;
    this.app.logAct?.('hub: open');
    if (!(await available())) { this.offline(); return; }
    this.drawTabs();
    this.refreshMe();
    if (target?.item) this.go('item', target.item);
    else if (target?.user) this.go('user', target.user);
    else this.go(typeof target === 'string' ? target : this.view?.name && this.view.name !== 'off' ? this.view.name : 'discover', this.view?.arg, true);
    setTimeout(() => (phone() || this.app.standalone ? this.box : this.search).focus?.({ preventScroll: true }), 30);
  }
  close() {
    if (!this.bg || this.app.standalone) return;                  // (the hub's own page: it is the page, it never closes)
    this.bg.hidden = true;
    this.stopPreview();
    this.app.logAct?.('hub: close');
  }
  drawTabs() {
    const me = session.me;
    const list = [['discover', 'Discover'], ['following', 'Following'], ['world', 'World'], ['me', 'My profile'], ...(me?.admin ? [['mod', 'Moderation']] : [])];
    this.tabs.replaceChildren(...list.map(([k, label]) => h('button', { class: 'key' + (this.tab === k ? ' on' : '') + (k === 'mod' ? ' mod' : ''), role: 'tab', 'aria-selected': String(this.tab === k), 'data-tab': k,
      onclick: () => { this.stack = []; this.go(k, null, true); } }, label)));
    this.drawMe();
  }
  drawMe() {
    const me = session.me;
    if (!me) { this.meBox.replaceChildren(h('button', { class: 'key', onclick: () => this.go('me') }, 'Sign in')); return; }
    const lv = levelOf(me.level?.xp ?? 0);
    this.meBox.replaceChildren(h('button', { class: 'hub-me', title: `${me.name} · ${lv.xp} XP`, onclick: () => { this.stack = []; this.go('me', null, true); } },
      avatar(me, false),
      h('span', { class: 'who' }, h('b', { ...NAME, text: me.name }), xpBar(lv)),
      h('span', { class: 'hub-lv', text: `LV ${lv.level}` })));
  }
  // what happened since the last visit (likes, downloads, followers, badges): said once, as a "+10 XP"
  async refreshMe(prefix = []) {
    if (!session.token) { if (prefix.length) this.app.toast(prefix.join(' · ')); return; }
    const before = session.me?.level?.level || 1;
    try {
      const { me } = await api.me();
      session.setMe(me);
      this.drawTabs();
      this.news(me, before, prefix);
    } catch (e) {
      if (prefix.length) this.app.toast(prefix.join(' · '));
      if (e.status === 401) { this.drawTabs(); if (this.view?.name === 'me') this.go('me', null, true); }
    }
  }
  news(me, before, prefix = []) {
    const ev = me.news || [];
    const sum = (r) => ev.filter((x) => r.test(x.reason)).reduce((a, x) => a + x.n, 0);
    const xp = ev.reduce((a, x) => a + x.xp, 0);
    const parts = [...prefix];
    if (xp > 0) parts.push(`+${xp} XP since your last visit`);
    const likes = sum(/^like$/), dls = sum(/^download$/), fol = sum(/^follower$/);
    if (likes) parts.push(likes === 1 ? '1 new like' : `${likes} new likes`);
    if (dls) parts.push(dls === 1 ? '1 download' : `${dls} downloads`);
    if (fol) parts.push(fol === 1 ? '1 new follower' : `${fol} new followers`);
    for (const b of ev.filter((x) => x.reason.startsWith('badge:'))) if (BADGES[b.reason.slice(6)]) parts.push(`New badge: ${BADGES[b.reason.slice(6)][1]}`);
    if ((me.level?.level || 1) > before) parts.push(`Level up: ${levelName(me.level)}!`);
    if (parts.length) this.app.toast(parts.join(' · '));
  }

  // ------------------------------------------------------------------------------------------ views ---
  // go to a view (pushed on the BACK stack unless fresh)
  go(name, arg = null, fresh = false) {
    if (this.view && !fresh && (this.view.name !== name || this.view.arg !== arg)) this.stack.push(this.view);
    if (fresh) this.stack = [];
    this.view = { name, arg };
    if (['discover', 'following', 'world', 'me', 'mod'].includes(name)) this.tab = name;
    for (const b of this.tabs.children) { const on = b.dataset.tab === this.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    const seq = ++this.seq;
    this.body.replaceChildren(h('div', { class: 'hub-busy', text: 'Loading…' }));
    this.body.scrollTop = 0;
    const draw = { discover: () => this.discover(seq), following: () => this.following(seq), world: () => this.world(seq), me: () => this.profile(seq, null),
      user: () => this.profile(seq, arg), item: () => this.item(seq, arg), mod: () => this.moderation(seq) }[name];
    return Promise.resolve(draw?.()).catch((e) => { if (seq === this.seq) this.body.replaceChildren(this.failed(e)); });
  }
  back() { const v = this.stack.pop(); if (v) { this.view = null; this.go(v.name, v.arg); } else this.go('discover', null, true); }
  put(seq, ...nodes) { if (seq !== this.seq) return false; this.body.replaceChildren(...nodes.flat().filter(Boolean)); return true; }
  backBtn() { return this.stack.length ? h('button', { class: 'hub-btn hub-back', onclick: () => this.back() }, '← Back') : null; }
  failed(e) {
    return h('div', { class: 'hub-empty' }, h('p', { text: errText(e) }), h('button', { class: 'hub-btn', onclick: () => this.go(this.view.name, this.view.arg, true) }, 'Try again'));
  }
  // no hub here (the claude.ai preview, GitHub Pages, a copy on another site): where it lives
  offline() {
    this.view = { name: 'off' };
    this.tabs.replaceChildren(); this.meBox.replaceChildren();
    const site = officialSite();
    const addr = h('input', { type: 'url', placeholder: 'https://example.com/api', 'aria-label': 'Hub address', spellcheck: 'false' });
    this.body.replaceChildren(h('div', { class: 'hub-off' },
      h('div', { class: 'big', 'aria-hidden': 'true' }, '🐙'),
      h('h2', { text: 'The Kraken hub lives at the official site' }),
      h('p', { text: 'Songs, presets and plugins shared by Kraken users around the world, with likes, XP and levels. This copy of Kraken has no hub of its own: the hub needs the official site\'s server.' }),
      site ? h('a', { class: 'hub-btn go', href: `${site.replace(/\/$/, '')}/`, target: '_blank', rel: 'noopener' }, 'Go to the official site') : null,
      h('p', { text: 'Everything else in Kraken works here, as always.' }),
      h('details', { class: 'hub-howxp', style: { textAlign: 'left', width: '100%' } }, h('summary', { text: 'Hub address (for developers)' }),
        h('div', { class: 'hub-form', style: { padding: '4px 0 12px' } },
          h('p', { text: 'The address of a Kraken hub API (the api folder of a site that has one). Leave empty for the one beside this page.' }), addr,
          h('div', { class: 'hub-actions' }, h('button', { class: 'hub-btn', onclick: () => { setHubUrl(addr.value || null); this.open(); } }, 'Use this address'))))));
  }

  // ---- DISCOVER
  async discover(seq) {
    const f = this.filters;
    const chips = h('div', { class: 'hub-filters' },
      KINDS.map(([k, label]) => h('button', { class: 'hub-chip' + (f.kind === k ? ' on' : ''), onclick: () => { f.kind = k; this.go('discover', null, true); } }, label)),
      select('Sort', SORTS, f.sort, (v) => { f.sort = v; this.go('discover', null, true); }),
      genreSelect(f.genre, (v) => { f.genre = v; this.go('discover', null, true); }, 'Any genre'),
      f.country ? h('button', { class: 'hub-chip on', title: 'Remove this filter', onclick: () => { f.country = ''; this.go('discover', null, true); } }, h('span', { class: 'hub-flag', text: flag(f.country) }), h('span', NAME, countryName(f.country, getLang())), ' ×') : null,
      f.tag ? h('button', { class: 'hub-chip on', title: 'Remove this filter', onclick: () => { f.tag = ''; this.go('discover', null, true); } }, h('span', NAME, `#${f.tag}`), ' ×') : null,
      f.q ? h('button', { class: 'hub-chip on', title: 'Remove this filter', onclick: () => { f.q = ''; this.search.value = ''; this.go('discover', null, true); } }, h('span', NAME, `“${f.q}”`), ' ×') : null,
      h('div', { class: 'spacer', style: { flex: '1' } }),
      f.kind === 'plugin' && this.app.labStart ? h('button', { class: 'hub-btn', onclick: () => this.lab() }, '◈ Build a plugin') : null,
      this.app.standalone ? null : h('button', { class: 'hub-btn go', onclick: () => this.publish() }, '☁ Publish…'));
    const query = { kind: f.kind, sort: f.sort, genre: f.genre, tag: f.tag, country: f.country, q: f.q };
    // the hub's own page: a welcome above the first page (not over a search: the results come first)
    const intro = this.app.standalone && !f.q && !f.tag && !f.country ? h('div', { class: 'hub-intro' },
      h('div', {}, h('h1', {}, h('b', { text: 'Discover what people' }), ' ', h('span', { text: 'make with Kraken' })),
        h('p', { text: session.token ? 'Songs, sounds and plugins from creators everywhere. Listen in one click, open them in Kraken, make them yours. Publish yours for everyone, or keep them private: a backup only you can see.'
          : 'Songs, sounds and plugins from creators everywhere. Listen in one click, open them in Kraken, make them yours. Join free to like, follow, and publish yours for everyone or privately.' })),
      h('div', { class: 'acts' }, session.token
        ? h('button', { class: 'hub-btn go', onclick: () => this.publish() }, '☁ Publish…')
        : h('button', { class: 'hub-btn go', onclick: () => this.go('me') }, 'Join free'),
      this.app.labStart ? h('button', { class: 'hub-btn', onclick: () => this.lab() }, '◈ Build a plugin') : null)) : null;
    await this.feed(seq, [intro, chips], query, () => h('div', { class: 'hub-empty' }, h('p', { text: f.q || f.genre || f.tag || f.country || f.kind ? 'Nothing matches these filters yet.' : 'Nothing published yet: be the first!' }),
      f.kind === 'plugin' && this.app.labStart ? h('button', { class: 'hub-btn', onclick: () => this.lab() }, '◈ Build a plugin') : null,
      h('button', { class: 'hub-btn go', onclick: () => this.publish() }, '☁ Publish…')));
  }
  // a list of cards, page after page
  async feed(seq, top, query, empty) {
    const grid = h('div', { class: 'hub-grid' });
    let page = 0;
    const more = h('button', { class: 'hub-btn hub-more', hidden: true }, 'Show more');
    const load = async () => {
      more.disabled = true;
      const r = await api.items({ ...query, page });
      if (seq !== this.seq) return;
      grid.append(...r.items.map((it) => this.card(it)));
      more.hidden = !r.more; more.disabled = false; page++;
    };
    more.onclick = () => load().catch((e) => this.app.toast(errText(e)));
    await load();
    if (grid.children.length) this.put(seq, top, grid, more);
    else this.put(seq, top, empty());
  }
  card(it) {
    return h('button', { class: 'hub-card', 'data-id': it.id, onclick: () => this.go('item', it.id) },
      thumb(it),
      h('div', { class: 'txt' },
        h('div', { class: 'ttl', ...NAME, text: it.title }),
        byline(it.user),
        h('div', { class: 'hub-meta' }, h('span', { text: it.kind === 'preset' && it.subkind ? SUBKIND[it.subkind] || KIND.preset : KIND[it.kind] }),
          it.genre ? [' · ', h('span', { ...NAME, text: it.genre })] : null, it.bpm ? ` · ${+it.bpm.toFixed(2)} BPM` : null),
        h('div', { class: 'hub-stats' }, h('span', { class: it.liked ? 'liked' : null, title: 'Likes' }, `♥ ${it.likes}`), h('span', { title: 'Downloads' }, `⬇ ${it.downloads}`),
          it.countries > 1 ? h('span', { title: 'Countries' }, `🌍 ${it.countries}`) : null)));
  }

  // ---- FOLLOWING
  async following(seq) {
    if (!session.token) { this.put(seq, this.signInBox('Follow creators to see what they publish here. Sign in first: an email is all it takes.')); return; }
    await this.feed(seq, h('p', { text: 'The latest from the creators you follow.' }), { following: 1, sort: 'new' },
      () => h('div', { class: 'hub-empty' }, h('p', { text: 'Nothing here yet. Follow creators (FOLLOW on their profile) and what they publish shows up here.' }),
        h('button', { class: 'hub-btn', onclick: () => this.go('discover', null, true) }, 'Discover creators')));
  }

  // ---- WORLD
  async world(seq) {
    const r = await api.world();
    const lang = getLang();
    const rows = r.countries.map((c, i) => h('button', { onclick: () => { Object.assign(this.filters, { country: c.country, q: '', tag: '' }); this.search.value = ''; this.go('discover', null, true); } },
      h('span', { class: 'rank', text: String(i + 1) }), h('span', { class: 'hub-flag', text: flag(c.country) }), h('span', { class: 'cn', ...NAME, text: countryName(c.country, lang) }),
      num(c.songs, 'songs'), num(c.creators, 'creators'), num(c.likes, 'likes', 'likes')));
    this.put(seq,
      h('h2', { text: 'Kraken around the world' }),
      h('div', { class: 'hub-totals hub-numbers' }, num(r.total.creators, 'creators'), num(r.total.countries, 'countries'), num(r.total.items, 'items')),
      h('p', { text: 'Where the creators of the hub make their music, ranked by songs published. Pick a country to hear what is made there. Your country (optional) is on your profile.' }),
      rows.length ? h('div', { class: 'hub-world' }, rows) : h('div', { class: 'hub-empty' }, h('p', { text: 'No country yet: add yours on your profile, and publish something!' })));
  }

  // ---- an item
  async item(seq, id) {
    const { item: it } = await api.item(id);
    const me = session.me;
    const listen = it.kind === 'song' || it.kind === 'template';
    const likeBtn = h('button', { class: 'hub-btn hub-like' + (it.liked ? ' on' : ''), title: 'Like', onclick: () => this.like(it, likeBtn, stats) }, it.liked ? '♥ Liked' : '♡ Like');
    const listenBtn = listen ? h('button', { class: 'hub-btn hub-listen' + (this.preview?.id === it.id ? ' on' : ''), onclick: () => this.listen(it, listenBtn) }, this.preview?.id === it.id ? '■ Stop' : '▶ Listen') : null;
    const stats = h('div', { class: 'hub-numbers' });
    const drawStats = () => stats.replaceChildren(...[num(it.likes, 'likes'), num(it.downloads, 'downloads'), it.countries ? num(it.countries, it.countries === 1 ? 'country' : 'countries') : null].filter(Boolean));
    // where it is liked: the flags of the likers' countries
    const world = it.liked_in?.length ? h('p', { class: 'hub-likedin' }, h('span', { text: it.liked_in.length === 1 ? 'Liked in 1 country' : `Liked in ${it.liked_in.length} countries` }), ' ',
      it.liked_in.slice(0, 40).map((c) => h('span', { class: 'hub-flag', title: countryName(c, getLang()), text: flag(c) }))) : null;
    drawStats(); stats.redraw = drawStats; stats.it = it;
    const hero = it.youtube
      ? h('a', { class: 'hero', href: youtubeUrl(it.youtube), target: '_blank', rel: 'noopener', title: 'Watch on YouTube' }, thumb(it, true), h('span', { class: 'hub-play' }, h('i')))
      : h('div', { class: 'hero' }, thumb(it, true));
    const kindLine = h('div', { class: 'hub-meta' }, h('span', { text: it.kind === 'preset' && it.subkind ? SUBKIND[it.subkind] || KIND.preset : KIND[it.kind] }),
      it.genre ? [' · ', h('button', { class: 'linkish', ...NAME, style: linkish, onclick: () => { Object.assign(this.filters, { genre: it.genre, tag: '', q: '' }); this.go('discover', null, true); } }, it.genre)] : null,
      it.bpm ? ` · ${+it.bpm.toFixed(2)} BPM` : null, ' · ', h('span', { text: when(it.created_at) }));
    const own = it.mine, admin = me?.admin, priv = it.status === 'private';
    const left = h('div', {},
      hero,
      it.has_audio ? h('p', { class: 'hub-warn', style: { marginTop: '12px' }, text: audioNote(it) }) : null,
      it.more?.length ? [h('h4', { text: 'More from this creator' }), h('div', { class: 'hub-grid' }, it.more.map((x) => this.card(x)))] : null);
    const right = h('div', {},
      h('h2', { ...NAME, text: it.title }),
      kindLine,
      priv ? h('div', { class: 'hub-private' }, h('b', { text: '🔒 Private' }),
        h('span', { text: 'Only you can see it: a backup kept on the hub. Nobody else can find it, open it or download it, not even with its link.' }),
        h('button', { class: 'hub-btn go', onclick: () => this.setPrivate(it, false) }, 'Share with everyone'))
        : it.status === 'hidden' ? h('p', { class: 'hub-warn', style: { marginTop: '10px' }, text: it.hidden_reason === 'reports' ? 'Hidden: reported by several people, waiting for a moderator.' : 'Hidden by a moderator.' }) : null,
      h('div', { class: 'hub-actions' }, listenBtn,
        it.kind === 'song' ? h('button', { class: 'hub-btn go', onclick: () => this.openSong(it) }, 'Open in Kraken') : h('button', { class: 'hub-btn go', onclick: () => this.install(it) }, '⬇ Install'),
        it.kind === 'plugin' && this.app.labOpenPatch ? h('button', { class: 'hub-btn', onclick: () => this.openInLab(it) }, '◈ Open in the LAB') : null,
        priv ? null : likeBtn,
        priv ? null : h('button', { class: 'hub-btn', onclick: () => this.share(it) }, '↗ Share')),
      stats, world,
      it.description ? h('div', { class: 'desc', ...NAME, text: it.description }) : null,
      it.tags?.length ? h('div', { class: 'hub-tags' }, it.tags.map((tg) => h('button', { ...NAME, onclick: () => { Object.assign(this.filters, { tag: tg, genre: '', q: '' }); this.go('discover', null, true); } }, `#${tg}`))) : null,
      h('h4', { text: 'Creator' }),
      this.creator(it.user),
      h('div', { class: 'hub-actions', style: { marginTop: '18px' } },
        own || admin ? h('button', { class: 'hub-btn', onclick: () => this.editItem(it) }, '✎ Edit') : null,
        own && it.status === 'visible' ? h('button', { class: 'hub-btn', onclick: () => this.setPrivate(it, true) }, '🔒 Make private') : null,
        own || admin ? h('button', { class: 'hub-btn danger', onclick: () => this.deleteItem(it) }, 'Delete') : null,
        !own ? h('button', { class: 'hub-btn danger', onclick: () => this.report(it) }, '⚑ Report') : null),
      admin && it.report_list?.length ? [h('h4', { text: 'Reports' }), reportList(it.report_list)] : null);
    this.put(seq, this.backBtn(), h('div', { class: 'hub-item', 'data-item': it.id }, left, right));
  }
  creator(u) {
    const lv = levelOf(u.level?.xp ?? 0);
    const fol = h('span', { class: 'hub-btn' + (u.followed ? ' on' : ''), role: 'button', tabindex: 0 }, u.followed ? '✓ Following' : '+ Follow');
    const mine = session.me?.id === u.id;
    if (!mine) fol.addEventListener('click', (e) => { e.stopPropagation(); this.follow(u, fol); });
    return h('button', { class: 'hub-creator', onclick: () => this.go('user', u.id) }, avatar(u, false),
      h('span', { class: 'who' }, h('b', { ...NAME, text: u.name }), h('span', { class: 'hub-by' }, levelTag(lv), u.followers != null ? h('small', { style: { color: 'var(--dim)' }, text: `${u.followers} ${plural(u.followers, 'follower', 'followers')}` }) : null)),
      mine ? null : fol);
  }

  // ---- a profile (mine with its settings, or someone's)
  async profile(seq, id) {
    if (id == null && !session.token) { this.put(seq, this.signInBox()); return; }
    const uid = id ?? session.me?.id;
    const r = await api.user(uid);
    const u = r.user, me = session.me, mine = me?.id === u.id;
    const lv = levelOf(u.level.xp);
    const fol = !mine ? h('button', { class: 'hub-btn' + (u.followed ? ' on' : ''), onclick: () => this.follow(u, fol, true) }, u.followed ? '✓ Following' : '+ Follow') : null;
    const head = h('div', { class: 'hub-profile' }, avatar(u, true),
      h('div', {},
        h('h2', { ...NAME, text: u.name }),
        h('div', { class: 'lvl' },
          h('span', {}, h('b', {}, `${LEVEL_ICONS[lv.level - 1]} `, h('span', { text: levelName(lv) })), ' · ', h('span', { text: `LV ${lv.level}` }), ' · ', h('span', { text: `${lv.xp} XP` })),
          xpBar(lv),
          h('span', { text: lv.next == null ? 'The highest level of the ocean.' : `${lv.next - lv.xp} XP to ${LEVELS[lv.level][1]}` }))));
    const nums = h('div', { class: 'hub-numbers' }, num(r.items.length, 'items'), num(u.likes, 'likes'), num(u.countries, u.countries === 1 ? 'country' : 'countries'), num(u.followers, 'followers'), num(u.following, 'following'));
    const badges = h('div', { class: 'hub-badges' }, Object.entries(BADGES).map(([k, [ic, name, about]]) => h('div', { class: 'hub-badge' + (u.badges.includes(k) ? '' : ' off'), title: about },
      h('i', { text: ic }), h('div', {}, h('b', { text: name }), h('small', { text: about })))));
    const country = u.country ? h('p', {}, h('span', { class: 'hub-flag', text: flag(u.country) }), ' ', h('span', NAME, countryName(u.country, getLang()))) : null;
    const actions = h('div', { class: 'hub-actions' }, fol,
      mine ? h('button', { class: 'hub-btn', onclick: () => this.editProfile() }, '✎ Edit my profile') : null,
      mine ? h('button', { class: 'hub-btn go', onclick: () => this.publish() }, '☁ Publish…') : null,
      mine && this.app.labStart ? h('button', { class: 'hub-btn', onclick: () => this.lab() }, '◈ Build a plugin') : null,
      u.youtube ? h('a', { class: 'hub-btn', href: u.youtube, target: '_blank', rel: 'noopener' }, '▶ YouTube channel') : null,
      !mine && me?.admin ? h('button', { class: 'hub-btn danger', onclick: () => this.adminAct(u.banned ? 'unban' : 'ban', { user: u.id }, () => this.go('user', u.id, true)) }, u.banned ? 'Unban' : 'Ban') : null,
      mine ? h('button', { class: 'hub-btn', onclick: () => this.signOut() }, 'Sign out') : null);
    const grid = r.items.length ? h('div', { class: 'hub-grid' }, r.items.map((it) => this.card(it)))
      : h('div', { class: 'hub-empty' }, h('p', { text: mine ? 'You have not published anything yet. Your song, a preset, a plugin: share it with the world.' : 'Nothing published yet.' }));
    this.put(seq, this.backBtn(), head, country, u.bio ? h('p', { class: 'desc', ...NAME, style: { whiteSpace: 'pre-wrap', color: 'var(--text)' }, text: u.bio }) : null,
      nums, actions, h('h4', { text: 'Badges' }), badges, h('h4', { text: mine ? 'My work' : 'Work' }), grid, mine ? howXp(lv) : null, mine ? this.myData() : null);
  }
  // my data: a copy of all of it, or the account deleted (with everything it published)
  myData() {
    return h('details', { class: 'hub-howxp' }, h('summary', { text: 'My data' }),
      h('p', { style: { marginTop: '6px' }, text: 'The hub keeps your email (never shown), your profile, what you publish, your likes, follows and reports, and your XP. Download a copy of all of it, or delete your account and everything it published, for good.' }),
      legal(),
      h('div', { class: 'hub-actions' },
        h('button', { class: 'hub-btn', onclick: async () => {
          try { const d = await api.myData(); this.app.toast(`Saved ${await saveFile('kraken-hub-my-data.json', JSON.stringify(d, null, 1))}`); } catch (e) { this.app.toast(errText(e)); }
        } }, '⬇ Download my data'),
        h('button', { class: 'hub-btn danger', onclick: () => this.app.confirm('Delete my hub account', 'Your hub account, everything you published, your likes and follows are deleted for good. Your songs in Kraken stay on this device.', 'Delete my account', async () => {
          try { await api.deleteMe(); session.clear(); this.drawTabs(); this.go('me', null, true); this.app.toast('Your hub account is deleted.'); } catch (e) { this.app.toast(errText(e)); }
        }, true) }, 'Delete my account')));
  }
  signInBox(why = null) {
    const email = h('input', { type: 'email', placeholder: 'you@example.com', 'aria-label': 'Email address', autocomplete: 'email', spellcheck: 'false' });
    const msg = h('div');
    const send = h('button', { class: 'hub-btn go' }, 'Email me a link');
    const go = async () => {
      const v = email.value.trim();
      if (!v) { email.focus(); return; }
      send.disabled = true;
      try {
        const r = await api.login(v, getLang());
        msg.replaceChildren(h('div', { class: 'hub-sent' }, h('span', { text: 'Check your inbox: a sign-in email is on its way. Open its link, on this device or another one: this window signs in by itself. Nothing there? Look in the spam folder.' }),
          r.dev_link ? [h('br'), h('a', { href: r.dev_link, class: 'hub-devlink', text: 'Test mode: sign in now' })] : null),
          r.wait ? codeBox(r.wait, (x) => this.signedIn(x)) : null);
      } catch (e) { msg.replaceChildren(h('p', { class: 'hub-warn', text: errText(e) })); }
      send.disabled = false;
    };
    send.onclick = go;
    email.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'hub-login' },
      h('div', { class: 'big', 'aria-hidden': 'true' }, '🐙'),
      h('h2', { text: 'Join the Kraken hub' }),
      h('p', { text: why || 'Publish your songs, presets and plugins, like and follow, earn XP and climb from Plankton to Legendary Kraken. No password: we email you a link to sign in.' }),
      h('div', { class: 'hub-form' }, h('label', {}, 'Email', email), send, msg),
      h('p', { text: 'Browsing, listening and downloading need no account. Your email is never shown to anyone.' }),
      legal(true), howXp(null));
  }
  // the link from the email: a session, and a name to choose the first time
  async signIn(token) {
    this.build();
    this.bg.hidden = false;
    if (!(await available())) { this.offline(); return; }
    this.drawTabs();
    this.body.replaceChildren(h('div', { class: 'hub-busy', text: 'Signing in…' }));
    try {
      await this.signedIn(await api.exchange(token));
    } catch (e) {
      this.app.toast(errText(e));
      this.go('me', null, true);
    }
  }
  // signed in (by the link, its code, or the link opened somewhere else): the session kept, the profile shown
  async signedIn(r) {
    session.set(r.token, r.me);
    this.build();
    this.bg.hidden = false;
    this.drawTabs();
    this.app.toast(`Signed in to the hub. Welcome, ${r.me.name}!`);
    this.onSignedIn?.(r);
    await this.go('me', null, true);
    if (r.created) this.editProfile(true);
  }
  async signOut() {
    try { await api.logout(); } catch { /* signed out here anyway */ }
    session.clear();
    this.drawTabs();
    this.go('me', null, true);
    this.app.toast('Signed out of the hub.');
  }
  editProfile(first = false) {
    const me = session.me || {};
    const lang = getLang();
    const name = h('input', { value: me.name || '', maxlength: 32, 'aria-label': 'Name', autocomplete: 'nickname' });
    const country = h('select', { 'aria-label': 'Country' }, h('option', { value: '' }, 'Not said'),
      COUNTRIES.map((c) => [c, countryName(c, lang)]).sort((a, b) => a[1].localeCompare(b[1], lang)).map(([c, n]) => h('option', { value: c, selected: c === me.country ? true : null, translate: 'no' }, `${flag(c)} ${n}`)));
    const bio = h('textarea', { maxlength: 280, rows: 3, 'aria-label': 'About you', placeholder: 'A few words about you and your music (optional)' }, me.bio || '');
    const yt = h('input', { type: 'url', value: me.youtube || '', placeholder: 'https://www.youtube.com/@yourname', 'aria-label': 'YouTube channel' });
    const err = h('p', { class: 'bad', hidden: true });
    const save = async () => {
      if (yt.value.trim() && !youtubeChannel(yt.value)) { err.textContent = ERRORS.bad_channel; err.hidden = false; return; }
      try {
        const r = await api.saveMe({ name: name.value, country: country.value, bio: bio.value, youtube: yt.value.trim() });
        session.setMe({ ...session.me, ...r.me });
        m.close();
        this.drawTabs();
        this.go('me', null, true);
        this.app.toast('Profile saved.');
      } catch (e) { err.textContent = errText(e); err.hidden = false; }
    };
    const m = this.app.modal(first ? 'Welcome to the hub!' : 'My hub profile', [
      first ? h('p', { class: 'hint', text: 'Choose the name people will see, and your country if you like: it puts you on the WORLD map.' }) : null,
      field('Name', name), field('Country (optional)', country), field('About you (optional)', bio), field('YouTube channel (optional)', yt), err,
      h('div', { class: 'row' }, h('button', { class: 'add', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'add go', onclick: save }, 'Save')),
    ].filter(Boolean), []);
    m.box.classList.add('hub-pub');
    setTimeout(() => name.focus(), 30);
  }

  // ---- MODERATION
  async moderation(seq) {
    const r = await api.adminReports();
    const rows = r.items.map((it) => h('div', { class: 'hub-mod-row', 'data-id': it.id },
      h('div', {},
        h('b', { ...NAME, style: { font: '700 13px/1.3 var(--f-ui)' }, text: it.title }),
        h('span', { class: 'hub-status' + (it.status === 'visible' ? ' vis' : ''), text: it.status === 'visible' ? 'Visible' : it.hidden_reason === 'reports' ? 'Hidden by reports' : 'Hidden' }),
        h('div', { class: 'hub-by', style: { marginTop: '6px' } }, h('span', { text: KIND[it.kind] }), ' · ', byline(it.user), ' · ', h('span', { text: `${it.reports} ${plural(it.reports, 'report', 'reports')}` })),
        reportList(it.report_list)),
      h('div', { class: 'hub-actions' },
        h('button', { class: 'hub-btn', onclick: () => this.go('item', it.id) }, 'Open'),
        it.status === 'visible' ? h('button', { class: 'hub-btn', onclick: () => this.adminAct('hide', { id: it.id }) }, 'Hide') : null,
        h('button', { class: 'hub-btn', onclick: () => this.adminAct('restore', { id: it.id }) }, it.status === 'visible' ? 'Dismiss reports' : 'Restore'),
        h('button', { class: 'hub-btn danger', onclick: () => this.app.confirm('Delete from the hub', `Delete "${it.title}" for good?`, 'Delete', () => this.adminAct('delete', { id: it.id }), true) }, 'Delete'),
        h('button', { class: 'hub-btn danger', onclick: () => this.app.confirm('Ban this creator', `Ban ${it.user.name}? They can no longer publish, like or follow, and everything they published is hidden.`, 'Ban', () => this.adminAct('ban', { user: it.user.id }), true) }, 'Ban creator'))));
    const banned = r.banned.map((u) => h('div', { class: 'hub-mod-row' }, byline(u),
      h('div', { class: 'hub-actions' }, h('button', { class: 'hub-btn', onclick: () => this.adminAct('unban', { user: u.id }) }, 'Unban'))));
    this.put(seq, h('h2', { text: 'Moderation' }),
      h('p', { text: 'Reported and hidden items. An item reported by several people is hidden until you look at it: restore it, or delete it. Banning someone hides everything they published.' }),
      rows.length ? h('div', { class: 'hub-mod' }, rows) : h('div', { class: 'hub-empty' }, h('p', { text: 'Nothing to review. All calm in the ocean.' })),
      h('h4', { text: 'Banned' }), banned.length ? h('div', { class: 'hub-mod' }, banned) : h('p', { text: 'Nobody.' }));
  }
  async adminAct(action, args, then = null) {
    try { await api.admin(action, args); this.app.toast({ hide: 'Hidden.', restore: 'Restored.', delete: 'Deleted.', ban: 'Banned.', unban: 'Unbanned.' }[action]); }
    catch (e) { this.app.toast(errText(e)); }
    if (then) then(); else this.go(this.view.name, this.view.arg, true);
  }

  // ------------------------------------------------------------------------------------------ actions ---
  needMember() {
    if (session.token) return true;
    this.go('me', null, true);
    this.app.toast('Sign in to the hub first (an email is all it takes).');
    return false;
  }
  async like(it, btn, stats) {
    if (!this.needMember()) return;
    btn.disabled = true;
    try {
      const r = await api.like(it.id, !it.liked);
      Object.assign(it, { liked: r.liked, likes: r.likes, countries: r.countries });
      btn.textContent = it.liked ? '♥ Liked' : '♡ Like';
      btn.classList.toggle('on', it.liked);
      stats.redraw();
      const parts = this.gained(r.xp);
      if (parts?.length) this.app.toast(parts.join(' · '));
    } catch (e) { this.app.toast(errText(e)); }
    btn.disabled = false;
  }
  async follow(u, btn, redraw = false) {
    if (!this.needMember()) return;
    try {
      const r = await api.follow(u.id, !u.followed);
      u.followed = r.followed; u.followers = r.followers;
      btn.textContent = u.followed ? '✓ Following' : '+ Follow';
      btn.classList.toggle('on', u.followed);
      this.app.toast(u.followed ? `You follow ${u.name}: what they publish shows in FOLLOWING.` : `You no longer follow ${u.name}.`);
      if (redraw) this.go(this.view.name, this.view.arg, true);
    } catch (e) { this.app.toast(errText(e)); }
  }
  // XP just earned by what I did: said at once, the level kept up to date
  gained(xp) {
    if (!xp) return;
    const me = session.me;
    const before = me?.level?.level || 1;
    if (me && xp.level) { session.setMe({ ...me, level: xp.level }); this.drawMe(); }
    const parts = [];
    if (xp.total > 0) parts.push(`+${xp.total} XP`);
    if (xp.level && xp.level.level > before) parts.push(`Level up: ${levelName(xp.level)}!`);
    return parts;
  }
  async share(it) {
    const url = shareUrl(it.id);
    this.lastShare = url;
    if (navigator.share) {
      try { await navigator.share({ title: it.title, text: t(`${it.title}, made with Kraken`), url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); this.app.toast('Link copied: paste it anywhere (it shows the title, the creator and the video).'); }
    catch {
      const inp = h('input', { value: url, readonly: true, style: { width: '100%' }, 'aria-label': 'Link' });
      this.app.modal('Share', [h('p', { class: 'hint', text: 'Copy this link:' }), inp], [['Close', null, true]]);
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    }
  }
  report(it) {
    if (!this.needMember()) return;
    const reason = h('select', { 'aria-label': 'Reason' }, h('option', { value: '' }, 'Choose a reason…'), REASONS.map(([v, l]) => h('option', { value: v }, l)));
    const note = h('textarea', { maxlength: 300, rows: 3, placeholder: 'Anything the moderators should know (optional)', 'aria-label': 'Note' });
    const err = h('p', { class: 'bad', hidden: true });
    const send = async () => {
      if (!reason.value) { err.textContent = ERRORS.bad_reason; err.hidden = false; return; }
      try { await api.report(it.id, reason.value, note.value); m.close(); this.app.toast('Thank you: the moderators will look at it.'); }
      catch (e) { err.textContent = errText(e); err.hidden = false; }
    };
    const m = this.app.modal('Report this', [h('p', { class: 'hint', text: 'Reports go to the hub\'s moderators. When several people report something, it is hidden until they look at it.' }),
      field('Reason', reason), field('Note', note), err,
      h('div', { class: 'row' }, h('button', { class: 'add', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'add go danger', onclick: send }, 'Report'))], []);
    m.box.classList.add('hub-pub');
  }
  // private (only me: a backup) or shared with everyone, any time
  async setPrivate(it, on) {
    const run = async () => {
      try {
        const r = await api.edit({ id: it.id, private: on });
        const parts = on ? [] : this.gained(r.xp) || [];
        this.app.toast([on ? 'Private: only you can see it now.' : 'Shared: everyone can see it now.', ...parts].join(' · '));
        this.go('item', it.id, true);
        if (!on) this.refreshMe();
      } catch (e) { this.app.toast(errText(e)); }
    };
    if (on) this.app.confirm('Make it private', `Only you will see "${it.title}". Its page and its link stop working for everyone else; its likes and downloads stay.`, 'Make private', run);
    else run();
  }
  deleteItem(it) {
    this.app.confirm('Delete from the hub', `Delete "${it.title}" from the hub? Its likes and downloads go with it (your XP stays).`, 'Delete', async () => {
      try { await api.remove(it.id); this.app.toast('Deleted from the hub.'); this.stack = []; this.go('me', null, true); } catch (e) { this.app.toast(errText(e)); }
    }, true);
  }
  editItem(it) {
    const f = this.fields({ title: it.title, description: it.description, genre: it.genre, tags: (it.tags || []).join(', '), youtube: it.youtube ? youtubeUrl(it.youtube) : '' });
    const err = h('p', { class: 'bad', hidden: true });
    const save = async () => {
      const v = f.values();
      if (v.youtube && !youtubeId(v.youtube)) { err.textContent = ERRORS.bad_youtube; err.hidden = false; return; }
      try {
        const r = await api.edit({ id: it.id, ...v });
        m.close();
        const parts = this.gained(r.xp) || [];
        this.app.toast(['Saved.', ...parts].join(' · '));
        this.go('item', it.id, true);
      } catch (e) { err.textContent = errText(e); err.hidden = false; }
    };
    const m = this.app.modal('Edit', [...f.nodes, err,
      h('div', { class: 'row' }, h('button', { class: 'add', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'add go', onclick: save }, 'Save'))], []);
    m.box.classList.add('hub-pub');
  }
  // the title, description, genre, tags and YouTube fields (publishing and editing)
  fields(v, onYt = null) {
    const title = h('input', { value: v.title || '', maxlength: 80, 'aria-label': 'Title' });
    const desc = h('textarea', { maxlength: 2000, rows: 4, 'aria-label': 'Description', placeholder: 'What is it? How was it made? (optional)' }, v.description || '');
    const sel = genreSelect(v.genre || '', null, 'No genre');
    const tags = h('input', { value: v.tags || '', maxlength: 200, placeholder: 'chill, night, vocal chops', 'aria-label': 'Tags' });
    const yt = h('input', { type: 'url', value: v.youtube || '', placeholder: 'https://youtu.be/…', 'aria-label': 'YouTube link' });
    const ytSay = h('span');
    const check = () => {
      const s = yt.value.trim(), id = s ? youtubeId(s) : null;
      ytSay.className = s ? (id ? 'ok' : 'bad') : '';
      ytSay.textContent = s ? (id ? '✓ A YouTube video' : 'Not a YouTube video link') : '';
      onYt?.(id);
    };
    yt.addEventListener('input', check);
    check();
    return {
      nodes: [field('Title', title), field('Description', desc), h('div', { class: 'hub-pub-row', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' } },
        field('Genre', sel), field('Tags (optional)', tags)), field('YouTube video (optional)', yt, ytSay)],
      values: () => ({ title: title.value.trim(), description: desc.value, genre: sel.value, tags: tags.value, youtube: yt.value.trim() }),
      title,
    };
  }

  // ---- LISTEN: the first 16 bars, rendered by the same engines, played beside the song (which stays as it is)
  async listen(it, btn) {
    const was = this.preview?.id;
    this.stopPreview();
    if (was === it.id) return;
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const { data } = await api.data(it.id, false);
      const p = validate(structuredClone(data));
      const end = Math.min(barStart(p, 16), projectEnd(p));
      if (!(end > 0)) throw new Error('This song has nothing in its arrangement to play.');
      const assets = {};
      for (const t of p.tracks) for (const id of trackSources(t)) { const a = genSound(id) || this.app.assets.get(id); if (a) assets[id] = { L: a.L, R: a.R }; }
      if (this.app.playing) this.app.play(false);
      const [L, R] = await this.app.audio.render(p, { end, tail: 1, assets });
      if (!btn.isConnected && !this.isOpen) return;
      const ctx = this.app.audio.ctx;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const buf = ctx.createBuffer(2, L.length, RATE);
      buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
      const src = ctx.createBufferSource(), gain = ctx.createGain();
      src.buffer = buf; gain.gain.value = 0.9;
      src.connect(gain).connect(ctx.destination);
      const done = () => { if (this.preview?.src === src) { this.preview = null; } btn.classList.remove('on'); btn.textContent = '▶ Listen'; };
      src.onended = done;
      this.preview = { id: it.id, src, startedAt: ctx.currentTime, seconds: buf.duration, stop: () => { try { src.stop(); } catch { /* */ } done(); } };
      src.start();
      btn.classList.add('on');
      btn.textContent = '■ Stop';
      const bars = Math.max(1, Math.min(16, Math.round(end / barStart(p, 1))));
      this.app.toast(bars === 1 ? 'Listening to the first bar. Your song is untouched.' : `Listening to the first ${bars} bars. Your song is untouched.`);
    } catch (e) {
      btn.textContent = '▶ Listen';
      this.app.toast(errText(e));
    }
    btn.disabled = false;
  }
  stopPreview() { this.preview?.stop(); this.preview = null; }

  // ---- OPEN a song: it replaces the project, the way a starter does (yours: one Ctrl+Z away, and in Earlier versions)
  async openSong(it) {
    try {
      const { data } = await api.data(it.id, true);
      const p = validate(structuredClone(data));
      this.stopPreview();
      this.app.load(p);
      await this.app.restoreAssets?.(this.app.store.p);
      this.close();
      const n = it.audio_count, msg = `${it.title} by ${it.user.name} is open. Your song is one Ctrl+Z away (and in PROJECT > Earlier versions).`;
      const extra = !it.has_audio ? '' : n === 1 ? 'Its audio file was not published.' : `Its ${n} audio files were not published.`;
      this.app.toast(extra ? `${msg} ${extra}` : msg);
    } catch (e) { this.app.toast(errText(e)); }
  }
  // ---- the LAB from the hub: build a plugin (the hub closes, the LAB's door opens)
  lab() { if (!this.app.standalone) this.close(); this.app.labStart?.(); }
  // a plugin opened in the LAB at once: kept in MY PATCHES, played (a new track, or an effect on the selected track), its editor open
  async openInLab(it) {
    try {
      const { data } = await api.data(it.id, true);
      if (!data?.lab) { this.app.toast('That plugin has no LAB patch.'); return; }
      if (!this.app.standalone) this.close();
      await this.app.labOpenPatch(data.lab, { name: it.title, from: { hub: it.id, creator: it.user?.name } });
    } catch (e) { this.app.toast(errText(e)); }
  }
  // ---- INSTALL a preset, a template, a plugin: kept with my presets
  async install(it) {
    try {
      const { data } = await api.data(it.id, true);
      const name = it.title.slice(0, 40);
      if (it.kind === 'plugin') {
        const meta = { name: it.title, hubId: it.id, creator: it.user.name };
        if (this.app.installLab) { await this.app.installLab(data.lab, meta); this.app.toast(`${it.title} is installed.`); return; }
        const q = await addPreset({ kind: 'lab', name, data: { lab: data.lab, hub: meta } });
        this.app.toast(q ? `${it.title} is kept with your presets: the LAB opens it.` : 'It could not be saved (storage?).');
        return;
      }
      if (it.kind === 'template') {
        const p = validate(structuredClone(data));
        const q = await addPreset({ kind: 'template', name, data: { json: JSON.stringify({ ...p, name }) } });
        this.app.toast(q ? `Template ${name} installed: PROJECT > Start a song in a style shows it under Your templates.` : 'It could not be saved (storage?).');
        return;
      }
      const q = await addPreset({ kind: data.kind, ...(data.type ? { type: data.type } : {}), name, data: data.data });
      if (!q) { this.app.toast('It could not be saved (storage?).'); return; }
      this.app.library?.render?.(true);
      this.app.toast(data.kind === 'fx' ? `Installed: in the ☰ of every ${DEVICES[data.type]?.name || 'effect'}.`
        : data.kind === 'chain' ? 'Installed: in the PRESETS of every effect chain.' : 'Installed: + TRACK > From a preset, and SOUNDS > ★ MY SOUNDS.');
    } catch (e) { this.app.toast(errText(e)); }
  }

  // ------------------------------------------------------------------------------------------ publishing ---
  // what: { kind: 'song' } (the song open now), { kind: 'template' } (it, as a template), { preset } (one of mine),
  // { lab, name } (a LAB patch); nothing: a choice
  async publish(what = null) {
    if (!this.isOpen) { this.build(); this.bg.hidden = false; this.drawTabs?.(); }
    if (!(await available())) { this.offline(); return; }
    await this.refreshMe();                                        // (what today's publishes still earn: up to date)
    if (!session.token) { this.drawTabs(); this.go('me', null, true); this.app.toast('Sign in to publish: an email is all it takes.'); return; }
    if (!this.view) this.go('discover', null, true);
    if (!what) { this.chooser(); return; }
    let kind, data, title, n = 0, sub = null, genre = '';
    const p = this.app.store.p;
    if (what.kind === 'song' || what.kind === 'template') {
      await this.app.wam?.captureAll?.();                          // (the plugins' latest settings)
      kind = what.kind;
      data = structuredClone({ ...p, savedWith: APP_VERSION });
      title = p.name;
      n = audioIds(p.tracks).size;
      const st = /^My (.+) song$/.exec(p.name);
      if (st && STARTERS.some((s) => s.name === st[1])) genre = st[1];
    } else if (what.preset) {
      const q = what.preset;
      title = q.name;
      if (q.kind === 'template') { kind = 'template'; data = JSON.parse(q.data.json); n = audioIds(data.tracks).size; }
      else if (q.kind === 'lab') { kind = 'plugin'; data = { lab: q.data.lab ?? q.data }; }
      else { kind = 'preset'; sub = q.kind; data = { kind: q.kind, ...(q.type ? { type: q.type } : {}), name: q.name, data: q.data }; n = audioIds(q.data).size; }
    } else if (what.lab) { kind = 'plugin'; data = { lab: what.lab }; title = what.name || 'LAB patch'; }
    else return;
    const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    if (bytes > MAX_DATA) { this.app.toast(`Too large for the hub: ${Math.round(bytes / 1024)} KB, 512 KB at most.`); return; }
    this.publishDialog({ kind, sub, data, title, n, genre });
  }
  chooser() {
    const pick = async (kinds, empty) => {
      const mine = (await listPresets()).filter((q) => kinds.includes(q.kind));
      if (!mine.length) { this.app.toast(empty); return; }
      this.app.sheet('Which one?', mine.map((q) => [`${q.kind === 'template' ? '▤' : q.kind === 'lab' ? '◈' : '⧉'} ${q.name.toUpperCase()}`, () => this.publish({ preset: q })]));
    };
    this.app.sheet('Publish to the hub', [
      ['♪ This song', () => this.publish({ kind: 'song' })],
      ['▤ This song, as a template', () => this.publish({ kind: 'template' })],
      ['⧉ One of my presets…', () => pick(['fx', 'chain', 'track'], 'No preset yet: save one from an effect\'s ☰, a chain\'s PRESETS or a track\'s menu.')],
      ['▤ One of my templates…', () => pick(['template'], 'No template yet: PROJECT > Save as a template.')],
      ['◈ A LAB plugin…', async () => {
        const labs = (await this.app.hubLabs?.()) || [];
        if (labs.length) this.app.sheet('Which one?', labs.map((x) => [`◈ ${String(x.name).toUpperCase()}`, () => this.publish({ lab: x.lab, name: x.name })]));
        else pick(['lab'], 'No LAB plugin yet: make one in the LAB.');
      }],
    ]);
  }
  publishDialog({ kind, sub, data, title, n, genre }) {
    const me = session.me;
    const today = me?.today || { publishes: 0, publish_max: XP.publishPerDay, youtube: 0, youtube_max: XP.youtubePerDay };
    const preview = h('div', { class: 'hub-xp-preview' });
    let ytOk = null, priv = false;
    // who sees it: everyone, or only me (a backup on the hub: nobody else can see it or take the idea)
    const vis = h('div', { class: 'hub-vis', role: 'radiogroup', 'aria-label': 'Who can see it' });
    const visSay = h('p', { class: 'hint' });
    const drawVis = () => {
      vis.replaceChildren(...[[false, '🌍 Everyone', 'On the hub for all to hear, like and download'], [true, '🔒 Only me', 'Private: a backup nobody else can see']].map(([v, b, sm]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(priv === v), class: priv === v ? 'on' : '', onclick: () => { priv = v; drawVis(); drawXp(); } }, h('b', { text: b }), h('small', { text: sm }))));
      visSay.textContent = priv ? 'Only you can see it, with your account, on any device. Share it with everyone later if you like: one button on its page.'
        : 'Everyone can see what you publish, with your name and level. You can edit, make private or delete it later.';
      go.textContent = priv ? 'Keep privately' : 'Publish';
    };
    const drawXp = () => {
      if (priv) { preview.replaceChildren(h('b', { text: '+0 XP' }), h('span', { text: 'Private: XP comes when you share it with everyone.' })); return; }
      const pub = today.publishes < today.publish_max ? XP.publish : 0;
      const yt = kind === 'song' && ytOk && today.youtube < today.youtube_max ? XP.youtube : 0;
      preview.replaceChildren(...[h('b', { text: `+${pub + yt} XP` }),
        h('span', { text: pub ? `+${XP.publish} XP for publishing (${today.publish_max - today.publishes} of ${today.publish_max} left today)` : `The first ${today.publish_max} publishes of a day earn XP: this one earns none today.` }),
        kind === 'song' ? h('span', { text: yt ? `+${XP.youtube} XP for the YouTube link` : `A YouTube link of your song earns +${XP.youtube} XP` }) : null,
        h('span', { text: `Then +${XP.like} XP for each like, +${XP.download} XP for each download.` })].filter(Boolean));   // (no "null" for a preset or a plugin)
    };
    const f = this.fields({ title, genre }, (id) => { ytOk = !!id; drawXp(); });
    drawXp();
    const what = { song: 'Your song as data: anyone can listen to it, open it in Kraken and make it their own. Songs made with Kraken\'s engines sound the same everywhere.',
      template: 'Your song as a template: people install it and start their own songs from it.',
      preset: 'Your preset\'s settings: anyone can install it and use it in their songs.',
      plugin: 'Your LAB patch: anyone can install it. Only its patch is published, never code.' }[kind];
    const audio = !n ? null : h('p', { class: 'hub-warn', text: kind === 'preset'
      ? (n === 1 ? 'This preset uses 1 audio file: it is not published. People get the settings without the samples.' : `This preset uses ${n} audio files: they are not published. People get the settings without the samples.`)
      : (n === 1 ? 'This song uses 1 audio file: it is not published. People get everything else; those clips stay silent for them.' : `This song uses ${n} audio files: they are not published. People get everything else; those clips stay silent for them.`) });
    const wam = (kind === 'song' || kind === 'template') && (data.tracks || []).some((t) => t.kind === 'wam' || (t.fx || []).some((d) => d.type === 'wam'))
      ? h('p', { class: 'hint', text: 'It uses plugins from other sites (WAM): people are asked before those run.' }) : null;
    const err = h('p', { class: 'bad', hidden: true });
    const go = h('button', { class: 'add go hub-publish-go' }, 'Publish');
    drawVis();
    go.onclick = async () => {
      const v = f.values();
      if (!v.title) { err.textContent = ERRORS.bad_title; err.hidden = false; f.title.focus(); return; }
      if (v.youtube && !youtubeId(v.youtube)) { err.textContent = ERRORS.bad_youtube; err.hidden = false; return; }
      go.disabled = true; go.textContent = priv ? 'Saving…' : 'Publishing…';
      try {
        const r = await api.publish({ kind, ...v, data, ...(priv ? { private: true } : {}) });
        m.close();
        const parts = this.gained(r.xp) || [];
        const said = priv ? 'Kept privately on the hub: only you can see it.' : 'Published on the hub!';
        if (!priv) session.setMe({ ...session.me, today: { ...today, publishes: today.publishes + 1, youtube: today.youtube + (r.item.youtube && kind === 'song' ? 1 : 0) } });
        this.app.toast([said, ...parts].join(' · '));
        this.app.logAct?.(`hub: ${priv ? 'kept privately' : 'published'} ${kind}`);
        this.go('item', r.item.id);
        if (!priv) this.refreshMe([said, ...parts]);                // (and the badge it may have earned)
      } catch (e) { err.textContent = errText(e); err.hidden = false; go.disabled = false; drawVis(); }
    };
    const m = this.app.modal({ song: 'Publish this song', template: 'Publish as a template', preset: `Publish this ${(SUBKIND[sub] || 'preset').toLowerCase()}`, plugin: 'Publish this plugin' }[kind], [
      h('p', { class: 'hint', text: what }), audio, wam, vis, ...f.nodes, preview, err, visSay,
      h('div', { class: 'row' }, h('button', { class: 'add', onclick: () => m.close() }, 'Cancel'), go),
    ].filter(Boolean), []);
    m.box.classList.add('hub-pub');
    setTimeout(() => { f.title.focus(); f.title.select(); }, 30);
  }
}

// -------------------------------------------------------------------------------------------------- pieces ---
const linkish = { background: 'none', border: '0', padding: '0', color: 'var(--accent)', font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit', cursor: 'pointer' };
// a cover drawn for it (hub-art.js: from its id and title, in Kraken's colours), the kind's sign over it
function coverEl(it) {
  const el = h('span', { class: 'art', 'aria-hidden': 'true' });
  el.innerHTML = cover(`${it.id}${it.title}`, it.kind);
  return el;
}
function thumb(it, big = false) {
  return h('div', { class: 'hub-thumb', '--g': grad(`${it.kind}${it.id}${it.title}`) },
    it.youtube ? h('img', { src: thumbUrl(it.youtube), alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.remove() }) : coverEl(it),
    big ? null : h('span', { class: 'kind', text: KIND[it.kind] }),
    it.youtube && !big ? h('span', { class: 'yt', title: 'YouTube video' }) : null,
    it.status === 'private' ? h('span', { class: 'tag-private', title: 'Only you can see it', text: '🔒 Private' })
      : it.status && it.status !== 'visible' ? h('span', { class: 'tag-hidden', text: 'Hidden' }) : null);
}
function avatar(u, big) {
  return h('span', { class: 'hub-avatar' + (big ? ' big' : ''), '--g': grad(u.name), 'aria-hidden': 'true' }, h('span', { ...NAME, text: (u.name || '?').trim().charAt(0).toUpperCase() }),
    u.country ? h('span', { class: 'hub-flag', text: flag(u.country) }) : null);
}
const levelTag = (lv) => h('span', { class: 'hub-lv', title: `${levelName(lv)} · ${lv.xp} XP` }, `LV ${lv.level} ${LEVEL_ICONS[lv.level - 1]}`);
function byline(u) {
  const lv = levelOf(u.level?.xp ?? 0);
  return h('span', { class: 'hub-by' }, u.country ? h('span', { class: 'hub-flag', title: countryName(u.country, getLang()), text: flag(u.country) }) : null,
    h('span', { class: 'nm', ...NAME, text: u.name }), levelTag(lv));
}
const xpBar = (lv) => h('span', { class: 'xpbar', role: 'progressbar', 'aria-label': 'XP to the next level', 'aria-valuenow': Math.round(lv.progress * 100), '--v': lv.progress.toFixed(3) }, h('i'));
function num(n, label, cls = null) { return h('div', { class: 'num' + (cls ? ` ${cls}` : '') }, h('b', { text: String(n) }), h('small', { text: label })); }
function field(label, input, extra = null) { return h('label', { class: 'hub-field' }, h('span', { text: label }), input, extra); }
function select(label, opts, value, onChange) {
  return h('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === value ? true : null }, l)));
}
// the genres: the starter styles by family (and what was typed before, if it is not one of them)
function genreSelect(value, onChange, none) {
  const sel = h('select', { 'aria-label': 'Genre', onchange: onChange ? (e) => onChange(e.target.value) : null },
    h('option', { value: '' }, none),
    FAMILIES.map((fam, i) => h('optgroup', { label: fam }, STARTERS.filter((s) => s.fam === i).map((s) => h('option', { value: s.name, selected: s.name === value ? true : null, translate: 'no' }, s.name)))),
    h('optgroup', { label: 'More genres' }, ['Jazz', 'Classical', 'Metal', 'Funk', 'Soul', 'Reggae', 'Folk', 'Experimental', 'Soundtrack', 'Game music']
      .map((g) => h('option', { value: g, selected: g === value ? true : null }, g))),
    value && !STARTERS.some((s) => s.name === value) && !['Jazz', 'Classical', 'Metal', 'Funk', 'Soul', 'Reggae', 'Folk', 'Experimental', 'Soundtrack', 'Game music'].includes(value)
      ? h('option', { value, selected: true, translate: 'no' }, value) : null);
  return sel;
}
function reportList(list) {
  return h('ul', {}, (list || []).map((r) => h('li', {}, h('b', { text: (REASONS.find((x) => x[0] === r.reason) || [, r.reason])[1] }), ' · ', h('span', { ...NAME, text: r.name }),
    r.note ? [' · ', h('span', { ...NAME, text: r.note })] : null, r.resolved ? ' ✓' : null)));
}
function audioNote(it) {
  const n = it.audio_count;
  return n === 1 ? 'This song plays an audio file of its own that is not on the hub: it opens without it.'
    : `This song plays ${n} audio files of its own that are not on the hub: it opens without them.`;
}
function when(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString(getLang());
}
// the hub's privacy policy and terms of use (config.php privacy_url, terms_url), when it has them
function legal(signing = false) {
  const p = hubInfo?.privacy_url, tm = hubInfo?.terms_url;
  if (!p && !tm) return null;
  const a = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', text });
  return h('p', { class: 'hub-legal' }, signing ? h('span', { text: 'By signing in, you accept:' }) : null, signing ? ' ' : null,
    tm ? a(tm, 'Terms of use') : null, tm && p ? ' · ' : null, p ? a(p, 'Privacy policy') : null);
}
// "How XP works": the rules, and the ten levels of the ocean
function howXp(lv) {
  return h('details', { class: 'hub-howxp' }, h('summary', { text: 'How XP works' }),
    h('ul', {},
      h('li', { text: `Publish a song, a preset, a template or a plugin: +${XP.publish} XP (the first ${XP.publishPerDay} of each day).` }),
      h('li', { text: `Add a YouTube video of your song: +${XP.youtube} XP (once per song).` }),
      h('li', { text: `Each like on your work: +${XP.like} XP (from accounts at least an hour old; never your own).` }),
      h('li', { text: `Each download of your work: +${XP.download} XP (once per person a day, ${XP.downloadCap} XP a day at most).` }),
      h('li', { text: `Each new follower: +${XP.follower} XP.` }),
      h('li', { text: `Each like you give: +${XP.likeGiven} XP (${XP.likeGivenCap} XP a day at most).` }),
      h('li', { text: 'Taking a like (or a follow) back takes back the XP it gave.' })),
    h('div', { class: 'hub-levels' }, LEVELS.map(([min, name], i) => h('div', { class: lv && lv.level === i + 1 ? 'me' : null }, h('span', {}, `${LEVEL_ICONS[i]} `, h('span', { text: name })), h('small', { text: `${min} XP` })))));
}
