// GET /wear/planet/<key>/<px>.png -- a world's sprite for the watch,
// rasterised from planetSvg (the game's own painter; see planetSvg.js).

import { configureRasterizer, rasterReady } from './shipIconRaster.js';
import { Resvg } from '@resvg/resvg-wasm';
import { encodePng } from './heraldPng.js';
import { planetSvg, parseSpriteKey } from './planetSvg.js';

const CACHE = new Map();
const CACHE_MAX = 200;

/** GET /wear/planet/<key>/<px>.png */
export async function handleWearPlanet(_req, _env, { params }) {
  const body = parseSpriteKey(params.key);
  if (!body) return new Response('bad sprite key', { status: 400 });
  // A ringed world's sprite is twice the disk across (planetSvg RING_PAD).
  const px = Math.max(32, Math.min(512, Number(params.px) || 128));
  const ck = `${params.key}@${px}`;
  let png = CACHE.get(ck);
  if (!png) {
    try {
      const { default: wasm } = await import('./resvgWasm.js');
      configureRasterizer(wasm);
    } catch (e) {
      console.error('wear planet: rasteriser load failed', e);
    }
    if (!(await rasterReady())) return new Response('sprites unavailable', { status: 503 });
    try {
      const img = new Resvg(planetSvg(body), { fitTo: { mode: 'width', value: px } }).render();
      // resvg is premultiplied; PNG is straight alpha.
      const src = img.pixels;
      const data = new Uint8Array(src.length);
      for (let i = 0; i < data.length; i += 4) {
        const a = src[i + 3];
        data[i + 3] = a;
        if (a === 0) continue;
        data[i] = Math.min(255, Math.round((src[i] * 255) / a));
        data[i + 1] = Math.min(255, Math.round((src[i + 1] * 255) / a));
        data[i + 2] = Math.min(255, Math.round((src[i + 2] * 255) / a));
      }
      png = await encodePng({ w: img.width, h: img.height, data });
      img.free?.();
    } catch (e) {
      console.error('wear planet: render failed', params.key, e);
      return new Response('sprite failed', { status: 500 });
    }
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(ck, png);
  }
  return new Response(png, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' },
  });
}
