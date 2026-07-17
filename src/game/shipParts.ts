// ============================================================
// Ship parts — client mirror of worker/shipDesigns.js.
// DESIGN-identity-economy.md §2 is the authoritative spec.
//
// KEEP IN SYNC with the worker module. Server columns are metal/gold;
// the client calls the same resources ore/credits (same rename as
// everywhere else at the network boundary).
//
// MULTIPLAYER ONLY. The SP sim (gameContext) never creates parts —
// SP ships carry no `parts` field, so every helper here degrades to
// the identity for them (bare hull = today's ship exactly).
// ============================================================

import { ShipClassName, SHIP_CLASSES } from './shipClasses';

export type ShipPartId = 'weapon' | 'shield' | 'engine' | 'detonator';

export interface ShipPartDef {
  id: ShipPartId;
  name: string;
  /** One-line effect description shown on the designer part card.
   *  For the detonator this is NOT the full disclosure — use
   *  detonatorDisclosure() wherever a detonator surfaces (spec §2.2:
   *  damage amount + friendly fire + ship consumed, all three,
   *  every time). */
  blurb: string;
  cost: { ore: number; credits: number };
  allowedOn: ShipClassName[];
  /** Tech track that scales this part's effect, for the designer UI. */
  techTrack: 'weapons' | 'armor' | 'propulsion';
  techNote: string;
}

/** Part slots per hull. Freighter's single slot is engine/shield only.
 *  Colony ships have no designer at all (0 slots — filtered out of the
 *  ShipDesigner class tabs). */
export const SHIP_SLOT_COUNTS: Record<ShipClassName, number> = {
  corvette: 2,
  frigate: 4,
  destroyer: 6,
  freighter: 1,
  colony: 0,
};

export const SHIP_PART_DEFS: Record<ShipPartId, ShipPartDef> = {
  weapon: {
    id: 'weapon',
    name: 'Weapon Mount',
    blurb: '+40% of hull base damage per mount.',
    cost: { ore: 6, credits: 2 },
    allowedOn: ['corvette', 'frigate', 'destroyer'],
    techTrack: 'weapons',
    techNote: 'Weapons tech: +10%/lvl to this part',
  },
  shield: {
    id: 'shield',
    name: 'Shield Array',
    blurb: '+35% of hull base HP per array.',
    cost: { ore: 4, credits: 4 },
    allowedOn: ['corvette', 'frigate', 'destroyer', 'freighter'],
    techTrack: 'armor',
    techNote: 'Armor tech: +8%/lvl to this part',
  },
  engine: {
    id: 'engine',
    name: 'Booster Engine',
    blurb: '−15% travel time per engine (multiplicative).',
    cost: { ore: 2, credits: 6 },
    allowedOn: ['corvette', 'frigate', 'destroyer', 'freighter'],
    techTrack: 'propulsion',
    techNote: 'Propulsion tech: +6%/lvl to this part',
  },
  detonator: {
    id: 'detonator',
    name: 'Fusion Detonator',
    // Full disclosure lives in detonatorDisclosure(); this short line
    // still names all three consequences per the spec's UX rule.
    blurb: 'Self-destruct charge: massive blast, hits friend AND foe, ship is destroyed.',
    cost: { ore: 10, credits: 10 },
    allowedOn: ['corvette', 'frigate', 'destroyer'],
    techTrack: 'weapons',
    techNote: 'Weapons tech: +5%/lvl to blast (half rate)',
  },
};

export const ALL_PART_IDS: ShipPartId[] = ['weapon', 'shield', 'engine', 'detonator'];

const WEAPON_DMG_PCT = 0.40;
const SHIELD_HP_PCT = 0.35;
const ENGINE_TRAVEL_PCT = 0.15;
const DETONATOR_HP_FRAC = 0.50;
const WEAPONS_TECH_PER_LVL = 0.10;
const ARMOR_TECH_PER_LVL = 0.08;
const PROPULSION_TECH_PER_LVL = 0.06;
const DETONATOR_TECH_PER_LVL = WEAPONS_TECH_PER_LVL / 2;

/** Narrow an untyped string[] (e.g. server parts_json) to known part ids. */
export function sanitizeParts(raw: unknown): ShipPartId[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is ShipPartId => typeof p === 'string' && p in SHIP_PART_DEFS);
}

export function countPart(parts: readonly string[] | undefined, id: ShipPartId): number {
  if (!parts) return 0;
  let n = 0;
  for (const p of parts) if (p === id) n++;
  return n;
}

/** Sum of part costs (hull cost NOT included). */
export function partsCost(parts: readonly ShipPartId[]): { ore: number; credits: number } {
  let ore = 0, credits = 0;
  for (const p of parts) {
    ore += SHIP_PART_DEFS[p].cost.ore;
    credits += SHIP_PART_DEFS[p].cost.credits;
  }
  return { ore, credits };
}

/**
 * Travel-time multiplier from engine parts: (1 − 0.15·techBoost)^n.
 * Propulsion tech boosts the per-engine effect (+6%/lvl). Floor 0.1 so
 * a stacked destroyer can't hit zero-time transfers.
 */
export function engineTravelMultiplier(
  parts: readonly string[] | undefined,
  propulsionLvl: number = 0,
): number {
  const n = countPart(parts, 'engine');
  if (n <= 0) return 1;
  const perEngine = Math.min(0.9, ENGINE_TRAVEL_PCT * (1 + PROPULSION_TECH_PER_LVL * Math.max(0, propulsionLvl)));
  return Math.max(0.1, Math.pow(1 - perEngine, n));
}

/**
 * Acceleration multiplier that realizes the travel-time multiplier
 * under the brachistochrone T = 2·√(d/a): scaling time by m means
 * scaling acceleration by 1/m². Applied where the transfer planner
 * picks the ship's engine accel (client-side — the server accepts the
 * client's arrival_t as-is; see handleCommitTransfer).
 */
export function engineAccelMultiplier(
  parts: readonly string[] | undefined,
  propulsionLvl: number = 0,
): number {
  const m = engineTravelMultiplier(parts, propulsionLvl);
  return 1 / (m * m);
}

/**
 * Combat stats for a hull + loadout at the given tech levels. Bare
 * hull returns the class-def stats untouched (tech scales PART effects
 * only — a bare hull is today's ship no matter the research state).
 */
export function computeDesignStats(
  shipClass: ShipClassName,
  parts: readonly ShipPartId[],
  techLevels: Partial<Record<string, number>> = {},
): {
  hp: number;
  damagePerTick: number;
  travelTimeMult: number;
  /** Hull + parts, in client resource names. */
  totalCost: { ore: number; credits: number };
} {
  const def = SHIP_CLASSES[shipClass];
  const weaponsLvl = Math.max(0, techLevels.weapons ?? 0);
  const armorLvl = Math.max(0, techLevels.armor ?? 0);
  const propulsionLvl = Math.max(0, techLevels.propulsion ?? 0);
  const nWeapons = countPart(parts, 'weapon');
  const nShields = countPart(parts, 'shield');
  // Server hull base is worker SHIP_COMBAT_STATS which matches the
  // class def hp/damagePerTick for every class except freighter hp
  // (server 30 vs client def 60) — use the server-authoritative bases
  // so the designer preview matches what the yard actually delivers.
  const base = SERVER_HULL_BASE[shipClass];
  const dmgBonus = WEAPON_DMG_PCT * (1 + WEAPONS_TECH_PER_LVL * weaponsLvl) * nWeapons;
  const hpBonus = SHIELD_HP_PCT * (1 + ARMOR_TECH_PER_LVL * armorLvl) * nShields;
  const pc = partsCost(parts);
  return {
    hp: Math.round(base.hp * (1 + hpBonus)),
    damagePerTick: Math.round(base.damagePerTick * (1 + dmgBonus) * 10) / 10,
    travelTimeMult: engineTravelMultiplier(parts, propulsionLvl),
    totalCost: { ore: def.cost.ore + pc.ore, credits: def.cost.credits + pc.credits },
  };
}

/** Server-authoritative hull combat bases (worker/factions.js
 *  SHIP_COMBAT_STATS). KEEP IN SYNC. */
export const SERVER_HULL_BASE: Record<ShipClassName, { hp: number; damagePerTick: number }> = {
  corvette: { hp: 40, damagePerTick: 5 },
  frigate: { hp: 80, damagePerTick: 10 },
  destroyer: { hp: 200, damagePerTick: 18 },
  freighter: { hp: 30, damagePerTick: 0 },
  colony: { hp: 60, damagePerTick: 0 },
};

/** Blast damage: 50% of max HP per detonator, Weapons tech at half rate. */
export function detonatorDamage(hpMax: number, detonatorCount: number, weaponsLvl: number = 0): number {
  return Math.round(
    Math.max(0, hpMax) * DETONATOR_HP_FRAC * Math.max(0, detonatorCount)
    * (1 + DETONATOR_TECH_PER_LVL * Math.max(0, weaponsLvl)),
  );
}

/**
 * REQUIRED detonator copy (spec §2.2): every surface where a detonator
 * appears must state ALL THREE — the damage amount, that it hits
 * friend and foe alike, and that the ship is destroyed.
 */
export function detonatorDisclosure(damage: number): string {
  return `Detonate: deal ${damage} damage (50% of max HP per detonator) to every ship in this orbit — friend or foe alike. This ship is destroyed.`;
}
