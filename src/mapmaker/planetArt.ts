// A world in the Map Maker wears the art the game will paint on it: the
// same painter (paintSurfaceOnto) fed the id the game will give it
// (`cm_<id>`), so the continents and craters you see here are the ones
// players see in the game.

import { paintSurfaceOnto, TEX_SIZE } from '../render/planetTexture';
import type { Body } from '../types';
import type { MapBody, MapBodyType } from '../game/customMap';

const GAME_TYPE: Record<MapBodyType, Body['type']> = {
  terrestrial: 'terrestrial', 'gas-giant': 'gas_giant', 'ice-giant': 'ice_giant',
  dwarf: 'dwarf', moon: 'moon', asteroid: 'asteroid', rock: 'meteoroid',
};

const cache = new Map<string, string | null>();
const CACHE_MAX = 800;

/** A PNG data URL of the world's face, `px` square, or null where no
 *  canvas exists (tests, very old browsers). */
export function worldArt(b: Pick<MapBody, 'id' | 'type' | 'color' | 'surface'>, px = 96): string | null {
  const key = `${b.id}|${b.type}|${b.color}|${b.surface}|${px}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let url: string | null = null;
  try {
    const src = document.createElement('canvas');
    src.width = src.height = TEX_SIZE;
    const c = src.getContext('2d');
    if (c) {
      const body = {
        id: `cm_${b.id}`, name: '', type: GAME_TYPE[b.type], color: b.color,
        look: { surface: b.surface },
      } as unknown as Body;
      paintSurfaceOnto(c, body, 'raw');
      const out = document.createElement('canvas');
      out.width = out.height = px;
      const o = out.getContext('2d');
      if (o) {
        o.imageSmoothingQuality = 'high';
        o.drawImage(src, 0, 0, px, px);
        url = out.toDataURL('image/png');
      }
    }
  } catch {
    url = null;
  }
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, url);
  return url;
}
