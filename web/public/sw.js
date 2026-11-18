/*
  Event photos - service worker.
  Caches the app shell, and thumbnails this phone has already viewed when the app itself sent them. Thumbnails live in
  OneDrive: the app answers with a redirect to a short-lived OneDrive link, which comes back to this worker as an
  opaque response. Those are passed through and not cached (an opaque entry takes about 7 MB of quota in Chrome, and
  the link behind it runs out); the browser's own cache keeps them for a few minutes.
  Never caches API answers (another person's results must never come from a cache), the admin console or sign-in.
  Shows the notification Keep me updated sends ("3 new photos of you at ...") and opens My prints on a tap.
*/
const SHELL = 'ep-shell-v5'; // v5: notifications for Keep me updated
const THUMBS = 'ep-thumbs-v2'; // v2: thumbnails come from OneDrive (redirects); v1 is deleted on activate
const MAX_THUMBS = 400;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/offline.html', '/logo-mark.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== THUMBS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(cacheName, request, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only a plain answer from this site is kept: never a redirected (opaque) one, never an error.
  if (res.ok && res.type === 'basic') {
    await cache.put(request, res.clone());
    if (limit) {
      const keys = await cache.keys();
      if (keys.length > limit) await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
    }
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/auth/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(async () => (await caches.match('/')) || (await caches.match('/offline.html'))),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(SHELL, request));
    return;
  }
  if (/^\/img\/[^/]+\/t$/.test(url.pathname) && !url.searchParams.has('a')) {
    event.respondWith(cacheFirst(THUMBS, request, MAX_THUMBS));
  }
});

// ---- Keep me updated: "N new photos of you at <event>" --------------------------------------
/**
 * Only a path on this site is opened from a notification. The path is resolved the way the browser will resolve it,
 * so tricks like "//host" or "/\host" (a backslash counts as a slash) cannot lead to another site.
 */
function safePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return '/';
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let p = null;
  try {
    p = event.data ? event.data.json() : null;
  } catch {
    p = null;
  }
  const shown =
    p && typeof p === 'object' && typeof p.title === 'string' && typeof p.body === 'string'
      ? self.registration.showNotification(p.title, {
          body: p.body,
          tag: typeof p.tag === 'string' ? p.tag : undefined,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          data: { url: safePath(p.url) },
        })
      : self.registration.showNotification('Event Photos', { body: 'New photos of you have arrived.', data: { url: '/' } });
  event.waitUntil(shown);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const tab = open.find((c) => new URL(c.url).origin === self.location.origin);
      if (tab) {
        try {
          const focused = await tab.focus();
          if (focused && 'navigate' in focused) {
            await focused.navigate(url);
            return;
          }
        } catch {
          /* a tab this worker does not control cannot be sent elsewhere: open a new one */
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
