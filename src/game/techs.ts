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
  'weapons', 'armor', 'propulsion', 'construction', 'industry', 'sensors',
];

/**
 * Per-faction tech progress: completed levels and the currently-researching tech.
 */
export interface FactionTechState {
  levels: Partial<Record<TechId, number>>;  // missing key = 0
  researching: TechId | null;
  progress: number;                          // science accumulated toward next level
}

export function emptyFactionTechState(): FactionTechState {
  return { levels: {}, researching: null, progress: 0 };
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
