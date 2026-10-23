// SPDX-License-Identifier: GPL-3.0-only
// Kraken offline: every file of the app precached; fonts kept as they are first fetched.
const VERSION = "b10b0edd63e2";
const FILES = [
"./",
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
"js/control.js",
"js/engine-core.js",
"js/fx.js",
"js/input.js",
"js/io.js",
"js/main.js",
"js/project.js",
"js/ui/arrange.js",
"js/ui/controllers.js",
"js/ui/device.js",
"js/ui/editor.js",
"js/ui/instruments.js",
"js/ui/keys.js",
"js/ui/kit.js",
"js/ui/library.js",
"js/ui/mixer.js",
"js/ui/palette.js",
"js/ui/session.js",
"js/wav.js",
"js/worklet.js",
"manifest.webmanifest"
];
const APP = 'kraken-' + VERSION, FONTS = 'kraken-fonts';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('kraken-') && k !== APP && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
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
