// ============================================================
// Combat System — Auto-fire at every hostile in orbit, every N ticks
// ============================================================

import { Ship, Body, Settlement } from '../types';
import { getShipClass, ShipClassName } from './shipClasses';
import { bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { bezierPositionAt } from '../physics/bezierTransfer';
import { SETTLEMENT_DEFS, BUILDING_DEFS, buildingLevel } from './settlements';

/** Ticks between auto-fire volleys. Each combatant fires every N ticks. */
export const AUTO_COMBAT_INTERVAL = 20;

/**
 * World position of a ship at the given tick. Handles ships in transit
 * (Bezier) and ships orbiting (parent body + local orbit position).
 */
export function shipWorldPosition(
  ship: Ship,
  tick: number,
  bodies: Body[],
): { x: number; y: number } | null {
  // Priority order matches the ship's possible states:
  //   1. Torch transit  → ship.transit.pos directly
  //   2. Legacy Bezier  → cubic interpolation (removed in Phase 6)
  //   3. Parked         → orbit element evaluation
  if (ship.transit) {
    return { x: ship.transit.pos.x, y: ship.transit.pos.y };
  }
  if (ship.transfer) {
    return bezierPositionAt(ship.transfer, tick);
  }
  const parent = bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!parent) return null;
  const parentPos = bodyPosition(parent, tick, bodies);
  const localPos = localPositionAt(ship.orbit, tick);
  return { x: parentPos.x + localPos.x, y: parentPos.y + localPos.y };
}

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
 * Auto-combat at bodies. Every ship and combat-capable settlement fires once
 * every AUTO_COMBAT_INTERVAL ticks at every hostile combatant sharing its body.
 * Each volley deals `damagePerTick` damage to each target, reduced by target
 * PDC. Damage accumulates across attackers in the same tick step.
 *
 * Returns updated ships and settlements (damaged or removed) plus a combat log.
 * Ships in transit do not participate. Settlements are valid targets too.
 */
export function autoCombatAtBodies(
  ships: Ship[],
  settlements: Settlement[],
  _bodies: Body[],
  tick: number,
  /** Optional per-faction damage multiplier (Weapons tech). Default 1.0. */
  damageMul: Record<string, number> = {},
): {
  ships: Ship[];
  settlements: Settlement[];
  log: string[];
  /** Per-ship kill credits — used by the reducer to hand a destroyed
   *  freighter's trade-route cargo to whoever landed the most damage
   *  (piracy). Empty when no ships died this tick. */
  killedShips: Array<{ shipId: string; killerFactionId: string | null }>;
} {
  const damageMulOf = (factionId: string) => damageMul[factionId] ?? 1;
  const log: string[] = [];
  const damageMap = new Map<string, number>();
  // Per-attacker damage attribution: targetId → Map<attackerFactionId, dmg>.
  // Used downstream to credit the kill to the top-damage faction so
  // piracy (cargo capture from dead freighters) goes to the right pool.
  const damageByAttacker = new Map<string, Map<string, number>>();
  const accrueDamage = (targetId: string, attackerFid: string, dmg: number) => {
    damageMap.set(targetId, (damageMap.get(targetId) || 0) + dmg);
    let m = damageByAttacker.get(targetId);
    if (!m) { m = new Map(); damageByAttacker.set(targetId, m); }
    m.set(attackerFid, (m.get(attackerFid) || 0) + dmg);
  };
  const shipLastCombat = new Map<string, number>();
  const settlementLastCombat = new Map<string, number>();

  // Group combatants by body
  const shipsByBody = new Map<string, Ship[]>();
  for (const s of ships) {
    if (s.transfer) continue;
    const key = s.orbit.parentBodyId;
    if (!shipsByBody.has(key)) shipsByBody.set(key, []);
    shipsByBody.get(key)!.push(s);
  }
  const settlementsByBody = new Map<string, Settlement[]>();
  for (const st of settlements) {
    if (!settlementsByBody.has(st.bodyId)) settlementsByBody.set(st.bodyId, []);
    settlementsByBody.get(st.bodyId)!.push(st);
  }

  const bodyIds = new Set<string>([...shipsByBody.keys(), ...settlementsByBody.keys()]);

  for (const bodyId of bodyIds) {
    const localShips = shipsByBody.get(bodyId) ?? [];
    const localSettlements = settlementsByBody.get(bodyId) ?? [];

    // Need at least two factions present for hostilities
    const factions = new Set<string>();
    for (const s of localShips) factions.add(s.ownedBy);
    for (const st of localSettlements) factions.add(st.ownedBy);
    if (factions.size < 2) continue;

    // Ships fire on every hostile combatant (ship or settlement) at this body
    for (const attacker of localShips) {
      const attackerClass = getShipClass(attacker.class as ShipClassName);
      if (attackerClass.damagePerTick <= 0) continue;
      const lastFired = attacker.lastCombatTick ?? -Infinity;
      if (tick - lastFired < AUTO_COMBAT_INTERVAL) continue;

      let fired = false;
      for (const target of localShips) {
        if (target.ownedBy === attacker.ownedBy) continue;
        const targetClass = getShipClass(target.class as ShipClassName);
        const dmg = attackerClass.damagePerTick * damageMulOf(attacker.ownedBy) * (1 - targetClass.pdcRating);
        accrueDamage(target.id, attacker.ownedBy, dmg);
        log.push(`${attacker.name} hits ${target.name} for ${dmg.toFixed(0)}`);
        fired = true;
      }
      for (const target of localSettlements) {
        if (target.ownedBy === attacker.ownedBy) continue;
        const dmg = attackerClass.damagePerTick * damageMulOf(attacker.ownedBy) * (1 - SETTLEMENT_DEFS[target.type].pdcRating);
        accrueDamage(target.id, attacker.ownedBy, dmg);
        log.push(`${attacker.name} hits ${target.name} for ${dmg.toFixed(0)}`);
        fired = true;
      }
      if (fired) shipLastCombat.set(attacker.id, tick);
    }

    // Settlements fire on every hostile ship at the same body.
    // Weapons-building levels (station-only) add flat damage on top
    // of the base SETTLEMENT_DEFS damagePerTick — see BUILDING_DEFS.
    const weaponsPerLevel = BUILDING_DEFS.weapons.combatBoost?.damagePerLevel ?? 0;
    for (const attacker of localSettlements) {
      const def = SETTLEMENT_DEFS[attacker.type];
      const weaponsBonus = weaponsPerLevel * buildingLevel(attacker, 'weapons');
      const baseDmg = def.damagePerTick + weaponsBonus;
      if (baseDmg <= 0) continue;
      const lastFired = attacker.lastCombatTick ?? -Infinity;
      if (tick - lastFired < AUTO_COMBAT_INTERVAL) continue;

      let fired = false;
      for (const target of localShips) {
        if (target.ownedBy === attacker.ownedBy) continue;
        const targetClass = getShipClass(target.class as ShipClassName);
        const dmg = baseDmg * damageMulOf(attacker.ownedBy) * (1 - targetClass.pdcRating);
        accrueDamage(target.id, attacker.ownedBy, dmg);
        log.push(`${attacker.name} hits ${target.name} for ${dmg.toFixed(0)}`);
        fired = true;
      }
      if (fired) settlementLastCombat.set(attacker.id, tick);
    }
  }

  // Determine destruction
  const destroyedShips = new Set<string>();
  const destroyedSettlements = new Set<string>();
  for (const [id, dmg] of damageMap) {
    const ship = ships.find(s => s.id === id);
    if (ship) {
      const maxHp = getShipClass(ship.class as ShipClassName).hp;
      const currentHp = ship.hp ?? maxHp;
      if (dmg >= currentHp) {
        destroyedShips.add(id);
        log.push(`${ship.name} destroyed!`);
      }
      continue;
    }
    const settlement = settlements.find(s => s.id === id);
    if (settlement && dmg >= settlement.hp) {
      destroyedSettlements.add(id);
      log.push(`${settlement.name} destroyed!`);
    }
  }

  // Apply damage and stamp lastCombatTick (fired) + lastDamagedTick (took hits).
  // lastDamagedTick drives the per-tick red flash overlay in the renderer.
  const updatedShips = ships
    .filter(s => !destroyedShips.has(s.id))
    .map(s => {
      let next = s;
      const dmg = damageMap.get(s.id);
      if (dmg !== undefined) {
        const maxHp = getShipClass(s.class as ShipClassName).hp;
        const currentHp = s.hp ?? maxHp;
        next = { ...next, hp: Math.max(0, currentHp - dmg), lastDamagedTick: tick };
      }
      const lc = shipLastCombat.get(s.id);
      if (lc !== undefined) next = { ...next, lastCombatTick: lc };
      return next;
    });

  const updatedSettlements = settlements
    .filter(st => !destroyedSettlements.has(st.id))
    .map(st => {
      let next = st;
      const dmg = damageMap.get(st.id);
      if (dmg !== undefined) {
        next = { ...next, hp: Math.max(0, st.hp - dmg), lastDamagedTick: tick };
      }
      const lc = settlementLastCombat.get(st.id);
      if (lc !== undefined) next = { ...next, lastCombatTick: lc };
      return next;
    });

  // Kill attribution — top-damage faction wins the credit. Ties go to
  // first-encountered (Map iteration = insertion order in JS).
  const killedShips: Array<{ shipId: string; killerFactionId: string | null }> = [];
  for (const shipId of destroyedShips) {
    const m = damageByAttacker.get(shipId);
    let killer: string | null = null;
    let best = -1;
    if (m) {
      for (const [fid, dmg] of m) {
        if (dmg > best) { best = dmg; killer = fid; }
      }
    }
    killedShips.push({ shipId, killerFactionId: killer });
  }

  return { ships: updatedShips, settlements: updatedSettlements, log, killedShips };
}
