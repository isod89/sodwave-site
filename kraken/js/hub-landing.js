// SPDX-License-Identifier: GPL-3.0-only
// The hub's front page (hub.html, www.sodwave.com/hub) for someone not signed in: what the hub is, why join, what is
// trending, how it works, and joining in one field (an email: the sign-in link). Real numbers only, and only once
// there are enough of them; nothing made up. "Explore" opens the hub itself (ui/hub.js).
import { h } from './ui/kit.js';
import { api, ERRORS, LEVELS, LEVEL_ICONS, levelOf, flag, KIND_ICONS, thumbUrl } from './hub.js';
import { getLang } from './i18n.js';
import { cover } from './hub-art.js';

const KIND = { song: 'Song', preset: 'Preset', plugin: 'Plugin', template: 'Template' };
const art = (seed, kind) => { const el = h('span', { class: 'lp-art', 'aria-hidden': 'true' }); el.innerHTML = cover(seed, kind); return el; };

// one field and a button: the sign-in link by email
function joinForm(id) {
  const email = h('input', { type: 'email', id, required: true, placeholder: 'your@email.com', autocomplete: 'email', 'aria-label': 'Your email', spellcheck: 'false' });
  const msg = h('p', { class: 'lp-msg', role: 'status' });
  const btn = h('button', { class: 'lp-btn go', type: 'submit' }, 'JOIN FREE');
  const form = h('form', { class: 'lp-join', novalidate: true }, h('div', { class: 'lp-field' }, email, btn), msg,
    h('p', { class: 'lp-fine', text: 'No password, no spam: we email you a link to sign in.' }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { msg.className = 'lp-msg bad'; msg.textContent = 'Type your email first.'; email.focus(); return; }
    btn.disabled = true; msg.className = 'lp-msg'; msg.textContent = 'Sending…';
    try {
      await api.login(v, getLang());
      msg.className = 'lp-msg ok'; msg.textContent = 'Check your inbox: your sign-in link is on its way (valid 15 minutes). Nothing there? Look in the spam folder.';
      email.value = '';
    } catch (err) { msg.className = 'lp-msg bad'; msg.textContent = err?.message || ERRORS.server; }
    btn.disabled = false;
  });
  email.addEventListener('keydown', (e) => e.stopPropagation());
  return form;
}

function itemCard(it, open) {
  const lv = levelOf(it.user?.level?.xp ?? 0);
  return h('button', { class: 'lp-card', onclick: () => open({ item: it.id }) },
    h('span', { class: 'lp-thumb' }, it.youtube ? h('img', { src: thumbUrl(it.youtube), alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : art(`${it.id}${it.title}`, it.kind),
      h('span', { class: 'lp-kind', text: `${KIND_ICONS[it.kind] || '♪'} ${KIND[it.kind] || ''}` })),
    h('span', { class: 'lp-ct', translate: 'no', text: it.title }),
    h('span', { class: 'lp-by' }, it.user?.country ? h('span', { text: flag(it.user.country) }) : null, h('span', { translate: 'no', text: it.user?.name || '' }), h('em', { text: `LV ${lv.level} ${LEVEL_ICONS[lv.level - 1]}` })),
    h('span', { class: 'lp-st' }, `♥ ${it.likes}`, h('span', { text: `⬇ ${it.downloads}` })));
}

export function landing({ open, openKraken }) {
  const showcase = h('div', { class: 'lp-show', 'aria-hidden': 'true' },
    h('div', { class: 'lp-float a' }, art('hero-song', 'song'), h('b', { text: '♪ YOUR SONG' }), h('span', { text: '♥ LIKES  ·  🌍 WORLD' })),
    h('div', { class: 'lp-float b' }, art('hero-plugin', 'plugin'), h('b', { text: '◈ YOUR PLUGIN' }), h('span', { text: 'OPEN IN THE LAB' })),
    h('div', { class: 'lp-float c' }, h('div', { class: 'lp-lvl' }, h('i', { text: '🐙' }), h('div', {}, h('b', { text: 'LV 4 · OCTOPUS' }), h('div', { class: 'lp-bar' }, h('span', {})), h('small', { text: '+50 XP · NEW BADGE: FIRST SONG' })))));
  const stats = h('div', { class: 'lp-stats', hidden: true });
  const trending = h('section', { class: 'lp-sec', hidden: true }, h('div', { class: 'lp-head' }, h('h2', { text: 'Trending now' }), h('button', { class: 'lp-link', onclick: () => open('discover') }, 'See everything →')), h('div', { class: 'lp-grid' }));
  const features = [
    ['♥', 'Get heard', 'Likes, followers and downloads from people everywhere. Watch your music travel on the WORLD map.'],
    ['⬆', 'Level up', 'Every song you publish, every like and download earns XP. Ten levels from Plankton to Legendary Kraken, and badges along the way.'],
    ['◈', 'Share your plugins', 'Build instruments and effects in the LAB, with the real SLOOP and Clipper engines, and let anyone play them.'],
    ['⧉', 'Remix and learn', 'Open any song in Kraken and any plugin in the LAB: see exactly how it was made, then make it yours.'],
  ];
  const ladder = h('div', { class: 'lp-ladder' }, LEVELS.map(([xp, name], i) => h('div', { class: 'lp-rung', style: { '--i': i } }, h('i', { text: LEVEL_ICONS[i] }), h('b', { text: name }), h('small', { text: `${xp.toLocaleString('en')} XP` }))));
  const page = h('div', { class: 'lp' },
    h('div', { class: 'lp-waves', 'aria-hidden': 'true' }),
    h('header', { class: 'lp-hero' },
      h('div', { class: 'lp-copy' },
        h('p', { class: 'lp-eye', text: 'THE KRAKEN HUB' }),
        h('h1', {}, h('span', { text: 'Make it in Kraken.' }), h('span', { class: 'grad', text: 'Share it with the world.' })),
        h('p', { class: 'lp-lead', text: 'The hub is where songs, presets and plugins made with Kraken find their people. Publish in one click, collect likes from every country, and climb from Plankton to Legendary Kraken.' }),
        joinForm('lp-email-1'),
        h('div', { class: 'lp-alt' }, h('button', { class: 'lp-link', onclick: () => open('discover') }, 'Explore without an account →'),
          h('span', { text: '·' }), h('button', { class: 'lp-link', onclick: openKraken }, 'Open Kraken, the free DAW'))),
      showcase),
    stats,
    trending,
    h('section', { class: 'lp-sec' }, h('h2', { text: 'Why share on the hub' }),
      h('div', { class: 'lp-feats' }, features.map(([ic, t, d]) => h('div', { class: 'lp-feat' }, h('i', { text: ic }), h('h3', { text: t }), h('p', { text: d }))))),
    h('section', { class: 'lp-sec' }, h('h2', { text: 'From Plankton to Legendary Kraken' }),
      h('p', { class: 'lp-sub', text: '+50 XP for each thing you publish, +10 for each like, +2 for each download, +5 for each follower.' }), ladder),
    h('section', { class: 'lp-sec', id: 'how' }, h('h2', { text: 'How it works' }),
      h('div', { class: 'lp-steps' },
        h('div', { class: 'lp-step' }, h('b', { text: '1' }), h('h3', { text: 'Make' }), h('p', { text: 'Kraken is a free DAW in your browser, with the real SLOOP and Clipper engines. Nothing to install.' }),
          h('button', { class: 'lp-btn', onclick: openKraken }, 'OPEN KRAKEN')),
        h('div', { class: 'lp-step' }, h('b', { text: '2' }), h('h3', { text: 'Publish' }), h('p', { text: 'One click on ☁ PUBLISH, in Kraken or in the LAB. Your song plays for everyone, right in their browser.' })),
        h('div', { class: 'lp-step' }, h('b', { text: '3' }), h('h3', { text: 'Grow' }), h('p', { text: 'Likes, followers, downloads, XP and badges: your profile shows it all, and the world map shows where you are heard.' })))),
    h('section', { class: 'lp-cta' }, h('h2', { text: 'Ready to share your sound?' }), h('p', { text: 'Free. No password. Your email is never shown to anyone.' }), joinForm('lp-email-2')),
    h('footer', { class: 'lp-foot' }, h('span', { translate: 'no', text: 'Kraken · Sodwave' }),
      h('a', { href: './', text: 'Kraken' }), h('a', { href: './?lab', text: 'LAB' }), h('a', { href: 'https://www.sodwave.com/', translate: 'no', text: 'sodwave.com' }),
      h('span', { text: 'Free and open source (GPL-3.0)' })));
  // the real numbers and what is trending, when the hub answers
  (async () => {
    try {
      const w = await api.world(), t = w.total || {};
      if ((t.items || 0) >= 20) {
        stats.replaceChildren(...[[t.creators, 'creators'], [t.items, 'songs, presets and plugins'], [t.countries, 'countries']].map(([n, l]) => h('div', {}, h('b', { text: Number(n || 0).toLocaleString('en') }), h('span', { text: l }))));
      } else stats.replaceChildren(h('p', { text: 'The hub just opened: publish now and be one of its very first creators.' }));
      stats.hidden = false;
    } catch { /* (no hub here: the page still explains it) */ }
    try {
      const r = await api.items({ sort: 'trending' });
      const list = (r.items || []).slice(0, 8);
      if (list.length) { trending.querySelector('.lp-grid').replaceChildren(...list.map((it) => itemCard(it, open))); trending.hidden = false; }
    } catch { /* */ }
  })();
  return page;
}
