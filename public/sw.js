const CACHE_NAME = 'wazambi-cache-v1';
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutes

// Install service worker
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                return cache.addAll([
                    '/',
                    '/index.html',
                    '/message.html',
                    '/accounts.html',
                    '/secure.html',
                    '/login.html',
                    '/signup.html'
                ]);
            })
    );
});

// Activate service worker
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Keep-alive mechanism
setInterval(() => {
    fetch('/health')
        .then(response => {
            if (!response.ok) {
                throw new Error('Health check failed');
            }
        })
        .catch(error => {
            console.error('Keep-alive failed:', error);
        });
}, KEEP_ALIVE_INTERVAL);

// Fetch event handler
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                return response || fetch(event.request);
            })
    );
});

self.addEventListener('push', event => {
    const data = event.data?.json() || { title: 'New Message', body: '' };
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/notification-icon.png',
            vibrate: [200, 100, 200],
            data: { userId: data.userId }
        })
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clients => {
            if (clients.length) {
                clients[0].postMessage({
                    type: 'notificationClick',
                    userId: event.notification.data.userId
                });
                clients[0].focus();
            } else {
                clients.openWindow(`#chat/${event.notification.data.userId}`);
            }
        })
    );
});