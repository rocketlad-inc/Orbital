// ============================================================
// Tech Tree — Neptune's Pride / Stellaris-late-game style.
//
// Six tech tracks, each with infinite levels. Each level costs
// progressively more science but yields a flat per-level modifier
// (so absolute benefit scales linearly while cost scales
// super-linearly — Stellaris repeatables pattern).
//
// Effects are applied via the helpers at the bottom of this file
// (combatModifier, buildCostModifier, etc.) which game logic calls
// to read the current modifier for a faction.
// ============================================================

export type TechId =
  | 'weapons'        // ship firepower
  | 'armor'          // ship HP
  | 'propulsion'     // transfer fuel efficiency
  | 'flight'         // transfer travel time
  | 'construction'   // ship build cost reduction
  | 'industry'       // settlement yield
  | 'sensors';       // SOI visibility radius

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
    name: 'Weapons',
    description: 'PDC velocity, torpedo yield, sustained-fire rate.',
    icon: '⚔',
    perLevel: 0.10,
    effectText: '+10% ship firepower',
    baseCost: 40,
    costScaling: 1.7,
  },
  armor: {
    id: 'armor',
    name: 'Armor',
    description: 'Hull plating composition and damage-control routines.',
    icon: '🛡',
    perLevel: 0.08,
    effectText: '+8% ship max HP',
    baseCost: 40,
    costScaling: 1.7,
  },
  propulsion: {
    id: 'propulsion',
    name: 'Propulsion',
    description: 'High-efficiency drives. Less fuel per transfer.',
    icon: '🚀',
    perLevel: 0.06,
    effectText: '-6% transfer Δv cost',
    baseCost: 35,
    costScaling: 1.6,
  },
  flight: {
    id: 'flight',
    name: 'Flight Dynamics',
    description: 'Advanced trajectory planning and high-thrust burns. Faster transits across the system.',
    icon: '🛸',
    perLevel: 0.06,
    effectText: '-6% travel time',
    baseCost: 50,
    costScaling: 1.7,
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
  'weapons', 'armor', 'propulsion', 'flight', 'construction', 'industry', 'sensors',
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

/** Damage multiplier for ships of a given faction. 1.0 at level 0. */
export function combatModifier(state: FactionTechState | undefined): number {
  return 1 + effectAtLevel(TECH_DEFS.weapons, techLevel(state, 'weapons'));
}

/** Max-HP multiplier for ships of a given faction. */
export function hpModifier(state: FactionTechState | undefined): number {
  return 1 + effectAtLevel(TECH_DEFS.armor, techLevel(state, 'armor'));
}

/** Transfer fuel-cost multiplier (lower = cheaper). Clamped at 0.2 of base. */
export function fuelCostModifier(state: FactionTechState | undefined): number {
  const reduction = effectAtLevel(TECH_DEFS.propulsion, techLevel(state, 'propulsion'));
  return Math.max(0.2, 1 - reduction);
}

/** Travel-time multiplier (lower = faster). Clamped at 0.25 of base so
 *  even fully-maxed players still have to commit ticks to long voyages. */
export function travelTimeModifier(state: FactionTechState | undefined): number {
  const reduction = effectAtLevel(TECH_DEFS.flight, techLevel(state, 'flight'));
  return Math.max(0.25, 1 - reduction);
}

/** Engine-G multiplier for the torch transfer model. Returns the
 *  factor applied to DEFAULT_ENGINE_G (≈ 0.05g) to give this faction's
 *  current per-ship acceleration. Higher tech = higher g = shorter
 *  trip times AND lower total Δv (peak velocity scales with √(a·d),
 *  total Δv = 2·peakV).
 *
 *  Tied to the `flight` tech so it's the same research line that
 *  shrank Hohmann travel-time under the old model — players who
 *  invested there don't lose progress to the Bezier→Torch migration.
 *  Maxed-out flight tech is currently 4× base = 0.20g (Mars in ~3
 *  days, Pluto in ~12). */
export function engineGModifier(
  state: FactionTechState | { levels: Record<string, number> } | undefined,
): number {
  // Re-uses the same effect curve as travelTimeModifier — at level 0
  // the reduction is 0 (multiplier = 1), at maxed it's roughly 0.75
  // (multiplier ≈ 4). Could split into a separate tech later.
  //
  // Accepts both FactionTechState (TechId-typed) and the looser
  // FactionTechStateBase (string-typed) so MP-side callers don't have
  // to widen-cast at the call site.
  const lvl = state?.levels?.flight ?? 0;
  const reduction = effectAtLevel(TECH_DEFS.flight, lvl);
  return 1 / Math.max(0.25, 1 - reduction);
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
