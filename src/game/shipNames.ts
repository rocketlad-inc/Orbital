// ============================================================
// shipNames — the default ship-name pools + picker.
//
// One shared bank for the player BuildPanel and the faction AI so
// every hull in a game draws from the same universe of names. Names
// are grouped by class and chosen to match the hull's character:
//
//   corvette   fast, sharp, predatory — blades, raptors, winds,
//              venomous things, anything that strikes first
//   frigate    steadfast line-of-battle — virtues, fortifications,
//              guardians, lawgivers, scientists
//   destroyer  heavy and wrathful — monsters, storms, volcanoes,
//              siege weapons, conquerors
//   freighter  the working spine of an empire — beasts of burden,
//              rivers, clippers, explorers, good fortune
//
// The picker filters out names already in use in the game; when a
// pool runs dry it falls back to "<Name>-NN" hull numbering.
// ============================================================

// The pools and the picker live in shipNamePools.js (plain JS, so the
// worker shares them); this file gives them their types.

import type { ShipClassName } from './shipClasses';
import { SHIP_NAME_POOLS as POOLS, randomShipName as pick } from './shipNamePools';

export const SHIP_NAME_POOLS: Record<ShipClassName, string[]> = POOLS;

/**
 * Pick a default name for a new hull: a pool name not already in use,
 * or "<Name>-NN" hull numbering once the pool for that class runs dry.
 */
export function randomShipName(cls: ShipClassName, existingNames: Iterable<string>): string {
  return pick(cls, existingNames);
}
