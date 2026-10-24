// ============================================================
// Who can fly a route, grouped by WHERE they are.
//
// Sam, 2026-10-22, over the New Route form: "you need to know the ship
// names, where instead it could be based on location." The picker was a
// wall of name chips in build order: 26 freighters, 221 warships, two
// hulls both called Jemison-2 and two fleets both called Uranus Group.
// Nobody picks a freighter by name; they pick the one that is closest to
// the first pickup. So the free hulls are grouped by the world they are
// at (or flying to), worlds sorted by how long the trip to the route's
// first stop takes, and hulls in another star system set apart, since a
// straight-line time through a sun gate means nothing.
//
// The trip time is the planner the move orders fly (planTorchTransfer
// with the hull's own engine and the multiplayer build-up), so "about 32
// ticks out" here is the number the ship panel would quote.
// ============================================================

import type { Body, Fleet, GameState, Ship } from '../types';
import {
  orbitWorldPos, orbitWorldVelocity, bodyPosition, bodyWorldVelocity,
} from '../physics/orbitalMechanics';
import { planTorchTransfer, brakeAccelFor, mpRampFor } from '../physics/torchTransfer';
import { shipEngineAccel, fleetEngineAccel } from '../game/fleetPace';
import { makeStarSystemOf, starSystemName } from '../render/galaxyLayer';

/** Where a hull is for picking: the world it orbits, or the one it is
 *  flying to (enRoute). */
export function shipWhere(ship: Ship): { bodyId: string; enRoute: boolean } {
  if (ship.transit) return { bodyId: ship.transit.currentTransfer.targetBodyId, enRoute: true };
  return { bodyId: ship.orbit.parentBodyId, enRoute: false };
}

/** Whole ticks from where the hull is to `toId`, flown at `accel`. A hull
 *  in flight first finishes its leg. Null when there is no trip to plan
 *  (unknown body). 0 = already there. */
export function tripTicks(
  ship: Ship, toId: string, accel: number, tick: number, bodies: Body[],
): number | null {
  const where = shipWhere(ship);
  let startTick = tick;
  let pos: { x: number; y: number };
  let vel: { x: number; y: number };
  if (ship.transit) {
    startTick = Math.max(tick, ship.transit.currentTransfer.arriveTick);
    if (where.bodyId === toId) return Math.max(0, Math.ceil(startTick - tick));
    const b = bodies.find(x => x.id === where.bodyId);
    if (!b) return null;
    pos = bodyPosition(b, startTick, bodies);
    vel = bodyWorldVelocity(b, startTick, bodies);
  } else {
    if (where.bodyId === toId) return 0;
    pos = orbitWorldPos(ship.orbit, tick, bodies);
    vel = orbitWorldVelocity(ship.orbit, tick, bodies);
  }
  const plan = planTorchTransfer(
    { pos, vel }, toId, accel, brakeAccelFor(accel), startTick, bodies, 20, mpRampFor(accel),
  );
  if (!plan) return where.bodyId === toId ? 0 : null;
  return Math.max(0, Math.round(plan.arriveTick - tick));
}

export interface ShipSpot { ship: Ship; enRoute: boolean; eta: number | null }
export interface WorldGroup { bodyId: string; eta: number | null; ships: ShipSpot[] }
export interface FarGroup { systemId: string; ships: (ShipSpot & { bodyId: string })[] }

const byEtaThenName = (byId: ReadonlyMap<string, Body>) =>
  (a: { eta: number | null; bodyId: string }, b: { eta: number | null; bodyId: string }) => {
    if (a.eta != null && b.eta != null && a.eta !== b.eta) return a.eta - b.eta;
    if (a.eta != null && b.eta == null) return -1;
    if (a.eta == null && b.eta != null) return 1;
    return (byId.get(a.bodyId)?.name ?? a.bodyId)
      .localeCompare(byId.get(b.bodyId)?.name ?? b.bodyId, undefined, { sensitivity: 'base' });
  };

const byName = (a: Ship, b: Ship) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** The home system for grouping: the first stop's, else the map's root. */
function homeSystemOf(firstStopId: string | undefined, gs: GameState, systemOf: (id: string) => string | null) {
  return (firstStopId ? systemOf(firstStopId) : null)
    ?? gs.bodies.find(b => !b.parent)?.id ?? 'sol';
}

/** "Centauri" for a far system's anchor id. */
export function systemLabel(systemId: string, bodies: Body[]): string {
  const b = bodies.find(x => x.id === systemId);
  return b ? starSystemName(b) : systemId;
}

/**
 * Free hulls by world, nearest the first stop first; hulls in another
 * star system in `far`, by system. `accelOf` picks the engine (a freighter
 * flies alone; a guard flies at its fleet's pace).
 */
export function groupByWorld(
  ships: Ship[], firstStopId: string | undefined, gs: GameState,
  accelOf: (s: Ship) => number,
): { worlds: WorldGroup[]; far: FarGroup[] } {
  const byId = new Map(gs.bodies.map(b => [b.id, b]));
  const systemOf = makeStarSystemOf(gs.bodies);
  const home = homeSystemOf(firstStopId, gs, systemOf);
  const tick = gs.currentTick;
  const worlds = new Map<string, WorldGroup>();
  const far = new Map<string, FarGroup>();
  for (const ship of ships) {
    const where = shipWhere(ship);
    const sys = systemOf(where.bodyId) ?? home;
    if (sys !== home) {
      const g = far.get(sys) ?? { systemId: sys, ships: [] };
      g.ships.push({ ship, enRoute: where.enRoute, eta: null, bodyId: where.bodyId });
      far.set(sys, g);
      continue;
    }
    const eta = firstStopId ? tripTicks(ship, firstStopId, accelOf(ship), tick, gs.bodies) : null;
    const g = worlds.get(where.bodyId) ?? { bodyId: where.bodyId, eta: null, ships: [] };
    g.ships.push({ ship, enRoute: where.enRoute, eta });
    if (eta != null && (g.eta == null || eta < g.eta)) g.eta = eta;
    worlds.set(where.bodyId, g);
  }
  for (const g of worlds.values()) g.ships.sort((a, b) => byName(a.ship, b.ship));
  for (const g of far.values()) {
    g.ships.sort((a, b) => (byId.get(a.bodyId)?.name ?? '').localeCompare(byId.get(b.bodyId)?.name ?? '')
      || byName(a.ship, b.ship));
  }
  return {
    worlds: [...worlds.values()].sort(byEtaThenName(byId)),
    far: [...far.values()].sort((a, b) => systemLabel(a.systemId, gs.bodies).localeCompare(systemLabel(b.systemId, gs.bodies))),
  };
}

/** Freighters fly a route alone, at their own engine. */
export function freighterAccel(gs: GameState) {
  return (s: Ship) => shipEngineAccel(s, gs.factions, gs.factionTech);
}

export interface FleetPick {
  fleet: Fleet;
  /** The members that can guard: free warships. Picking the fleet picks these. */
  members: Ship[];
  lead: Ship;
  bodyId: string;
  enRoute: boolean;
  eta: number | null;
  /** At the first stop now. */
  here: boolean;
}

/**
 * Fleets with at least one free warship, nearest the first stop first,
 * and the free warships in no fleet. A fleet sits where its lead does.
 */
export function groupGuards(
  warships: Ship[], firstStopId: string | undefined, gs: GameState,
): { fleets: FleetPick[]; loose: { worlds: WorldGroup[]; far: FarGroup[] } } {
  const byId = new Map(gs.bodies.map(b => [b.id, b]));
  const free = new Set(warships.map(s => s.id));
  const inFleet = new Set<string>();
  const fleets: FleetPick[] = [];
  for (const fleet of gs.fleets ?? []) {
    const members = warships.filter(s => s.fleetId === fleet.id && !s.fleetDetached);
    if (members.length === 0) continue;
    for (const m of members) inFleet.add(m.id);
    const lead = members.find(m => m.id === fleet.leadShipId) ?? members[0];
    const where = shipWhere(lead);
    const eta = firstStopId
      ? tripTicks(lead, firstStopId, fleetEngineAccel(lead, gs.ships, gs.factions, gs.factionTech), gs.currentTick, gs.bodies)
      : null;
    fleets.push({
      fleet, members: [...members].sort(byName), lead,
      bodyId: where.bodyId, enRoute: where.enRoute, eta,
      here: !!firstStopId && !where.enRoute && where.bodyId === firstStopId,
    });
  }
  fleets.sort((a, b) => byEtaThenName(byId)(a, b) || b.members.length - a.members.length);
  const loose = warships.filter(s => free.has(s.id) && !inFleet.has(s.id));
  const accel = (s: Ship) => shipEngineAccel(s, gs.factions, gs.factionTech);
  return { fleets, loose: groupByWorld(loose, firstStopId, gs, accel) };
}
