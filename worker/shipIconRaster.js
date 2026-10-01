// ---------------------------------------------------------------------
// THE REAL SHIP ICON, ON A PNG
//
// The battle card draws ships the way the game draws them: the actual
// ShipIcons.tsx component, livery shading, engine glow, canopy and all.
// Not an outline traced from it -- an earlier version did that, and a
// row of flat silhouettes is not the icon a player recognises from the
// situation log.
//
// HOW. The hull is drawn by the game's own hull language
// (src/render/hulls), the same code ShipIcons.tsx mounts, on request:
// every class and letter the game has (the 25 homage designs, the Planet
// Killer, the Mobile Foundry) painted in the situation log's health
// colours, rasterised with resvg -- the Skia-derived SVG renderer,
// compiled to WebAssembly -- at whatever size is asked for. A new design
// in the game is a new design here with the next deploy. (This used to be
// a hand-run snapshot of the old icons, worker/generated/shipIconSvgs.js,
// which went stale the day the hulls changed.)
//
// VERSIONED KEYS. iconKey puts WEAR_ART_VERSION into the letter field
// ('frigate:U~2d1da280:green'). The watch caches each icon on disk by its
// key, for good, so a key that changes when the art changes is what
// makes a watch fetch the new drawing by itself.
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
import { shipDesign, hasShipDesign, hullSvgString } from '../src/render/hulls/index';
import { WEAR_ART_VERSION } from '../src/render/artVersion';

/** The game's default letter per class (ShipIcons DEFAULT_SHIP_ICONS;
 *  capital hulls default to their first design). */
export const DEFAULT_SHIP_ICONS = {
  corvette: 'B', frigate: 'B', destroyer: 'B', freighter: 'A', colony: 'A',
  mega_destroyer: 'A', mobile_foundry: 'A',
};

/** The situation log's hull ramp, exactly (SituationLog.tsx hpColor and
 *  hpColor2): the icon is only the real icon if it is painted the way
 *  the game paints it. */
const BUCKETS = {
  green: ['#6ee7b7', '#3f8f78'],
  amber: ['#ffb84d', '#a67430'],
  red: ['#ff5e5e', '#a63636'],
  unknown: ['#8aa0b4', '#5a7080'],
};

const KEY_RE = /^([a-z_]+):([A-Z])(?:~([0-9a-f]{6,16}))?:(green|amber|red|unknown)$/;

/** A key's parts, or null when it names nothing this server can draw. The
 *  version is optional: the watch app has a few keys written into it
 *  (its build picker), and those must keep working. */
export function parseIconKey(key) {
  const m = KEY_RE.exec(String(key || ''));
  if (!m || !(m[1] in DEFAULT_SHIP_ICONS) || !shipDesign(m[1], m[2])) return null;
  return { cls: m[1], variant: m[2], version: m[3] ?? null, bucket: m[4] };
}

/** The icon's SVG at `size` px, from the hull language. */
export function iconSvg(key, size) {
  const k = parseIconKey(key);
  if (!k) return null;
  const d = shipDesign(k.cls, k.variant);
  const [primary, secondary] = BUCKETS[k.bucket];
  return hullSvgString(d, `${k.cls}.${k.variant}`, size, primary, secondary);
}

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
 * The icon key the game would draw for this ship: its own class (capital
 * hulls included, they have their own designs now) and its chosen letter,
 * or the class default when that letter has no design. Anything
 * unrecognised draws as a default corvette, never as nothing. The art
 * version rides in the letter field so a watch re-fetches changed art.
 */
export function iconKey(shipClass, variant, pct) {
  const c = String(shipClass || '').toLowerCase();
  const cls = c in DEFAULT_SHIP_ICONS ? c : 'corvette';
  const want = String(variant || '');
  const v = /^[A-Z]$/.test(want) && hasShipDesign(cls, want) ? want : DEFAULT_SHIP_ICONS[cls];
  return `${cls}:${v}~${WEAR_ART_VERSION}:${healthBucket(pct)}`;
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
  const svg = iconSvg(key, size);
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
