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