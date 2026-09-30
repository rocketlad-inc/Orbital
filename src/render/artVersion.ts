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

export const ART_VERSION = '90878883cd11';

/** A world-art path ('/globes/mars.webp') with the art version attached. */
export function artUrl(path: string): string {
  return `${path}?v=${ART_VERSION}`;
}
