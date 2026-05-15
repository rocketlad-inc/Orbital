// ============================================================
// Combat System — Auto-resolve at bodies + player-initiated engagements
// ============================================================

import { Ship, Body } from '../types';
import { getShipClass, ShipClassName } from './shipClasses';
import { bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { bezierPositionAt } from '../physics/bezierTransfer';

/** Ticks between damage applications during an active engagement */
export const COMBAT_DAMAGE_INTERVAL = 5;

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
 * Compute the world position of a ship at the given tick.
 * Handles both orbiting ships (parent body + local orbit) and ships in transit (Bezier).
 */
export function shipWorldPosition(
  ship: Ship,
  tick: number,
  bodies: Body[],
): { x: number; y: number } | null {
  if (ship.transfer) {
    return bezierPositionAt(ship.transfer, tick);
  }
  const parent = bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!parent) return null;
  const parentPos = bodyPosition(parent, tick, bodies);
  const localPos = localPositionAt(ship.orbit, tick);
  return { x: parentPos.x + localPos.x, y: parentPos.y + localPos.y };
}

/**
 * Compute the Euclidean distance between two ships in world space.
 * Returns Infinity if either ship's position cannot be computed.
 */
export function shipDistance(
  shipA: Ship,
  shipB: Ship,
  tick: number,
  bodies: Body[],
): number {
  const posA = shipWorldPosition(shipA, tick, bodies);
  const posB = shipWorldPosition(shipB, tick, bodies);
  if (!posA || !posB) return Infinity;
  return Math.hypot(posA.x - posB.x, posA.y - posB.y);
}

/**
 * Process player-initiated engagements. For each ship with an active
 * `engagedTargetId`, deal damage to the target if it's within range and
 * the combat-damage cooldown has elapsed.
 *
 * Returns an updated ship array (with reduced HP, removed-if-destroyed ships,
 * and cleared engagements where the target is gone) plus a combat log.
 */
export function processEngagements(
  ships: Ship[],
  bodies: Body[],
  tick: number,
): { ships: Ship[]; log: string[] } {
  const log: string[] = [];
  const damageMap = new Map<string, number>(); // shipId → total damage taken
  const destroyed = new Set<string>();
  const lastCombatUpdates = new Map<string, number>(); // shipId → new lastCombatTick

  // Index ships for quick lookup
  const byId = new Map<string, Ship>();
  for (const s of ships) byId.set(s.id, s);

  // First pass: compute damage from all active engagements
  for (const attacker of ships) {
    if (!attacker.engagedTargetId) continue;
    const target = byId.get(attacker.engagedTargetId);
    if (!target) continue; // target gone — will be cleared in second pass

    const attackerClass = getShipClass(attacker.class as ShipClassName);
    if (attackerClass.range <= 0 || attackerClass.damagePerTick <= 0) continue;

    const lastFired = attacker.lastCombatTick ?? -Infinity;
    if (tick - lastFired < COMBAT_DAMAGE_INTERVAL) continue;

    const dist = shipDistance(attacker, target, tick, bodies);
    if (dist > attackerClass.range) continue; // out of range — no damage this pass

    // Deal damage, reduced by target's PDC
    const targetClass = getShipClass(target.class as ShipClassName);
    const dmg = attackerClass.damagePerTick * (1 - targetClass.pdcRating);
    damageMap.set(target.id, (damageMap.get(target.id) || 0) + dmg);
    lastCombatUpdates.set(attacker.id, tick);
    log.push(`${attacker.name} hits ${target.name} for ${dmg.toFixed(0)} (${dist.toFixed(1)}u)`);
  }

  // Determine which ships are destroyed
  for (const [shipId, dmg] of damageMap) {
    const s = byId.get(shipId);
    if (!s) continue;
    const maxHp = getShipClass(s.class as ShipClassName).hp;
    const currentHp = s.hp ?? maxHp;
    if (dmg >= currentHp) {
      destroyed.add(shipId);
      log.push(`${s.name} destroyed!`);
    }
  }

  // Second pass: build updated ship array
  const updated = ships
    .filter(s => !destroyed.has(s.id))
    .map(s => {
      let next = s;
      // Apply damage
      const dmg = damageMap.get(s.id);
      if (dmg !== undefined) {
        const maxHp = getShipClass(s.class as ShipClassName).hp;
        const currentHp = s.hp ?? maxHp;
        next = { ...next, hp: Math.max(0, currentHp - dmg) };
      }
      // Update lastCombatTick for ships that fired
      const newLastCombat = lastCombatUpdates.get(s.id);
      if (newLastCombat !== undefined) {
        next = { ...next, lastCombatTick: newLastCombat };
      }
      // Clear engagement if target was destroyed or no longer exists
      if (next.engagedTargetId) {
        if (destroyed.has(next.engagedTargetId) || !byId.has(next.engagedTargetId)) {
          next = { ...next, engagedTargetId: undefined };
        }
      }
      return next;
    });

  return { ships: updated, log };
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
