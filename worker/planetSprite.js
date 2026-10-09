// GET /wear/planet/<key>/<px>.png -- a world's sprite for the watch,
// rasterised from planetSvg. A world with a globe in the game is drawn
// from that globe (a PNG copy made at build, public/globes-png, read
// through ASSETS: resvg cannot read the WebP originals); the rest from
// the procedural painter. See planetSvg.js.

import { configureRasterizer, rasterReady } from './shipIconRaster.js';
import { Resvg } from '@resvg/resvg-wasm';
import { encodePng } from './heraldPng.js';
import { planetSvg, parseSpriteKey, globeNameOf } from './planetSvg.js';

const CACHE = new Map();
const CACHE_MAX = 200;

/**
 * An SVG rasterised to a straight-alpha PNG `px` wide, or null when the
 * rasteriser cannot start. Shared by the planet sprites and the face map.
 */
export async function rasterSvgPng(svg, px) {
  const img = await rasterSvgPixels(svg, px);
  return img ? encodePng(img) : null;
}

/**
 * An SVG rasterised to straight-alpha RGBA pixels { w, h, data }, or null
 * when the rasteriser cannot start. For callers that composite the art
 * into a bigger picture (the recap's link-preview card) rather than
 * serving it alone.
 */
export async function rasterSvgPixels(svg, px) {
  try {
    const { default: wasm } = await import('./resvgWasm.js');
    configureRasterizer(wasm);
  } catch (e) {
    console.error('wear raster: rasteriser load failed', e);
  }
  if (!(await rasterReady())) return null;
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render();
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
  const out = { w: img.width, h: img.height, data };
  img.free?.();
  return out;
}

/** The world's globe as base64 PNG, or null (no globe, or not found). */
export async function globePngOf(req, env, body) {
  const name = globeNameOf(body);
  if (!name || !env?.ASSETS) return null;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(`/globes-png/${name}.png`, req.url)));
    if (!res.ok || !(res.headers.get('content-type') || '').includes('png')) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  } catch (e) {
    console.error('wear planet: globe fetch failed', name, e);
    return null;
  }
}

export async function handleWearPlanet(req, env, { params }) {
  const body = parseSpriteKey(params.key);
  if (!body) return new Response('bad sprite key', { status: 400 });
  // A ringed world's sprite is twice the disk across (planetSvg RING_PAD).
  const px = Math.max(32, Math.min(512, Number(params.px) || 128));
  const ck = `${params.key}@${px}`;
  let png = CACHE.get(ck);
  if (!png) {
    try {
      const globe = await globePngOf(req, env, body);
      png = await rasterSvgPng(planetSvg(body, globe), px);
      if (!png) return new Response('sprites unavailable', { status: 503 });
    } catch (e) {
      console.error('wear planet: render failed', params.key, e);
      return new Response('sprite failed', { status: 500 });
    }
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(ck, png);
  }
  return new Response(png, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' },
  });
}
