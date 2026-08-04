// ============================================================
// Tech Tree — Neptune's Pride / Stellaris-late-game style.
//
// Seven tech tracks, capped at TECH_MAX_LEVEL (=10) per track.
// Each level costs progressively more science but yields a flat
// per-level modifier (so absolute benefit scales linearly while
// cost scales super-linearly — Stellaris repeatables pattern).
//
// Hitting max level on every track is the Science Victory
// condition (see src/game/victory.ts).
//
// Effects are applied via the helpers at the bottom of this file
// (combatModifier, buildCostModifier, etc.) which game logic calls
// to read the current modifier for a faction.
// ============================================================

/**
 * Hard cap on per-track tech level. Reaching this for every track
 * triggers Science Victory. Server mirror lives in worker/actions.js.
 */
export const TECH_MAX_LEVEL = 10;

// SIX tracks. Each is a 10-rung ladder that UNLOCKS a mechanic on its
// early levels and pays a passive % on every level (see RESEARCH_UNLOCKS
// in researchUnlocks.ts). A game starts with almost nothing — the tree
// is the tutorial.
//
// IDs are deliberately unchanged from the original six so no live game
// needs a data migration. Two consequences of the consolidation:
//   - 'armor' is now the DEFENSE track (both 🛡 shields and 🪨 armor).
//   - 'industry' is now displayed as SOCIETY (economy + diplomacy).
// The short-lived 'energy_weapons' / 'shields' ids are folded back in;
// any levels a live game banked in them are honoured via the max()
// fallbacks in combatModifier / hpModifier below, so nobody loses
// research they paid for.
export type TechId =
  | 'weapons'          // ⚔ Weapons — kinetic + energy mounts, detonator
  | 'armor'            // 🛡 Defense — shields + armor plate, PDC, repair
  | 'propulsion'       // 🚀 Propulsion — freighters, engines, logistics
  | 'construction'     // 🔧 Construction — stations, hulls, Dyson
  | 'industry'         // ⛏ Society — buildings, pacts, senate
  | 'sensors';         // 📡 Sensors — the intel ladder

export interface TechDef {
  id: TechId;
  name: string;
  description: string;
  icon: string;
  /** Per-level effect magnitude — e.g. 0.10 = +10% per level */
  perLevel: number;
  /** Human-readable effect description for one level */
  effectText: string;
  /** Base science cost of level 1 */
  baseCost: number;
  /** Exponent applied to (level) for cost scaling. Cost = baseCost * level^costScaling */
  costScaling: number;
}

// Unified cost curve: 15 × level^1.72. Deliberately steeper than the old
// per-track curves AND much cheaper at level 1 — the first unlock should
// land around turn 5 (tutorial pace) while level 10 stays a real late-game
// project. L1 15 · L3 100 · L5 267 · L10 ~1130.
const RESEARCH_BASE_COST = 15;
const RESEARCH_COST_SCALING = 1.72;

export const TECH_DEFS: Record<TechId, TechDef> = {
  weapons: {
    id: 'weapons',
    name: 'Weapons',
    description: 'Guns, and what you bolt them to. Unlocks ⚔ kinetic mounts, then the ☠ detonator, then ⚡ energy mounts — and scales every mount you fit. Shields only stop kinetic; armor only stops energy.',
    icon: '⚔',
    perLevel: 0.10,
    effectText: '+10% ship damage',
    baseCost: RESEARCH_BASE_COST,
    costScaling: RESEARCH_COST_SCALING,
  },
  armor: {
    id: 'armor',
    name: 'Defense',
    description: 'Staying alive. Unlocks 🛡 shield arrays, then 🪨 armor plate, then hardened settlements and damage control — and scales every point of hull you fit.',
    icon: '🛡',
    perLevel: 0.08,
    effectText: '+8% ship HP',
    baseCost: RESEARCH_BASE_COST,
    costScaling: RESEARCH_COST_SCALING,
  },
  propulsion: {
    id: 'propulsion',
    name: 'Propulsion',
    description: 'Moving things. Unlocks the freighter and everything it does, then 🔥 booster engines, transfer lanes, and automated collectors.',
    icon: '🚀',
    perLevel: 0.06,
    effectText: '+6% per 🔥 booster engine',
    baseCost: RESEARCH_BASE_COST,
    costScaling: RESEARCH_COST_SCALING,
  },
  construction: {
    id: 'construction',
    name: 'Construction',
    description: 'Building big. Unlocks orbital stations, shipyards, the frigate and destroyer hulls, asteroid thrusters, and the Dyson foundation.',
    icon: '🔧',
    perLevel: 0.05,
    effectText: '-5% ship build cost',
    baseCost: RESEARCH_BASE_COST,
    costScaling: RESEARCH_COST_SCALING,
  },
  industry: {
    id: 'industry',
    name: 'Society',
    description: 'Everything civilian. Unlocks the lab, forge and mint, then diplomatic pacts, senate proposals, and the Chancellor election.',
    icon: '⛏',
    perLevel: 0.10,
    effectText: '+10% settlement yield',
    baseCost: RESEARCH_BASE_COST,
    costScaling: RESEARCH_COST_SCALING,
  },
  sensors: {
    id: 'sensors',
    name: 'Sensors',
    description: 'Knowing things. Every level widens your scan radius AND peels back another layer of what your rivals are doing.',
    icon: '📡',
    perLevel: 0.12,
    effectText: '+12% sensor range',
    baseCost: RESEARCH_BASE_COST,
    costScaling: RESEARCH_COST_SCALING,
  },
};

export const ALL_TECH_IDS: TechId[] = [
  'weapons', 'armor', 'propulsion', 'construction', 'industry', 'sensors',
];

/**
 * Per-faction tech progress: completed levels, the currently-researching
 * tech, and a queue of techs to research next.
 *
 * `researching` becomes null when a level completes and the queue is empty.
 * When the queue has entries, the next one auto-promotes to `researching`
 * and progress resets — handled in the per-tick reducer in gameContext.
 */
export interface FactionTechState {
  levels: Partial<Record<TechId, number>>;  // missing key = 0
  researching: TechId | null;
  progress: number;                          // science accumulated toward next level
  queue?: TechId[];                          // upcoming research, FIFO
}

/**
 * Maximum science a faction can spend per tick toward its current research.
 * Caps the per-tick drain so a player who's been stockpiling can't insta-
 * complete a tech the moment they pick it. Combined with baseCost (30–50
 * for L1) this means a fresh tech takes ~10 ticks at base rate even with
 * an enormous stockpile, which feels like "build over time" rather than
 * "spend lump sum." Future-tunable; exposed here so tunables/AI can read it.
 */
export const MAX_SCIENCE_PER_TICK = 3;

export function emptyFactionTechState(): FactionTechState {
  return { levels: {}, researching: null, progress: 0, queue: [] };
}

/** Current level (0 if never researched). */
export function techLevel(state: FactionTechState | undefined, id: TechId): number {
  if (!state) return 0;
  return state.levels[id] ?? 0;
}

/** True when this tech has hit the global TECH_MAX_LEVEL cap. */
export function isTechMaxed(state: FactionTechState | undefined, id: TechId): boolean {
  return techLevel(state, id) >= TECH_MAX_LEVEL;
}

/** True when every tech track is at TECH_MAX_LEVEL — Science Victory trigger. */
export function allTechsMaxed(state: FactionTechState | undefined): boolean {
  for (const id of ALL_TECH_IDS) {
    if (techLevel(state, id) < TECH_MAX_LEVEL) return false;
  }
  return true;
}

/** Science cost to advance from current level (N) to N+1 of the given tech. */
export function nextLevelCost(currentLevel: number, def: TechDef): number {
  const nextLevel = currentLevel + 1;
  return Math.ceil(def.baseCost * Math.pow(nextLevel, def.costScaling));
}

/** Cost for the next level of `id` given current state. */
export function costForNext(state: FactionTechState | undefined, id: TechId): number {
  return nextLevelCost(techLevel(state, id), TECH_DEFS[id]);
}

/** Effect magnitude at level N — flat `perLevel * level`. */
export function effectAtLevel(def: TechDef, level: number): number {
  return def.perLevel * level;
}

// ============================================================
// Modifier helpers — game logic calls these to read the current
// effect of a faction's tech levels. All return multipliers
// applied to base game values.
// ============================================================

/** Effective WEAPONS level. The short-lived 'energy_weapons' track was
 *  folded back into 'weapons'; max() honours any levels a live game
 *  banked there so nobody loses research they paid for. */
export function weaponsLevel(state: FactionTechState | undefined): number {
  return Math.max(techLevel(state, 'weapons'), techLevel(state, 'energy_weapons' as TechId));
}

/** Effective DEFENSE level ('armor' track). Same fold-back for the
 *  short-lived 'shields' track. */
export function defenseLevel(state: FactionTechState | undefined): number {
  return Math.max(techLevel(state, 'armor'), techLevel(state, 'shields' as TechId));
}

/** Weapon damage multiplier — scales BOTH ⚔ kinetic and ⚡ energy mounts.
 *  1.0 at level 0. */
export function combatModifier(state: FactionTechState | undefined): number {
  return 1 + effectAtLevel(TECH_DEFS.weapons, weaponsLevel(state));
}

/** Max-HP multiplier — scales BOTH 🛡 shields and 🪨 armor. Baked HP
 *  already reflects tech at build time; this is the live repair-ceiling
 *  bump, so a Defense-teched fleet repairs into a bigger buffer. */
export function hpModifier(state: FactionTechState | undefined): number {
  return 1 + effectAtLevel(TECH_DEFS.armor, defenseLevel(state));
}

/** Per-rank multiplier applied to a ship's BOTH damage and max HP.
 *  Each confirmed kill grants +1 rank → +1% damage and +1% HP. Stacks
 *  multiplicatively with the faction-level weapons/armor tech modifiers.
 *  A rank-25 destroyer with weapons-3 (+30%) hits for 1.25 × 1.30 = 1.625×
 *  base — meaningful veteran reward without runaway stacking. */
export const RANK_PER_KILL_MUL = 0.01;

export function rankDamageMul(rank: number | undefined): number {
  return 1 + RANK_PER_KILL_MUL * Math.max(0, rank ?? 0);
}

export function rankHpMul(rank: number | undefined): number {
  return 1 + RANK_PER_KILL_MUL * Math.max(0, rank ?? 0);
}

/** Base per-ship engine-acceleration multiplier for the torch transfer
 *  model. Was tied to the Flight Dynamics tech (a universal speed line);
 *  that tech has been scrapped — speed now comes ONLY from 🔥 booster
 *  engine parts, scaled by Propulsion (see engineAccelMultiplier in
 *  shipParts.ts). Base acceleration is therefore fixed at DEFAULT_ENGINE_G,
 *  so this returns a neutral 1. Kept as a named seam (rather than deleting
 *  the ~5 call sites) so the transfer math reads the same and a future
 *  universal-speed source could slot back in here. `state` is unused. */
export function engineGModifier(
  _state?: FactionTechState | { levels: Record<string, number> } | undefined,
): number {
  return 1;
}

/** Build-cost multiplier (lower = cheaper). Clamped at 0.25 of base. */
export function buildCostModifier(state: FactionTechState | undefined): number {
  const reduction = effectAtLevel(TECH_DEFS.construction, techLevel(state, 'construction'));
  return Math.max(0.25, 1 - reduction);
}

/** Settlement yield multiplier. */
export function yieldModifier(state: FactionTechState | undefined): number {
  return 1 + effectAtLevel(TECH_DEFS.industry, techLevel(state, 'industry'));
}

/** Sensor radius multiplier. */
export function sensorModifier(state: FactionTechState | undefined): number {
  return 1 + effectAtLevel(TECH_DEFS.sensors, techLevel(state, 'sensors'));
}
