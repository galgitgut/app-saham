// Service worker sederhana: app tetap terbuka walau sinyal jelek.
// Strategi "network first": selalu coba versi terbaru, kalau gagal pakai salinan terakhir.
const CACHE = 'binar-saujana-shell-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // hanya file app sendiri; data GitHub ditangani oleh github.js
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
