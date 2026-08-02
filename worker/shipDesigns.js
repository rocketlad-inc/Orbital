// Ship designer — shared server-side part definitions + stat math.
// DESIGN-identity-economy.md §2 is the authoritative spec.
//
// KEEP IN SYNC with the client mirror in src/game/shipParts.ts. Same
// convention as SHIP_BUILD_COST / BUILDING_DEFS: the worker is a
// separate Cloudflare bundle that doesn't share the React build tree,
// so the constants are duplicated rather than imported.
//
// Server naming: metal/gold columns (client calls them ore/credits).

import { SHIP_COMBAT_STATS } from './factions.js';

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
export const SHIP_PART_DEFS = {
  kinetic:   { metal: 6,  gold: 2,  allowed: ['corvette', 'frigate', 'destroyer'], damageType: 'kinetic' },
  energy:    { metal: 2,  gold: 6,  allowed: ['corvette', 'frigate', 'destroyer'], damageType: 'energy' },
  shield:    { metal: 4,  gold: 4,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  armor:     { metal: 6,  gold: 2,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  engine:    { metal: 2,  gold: 6,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  detonator: { metal: 10, gold: 10, allowed: ['corvette', 'frigate', 'destroyer'] },
};

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
  return {
    hp: Math.round(base.hp * (1 + hpBonus)),
    damage_per_tick: Math.round(base.damage_per_tick * (1 + dmgBonus) * 10) / 10,
  };
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
