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
import { BUILDING_DEFS, SETTLEMENT_DEFS, buildingLevel, settlementYield } from '../settlements';

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

  const weaponsDmg = BUILDING_DEFS.weapons.combatBoost?.damagePerLevel ?? 4;

  for (const s of here) {
    pop += s.population;
    defense += SETTLEMENT_DEFS[s.type].damagePerTick + buildingLevel(s, 'weapons') * weaponsDmg;
    if (s.type === 'city' && !city) {
      city = { name: s.name, hp: s.hp, maxHp: s.maxHp, settlementId: s.id };
    }
    if (s.type === 'station' && !station) {
      station = { name: s.name, hp: s.hp, maxHp: s.maxHp, settlementId: s.id };
    }
  }
  for (const s of mine) {
    const y = settlementYield(s, body);
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
