// ============================================================
// World art URLs, versioned so devices can keep them for good.
//
// The globes, surface maps, rings and rock textures are served with a
// one-year immutable cache (public/_headers) and kept by the service
// worker (public/sw.js), so a returning player downloads none of them.
// That is only safe because every URL carries this version: it is a
// fingerprint of every art file (scripts/art-hash.js), so regenerated art
// arrives under a new URL and no device can be left holding a stale map.
//
// After regenerating art: npm run art:version. A test fails until you do.
// ============================================================

export const ART_VERSION = '10a6d1bd1061';

/** The watch and widget art version: the world art plus the hull designs
 *  and emblem art the server draws them from (scripts/art-hash.js
 *  wearArtHash). It rides inside the ship and planet image keys, so a
 *  watch, which caches each image by its key for good, fetches new art
 *  by itself when this moves. Same npm run art:version, same test. */
export const WEAR_ART_VERSION = 'b77f97e4';

/** A world-art path ('/globes/mars.webp') with the art version attached. */
export function artUrl(path: string): string {
  return `${path}?v=${ART_VERSION}`;
}
