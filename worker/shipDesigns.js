// Ship designer — shared server-side part definitions + stat math.
// DESIGN-identity-economy.md §2 is the authoritative spec.
//
// KEEP IN SYNC with the client mirror in src/game/shipParts.ts. Same
// convention as SHIP_BUILD_COST / BUILDING_DEFS: the worker is a
// separate Cloudflare bundle that doesn't share the React build tree,
// so the constants are duplicated rather than imported.
//
// Server naming: metal/gold columns (client calls them ore/credits).

import { SHIP_COMBAT_STATS, ENGINE_SPEED_MUL, SPEED_CAP } from './factions.js';

/** Part slots per hull. Freighter's single slot is engine/shield only
 *  (no weapon, no detonator — it's a hauler, not a fireship). Colony
 *  ships (P1d, other agent) have no designer at all. */
export const SHIP_SLOT_COUNTS = {
  corvette: 2,
  frigate: 4,
  destroyer: 6,
  freighter: 1,
};

/**
 * Part catalog. Effects are BASE values; tech tracks scale the part
 * effect (not the hull base — a bare hull is identical to today's ship
 * no matter the tech level, which is the live-game migration story):
 *
 *   weapon    +40% of hull base dmg/part      × (1 + 0.10·Weapons lvl)
 *   shield    +35% of hull base HP/part       × (1 + 0.08·Armor lvl)
 *   engine    −15% travel time/part (mult.)   × (1 + 0.06·Propulsion lvl)
 *   detonator 50% of ship MAX HP dmg/part     × (1 + 0.05·Weapons lvl)
 *                                               (HALF the Weapons rate)
 *
 * Costs are per part, added to the hull cost at queue time. Priced
 * against P0 hull costs (corvette 5M/4G … destroyer 20M/17G) so a
 * fully-loaded hull meaningfully exceeds the bare hull price.
 */
/**
 * CURRENCY SPLIT (2026-08-09). Metal buys KINETIC + SHIELD; credits buy
 * ENERGY + ARMOR. The pairing is CROSSED on purpose, and that crossing —
 * not the 8:1 ratio — is the whole mechanism.
 *
 * Read it against COUNTERED_BY below: shield stops kinetic, armor stops
 * energy. So a one-currency empire ends up holding the defense that is
 * useless against what its enemy actually shoots. A mono-metal empire
 * fields kinetic guns and shields; a credit empire shoots energy; and
 * shields do nothing about energy. You cannot build a complete warship
 * on a single currency, which makes economic diversity a MILITARY
 * requirement and gives the trade system a real job.
 *
 * The previous 3:1 spread paired metal with kinetic AND armor — same
 * side, coherent, and completely inert: a mono-metal empire already
 * carried the right defense against a credit empire, so nobody ever had
 * to trade.
 *
 * 8:1 rather than 1:0 deliberately: the 100-game sim measured a 9.4x
 * spawn imbalance in starting yields, and at 1:0 that stops being an
 * economic handicap you can play around and becomes a military one —
 * a metal-poor spawn simply could not field the energy half of the game.
 * At 8:1 every design stays buildable on a bad spawn, just expensively.
 *
 * KEEP IN SYNC with SHIP_PART_DEFS in src/game/shipParts.ts.
 */
export const SHIP_PART_DEFS = {
  kinetic:   { metal: 8,  gold: 1,  allowed: ['corvette', 'frigate', 'destroyer'], damageType: 'kinetic' },
  energy:    { metal: 1,  gold: 8,  allowed: ['corvette', 'frigate', 'destroyer'], damageType: 'energy' },
  shield:    { metal: 8,  gold: 1,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  armor:     { metal: 1,  gold: 8,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  engine:    { metal: 2,  gold: 6,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  detonator: { metal: 10, gold: 10, allowed: ['corvette', 'frigate', 'destroyer'] },
  // FIELD TENDER (Defense 4). Freighter-only on purpose: it gives the
  // hauler a second career and makes a support hull worth escorting —
  // and worth hunting. Credit-leaning like the rest of the armor track.
  repair:    { metal: 4,  gold: 10, allowed: ['freighter'] },
};

/** HP per tick a single Repair Bay restores to EVERY friendly hull parked
 *  at the same body — the tender's whole point is that it heals the fleet,
 *  not itself.
 *
 *  Scale check against the other repair sources: a bare station is 2/tick,
 *  Damage Control is 1/tick anywhere, and a level-6 shipyard is 32/tick.
 *  8 puts a tender well above the trickle a researched faction gets for
 *  free, and well below a developed dry dock — so a fleet with a tender
 *  can hold a front, but a wreck still wants to go home.
 *
 *  Deliberately FLAT and untouched by tech: every other repair rate in the
 *  game is either flat or scaled by a BUILDING (the shipyard), and adding
 *  a tech curve here would be the only exception. Tune this constant. */
export const REPAIR_TENDER_PER_BAY = 8;

// Legacy ids from before the kinetic/energy split. `weapon` becomes
// kinetic (also the bare-hull default), so existing parts_json + saved
// designs keep working with no data migration. Applied in validateParts.
const PART_ALIAS = { weapon: 'kinetic' };

// Damage-type counter-matrix. KEEP IN SYNC with src/game/shipParts.ts.
const DAMAGE_MITIGATION_PER_PART = 0.78;   // per matching defensive part
const COUNTERED_BY = { kinetic: 'shield', energy: 'armor' };
export const MITIGATION_FLOOR = 0.15;      // 85% cap on total reduction

/**
 * Standard-issue fitting per hull — the "Default" template every player
 * starts with, and what a build falls back to when no design is active.
 * Weapon slots default to KINETIC (the neutral pick against unshielded
 * targets); players re-fit for energy when they scout shields.
 *
 * COST NOTE: these fill every slot, so a fitted hull runs ~2.3-2.8x the
 * bare-hull price. Intentional — a default should be a real warship —
 * but it IS a live economy change. UNSET the active design to fall back
 * to a bare hull. KEEP IN SYNC with DEFAULT_LOADOUTS in src/game/shipParts.ts.
 */
export const DEFAULT_LOADOUTS = {
  corvette:  ['kinetic', 'engine'],
  frigate:   ['kinetic', 'kinetic', 'shield', 'engine'],
  destroyer: ['kinetic', 'kinetic', 'kinetic', 'shield', 'shield', 'engine'],
  freighter: ['engine'],
  colony:    [],
};

const WEAPON_DMG_PCT       = 0.40;  // of hull base dmg, per weapon mount
const SHIELD_HP_PCT        = 0.35;  // of hull base HP, per defensive part
const DETONATOR_HP_FRAC    = 0.50;  // of ship MAX HP, per part
const WEAPONS_TECH_PER_LVL = 0.10;  // boosts a weapon mount's effect
const ARMOR_TECH_PER_LVL   = 0.08;  // boosts a defensive part's effect
const DETONATOR_TECH_PER_LVL = WEAPONS_TECH_PER_LVL / 2;  // Weapons at half rate

/**
 * Validate + normalize a parts loadout for a hull class.
 * Returns { ok: true, parts } with a clean string[] on success, or
 * { ok: false, error } with a player-readable message.
 */
export function validateParts(shipClass, parts) {
  const slots = SHIP_SLOT_COUNTS[shipClass];
  if (slots == null) return { ok: false, error: `unknown ship_class: ${shipClass}` };
  if (parts == null) return { ok: true, parts: [] };
  if (!Array.isArray(parts)) return { ok: false, error: 'parts must be an array of part ids' };
  if (parts.length > slots) {
    return { ok: false, error: `${shipClass} has ${slots} slot${slots === 1 ? '' : 's'} — got ${parts.length} parts` };
  }
  const clean = [];
  for (const raw of parts) {
    const p = PART_ALIAS[raw] ?? raw;   // normalize legacy ids (weapon -> kinetic)
    const def = SHIP_PART_DEFS[p];
    if (!def) return { ok: false, error: `unknown part: ${raw}` };
    if (!def.allowed.includes(shipClass)) {
      return { ok: false, error: `${p} cannot be fitted on a ${shipClass}` };
    }
    clean.push(p);
  }
  return { ok: true, parts: clean };
}

/**
 * Bare-hull build cost, metal/gold only.
 *
 * The single source for these five numbers: actions.js SHIP_BUILD_COST
 * spreads this and adds fuel + build_ticks, so the price a shipyard
 * charges and the ratio upkeep bills at cannot drift apart. KEEP IN SYNC
 * with SHIP_CLASSES[*].cost in src/game/shipClasses.ts.
 */
export const HULL_COST = {
  corvette:  { metal: 20,  gold: 16 },
  frigate:   { metal: 45,  gold: 36 },
  destroyer: { metal: 110, gold: 95 },
  freighter: { metal: 28,  gold: 20 },
  colony:    { metal: 80,  gold: 60 },
};

/**
 * Split a hull's upkeep across metal and credits IN PROPORTION TO WHAT
 * IT IS MADE OF.
 *
 * Why this exists: upkeep used to be a flat per-class figure, and three
 * of five classes billed credits ONLY (corvette 0.25C/0M, freighter
 * 1C/0M). That put a permanent credit drain on every fleet regardless of
 * what a player's worlds produce — so an empire holding the outer metal
 * belt (Saturn 9M/1C, Titan 7M/1C) paid its bills in the one currency
 * its geography does not make. A player reported exactly that: metal
 * income +50/tick against credits at −7/tick.
 *
 * The rule (Lorne): currency per tick is proportional to the loadout's
 * cost distribution. A hull whose parts are 89% metal by cost pays 89%
 * of its upkeep in metal. Kinetic and shield are metal-side (8/1),
 * energy and armor credit-side (1/8), so the currency-split axis that
 * already governs what a ship COSTS now also governs what it DRAINS.
 *
 * TOTAL IS PRESERVED EXACTLY. This redistributes a bill, it does not
 * raise or lower one: `gold + metal` out equals `totals.gold +
 * totals.metal` in. A fleet's absolute cost is unchanged; only which
 * pocket it comes from moves. That keeps it a strategy change rather
 * than a stealth economy buff, and keeps the host's Editor knobs
 * meaningful (they set the per-class TOTAL, split at runtime).
 *
 * A BARE HULL falls back to its own build-cost ratio rather than to the
 * old class default — an unfitted corvette is still mostly metal (20M
 * vs 16C), and defaulting it to 100% credits is the very bias being
 * removed. Unknown/empty part lists take the same path.
 */
export function upkeepSplit(shipClass, parts, totals) {
  const total = Math.max(0, Number(totals?.gold ?? 0)) + Math.max(0, Number(totals?.metal ?? 0));
  if (!(total > 0)) return { gold: 0, metal: 0 };

  const pc = partsCost(parts ?? []);
  let m = pc.metal;
  let g = pc.gold;
  if (m + g <= 0) {
    const hull = HULL_COST[shipClass] ?? HULL_COST.frigate;
    m = hull.metal;
    g = hull.gold;
  }
  const denom = m + g;
  // Degenerate only if a hull cost were zeroed by config; split evenly
  // rather than dividing by zero.
  const metalShare = denom > 0 ? m / denom : 0.5;
  const metal = total * metalShare;
  return { metal, gold: total - metal };
}

/** Total metal/gold cost of a parts list (hull cost NOT included). */
/** Cost escalation for STACKING the same part — the k-th copy costs
 *  base × ESCALATION^(k-1). KEEP IN SYNC with PART_STACK_ESCALATION in
 *  src/game/shipParts.ts (and the identical rounding below, or the
 *  client's quoted price won't match what the server charges). */
export const PART_STACK_ESCALATION = 1.75;

export function partsCost(parts) {
  const seen = Object.create(null);
  let metal = 0, gold = 0;
  for (const p of parts ?? []) {
    const def = SHIP_PART_DEFS[p];
    if (!def) continue;
    const n = seen[p] ?? 0;
    seen[p] = n + 1;
    const mul = Math.pow(PART_STACK_ESCALATION, n);
    metal += Math.round(def.metal * mul);
    gold += Math.round(def.gold * mul);
  }
  return { metal, gold };
}

/** Refit fee: half the ADDED parts' price (DESIGN-fleet-economy §2).
 *
 *  Per part type: copies kept from the old loadout are free, removed
 *  copies refund NOTHING, and each added copy is priced at its stack
 *  position in the NEW loadout (cost of the new stack minus the cost of
 *  the retained prefix) — i.e. the current escalated rate. The half-off
 *  multiplier is applied per resource with ceil so quotes stay integers.
 *  KEEP IN SYNC with refitFee in src/game/shipParts.ts (the client's
 *  quote must equal the server's charge). */
export const REFIT_MULTIPLIER = 0.5;

function stackCost(counts) {
  let metal = 0, gold = 0;
  for (const [p, n] of Object.entries(counts)) {
    const def = SHIP_PART_DEFS[p];
    if (!def) continue;
    for (let k = 0; k < n; k++) {
      const mul = Math.pow(PART_STACK_ESCALATION, k);
      metal += Math.round(def.metal * mul);
      gold += Math.round(def.gold * mul);
    }
  }
  return { metal, gold };
}

export function refitFee(oldParts, newParts) {
  const count = (parts) => {
    const c = Object.create(null);
    for (const p of parts ?? []) c[p] = (c[p] ?? 0) + 1;
    return c;
  };
  const oldC = count(oldParts);
  const newC = count(newParts);
  const kept = Object.create(null);
  for (const [p, n] of Object.entries(newC)) kept[p] = Math.min(n, oldC[p] ?? 0);
  const full = stackCost(newC);
  const retained = stackCost(kept);
  return {
    metal: Math.ceil(Math.max(0, full.metal - retained.metal) * REFIT_MULTIPLIER),
    gold: Math.ceil(Math.max(0, full.gold - retained.gold) * REFIT_MULTIPLIER),
  };
}

/** Count occurrences of a part id in a loadout. */
export function countPart(parts, partId) {
  let n = 0;
  for (const p of parts ?? []) if (p === partId) n++;
  return n;
}

/** Defensive-parse a parts_json blob to a validated string[] (never throws). */
export function parsePartsJson(shipClass, partsJson) {
  if (!partsJson) return [];
  try {
    const raw = JSON.parse(partsJson);
    const v = validateParts(shipClass, raw);
    return v.ok ? v.parts : [];
  } catch {
    return [];
  }
}

/**
 * Combat stats for a hull + parts loadout at the given tech levels.
 * Bare hull (parts = []) returns SHIP_COMBAT_STATS unchanged — tech
 * scales PART effects only, matching the spec's migration guarantee.
 *
 * @param shipClass  hull class
 * @param parts      validated part id array (may be empty)
 * @param techLevels { weapons?: number, armor?: number } (missing = 0)
 * @returns { hp, damage_per_tick }
 */
export function computeShipStats(shipClass, parts, techLevels = {}) {
  const base = SHIP_COMBAT_STATS[shipClass] ?? { hp: 50, damage_per_tick: 0 };
  const nKinetic = countPart(parts, 'kinetic');
  const nEnergy = countPart(parts, 'energy');
  const nShields = countPart(parts, 'shield');
  const nArmor = countPart(parts, 'armor');
  const kineticLvl = Math.max(0, Number(techLevels.weapons ?? 0));
  const energyLvl = Math.max(0, Number(techLevels.energy_weapons ?? 0));
  const shieldsLvl = Math.max(0, Number(techLevels.shields ?? 0));
  const armorLvl = Math.max(0, Number(techLevels.armor ?? 0));
  const dmgBonus = WEAPON_DMG_PCT * (
    (1 + WEAPONS_TECH_PER_LVL * kineticLvl) * nKinetic
    + (1 + WEAPONS_TECH_PER_LVL * energyLvl) * nEnergy
  );
  const hpBonus = SHIELD_HP_PCT * (
    (1 + ARMOR_TECH_PER_LVL * shieldsLvl) * nShields
    + (1 + ARMOR_TECH_PER_LVL * armorLvl) * nArmor
  );
  // COMBAT V2: speed rides the hull and its engines. Propulsion tech is
  // deliberately NOT applied here — it raises the per-engine travel step
  // elsewhere, and folding it in again would double-count. The cap binds
  // for both the hit roll and travel (DESIGN-combat-v2.md R1).
  const nEngines = countPart(parts, 'engine');
  const speed = Math.min(
    SPEED_CAP,
    (base.speed ?? 0.5) * Math.pow(ENGINE_SPEED_MUL, nEngines),
  );

  return {
    hp: Math.round(base.hp * (1 + hpBonus)),
    damage_per_tick: Math.round(base.damage_per_tick * (1 + dmgBonus) * 10) / 10,
    speed: Math.round(speed * 1000) / 1000,
  };
}

/**
 * COMBAT V2 speed for a hull + loadout. Cheap enough to call per ship per
 * tick — computeShipStats does hp/damage work the combat loop does not need.
 *
 * Deliberately independent of tech: Propulsion raises the per-engine TRAVEL
 * step elsewhere, and folding it in here too would double-count it into the
 * hit roll.
 */
export function shipSpeed(shipClass, parts) {
  const base = SHIP_COMBAT_STATS[shipClass]?.speed ?? 0.5;
  return Math.min(SPEED_CAP, base * Math.pow(ENGINE_SPEED_MUL, countPart(parts, 'engine')));
}

/** Hit chance: p = atk^2 / (atk^2 + def^2). Symmetric, mirrors are always
 *  50%, and it can never reach 0 or 1 — there are no guaranteed shots and
 *  no untouchable hulls. */
export function hitChance(atkSpeed, defSpeed) {
  const a = atkSpeed * atkSpeed;
  const d = defSpeed * defSpeed;
  return a + d <= 0 ? 0.5 : a / (a + d);
}

/**
 * Fraction of a loadout's weapon output per damage type. No weapon
 * mounts (bare hull / freighter / defensive-only) => 100% kinetic, the
 * neutral default so undesigned ships behave exactly as before.
 * @returns { kinetic, energy } summing to 1.
 */
export function damageProfile(parts) {
  const k = countPart(parts, 'kinetic');
  const e = countPart(parts, 'energy');
  const total = k + e;
  if (total === 0) return { kinetic: 1, energy: 0 };
  return { kinetic: k / total, energy: e / total };
}

/**
 * Incoming-damage multiplier a TARGET's defensive parts apply, blended
 * by the ATTACKER's damage profile. Shields cut kinetic, armor cuts
 * energy — 0.78^count each, the other type passing at full. In (0, 1].
 */
export function defenseMitigation(targetParts, profile) {
  const kMit = Math.pow(DAMAGE_MITIGATION_PER_PART, countPart(targetParts, COUNTERED_BY.kinetic));
  const eMit = Math.pow(DAMAGE_MITIGATION_PER_PART, countPart(targetParts, COUNTERED_BY.energy));
  return profile.kinetic * kMit + profile.energy * eMit;
}

/**
 * Detonator blast damage: 50% of the ship's MAX HP per detonator part,
 * scaled by Weapons tech at HALF the normal rate (spec §2.2). Applied
 * to EVERY in-orbit ship at the body — including the owner's own.
 */
export function detonatorDamage(hpMax, detonatorCount, weaponsLvl = 0) {
  const lvl = Math.max(0, Number(weaponsLvl) || 0);
  return Math.round(
    Math.max(0, hpMax) * DETONATOR_HP_FRAC * Math.max(0, detonatorCount)
    * (1 + DETONATOR_TECH_PER_LVL * lvl),
  );
}
