// ============================================================
// Visibility / Fog of War
// ----------------------------------------------------------------
// Each faction's view of the game is constrained by orbital
// dynamics: you can only see enemy ships that lie within a
// friendly asset's sensor range AND aren't occluded by a body.
//
// All bodies, orbits, and settlements remain visible to everyone
// (they're lit, hot, or just plain huge). Fog applies to ships
// only — that's where intel and scouting are gameplay-relevant.
// ============================================================

import { Body, Ship, Settlement } from '../types';
import { bodyPosition, orbitWorldPos } from '../physics/orbitalMechanics';
import { bezierPositionAt } from '../physics/bezierTransfer';
import { settlementWorldPosition } from './settlements';

// === Sensor ranges (world units) ============================

/** Sensor range per ship class. Solar system spans ~460 units. */
export const SHIP_SENSOR_RANGE: Record<string, number> = {
  corvette: 150,   // light scout
  frigate: 200,    // balanced warship
  destroyer: 175,  // heavy weapons, less sensor budget
  freighter: 100,  // civilian
};

/** Sensor range per settlement type. */
export const SETTLEMENT_SENSOR_RANGE: Record<string, number> = {
  city: 250,       // ground-based array — surveys its whole local neighborhood
  station: 400,    // dedicated orbital platform — sees most of the inner system
};

/** Multiplier on body radius for occlusion (accounts for atmosphere/grazing). */
const OCCLUSION_FACTOR = 1.1;

/** Sol occludes a much wider zone than its visible disk (corona, plasma). */
const SOL_OCCLUSION_RADIUS = 35;

/** Ticks a last-known ghost remains rendered before it fades to nothing. */
export const GHOST_LIFETIME_TICKS = 50;

/**
 * Ticks after a burn during which a ship has an elevated thermal/EM
 * signature. Engines flare; the plume is much easier to detect than a
 * cold coasting hull.
 */
export const BURN_SIGNATURE_DURATION = 15;

/**
 * Maximum sensor-range multiplier applied immediately after a burn,
 * decaying linearly to 1.0 over BURN_SIGNATURE_DURATION ticks. A boost
 * of 2.5 means a corvette at peak burn flare is detectable from 375
 * units instead of 150 — long-range scouting can pick up enemy
 * transfers committing across the system.
 */
export const BURN_SIGNATURE_BOOST = 2.5;

// === Geometry helpers ========================================

/**
 * Does the line segment from A to B pass through the disk of radius r centered
 * at C? Uses closest-point-on-line. Works in 2D (the game is top-down).
 */
function segmentIntersectsDisk(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  r: number,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    // A and B coincident — just distance check
    const d2 = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
    return d2 < r * r;
  }
  // Project C onto AB, clamped to [0, 1]
  let t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const d2 = (px - c.x) ** 2 + (py - c.y) ** 2;
  return d2 < r * r;
}

/**
 * Is the line of sight from sensor S to target T blocked by any body?
 * Bodies that the sensor or target is sitting on/near are skipped so a
 * ship in low orbit doesn't get occluded by its host body.
 */
function isOccluded(
  sensorPos: { x: number; y: number },
  targetPos: { x: number; y: number },
  bodies: Body[],
  tick: number,
): boolean {
  for (const body of bodies) {
    const bp = bodyPosition(body, tick, bodies);
    const occR = body.id === 'sol'
      ? SOL_OCCLUSION_RADIUS
      : body.radius * OCCLUSION_FACTOR;

    // If sensor or target is very close to (or inside) this body, don't let
    // it block its own host's signal
    const distSensor = Math.hypot(sensorPos.x - bp.x, sensorPos.y - bp.y);
    const distTarget = Math.hypot(targetPos.x - bp.x, targetPos.y - bp.y);
    if (distSensor < occR + 1 || distTarget < occR + 1) continue;

    if (segmentIntersectsDisk(sensorPos, targetPos, bp, occR)) {
      return true;
    }
  }
  return false;
}

// === Position helpers ========================================

/** Get the world position of a ship at the current tick. */
export function shipWorldPosition(ship: Ship, tick: number, bodies: Body[]): { x: number; y: number } {
  if (ship.transfer) return bezierPositionAt(ship.transfer, tick);
  return orbitWorldPos(ship.orbit, tick, bodies);
}

// === Sensor source enumeration ===============================

/**
 * All sensor sources for a faction: ships + settlements. Returns
 * an array of {pos, range} pairs evaluated at the current tick.
 */
function factionSensors(
  viewerFactionIds: Set<string>,
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
): Array<{ pos: { x: number; y: number }; range: number }> {
  const sensors: Array<{ pos: { x: number; y: number }; range: number }> = [];

  for (const s of ships) {
    if (!viewerFactionIds.has(s.ownedBy)) continue;
    // Even ships in transit have working sensors.
    const range = SHIP_SENSOR_RANGE[s.class] ?? 25;
    sensors.push({ pos: shipWorldPosition(s, tick, bodies), range });
  }

  for (const st of settlements) {
    if (!viewerFactionIds.has(st.ownedBy)) continue;
    const range = SETTLEMENT_SENSOR_RANGE[st.type] ?? 40;
    const pos = settlementWorldPosition(st, tick, bodies);
    if (pos) sensors.push({ pos, range });
  }

  return sensors;
}

/**
 * Multiplier on a target ship's effective detectability, based on how
 * recently it burned its engines. Returns 1.0 for a cold coasting ship,
 * up to BURN_SIGNATURE_BOOST immediately after a burn, decaying linearly
 * over BURN_SIGNATURE_DURATION.
 */
export function burnSignatureFactor(ship: Ship, tick: number): number {
  if (ship.lastBurnTick === undefined) return 1.0;
  const age = tick - ship.lastBurnTick;
  if (age < 0 || age >= BURN_SIGNATURE_DURATION) return 1.0;
  const freshness = 1 - age / BURN_SIGNATURE_DURATION;
  return 1 + (BURN_SIGNATURE_BOOST - 1) * freshness;
}

// === Visibility computation ==================================

export interface VisibilityResult {
  /** IDs of ships currently visible to the viewing faction. */
  visibleShipIds: Set<string>;
  /**
   * Map of shipId -> last-known intel. Includes ships that ARE currently
   * visible (their `tick` matches current tick) and ones that were seen
   * within GHOST_LIFETIME_TICKS.
   */
  lastSeen: Map<string, { x: number; y: number; tick: number; shipClass: string; ownedBy: string }>;
}

/**
 * Compute what the viewer can currently see.
 *
 * `viewerFactionIds` is the set of factions whose sensors and assets count as
 * "ours" — typically the player plus any allied factions sharing intel via
 * a defense or intel-share pact. Anything owned by a faction in this set is
 * always visible. Anything else is visible only if at least one of the
 * viewer's sensors has it in range AND no body blocks the line of sight.
 *
 * Recently-burning enemy ships (lastBurnTick within BURN_SIGNATURE_DURATION)
 * have their effective detection range boosted by burnSignatureFactor — a
 * hot exhaust plume is visible from much further away than a cold hull.
 *
 * Previous lastSeen entries are passed in so they can be carried forward
 * (and aged) when the ship is no longer directly visible.
 */
export function computeVisibility(
  viewerFactionIds: Set<string>,
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
  previousLastSeen: Map<string, { x: number; y: number; tick: number; shipClass: string; ownedBy: string }>,
): VisibilityResult {
  const visibleShipIds = new Set<string>();
  const lastSeen = new Map<string, { x: number; y: number; tick: number; shipClass: string; ownedBy: string }>();

  const sensors = factionSensors(viewerFactionIds, ships, settlements, bodies, tick);

  for (const ship of ships) {
    // Friendlies (own + allied) always visible
    if (viewerFactionIds.has(ship.ownedBy)) {
      visibleShipIds.add(ship.id);
      continue;
    }

    const tp = shipWorldPosition(ship, tick, bodies);
    const sigFactor = burnSignatureFactor(ship, tick);

    let seen = false;
    for (const s of sensors) {
      const dx = s.pos.x - tp.x;
      const dy = s.pos.y - tp.y;
      const d2 = dx * dx + dy * dy;
      const effectiveRange = s.range * sigFactor;
      if (d2 > effectiveRange * effectiveRange) continue;
      if (isOccluded(s.pos, tp, bodies, tick)) continue;
      seen = true;
      break;
    }

    if (seen) {
      visibleShipIds.add(ship.id);
      lastSeen.set(ship.id, {
        x: tp.x,
        y: tp.y,
        tick,
        shipClass: ship.class,
        ownedBy: ship.ownedBy,
      });
    } else {
      // Carry forward previous sighting if still fresh
      const prev = previousLastSeen.get(ship.id);
      if (prev && tick - prev.tick < GHOST_LIFETIME_TICKS) {
        lastSeen.set(ship.id, prev);
      }
    }
  }

  return { visibleShipIds, lastSeen };
}

// === Allied faction resolution ===============================

/**
 * Minimal Pact shape — duplicated here (rather than imported from the
 * multiplayer API module) so this game-logic file stays free of UI deps.
 */
export interface PactLike {
  kind: string;          // 'defense_pact' | 'intel_share' | 'nap' | ...
  status: string;        // 'active' | 'expired' | 'broken'
  counterparty_faction_ids: string[];
}

/**
 * Build the set of factions whose sensors should count for `viewer`'s
 * intel: the viewer itself plus anyone currently in a defense pact or
 * an intel-share pact with them. Returns at minimum `{viewer}`.
 *
 * Pact data is optional — when no pacts are passed (e.g. single-player
 * scenarios) the result is just the viewer alone.
 */
export function alliedFactions(viewer: string, pacts?: PactLike[]): Set<string> {
  const out = new Set<string>([viewer]);
  if (!pacts) return out;
  for (const p of pacts) {
    if (p.status !== 'active') continue;
    if (p.kind !== 'defense_pact' && p.kind !== 'intel_share') continue;
    if (!p.counterparty_faction_ids.includes(viewer)) continue;
    for (const id of p.counterparty_faction_ids) {
      if (id !== viewer) out.add(id);
    }
  }
  return out;
}

// === Sensor range query (for rendering coverage rings) =======

/**
 * Return per-sensor world positions and ranges for a faction. Useful for
 * drawing translucent coverage rings on the map.
 */
export function factionSensorRings(
  viewerFactionIds: Set<string>,
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
): Array<{ pos: { x: number; y: number }; range: number; sourceType: 'ship' | 'city' | 'station' }> {
  const rings: Array<{ pos: { x: number; y: number }; range: number; sourceType: 'ship' | 'city' | 'station' }> = [];

  for (const s of ships) {
    if (!viewerFactionIds.has(s.ownedBy)) continue;
    const range = SHIP_SENSOR_RANGE[s.class] ?? 25;
    rings.push({ pos: shipWorldPosition(s, tick, bodies), range, sourceType: 'ship' });
  }

  for (const st of settlements) {
    if (!viewerFactionIds.has(st.ownedBy)) continue;
    const range = SETTLEMENT_SENSOR_RANGE[st.type] ?? 40;
    const pos = settlementWorldPosition(st, tick, bodies);
    if (pos) rings.push({ pos, range, sourceType: st.type });
  }

  return rings;
}
