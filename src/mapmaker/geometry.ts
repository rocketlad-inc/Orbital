// Where things draw in the Map Maker. A star system spans Mercury (144)
// to past Sedna (~14000), so true distances cram the inner planets into a
// dot; the default view compresses distance (a square root) so every world
// has room, and "True distances" shows the real thing.

import type { CustomMap, MapBody } from '../game/customMap';

export type Scale = 'compressed' | 'true';

const K_SUN = 30;    // compressed: display = K * sqrt(orbit)
const K_MOON = 6;

/** Drawn radius of a body's disc, in display units. */
export function discR(b: Pick<MapBody, 'type' | 'radius'>): number {
  if (b.type === 'rock') return 4;
  if (b.type === 'asteroid') return 3 + b.radius * 2;
  return 4 + b.radius * 3;
}
export function sunR(map: CustomMap): number {
  return map.sun.size * 1.2;
}

/** Display distance of an orbit from its parent's centre. */
export function orbitToDisplay(map: CustomMap, b: MapBody, scale: Scale): number {
  if (b.parent === 'sun') return scale === 'true' ? b.orbit * 0.6 : K_SUN * Math.sqrt(b.orbit);
  const p = map.bodies.find(x => x.id === b.parent);
  const base = p ? discR(p) : 10;
  return base + (scale === 'true' ? b.orbit : K_MOON * Math.sqrt(b.orbit));
}

/** Inverse of orbitToDisplay, for dragging and placing. */
export function displayToOrbit(map: CustomMap, parent: string, d: number, scale: Scale): number {
  if (parent === 'sun') return scale === 'true' ? d / 0.6 : Math.pow(Math.max(0, d) / K_SUN, 2);
  const p = map.bodies.find(x => x.id === parent);
  const base = p ? discR(p) : 10;
  const rest = Math.max(0, d - base);
  return scale === 'true' ? rest : Math.pow(rest / K_MOON, 2);
}

/** Display position of a body (sun at 0,0). `t` advances every world
 *  along its orbit, for the motion preview: radians per year. */
export function displayPos(
  map: CustomMap, b: MapBody, scale: Scale, spin: (b: MapBody) => number = () => 0,
): { x: number; y: number } {
  const a = b.angle + spin(b);
  const r = orbitToDisplay(map, b, scale);
  if (b.parent === 'sun') return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  const p = map.bodies.find(x => x.id === b.parent);
  const pp = p ? displayPos(map, p, scale, spin) : { x: 0, y: 0 };
  return { x: pp.x + Math.cos(a) * r, y: pp.y + Math.sin(a) * r };
}

/** Display radius of an orbit round the sun (a sector's edge). */
export function sunOrbitToDisplay(orbit: number, scale: Scale): number {
  return scale === 'true' ? orbit * 0.6 : K_SUN * Math.sqrt(Math.max(0, orbit));
}

/** The furthest anything draws from the sun, for "Fit system". */
export function systemExtent(map: CustomMap, scale: Scale): number {
  let ext = sunR(map) * 2;
  for (const b of map.bodies) {
    if (b.parent !== 'sun') continue;
    ext = Math.max(ext, orbitToDisplay(map, b, scale) + discR(b) + 40);
  }
  for (const s of map.sectors) ext = Math.max(ext, sunOrbitToDisplay(s.outer, scale) + 20);
  return ext;
}
