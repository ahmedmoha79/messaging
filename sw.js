const STATIC_CACHE = 'wazambi-static-v2';
const RUNTIME_CACHE = 'wazambi-runtime-v2';
const OFFLINE_URL = '/offline.html';

const STATIC_ASSETS = [
  '/',
  '/login.html',
  '/signup.html',
  '/message.html',
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/public/notification-icon.png',
  OFFLINE_URL,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![STATIC_CACHE, RUNTIME_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isNavigationRequest(request) {
  return request.mode === 'navigate' || request.destination === 'document';
}

function isCacheableGet(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (request.headers.has('authorization')) return false;
  return true;
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && isCacheableGet(request)) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (isNavigationRequest(request)) {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok && isCacheableGet(request)) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || networkFetch || new Response('Offline', { status: 503, statusText: 'Offline' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  if (!isCacheableGet(request)) {
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  const isAsset = ['style', 'script', 'image', 'font'].includes(request.destination);
  event.respondWith(isAsset ? staleWhileRevalidate(request) : networkFirst(request));
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'WAZAMBI Messaging',
    body: 'You have a new message',
    icon: '/icon-192x192.png',
    badge: '/public/notification-icon.png',
    tag: 'message-notification',
  };

  try {
    const data = event.data?.json();
    if (data && typeof data === 'object') {
      payload = { ...payload, ...data };
    }
  } catch (_error) {
    // keep default payload
  }

  event.waitUntil(self.registration.showNotification(payload.title, payload));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/message.html'));
});
