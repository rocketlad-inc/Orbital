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
    'Sietch Jacurutu', 'Two Bird Sietch', 'Red Wall Sietch', 'Wind Trap Village',
    'Gara Kulon', 'False Wall South', 'Hole-in-the-Rock', 'True Wall Erg',
    'Sihaya Ridge', 'Shuloch', 'Cave of Birds', 'Sietch Chin',
    'Old Sietch', 'Rock Village', 'South Rim Hold',
    // Star Wars — cities and settlements
    'Mos Eisley', 'Mos Espa', 'Bestine', 'Anchorhead', 'Theed',
    'Coruscant Prime', 'Chandrila', 'Hanna City', 'Jedha City', 'Aldera',
    'Canto Bight', 'Corellia', 'Lothal', 'Niima Outpost', 'Tanaab',
    'Coronet City', 'Cato Neimoidia', 'Black Spire Outpost', 'Kaadara',
    'Calodan', 'Tehar', 'Kijimi City', 'Iziz', 'Keldabe', 'Sundari',
    'Otomok', 'Weewib', 'Nubla City', 'Kessik City', 'Skarch',
    // The Expanse — colonies and domes
    'Londres Nova', 'New Terra', 'Foundation Dome', 'Baltimore Enclave',
    'Corley Reach', 'Iapetus Hold', 'Ilus Landing', 'New Anchorage',
    'Ganymede Greenhouse', 'Auberon Reach',
    'Nauvoo Landing', 'Dawes Landing', 'Fred Johnson Post', 'Ashford Row',
    'Ceres Understory', 'Coalsack Landing', 'Belter Row', 'Independence Dome',
    'Freehold Dome', 'New Londres',
    // Star Trek — planetary settlements
    "Shi'Kahr", 'Vulcana Regar', 'Ashalla', "Qo'noS Prime", 'Risa Landing',
    'New Paris', 'Millennium City', 'Ketha Lowlands', 'Dahkur Province',
    'Ki Baratan', 'Dartha', 'Rakantha Province', 'ShanaiKahr', 'First City',
    'Coridan Prime', 'Cardassia Prime', 'Andor Capital', 'Trill Capital',
    // Frontier and homestead register (generic sci-fi settler naming)
    'Landfall', 'First Light', 'New Dawn', 'Threshold', 'Farside',
    'Deep Furrow', 'Sunward Hold', 'Last Meridian', 'Twin Ridge',
    'Hollow Vale', 'Amber Reach', 'Dustwatch', 'Cinder Flats',
    'Cold Harbor', 'Long Shadow', 'Broken Ridge', 'Salt Flats',
    'Iron Gate', 'Distant Shore', 'Quiet Basin', 'Emberfall',
    'Stonebridge', 'Farwatch', 'Lonesome Ridge', 'Windward Hold', 'Silt Reach',
  ],
  station: [
    // Dune — Guild and spacing infrastructure
    'Guild Heighliner Dock', 'Spacing Post', 'Highliner Bay', 'Chusuk Relay',
    'Junction Dock', 'Spacing Guild Anchorage', 'Heighliner Berth', 'Foldspace Relay',
    // Star Wars — orbital and deep-space installations
    'Cloud City', 'Scarif Station', 'Eadu Platform', 'Csilla Anchorage',
    'Outpost Beta', 'Nevarro Yard', 'Corulag Anchorage', 'Ord Mantell Post',
    'Bespin Platform', 'Kessel Relay', 'Vandor Waystation',
    'Kamino Platform', 'Raxus Yard', 'Geonosis Foundry', 'Mustafar Refinery',
    'Ryloth Anchorage', 'Corellia Shipyards', 'Fondor Shipyards',
    'Kuat Drive Yards', 'Sienar Fleet Yards', 'Byss Station', 'Yavin Station',
    // The Expanse — belt and outer-system stations
    'Tycho Station', 'Ceres Station', 'Medina Station', 'Thoth Station',
    'Anderson Station', 'Corley Station', 'Pallas Yard', 'Iapetus Station',
    'Ganymede Relay', 'Bara Gaon Post', 'Pallas Junction', 'Eros Waystation',
    'Callisto Yard', 'Io Refinery', 'Titan Anchorage', 'Luna Gateway',
    'Phoebe Station', 'Hygiea Yard', 'Vesta Anchorage', 'Rhea Waystation',
    'Enceladus Relay', 'Mimas Post', 'Behemoth Yard', 'Freehold Station',
    // Star Trek — starbases and shipyards
    'Deep Space Nine', 'Deep Space Five', 'Starbase One', 'Starbase 74',
    'Regula Station', 'McKinley Yard', 'Empok Nor', 'Terok Nor',
    'Wolf 359 Post', 'Jupiter Yard', 'Spacedock', 'Vulcan Relay',
    'Starbase 375', 'Starbase 12', 'Utopia Planitia Yards', 'Deep Space Seven',
    'Deep Space Twelve', 'Earth Spacedock', 'Qualor II Depot', 'Nimbus Station',
    'Deneva Yard', 'Rigel Station', 'Argus Array', 'Gamma Relay',
    // Generic deep-space register
    'High Anchor', 'Farpoint', 'Longview', 'Nightwatch', 'Outer Reach',
    'Anchorpoint', 'Skybridge', 'Drydock Seven', 'Beacon Point', 'Threshold Yard',
    'Ironhold Yard', 'Farreach Post', 'Lastlight Anchorage', 'Stormwatch Platform',
    'Duskgate Relay', 'Coldharbor Dock', 'Sunspire Yard', 'Windward Post',
    'Blackpoint Station', 'Silvergate Anchorage',
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
