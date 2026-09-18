// ============================================================
// Service-worker registration.
//
// The worker itself (public/sw.js) is deliberately minimal — see the
// essay at the top of it. This file decides WHETHER to register, which
// is the part that can hurt.
//
// DEV IS EXCLUDED. A service worker in front of the dev server caches a
// bundle that changes every save; the failure mode is an afternoon spent
// debugging code you already deleted.
//
// AND IT CAN BE TURNED OFF FROM THE PAGE. `?sw=off` unregisters and
// clears, then reloads clean. That is the recovery path if a worker ever
// does misbehave on a device we cannot reach — a URL a player can be
// given over Discord, rather than "open chrome://serviceworker-internals".
// ============================================================

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const params = new URLSearchParams(window.location.search);
  if (params.get('sw') === 'off') {
    void (async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('orbital-')).map(k => caches.delete(k)));
      }
      // Drop the flag out of the URL so a reload does not loop.
      const url = new URL(window.location.href);
      url.searchParams.delete('sw');
      window.location.replace(url.toString());
    })();
    return;
  }

  if (process.env.NODE_ENV !== 'production') return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // A failed registration costs installability and push, not play.
      console.warn('service worker registration failed', err);
    });
  });
}
