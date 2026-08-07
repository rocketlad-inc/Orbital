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
  damagePerTick: 7,
  speed: 0.85,
  fuelCapacity: 80,
  speedModifier: 0.7,
  cargoCapacity: 0,
  cost: { fuel: 0, ore: 20, credits: 16 },
  buildTime: 10,
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
  damagePerTick: 20.25,
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
  damagePerTick: 45,
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
