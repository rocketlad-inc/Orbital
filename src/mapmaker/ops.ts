// Every edit the Map Maker makes, as a pure function from one map to the
// next, so undo is just keeping the old map and bulk edits are loops.

import {
  type CustomMap, type MapBody, type MapBodyType, type MapYields, type MapSecret,
  TYPE_INFO, newBodyId, makeName, normalizeMap, canStartOn, secretFits, ORBIT_LIMITS, RESOURCE_MAX,
} from '../game/customMap';
import type { PlaceTool } from './MapView';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function takenNames(map: CustomMap): Set<string> {
  return new Set([map.sun.name, ...map.bodies.map(b => b.name)].map(n => n.toLowerCase()));
}

function idsOf(map: CustomMap): Set<string> {
  return new Set(map.bodies.map(b => b.id));
}

const SURFACE_COLOR: Record<string, string> = {
  verdant: '#4f8a3c', ocean: '#2f8fd6', desert: '#c9a36b', rocky: '#9a8a78', barren: '#a0a6ad',
  ice: '#cfe8f2', lava: '#d65a2a', toxic: '#9ab83c', gas: '#d4a574', storm: '#6fa8c9',
};
export function colorForSurface(surface: string | null, fallback: string): string {
  return (surface && SURFACE_COLOR[surface]) || fallback;
}

/** A new body of `tool`, named in `theme`; a belt is a ring of asteroids. */
export function placeBody(
  map: CustomMap, tool: PlaceTool, parent: string, orbit: number, angle: number, theme: string,
): { map: CustomMap; ids: string[] } {
  const taken = takenNames(map);
  const ids = idsOf(map);
  const out: MapBody[] = [];
  const mk = (type: MapBodyType, o: number, a: number, extra: Partial<MapBody> = {}): MapBody => {
    const info = TYPE_INFO[type];
    const id = newBodyId(ids);
    ids.add(id);
    const name = makeName(theme, taken, Math.random, map.bodies.length + out.length, map.sun.name);
    taken.add(name.toLowerCase());
    const lim = parent === 'sun' ? ORBIT_LIMITS.sun : ORBIT_LIMITS.moon;
    return {
      id, name, type, parent: type === 'moon' ? parent : 'sun',
      orbit: clamp(o, lim[0], lim[1]), angle: a, radius: info.radius[2],
      yields: type === 'rock' ? { metal: 0, credits: 0, science: 0 }
        : type === 'terrestrial' ? { metal: 3, credits: 3, science: 3 }
          : type === 'gas-giant' ? { metal: 1, credits: 6, science: 2 }
            : type === 'ice-giant' ? { metal: 1, credits: 2, science: 5 }
              : { metal: 3, credits: 1, science: 1 },
      color: info.color, surface: info.surface, rings: false, start: false, secret: null,
      ...(type === 'rock' ? { mineral: { kind: 'metal' as const, tons: 1200 } } : {}),
      ...extra,
    };
  };
  if (tool === 'belt') {
    const n = 8;
    for (let i = 0; i < n; i++) {
      out.push(mk('asteroid', orbit * (0.97 + Math.random() * 0.06), angle + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.3,
        { radius: 0.5 + Math.random() * 0.5 }));
    }
  } else {
    out.push(mk(tool, orbit, angle));
  }
  return { map: normalizeMap({ ...map, bodies: [...map.bodies, ...out] }), ids: out.map(b => b.id) };
}

/** A new moon for a planet, just outside its outermost moon. */
export function addMoon(map: CustomMap, planetId: string, theme: string): { map: CustomMap; ids: string[] } {
  const moons = map.bodies.filter(b => b.parent === planetId);
  const p = map.bodies.find(b => b.id === planetId);
  const orbit = moons.length ? Math.max(...moons.map(m => m.orbit)) * 1.45 + 4 : (p ? p.radius * 4 + 10 : 20);
  return placeBody(map, 'moon', planetId, orbit, Math.random() * Math.PI * 2, theme);
}

export function updateBodies(map: CustomMap, ids: Iterable<string>, fn: (b: MapBody) => Partial<MapBody>): CustomMap {
  const set = new Set(ids);
  return normalizeMap({ ...map, bodies: map.bodies.map(b => (set.has(b.id) ? { ...b, ...fn(b) } : b)) });
}

/** Delete bodies, and the moons of any planet deleted. */
export function deleteBodies(map: CustomMap, ids: Iterable<string>): CustomMap {
  const gone = new Set(ids);
  for (const b of map.bodies) if (gone.has(b.parent)) gone.add(b.id);
  return normalizeMap({ ...map, bodies: map.bodies.filter(b => !gone.has(b.id)) });
}

/** Copies a little further along their orbits, with their moons. */
export function duplicateBodies(map: CustomMap, ids: Iterable<string>, theme: string): { map: CustomMap; ids: string[] } {
  const want = new Set(ids);
  const taken = takenNames(map);
  const allIds = idsOf(map);
  const remap = new Map<string, string>();
  const copies: MapBody[] = [];
  const src = map.bodies.filter(b => want.has(b.id) || (want.has(b.parent)));
  for (const b of src) { const id = newBodyId(allIds); allIds.add(id); remap.set(b.id, id); }
  const picked: string[] = [];
  for (const b of src) {
    const name = makeName(theme, taken, Math.random, copies.length, map.sun.name);
    taken.add(name.toLowerCase());
    const id = remap.get(b.id)!;
    copies.push({
      ...b, id, name,
      parent: remap.get(b.parent) ?? b.parent,
      angle: want.has(b.id) && b.parent === 'sun' ? b.angle + 0.5 : b.angle,
      start: false,
    });
    if (want.has(b.id)) picked.push(id);
  }
  return { map: normalizeMap({ ...map, bodies: [...map.bodies, ...copies] }), ids: picked };
}

export type ResMode = 'set' | 'add' | 'multiply' | 'range';
export type ResKey = keyof MapYields;

/**
 * Bulk resources. Per resource: set it, add to it, multiply it, or roll
 * it in a range. "Keep character" makes a range roll keep each world's
 * rank: the richest stays the richest, it just lands somewhere new.
 */
export function bulkResources(
  map: CustomMap, ids: Iterable<string>,
  rows: Partial<Record<ResKey, { on: boolean; a: number; b: number }>>,
  mode: ResMode, keepCharacter: boolean,
): CustomMap {
  const set = new Set(ids);
  const targets = map.bodies.filter(b => set.has(b.id) && b.type !== 'rock');
  const next = new Map<string, MapYields>(targets.map(b => [b.id, { ...b.yields }]));
  for (const key of ['metal', 'credits', 'science'] as ResKey[]) {
    const row = rows[key];
    if (!row?.on) continue;
    if (mode === 'range') {
      const lo = Math.min(row.a, row.b), hi = Math.max(row.a, row.b);
      const draws = targets.map(() => Math.round(lo + Math.random() * (hi - lo)));
      if (keepCharacter) {
        draws.sort((x, y) => x - y);
        const order = [...targets].sort((x, y) => x.yields[key] - y.yields[key]);
        order.forEach((b, i) => { next.get(b.id)![key] = draws[i]; });
      } else {
        targets.forEach((b, i) => { next.get(b.id)![key] = draws[i]; });
      }
    } else {
      for (const b of targets) {
        const y = next.get(b.id)!;
        y[key] = mode === 'set' ? row.a : mode === 'add' ? y[key] + row.a : Math.round(y[key] * row.a);
      }
    }
    for (const y of next.values()) y[key] = clamp(Math.round(y[key]), 0, RESOURCE_MAX);
  }
  return updateBodies(map, set, b => (next.has(b.id) ? { yields: next.get(b.id)! } : {}));
}

/** Spread the sun's worlds in the selection evenly between the innermost
 *  and outermost of them, keeping their order. */
export function spaceEvenly(map: CustomMap, ids: Iterable<string>): CustomMap {
  const set = new Set(ids);
  const ring = map.bodies.filter(b => set.has(b.id) && b.parent === 'sun').sort((a, b) => a.orbit - b.orbit);
  if (ring.length < 3) return map;
  const lo = ring[0].orbit, hi = ring[ring.length - 1].orbit;
  // Even on a log scale, like real systems: each orbit a fixed ratio out.
  const ratio = Math.pow(hi / lo, 1 / (ring.length - 1));
  const target = new Map(ring.map((b, i) => [b.id, lo * Math.pow(ratio, i)]));
  return updateBodies(map, set, b => (target.has(b.id) ? { orbit: target.get(b.id)! } : {}));
}

export function renameByTheme(map: CustomMap, ids: Iterable<string>, theme: string): CustomMap {
  const set = new Set(ids);
  const taken = new Set([map.sun.name, ...map.bodies.filter(b => !set.has(b.id)).map(b => b.name)].map(n => n.toLowerCase()));
  let i = 0;
  const names = new Map<string, string>();
  for (const b of map.bodies) {
    if (!set.has(b.id)) continue;
    const n = makeName(theme, taken, Math.random, i++, map.sun.name);
    taken.add(n.toLowerCase());
    names.set(b.id, n);
  }
  return updateBodies(map, set, b => ({ name: names.get(b.id)! }));
}

/** One colour for all, or each a little different around a base. */
export function recolor(map: CustomMap, ids: Iterable<string>, color: string, vary: boolean): CustomMap {
  const n = parseInt(color.slice(1), 16);
  const jitter = () => {
    if (!vary) return color;
    const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (Math.random() - 0.5) * 70)));
    const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  };
  return updateBodies(map, ids, () => ({ color: jitter() }));
}

export function markStart(map: CustomMap, ids: Iterable<string>, on: boolean): CustomMap {
  return updateBodies(map, ids, b => ({ start: on && canStartOn(b.type) }));
}

export function setSecret(map: CustomMap, ids: Iterable<string>, kind: MapSecret | 'random' | null): CustomMap {
  return updateBodies(map, ids, b => ({ secret: secretFits(kind, b.type) ? kind : b.secret ?? null }));
}

export function scaleSize(map: CustomMap, ids: Iterable<string>, factor: number): CustomMap {
  return updateBodies(map, ids, b => ({ radius: b.radius * factor }));
}

/** Change a world's type, keeping what still makes sense. A moon turned
 *  into a planet leaves its planet for the sun, at its planet's orbit. */
export function changeType(map: CustomMap, id: string, type: MapBodyType): CustomMap {
  const b = map.bodies.find(x => x.id === id);
  if (!b || b.type === type) return map;
  const info = TYPE_INFO[type];
  const patch: Partial<MapBody> = {
    type, radius: info.radius[2], surface: info.surface, color: info.color,
  };
  if (b.type === 'moon' && type !== 'moon') {
    const p = map.bodies.find(x => x.id === b.parent);
    patch.parent = 'sun';
    patch.orbit = p ? p.orbit * 1.12 : 500;
  }
  if (type === 'rock') patch.mineral = { kind: 'metal', tons: 1200 };
  return updateBodies(map, [id], () => patch);
}

/** A resource preset. */
export const PRESETS: Array<{ label: string; y: MapYields }> = [
  { label: 'Barren', y: { metal: 1, credits: 0, science: 0 } },
  { label: 'Balanced', y: { metal: 4, credits: 4, science: 4 } },
  { label: 'Rich', y: { metal: 8, credits: 8, science: 8 } },
  { label: 'Metal world', y: { metal: 12, credits: 2, science: 2 } },
  { label: 'Credit world', y: { metal: 2, credits: 12, science: 2 } },
  { label: 'Research world', y: { metal: 2, credits: 2, science: 12 } },
];
