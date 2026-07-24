// ============================================================
// settlementNames — the default city/station name pools + picker.
//
// One shared bank so every settlement founded in a game draws from
// the same universe of names, mirroring shipNames.ts. Names are
// grouped by type to match what they're naming:
//
//   city     surface settlements — desert holds, domed colonies,
//             free ports, capitals of worlds we never got to visit
//   station   orbital installations — shipyards, waystations,
//             tunnel-cities in the rock, deep-space outposts
//
// Drawn from classic sci-fi (Dune, Star Wars, The Expanse, Star
// Trek) as an homage, not a reproduction — single place names, the
// same register as calling a corvette "Kestrel". The picker filters
// out names already in use in the game; when a pool runs dry it
// falls back to "<Body> City/Station[ N]" (settlements.ts already
// owns that fallback via suggestSettlementName).
// ============================================================

import { SettlementType } from '../types';

export const SETTLEMENT_NAME_POOLS: Record<SettlementType, string[]> = {
  city: [
    // Dune — desert holds and sietches
    'Arrakeen', 'Carthag', 'Sietch Tabr', 'Tuono', 'Windsack',
    'Rimwall West', 'Tsimpo', 'Habbanya', 'Old Gap', 'Red Chasm',
    'Harg Pass', 'Splintered Rock', 'Tabr', 'Cielago North', 'Plaster Basin',
    // Star Wars — cities and settlements
    'Mos Eisley', 'Mos Espa', 'Bestine', 'Anchorhead', 'Theed',
    'Coruscant Prime', 'Chandrila', 'Hanna City', 'Jedha City', 'Aldera',
    'Canto Bight', 'Corellia', 'Lothal', 'Niima Outpost', 'Tanaab',
    // The Expanse — colonies and domes
    'Londres Nova', 'New Terra', 'Foundation Dome', 'Baltimore Enclave',
    'Corley Reach', 'Iapetus Hold', 'Ilus Landing', 'New Anchorage',
    'Ganymede Greenhouse', 'Auberon Reach',
    // Star Trek — planetary settlements
    "Shi'Kahr", 'Vulcana Regar', 'Ashalla', "Qo'noS Prime", 'Risa Landing',
    'New Paris', 'Millennium City', 'Ketha Lowlands', 'Dahkur Province',
    // Frontier and homestead register (generic sci-fi settler naming)
    'Landfall', 'First Light', 'New Dawn', 'Threshold', 'Farside',
    'Deep Furrow', 'Sunward Hold', 'Last Meridian', 'Twin Ridge',
    'Hollow Vale', 'Amber Reach', 'Dustwatch', 'Cinder Flats',
  ],
  station: [
    // Dune — Guild and spacing infrastructure
    'Guild Heighliner Dock', 'Spacing Post', 'Highliner Bay', 'Chusuk Relay',
    // Star Wars — orbital and deep-space installations
    'Cloud City', 'Scarif Station', 'Eadu Platform', 'Csilla Anchorage',
    'Outpost Beta', 'Nevarro Yard', 'Corulag Anchorage', 'Ord Mantell Post',
    'Bespin Platform', 'Kessel Relay', 'Vandor Waystation',
    // The Expanse — belt and outer-system stations
    'Tycho Station', 'Ceres Station', 'Medina Station', 'Thoth Station',
    'Anderson Station', 'Corley Station', 'Pallas Yard', 'Iapetus Station',
    'Ganymede Relay', 'Bara Gaon Post', 'Pallas Junction', 'Eros Waystation',
    // Star Trek — starbases and shipyards
    'Deep Space Nine', 'Deep Space Five', 'Starbase One', 'Starbase 74',
    'Regula Station', 'McKinley Yard', 'Empok Nor', 'Terok Nor',
    'Wolf 359 Post', 'Jupiter Yard', 'Spacedock', 'Vulcan Relay',
    // Generic deep-space register
    'High Anchor', 'Farpoint', 'Longview', 'Nightwatch', 'Outer Reach',
    'Anchorpoint', 'Skybridge', 'Drydock Seven', 'Beacon Point', 'Threshold Yard',
  ],
};

/**
 * Pick a default name for a new settlement: a pool name not already
 * in use, or null once the pool for that type runs dry (callers fall
 * back to a body-relative name, e.g. suggestSettlementName).
 */
export function randomSettlementName(
  type: SettlementType,
  existingNames: Iterable<string>,
): string | null {
  const pool = SETTLEMENT_NAME_POOLS[type];
  const taken = existingNames instanceof Set ? existingNames : new Set(existingNames);
  const available = pool.filter(n => !taken.has(n));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}
