const CACHE_NAME = 'wazambi-cache-v1';
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutes
const NOTIFICATION_QUEUE = 'notification-queue';

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
                    '/signup.html',
                    '/notification.mp3'
                ]);
            })
    );
    self.skipWaiting();
});

// Activate service worker
self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== CACHE_NAME) {
                            return caches.delete(cacheName);
                        }
                    })
                );
            }),
            self.clients.claim()
        ])
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

// Background sync for notifications
self.addEventListener('sync', event => {
    if (event.tag === 'notification-sync') {
        event.waitUntil(processNotificationQueue());
    }
});

async function processNotificationQueue() {
    const queue = await getNotificationQueue();
    for (const notification of queue) {
        await showNotification(notification);
    }
    await clearNotificationQueue();
}

async function getNotificationQueue() {
    const cache = await caches.open(NOTIFICATION_QUEUE);
    const response = await cache.match('queue');
    return response ? await response.json() : [];
}

async function clearNotificationQueue() {
    const cache = await caches.open(NOTIFICATION_QUEUE);
    await cache.delete('queue');
}

// Enhanced push notification handling
self.addEventListener('push', event => {
    const data = event.data?.json() || { title: 'New Message', body: '' };
    
    // Store notification in queue if app is not active
    event.waitUntil(
        Promise.all([
            showNotification(data),
            storeNotificationInQueue(data)
        ])
    );
});

async function storeNotificationInQueue(notification) {
    const queue = await getNotificationQueue();
    queue.push(notification);
    const cache = await caches.open(NOTIFICATION_QUEUE);
    await cache.put('queue', new Response(JSON.stringify(queue)));
}

async function showNotification(data) {
    const options = {
        body: data.body,
        icon: '/notification-icon.png',
        badge: '/notification-icon.png',
        vibrate: [200, 100, 200],
        data: { 
            userId: data.userId,
            messageId: data.messageId,
            type: data.type
        },
        requireInteraction: true,
        actions: [
            {
                action: 'open',
                title: 'Open Chat'
            },
            {
                action: 'dismiss',
                title: 'Dismiss'
            }
        ]
    };

    // Play notification sound
    const audio = new Audio('/notification.mp3');
    audio.volume = 0.7;
    await audio.play().catch(e => console.warn('Sound play failed:', e));

    return self.registration.showNotification(data.title, options);
}

// Enhanced notification click handling
self.addEventListener('notificationclick', event => {
    event.notification.close();
    
    const { userId, messageId } = event.notification.data;
    
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clients => {
            if (clients.length) {
                const client = clients[0];
                client.postMessage({
                    type: 'notificationClick',
                    userId,
                    messageId
                });
                client.focus();
            } else {
                clients.openWindow(`/message.html#chat/${userId}`);
            }
        })
    );
});

// Handle notification actions
self.addEventListener('notificationclose', event => {
    const { messageId } = event.notification.data;
    if (messageId) {
        // Mark message as read if dismissed
        event.waitUntil(
            fetch(`/api/messages/${messageId}/read`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            }).catch(e => console.error('Failed to mark message as read:', e))
        );
    }
});

// Fetch event handler with network-first strategy
self.addEventListener('fetch', (event) => {
    if (event.request.url.includes('/api/')) {
        // API requests use network-first strategy
        event.respondWith(
            fetch(event.request)
                .catch(() => caches.match(event.request))
        );
    } else {
        // Static assets use cache-first strategy
        event.respondWith(
            caches.match(event.request)
                .then((response) => {
                    return response || fetch(event.request);
                })
        );
    }
});

// Add message event listener for notifications
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'showNotification') {
        const { data } = event.data;
        event.waitUntil(
            showNotification({
                title: data.title,
                body: data.body,
                icon: data.icon,
                userId: data.userId,
                messageId: data.messageId
            })
        );
    }
});