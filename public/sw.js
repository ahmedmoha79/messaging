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

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/app';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = windows.find(w => new URL(w.url).pathname.startsWith('/app'));
    if (app) {
      app.postMessage({ type: 'open', url: target });
      return app.focus();
    }
    return self.clients.openWindow(target);
  })());
});
