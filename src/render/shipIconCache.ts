// ============================================================
// Ship Icon Cache — rasterize SVG ship icons to images so they
// can be drawn on canvas. Cached per (class, color) pair.
// ============================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShipIcon, ShipIconClass } from '../components/ShipIcons';

/** Pixel size of the rasterized icon — large enough to stay crisp when
 *  drawn at any practical on-map size. */
const ICON_RASTER_SIZE = 64;

type CacheKey = string;

const ready = new Map<CacheKey, HTMLImageElement>();
const loading = new Set<CacheKey>();
const failed = new Set<CacheKey>();

function key(shipClass: ShipIconClass, color: string): CacheKey {
  return `${shipClass}|${color}`;
}

/**
 * Get the cached icon image for a (class, color) combo. Returns null if
 * the image is still loading — the caller should draw a fallback shape.
 * Loading kicks off on first request and the image becomes available on
 * a subsequent animation frame.
 */
export function getShipIconImage(
  shipClass: ShipIconClass,
  color: string,
): HTMLImageElement | null {
  const k = key(shipClass, color);
  const hit = ready.get(k);
  if (hit) return hit;
  if (loading.has(k) || failed.has(k)) return null;

  loading.add(k);
  try {
    const svgString = renderToStaticMarkup(
      React.createElement(ShipIcon, { shipClass, color, size: ICON_RASTER_SIZE })
    );
    const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svgString)}`;
    const img = new Image();
    img.onload = () => {
      ready.set(k, img);
      loading.delete(k);
    };
    img.onerror = (e) => {
      // Failed once — don't retry every frame. Log so we can debug.
      // eslint-disable-next-line no-console
      console.warn('[shipIconCache] failed to rasterize', k, e);
      loading.delete(k);
      failed.add(k);
    };
    img.src = dataUrl;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[shipIconCache] renderToStaticMarkup threw for', k, err);
    loading.delete(k);
    failed.add(k);
  }
  return null;
}

/**
 * Prewarm: kick off image loading for every class in both faction colors
 * so the first ship draws after startup get the icon, not the fallback dot.
 */
export function prewarmShipIcons(colors: string[]) {
  const classes: ShipIconClass[] = ['corvette', 'frigate', 'destroyer', 'freighter'];
  for (const c of classes) {
    for (const color of colors) {
      getShipIconImage(c, color);
    }
  }
}
