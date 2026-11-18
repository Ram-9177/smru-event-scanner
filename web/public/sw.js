/*
  Event photos - service worker.
  Keeps only the app itself on the phone: the page and the newest scripts, styles and fonts (a few hundred KB), so it
  opens like an installed app and shows a page when there is no connection. Photos and videos are never kept here:
  they come from the server or straight from Microsoft OneDrive each time, and the browser's own cache holds one for
  5 minutes at most. When this version takes over it deletes every other cache, the thumbnails older versions kept
  (ep-thumbs-*) included, so a phone gets that space back.
  Never caches API answers (another person's results must never come from a cache), the admin console or sign-in.
  Shows the notification Keep me updated sends ("3 new photos of you at ...") and opens My prints on a tap.
*/
const SHELL = 'ep-shell-v6'; // v6: no photos on the phone, and only the newest app files
const MAX_ASSETS = 30; // scripts, styles and fonts under /assets/: this version's, and a little of the last one's

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/offline.html', '/logo-mark.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** An app file (/assets/..., named after its contents): kept on the phone once fetched; older versions' files go. */
async function appFile(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only a plain answer from this site is kept: never a redirected (opaque) one, never an error.
  if (res.ok && res.type === 'basic') {
    await cache.put(request, res.clone());
    const files = (await cache.keys()).filter((k) => new URL(k.url).pathname.startsWith('/assets/'));
    if (files.length > MAX_ASSETS) await Promise.all(files.slice(0, files.length - MAX_ASSETS).map((k) => cache.delete(k)));
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
  if (url.pathname.startsWith('/assets/')) event.respondWith(appFile(request));
  // Anything else, photos and videos (/img/...) included, goes to the network as the browser sends it.
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
