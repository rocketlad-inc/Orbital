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

export type TechId =
  // Combat tech is split by damage type so a faction can specialize
  // doctrine, not just per-ship. IDs 'weapons'/'armor' are KEPT (not
  // renamed) so existing games, saved designs and the two victory
  // checks need no data migration — 'weapons' simply now means kinetic,
  // and 'armor' means the armor-plate part specifically.
  | 'weapons'          // KINETIC weapons — scales ⚔ kinetic mounts
  | 'energy_weapons'   // ENERGY weapons — scales ⚡ energy mounts
  | 'shields'          // scales 🛡 shield arrays (kinetic mitigation)
  | 'armor'            // scales 🪨 armor plates (energy mitigation)
  | 'propulsion'       // booster-engine part speed (the only speed tech)
  | 'construction'     // ship build cost reduction
  | 'industry'         // settlement yield
  | 'sensors';         // SOI visibility radius

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

export const TECH_DEFS: Record<TechId, TechDef> = {
  weapons: {
    id: 'weapons',
    name: 'Kinetic Weapons',
    description: 'Railguns, autocannon, and slug throwers — the punch of every ⚔ kinetic mount you fit. Kinetic shreds armor but bleeds off against shields.',
    icon: '⚔',
    perLevel: 0.10,
    effectText: '+10% · stronger ⚔ kinetic mounts',
    baseCost: 40,
    costScaling: 1.7,
  },
  energy_weapons: {
    id: 'energy_weapons',
    name: 'Energy Weapons',
    description: 'Lasers, plasma, and particle beams — the punch of every ⚡ energy mount you fit. Energy melts shields but scatters off heavy armor.',
    icon: '⚡',
    perLevel: 0.10,
    effectText: '+10% · stronger ⚡ energy mounts',
    baseCost: 40,
    costScaling: 1.7,
  },
  shields: {
    id: 'shields',
    name: 'Shields',
    description: 'Deflector fields that soak incoming fire — the strength of every 🛡 shield array you fit. Shields blunt KINETIC rounds; energy passes through them.',
    icon: '🛡',
    perLevel: 0.08,
    effectText: '+8% HP · stronger 🛡 arrays (vs kinetic)',
    baseCost: 40,
    costScaling: 1.7,
  },
  armor: {
    id: 'armor',
    name: 'Armor',
    description: 'Ablative plating and damage control — the strength of every 🪨 armor plate you fit. Armor shrugs off ENERGY beams; kinetic slugs chew through it.',
    icon: '🪨',
    perLevel: 0.08,
    effectText: '+8% HP · stronger 🪨 plates (vs energy)',
    baseCost: 40,
    costScaling: 1.7,
  },
  propulsion: {
    id: 'propulsion',
    name: 'Propulsion',
    description: 'Drive tuning for the 🔥 booster engines you fit in the designer. Faster transits — but only for ships carrying an engine mount.',
    icon: '🚀',
    perLevel: 0.06,
    effectText: '+6% per 🔥 booster engine',
    baseCost: 35,
    costScaling: 1.6,
  },
  construction: {
    id: 'construction',
    name: 'Construction',
    description: 'Automated yards. Cheaper hulls.',
    icon: '🔧',
    perLevel: 0.05,
    effectText: '-5% ship build cost',
    baseCost: 50,
    costScaling: 1.8,
  },
  industry: {
    id: 'industry',
    name: 'Industry',
    description: 'Refinery upgrades. Settlements extract more per harvest.',
    icon: '⛏',
    perLevel: 0.10,
    effectText: '+10% settlement yield',
    baseCost: 45,
    costScaling: 1.7,
  },
  sensors: {
    id: 'sensors',
    name: 'Sensors',
    description: 'Deep-space arrays. Extended visibility radius.',
    icon: '📡',
    perLevel: 0.12,
    effectText: '+12% sensor range',
    baseCost: 30,
    costScaling: 1.5,
  },
};

export const ALL_TECH_IDS: TechId[] = [
  'weapons', 'energy_weapons', 'shields', 'armor',
  'propulsion', 'construction', 'industry', 'sensors',
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

/** KINETIC weapon damage multiplier for a faction. 1.0 at level 0. */
export function combatModifier(state: FactionTechState | undefined): number {
  return 1 + effectAtLevel(TECH_DEFS.weapons, techLevel(state, 'weapons'));
}

/** ENERGY weapon damage multiplier. Legacy games that only teched the
 *  old (kinetic) 'weapons' line fall back to it, so an existing
 *  energy-armed fleet isn't silently un-teched by the split. */
export function energyCombatModifier(state: FactionTechState | undefined): number {
  const lvl = Math.max(techLevel(state, 'energy_weapons'), techLevel(state, 'weapons'));
  return 1 + effectAtLevel(TECH_DEFS.energy_weapons, lvl);
}

/** Max-HP multiplier for ships of a given faction — the strongest of the
 *  two defensive lines (shields / armor). Baked HP already reflects the
 *  per-part tech at build time; this is the live repair-ceiling bump, so
 *  a faction that teched EITHER defense repairs into a bigger buffer.
 *  Legacy 'armor' covers both until 'shields' is researched. */
export function hpModifier(state: FactionTechState | undefined): number {
  const lvl = Math.max(techLevel(state, 'armor'), techLevel(state, 'shields'));
  return 1 + effectAtLevel(TECH_DEFS.armor, lvl);
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
