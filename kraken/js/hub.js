// SPDX-License-Identifier: GPL-3.0-only
// The Kraken hub, the page's side of the API (no DOM): where the hub is, whether it is there, the session, every
// call, and what both the hub's window and the tests need to know (YouTube links, countries and their flags, levels,
// badges, the XP rules, the audio a song plays). The API itself is hub/api (PHP), on the same site as Kraken: in the
// claude.ai preview or on GitHub Pages there is none, and the hub says where it lives instead of failing.

const URL_KEY = 'kraken.hubUrl';            // the API's address, when it is not "api" beside the page (developers)
const SESSION_KEY = 'kraken.hubSession';    // { token, me } once signed in
const SITE_KEY = 'kraken.hubSite';          // the official site, when it is not OFFICIAL_SITE
// the site where the hub lives (Kraken with its hub/api): shown where there is no hub. Sam: put the site's address here
export const OFFICIAL_SITE = 'https://www.sodwave.com/kraken/';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked: for this visit only */ } },
};
export const officialSite = () => store.get(SITE_KEY) || OFFICIAL_SITE;
// the official site without its www (sodwave.com/kraken): to the www one, where the session was kept (a browser keeps a
// site's storage per exact address: signed in on one, signed out on the other)
export function toOfficialHost() {
  try {
    const o = new URL(OFFICIAL_SITE);
    if (location.hostname !== o.hostname && location.hostname === o.hostname.replace(/^www\./, '')) { location.replace(location.href.replace(location.host, o.host)); return true; }
  } catch { /* */ }
  return false;
}
export const setHubUrl = (u) => { store.set(URL_KEY, u ? String(u).trim().replace(/\/+$/, '') : null); avail = null; };
// the API's address, absolute (index.php, s.php and thumb.php are in it)
export function hubBase() {
  const b = store.get(URL_KEY) || 'api';
  try { return new URL(b.replace(/\/+$/, '') + '/', typeof location !== 'undefined' ? location.href : 'http://localhost/').href.replace(/\/$/, ''); } catch { return 'api'; }
}
export const shareUrl = (id) => `${hubBase()}/s.php?id=${encodeURIComponent(id)}`;
export const thumbUrl = (v) => `${hubBase()}/thumb.php?v=${encodeURIComponent(v)}`;
export const youtubeUrl = (v) => `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`;

// ------------------------------------------------------------------ is there a hub here? ---
let avail = null;
export let hubInfo = null;                  // what the hub said of itself (ping): its limits, its privacy policy and terms
// places with no API: a file, the claude.ai preview, GitHub Pages (unless an address was set by hand)
function noApiHere() {
  if (typeof location === 'undefined') return true;
  if (store.get(URL_KEY)) return false;
  if (!/^https?:$/.test(location.protocol)) return true;
  return /(^|\.)claudeusercontent\.com$|(^|\.)claude\.ai$|\.github\.io$/i.test(location.hostname);
}
export function available(force = false) {
  if (avail && !force) return avail;
  avail = (async () => {
    if (noApiHere()) return false;
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`${hubBase()}/index.php?r=ping`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!r.ok) return false;
      const j = await r.json();
      if (j?.hub === 'kraken') hubInfo = j;
      return j?.hub === 'kraken';
    } catch { return false; }
  })();
  return avail;
}

// ------------------------------------------------------------------ the session ---
// a session the page lost (Safari clears a site's storage after 7 days away; a home-screen app has its own) but the
// API's cookie kept: asked back once, quietly, when the API said a session is here (its kraken_hub_in flag)
export async function resumeSession() {
  if (session.token || typeof document === 'undefined' || !/(^|;\s*)kraken_hub_in=1/.test(document.cookie)) return false;
  try { const r = await call('me'); if (r.token && r.me) { session.set(r.token, r.me); return true; } } catch { /* signed out, or no hub */ }
  return false;
}
export const session = {
  get() { try { const s = JSON.parse(store.get(SESSION_KEY) || 'null'); return s && /^[a-f0-9]{64}$/.test(s.token) ? s : null; } catch { return null; } },
  get token() { return this.get()?.token || null; },
  get me() { return this.get()?.me || null; },
  set(token, me) { store.set(SESSION_KEY, JSON.stringify({ token, me })); },
  setMe(me) { const s = this.get(); if (s) this.set(s.token, me); },
  clear() { store.set(SESSION_KEY, null); },
};

// ------------------------------------------------------------------ calls ---
export class HubError extends Error {
  constructor(code, status = 0, extra = {}) { super(ERRORS[code] || ERRORS.server); this.code = code; this.status = status; Object.assign(this, extra); }
}
// what each error code says (the server only sends codes: the sentences stay in the page, in both languages)
export const ERRORS = {
  network: 'The hub cannot be reached right now. Check your connection and try again.',
  server: 'The hub had a problem. Try again in a moment.',
  database: 'The hub cannot reach its database right now. Try again in a moment.',
  not_configured: 'The hub is not set up on this site yet.',
  not_found: 'This is no longer on the hub.',
  bad_method: 'The hub did not understand that request.',
  bad_request: 'The hub did not understand that request.',
  bad_json: 'The hub did not understand that request.',
  login_required: 'Sign in to the hub first (an email is all it takes).',
  banned: 'Your hub account is suspended: you can browse and download, not publish, like or follow.',
  forbidden: 'Only the hub\'s moderators can do that.',
  rate_limited: 'Too many tries for now: wait a few minutes and try again.',
  bad_email: 'That email address does not look right.',
  mail_failed: 'The email could not be sent. Try again in a moment.',
  bad_token: 'This sign-in link has expired or was already used. If you asked for it in another window, look there: it may be signed in already. Otherwise ask for a new one.',
  bad_code: 'That is not the code of the email. Check it and type it again.',
  code_tries: 'Too many wrong codes: ask for a new email.',
  bad_name: 'Your name needs at least 2 characters.',
  bad_country: 'Pick a country from the list.',
  bad_channel: 'That is not a YouTube channel link (youtube.com/@name or youtube.com/channel/…).',
  bad_youtube: 'That is not a YouTube video link.',
  bad_kind: 'This cannot be published on the hub.',
  bad_shape: 'This cannot be published: its data is not what the hub expects.',
  too_large: 'Too large for the hub (512 KB at most).',
  bad_title: 'Give it a title.',
  duplicate: 'You already published exactly this (publicly or privately): it is on your profile.',
  hidden: 'A moderator hid it: who can see it cannot be changed for now.',
  self_like: 'You cannot like your own work (but others can!).',
  self_follow: 'You cannot follow yourself.',
  self_report: 'You cannot report your own work: delete it instead.',
  bad_reason: 'Pick a reason.',
  bad_sort: 'The hub did not understand that request.',
  bad_action: 'The hub did not understand that request.',
};
export async function call(route, { method = 'GET', body = null, query = {} } = {}) {
  const q = new URLSearchParams({ r: route });
  for (const [k, v] of Object.entries(query)) if (v !== '' && v != null && v !== false) q.set(k, String(v));
  const tok = session.token;
  let res;
  try {
    res = await fetch(`${hubBase()}/index.php?${q}`, {
      method, cache: 'no-store',
      headers: { ...(tok ? { Authorization: `Bearer ${tok}`, 'X-Kraken-Token': tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new HubError('network'); }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON: no hub here */ }
  if (!res.ok || !json || json.error) {
    const code = json?.error || (res.status === 404 ? 'not_found' : 'server');
    if (res.status === 401 && tok) session.clear();               // (the session ended: signed out here too)
    throw new HubError(code, res.status, json || {});
  }
  return json;
}
const post = (route, body) => call(route, { method: 'POST', body });
export const api = {
  items: (query) => call('items', { query }),
  item: (id) => call('item', { query: { id } }),
  data: (id, download = false) => call('data', { query: { id, dl: download ? 1 : 0 } }),
  user: (id) => call('user', { query: { id } }),
  world: () => call('world'),
  me: () => call('me'),
  saveMe: (p) => post('me', p),
  myData: () => call('my_data'),
  deleteMe: () => post('delete_me', { confirm: 'DELETE' }),
  login: (email, lang) => post('login', { email, lang }),
  exchange: (token) => post('exchange', { token }),
  loginCode: (wait, code) => post('login_code', { wait, code }),
  loginWait: (wait) => post('login_wait', { wait }),
  logout: () => post('logout', {}),
  publish: (p) => post('publish', p),
  edit: (p) => post('edit', p),
  remove: (id) => post('delete', { id }),
  like: (id, on = true) => post(on ? 'like' : 'unlike', { id }),
  follow: (user, on = true) => post(on ? 'follow' : 'unfollow', { user }),
  report: (id, reason, note) => post('report', { id, reason, note }),
  adminReports: () => call('admin_reports'),
  admin: (action, args) => post('admin', { action, ...args }),
};

// ------------------------------------------------------------------ YouTube ---
// a video link -> its 11-character id, or null (the same rules as the server's)
export function youtubeId(url) {
  const u = String(url ?? '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(u)) return u;
  const m = /^(?:https?:\/\/)?([a-z0-9.-]+)(\/\S*)?$/i.exec(u);
  if (!m) return null;
  const host = m[1].toLowerCase();
  let x;
  try { x = new URL('https://x' + (m[2] || '')); } catch { return null; }
  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = x.pathname.slice(1).split('/')[0];
  else if (/^(?:www\.|m\.|music\.)?youtube\.com$|^(?:www\.)?youtube-nocookie\.com$/.test(host)) {
    if (x.pathname === '/watch') id = x.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(x.pathname)?.[1] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
// a channel link (youtube.com/@handle, youtube.com/channel/UC…) -> its clean address, or null
export function youtubeChannel(url) {
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(@[A-Za-z0-9._-]{3,30}|channel\/UC[A-Za-z0-9_-]{22})\/?(?:[?#].*)?$/.exec(String(url ?? '').trim());
  return m ? `https://www.youtube.com/${m[1]}` : null;
}

// ------------------------------------------------------------------ countries ---
export const COUNTRIES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE '
  + 'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR '
  + 'KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI '
  + 'NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS '
  + 'ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW').split(' ');
// a flag from a country code: two regional indicator letters (🇨🇦)
export const flag = (c) => (/^[A-Z]{2}$/.test(c || '') ? String.fromCodePoint(...[...c].map((x) => 0x1f1e6 + x.charCodeAt(0) - 65)) : '');
const names = new Map();
export function countryName(c, lang = 'en') {
  if (!c) return '';
  let dn = names.get(lang);
  if (dn === undefined) { try { dn = new Intl.DisplayNames([lang], { type: 'region' }); } catch { dn = null; } names.set(lang, dn); }
  try { return dn?.of(c) || c; } catch { return c; }
}

// ------------------------------------------------------------------ levels, badges, XP ---
export const LEVELS = [[0, 'Plankton'], [100, 'Shrimp'], [300, 'Seahorse'], [700, 'Octopus'], [1500, 'Shark'], [3000, 'Orca'],
  [6000, 'Sperm whale'], [12000, 'Leviathan'], [25000, 'Kraken'], [50000, 'Legendary Kraken']];
export const LEVEL_ICONS = ['💧', '🦐', '🐠', '🐙', '🦈', '🐋', '🐳', '🌊', '🦑', '👑'];
export function levelOf(xp) {
  let i = 0;
  LEVELS.forEach(([min], k) => { if (xp >= min) i = k; });
  const floor = LEVELS[i][0], next = LEVELS[i + 1]?.[0] ?? null;
  return { level: i + 1, name: LEVELS[i][1], xp, floor, next, progress: next == null ? 1 : (xp - floor) / (next - floor) };
}
export const BADGES = {
  first_song: ['♪', 'First song', 'Published a first song'],
  first_plugin: ['◈', 'First plugin', 'Published a first plugin'],
  likes_10: ['♥', '10 likes', 'Ten likes on your work'],
  likes_100: ['❤', '100 likes', 'A hundred likes on your work'],
  countries_10: ['🌍', 'Liked in 10 countries', 'People in ten countries liked your work'],
  followers_10: ['★', '10 followers', 'Ten people follow you'],
};
// the rules (the server applies the same: hub/api/lib.php)
export const XP = { publish: 50, publishPerDay: 3, youtube: 20, youtubePerDay: 3, like: 10, download: 2, downloadCap: 100, likeGiven: 1, likeGivenCap: 20, follower: 5 };

// ------------------------------------------------------------------ what is published ---
export const MAX_DATA = 524288;
// the audio files a song (or a preset) plays: their ids, found anywhere in it. The files themselves are never
// published; gen-…: the sounds Kraken makes by itself (gensounds.js), the same everywhere
export function audioIds(x, out = new Set(), depth = 0) {
  if (depth > 40 || !x || typeof x !== 'object') return out;
  for (const [k, v] of Object.entries(x)) {
    if ((k === 'src' || k === 'orig') && typeof v === 'string' && v && !v.startsWith('gen-')) out.add(v);
    else if (v && typeof v === 'object') audioIds(v, out, depth + 1);
  }
  return out;
}
export const KIND_ICONS = { song: '♪', preset: '⧉', plugin: '◈', template: '▤' };
