// ============================================================
// World-menu body readout — MULTIPLAYER ONLY.
//
// Assembles the full top-panel readout (spec E1) from real game
// state: owner faction, population, defense, ships in orbit,
// city/station integrity, per-tick yields (via settlementYield, so
// building boosts are the game's own math), local stockpile, and
// the neighbor list that becomes the tappable sky orbs.
// ============================================================

import { Body, Settlement, Ship } from '../../types';
import { ProductionBundle } from '../economy';
import { buildingLevel, settlementYield } from '../settlements';
import {
  YieldMultipliers, NEUTRAL_YIELD, applyYieldMultipliers,
} from '../yieldMultipliers';

export interface BodyReadout {
  ownerFactionId: string | null;
  pop: number;
  defense: number;
  shipCount: number;
  city: { name: string; hp: number; maxHp: number; settlementId: string } | null;
  station: { name: string; hp: number; maxHp: number; settlementId: string } | null;
  yields: ProductionBundle;
  stockpile: ProductionBundle;
  hasCollector: boolean;
}

const zeroBundle = (): ProductionBundle => ({ fuel: 0, ore: 0, credits: 0, science: 0 });

/** Everything the menu's top panel shows for one body, from the
 *  viewer's perspective. Settlements not owned by `viewerFactionId`
 *  contribute to owner/defense display but not to yields/stockpile
 *  (you can't read a rival's books). */
export function readoutFor(
  body: Body,
  settlements: Settlement[],
  ships: Ship[],
  viewerFactionId: string,
  /** Empire-wide multipliers the tick applies on top of each
   *  settlement's own output (Industry tech, Senate yield laws).
   *  Defaults to neutral so SP and older callers are unchanged. */
  yieldMul: YieldMultipliers = NEUTRAL_YIELD,
): BodyReadout {
  const here = settlements.filter(s => s.bodyId === body.id);
  const mine = here.filter(s => s.ownedBy === viewerFactionId);

  // Owner = the faction holding settlements here (first one wins; mixed
  // occupancy is rare and the map already color-codes it).
  const ownerFactionId = here.length ? here[0].ownedBy : null;

  let pop = 0;
  let defense = 0;
  const yields = zeroBundle();
  const stockpile = zeroBundle();
  let city: BodyReadout['city'] = null;
  let station: BodyReadout['station'] = null;
  let hasCollector = false;

  // Defense = station return-fire only. Cities never fire, and a station
  // has no guns until a Weapons module is built; damage then scales with
  // its level. Mirrors the server (worker/room.js
  // STATION_DMG_PER_WEAPONS_LEVEL) so the DEFENSE readout matches what a
  // station will actually deal.
  const STATION_DMG_PER_WEAPONS_LEVEL = 8;

  for (const s of here) {
    pop += s.population;
    if (s.type === 'station') {
      defense += buildingLevel(s, 'weapons') * STATION_DMG_PER_WEAPONS_LEVEL;
    }
    if (s.type === 'city' && !city) {
      city = { name: s.name, hp: s.hp, maxHp: s.maxHp, settlementId: s.id };
    }
    if (s.type === 'station' && !station) {
      station = { name: s.name, hp: s.hp, maxHp: s.maxHp, settlementId: s.id };
    }
  }
  for (const s of mine) {
    // The rate the tick pays, not the settlement's bare output — the
    // menu is quoted against the Economy tab constantly.
    const y = applyYieldMultipliers(settlementYield(s, body), yieldMul);
    yields.fuel += y.fuel; yields.ore += y.ore; yields.credits += y.credits; yields.science += y.science;
    stockpile.fuel += s.stockpile.fuel; stockpile.ore += s.stockpile.ore;
    stockpile.credits += s.stockpile.credits; stockpile.science += s.stockpile.science;
    if (s.hasCollector) hasCollector = true;
  }

  const shipCount = ships.filter(
    sh => !sh.transit && sh.orbit?.parentBodyId === body.id,
  ).length;

  return { ownerFactionId, pop, defense, shipCount, city, station, yields, stockpile, hasCollector };
}

/**
 * Neighbor bodies for the menu's tappable sky orbs (spec D1):
 * a moon sees its parent + siblings; a planet sees its moons.
 * Null-safe (spec C6): unknown/absent ids return [].
 */
export function neighborsOf(bodyId: string | null | undefined, bodies: Body[]): Body[] {
  if (!bodyId) return [];
  const body = bodies.find(b => b.id === bodyId);
  if (!body) return [];
  if (body.parent && body.parent !== 'sol') {
    const parent = bodies.find(b => b.id === body.parent);
    const siblings = bodies.filter(b => b.parent === body.parent && b.id !== bodyId);
    return parent ? [parent, ...siblings] : siblings;
  }
  return bodies.filter(b => b.parent === bodyId);
}
