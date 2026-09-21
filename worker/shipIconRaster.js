// ---------------------------------------------------------------------
// THE REAL SHIP ICON, ON A PNG
//
// The battle card draws ships the way the game draws them: the actual
// ShipIcons.tsx component, livery shading, engine glow, canopy and all.
// Not an outline traced from it -- an earlier version did that, and a
// row of flat silhouettes is not the icon a player recognises from the
// situation log.
//
// HOW. scripts/gen-ship-icon-svgs.tsx renders every icon through the
// component with react-dom/server and saves the exact markup, once per
// class, variant and health colour (worker/generated/shipIconSvgs.js).
// This module rasterises that markup with resvg -- the Skia-derived SVG
// renderer, compiled to WebAssembly -- at whatever size the card asks
// for, and composites it. The SVG is never reinterpreted, only drawn.
//
// WHY THE WASM IS INJECTED rather than imported here: the Worker loads
// it as a compiled WebAssembly.Module (see resvgWasm.js), but the node
// simulations cannot import a .wasm file at all. So whoever calls this
// supplies the module or its bytes through configureRasterizer, and the
// same drawing code runs in both places.
//
// RESVG HANDS BACK PREMULTIPLIED ALPHA. Measured, not assumed: a 50% red
// fill comes back as [128, 0, 0, 128]. Compositing it as if it were
// straight alpha darkens every anti-aliased edge into a grey halo, so
// the blend below is the premultiplied one.
// ---------------------------------------------------------------------

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import {
  SHIP_ICON_SVGS, DEFAULT_SHIP_ICONS, ICON_CLASS_FOR,
} from './generated/shipIconSvgs.js';

let wasmSource = null;
let ready = null;
let failed = null;

/** Hand the rasteriser its WebAssembly: a compiled Module in the
 *  Worker, raw bytes in node. Safe to call repeatedly. */
export function configureRasterizer(source) {
  if (!wasmSource) wasmSource = source;
}

/** Initialise once per isolate. Resolves true when icons can be drawn. */
export async function rasterReady() {
  if (failed) return false;
  if (!wasmSource) return false;
  if (!ready) {
    ready = initWasm(wasmSource).then(
      () => true,
      (e) => {
        // initWasm refuses a second call in the same isolate; that is
        // success, not failure.
        if (String(e?.message || e).includes('Already initialized')) return true;
        failed = e;
        console.error('ship icon rasteriser failed to initialise', e);
        return false;
      },
    );
  }
  return ready;
}

/** Health percentage to the situation log's colour bucket. */
export function healthBucket(pct) {
  if (pct == null) return 'unknown';
  return pct <= 33 ? 'red' : pct <= 66 ? 'amber' : 'green';
}

/**
 * The icon key the game would draw for this ship: its class mapped the
 * way ShipIcons.iconClassFor maps it, and its chosen variant or the
 * class default. Anything unrecognised draws as the game draws it -- a
 * default-variant corvette -- and never as nothing.
 */
export function iconKey(shipClass, variant, pct) {
  const cls = ICON_CLASS_FOR[String(shipClass || '').toLowerCase()] || 'corvette';
  const v = /^[A-S]$/.test(String(variant || '')) ? variant : DEFAULT_SHIP_ICONS[cls];
  return `${cls}:${v}:${healthBucket(pct)}`;
}

// A card draws the same few dozen icons over and over, at one or two
// sizes. Rasterising is the only expensive thing here, so each result
// is kept for the life of the isolate.
const CACHE = new Map();
const CACHE_MAX = 600;

/** The icon as premultiplied RGBA at `size` pixels wide, or null. */
export function rasterIcon(key, size) {
  const ck = `${key}@${size}`;
  const hit = CACHE.get(ck);
  if (hit) return hit;
  const svg = SHIP_ICON_SVGS[key];
  if (!svg) return null;
  try {
    const img = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
    const out = { w: img.width, h: img.height, px: img.pixels };
    img.free?.();
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(ck, out);
    return out;
  } catch (e) {
    console.error('ship icon failed to rasterise', key, e);
    return null;
  }
}

/**
 * Composite an icon onto a heraldPng surface, centred on (cx, cy).
 *
 * The surface is opaque straight-alpha RGBA; the icon is premultiplied.
 * Source-over for that pairing is dst = src + dst * (1 - srcAlpha).
 */
export function drawIcon(s, icon, cx, cy) {
  if (!icon) return;
  const x0 = Math.round(cx - icon.w / 2);
  const y0 = Math.round(cy - icon.h / 2);
  const d = s.data;
  const src = icon.px;
  for (let y = 0; y < icon.h; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= s.h) continue;
    for (let x = 0; x < icon.w; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= s.w) continue;
      const si = (y * icon.w + x) * 4;
      const a = src[si + 3];
      if (a === 0) continue;
      const di = (dy * s.w + dx) * 4;
      const inv = 1 - a / 255;
      d[di] = src[si] + d[di] * inv;
      d[di + 1] = src[si + 1] + d[di + 1] * inv;
      d[di + 2] = src[si + 2] + d[di + 2] * inv;
      d[di + 3] = 255;
    }
  }
}
