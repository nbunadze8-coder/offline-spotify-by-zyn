const CACHE_NAME = 'offline-player-v6';
const FILES_TO_CACHE = [
  'offline-spotify.html',
  'manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests for our own files; let everything else (audio blobs, etc.) pass through normally.
  if (event.request.method !== 'GET') return;

  // Network-first: always try to get the latest version when online,
  // so updates show up right away. Only fall back to the cached copy
  // when there's no internet connection.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok && event.request.url.startsWith(self.location.origin)) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
