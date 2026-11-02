'use strict';
// Minimal service worker. It lets the browser install the chat as an app and shows a friendly page
// when there is no internet.
// PRIVACY: it never stores chat data. Only the offline page and one icon are cached. It does not touch
// any other request, so messages, files and the real-time connection always go straight to the server.
const CACHE = 'hailacho-shell-v2';
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

// ============================================================
// ALERTS when the app is closed or in the background (Web Push)
// ============================================================
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // The app is open and in front of the person: it shows its own alert, so stay quiet here.
      if (windows.some((c) => c.visibilityState === 'visible' && c.focused)) return;

      const ringing = data.type === 'call';
      await self.registration.showNotification(String(data.title || 'New message').slice(0, 80), {
        body: String(data.body || '').slice(0, 200),
        tag: String(data.tag || 'chat'), // a newer alert with the same tag replaces the old one
        renotify: true,
        requireInteraction: ringing,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: {
          type: String(data.type || 'message'),
          url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/',
          conversationId: String(data.conversationId || ''),
          callId: String(data.callId || '')
        }
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'notification-click', conversationId: d.conversationId, callId: d.callId });
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(d.url || '/');
    })()
  );
});

// The browser changed this device's registration: ask the open page to register again
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => windows.forEach((c) => c.postMessage({ type: 'push-resubscribe' })))
  );
});