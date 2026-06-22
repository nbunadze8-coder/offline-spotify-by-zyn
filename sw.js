/**
 * MusiCloud — sw.js
 * Service Worker: offline caching of the app shell.
 *
 * STRATEGY:
 *  - App shell (HTML, CSS, JS, manifest, icons) → Cache First
 *  - CDN libraries (JSZip, jsmediatags) → Cache First (cached on first load)
 *  - Audio data → served directly from IndexedDB by app.js (NOT the SW cache,
 *    because audio files can be hundreds of MB and exceed SW cache quotas)
 *  - Everything else → Network First with cache fallback
 *
 * WHAT'S CACHED (what makes the app work with zero network):
 *  ✓ index.html
 *  ✓ style.css
 *  ✓ app.js
 *  ✓ manifest.json
 *  ✓ icons/icon-192.png, icons/icon-512.png
 *  ✓ jszip.min.js (CDN — cached on first visit)
 *  ✓ jsmediatags.min.js (CDN — cached on first visit)
 *
 * Audio binary data is stored in IndexedDB by the app, not here.
 */

const CACHE_NAME = 'musicloud-v1';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// CDN resources to cache on first fetch (stale-while-revalidate not needed
// since these are versioned URLs that never change)
const CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js',
];

/* ── INSTALL: pre-cache the app shell ── */
self.addEventListener('install', event => {
  console.log('[SW] Installing…');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching app shell:', APP_SHELL);
      // Cache app shell eagerly; CDN resources will be cached on first fetch
      return cache.addAll(APP_SHELL).catch(err => {
        // Log but don't fail install if a shell resource is missing
        // (important during local dev where icons might not exist yet)
        console.warn('[SW] Some shell resources could not be cached:', err);
      });
    }).then(() => self.skipWaiting()) // Activate immediately
  );
});

/* ── ACTIVATE: clean up old caches ── */
self.addEventListener('activate', event => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim()) // Take control of all pages immediately
  );
});

/* ── FETCH: Cache-First for shell/CDN, Network-First otherwise ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET requests and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.startsWith('chrome-extension://')) return;

  // Skip blob: and data: URLs (object URLs from IndexedDB audio)
  if (url.startsWith('blob:') || url.startsWith('data:')) return;

  // Skip range requests (audio scrubbing) — let the browser handle those natively
  if (request.headers.get('range')) return;

  const isCDN = CDN_URLS.some(cdn => url.startsWith(cdn));
  const isShell = APP_SHELL.some(path => {
    // Match both root-relative and absolute
    try {
      const shellUrl = new URL(path, self.location.href).href;
      return url === shellUrl || url.endsWith(path);
    } catch { return false; }
  });

  if (isShell || isCDN) {
    // Cache-First strategy
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        // Not cached yet (CDN resources on first load) — fetch and cache
        return fetch(request).then(response => {
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
          return response;
        }).catch(() => {
          // Completely offline and not cached — return a minimal offline page
          // only for the HTML shell
          if (request.destination === 'document') {
            return caches.match('./index.html');
          }
        });
      })
    );
    return;
  }

  // Network-First for everything else
  event.respondWith(
    fetch(request).then(response => {
      if (!response || response.status !== 200 || response.type === 'error') {
        return response;
      }
      // Don't cache audio files — they're managed by IndexedDB
      if (response.headers.get('content-type')?.includes('audio')) {
        return response;
      }
      const responseToCache = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
      return response;
    }).catch(() => {
      // Offline fallback
      return caches.match(request);
    })
  );
});

/* ── BACKGROUND SYNC (future enhancement placeholder) ── */
// If you ever add a backend, use Background Sync to queue actions here.

console.log('[SW] Service Worker script loaded');
