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
import { settlementWorldPosition } from './settlements';

// === Sensor ranges (world units) ============================

// Ranges are scaled alongside SYSTEM_SCALE in worker/factions.js. The
// Sol system was spread 2x; leaving sensors at their old absolute values
// would have silently doubled the fog — a stealth nerf to every scout
// and station that nobody asked for. Scaling them keeps visibility the
// same FRACTION of the board it always was.
// KEEP IN SYNC with worker/state.js (server mirror of this table).
const SENSOR_SCALE = 2;

/** Sensor range per ship class. Solar system spans ~920 units (post-scale). */
export const SHIP_SENSOR_RANGE: Record<string, number> = {
  corvette: 150 * SENSOR_SCALE,   // light scout
  frigate: 200 * SENSOR_SCALE,    // balanced warship
  destroyer: 175 * SENSOR_SCALE,  // heavy weapons, less sensor budget
  freighter: 100 * SENSOR_SCALE,  // civilian
  colony: 75 * SENSOR_SCALE,      // settler transport — minimal nav sensors
};

/** Sensor range per settlement type. */
export const SETTLEMENT_SENSOR_RANGE: Record<string, number> = {
  city: 250 * SENSOR_SCALE,       // ground-based array — surveys its whole local neighborhood
  station: 400 * SENSOR_SCALE,    // dedicated orbital platform — sees most of the inner system
};

/** Multiplier on body radius for occlusion (accounts for atmosphere/grazing). */
const OCCLUSION_FACTOR = 1.1;

/** Sol occludes a much wider zone than its visible disk (corona, plasma). */
const SOL_OCCLUSION_RADIUS = 35;

/** Ticks a last-known ghost remains rendered before it fades to nothing. */
export const GHOST_LIFETIME_TICKS = 50;

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

/** Get the world position of a ship at the current tick.
 *
 *  Priority order matches the ship's possible states:
 *    1. Torch transit — read ship.transit.pos directly
 *    2. Parked — evaluate ship.orbit around its parent body
 */
export function shipWorldPosition(
  ship: Ship,
  tick: number,
  bodies: Body[],
  drawnTransitPos?: ReadonlyMap<string, { x: number; y: number }>,
): { x: number; y: number } {
  // Prefer the position the RENDERER actually drew this hull at. For a
  // ship in transit, ship.transit.pos is a separate integration that
  // drifts away from the polyline the renderer lerps along — MapCanvas
  // already had to route the click hit-test around it for exactly this
  // reason (see transitShipCanvasPosRef, "not the diverging
  // ship.transit.pos integration").
  //
  // Sensor rings were still reading the diverging value, so the fog hole
  // was punched ahead of the hull it belongs to: a lit circle sitting off
  // in front of the ship, revealing empty space.
  const drawn = ship.transit ? drawnTransitPos?.get(ship.id) : undefined;
  if (drawn) return { x: drawn.x, y: drawn.y };
  if (ship.transit) return { x: ship.transit.pos.x, y: ship.transit.pos.y };
  return orbitWorldPos(ship.orbit, tick, bodies);
}

// === Friendly-faction helper ================================
//
// Allies share sensors + vision: an allied faction's ships/settlements
// act as the viewer's own for fog-of-war. `alliedFactionIds` is empty
// in single-player (no alliances) and carries the active
// defense-pact / intel-share partners in multiplayer.

const NO_ALLIES: ReadonlySet<string> = new Set();

function isFriendly(ownedBy: string, viewer: string, allies: ReadonlySet<string>): boolean {
  return ownedBy === viewer || allies.has(ownedBy);
}

// === Sensor source enumeration ===============================

/**
 * All sensor sources for a faction (and its allies): ships +
 * settlements. Returns {pos, range} pairs evaluated at the current tick.
 */
function factionSensors(
  factionId: string,
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
  allies: ReadonlySet<string> = NO_ALLIES,
  drawnTransitPos?: ReadonlyMap<string, { x: number; y: number }>,
): Array<{ pos: { x: number; y: number }; range: number }> {
  const sensors: Array<{ pos: { x: number; y: number }; range: number }> = [];

  for (const s of ships) {
    if (!isFriendly(s.ownedBy, factionId, allies)) continue;
    // Even ships in transit have working sensors.
    const range = SHIP_SENSOR_RANGE[s.class] ?? 25;
    sensors.push({ pos: shipWorldPosition(s, tick, bodies, drawnTransitPos), range });
  }

  for (const st of settlements) {
    if (!isFriendly(st.ownedBy, factionId, allies)) continue;
    const range = SETTLEMENT_SENSOR_RANGE[st.type] ?? 40;
    const pos = settlementWorldPosition(st, tick, bodies);
    if (pos) sensors.push({ pos, range });
  }

  return sensors;
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
 * Compute what `viewerFactionId` can currently see.
 *
 * Friendlies are always visible. Enemies are visible only if at least one of
 * the viewer's sensors has them in range AND no body blocks the line of sight.
 *
 * Previous lastSeen entries are passed in so they can be carried forward
 * (and aged) when the ship is no longer directly visible.
 */
export function computeVisibility(
  viewerFactionId: string,
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
  previousLastSeen: Map<string, { x: number; y: number; tick: number; shipClass: string; ownedBy: string }>,
  alliedFactionIds: ReadonlySet<string> = NO_ALLIES,
  drawnTransitPos?: ReadonlyMap<string, { x: number; y: number }>,
): VisibilityResult {
  const visibleShipIds = new Set<string>();
  const lastSeen = new Map<string, { x: number; y: number; tick: number; shipClass: string; ownedBy: string }>();

  const sensors = factionSensors(viewerFactionId, ships, settlements, bodies, tick, alliedFactionIds, drawnTransitPos);

  for (const ship of ships) {
    // Friendlies (own + allied) always visible
    if (isFriendly(ship.ownedBy, viewerFactionId, alliedFactionIds)) {
      visibleShipIds.add(ship.id);
      continue;
    }

    const tp = shipWorldPosition(ship, tick, bodies, drawnTransitPos);

    let seen = false;
    for (const s of sensors) {
      const dx = s.pos.x - tp.x;
      const dy = s.pos.y - tp.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > s.range * s.range) continue;
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

// === Sensor range query (for rendering coverage rings) =======

/**
 * Return per-sensor world positions and ranges for a faction. Useful for
 * drawing translucent coverage rings on the map.
 */
export function factionSensorRings(
  factionId: string,
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
  allies: ReadonlySet<string> = NO_ALLIES,
  drawnTransitPos?: ReadonlyMap<string, { x: number; y: number }>,
): Array<{ pos: { x: number; y: number }; range: number; sourceType: 'ship' | 'city' | 'station' }> {
  const rings: Array<{ pos: { x: number; y: number }; range: number; sourceType: 'ship' | 'city' | 'station' }> = [];

  for (const s of ships) {
    if (!isFriendly(s.ownedBy, factionId, allies)) continue;
    const range = SHIP_SENSOR_RANGE[s.class] ?? 25;
    rings.push({ pos: shipWorldPosition(s, tick, bodies, drawnTransitPos), range, sourceType: 'ship' });
  }

  for (const st of settlements) {
    if (!isFriendly(st.ownedBy, factionId, allies)) continue;
    const range = SETTLEMENT_SENSOR_RANGE[st.type] ?? 40;
    const pos = settlementWorldPosition(st, tick, bodies);
    if (pos) rings.push({ pos, range, sourceType: st.type });
  }

  return rings;
}
