// ============================================================
// Ship Class Definitions — Expanse-inspired fleet roster
// ============================================================

export type ShipClassName = 'corvette' | 'frigate' | 'destroyer' | 'freighter';

export interface ShipClassDef {
  className: ShipClassName;
  displayName: string;
  description: string;

  // Combat stats
  firepower: number;    // damage per combat tick
  hp: number;           // hit points
  pdcRating: number;    // point-defense coverage (0-1), reduces incoming damage

  // Movement
  fuelCapacity: number;
  speedModifier: number; // multiplier on transfer time (lower = faster)

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
  fuelCapacity: 80,
  speedModifier: 0.7,
  cargoCapacity: 0,
  cost: { fuel: 10, ore: 15, credits: 10 },
  buildTime: 30,
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
  fuelCapacity: 120,
  speedModifier: 1.0,
  cargoCapacity: 0,
  cost: { fuel: 20, ore: 30, credits: 25 },
  buildTime: 60,
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
  hp: 200,
  pdcRating: 0.6,
  fuelCapacity: 150,
  speedModifier: 1.4,
  cargoCapacity: 0,
  cost: { fuel: 40, ore: 60, credits: 50 },
  buildTime: 120,
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
  fuelCapacity: 100,
  speedModifier: 1.3,
  cargoCapacity: 50,
  cost: { fuel: 15, ore: 20, credits: 15 },
  buildTime: 45,
  canHarvest: true,
  size: 4,
  icon: '□',
};

export const SHIP_CLASSES: Record<ShipClassName, ShipClassDef> = {
  corvette: CORVETTE,
  frigate: FRIGATE,
  destroyer: DESTROYER,
  freighter: FREIGHTER,
};

/** All buildable ship classes in display order */
export const BUILDABLE_CLASSES: ShipClassName[] = ['corvette', 'frigate', 'destroyer', 'freighter'];

/** Get class definition, throws if invalid */
export function getShipClass(name: ShipClassName): ShipClassDef {
  const def = SHIP_CLASSES[name];
  if (!def) throw new Error(`Unknown ship class: ${name}`);
  return def;
}
