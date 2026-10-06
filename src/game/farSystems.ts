// ============================================================
// The far systems' own rules, client side.
//
// Centauri is a binary: two suns pour twice the light on anything in
// orbit, so a STATION there yields double (Lorne, 2026-10-06). Mirrors
// BINARY_SYSTEM_TEMPLATE_IDS / BINARY_STATION_MUL in worker/systems.js,
// held together by src/game/__tests__/farSystems.test.ts.
// ============================================================

import type { Body } from '../types';
import { bodyPosition } from '../physics/orbitalMechanics';

export const BINARY_SYSTEM_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  'verdant', 'thistle', 'sorrel', 'crimson', 'prismara', 'scoria', 'umber',
  'cinder', 'clinker', 'farspire', 'flint', 'tinder', 'ember', 'pyrite',
]);

export const BINARY_STATION_MUL = 2;

/** The worlds that orbit ONE sun ("two homes"): Verdant and its moons
 *  around A, Cinder and Clinker around B. MIRROR of
 *  BINARY_INNER_TEMPLATE_IDS in worker/systems.js. */
export const BINARY_INNER_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  'verdant', 'thistle', 'sorrel', 'cinder', 'clinker',
]);
/** A station around one sun: x1.5 with the suns furthest apart, x3 as
 *  they swing closest. MIRRORS worker/systems.js. */
export const INNER_STATION_MUL_FAR = 1.5;
export const INNER_STATION_MUL_NEAR = 3;

/** How close Centauri's suns are, 0 (furthest) .. 1 (closest), from
 *  Centauri A's own orbit -- the same number worker/binaryDance.js gets
 *  from the same Kepler solve. 0.5 when there is no dance. */
export function binaryClosenessFrom(bodies: Body[], tick: number): number {
  const a = bodies.find(b => templateOf(b.id) === 'centauri_a');
  if (!a || a.orbit_rp == null || a.orbit_ra == null || !(a.orbit_ra > a.orbit_rp)) return 0.5;
  const parent = bodies.find(b => b.id === a.parent);
  const p = bodyPosition(a, tick, bodies);
  const c = parent ? bodyPosition(parent, tick, bodies) : { x: 0, y: 0 };
  const r = Math.hypot(p.x - c.x, p.y - c.y);
  return Math.max(0, Math.min(1, (a.orbit_ra - r) / (a.orbit_ra - a.orbit_rp)));
}

/** The dance as of the last /state, set by the multiplayer provider so
 *  every yield readout (settlementYield) follows it without each caller
 *  having to know the tick. */
let currentCloseness = 0.5;
export function setBinaryCloseness(c: number): void {
  currentCloseness = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
}
export function getBinaryCloseness(): number { return currentCloseness; }

/** Catalogue id of a client body (ids arrive stripped, but tolerate a
 *  game prefix the way templateIdOf does). */
function templateOf(id: string): string {
  const i = id.lastIndexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

export function isBinarySystemBody(body: Pick<Body, 'id'>): boolean {
  return BINARY_SYSTEM_TEMPLATE_IDS.has(templateOf(body.id));
}

/** What a station's yield is multiplied by at this body: 1 outside
 *  Centauri, x2 around both suns, x1.5..x3 with the dance around one. */
export function binaryStationMul(body: Pick<Body, 'id'>, closeness = currentCloseness): number {
  if (!isBinarySystemBody(body)) return 1;
  if (!BINARY_INNER_TEMPLATE_IDS.has(templateOf(body.id))) return BINARY_STATION_MUL;
  const c = Math.max(0, Math.min(1, closeness));
  return INNER_STATION_MUL_FAR + (INNER_STATION_MUL_NEAR - INNER_STATION_MUL_FAR) * c;
}

// ---- the sun gates' landing sites (worker/sunGates.js) -----------------

/** A sun gate's landing site: a point in empty space on the orbit the
 *  gate will stop on, there to be flown to while the gate is in flight. */
export function isSunGateSite(body: Pick<Body, 'id'> | null | undefined): boolean {
  return !!body && /^sungate_[a-z]+_site$/.test(templateOf(body.id));
}

/** A sun gate still flying out of the Sun at `tick`. It cannot be a
 *  transfer target until it lands (worker/actions.js): its site can. */
export function isGateInFlight(body: Pick<Body, 'type' | 'emerge'> | null | undefined, tick: number): boolean {
  return !!body && body.type === 'megastructure' && !!body.emerge && tick < body.emerge.untilTick;
}

/** The landing site of a gate, by id (same prefix, `_site` appended). */
export function landingSiteIdOf(gateId: string): string {
  return `${gateId}_site`;
}
