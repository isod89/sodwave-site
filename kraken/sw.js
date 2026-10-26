// SPDX-License-Identifier: GPL-3.0-only
// Kraken offline: every file of the app precached; fonts kept as they are first fetched.
const VERSION = "a0c35ee8f179";
const FILES = [
"./",
"hub.html",
"assets/apple-touch-icon.png",
"assets/icon-192.png",
"assets/icon-512.png",
"assets/icon-maskable-512.png",
"assets/kraken-icon.svg",
"assets/kraken-logo.svg",
"assets/kraken-mark.svg",
"assets/kraken-maskable.svg",
"engines/categories.json",
"engines/clipper.wasm",
"engines/sloop.wasm",
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
"js/patch.js",
"js/presets.js",
"js/project.js",
"js/render-worker.js",
"js/resample.js",
"js/sampler.js",
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
const APP = 'kraken-' + VERSION, FONTS = 'kraken-fonts';
self.addEventListener('install', (e) => {
  // from the network, never the browser's HTTP cache: a new version is installed whole, file for file
  e.waitUntil(caches.open(APP).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('kraken-') && k !== APP && k !== FONTS).map((k) => caches.delete(k))))
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
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit
    || fetch(e.request).catch(() => (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
self.addEventListener('message', (e) => { if (e.data === 'version') e.source.postMessage({ kraken: VERSION }); });
