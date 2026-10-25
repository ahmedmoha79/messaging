/* WAZAMBI service worker
 * - Opens instantly on repeat visits: the app shell is served from cache
 *   and refreshed in the background.
 * - Never caches Supabase traffic or our /api routes (always live data).
 * - Focuses the right chat when a notification is clicked.
 * The server stamps the deploy version below, so every deploy installs fresh.
 */
const VERSION = '__APP_VERSION__';
const SHELL_CACHE = `wazambi-shell-${VERSION}`;
const ASSET_CACHE = `wazambi-assets-${VERSION}`;

const SHELL = [
  '/app',
  '/',
  '/config.js',
  '/vendor/supabase.js',
  '/css/base.css',
  '/css/app.css',
  '/css/auth.css',
  '/js/lib/supabase.js',
  '/js/lib/dom.js',
  '/js/lib/icons.js',
  '/js/lib/format.js',
  '/js/lib/bytes.js',
  '/js/lib/mediaAccess.js',
  '/js/auth-page.js',
  '/js/app/main.js',
  '/js/app/state.js',
  '/js/app/data.js',
  '/js/app/ui.js',
  '/js/app/router.js',
  '/js/app/realtime.js',
  '/js/app/notify.js',
  '/js/app/chatList.js',
  '/js/app/conversation.js',
  '/js/app/media.js',
  '/js/app/voice.js',
  '/js/app/calls.js',
  '/js/app/groups.js',
  '/js/app/profile.js',
  '/js/app/settings.js',
  '/js/app/map.js',
  '/js/app/push.js',
  '/js/app/jobs.js',
  '/js/app/org.js',
  '/js/lib/jobStatus.js',
  '/icons/icon-192.png',
  '/sounds/notification.mp3',
  '/manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => null))))
      // Take over right away: the previous app version's worker served scripts
      // cache-first, which would otherwise pin old code until every tab closes.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('wazambi-') && !keep.has(n)).map(n => caches.delete(n)));
    // Older app versions registered caches with other names; clear those too.
    await Promise.all(names.filter(n => /^(static|dynamic|messaging|logistics)/i.test(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, tiles, etc. go straight to the network
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/sw.js') return;
  // customer tracking links and invite redirects always come from the network
  if (url.pathname.startsWith('/t/') || url.pathname.startsWith('/join/')) return;

  // Pages and runtime config: network first so deploys show up, cache as fallback for offline.
  if (req.mode === 'navigate' || url.pathname === '/config.js') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req.mode === 'navigate' ? new Request(url.pathname) : req, fresh.clone());
        }
        return fresh;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(url.pathname)) ||
          (await cache.match(req)) ||
          (url.pathname.startsWith('/app') ? cache.match('/app') : cache.match('/')) ||
          new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Static assets: serve from cache immediately, refresh in the background.
  event.respondWith((async () => {
    const shell = await caches.open(SHELL_CACHE);
    const cached = (await shell.match(req, { ignoreSearch: true })) || (await caches.match(req));
    const network = fetch(req).then(async res => {
      if (res.ok && res.type === 'basic') {
        const target = (await shell.match(req, { ignoreSearch: true })) ? shell : await caches.open(ASSET_CACHE);
        target.put(req, res.clone());
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});

// ---------------------------------------------------------------------------
// Push: calls, messages and job alerts arrive here even when the app is closed.
// ---------------------------------------------------------------------------
async function appWindows() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter(w => new URL(w.url).pathname.startsWith('/app'));
}

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'WAZAMBI', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil((async () => {
    const wins = await appWindows();
    const visible = wins.find(w => w.visibilityState === 'visible');
    // Tell open copies of the app; they re-check the call / chat themselves.
    wins.forEach(w => w.postMessage({ type: 'push', data }));

    if (data.kind === 'call-close') {
      const open = await self.registration.getNotifications({ tag: data.tag });
      open.forEach(n => n.close());
      return;
    }
    // The app is on screen and handles it (ring screen, sound, badge).
    if (visible) return;

    const options = {
      body: data.body || '',
      tag: data.tag,
      renotify: true,
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/notification.png',
      data: { url: data.url || '/app', kind: data.kind, callId: data.callId, declineUrl: data.declineUrl, declineToken: data.declineToken },
      timestamp: Date.now()
    };
    if (data.kind === 'call') {
      options.requireInteraction = true;
      options.vibrate = [600, 300, 600, 300, 600, 300, 600];
      options.actions = [
        { action: 'answer', title: 'Answer' },
        { action: 'decline', title: 'Decline' }
      ];
    }
    if (data.kind === 'call-ended') {
      const ringing = await self.registration.getNotifications({ tag: data.tag });
      ringing.forEach(n => n.close());
    }
    await self.registration.showNotification(data.title || 'WAZAMBI', options);
  })());
});

self.addEventListener('notificationclick', event => {
  const n = event.notification;
  const d = n.data || {};
  n.close();

  if (event.action === 'decline' && d.callId && d.declineUrl) {
    // Decline without opening the app: a signed, single-purpose request.
    event.waitUntil(fetch(d.declineUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'decline', id: d.callId, token: d.declineToken })
    }).catch(() => {}));
    return;
  }

  let target = d.url || '/app';
  if (d.kind === 'call' && d.callId) target = `/app#/call/${d.callId}${event.action === 'answer' ? '/answer' : ''}`;
  event.waitUntil((async () => {
    const wins = await appWindows();
    const app = wins[0];
    if (app) {
      app.postMessage({ type: 'open', url: target });
      return app.focus();
    }
    return self.clients.openWindow(target);
  })());
});
