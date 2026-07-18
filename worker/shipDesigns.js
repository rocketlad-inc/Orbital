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
  weapon:    { metal: 6,  gold: 2,  allowed: ['corvette', 'frigate', 'destroyer'] },
  shield:    { metal: 4,  gold: 4,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  engine:    { metal: 2,  gold: 6,  allowed: ['corvette', 'frigate', 'destroyer', 'freighter'] },
  detonator: { metal: 10, gold: 10, allowed: ['corvette', 'frigate', 'destroyer'] },
};

/**
 * Standard-issue fitting per hull — the "Default" template every player
 * starts with, and what a build falls back to when no design is active.
 *
 * COST NOTE: these fill every slot, so a fitted hull runs ~2.3-2.8x the
 * bare-hull price (frigate 10M/8G -> 28M/22G, destroyer 20M/17G ->
 * 48M/37G). That's intentional — a default should be a real warship —
 * but it IS a live economy change. Players who want the cheap hull can
 * UNSET the active design; builds then fall back to bare.
 * Trim any entry here to soften it; nothing else needs to change.
 *
 * KEEP IN SYNC with DEFAULT_LOADOUTS in src/game/shipParts.ts.
 */
export const DEFAULT_LOADOUTS = {
  corvette:  ['weapon', 'engine'],
  frigate:   ['weapon', 'weapon', 'shield', 'engine'],
  destroyer: ['weapon', 'weapon', 'weapon', 'shield', 'shield', 'engine'],
  freighter: ['engine'],
  colony:    [],
};

const WEAPON_DMG_PCT       = 0.40;  // of hull base dmg, per part
const SHIELD_HP_PCT        = 0.35;  // of hull base HP, per part
const DETONATOR_HP_FRAC    = 0.50;  // of ship MAX HP, per part
const WEAPONS_TECH_PER_LVL = 0.10;  // boosts weapon part effect
const ARMOR_TECH_PER_LVL   = 0.08;  // boosts shield part effect
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
  for (const p of parts) {
    const def = SHIP_PART_DEFS[p];
    if (!def) return { ok: false, error: `unknown part: ${p}` };
    if (!def.allowed.includes(shipClass)) {
      return { ok: false, error: `${p} cannot be fitted on a ${shipClass}` };
    }
    clean.push(p);
  }
  return { ok: true, parts: clean };
}

/** Total metal/gold cost of a parts list (hull cost NOT included). */
export function partsCost(parts) {
  let metal = 0, gold = 0;
  for (const p of parts ?? []) {
    const def = SHIP_PART_DEFS[p];
    if (!def) continue;
    metal += def.metal;
    gold += def.gold;
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
  const nWeapons = countPart(parts, 'weapon');
  const nShields = countPart(parts, 'shield');
  const weaponsLvl = Math.max(0, Number(techLevels.weapons ?? 0));
  const armorLvl = Math.max(0, Number(techLevels.armor ?? 0));
  const dmgBonus = WEAPON_DMG_PCT * (1 + WEAPONS_TECH_PER_LVL * weaponsLvl) * nWeapons;
  const hpBonus = SHIELD_HP_PCT * (1 + ARMOR_TECH_PER_LVL * armorLvl) * nShields;
  return {
    hp: Math.round(base.hp * (1 + hpBonus)),
    damage_per_tick: Math.round(base.damage_per_tick * (1 + dmgBonus) * 10) / 10,
  };
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
