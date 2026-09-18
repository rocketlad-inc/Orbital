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
//
// THIS CONSTANT IS THE BASE, NOT THE ANSWER. It was the whole story when
// the map was spread 2x once, for every game. It stopped being the whole
// story when system_scale became a per-game knob: the server multiplies
// these numbers by the game's own spread, and this file did not, so at
// system_scale 4 the server revealed ships out to 3200 while the client
// culled them at 800 and drew an 800 ring. The tighter number wins, so
// the player got a quarter of the vision they had actually paid for.
//
// runtimeSensorScale carries the server's TOTAL multiplier. Read it
// through sensorScale() — never multiply by SENSOR_SCALE directly.
const SENSOR_SCALE = 2;

let runtimeSensorScale = 1;

/**
 * Adopt the sensor multiplier the SERVER used for this game
 * (game.sensor_scale on the state payload = system_scale x sensor_scale).
 *
 * Defaults to 1, which reproduces the old behaviour exactly, so an
 * un-plumbed caller or a single-player board is unaffected.
 */
export function setSensorScale(scale: number): void {
  runtimeSensorScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The multiplier in force. Exported for tests and the HUD. */
export function sensorScale(): number {
  return runtimeSensorScale;
}

/** Sensor reach of a ship class, in world units, at this game's scale. */
export function shipSensorRange(shipClass: string): number {
  return (SHIP_SENSOR_RANGE[shipClass] ?? 25) * runtimeSensorScale;
}

/** Sensor reach of a settlement type, in world units, at this game's scale. */
export function settlementSensorRangeFor(type: string): number {
  return (SETTLEMENT_SENSOR_RANGE[type] ?? 40) * runtimeSensorScale;
}

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
    const range = shipSensorRange(s.class);
    sensors.push({ pos: shipWorldPosition(s, tick, bodies, drawnTransitPos), range });
  }

  for (const st of settlements) {
    if (!isFriendly(st.ownedBy, factionId, allies)) continue;
    const range = settlementSensorRangeFor(st.type);
    const pos = settlementWorldPosition(st, tick, bodies);
    if (pos) sensors.push({ pos, range });
  }

  return sensors;
}

// === Visibility computation ==================================

export interface VisibilityResult {
  /** IDs of ships currently visible to the viewing faction. */
  visibleShipIds: Set<string>;
}

/**
 * Compute what `viewerFactionId` can currently see.
 *
 * Friendlies are always visible. Enemies are visible only if at least one of
 * the viewer's sensors has them in range AND no body blocks the line of sight.
 *
 * Contact is PRESENT TENSE. There is no memory here: a hull you cannot
 * currently see is simply absent from the result. The last-known "ghost"
 * marker this used to feed was removed, and with it the intel records
 * that only ever existed to paint it.
 */
export function computeVisibility(
  viewerFactionId: string,
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
  alliedFactionIds: ReadonlySet<string> = NO_ALLIES,
  drawnTransitPos?: ReadonlyMap<string, { x: number; y: number }>,
): VisibilityResult {
  const visibleShipIds = new Set<string>();

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

    if (seen) visibleShipIds.add(ship.id);
  }

  return { visibleShipIds };
}

/**
 * MULTIPLAYER visibility: the payload IS the fog.
 *
 * The MP server already fogs /state — a rival ship is in `ships` only if
 * the server decided the caller can see it. The client then re-ran
 * computeVisibility on top, which is a SECOND, DIFFERENT fog: it
 * positions sensors on their orbits where the server uses body centres,
 * and it applies an occlusion test (including a 35-unit Sol disk) that
 * the server does not have at all. Two approximations of the same rule
 * can only agree or disagree, and near a range boundary they disagree
 * for real stretches — measured on a live game: Mercury drifting across
 * a station's 800-range at ±35 units while moving 6.5 units/tick, and a
 * viewer whose own line to Mercury crossed the Sol occlusion disk. In
 * the gap the payload contains a ship the client refuses to draw, so a
 * hull the server says you can see blinks out, its count badge with it
 * ("a flickering ship around Mercury at all zoom levels").
 *
 * So in MP: every ship in the payload is visible, full stop. Nothing
 * else remains client-side. This used to also keep GHOST bookkeeping —
 * where a rival was last seen after the server stopped sending it — for
 * a last-known marker on the map. That marker is gone, so the records
 * are too: a hull the server withholds is simply not on the map.
 *
 * SP keeps computeVisibility unchanged — there is no server there, the
 * local fog is the only fog.
 */
export function payloadVisibility(ships: Ship[]): VisibilityResult {
  return { visibleShipIds: new Set(ships.map(s => s.id)) };
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
    const range = shipSensorRange(s.class);
    rings.push({ pos: shipWorldPosition(s, tick, bodies, drawnTransitPos), range, sourceType: 'ship' });
  }

  for (const st of settlements) {
    if (!isFriendly(st.ownedBy, factionId, allies)) continue;
    const range = settlementSensorRangeFor(st.type);
    const pos = settlementWorldPosition(st, tick, bodies);
    if (pos) rings.push({ pos, range, sourceType: st.type });
  }

  return rings;
}
