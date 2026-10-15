// Every edit the Map Maker makes, as a pure function from one map to the
// next, so undo is just keeping the old map and bulk edits are loops.

import {
  type CustomMap, type MapBody, type MapBodyType, type MapYields, type MapSecret, type MapSurface, type MapBackdrop,
  TYPE_INFO, newBodyId, makeName, normalizeMap, canStartOn, secretFits, generateMap, ORBIT_LIMITS, RESOURCE_MAX, MAX_BODIES,
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

// ---- paint tools, symmetry, moods ---------------------------------------

/** Several moons at once, each just outside the last. */
export function addMoons(map: CustomMap, planetId: string, n: number, theme: string): { map: CustomMap; ids: string[] } {
  let m = map;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = addMoon(m, planetId, theme);
    m = r.map;
    ids.push(...r.ids);
  }
  return { map: m, ids };
}

/** The same placement repeated round the sun, `n` ways. */
export function placeSymmetric(
  map: CustomMap, tool: PlaceTool, orbit: number, angle: number, theme: string, n: number,
): { map: CustomMap; ids: string[] } {
  let m = map;
  const ids: string[] = [];
  for (let k = 0; k < Math.max(1, n); k++) {
    const r = placeBody(m, tool, 'sun', orbit, angle + (k * Math.PI * 2) / Math.max(1, n), theme);
    m = r.map;
    ids.push(...r.ids);
  }
  return { map: m, ids };
}

/** `n` worlds of one type spaced evenly round one orbit. */
export function ringOf(
  map: CustomMap, type: MapBodyType, n: number, orbit: number, angle: number, theme: string,
): { map: CustomMap; ids: string[] } {
  return placeSymmetric(map, type === 'moon' ? 'dwarf' : type, orbit, angle, theme, n);
}

/** A spray of asteroids, one per point. */
export function scatterAsteroids(
  map: CustomMap, points: Array<{ orbit: number; angle: number }>, theme: string,
): { map: CustomMap; ids: string[] } {
  const taken = takenNames(map);
  const ids = idsOf(map);
  const out: MapBody[] = [];
  const room = Math.max(0, MAX_BODIES - map.bodies.length);
  for (const p of points.slice(0, room)) {
    const id = newBodyId(ids);
    ids.add(id);
    const name = makeName(theme, taken, Math.random, map.bodies.length + out.length, map.sun.name);
    taken.add(name.toLowerCase());
    out.push({
      id, name, type: 'asteroid', parent: 'sun', orbit: p.orbit, angle: p.angle,
      radius: 0.5 + Math.random() * 0.6,
      yields: { metal: 2 + Math.floor(Math.random() * 3), credits: Math.floor(Math.random() * 2), science: Math.floor(Math.random() * 2) },
      color: TYPE_INFO.asteroid.color, surface: TYPE_INFO.asteroid.surface, rings: false, start: false, secret: null,
    });
  }
  return { map: normalizeMap({ ...map, bodies: [...map.bodies, ...out] }), ids: out.map(b => b.id) };
}

/**
 * Mirror a selection round the sun: `n` copies in all, each turned a
 * further 1/n of a circle, with their moons, start marks and hidden
 * discoveries -- the quick road to a fair competitive map.
 */
export function mirrorBodies(map: CustomMap, ids: Iterable<string>, n: number, theme: string): { map: CustomMap; ids: string[] } {
  const want = new Set(ids);
  // Mirror whole systems: a selected moon brings its planet.
  for (const b of map.bodies) if (want.has(b.id) && b.parent !== 'sun') want.add(b.parent);
  const roots = map.bodies.filter(b => want.has(b.id) && b.parent === 'sun');
  const src = map.bodies.filter(b => roots.some(r => r.id === b.id || r.id === b.parent));
  const taken = takenNames(map);
  const allIds = idsOf(map);
  const copies: MapBody[] = [];
  const picked: string[] = roots.map(r => r.id);
  for (let k = 1; k < Math.max(2, n); k++) {
    const remap = new Map<string, string>();
    for (const b of src) { const id = newBodyId(allIds); allIds.add(id); remap.set(b.id, id); }
    for (const b of src) {
      const name = makeName(theme, taken, Math.random, copies.length, map.sun.name);
      taken.add(name.toLowerCase());
      const id = remap.get(b.id)!;
      copies.push({
        ...b, id, name,
        parent: remap.get(b.parent) ?? b.parent,
        angle: b.parent === 'sun' ? b.angle + (k * Math.PI * 2) / n : b.angle,
      });
      if (b.parent === 'sun') picked.push(id);
    }
  }
  const room = MAX_BODIES - map.bodies.length;
  return { map: normalizeMap({ ...map, bodies: [...map.bodies, ...copies.slice(0, Math.max(0, room))] }), ids: picked };
}

export type MatchAspect = 'resources' | 'look' | 'size' | 'secret';

/** Copy chosen aspects of one world onto others. */
export function matchBodies(map: CustomMap, srcId: string, ids: Iterable<string>, aspects: Set<MatchAspect>): CustomMap {
  const src = map.bodies.find(b => b.id === srcId);
  if (!src) return map;
  const targets = new Set([...ids].filter(id => id !== srcId));
  return updateBodies(map, targets, b => ({
    ...(aspects.has('resources') && b.type !== 'rock' && src.type !== 'rock' ? { yields: { ...src.yields } } : {}),
    ...(aspects.has('look') ? { color: src.color, surface: src.surface, rings: src.rings } : {}),
    ...(aspects.has('size') ? { radius: src.radius } : {}),
    ...(aspects.has('secret') && secretFits(src.secret, b.type) && !b.start
      ? { secret: src.secret ?? null, secretName: src.secretName, secretText: src.secretText } : {}),
  }));
}

/** A whole-map style in one click. */
export interface Mood {
  id: string; label: string; blurb: string;
  sun: string; backdrop: MapBackdrop;
  /** surfaces a rocky world may take (one picked per world) */
  rocky: MapSurface[];
  giants: string[]; ice: string[]; small: string;
}
export const MOODS: Mood[] = [
  { id: 'garden', label: 'Garden', blurb: 'Green worlds and blue seas under a warm sun.', sun: '#ffd180', backdrop: 'emerald',
    rocky: ['verdant', 'verdant', 'ocean'], giants: ['#d4a574', '#e0c08a'], ice: ['#73c2d6'], small: '#a0a6ad' },
  { id: 'ice-age', label: 'Ice Age', blurb: 'A pale sun and frozen worlds.', sun: '#fff1d6', backdrop: 'blue',
    rocky: ['ice', 'ice', 'barren'], giants: ['#c6d8e0', '#a9c8ff'], ice: ['#cfe8f2', '#9fd3e6'], small: '#d6e4ea' },
  { id: 'hellscape', label: 'Hellscape', blurb: 'Molten crusts round a red star.', sun: '#ff9b5e', backdrop: 'crimson',
    rocky: ['lava', 'lava', 'rocky'], giants: ['#c1440e', '#a8562a'], ice: ['#8a5a6b'], small: '#6b5a52' },
  { id: 'dunes', label: 'Desert Worlds', blurb: 'Sand seas and dry rock, scorched gold.', sun: '#ffd180', backdrop: 'amber',
    rocky: ['desert', 'desert', 'rocky'], giants: ['#e0c08a', '#c98b5a'], ice: ['#c9b48a'], small: '#b8a080' },
  { id: 'bloom', label: 'Toxic Bloom', blurb: 'Acid greens under a violet sky.', sun: '#a9c8ff', backdrop: 'violet',
    rocky: ['toxic', 'toxic', 'ocean'], giants: ['#9ab83c', '#7a9a5c'], ice: ['#6fa8c9'], small: '#8a9a7a' },
  { id: 'classic', label: 'Classic', blurb: 'Every world back to the plain look of its type.', sun: '#ffd180', backdrop: 'deep',
    rocky: [], giants: [], ice: [], small: '' },
];

export function applyMood(map: CustomMap, mood: Mood, ids?: Iterable<string> | null): CustomMap {
  const only = ids ? new Set(ids) : null;
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const next = updateBodies(map, map.bodies.filter(b => !only || only.has(b.id)).map(b => b.id), b => {
    if (mood.id === 'classic') {
      const info = TYPE_INFO[b.type];
      return { color: info.color, surface: info.surface };
    }
    if (b.type === 'gas-giant') return { color: pick(mood.giants), surface: 'gas' };
    if (b.type === 'ice-giant') return { color: pick(mood.ice), surface: 'storm' };
    if (b.type === 'asteroid' || b.type === 'rock') return { color: mood.small };
    if (b.type === 'moon' && Math.random() < 0.6) return { color: mood.small, surface: mood.rocky.includes('ice') ? 'ice' : 'barren' };
    const s = pick(mood.rocky);
    return { surface: s, color: colorForSurface(s, b.color) };
  });
  if (only) return next;
  return { ...next, sun: { ...next.sun, color: mood.sun }, settings: { ...next.settings, backdrop: mood.backdrop } };
}

/**
 * Re-roll half the system: the inner or the outer worlds (split at the
 * middle of the sun's worlds) are replaced by freshly generated ones in
 * the same span of orbits, keeping as many start worlds as were there.
 */
export function rerollZone(map: CustomMap, zone: 'inner' | 'outer', theme: string): { map: CustomMap; ids: string[] } {
  const kids = map.bodies.filter(b => b.parent === 'sun' && b.type !== 'asteroid' && b.type !== 'rock').sort((a, b) => a.orbit - b.orbit);
  if (kids.length < 2) return { map, ids: [] };
  const half = Math.ceil(kids.length / 2);
  const split = Math.sqrt(kids[half - 1].orbit * kids[Math.min(half, kids.length - 1)].orbit);
  const inZone = (o: number) => (zone === 'inner' ? o <= split : o > split);
  const gone = new Set(map.bodies.filter(b => b.parent === 'sun' && inZone(b.orbit)).map(b => b.id));
  for (const b of map.bodies) if (gone.has(b.parent)) gone.add(b.id);
  const removed = map.bodies.filter(b => gone.has(b.id) && b.parent === 'sun');
  const worlds = removed.filter(b => b.type !== 'asteroid' && b.type !== 'rock');
  if (!worlds.length) return { map, ids: [] };
  const starts = map.bodies.filter(b => gone.has(b.id) && b.start).length;
  const lo = Math.min(...removed.map(b => b.orbit)), hi = Math.max(...removed.map(b => b.orbit));
  const gen = generateMap({
    theme, planets: Math.max(2, worlds.length), belts: removed.some(b => b.type === 'asteroid') ? 1 : 0, starts: 2,
  });
  const gKids = gen.bodies.filter(b => b.parent === 'sun');
  const gLo = Math.min(...gKids.map(b => b.orbit)), gHi = Math.max(...gKids.map(b => b.orbit));
  const span = (o: number) => {
    if (gHi <= gLo || hi <= lo) return lo;
    const f = Math.log(o / gLo) / Math.log(gHi / gLo);
    return lo * Math.pow(hi / lo, f);
  };
  const keep = map.bodies.filter(b => !gone.has(b.id));
  const taken = new Set([map.sun.name, ...keep.map(b => b.name)].map(n => n.toLowerCase()));
  const allIds = new Set(keep.map(b => b.id));
  const remap = new Map<string, string>();
  for (const b of gen.bodies) { const id = newBodyId(allIds); allIds.add(id); remap.set(b.id, id); }
  const fresh: MapBody[] = gen.bodies.map((b, i) => {
    let name = b.name;
    if (taken.has(name.toLowerCase())) name = makeName(theme, taken, Math.random, i, map.sun.name);
    taken.add(name.toLowerCase());
    return { ...b, id: remap.get(b.id)!, name, parent: remap.get(b.parent) ?? 'sun', orbit: b.parent === 'sun' ? span(b.orbit) : b.orbit, start: false };
  });
  // As many start worlds as the zone had, on its roomiest worlds.
  const cands = fresh.filter(b => canStartOn(b.type) && b.parent === 'sun').sort((a, b) => b.radius - a.radius);
  for (const b of cands.slice(0, starts)) { b.start = true; b.secret = null; b.yields.science = Math.max(2, b.yields.science); }
  return { map: normalizeMap({ ...map, bodies: [...keep, ...fresh] }), ids: fresh.filter(b => b.parent === 'sun').map(b => b.id) };
}
