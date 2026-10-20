'use strict';
// Minimal service worker. It lets the browser install the chat as an app and shows a friendly page
// when there is no internet.
// PRIVACY: it never stores chat data. Only the offline page and one icon are cached. It does not touch
// any other request, so messages, files and the real-time connection always go straight to the server.
const CACHE = 'hailacho-shell-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL, '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only page loads are handled. Everything else is not intercepted at all.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
