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
