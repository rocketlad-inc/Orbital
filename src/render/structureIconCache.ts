// ============================================================
// Structure Icon Cache — rasterize the megastructure SVGs so canvas can
// draw them. A near-copy of shipIconCache by design: same raster size,
// same key shape, same loading/failed sets.
//
// The duplication is deliberate rather than a shared generic. These two
// caches key on different things (ship class + variant vs structure
// kind + variant), and the one place worth sharing — the ART TREATMENT
// — is already shared, because both icon families render through
// IconFrame. A generic over both would abstract the part that does not
// matter and leave the part that does exactly where it is.
// ============================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  StructureIcon, StructureScaffold, StructureVariant, DEFAULT_STRUCTURE_VARIANT,
} from '../components/StructureIcons';
import type { MegastructureKind } from '../game/megastructures';

/** Same 64px as the ship raster, for the same reason: the shaded-hull
 *  treatment bakes gradients in, and a structure drawn at up to 46px on
 *  the map needs the headroom to stay smooth. Keep in step with
 *  ICON_RASTER_SIZE in shipIconCache. */
const ICON_RASTER_SIZE = 64;

type CacheKey = string;

const ready = new Map<CacheKey, HTMLImageElement>();
const loading = new Set<CacheKey>();
const failed = new Set<CacheKey>();

function key(
  kind: MegastructureKind, color: string,
  variant: StructureVariant, color2?: string,
): CacheKey {
  return `${kind}|${variant}|${color}|${color2 ?? ''}`;
}

/**
 * Cached raster for a (kind, colour, variant) combo, or null while it
 * loads. Callers draw a fallback on null — the same contract the ship
 * cache has, so the map's "not ready yet" path is identical for both.
 */
export function getStructureIconImage(
  kind: MegastructureKind,
  color: string,
  variant?: StructureVariant | null,
  color2?: string,
): HTMLImageElement | null {
  const v = variant ?? DEFAULT_STRUCTURE_VARIANT;
  const k = key(kind, color, v, color2);
  const hit = ready.get(k);
  if (hit) return hit;
  if (loading.has(k) || failed.has(k)) return null;

  loading.add(k);
  try {
    const svgString = renderToStaticMarkup(
      React.createElement(StructureIcon, {
        kind, variant: v, color, color2, size: ICON_RASTER_SIZE,
      }),
    );
    const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svgString)}`;
    const img = new Image();
    img.onload = () => {
      ready.set(k, img);
      loading.delete(k);
    };
    img.onerror = (e) => {
      // Failed once — do not retry every frame.
      // eslint-disable-next-line no-console
      console.warn('[structureIconCache] failed to rasterize', k, e);
      loading.delete(k);
      failed.add(k);
    };
    img.src = dataUrl;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[structureIconCache] render failed', k, e);
    loading.delete(k);
    failed.add(k);
  }
  return null;
}

/**
 * The scaffold raster for a build stage. Keyed on stage rather than kind
 * because the frame is generic — what tells you WHAT is being built is
 * the finished silhouette ghosted behind it, which the map draws
 * separately in the last quarter.
 */
export function getScaffoldImage(
  stage: number,
  color: string,
  color2?: string,
): HTMLImageElement | null {
  const st = Math.max(0, Math.min(3, Math.round(stage)));
  const k = `scaffold|${st}|${color}|${color2 ?? ''}`;
  const hit = ready.get(k);
  if (hit) return hit;
  if (loading.has(k) || failed.has(k)) return null;

  loading.add(k);
  try {
    const svgString = renderToStaticMarkup(
      React.createElement(StructureScaffold, {
        stage: st, color, color2, size: ICON_RASTER_SIZE,
      }),
    );
    const img = new Image();
    img.onload = () => { ready.set(k, img); loading.delete(k); };
    img.onerror = () => { loading.delete(k); failed.add(k); };
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svgString)}`;
  } catch {
    loading.delete(k);
    failed.add(k);
  }
  return null;
}

/**
 * How much bigger to draw a sprite so its ART, not its padded square,
 * fills the box it is given: the box over the art's own extent (alpha
 * bounding box), measured once per image. 1 until it can be measured.
 *
 * The Mega Destroyer's round, open hull sits in the middle of its square,
 * so a 200 px Mega read as a 110 px ship beside 90 px destroyers (judges,
 * 2026-10-22: "barely reads as the biggest ship").
 */
const artFill = new WeakMap<HTMLImageElement, number>();
export function artScaleOf(img: HTMLImageElement): number {
  const hit = artFill.get(img);
  if (hit != null) return hit;
  let s = 1;
  try {
    const n = 128;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (g) {
      g.drawImage(img, 0, 0, n, n);
      const d = g.getImageData(0, 0, n, n).data;
      let x0 = n, y0 = n, x1 = -1, y1 = -1;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (d[(y * n + x) * 4 + 3] > 24) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      // Rotation-safe: the art's reach from the centre, both ways, both axes.
      if (x1 >= 0) {
        const reach = Math.max(n / 2 - x0, x1 + 1 - n / 2, n / 2 - y0, y1 + 1 - n / 2);
        s = Math.max(1, Math.min(1.8, (n / 2) / Math.max(1, reach)));
      }
    }
  } catch {
    s = 1;
  }
  artFill.set(img, s);
  return s;
}
