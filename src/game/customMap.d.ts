// Types for customMap.js (plain JS so the worker can import it too).

export type MapBodyType = 'terrestrial' | 'gas-giant' | 'ice-giant' | 'dwarf' | 'moon' | 'asteroid' | 'rock';
export type MapSurface = 'verdant' | 'ocean' | 'desert' | 'rocky' | 'barren' | 'ice' | 'lava' | 'toxic' | 'gas' | 'storm';
export type MapSecret =
  | 'ancient_city' | 'pre_terraformed' | 'derelict_warship' | 'resource_cache' | 'ancient_databank'
  | 'ancient_capital' | 'ancient_relay' | 'ancient_station' | 'deep_cache';

export interface MapYields { metal: number; credits: number; science: number }

export interface MapBody {
  id: string;
  name: string;
  type: MapBodyType;
  /** 'sun', or (moons only) the id of the world it orbits. */
  parent: string;
  /** Distance from its parent, map units (catalogue units). */
  orbit: number;
  /** Where on its orbit, radians. */
  angle: number;
  radius: number;
  yields: MapYields;
  color: string;
  surface: MapSurface | null;
  rings?: boolean;
  start?: boolean;
  secret?: MapSecret | 'random' | null;
  mineral?: { kind: 'metal' | 'gold'; tons: number };
  /** A line of flavour, shown to players with the world. */
  lore?: string;
  /** A hand-placed discovery's own name and message (optional). */
  secretName?: string;
  secretText?: string;
}

export interface MapSun { name: string; color: string; size: number; mass: number }

export interface CustomMap {
  v: number;
  name: string;
  sun: MapSun;
  /** The map's pitch: shown in the gallery and the lobby. */
  blurb: string;
  bodies: MapBody[];
  /** Sorted outward, never overlapping. Empty: automatic grouping. */
  sectors: MapSector[];
  settings: { shareHidesSecrets: boolean; backdrop: MapBackdrop };
}

export type MapBackdrop = 'deep' | 'blue' | 'crimson' | 'emerald' | 'violet' | 'amber';

/** A band of orbit round the sun, inner <= orbit < outer (map units). */
export interface MapSector { id: string; name: string; color: string; inner: number; outer: number }

export interface MapIssue {
  level: 'ok' | 'warn' | 'block';
  code: string;
  title: string;
  detail: string;
  bodyIds: string[];
  /** The counts and names the English title/detail were built from, so
   *  the client can rebuild them in the player's language. */
  params?: MapIssueParams;
}

export interface MapIssueParams {
  count?: number; marked?: boolean; seats?: number;
  /** start worlds sharing a planet's orbit, by group */
  groups?: string[][];
  /** the first few pairs of orbits nearly touching; `more` if there are others */
  pairs?: string[][]; more?: boolean;
  names?: string[];
  metal?: number; credits?: number; science?: number;
  /** each sector's name and how many worlds it holds */
  list?: Array<[string, number]>;
  placed?: number; chance?: number; max?: number;
}

export interface TypeInfo {
  label: string;
  radius: [number, number, number];
  mu: number;
  soi: number;
  color: string;
  surface: MapSurface | null;
}

export const MAP_VERSION: number;
export const MAX_BODIES: number;
export const MAX_NAME: number;
export const BODY_TYPES: MapBodyType[];
export const TYPE_INFO: Record<MapBodyType, TypeInfo>;
export const SURFACES: MapSurface[];
export const MAP_SECRETS: MapSecret[];
export const ORBIT_LIMITS: { sun: [number, number]; moon: [number, number] };
export const RESOURCE_MAX: number;
export const SUN_LIMITS: { size: [number, number]; mass: [number, number] };
export const SUN_YEAR_K: number;
export const BACKDROPS: MapBackdrop[];
export const MAX_SECTORS: number;
export const SECTOR_COLORS: string[];
export function sectorOf(map: CustomMap, body: MapBody): MapSector | null;
export function newSectorId(taken: Set<string>, rand?: () => number): string;
export const TEXT_LIMITS: { blurb: number; lore: number; secretName: number; secretText: number };
export const NAME_THEMES: string[];

export function secretFits(kind: string | null | undefined, type: MapBodyType): boolean;
export function canStartOn(type: MapBodyType): boolean;
export function blankMap(name?: string): CustomMap;
export function newBodyId(taken: Set<string>, rand?: () => number): string;
export function normalizeMap(input: unknown): CustomMap;
export function bodyYear(map: CustomMap, body: MapBody): number;
export function bodySoi(map: CustomMap, body: MapBody): number;
export function bodyPos(map: CustomMap, body: MapBody, dAngle?: number): { x: number; y: number };
export function startWorlds(map: CustomMap): { worlds: MapBody[]; marked: boolean };
export function checkMap(map: unknown): MapIssue[];
export function hostBlockers(map: unknown): MapIssue[];
export function mapToCatalog(map: unknown): Array<Record<string, unknown>>;
export function startTemplateIds(map: unknown): Set<string>;
export function makeName(theme: string, taken?: Set<string>, rand?: () => number, index?: number, sunName?: string): string;
export function seededRand(seed: string | number): () => number;
export function generateMap(opts?: {
  seed?: number | string; theme?: string; planets?: number; moonsMin?: number; moonsMax?: number;
  belts?: number; richness?: number; starts?: number; spread?: number; name?: string;
}): CustomMap;
