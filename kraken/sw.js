// SPDX-License-Identifier: GPL-3.0-only
// Kraken offline: every file of the app precached; fonts kept as they are first fetched.
const VERSION = "893784fb9045";
const FILES = [
"./",
"assets/apple-touch-icon.png",
"assets/fonts/TwemojiCountryFlags-LICENSE.txt",
"assets/fonts/TwemojiCountryFlags.woff2",
"assets/icon-192.png",
"assets/icon-512.png",
"assets/icon-maskable-512.png",
"assets/kraken-icon-clear.svg",
"assets/kraken-icon.svg",
"assets/kraken-logo.svg",
"assets/kraken-mark.svg",
"assets/kraken-maskable.svg",
"engines/categories.json",
"engines/clipper.wasm",
"engines/packs/index.json",
"engines/sloop.wasm",
"hub.html",
"js/assets.js",
"js/audio.js",
"js/audio2midi.js",
"js/collab.js",
"js/comp.js",
"js/control.js",
"js/dawproject.js",
"js/edit.js",
"js/engine-core.js",
"js/flac.js",
"js/fx.js",
"js/gensounds.js",
"js/hub-art.js",
"js/hub-landing.js",
"js/hub-page.js",
"js/hub.js",
"js/i18n.js",
"js/i18n/fr-hub.js",
"js/i18n/fr.js",
"js/input.js",
"js/io.js",
"js/lab-dsp.js",
"js/lab-modules.js",
"js/lab-presets.js",
"js/launchpad.js",
"js/levels.js",
"js/main.js",
"js/mc-worker.js",
"js/meter.js",
"js/mods.js",
"js/mp3-worker.js",
"js/mp3.js",
"js/multicore-core.js",
"js/multicore.js",
"js/notefx.js",
"js/opus.js",
"js/packs.js",
"js/patch.js",
"js/presets.js",
"js/project.js",
"js/render-worker.js",
"js/resample.js",
"js/sampler.js",
"js/sloop-pro.js",
"js/sloopsong.js",
"js/templates.js",
"js/ui/arrange.js",
"js/ui/autorec.js",
"js/ui/collab.js",
"js/ui/controllers.js",
"js/ui/device.js",
"js/ui/diagnostic.js",
"js/ui/drums.js",
"js/ui/editor.js",
"js/ui/hub-style.js",
"js/ui/hub.js",
"js/ui/instruments.js",
"js/ui/keys.js",
"js/ui/kit.js",
"js/ui/lab.js",
"js/ui/library.js",
"js/ui/macros.js",
"js/ui/meters.js",
"js/ui/mixer.js",
"js/ui/mods.js",
"js/ui/notes.js",
"js/ui/packs.js",
"js/ui/palette.js",
"js/ui/presets.js",
"js/ui/report.js",
"js/ui/samples.js",
"js/ui/session.js",
"js/ui/wam.js",
"js/ui/welcome.js",
"js/vault.js",
"js/vendor/LAME-README.txt",
"js/vendor/LGPL-3.0.txt",
"js/vendor/lame.js",
"js/vendor/wam-env.js",
"js/wam-host.js",
"js/wam.js",
"js/warp-worker.js",
"js/warp.js",
"js/wav.js",
"js/worklet.js",
"js/xml.js",
"manifest.webmanifest"
];
const APP = 'kraken-' + VERSION, FONTS = 'kraken-fonts', PACKS = 'kraken-packs';
const HASHES = {
"./": "d5acad26713ac6e2",
"assets/apple-touch-icon.png": "f17f300d7095555f",
"assets/fonts/TwemojiCountryFlags-LICENSE.txt": "e42b16deeb80d8cc",
"assets/fonts/TwemojiCountryFlags.woff2": "9f04f14429bb6a9f",
"assets/icon-192.png": "eac7183445a6cc25",
"assets/icon-512.png": "6537a0849702f146",
"assets/icon-maskable-512.png": "c1eaa709f7a2e0b6",
"assets/kraken-icon-clear.svg": "2c8d943df005b48d",
"assets/kraken-icon.svg": "d5735ad5996e57da",
"assets/kraken-logo.svg": "127b909a5dd98907",
"assets/kraken-mark.svg": "2c8d943df005b48d",
"assets/kraken-maskable.svg": "4a8c13b887de9673",
"engines/categories.json": "0910c5df4892b672",
"engines/clipper.wasm": "484fb761c60eccde",
"engines/packs/index.json": "42b0035b4f3e7a9a",
"engines/sloop.wasm": "6cca862ab545b47e",
"hub.html": "2325b2593d830ab0",
"js/assets.js": "f9e37a5394c1996b",
"js/audio.js": "ecbc049bb3588eb6",
"js/audio2midi.js": "ae1895a605a204d7",
"js/collab.js": "7217a50198513312",
"js/comp.js": "6159f03c88e913b4",
"js/control.js": "41dad04e52674613",
"js/dawproject.js": "a0d34f88063ae8a0",
"js/edit.js": "68fd30c2cb6a142b",
"js/engine-core.js": "78ed44a64cc06d99",
"js/flac.js": "9265927064076ede",
"js/fx.js": "3ebaf56086d6a61e",
"js/gensounds.js": "153bcb24ffacd831",
"js/hub-art.js": "306bdd6cc9c5985a",
"js/hub-landing.js": "314b1cac1e2ee08e",
"js/hub-page.js": "58f207dc0cb8c686",
"js/hub.js": "ae16cb9d424d794a",
"js/i18n.js": "5d26939e61333792",
"js/i18n/fr-hub.js": "572a106d9ea51007",
"js/i18n/fr.js": "8664369646c8bbb3",
"js/input.js": "6380044ba9c51bc4",
"js/io.js": "8dab5b01b2a1f361",
"js/lab-dsp.js": "0595d240c21578c7",
"js/lab-modules.js": "3a34c940ad28abe2",
"js/lab-presets.js": "bf8748f1a560c9ea",
"js/launchpad.js": "62d81134fffdfba7",
"js/levels.js": "bef2d9abe9e589f0",
"js/main.js": "ea5e9feeaa22208d",
"js/mc-worker.js": "880ea63a24ec78da",
"js/meter.js": "6cf9580d1d704557",
"js/mods.js": "8445d16b87bf54ba",
"js/mp3-worker.js": "ed4ae9e5fcd36a0b",
"js/mp3.js": "81a1d8e74cd1741a",
"js/multicore-core.js": "859c4cf17f3f16fc",
"js/multicore.js": "71d64b0c05169671",
"js/notefx.js": "dcb7f4536dc65cf9",
"js/opus.js": "f80039368247154c",
"js/packs.js": "0d48f38dc813add1",
"js/patch.js": "aa95ddf8ae05a0c6",
"js/presets.js": "0d5aa18dc1c00f2b",
"js/project.js": "537aff8020ef8a6a",
"js/render-worker.js": "dc9447f816d1b065",
"js/resample.js": "b69a5b0ce1845725",
"js/sampler.js": "a91263950e2d49c4",
"js/sloop-pro.js": "262bbc42a932bd51",
"js/sloopsong.js": "fbb95974e5f385b7",
"js/templates.js": "0c16d3a949ef166d",
"js/ui/arrange.js": "b8bf536df63e9c99",
"js/ui/autorec.js": "1fed4390fecc57c7",
"js/ui/collab.js": "d6b2a58b2b8b1e75",
"js/ui/controllers.js": "bb826709a78a3ab3",
"js/ui/device.js": "8d519c1e0cb3a474",
"js/ui/diagnostic.js": "21143415ef690999",
"js/ui/drums.js": "5e0e3428bcd91b19",
"js/ui/editor.js": "5be1ac8c21636f43",
"js/ui/hub-style.js": "a87d1153c68b1630",
"js/ui/hub.js": "4316ee9f65408c37",
"js/ui/instruments.js": "ff60f41d86a6c41b",
"js/ui/keys.js": "778e6068734f0ffd",
"js/ui/kit.js": "d47103e4cd83f192",
"js/ui/lab.js": "58d8853fcd0767dd",
"js/ui/library.js": "27f9cc3061de4b5d",
"js/ui/macros.js": "f01c46916cde13c0",
"js/ui/meters.js": "6dc09c6b7f47b622",
"js/ui/mixer.js": "a1b3536084cc913f",
"js/ui/mods.js": "506552f13ad7383b",
"js/ui/notes.js": "6cecc51afbf2cafd",
"js/ui/packs.js": "b440d350e6511c7c",
"js/ui/palette.js": "a62f9a34e41a6ef5",
"js/ui/presets.js": "890a430f5b7c4413",
"js/ui/report.js": "6632758d92621165",
"js/ui/samples.js": "63b1fffbc3a02aff",
"js/ui/session.js": "df61420498bf69e3",
"js/ui/wam.js": "11a6217a1fc0f50d",
"js/ui/welcome.js": "62ba7ffd78e12b7d",
"js/vault.js": "4e0620a7f22cdb52",
"js/vendor/LAME-README.txt": "cd144ca132e3842b",
"js/vendor/LGPL-3.0.txt": "e3a994d82e644b03",
"js/vendor/lame.js": "f7c0e95f6e622a34",
"js/vendor/wam-env.js": "7bda0bcc316830d1",
"js/wam-host.js": "a7eabe72ca41753b",
"js/wam.js": "35402a6ff3498f5b",
"js/warp-worker.js": "fb095476020d677c",
"js/warp.js": "0e2e6e8534064572",
"js/wav.js": "36de3ed6a971da0c",
"js/worklet.js": "f0bd6b893d31f3c1",
"js/xml.js": "a4bd65e8f9c398bc",
"manifest.webmanifest": "3474b89513641e72"
};                                                 // (filled at the build)
// a file as this version has it: the first 16 hex digits of its SHA-256 (written at the build). A site is uploaded file
// by file: a visit in the middle could get the new sw.js and an old page; a file that does not match is fetched again,
// and if it still does not, this version is not installed now (the one in place keeps working; the next visit tries again)
const HEX = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
async function fetchChecked(f) {
  for (let i = 0; ; i++) {
    const r = await fetch(new Request(f, { cache: 'reload' }));
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    const buf = await r.arrayBuffer(), want = HASHES[f];
    if (!want || HEX(await crypto.subtle.digest('SHA-256', buf)) === want) return new Response(buf, { status: r.status, statusText: r.statusText, headers: r.headers });
    if (i >= 2) throw new Error(`${f}: not this version yet`);
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}
self.addEventListener('install', (e) => {
  // from the network, never the browser's HTTP cache: a new version is installed whole, file for file, checked
  e.waitUntil((async () => {
    const got = await Promise.all(FILES.map(async (f) => [f, await fetchChecked(f)]));
    const c = await caches.open(APP);
    await Promise.all(got.map(([f, r]) => c.put(new Request(f), r)));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('kraken-') && k !== APP && k !== FONTS && k !== PACKS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.includes('/api/')) return;   // the hub's API: always the network
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then((r) => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // a community engine (engines/packs/NAME-HASH.wasm): kept once played (its name changes with its bytes), not precached
  if (/\/engines\/packs\/[a-z0-9-]+\.wasm$/.test(url.pathname)) {
    e.respondWith(caches.open(PACKS).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit
    || fetch(e.request).catch(() => (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
self.addEventListener('message', (e) => { if (e.data === 'version') e.source.postMessage({ kraken: VERSION }); });
