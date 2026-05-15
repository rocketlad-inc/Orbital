// ============================================================
// Maintenance — Repair and refuel ships at owned bodies
// ============================================================

import { Ship, Body, Settlement } from '../types';
import { getShipClass, ShipClassName } from './shipClasses';

/** HP restored per tick when orbiting an owned body with a city */
export const REPAIR_PER_TICK_CITY = 2;

/** Base fuel restored per tick when orbiting an owned body (no settlement) */
export const REFUEL_PER_TICK_BASE = 1;

/** Additional fuel per tick when orbiting a body with an owned station */
export const REFUEL_PER_TICK_STATION = 2;

export interface MaintenanceInfo {
  repairRate: number;   // HP per tick
  refuelRate: number;   // fuel per tick
  hasCity: boolean;
  hasStation: boolean;
}

/**
 * Compute the maintenance rates available to a ship at its current location.
 * Returns zero rates if the ship is in transit or at a non-friendly body.
 */
export function maintenanceRatesForShip(
  ship: Ship,
  bodies: Body[],
  settlements: Settlement[],
): MaintenanceInfo {
  const zero = { repairRate: 0, refuelRate: 0, hasCity: false, hasStation: false };
  if (ship.transfer) return zero;
  const body = bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!body) return zero;
  if (body.ownedBy !== ship.ownedBy) return zero;

  let repairRate = 0;
  let refuelRate = REFUEL_PER_TICK_BASE;
  let hasCity = false;
  let hasStation = false;
  for (const st of settlements) {
    if (st.bodyId !== body.id) continue;
    if (st.ownedBy !== ship.ownedBy) continue;
    if (st.type === 'city') {
      hasCity = true;
      repairRate += REPAIR_PER_TICK_CITY;
    } else if (st.type === 'station') {
      hasStation = true;
      refuelRate += REFUEL_PER_TICK_STATION;
    }
  }
  return { repairRate, refuelRate, hasCity, hasStation };
}

/**
 * Apply repair and refuel to all ships orbiting friendly bodies.
 * `tickDelta` is the elapsed time since the last application — rates are
 * multiplied by this so the result is the same whether ticking smoothly or
 * jumping via updateTick.
 */
export function tickMaintenance(
  ships: Ship[],
  settlements: Settlement[],
  bodies: Body[],
  tickDelta: number,
): Ship[] {
  if (tickDelta <= 0) return ships;

  let mutated = false;
  const updated = ships.map(ship => {
    const rates = maintenanceRatesForShip(ship, bodies, settlements);
    if (rates.repairRate <= 0 && rates.refuelRate <= 0) return ship;

    const classDef = getShipClass(ship.class as ShipClassName);
    const maxHp = classDef.hp;
    const maxFuel = classDef.fuelCapacity;

    const currentHp = ship.hp ?? maxHp;
    const newHp = Math.min(maxHp, currentHp + rates.repairRate * tickDelta);
    const newFuel = Math.min(maxFuel, ship.fuel + rates.refuelRate * tickDelta);

    if (newHp === currentHp && newFuel === ship.fuel) return ship;
    mutated = true;
    return { ...ship, hp: newHp, fuel: newFuel };
  });

  return mutated ? updated : ships;
}
