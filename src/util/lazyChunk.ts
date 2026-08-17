// ============================================================
// Lazy components that survive a deploy.
//
// Code splitting puts a hashed filename in the main bundle: "when the
// user asks for the film, fetch 609.9837fe7b.chunk.js". Deploying
// replaces every hashed asset, so a browser still running the PREVIOUS
// main bundle asks for a chunk that no longer exists, gets a 404, and
// React.lazy throws into the nearest error boundary. The user sees the
// app break at the exact moment they click the new feature.
//
// It cannot be fixed by keeping old chunks around forever, and it is
// not worth un-splitting the bundle over — three.js is 126kB that most
// players never need. The fix is to notice the failure for what it is:
// the page is stale, so reload it once and let the fresh main bundle
// ask for the chunk it actually shipped with.
//
// Guarded by sessionStorage so a genuinely missing chunk (a broken
// deploy, an offline client) surfaces as an error on the second attempt
// instead of reloading forever.
// ============================================================

import React from 'react';

/** Is this the "the file isn't there" failure, rather than a bug? */
function isChunkLoadError(e: unknown): boolean {
  const msg = (e as Error)?.message ?? String(e);
  return /Loading chunk|ChunkLoadError|Failed to fetch dynamically imported|error loading dynamically imported/i
    .test(msg);
}

export function lazyChunk<T extends React.ComponentType<any>>(
  key: string, factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  const flag = `chunk-reload:${key}`;
  return React.lazy(async () => {
    try {
      const mod = await factory();
      // Loaded fine: forget any earlier reload so a future deploy gets
      // its own single retry rather than being denied one.
      try { sessionStorage.removeItem(flag); } catch { /* private mode */ }
      return mod;
    } catch (e) {
      if (!isChunkLoadError(e)) throw e;
      let tried = false;
      try { tried = sessionStorage.getItem(flag) === '1'; } catch { /* ignore */ }
      if (tried) throw e;
      try { sessionStorage.setItem(flag, '1'); } catch { /* ignore */ }
      // Reload with the cache bypassed for the document, so the shell
      // that names the chunks is refetched rather than served from disk.
      window.location.reload();
      // The reload takes over; never resolve, so no error boundary
      // flashes in the moment before the page goes away.
      return new Promise<never>(() => { /* deliberately pending */ });
    }
  });
}
