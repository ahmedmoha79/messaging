const CACHE_NAME = 'wazambi-messaging-v1.0.0';
const STATIC_CACHE = 'wazambi-static-v1.0.0';
const DYNAMIC_CACHE = 'wazambi-dynamic-v1.0.0';

// Files to cache immediately
const STATIC_ASSETS = [
  '/',
  '/message.html',
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
];

// API endpoints to cache
const API_CACHE = [
  '/api/',
  'https://twsqvdxhsfvdibhpfvqr.supabase.co'
];

// Install event - cache static assets
self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('Static assets cached successfully');
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('Failed to cache static assets:', error);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE) {
              console.log('Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('Service Worker activated');
        return self.clients.claim();
      })
  );
});

// Fetch event - serve from cache when offline
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Handle different types of requests
  if (request.destination === 'document' || request.destination === '') {
    // HTML pages - network first, fallback to cache
    event.respondWith(networkFirst(request));
  } else if (request.destination === 'script' || request.destination === 'style') {
    // Static assets - cache first, fallback to network
    event.respondWith(cacheFirst(request));
  } else if (request.destination === 'image') {
    // Images - cache first with network update
    event.respondWith(cacheFirstWithUpdate(request));
  } else if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co')) {
    // API requests - network first, cache fallback
    event.respondWith(networkFirst(request, DYNAMIC_CACHE));
  } else {
    // Default - network first
    event.respondWith(networkFirst(request));
  }
});

// Cache first strategy
async function cacheFirst(request) {
  try {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.error('Cache first strategy failed:', error);
    return new Response('Offline content not available', { status: 503 });
  }
}

// Network first strategy
async function networkFirst(request, cacheName = DYNAMIC_CACHE) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.log('Network failed, trying cache:', error);
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Return offline page for HTML requests
    if (request.destination === 'document' || request.destination === '') {
      return caches.match('/offline.html') || new Response('Offline', { status: 503 });
    }
    
    return new Response('Offline content not available', { status: 503 });
  }
}

// Cache first with background update
async function cacheFirstWithUpdate(request) {
  try {
    const cachedResponse = await caches.match(request);
    const fetchPromise = fetch(request).then(async networkResponse => {
      if (networkResponse.ok) {
        const cache = await caches.open(DYNAMIC_CACHE);
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    });
    
    return cachedResponse || fetchPromise;
  } catch (error) {
    console.error('Cache first with update failed:', error);
    return new Response('Image not available', { status: 503 });
  }
}

// Background sync for offline actions
self.addEventListener('sync', event => {
  if (event.tag === 'background-sync') {
    event.waitUntil(doBackgroundSync());
  }
});

async function doBackgroundSync() {
  try {
    // Sync any pending messages or location updates
    console.log('Performing background sync...');
    
    // Get all clients
    const clients = await self.clients.matchAll();
    
    // Notify clients about sync
    clients.forEach(client => {
      client.postMessage({
        type: 'background-sync',
        timestamp: new Date().toISOString()
      });
    });
  } catch (error) {
    console.error('Background sync failed:', error);
  }
}

// Push notification handling
self.addEventListener('push', event => {
  console.log('Push event received:', event);
  
  let notificationData = {
    title: 'WAZAMBI Messaging',
    body: 'You have a new message',
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    tag: 'message-notification',
    data: {
      url: '/message.html'
    }
  };

  // Parse push data if available
  if (event.data) {
    try {
      const data = event.data.json();
      notificationData = { ...notificationData, ...data };
    } catch (error) {
      console.error('Failed to parse push data:', error);
    }
  }

  event.waitUntil(
    self.registration.showNotification(notificationData.title, notificationData)
  );
});

// Notification click handling
self.addEventListener('notificationclick', event => {
  console.log('Notification clicked:', event);
  
  event.notification.close();
  
  event.waitUntil(
    self.clients.matchAll({ type: 'window' })
      .then(clients => {
        // If app is already open, focus it
        for (let client of clients) {
          if (client.url.includes('/message.html') && 'focus' in client) {
            return client.focus();
          }
        }
        
        // If app is not open, open it
        if (self.clients.openWindow) {
          return self.clients.openWindow('/message.html');
        }
      })
  );
});

// Message handling from main thread
self.addEventListener('message', event => {
  console.log('Service Worker received message:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});

// Periodic background sync (if supported)
if ('periodicSync' in self.registration) {
  self.addEventListener('periodicsync', event => {
    if (event.tag === 'content-sync') {
      event.waitUntil(syncContent());
    }
  });
}

async function syncContent() {
  try {
    console.log('Performing periodic content sync...');
    
    // Sync user data, messages, etc.
    const cache = await caches.open(DYNAMIC_CACHE);
    
    // You can add specific sync logic here
    // For example, prefetching recent messages or user locations
    
  } catch (error) {
    console.error('Periodic sync failed:', error);
  }
} 