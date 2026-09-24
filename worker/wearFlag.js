// ============================================================
// GET /wear/flag/<emblem>/<px>.png -- an empire's emblem, for the watch.
//
// THE SAME SHAPES EVERY OTHER SURFACE DRAWS. The artwork is React SVG,
// which a Worker cannot rasterise, so the Herald bakes 1-bit masks of it
// (worker/_emblemMasks.js) and both Herald renderers stamp from that one
// table. The watch stamps from it too, which is the whole point: an
// emblem cannot mean one thing on the map and another on a wrist.
//
// WHITE, WITH ALPHA, AND NEVER A COLOUR. The watch tints it to the
// faction's own livery when it draws it, so one PNG per emblem serves
// every empire that ever flies it -- and a colour baked in here would be
// a second place for a faction's colour to live and drift.
//
// The mask is 24 square and nearest-neighboured up: at 24 to 48 device
// pixels on a watch, a hard edge reads better than a blurred one, and
// these shapes were drawn as silhouettes.
// ============================================================

import { EMBLEM_MASK_SIZE, forEachMaskPixel } from './_emblemMasks.js';
import { encodePng } from './heraldPng.js';

export const WEAR_FLAG_RE = /^\/wear\/flag\/([a-z0-9_]{1,32})\/(\d{2,3})\.png$/;

const CACHE = new Map();

export async function handleWearFlag(_req, _env, { params }) {
  const id = String(params.id ?? '');
  const px = Math.max(16, Math.min(128, Number(params.px) || 48));
  const ck = `${id}@${px}`;
  let png = CACHE.get(ck);
  if (!png) {
    const N = EMBLEM_MASK_SIZE;
    const on = new Uint8Array(N * N);
    // A mask this server does not have is a 404, not a blank square: the
    // watch falls back to a plain dot in the faction's colour, which is
    // what it drew before emblems reached it.
    if (!forEachMaskPixel(id, (mx, my) => { on[my * N + mx] = 1; })) {
      return new Response('no such emblem', { status: 404 });
    }
    const data = new Uint8Array(px * px * 4);
    for (let y = 0; y < px; y++) {
      const my = Math.min(N - 1, Math.floor((y * N) / px));
      for (let x = 0; x < px; x++) {
        const mx = Math.min(N - 1, Math.floor((x * N) / px));
        if (!on[my * N + mx]) continue;
        const i = (y * px + x) * 4;
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
      }
    }
    png = await encodePng({ w: px, h: px, data });
    if (CACHE.size > 120) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(ck, png);
  }
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // The shapes only change when the artwork is regenerated, which
      // renames nothing -- so this is as immutable as the ship icons.
      'cache-control': 'public, max-age=604800',
    },
  });
}
