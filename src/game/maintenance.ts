// ============================================================
// Maintenance — Repair and refuel ships at owned bodies
// ============================================================

import { Ship, Body, Settlement } from '../types';
import { getShipClass, ShipClassName } from './shipClasses';
import { buildingLevel } from './settlements';
import { rankHpMul } from './techs';
import { countPart, REPAIR_TENDER_PER_BAY } from './shipParts';

/** HP/tick a friendly Repair Bay parked in the same orbit contributes.
 *  Re-exported under the maintenance module's naming so this file reads
 *  consistently; the value lives in shipParts.ts next to the part. */
export const REPAIR_PER_TICK_PER_TENDER_BAY = REPAIR_TENDER_PER_BAY;

/** Cities no longer repair hulls — repair is station-only (the
 *  orbital dry dock). Kept at 0 so any stray reference is inert. */
export const REPAIR_PER_TICK_CITY = 0;

/** HP restored per tick by a bare STATION with no shipyard on it.
 *  Stations are the sole repair source — a docked ship is patched up by
 *  station crews/auto-fabbers. Mirrors REPAIR_STATION_BASE in
 *  worker/room.js. */
export const REPAIR_PER_TICK_STATION = 5;

/** How much each SHIPYARD level MULTIPLIES the station's repair rate.
 *
 *  Was an additive +5 per level (2/7/12/17), set when hulls topped out near
 *  200 HP. Combat v2 destroyers start at 1184 before defense tech, so a
 *  wrecked one needed ~138 ticks at a level-2 yard — Lorne: "my destroyer is
 *  going to take 2 weeks to repair at my level 2 shipyard". Now geometric:
 *  bare 2, L1 6, L2 18, L3 54, L4 162.
 *
 *  Mirrors REPAIR_YARD_MULT in worker/room.js — KEEP IN SYNC. The server is
 *  authoritative; this exists so the ship panel quotes the rate the
 *  maintenance pass will actually apply, and a drift here shows up as the
 *  panel lying about a repair ETA. */
export const REPAIR_YARD_MULT = 3;

/** What the first shipyard level adds, before tripling. Mirrors
 *  REPAIR_YARD_STEP in worker/room.js — KEEP IN SYNC. */
export const REPAIR_YARD_STEP = 5;

/** Base fuel restored per tick when orbiting an owned body (no settlement) */
export const REFUEL_PER_TICK_BASE = 1;

/** Additional fuel per tick when orbiting a body with an owned station */
export const REFUEL_PER_TICK_STATION = 2;

export interface MaintenanceInfo {
  repairRate: number;   // HP per tick
  refuelRate: number;   // fuel per tick
  hasCity: boolean;
  hasStation: boolean;
  /** True when a friendly Repair Bay in this orbit has picked THIS ship as
   *  its patient (MP only — the caller has to pass `fleet`). A bay works
   *  one hull at a time, so this is a yes/no, not a count. False when
   *  unknown, so callers that don't pass a fleet are exactly as before. */
  tenderRepairing: boolean;
}

/**
 * Compute the maintenance rates available to a ship at its current location.
 *
 * Three independent rules, each contributing to the total:
 *
 *   (a) base refuel: requires the ship to be parked at an OWNED body
 *       (faction-controlled surface — basic logistics presence)
 *   (b) city repair / station refuel boost: any of YOUR settlements
 *       at the body, regardless of which faction owns the body.
 *       Lets a city you've planted on a moon someone else technically
 *       controls (settlement count tie) still service your hulls.
 *   (c) station repair: any of YOUR stations at the body, full stop.
 *       Stations are orbital infrastructure — the wrench-monkeys
 *       don't care whose flag is on the planet below.
 *
 * Previously the entire function returned zero when body.ownedBy !=
 * ship.ownedBy, which defeated the new station-heal feature for any
 * forward base on contested territory.
 */
export function maintenanceRatesForShip(
  ship: Ship,
  bodies: Body[],
  settlements: Settlement[],
  /** MP only: the ships the caller knows about, so a friendly Repair Bay
   *  parked in this orbit can pick its patient. SP's tickMaintenance passes
   *  nothing and gets the pre-tender behaviour unchanged — the SP sim has
   *  no parts at all, so there is nothing here for it to find. */
  fleet?: readonly Ship[],
  /** Effective max HP for any hull, which the tender triage needs to rank
   *  hulls by how close to death they are. Required alongside `fleet`:
   *  the real ceiling folds in faction armor tech, which this module has
   *  no access to, and guessing it would put the panel and the server on
   *  different patients. Omit both to skip tender accounting entirely. */
  maxHpOf?: (s: Ship) => number,
): MaintenanceInfo {
  const zero = {
    repairRate: 0, refuelRate: 0, hasCity: false, hasStation: false, tenderRepairing: false,
  };
  // Ships in transit get no repair/refuel — they're not at any
  // body's infrastructure.
  if (ship.transit) return zero;
  const body = bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!body) return zero;

  // Base refuel only if you actually own the body (rule a).
  let refuelRate = body.ownedBy === ship.ownedBy ? REFUEL_PER_TICK_BASE : 0;
  let repairRate = 0;
  let hasCity = false;
  let hasStation = false;
  // Rules (b) and (c): walk all settlements at this body and credit
  // each one you own. No body-ownership gate on this loop — your
  // infrastructure is your infrastructure.
  // Station-only repair: only a friendly STATION in orbit repairs a
  // hull (and refuels). Cities are surface industry — they no longer
  // heal ships. Mirrors worker/room.js maintenance. hasCity is still
  // tracked for any UI that wants to show "city present" separately.
  for (const st of settlements) {
    if (st.bodyId !== body.id) continue;
    if (st.ownedBy !== ship.ownedBy) continue;
    if (st.type === 'city') {
      hasCity = true;
    } else if (st.type === 'station') {
      hasStation = true;
      refuelRate += REFUEL_PER_TICK_STATION;
      // Bare dry dock, plus the shipyard's contribution — the yard is
      // what turns a mooring point into a repair facility.
      const yl = buildingLevel(st, 'shipyard');
      repairRate += REPAIR_PER_TICK_STATION + (yl > 0
        ? REPAIR_YARD_STEP * Math.pow(REPAIR_YARD_MULT, yl - 1)
        : 0);
    }
  }
  // Field tenders (Defense 4). Reproduces the triage in worker/room.js
  // §3.45 rather than approximating it: each friendly Repair Bay parked
  // here takes the ONE worst-off hull in the orbit and stays on it, ranked
  // by HP fraction with ship id as a stable tie-break. A panel that
  // disagreed with the server about who is being repaired would be worse
  // than one that said nothing at all.
  //
  // The ownedBy filter is what keeps a rival's tender out of your maths;
  // it also means every hull considered here is one whose loadout you can
  // actually see. partsRedacted is still checked, defensively, so a future
  // caller passing an all-ships list can't credit an enemy's bays to you.
  let tenderRepairing = false;
  if (fleet && maxHpOf) {
    const parked = fleet.filter(o =>
      o.ownedBy === ship.ownedBy
      && !o.transit
      && o.orbit.parentBodyId === body.id);
    let bays = 0;
    for (const o of parked) {
      if (o.class !== 'freighter' || o.partsRedacted) continue;
      bays += countPart(o.parts, 'repair');
    }
    if (bays > 0) {
      const patients = parked
        .filter(o => { const m = maxHpOf(o); return m > 0 && (o.hp ?? m) < m - 1e-6; })
        .sort((a, b) => {
          const fa = (a.hp ?? 0) / (maxHpOf(a) || 1);
          const fb = (b.hp ?? 0) / (maxHpOf(b) || 1);
          if (fa !== fb) return fa - fb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .slice(0, bays);
      tenderRepairing = patients.some(o => o.id === ship.id);
    }
  }
  if (tenderRepairing) repairRate += REPAIR_PER_TICK_PER_TENDER_BAY;
  return { repairRate, refuelRate, hasCity, hasStation, tenderRepairing };
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
  /** Per-faction armor-tech HP multiplier (+8%/level). Mirrors the
   *  server maintenance heal cap so armor research raises the repair
   *  ceiling in SP the same way it does in MP. Default 1.0. */
  hpMulByFaction: Record<string, number> = {},
): Ship[] {
  if (tickDelta <= 0) return ships;

  let mutated = false;
  const updated = ships.map(ship => {
    const rates = maintenanceRatesForShip(ship, bodies, settlements);
    if (rates.repairRate <= 0 && rates.refuelRate <= 0) return ship;

    const classDef = getShipClass(ship.class as ShipClassName);
    // Cap = base × rank (+1%/kill) × armor tech (+8%/level). A veteran
    // cruiser with armor research can heal into its enlarged buffer.
    const maxHp = classDef.hp * rankHpMul(ship.rank) * (hpMulByFaction[ship.ownedBy] ?? 1);
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
