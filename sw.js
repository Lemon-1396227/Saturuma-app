// Service Worker untuk PWA Saturuma
const CACHE_NAME = 'saturuma-cache-v6';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/user-logo.png',
  './icons/favicon.svg',
  './icons/favicon-light.png',
  './icons/favicon-dark.png',
  './icons/favicon-brutal.png'
];

// 1. Install Event: Simpan aset utama ke cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Bersihkan cache versi lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event: Stale-While-Revalidate untuk aset lokal & CDN eksternal (Tailwind, FontAwesome, Chart.js)
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Hanya proses GET request untuk http/https, abaikan request API GAS / Gemini
  if (req.method !== 'GET' || !req.url.startsWith('http') || req.url.includes('script.google.com') || req.url.includes('generativelanguage.googleapis.com')) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          // Dukung response lokal (basic) dan CDN pihak ketiga (cors)
          if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Jika offline dan navigasi halaman gagal, fallback ke index.html
          if (req.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
        });

      return cachedResponse || fetchPromise;
    })
  );
});
