// Type-only (erased at build): shipParts imports THIS module, so a
// value import back would be a runtime cycle. The cost function is
// passed in by the caller for the same reason.
import type { ShipPartId } from './shipParts';
// ============================================================
// Ship Class Definitions — Expanse-inspired fleet roster
// ============================================================

export type ShipClassName = 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';

export interface ShipClassDef {
  className: ShipClassName;
  displayName: string;
  description: string;

  // Combat stats
  firepower: number;    // damage per combat tick (used in auto-resolve combat at bodies)
  hp: number;           // hit points
  pdcRating: number;    // point-defense coverage (0-1), reduces incoming damage
  range: number;        // engagement range in world units (0 = no combat capability)
  damagePerTick: number; // damage dealt per TICK while engaged (COMBAT V2)

  // Movement
  fuelCapacity: number;
  /** COMBAT V2 legacy. Travel time now derives from `speed` — see
   *  combatSpeedOf / travelMultiplierOf below. Kept only so older callers
   *  compile; it is defined as 0.50/speed so the two cannot disagree. */
  speedModifier: number;
  /** COMBAT V2. 0-1 mobility. Drives BOTH the hit roll
   *  (p = atk^2/(atk^2+def^2)) and travel time. Mirrors
   *  worker/factions.js SHIP_COMBAT_STATS.speed — KEEP IN SYNC. */
  speed: number;

  // Cargo
  cargoCapacity: number; // cargo slots (0 for combat ships)

  // Economy
  cost: { fuel: number; ore: number; credits: number };
  buildTime: number;     // ticks to build
  canHarvest: boolean;   // only freighters can harvest resources

  // Visual
  size: number;          // render size on map (px radius)
  icon: string;          // unicode glyph for map label
}

/**
 * Corvette — Fast attack craft. The Rocinante.
 * Cheap, fast, light firepower. Scouts and wolfpack raiders.
 */
const CORVETTE: ShipClassDef = {
  className: 'corvette',
  displayName: 'Corvette',
  description: 'Fast attack craft. Light armor, high speed.',
  firepower: 8,
  hp: 40,
  pdcRating: 0.2,
  range: 8,
  // 3.75 -> 7: corvettes were losing badly to destroyers in live play
  // (see migration 0071). Mirrors SHIP_COMBAT_STATS in worker/factions.js.
  damagePerTick: 3.5,      // halved in the pacing pass
  speed: 0.85,
  fuelCapacity: 80,
  speedModifier: 0.7,
  cargoCapacity: 0,
  // Doubled, and +6 ticks, in the pacing pass — swarms outran any
  // answer at 20/16/10. MIRRORS SHIP_BUILD_COST in worker/actions.js.
  cost: { fuel: 0, ore: 40, credits: 32 },
  buildTime: 16,
  canHarvest: false,
  size: 3,
  icon: '▸',
};

/**
 * Frigate — Backbone of any fleet.
 * Balanced combat vessel. The Donnager-class in spirit (scaled down).
 */
const FRIGATE: ShipClassDef = {
  className: 'frigate',
  displayName: 'Frigate',
  description: 'Balanced warship. Solid firepower and armor.',
  firepower: 18,
  hp: 100,
  pdcRating: 0.4,
  range: 14,
  damagePerTick: 10.125,   // halved in the pacing pass
  speed: 0.50,
  fuelCapacity: 120,
  speedModifier: 1.0,
  cargoCapacity: 0,
  cost: { fuel: 0, ore: 45, credits: 36 },
  buildTime: 20,
  canHarvest: false,
  size: 4,
  icon: '◆',
};

/**
 * Destroyer — Heavy hitter. Slow but devastating.
 * The Truman-class. Carries torpedoes (abstracted as high firepower).
 */
const DESTROYER: ShipClassDef = {
  className: 'destroyer',
  displayName: 'Destroyer',
  description: 'Heavy warship. Devastating firepower, slow.',
  firepower: 35,
  hp: 400,
  pdcRating: 0.6,
  range: 22,
  damagePerTick: 22.5,     // halved in the pacing pass
  speed: 0.30,
  fuelCapacity: 150,
  speedModifier: 1.4,
  cargoCapacity: 0,
  cost: { fuel: 0, ore: 110, credits: 95 },
  buildTime: 40,
  canHarvest: false,
  size: 5,
  icon: '◈',
};

/**
 * Freighter — Cargo hauler for trade routes.
 * No combat ability. The Canterbury. Can harvest resources from bodies.
 */
const FREIGHTER: ShipClassDef = {
  className: 'freighter',
  displayName: 'Freighter',
  description: 'Unarmed cargo hauler. Harvests resources at bodies.',
  firepower: 0,
  hp: 60,
  pdcRating: 0.1,
  range: 0,
  damagePerTick: 0,
  speed: 0.55,
  fuelCapacity: 100,
  speedModifier: 1.3,
  cargoCapacity: 50,
  cost: { fuel: 0, ore: 28, credits: 20 },
  buildTime: 15,
  canHarvest: true,
  size: 4,
  icon: '□',
};

/**
 * Colony Ship — consumable expansion hull (DESIGN-identity-economy §4).
 * Unarmed, no cargo, slow. Founding a city ALWAYS consumes one; a
 * station consumes one unless you already own a settlement at the body.
 * ~3× freighter cost — it is the expansion pacing knob. MP-only verb:
 * SP's frozen sim never consumes them.
 */
const COLONY: ShipClassDef = {
  className: 'colony',
  displayName: 'Colony Ship',
  description: 'Consumable settler transport. Deploying a settlement consumes it.',
  firepower: 0,
  hp: 60,
  pdcRating: 0,
  range: 0,
  damagePerTick: 0,
  speed: 0.55,
  fuelCapacity: 60,
  speedModifier: 1.6,
  cargoCapacity: 0,
  cost: { fuel: 0, ore: 80, credits: 60 },
  buildTime: 15,
  canHarvest: false,
  size: 4,
  icon: '◉',
};

export const SHIP_CLASSES: Record<ShipClassName, ShipClassDef> = {
  corvette: CORVETTE,
  frigate: FRIGATE,
  destroyer: DESTROYER,
  freighter: FREIGHTER,
  colony: COLONY,
};

/** All buildable ship classes in display order */
export const BUILDABLE_CLASSES: ShipClassName[] = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];

/**
 * Per-tick fleet upkeep (DESIGN-fleet-economy §1). Every ACTIVE hull
 * bills this each tick; an empty stockpile puts the whole fleet in
 * arrears (−25% damage) until income clears the debt. Display/quote
 * table only — the server bills authoritatively. KEEP IN SYNC with the
 * UPKEEP tables in worker/room.js (upkeep pass) and worker/state.js.
 */
export const SHIP_UPKEEP: Record<ShipClassName, { credits: number; ore: number }> = {
  corvette:  { credits: 0.25, ore: 0 },
  frigate:   { credits: 0.5,  ore: 0.5 },
  destroyer: { credits: 1,    ore: 1 },
  freighter: { credits: 1,    ore: 0 },
  colony:    { credits: 0,    ore: 0 },
};

/**
 * Split a hull's upkeep across credits and metal IN PROPORTION TO WHAT
 * IT IS MADE OF. Mirror of upkeepSplit in worker/shipDesigns.js — the
 * server bills authoritatively, this is the designer's quote.
 *
 * The class table above is now a TOTAL, not a currency breakdown: a
 * hull's whole bill is `credits + ore`, and the loadout decides which
 * pockets it comes out of. Kinetic/shield are metal-side (8/1),
 * energy/armor credit-side (1/8), so the axis that governs what a ship
 * costs to BUILD now governs what it costs to KEEP. Totals are
 * preserved exactly — this moves a bill, it never changes its size.
 *
 * A bare hull falls back to its own build-cost ratio (a corvette is
 * 20 ore / 16 credits, so ~56% metal), never to the old credits-only
 * default — that bias is the thing being removed.
 */
export function upkeepSplitFor(
  cls: ShipClassName,
  parts: ShipPartId[] | undefined,
  partsCostOf: (p: ShipPartId[]) => { ore: number; credits: number },
): { credits: number; ore: number } {
  const t = SHIP_UPKEEP[cls];
  const total = Math.max(0, t.credits) + Math.max(0, t.ore);
  if (!(total > 0)) return { credits: 0, ore: 0 };
  let { ore, credits } = partsCostOf(parts ?? []);
  if (ore + credits <= 0) {
    const hull = SHIP_CLASSES[cls].cost;
    ore = hull.ore;
    credits = hull.credits;
  }
  const denom = ore + credits;
  const oreShare = denom > 0 ? ore / denom : 0.5;
  const o = total * oreShare;
  return { ore: o, credits: total - o };
}

/**
 * Get class definition. Never throws — an unknown class returns the
 * frigate def with a console warning, so a single bad ship from the
 * server can't crash the whole React tree (which previously happened
 * when the worker spawned legacy 'cargo'-class ships). Server-side
 * names should be translated at the network boundary; this fallback
 * is a defense-in-depth safety net.
 */
export function getShipClass(name: ShipClassName | string): ShipClassDef {
  const def = SHIP_CLASSES[name as ShipClassName];
  if (def) return def;
  if (typeof console !== 'undefined') {
    console.warn(`Unknown ship class: ${name} — falling back to frigate`);
  }
  return FRIGATE;
}
