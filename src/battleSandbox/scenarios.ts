// ============================================================
// Battle test-page scenarios: who is fighting over the world.
//
// Two kinds of force, because the game has both (Lorne: "fleets as in
// the in game context, as well as fleets meaning a shit ton of ships
// individually at the planet"):
//
//   FLEET   an in-game fleet: the flagship drawn full size with every
//           other hull riding behind it as a small glyph of its own
//           class, in the escort block the map draws (fleetGrouping
//           escortOffsets / escortSpacingFor / escortGlyphFor). Laid out
//           as ONE body covering the block.
//   SWARM   many separate hulls at the world, each a full-size sprite,
//           clumping with the others that came with it.
//
// Hull classes and the designs they fly follow what live games actually
// field (CLASS_MIX / DESIGNS below), so the mix of shapes and sizes is
// the one players see.
//
// Rosters are seeded, so "Large" is the same fight every time unless the
// page rerolls. Sizes are the game's own drawn sprite sizes (mapRenderer
// shipIconSize: SHIP_ICON_REST_SIZE x SHIP_ICON_SCALE x REGULAR_SHIP_BOOST,
// capital hulls without the boost), times the zoom's hull scale
// (bodyPresentation.hullSize), so the layout is solved against the
// pixels the map would draw.
// ============================================================

import { CLEAR_FRAC, type OBShip } from '../render/orbitBattleLayout';
import type { ShipIconVariant } from '../components/ShipIcons';
import { escortStandoffFor, escortOffsets, escortGlyphFor } from '../render/fleetGrouping';
import { escortBlockSpacing } from '../render/battleLayoutLive';

export type ShipClass = 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'mega_destroyer';

/** Full-size drawn px per class (mapRenderer shipIconSize, unselected),
 *  guarded against drift by a test. */
export const CLASS_PX: Record<ShipClass, number> = {
  corvette: 10 * 3,
  frigate: 16 * 3,
  destroyer: 28 * 3,
  freighter: 15 * 3,
  mega_destroyer: 58 * 2,
};

/** Drawn px per class, plus the world's station. */
export type SizeTable = Record<ShipClass | 'station', number>;

export type SizeLadderId = 'before' | 'live' | 'extreme';

/**
 * SIZE CONTRAST (Lorne: "more dramatic size differences between
 * Corvettes, Frigates, Destroyers and stations"). He picked Bold on this
 * page and it is now LIVE on the map (shipIconSize per class, the
 * station's 88-unit art at STATION_STRUCTURE_SCALE 200/88). BEFORE is
 * the map as it was; EXTREME pulls the ladder further apart.
 */
export const SIZE_LADDERS: Record<SizeLadderId, { label: string; px: SizeTable }> = {
  before: {
    label: 'Before',
    px: { corvette: 42, frigate: 51, freighter: 48, destroyer: 66, mega_destroyer: 76, station: 88 * 1.6 },
  },
  live: {
    label: 'Live (Bold)',
    px: { ...CLASS_PX, station: 200 },
  },
  extreme: {
    label: 'Extreme',
    px: { corvette: 24, frigate: 46, freighter: 42, destroyer: 104, mega_destroyer: 150, station: 260 },
  },
};

export interface SandboxFaction {
  id: string;
  name: string;
  color: string;
  color2: string;
  /** Kinetic rounds or energy beams, for the look of its fire. */
  weapon: 'kinetic' | 'energy';
}

export const FACTIONS: SandboxFaction[] = [
  { id: 'a', name: 'Solar Directorate', color: '#ff8a3d', color2: '#ffd36b', weapon: 'kinetic' },
  { id: 'b', name: 'Vexan Concord', color: '#8b6cff', color2: '#5fd8ff', weapon: 'energy' },
  { id: 'c', name: 'Tal Free Worlds', color: '#3fd0a5', color2: '#e9f871', weapon: 'kinetic' },
];

/** A fleet marker's drawn pieces, in the fleet's own frame: forward is
 *  +x, the origin is the CENTRE of the body the layout places. */
export interface FleetGeometry {
  flagSize: number;
  /** Flagship centre (on the x axis, ahead of the body centre). */
  flagX: number;
  escorts: Array<{
    id: string; cls: ShipClass; variant?: ShipIconVariant; x: number; y: number; size: number;
  }>;
  /** Radius of the circle that covers the flagship and every escort. */
  clearR: number;
}

export interface SandboxShip extends OBShip {
  cls: ShipClass;
  /** The hull design the player picked (designer letter); undefined =
   *  the class default, as for a ship with no icon_variant. */
  variant?: ShipIconVariant;
  name: string;
  /** Present on an in-game fleet marker: the hulls riding behind. */
  escortClasses?: Hull[];
  geo?: FleetGeometry;
}

export type ScenarioId = 'small' | 'medium' | 'large' | 'swarm' | 'fleets' | 'three';

export const SCENARIOS: Record<ScenarioId, { label: string; blurb: string }> = {
  small:  { label: 'Small',       blurb: 'A fleet of 4 against 3 lone hulls' },
  medium: { label: 'Medium',      blurb: 'A fleet and a swarm a side: 23 vs 21' },
  large:  { label: 'Large',       blurb: 'Fleets, capitals and swarms: 80 vs 66' },
  swarm:  { label: 'Swarm',       blurb: '110 vs 95 hulls, every one on its own' },
  fleets: { label: 'Fleets only', blurb: 'In-game fleets, flagship + escorts: 72 vs 57' },
  three:  { label: 'Three-way',   blurb: 'Fleets and swarms: 31 vs 27 vs 18' },
};

/** One hull of a roster: its class and the design it flies. */
export interface Hull { cls: ShipClass; variant?: ShipIconVariant }

// WHAT LIVE GAMES ACTUALLY FLY (prod D1, active games, 2026-10-06), so a
// battle here looks like a battle there. Hulls by class: about half are
// corvettes and destroyers are rare; most hulls fly a design the player
// picked rather than the class default ('-').
const CLASS_MIX: Array<[ShipClass, number]> = [
  ['corvette', 709], ['frigate', 290], ['freighter', 220], ['destroyer', 77],
];
type Regular = 'corvette' | 'frigate' | 'destroyer' | 'freighter';
const DESIGNS: Record<Regular, Array<[string, number]>> = {
  corvette: [['-', 246], ['H', 135], ['X', 64], ['G', 52], ['Y', 49], ['T', 39], ['C', 30], ['D', 21],
    ['A', 16], ['I', 15], ['F', 13], ['S', 8], ['E', 8], ['U', 7], ['B', 6]],
  frigate: [['U', 52], ['C', 35], ['A', 24], ['G', 23], ['-', 23], ['D', 20], ['J', 19], ['I', 16],
    ['H', 16], ['E', 14], ['F', 11], ['B', 11], ['P', 6]],
  destroyer: [['D', 16], ['E', 10], ['H', 9], ['I', 8], ['C', 8], ['G', 7], ['F', 7], ['-', 6],
    ['B', 3], ['A', 3]],
  freighter: [['-', 163], ['B', 21], ['D', 16], ['A', 11], ['I', 3], ['C', 3], ['U', 2], ['E', 1]],
};
function weighted<T>(rows: Array<[T, number]>, x: number): T {
  let t = x * rows.reduce((n, r) => n + r[1], 0);
  for (const [k, w] of rows) { t -= w; if (t <= 0) return k; }
  return rows[rows.length - 1][0];
}
const design = (cls: Regular, x: number): ShipIconVariant | undefined => {
  const d = weighted(DESIGNS[cls], x);
  return d === '-' ? undefined : d as ShipIconVariant;
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The map's escort block, measured. Same calls, same constants as
 * MapCanvas's fleet-marker draw: spacing from the flagship's DRAWN
 * radius, the block astern of it, each escort a glyph of its own class
 * at its size relative to a destroyer (capped at 1).
 */
export function fleetGeometry(
  id: string, flag: ShipClass, escorts: Array<Hull | ShipClass>, hullScale: number,
  px: Record<ShipClass, number> = CLASS_PX,
): FleetGeometry {
  const flagSize = px[flag] * hullScale;
  // hb.r in MapCanvas is the flagship's HITBOX radius: half the sprite
  // plus 3, never under SHIP_MIN_HIT_RADIUS (12).
  const hr = Math.max(flagSize / 2 + 3, 12);
  const spacing = escortBlockSpacing(escorts.length, hr);
  const offs = escortOffsets(escorts.length, spacing, 0, escortStandoffFor(hr, spacing));
  const glyph = escortGlyphFor(spacing);
  const pts = [{ x: 0, y: 0, r: (flagSize / 2) * (CLEAR_FRAC * 2) }];
  const raw = escorts.map((h, i) => {
    const { cls, variant } = typeof h === 'string' ? { cls: h, variant: undefined } : h;
    const size = Math.max(3, glyph * Math.min(1, px[cls] / px.destroyer));
    pts.push({ x: offs[i].dx, y: offs[i].dy, r: (size / 2) * (CLEAR_FRAC * 2) });
    return { id: `${id}.e${i}`, cls, variant, x: offs[i].dx, y: offs[i].dy, size };
  });
  // Centre the body on the block's bounding box.
  const minX = Math.min(...pts.map(p => p.x - p.r)), maxX = Math.max(...pts.map(p => p.x + p.r));
  const minY = Math.min(...pts.map(p => p.y - p.r)), maxY = Math.max(...pts.map(p => p.y + p.r));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const clearR = Math.max(...pts.map(p => Math.hypot(p.x - cx, p.y - cy) + p.r));
  return {
    flagSize,
    flagX: -cx,
    escorts: raw.map(e => ({ ...e, x: e.x - cx, y: e.y - cy })),
    clearR,
  };
}

interface SideSpec {
  /** One entry per in-game fleet: how many hulls ride behind its flagship. */
  fleets?: number[];
  /** Separate hulls at the world. */
  swarm?: number;
  /** How many clumps the swarm arrived in (about one in six is a straggler). */
  groups?: number;
  /** How many of the fleets are led by a capital hull. */
  capitals?: number;
}

function side(
  faction: string, spec: SideSpec, R: () => number, hullScale: number, px: Record<ShipClass, number>,
): SandboxShip[] {
  const out: SandboxShip[] = [];
  const pick = (): Hull => {
    const cls = weighted(CLASS_MIX, R()) as Regular;
    return { cls, variant: design(cls, R()) };
  };
  (spec.fleets ?? []).forEach((n, k) => {
    const id = `${faction}-F${k}`;
    const capital = k < (spec.capitals ?? 0);
    const flag: ShipClass = capital ? 'mega_destroyer' : 'destroyer';
    const variant = capital ? undefined : design('destroyer', R());
    const escortClasses = Array.from({ length: n }, pick);
    const geo = fleetGeometry(id, flag, escortClasses, hullScale, px);
    out.push({
      id, name: `${faction.toUpperCase()} Fleet ${k + 1}`, faction,
      // Its own layout group: a fleet marker is one body.
      fleet: id,
      cls: flag, variant, size: geo.flagSize, clearR: geo.clearR, armed: true,
      escortClasses, geo,
    });
  });
  const groups = spec.groups ?? 1;
  for (let i = 0; i < (spec.swarm ?? 0); i++) {
    const { cls, variant } = pick();
    const fleet = R() > 0.16 ? `${faction}-s${Math.floor(R() * groups)}` : null;
    out.push({
      id: `${faction}-${i}`, name: `${faction.toUpperCase()}-${i}`, faction, fleet, cls, variant,
      size: px[cls] * hullScale, armed: cls !== 'freighter',
    });
  }
  return out;
}

/** The roster, sized for a zoom: `hullScale` is the map's parked-hull
 *  multiplier at that zoom (1 close in, 0.5 far out), `px` the drawn size
 *  of each class at full size (the live map's by default). */
export function buildScenario(
  id: ScenarioId, seed = 1, hullScale = 1, px: Record<ShipClass, number> = CLASS_PX,
): SandboxShip[] {
  const R = rng(seed * 104729 + id.length);
  const S = (f: string, spec: SideSpec) => side(f, spec, R, hullScale, px);
  switch (id) {
    case 'small':  return [...S('a', { fleets: [3] }), ...S('b', { swarm: 3 })];
    case 'medium': return [
      ...S('a', { fleets: [10], swarm: 12, groups: 2 }),
      ...S('b', { fleets: [8], swarm: 12, groups: 2 }),
    ];
    case 'large':  return [
      ...S('a', { fleets: [22, 14, 7], capitals: 1, swarm: 34, groups: 3 }),
      ...S('b', { fleets: [18, 11], capitals: 1, swarm: 35, groups: 3 }),
    ];
    case 'swarm':  return [...S('a', { swarm: 110, groups: 5 }), ...S('b', { swarm: 95, groups: 4 })];
    case 'fleets': return [
      ...S('a', { fleets: [28, 20, 12, 8], capitals: 1 }),
      ...S('b', { fleets: [25, 17, 11], capitals: 1 }),
    ];
    case 'three':  return [
      ...S('a', { fleets: [10], swarm: 20, groups: 2 }),
      ...S('b', { fleets: [8], swarm: 18, groups: 2 }),
      ...S('c', { swarm: 18, groups: 2 }),
    ];
    default:       return [];
  }
}

/** Hulls in a roster, counting every escort. */
export function hullCount(ships: readonly SandboxShip[]): number {
  return ships.reduce((n, s) => n + 1 + (s.escortClasses?.length ?? 0), 0);
}
