// ============================================================
// settlementSkins — the colony and station skin catalogue (0154).
//
// Mirror of worker/skins.js (the server enforces it; this names and
// orders it for the pickers and the renderer). One free look per kind;
// the rest come with the Commander's Commission.
//
// The rule every skin keeps: change the CHARACTER, never the
// INFORMATION. A city's forge, mint, lab and thrusters, and a station's
// weapons, lab, shipyard and thrusters, keep their shapes and positions
// in every skin, because rivals read a world's strength from them. A
// skin restyles the habitats, the landing pad and the station hub.
// ============================================================

export type CitySkin = 'towers' | 'hive' | 'spires' | 'domes' | 'ziggurat';
export type StationSkin = 'hub' | 'wheel' | 'citadel' | 'spindle' | 'lattice';

export interface SkinDef<T extends string> {
  id: T;
  name: string;
  /** The tile label, where the full name will not fit. */
  short: string;
  /** One line for the picker's tooltip. */
  blurb: string;
  free?: boolean;
}

export const CITY_SKINS: SkinDef<CitySkin>[] = [
  { id: 'towers', name: 'Standard towers', short: 'Towers', blurb: 'Block towers on a landing pad.', free: true },
  { id: 'hive', name: 'Hive', short: 'Hive', blurb: 'Clustered hexagonal towers on a hex pad.' },
  { id: 'spires', name: 'Needle spires', short: 'Spires', blurb: 'Tall thin spires with beacon tips.' },
  { id: 'domes', name: 'Arcology domes', short: 'Domes', blurb: 'Glass domes with towers inside.' },
  { id: 'ziggurat', name: 'Terraced ziggurats', short: 'Ziggurats', blurb: 'Stepped pyramids, lit at the summit.' },
];

export const STATION_SKINS: SkinDef<StationSkin>[] = [
  { id: 'hub', name: 'Standard hub', short: 'Hub', blurb: 'A docking ring between solar wings.', free: true },
  { id: 'wheel', name: 'Wheel', short: 'Wheel', blurb: 'A spoked habitat ring, the classic station.' },
  { id: 'citadel', name: 'Citadel', short: 'Citadel', blurb: 'An armoured octagon with corner bastions.' },
  { id: 'spindle', name: 'Spindle', short: 'Spindle', blurb: 'A long axial hull with docking rings at each end.' },
  { id: 'lattice', name: 'Lattice', short: 'Lattice', blurb: 'An open truss frame with suspended spheres.' },
];

export const FREE_CITY_SKIN: CitySkin = 'towers';
export const FREE_STATION_SKIN: StationSkin = 'hub';

export function isCitySkin(v: unknown): v is CitySkin {
  return CITY_SKINS.some(s => s.id === v);
}
export function isStationSkin(v: unknown): v is StationSkin {
  return STATION_SKINS.some(s => s.id === v);
}
/** What a value DRAWS as: anything unknown or absent is the free look. */
export function citySkinOf(v: unknown): CitySkin {
  return isCitySkin(v) ? v : FREE_CITY_SKIN;
}
export function stationSkinOf(v: unknown): StationSkin {
  return isStationSkin(v) ? v : FREE_STATION_SKIN;
}
export function isPremiumSkin(v: string): boolean {
  return v !== FREE_CITY_SKIN && v !== FREE_STATION_SKIN;
}
/** How many premium styles the Commission adds, for the copy. */
export const PREMIUM_SKIN_COUNT = CITY_SKINS.filter(s => !s.free).length + STATION_SKINS.filter(s => !s.free).length;
