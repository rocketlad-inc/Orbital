// ============================================================
// Combat System — Auto-resolve at bodies + intercept in transit
// ============================================================

import { Ship, Body } from '../types';
import { getShipClass, ShipClassName } from './shipClasses';

export interface CombatResult {
  attackerLosses: string[];   // ship IDs destroyed
  defenderLosses: string[];   // ship IDs destroyed
  attackerDamage: Map<string, number>; // shipId -> damage taken
  defenderDamage: Map<string, number>;
  log: string[];              // human-readable combat log
}

/**
 * Check for hostile ships at the same body and resolve combat.
 * Called each tick from the game loop.
 */
export function checkCombatAtBodies(
  ships: Ship[],
  _bodies: Body[],
): CombatResult[] {
  const results: CombatResult[] = [];

  // Group non-transit ships by parent body
  const byBody = new Map<string, Ship[]>();
  for (const ship of ships) {
    if (ship.transfer) continue; // in transit, skip body combat
    if ((ship.hp ?? getShipClass(ship.class as ShipClassName).hp) <= 0) continue;
    const key = ship.orbit.parentBodyId;
    if (!byBody.has(key)) byBody.set(key, []);
    byBody.get(key)!.push(ship);
  }

  // Check each body for hostile encounters
  for (const [, bodyShips] of byBody) {
    const factions = new Set(bodyShips.map(s => s.ownedBy));
    if (factions.size < 2) continue; // no hostiles

    // Find all faction pairs that are hostile
    const factionList = Array.from(factions);
    for (let i = 0; i < factionList.length; i++) {
      for (let j = i + 1; j < factionList.length; j++) {
        const fA = factionList[i];
        const fB = factionList[j];
        // For now, all factions are hostile to each other
        const attackers = bodyShips.filter(s => s.ownedBy === fA);
        const defenders = bodyShips.filter(s => s.ownedBy === fB);

        if (attackers.length > 0 && defenders.length > 0) {
          const result = resolveCombat(attackers, defenders);
          results.push(result);
        }
      }
    }
  }

  return results;
}

/**
 * Resolve combat between two groups of ships.
 * Simultaneous exchange: both sides fire, then damage is applied.
 */
function resolveCombat(
  attackers: Ship[],
  defenders: Ship[],
): CombatResult {
  const log: string[] = [];
  const attackerDamage = new Map<string, number>();
  const defenderDamage = new Map<string, number>();
  const attackerLosses: string[] = [];
  const defenderLosses: string[] = [];

  // Calculate total firepower for each side
  let atkFirepower = 0;
  let defFirepower = 0;
  let atkAvgPdc = 0;
  let defAvgPdc = 0;

  for (const s of attackers) {
    const cls = getShipClass(s.class as ShipClassName);
    atkFirepower += cls.firepower;
    atkAvgPdc += cls.pdcRating;
  }
  for (const s of defenders) {
    const cls = getShipClass(s.class as ShipClassName);
    defFirepower += cls.firepower;
    defAvgPdc += cls.pdcRating;
  }

  atkAvgPdc = attackers.length > 0 ? atkAvgPdc / attackers.length : 0;
  defAvgPdc = defenders.length > 0 ? defAvgPdc / defenders.length : 0;

  // Attackers fire on defenders
  const atkDamageDealt = atkFirepower * (1 - defAvgPdc);
  // Defenders fire on attackers
  const defDamageDealt = defFirepower * (1 - atkAvgPdc);

  log.push(`Combat: ${attackers.length} vs ${defenders.length} ships`);

  // Distribute damage across enemy ships (spread evenly, focus weakest first)
  distributeDamage(defenders, atkDamageDealt, defenderDamage, defenderLosses, log);
  distributeDamage(attackers, defDamageDealt, attackerDamage, attackerLosses, log);

  return { attackerLosses, defenderLosses, attackerDamage, defenderDamage, log };
}

function distributeDamage(
  targets: Ship[],
  totalDamage: number,
  damageMap: Map<string, number>,
  losses: string[],
  log: string[],
) {
  if (targets.length === 0 || totalDamage <= 0) return;

  // Sort by HP ascending (focus fire on weakest)
  const sorted = [...targets].sort((a, b) => {
    const hpA = a.hp ?? getShipClass(a.class as ShipClassName).hp;
    const hpB = b.hp ?? getShipClass(b.class as ShipClassName).hp;
    return hpA - hpB;
  });

  let remaining = totalDamage;
  for (const ship of sorted) {
    if (remaining <= 0) break;
    const currentHp = ship.hp ?? getShipClass(ship.class as ShipClassName).hp;
    const dmg = Math.min(remaining, currentHp + 10); // slight overkill allowed
    damageMap.set(ship.id, dmg);
    remaining -= dmg;

    if (dmg >= currentHp) {
      losses.push(ship.id);
      log.push(`${ship.name} destroyed!`);
    } else {
      log.push(`${ship.name} took ${dmg.toFixed(0)} damage`);
    }
  }
}

/**
 * Apply combat results to ship array, returning updated ships.
 * Destroyed ships are removed. Damaged ships get reduced HP.
 */
export function applyCombatResults(
  ships: Ship[],
  results: CombatResult[],
): Ship[] {
  if (results.length === 0) return ships;

  const allLosses = new Set<string>();
  const allDamage = new Map<string, number>();

  for (const result of results) {
    for (const id of result.attackerLosses) allLosses.add(id);
    for (const id of result.defenderLosses) allLosses.add(id);
    for (const [id, dmg] of result.attackerDamage) {
      allDamage.set(id, (allDamage.get(id) || 0) + dmg);
    }
    for (const [id, dmg] of result.defenderDamage) {
      allDamage.set(id, (allDamage.get(id) || 0) + dmg);
    }
  }

  return ships
    .filter(s => !allLosses.has(s.id))
    .map(s => {
      const dmg = allDamage.get(s.id);
      if (dmg && !allLosses.has(s.id)) {
        const maxHp = getShipClass(s.class as ShipClassName).hp;
        const currentHp = s.hp ?? maxHp;
        return { ...s, hp: Math.max(0, currentHp - dmg) };
      }
      return s;
    });
}
