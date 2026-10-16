// A world in the Map Maker wears the art the game will paint on it: the
// same painter (paintSurfaceOnto) fed the id the game will give it
// (`cm_<id>`), so the continents and craters you see here are the ones
// players see in the game.
//
// Painting is LAZY (review, 2026-10-15): a surface paint plus a PNG
// encode is a few milliseconds, so painting during render froze the tab
// when a bulk recolour or a mood touched 200 worlds, or a colour picker
// was dragged. worldArt answers from the cache or returns null (the
// caller draws its gradient), and queues the paint; a few paints run per
// idle slice, newest request first, and then everyone subscribed is told
// to draw again.

import { useEffect, useState } from 'react';
import { paintSurfaceOnto, TEX_SIZE } from '../render/planetTexture';
import type { Body } from '../types';
import type { MapBody, MapBodyType } from '../game/customMap';

const GAME_TYPE: Record<MapBodyType, Body['type']> = {
  terrestrial: 'terrestrial', 'gas-giant': 'gas_giant', 'ice-giant': 'ice_giant',
  dwarf: 'dwarf', moon: 'moon', asteroid: 'asteroid', rock: 'meteoroid',
};

type ArtKey = Pick<MapBody, 'id' | 'type' | 'color' | 'surface'>;

/** Painted faces, least recently used first (a Map keeps insertion order). */
const cache = new Map<string, string | null>();
const CACHE_MAX = 1500;
/** Paints waiting, oldest request first. A request past QUEUE_MAX drops
 *  the oldest: a colour dragged through a hundred shades only needs the
 *  last few. */
const queue = new Map<string, { b: ArtKey; px: number }>();
const QUEUE_MAX = 400;
/** Milliseconds of painting per slice. */
const SLICE_MS = 8;
const listeners = new Set<() => void>();
let scheduled = false;

function paint(b: ArtKey, px: number): string | null {
  try {
    const src = document.createElement('canvas');
    src.width = src.height = TEX_SIZE;
    const c = src.getContext('2d');
    if (!c) return null;
    const body = {
      id: `cm_${b.id}`, name: '', type: GAME_TYPE[b.type], color: b.color,
      look: { surface: b.surface },
    } as unknown as Body;
    paintSurfaceOnto(c, body, 'raw');
    const out = document.createElement('canvas');
    out.width = out.height = px;
    const o = out.getContext('2d');
    if (!o) return null;
    o.imageSmoothingQuality = 'high';
    o.drawImage(src, 0, 0, px, px);
    return out.toDataURL('image/png');
  } catch {
    return null;
  }
}

function remember(key: string, url: string | null) {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

function runSlice() {
  scheduled = false;
  const t0 = performance.now();
  let painted = 0;
  // Newest first: what the player is looking at now.
  for (const key of [...queue.keys()].reverse()) {
    const job = queue.get(key)!;
    queue.delete(key);
    remember(key, paint(job.b, job.px));
    painted++;
    if (performance.now() - t0 > SLICE_MS) break;
  }
  if (painted) for (const fn of [...listeners]) fn();
  if (queue.size) schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(runSlice, { timeout: 120 });
  else window.setTimeout(runSlice, 16);
}

/** A PNG data URL of the world's face, `px` square, when it is painted;
 *  null while it waits (or where no canvas exists: tests, very old
 *  browsers). Components that show it call useArtTick to redraw when it
 *  arrives. */
export function worldArt(b: ArtKey, px = 96): string | null {
  const key = `${b.id}|${b.type}|${b.color}|${b.surface}|${px}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Recently used: to the back of the line for eviction.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (typeof window === 'undefined') return null;
  queue.delete(key);
  queue.set(key, { b: { id: b.id, type: b.type, color: b.color, surface: b.surface }, px });
  while (queue.size > QUEUE_MAX) queue.delete(queue.keys().next().value as string);
  schedule();
  return null;
}

/** Re-render this component whenever freshly painted art arrives. */
export function useArtTick(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump(n => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
}
