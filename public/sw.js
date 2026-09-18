/* ============================================================
 * Orbital service worker.
 *
 * DELIBERATELY SMALL. Orbital is an always-online game against a live
 * server; there is no useful offline mode, and a service worker that
 * tries to invent one is the classic way to ship a permanently stale
 * client that no deploy can fix. This exists for exactly three jobs:
 *
 *   1. Installability. Android will not offer "add to home screen", and
 *      a Trusted Web Activity will not package, without a fetch handler.
 *   2. Push. A web push notification can only be delivered to a service
 *      worker; this is the only place that handler can live.
 *   3. Repeat-load speed on a phone, by caching the hashed bundle.
 *
 * THE CACHING RULE, and why it cannot go stale:
 *
 *   /static/*  — content-hashed by the build (main.<hash>.js). A given
 *                URL's bytes never change, so cache-first is safe
 *                forever and a new deploy simply asks for new URLs.
 *   /api/*     — never touched. Game state is never served from a cache.
 *   navigation — NETWORK FIRST. The HTML shell is the one file whose URL
 *                is stable while its contents change every deploy, so it
 *                is always re-fetched when the network is there. The
 *                cached copy is a fallback for a dead connection only.
 *
 * That combination means the worst case offline is the shell plus the
 * last bundle, and the worst case online is a normal request. There is
 * no path where an old build survives a deploy.
 *
 * Bumping CACHE_VERSION is a hard reset of everything above.
 * ============================================================ */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `orbital-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `orbital-assets-${CACHE_VERSION}`;
const KEEP = new Set([SHELL_CACHE, ASSET_CACHE]);

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready rather than waiting for
  // every tab to close: a game left open in a background tab for hours
  // would otherwise pin an old worker indefinitely.
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.add('/')).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('orbital-') && !KEEP.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // Escape hatch. If a worker ever does go wrong in the wild, the page
  // can tell it to stand down and clear everything without the player
  // having to find browser settings.
  if (event.data === 'orbital:sw-reset') {
    event.waitUntil((async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('orbital-')) await caches.delete(key);
      }
      await self.registration.unregister();
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Someone else's server is not ours to cache.
  if (url.origin !== self.location.origin) return;
  // Live game state, auth, telemetry: always the network, no exceptions.
  if (url.pathname.startsWith('/api/')) return;
  // Worker-rendered HTML that changes per request.
  if (url.pathname.startsWith('/herald/') || url.pathname.startsWith('/battle/')) return;

  // The shell: network first, cache as a fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return (await caches.match('/')) ?? Response.error();
      }
    })());
    return;
  }

  // Hashed build output: cache first, since the URL identifies the bytes.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    })());
  }
});

// ---- Push ---------------------------------------------------------
//
// The server sends {title, body, tag, url, category}. `tag` collapses
// repeats of the same subject (one "your offer was accepted" at a time
// rather than a stack of four), and `url` is where a tap should land.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* keep defaults */ }

  const title = data.title || 'Orbital';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'orbital',
    renotify: !!data.tag,
    data: { url: data.url || '/' },
    timestamp: Date.now(),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    // Re-use an open Orbital rather than stacking a second copy of a
    // game the player already has running.
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client && target !== '/') {
          try { await client.navigate(target); } catch { /* focus is enough */ }
        }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
