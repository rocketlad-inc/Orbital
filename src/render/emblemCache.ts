// ============================================================
// Emblem raster cache — faction emblems as canvas-drawable images.
//
// The emblems are React SVG (components/FactionEmblem) and the map is a
// canvas, so they have to be rasterised to be drawn on territory. This
// mirrors shipIconCache exactly — same renderToStaticMarkup → data URL →
// Image pipeline, same ready/loading/failed tri-state, same "return null
// and let the caller skip this frame" contract. Two caches with the same
// shape beats one clever shared abstraction over two things that only
// look alike.
//
// Cached per (emblem, colour): a faction is one colour, and a game has a
// handful of factions, so the cache stays tiny.
// ============================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { emblemSvgElement } from '../components/FactionEmblem';
import { EmblemId, isEmblemId } from '../game/emblems';

/** Raster size. Territory watermarks draw large — up to a few hundred
 *  px on a fat band at low zoom — but they're painted at very low alpha
 *  behind a label, where softness is invisible and often flattering.
 *  128 is a comfortable middle: crisp at typical sizes, ~1 frame to
 *  rasterise, and small in memory across a handful of factions. */
const EMBLEM_RASTER_SIZE = 128;

const ready = new Map<string, HTMLImageElement>();
const loading = new Set<string>();
const failed = new Set<string>();

/**
 * Cached emblem image for (emblem, colour), or null while it loads.
 *
 * Null is a normal, expected answer on the first frames — callers must
 * simply not draw rather than block. The image lands on a later frame
 * and the map redraws continuously anyway.
 */
export function getEmblemImage(emblem: string | null | undefined, color: string): HTMLImageElement | null {
  if (!isEmblemId(emblem)) return null;
  const k = `${emblem}|${color}`;
  const hit = ready.get(k);
  if (hit) return hit;
  if (loading.has(k) || failed.has(k)) return null;

  loading.add(k);
  try {
    const svg = renderToStaticMarkup(
      emblemSvgElement(emblem as EmblemId, EMBLEM_RASTER_SIZE, color),
    );
    const img = new Image();
    img.onload = () => { ready.set(k, img); loading.delete(k); };
    img.onerror = (e) => {
      // Once is enough — retrying every frame would hammer the decoder
      // for a glyph that is never going to parse.
      // eslint-disable-next-line no-console
      console.warn('[emblemCache] failed to rasterize', k, e);
      loading.delete(k);
      failed.add(k);
    };
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[emblemCache] renderToStaticMarkup threw for', k, err);
    loading.delete(k);
    failed.add(k);
  }
  return null;
}

/** Test/hot-reload hook. */
export function clearEmblemCache() {
  ready.clear();
  loading.clear();
  failed.clear();
}
