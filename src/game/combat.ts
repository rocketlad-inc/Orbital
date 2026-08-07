// ============================================================
// Combat System — Auto-fire at every hostile in orbit, every N ticks
// ============================================================

import { Ship, Body, Settlement, ShipKillRecord, FactionTechStateBase } from '../types';
import { getShipClass, ShipClassName } from './shipClasses';
import { bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { SETTLEMENT_DEFS, BUILDING_DEFS, buildingLevel } from './settlements';
import { rankDamageMul, rankHpMul, hpModifier } from './techs';
import { traitMul as captainTraitMul } from './captains';

/** One named factor in an attacker's live damage chain. */
export interface DamageFactor {
  label: string;
  mul: number;
}

/**
 * Every live multiplier the tick stacks on a hull's stamped
 * damage_per_tick, mirroring the attackPower expression in
 * worker/room.js — KEEP IN SYNC.
 *
 * The stamped damage is only the starting point: weapons tech, the
 * captain's rank, a Gunner trait, the flag captain's halved aura, unpaid
 * upkeep and a senate war authorization all multiply on top, and the
 * result routinely differs from the stamped figure by 2x or more. Any UI
 * quoting "expected damage" has to apply the same chain or it quietly
 * disagrees with the combat log.
 *
 * Returns the factors that actually APPLY (mul !== 1) so callers can
 * show their work, plus the product.
 *
 * NOT modelled: the senate's combat_damage_multiplier slider, which the
 * client is never sent. Callers should treat the result as complete for
 * every ordinary game and note the slider only if it ever ships to the
 * client.
 */
export function attackerDamageFactors(opts: {
  rank?: number;
  captainTraits?: string[];
  /** Flag captain of the ship's fleet, when it isn't the flagship. */
  flagTraits?: string[];
  /** Weapon mix, from damageProfile(parts). */
  profile: { kinetic: number; energy: number };
  tech: FactionTechStateBase | undefined;
  /** True when the owner's fleet upkeep is in arrears. */
  inArrears?: boolean;
  /** True when the senate has authorized war on the TARGET's faction. */
  warAuthorized?: boolean;
}): { total: number; factors: DamageFactor[] } {
  const factors: DamageFactor[] = [];
  const push = (label: string, mul: number) => {
    if (Math.abs(mul - 1) > 1e-9) factors.push({ label, mul });
  };

  // Weapons tech, blended by what this hull fires. Energy rides the
  // higher of energy_weapons/weapons, matching energyMulOf.
  const levels = (opts.tech?.levels ?? {}) as Record<string, number>;
  const wLvl = Number(levels.weapons ?? 0);
  const eLvl = Math.max(Number(levels.energy_weapons ?? 0), wLvl);
  const techMul = opts.profile.kinetic * (1 + 0.10 * wLvl)
    + opts.profile.energy * (1 + 0.10 * eLvl);
  push('Weapons tech', techMul);

  push('Rank', rankDamageMul(opts.rank));
  push('Captain', captainTraitMul(opts.captainTraits, 'dmgMul'));
  // Flag aura is HALF strength and never applies to the flagship — the
  // caller decides that by passing flagTraits only for members.
  const flagFull = captainTraitMul(opts.flagTraits, 'dmgMul');
  push('Flag aura', 1 + (flagFull - 1) / 2);
  if (opts.inArrears) push('Unpaid fleet', 0.75);
  if (opts.warAuthorized) push('War authorization', 2);

  return { total: factors.reduce((m, f) => m * f.mul, 1), factors };
}

/**
 * HP the yard will actually DELIVER for a fresh hull of a given design.
 *
 * `computeDesignStats().hp` is the build-time base — class hull plus
 * fitted armor/shield parts — and that is what gets stored as hp_max.
 * It is NOT what launches. worker/room.js spawns at the effective
 * ceiling: base × defense tech (+8% per level of the higher of
 * armor/shields). At Defense 10 that is ×1.80, so a build menu showing
 * the bare base under-reports a corvette as 40 HP when the yard hands
 * over 72 (playtest report: "ship building menu does not give accurate
 * stats for ship HP which makes planning a bit difficult").
 *
 * Veteran Yards (+1% per 4 average fleet rank, gated on weapons 5) is
 * deliberately NOT folded in: it depends on live fleet state the build
 * menu doesn't have, and it only ever adds. Under-promising by a couple
 * of percent is fine; under-promising by 80% is the bug.
 */
export function deliveredHullHp(
  baseHp: number,
  tech: FactionTechStateBase | undefined,
): number {
  return Math.round(baseHp * hpModifier(tech as unknown as Parameters<typeof hpModifier>[0]));
}

/**
 * A ship's TRUE maximum HP for display, mirroring the server's
 * maintenance-pass cap (worker/room.js `effectiveMaxHp`). The stored
 * hp_max is the build-time base (class × fitted armor parts); the server
 * then heals ships INTO a larger buffer scaled by veterancy (+1%/rank)
 * and the owner's armor tech (+8%/level). Without applying the same two
 * multipliers here, an armor-teched or ranked hull reads OVER 100% (e.g.
 * a corvette healed to 52.8 against a stored max of 40). `tech` is the
 * OWNER's faction tech (gameState.factionTech[ship.ownedBy]); undefined
 * (unknown owner / no tech) falls back to no armor bonus.
 */
export function effectiveShipMaxHp(
  ship: Ship,
  tech: FactionTechStateBase | undefined,
): number {
  // Server-computed ceiling wins when present: it's the number the
  // server actually enforces, and it's the ONLY correct answer for a
  // rival hull (whose armor tech the client never receives). The
  // estimate below stays as the single-player / pre-enrichment path.
  if (ship.hpMaxEffective && ship.hpMaxEffective > 0) return ship.hpMaxEffective;
  const base = ship.hpMax ?? getShipClass(ship.class as ShipClassName).hp;
  // hpModifier only reads tech.levels.armor; FactionTechStateBase carries
  // it (string-keyed levels), so the cast to the stricter TechId-keyed
  // FactionTechState is safe. captainTraitMul mirrors the server's
  // Bulwark bonus (worker/room.js maintenance cap) — DESIGN-captains §3.
  return base * rankHpMul(ship.rank)
    * hpModifier(tech as unknown as Parameters<typeof hpModifier>[0])
    * captainTraitMul(ship.captainTraits, 'hpMul');
}

/** Maximum entries to keep on a ship's combatHistory — LRU. Older
 *  kills age out so a long campaign doesn't bloat save blobs. */
const KILL_HISTORY_CAP = 20;

/** Ticks between auto-fire volleys. Each combatant fires every N ticks.
 *  Was 20 originally — far too slow once playtesting confirmed engagements
 *  at the same body should feel punchy. 3 ticks lets a frigate trade
 *  volleys quickly without making corvettes vaporize on the first turn.
 *  The MP server reads the same constant (mirrored in worker/room.js so
 *  the combat cadence matches between SP and MP). */
export const AUTO_COMBAT_INTERVAL = 3;

/**
 * World position of a ship at the given tick. Handles ships in torch
 * transit (state-vector) and ships orbiting (parent body + local orbit).
 */
export function shipWorldPosition(
  ship: Ship,
  tick: number,
  bodies: Body[],
): { x: number; y: number } | null {
  // Priority order matches the ship's possible states:
  //   1. Torch transit  → ship.transit.pos directly
  //   2. Parked         → orbit element evaluation
  if (ship.transit) {
    return { x: ship.transit.pos.x, y: ship.transit.pos.y };
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
  // Per-ship damage attribution: targetId → Map<attackerShipId, dmg>.
  // Used to identify the single hull that lands the killing blow for
  // rank-up + combat-history recording. Settlements that fire on ships
  // contribute to damageByAttacker (faction-level) but NOT here —
  // stationary defenders don't accrue veterancy.
  const damageByAttackerShip = new Map<string, Map<string, number>>();
  const accrueDamage = (targetId: string, attackerFid: string, dmg: number, attackerShipId?: string) => {
    damageMap.set(targetId, (damageMap.get(targetId) || 0) + dmg);
    let m = damageByAttacker.get(targetId);
    if (!m) { m = new Map(); damageByAttacker.set(targetId, m); }
    m.set(attackerFid, (m.get(attackerFid) || 0) + dmg);
    if (attackerShipId) {
      let sm = damageByAttackerShip.get(targetId);
      if (!sm) { sm = new Map(); damageByAttackerShip.set(targetId, sm); }
      sm.set(attackerShipId, (sm.get(attackerShipId) || 0) + dmg);
    }
  };
  const shipLastCombat = new Map<string, number>();
  const settlementLastCombat = new Map<string, number>();

  // Group combatants by body
  const shipsByBody = new Map<string, Ship[]>();
  for (const s of ships) {
    if (s.transit) continue;
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

      // Veterancy bonus: each rank on the attacker ship = +1% damage.
      // Stacks multiplicatively with the faction Weapons tech modifier.
      const attackerRankMul = rankDamageMul(attacker.rank);
      let fired = false;
      for (const target of localShips) {
        if (target.ownedBy === attacker.ownedBy) continue;
        const targetClass = getShipClass(target.class as ShipClassName);
        const dmg = attackerClass.damagePerTick * damageMulOf(attacker.ownedBy) * attackerRankMul * (1 - targetClass.pdcRating);
        accrueDamage(target.id, attacker.ownedBy, dmg, attacker.id);
        log.push(`${attacker.name} hits ${target.name} for ${dmg.toFixed(0)}`);
        fired = true;
      }
      for (const target of localSettlements) {
        if (target.ownedBy === attacker.ownedBy) continue;
        const dmg = attackerClass.damagePerTick * damageMulOf(attacker.ownedBy) * attackerRankMul * (1 - SETTLEMENT_DEFS[target.type].pdcRating);
        accrueDamage(target.id, attacker.ownedBy, dmg, attacker.id);
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

  // Determine destruction. Target's effective HP cap factors in their
  // own rank (each rank +1% max HP). The persisted `ship.hp` already
  // reflects rank growth from prior maintenance ticks, so we compare
  // against the rank-boosted maxHp consistently.
  const destroyedShips = new Set<string>();
  const destroyedSettlements = new Set<string>();
  for (const [id, dmg] of damageMap) {
    const ship = ships.find(s => s.id === id);
    if (ship) {
      const baseMaxHp = getShipClass(ship.class as ShipClassName).hp;
      const maxHp = baseMaxHp * rankHpMul(ship.rank);
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
        const baseMaxHp = getShipClass(s.class as ShipClassName).hp;
        const maxHp = baseMaxHp * rankHpMul(s.rank);
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
  // Per-ship veterancy awards: targetShipId → top-damage attacker shipId.
  // Stationary settlements can damage ships but don't accrue veterancy;
  // damageByAttackerShip only carries ship-vs-ship attribution.
  const killerByVictim = new Map<string, string>();
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

    // Find the single attacker SHIP with the highest damage on this
    // target. Awards the rank-up + history entry to that hull.
    const sm = damageByAttackerShip.get(shipId);
    if (sm) {
      let bestShip: string | null = null;
      let bestShipDmg = -1;
      for (const [sid, dmg] of sm) {
        if (dmg > bestShipDmg) { bestShipDmg = dmg; bestShip = sid; }
      }
      if (bestShip) killerByVictim.set(shipId, bestShip);
    }
  }

  // Apply rank-up + push combat history record to each kill-credited ship.
  // We mutate the already-mapped updatedShips array in a second pass so
  // the killer's rank/history changes don't fight the lastCombatTick/HP
  // writes above. A single ship can score multiple kills on the same
  // tick (rare but possible — destroyer in a target-rich environment).
  const survivors = updatedShips.map(s => {
    let mut = s;
    for (const [victimId, killerShipId] of killerByVictim) {
      if (killerShipId !== s.id) continue;
      const victim = ships.find(v => v.id === victimId);
      if (!victim) continue;
      const victimBody = victim.transit ? null : victim.orbit.parentBodyId;
      const newRecord: ShipKillRecord = {
        tick,
        targetName: victim.name,
        targetClass: victim.class,
        atBodyId: victimBody ?? s.orbit.parentBodyId,
      };
      const history = mut.combatHistory ?? [];
      // LRU: drop oldest when at cap.
      const nextHistory = history.length >= KILL_HISTORY_CAP
        ? [...history.slice(history.length - KILL_HISTORY_CAP + 1), newRecord]
        : [...history, newRecord];
      mut = {
        ...mut,
        rank: (mut.rank ?? 0) + 1,
        combatHistory: nextHistory,
      };
    }
    return mut;
  });

  return { ships: survivors, settlements: updatedSettlements, log, killedShips };
}
