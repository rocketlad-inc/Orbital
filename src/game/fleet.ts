// ============================================================
// Fleet System — Group ships, move together, stack/split
// ============================================================

import { Ship, Fleet } from '../types';
import { getShipClass, ShipClassName } from './shipClasses';

let fleetCounter = 0;

/** Create a new fleet from ships at the same location */
export function formFleet(name: string, shipIds: string[], allShips: Ship[]): Fleet | null {
  const ships = allShips.filter(s => shipIds.includes(s.id));
  if (ships.length < 2) return null;

  // All ships must be at the same parent body and not in transit
  const parentId = ships[0].orbit.parentBodyId;
  if (ships.some(s => s.orbit.parentBodyId !== parentId || s.transit)) return null;

  // All ships must be same faction
  const faction = ships[0].ownedBy;
  if (ships.some(s => s.ownedBy !== faction)) return null;

  fleetCounter++;
  return {
    id: `fleet-${Date.now()}-${fleetCounter}`,
    name,
    shipIds: ships.map(s => s.id),
    leadShipId: ships[0].id,
    ownedBy: faction,
  };
}

/** Calculate fleet speed modifier (slowest ship in fleet) */
export function fleetSpeedModifier(fleet: Fleet, allShips: Ship[]): number {
  const ships = allShips.filter(s => fleet.shipIds.includes(s.id));
  if (ships.length === 0) return 1.0;

  return Math.max(...ships.map(s => {
    const classDef = getShipClass(s.class as ShipClassName);
    return classDef.speedModifier;
  }));
}

/** Get fleet composition summary */
export function fleetComposition(fleet: Fleet, allShips: Ship[]): Record<string, number> {
  const ships = allShips.filter(s => fleet.shipIds.includes(s.id));
  const counts: Record<string, number> = {};
  for (const ship of ships) {
    counts[ship.class] = (counts[ship.class] || 0) + 1;
  }
  return counts;
}

/** Get total fleet stats */
export function fleetStats(fleet: Fleet, allShips: Ship[]): {
  totalFirepower: number;
  totalHp: number;
  avgPdc: number;
  totalCargo: number;
  shipCount: number;
} {
  const ships = allShips.filter(s => fleet.shipIds.includes(s.id));
  let totalFirepower = 0;
  let totalHp = 0;
  let totalPdc = 0;
  let totalCargo = 0;

  for (const ship of ships) {
    const classDef = getShipClass(ship.class as ShipClassName);
    totalFirepower += classDef.firepower;
    totalHp += ship.hp ?? classDef.hp;
    totalPdc += classDef.pdcRating;
    totalCargo += classDef.cargoCapacity;
  }

  return {
    totalFirepower,
    totalHp,
    avgPdc: ships.length > 0 ? totalPdc / ships.length : 0,
    totalCargo,
    shipCount: ships.length,
  };
}

/** Split a ship out of a fleet */
export function splitFromFleet(fleet: Fleet, shipId: string): Fleet | null {
  const remaining = fleet.shipIds.filter(id => id !== shipId);
  if (remaining.length < 2) return null; // fleet dissolves below 2

  return {
    ...fleet,
    shipIds: remaining,
    leadShipId: fleet.leadShipId === shipId ? remaining[0] : fleet.leadShipId,
  };
}

/** Merge two fleets (must be same faction, same location) */
export function mergeFleets(a: Fleet, b: Fleet, allShips: Ship[]): Fleet | null {
  if (a.ownedBy !== b.ownedBy) return null;

  // Check same location
  const shipA = allShips.find(s => s.id === a.shipIds[0]);
  const shipB = allShips.find(s => s.id === b.shipIds[0]);
  if (!shipA || !shipB) return null;
  if (shipA.orbit.parentBodyId !== shipB.orbit.parentBodyId) return null;
  if (shipA.transit || shipB.transit) return null;

  const merged = [...new Set([...a.shipIds, ...b.shipIds])];
  fleetCounter++;
  return {
    id: `fleet-${Date.now()}-${fleetCounter}`,
    name: a.name,
    shipIds: merged,
    leadShipId: a.leadShipId,
    ownedBy: a.ownedBy,
  };
}
