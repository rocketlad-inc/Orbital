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

import { tk } from '../i18n/core';

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
  { id: 'towers', get name() { return tk('data.skin.city.towers.name', 'Standard towers'); }, get short() { return tk('data.skin.city.towers.short', 'Towers'); }, get blurb() { return tk('data.skin.city.towers.blurb', 'Block towers on a landing pad.'); }, free: true },
  { id: 'hive', get name() { return tk('data.skin.city.hive.name', 'Hive'); }, get short() { return tk('data.skin.city.hive.short', 'Hive'); }, get blurb() { return tk('data.skin.city.hive.blurb', 'Clustered hexagonal towers on a hex pad.'); } },
  { id: 'spires', get name() { return tk('data.skin.city.spires.name', 'Needle spires'); }, get short() { return tk('data.skin.city.spires.short', 'Spires'); }, get blurb() { return tk('data.skin.city.spires.blurb', 'Tall thin spires with beacon tips.'); } },
  { id: 'domes', get name() { return tk('data.skin.city.domes.name', 'Arcology domes'); }, get short() { return tk('data.skin.city.domes.short', 'Domes'); }, get blurb() { return tk('data.skin.city.domes.blurb', 'Glass domes with towers inside.'); } },
  { id: 'ziggurat', get name() { return tk('data.skin.city.ziggurat.name', 'Terraced ziggurats'); }, get short() { return tk('data.skin.city.ziggurat.short', 'Ziggurats'); }, get blurb() { return tk('data.skin.city.ziggurat.blurb', 'Stepped pyramids, lit at the summit.'); } },
];

export const STATION_SKINS: SkinDef<StationSkin>[] = [
  { id: 'hub', get name() { return tk('data.skin.station.hub.name', 'Standard hub'); }, get short() { return tk('data.skin.station.hub.short', 'Hub'); }, get blurb() { return tk('data.skin.station.hub.blurb', 'A docking ring between solar wings.'); }, free: true },
  { id: 'wheel', get name() { return tk('data.skin.station.wheel.name', 'Wheel'); }, get short() { return tk('data.skin.station.wheel.short', 'Wheel'); }, get blurb() { return tk('data.skin.station.wheel.blurb', 'A spoked habitat ring, the classic station.'); } },
  { id: 'citadel', get name() { return tk('data.skin.station.citadel.name', 'Citadel'); }, get short() { return tk('data.skin.station.citadel.short', 'Citadel'); }, get blurb() { return tk('data.skin.station.citadel.blurb', 'An armoured octagon with corner bastions.'); } },
  { id: 'spindle', get name() { return tk('data.skin.station.spindle.name', 'Spindle'); }, get short() { return tk('data.skin.station.spindle.short', 'Spindle'); }, get blurb() { return tk('data.skin.station.spindle.blurb', 'A long axial hull with docking rings at each end.'); } },
  { id: 'lattice', get name() { return tk('data.skin.station.lattice.name', 'Lattice'); }, get short() { return tk('data.skin.station.lattice.short', 'Lattice'); }, get blurb() { return tk('data.skin.station.lattice.blurb', 'An open truss frame with suspended spheres.'); } },
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
