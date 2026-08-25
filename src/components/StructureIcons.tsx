// ============================================================
// Structure Icons — three silhouette options per megastructure kind.
//
// WHY THESE ARE SVG AND NOT CANVAS. The first cut of the megastructures
// was procedural canvas art: a "hardware kit" of trusses, radiators and
// gradients, forty-odd primitives per sprite, drawn in greys. Next to
// the ships — flat two-tone silhouettes with hard edges — they never
// looked like the same game, and Lorne was right that the older art is
// the cleaner of the two.
//
// So these are drawn through IconFrame, the SAME wrapper every ship
// icon uses. That is the whole trick: matching by imitation would have
// meant re-deriving the keel shade, the dorsal highlight and the stroke
// weight by eye and then keeping them in step forever. Sharing the
// frame means they cannot drift — change the ship treatment and every
// station changes with it.
//
// THE RULES, inherited from the ship icons:
//   - 32x32 viewBox, drawn around the centre (16, 16). Unlike a ship,
//     a station has no "front", so nothing faces right.
//   - The FIRST child is the hull and takes the primary faction colour;
//     every child after it is detail and takes the secondary. Two-tone
//     falls out with no per-icon work.
//   - Strokes, not fills. Hard-lined silhouettes read at 12 pixels and
//     at 120; the old gradients read at neither.
//   - Four to six elements. The discipline IS the style: every sprite
//     that grew past that is one of the ones that looked wrong.
// ============================================================

import React from 'react';
import { IconFrame } from './ShipIcons';
import type { MegastructureKind } from '../game/megastructures';

export type StructureVariant = 'A' | 'B' | 'C' | 'D' | 'E';

/** Every letter the type allows, in picker order. Most kinds use the
 *  first three; the Mega Destroyer earns more because it is the one
 *  hull a player stares at. Ask variantsFor(kind) rather than using
 *  this directly — a picker built on the full list would offer a warp
 *  gate two options that do not exist. */
export const STRUCTURE_VARIANTS: StructureVariant[] = ['A', 'B', 'C', 'D', 'E'];

interface Props {
  size?: number;
  color?: string;
  color2?: string;
  className?: string;
}

// ---------------------------------------------------------------------
// A NOTE ON HOW THESE ARE DRAWN, because the first cut got it wrong.
//
// IconFrame FILLS the first child — that is what gives a ship its solid
// body. I designed the first pass as stroked outlines, so every "ring"
// came out as a solid blob with a circle drawn on top of it: an octagon
// that was not a gate, a collar that was not a well.
//
// So a hole is a real hole: one path, an outer contour and an inner
// contour, fillRule="evenodd". Everything else is a solid silhouette
// with trim detail on top, exactly like a hull.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// WARP GATE — a ring you fly through. The hole is the whole point.
// ---------------------------------------------------------------------

const GateA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Octagonal ring — outer contour, then the aperture punched out */}
    <path
      fillRule="evenodd"
      d="M12 2 L20 2 L30 12 L30 20 L20 30 L12 30 L2 20 L2 12 Z
         M14 9 L18 9 L23 14 L23 18 L18 23 L14 23 L9 18 L9 14 Z"
    />
    {/* Flange blocks on the ring */}
    <path d="M13 1 L19 1 L19 5 L13 5 Z" />
    <path d="M13 27 L19 27 L19 31 L13 31 Z" />
  </IconFrame>
);

const GateB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Hex ring */}
    <path
      fillRule="evenodd"
      d="M16 1 L29 8.5 L29 23.5 L16 31 L3 23.5 L3 8.5 Z
         M16 9 L23 13 L23 19 L16 23 L9 19 L9 13 Z"
    />
    {/* Emitter housings */}
    <path d="M25 5 L31 8 L31 13" />
    <path d="M7 27 L1 24 L1 19" />
  </IconFrame>
);

const GateC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* True torus */}
    <path
      fillRule="evenodd"
      d="M16 2 A 14 14 0 1 0 16 30 A 14 14 0 1 0 16 2 Z
         M16 9 A 7 7 0 1 1 16 23 A 7 7 0 1 1 16 9 Z"
    />
    {/* Three segment joints, so it reads as assembled */}
    <path d="M16 2 L16 9" />
    <path d="M28 23 L22 19.5" />
    <path d="M4 23 L10 19.5" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// WEAPONS STATION — a solid fort with barrels pointing out.
// ---------------------------------------------------------------------

const StationA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Cruciform bastion */}
    <path d="M11 11 L11 4 L21 4 L21 11 L28 11 L28 21 L21 21 L21 28 L11 28 L11 21 L4 21 L4 11 Z" />
    {/* Barrels */}
    <path d="M16 4 L16 1" />
    <path d="M16 28 L16 31" />
    <path d="M4 16 L1 16" />
    <path d="M28 16 L31 16" />
    <circle cx="16" cy="16" r="3.5" />
  </IconFrame>
);

const StationB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Bastion: a solid block with two turret shoulders */}
    <path d="M5 12 L11 12 L11 6 L21 6 L21 12 L27 12 L27 22 L21 22 L21 26 L11 26 L11 22 L5 22 Z" />
    {/* Twin barrels from each shoulder */}
    <path d="M13 6 L13 1 M19 6 L19 1" />
    <path d="M27 15 L31 15 M27 19 L31 19" />
    <circle cx="16" cy="16" r="3" />
  </IconFrame>
);

const StationC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Star fort — six bastion points */}
    <path d="M16 1 L24 6 L31 16 L24 26 L16 31 L8 26 L1 16 L8 6 Z" />
    {/* Casemate barrels */}
    <path d="M8 6 L4 2" />
    <path d="M24 6 L28 2" />
    <path d="M8 26 L4 30" />
    <circle cx="16" cy="16" r="4.5" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// GRAVITY SINK — rings marching inward, holding a hole open.
// ---------------------------------------------------------------------

const SinkA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Heavy collar with the well open through it */}
    <path
      fillRule="evenodd"
      d="M16 2 A 14 14 0 1 0 16 30 A 14 14 0 1 0 16 2 Z
         M16 10 A 6 6 0 1 1 16 22 A 6 6 0 1 1 16 10 Z"
    />
    {/* The next ring in */}
    <circle cx="16" cy="16" r="9.5" />
    <circle cx="16" cy="16" r="3" />
  </IconFrame>
);

const SinkB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Truss ring */}
    <path
      fillRule="evenodd"
      d="M16 3 A 13 13 0 1 0 16 29 A 13 13 0 1 0 16 3 Z
         M16 9 A 7 7 0 1 1 16 23 A 7 7 0 1 1 16 9 Z"
    />
    {/* Generator drums riding it */}
    <circle cx="16" cy="5" r="2.5" />
    <circle cx="16" cy="27" r="2.5" />
    <circle cx="5" cy="16" r="2.5" />
    <circle cx="27" cy="16" r="2.5" />
  </IconFrame>
);

const SinkC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Wide collar, deep well */}
    <path
      fillRule="evenodd"
      d="M16 2 A 14 14 0 1 0 16 30 A 14 14 0 1 0 16 2 Z
         M16 8 A 8 8 0 1 1 16 24 A 8 8 0 1 1 16 8 Z"
    />
    {/* Spokes reaching in toward nothing */}
    <path d="M16 8 L16 13" />
    <path d="M16 19 L16 24" />
    <path d="M8 16 L13 16" />
    <path d="M19 16 L24 16" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// DEEP SPACE ARRAY — a dish. THIS is the radar dish, not the Null Field.
// ---------------------------------------------------------------------

const ArrayA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* One great bowl */}
    <path d="M2 21 A 14 14 0 0 1 30 21 Z" />
    {/* Feed horn on its mast */}
    <path d="M16 21 L16 9" />
    <circle cx="16" cy="7" r="2.5" />
    {/* Mount */}
    <path d="M11 21 L11 30 L21 30 L21 21 Z" />
  </IconFrame>
);

const ArrayB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* A big bowl and two juniors on a spine */}
    <path d="M1 17 A 9 9 0 0 1 19 17 Z" />
    <path d="M17 19 A 5 5 0 0 1 27 19 Z" />
    <path d="M25 21 A 3.5 3.5 0 0 1 31 21 Z" />
    <path d="M10 17 L10 29" />
    <path d="M5 29 L15 29" />
  </IconFrame>
);

const ArrayC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Tilted bowl — a dish farm grows lopsided */}
    <path d="M4 26 A 15 15 0 0 1 26 4 Z" />
    {/* Feed horn on its boom */}
    <path d="M15 15 L25 21" />
    <circle cx="26" cy="22" r="2.5" />
    {/* Counterweight */}
    <path d="M8 8 L3 3" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// NULL FIELD — heavy pylons caging a core darker than space.
// Not a dish. The Array listens; this one shouts.
// ---------------------------------------------------------------------

const NullA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Four pylons, one path */}
    <path d="M12 1 L20 1 L20 10 L12 10 Z
             M12 22 L20 22 L20 31 L12 31 Z
             M1 12 L10 12 L10 20 L1 20 Z
             M22 12 L31 12 L31 20 L22 20 Z" />
    {/* The caged core */}
    <circle cx="16" cy="16" r="7" />
    <circle cx="16" cy="16" r="3" />
  </IconFrame>
);

const NullB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Containment ring with the core showing through */}
    <path
      fillRule="evenodd"
      d="M16 3 A 13 13 0 1 0 16 29 A 13 13 0 1 0 16 3 Z
         M16 8 A 8 8 0 1 1 16 24 A 8 8 0 1 1 16 8 Z"
    />
    {/* Three heavy pylons clamped on */}
    <path d="M13 1 L19 1 L19 7 L13 7 Z" />
    <path d="M26 24 L30 20 L25 15 L21 19 Z" />
    <path d="M6 24 L2 20 L7 15 L11 19 Z" />
    <circle cx="16" cy="16" r="4" />
  </IconFrame>
);

const NullC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Diagonal cage — four corner pylons */}
    <path d="M1 1 L10 1 L10 10 L1 10 Z
             M22 1 L31 1 L31 10 L22 10 Z
             M1 22 L10 22 L10 31 L1 31 Z
             M22 22 L31 22 L31 31 L22 31 Z" />
    {/* Core */}
    <circle cx="16" cy="16" r="8" />
    <circle cx="16" cy="16" r="3.5" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// MEGA DESTROYER — five hulls, and only two of them are moons.
//
// The first cut was three spheres, which was right about the FANTASY
// (this thing kills worlds) and wrong about variety: a picker where
// every option is a circle is not a picker. Lorne's references pull in
// three other silhouettes that all say "world-killer" without saying
// "Death Star" — a ribbed industrial spine, a Rama cylinder, and a
// lance built around one enormous gun.
//
// The two spheres that stayed are the two that read differently from
// each other. The Belted Sphere went because it was the one you could
// not tell from the Battle Station at map scale.
// ---------------------------------------------------------------------

const DestroyerHullA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* The sphere */}
    <circle cx="16" cy="16" r="14" />
    {/* Superlaser dish, off-centre like the one it is adjacent to */}
    <circle cx="11" cy="11" r="4.5" />
    {/* Equatorial trench */}
    <path d="M2 18 L30 18" />
    {/* Focusing eye */}
    <circle cx="11" cy="11" r="1.5" />
  </IconFrame>
);

const DestroyerHullB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* SPINAL LANCE — a ship built around one gun, firing left.
        The hull is a long wedge; everything else is mounting. */}
    <path d="M2 16 L9 12 L26 11 L30 14 L30 18 L26 21 L9 20 Z" />
    {/* The lance, projecting past the bow */}
    <path d="M2 16 L9 16" />
    {/* Accelerator ring amidships */}
    <path d="M17 8 L17 24" />
    <path d="M20 9 L20 23" />
    {/* Drive block */}
    <path d="M27 13 L31 13 M27 19 L31 19" />
  </IconFrame>
);

const DestroyerHullC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Sphere inside an orbital ring */}
    <circle cx="16" cy="16" r="11" />
    <path d="M1 16 A 15 6 0 0 0 31 16 A 15 6 0 0 0 1 16 Z" />
    <circle cx="21" cy="11" r="3" />
  </IconFrame>
);

const DestroyerHullD: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* RIBBED DREADNOUGHT — a spine with buttresses hung off it, the
        silhouette of something assembled in orbit and never landed. */}
    <path d="M3 13 L29 13 L29 19 L3 19 Z" />
    {/* Ribs above and below, longest amidships */}
    <path d="M7 13 L5 5 M12 13 L10 3 M17 13 L15 3 M22 13 L20 5" />
    <path d="M7 19 L5 27 M12 19 L10 29 M17 19 L15 29 M22 19 L20 27" />
    {/* Prow */}
    <path d="M29 13 L32 16 L29 19" />
  </IconFrame>
);

const DestroyerHullE: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* THE GREAT CYLINDER — a hollow drum the size of a moon, seen at
        an angle. Rama, not a warship: no guns on the silhouette at all,
        which is exactly why it is frightening. */}
    <path d="M6 24 L24 6 A 8 8 0 0 1 26 22 L8 30 A 8 8 0 0 1 6 24 Z" />
    {/* The open mouth */}
    <ellipse cx="25" cy="14" rx="4" ry="8" transform="rotate(-45 25 14)" />
    {/* Hull banding */}
    <path d="M9 27 L27 9" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// MOBILE FOUNDRY — a shipyard that moves: an open frame with something
// held inside it.
// ---------------------------------------------------------------------

const FoundryA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Gantry frame, open in the middle where the work sits */}
    <path
      fillRule="evenodd"
      d="M2 6 L30 6 L30 26 L2 26 Z
         M8 12 L24 12 L24 20 L8 20 Z"
    />
    {/* The hull on the ways */}
    <path d="M10 14 L21 14 L24 16 L21 18 L10 18 Z" />
    {/* Cranes */}
    <path d="M8 6 L8 1 M24 6 L24 1" />
  </IconFrame>
);

const FoundryB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Cradle — open at the top */}
    <path d="M1 8 L7 8 L7 22 L25 22 L25 8 L31 8 L31 28 L1 28 Z" />
    {/* Work in the cradle */}
    <path d="M11 12 L21 12 L21 20 L11 20 Z" />
    {/* Cranes */}
    <path d="M4 8 L4 2" />
    <path d="M28 8 L28 2" />
  </IconFrame>
);

const FoundryC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Ring yard */}
    <path
      fillRule="evenodd"
      d="M16 2 A 14 14 0 1 0 16 30 A 14 14 0 1 0 16 2 Z
         M16 8 A 8 8 0 1 1 16 24 A 8 8 0 1 1 16 8 Z"
    />
    {/* Slipway across the middle */}
    <path d="M9 13 L23 13 L23 19 L9 19 Z" />
    <path d="M16 2 L16 8" />
  </IconFrame>
);

// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// CONSTRUCTION SITE — scaffolding, in the same hand as everything else.
//
// A site stays scaffolding: it is the one thing on the map that says
// "not finished yet". Generic rather than per-kind, because the map
// already answers "what is being built here" a better way — the
// finished silhouette is ghosted behind the frame in the last quarter.
// The scaffold's job is to say HOW FAR ALONG, and it does that by
// growing.
// ---------------------------------------------------------------------

/** Build stage 0-3, matching BUILD_STAGES in megastructureArt. */
export const StructureScaffold: React.FC<Props & { stage?: number }> = ({ stage = 0, ...rest }) => {
  const st = Math.max(0, Math.min(3, Math.round(stage)));
  return (
    <IconFrame {...rest}>
      {/* Keel: the base frame, always there. Open in the middle, because
          a slipway that reads as a solid slab is a crate. */}
      <path
        fillRule="evenodd"
        d="M2 24 L30 24 L30 30 L2 30 Z M6 26 L26 26 L26 28 L6 28 Z"
      />
      {/* Frame: uprights, growing to full height at stage 1. */}
      <path d={st >= 1 ? 'M6 24 L6 4 M26 24 L26 4' : 'M6 24 L6 16 M26 24 L26 16'} />
      {/* Plating: the braces that make it a structure. */}
      <path d={st >= 2 ? 'M6 4 L26 4 M6 14 L26 14 M6 4 L26 14 M26 4 L6 14'
        : 'M6 16 L26 16'} />
      {/* Fitting out: something taking shape on the ways. */}
      <path d={st >= 3 ? 'M11 8 L21 8 L21 21 L11 21 Z' : 'M15 21 L17 21'} />
    </IconFrame>
  );
};

/** Partial on purpose: a kind lists only the variants it really has,
 *  and variantsFor reads the keys. The alternative — every kind
 *  carrying five entries with duplicates to pad — is how a picker
 *  ends up offering the same gate three times under different
 *  names. */
type Reg = Partial<Record<StructureVariant, React.FC<Props>>>;

const REGISTRY: Record<MegastructureKind, Reg> = {
  warp_gate:       { A: GateA, B: GateB, C: GateC },
  weapons_station: { A: StationA, B: StationB, C: StationC },
  gravity_sink:    { A: SinkA, B: SinkB, C: SinkC },
  deep_array:      { A: ArrayA, B: ArrayB, C: ArrayC },
  null_field:      { A: NullA, B: NullB, C: NullC },
  mega_destroyer:  { A: DestroyerHullA, B: DestroyerHullB, C: DestroyerHullC,
                     D: DestroyerHullD, E: DestroyerHullE },
  mobile_foundry:  { A: FoundryA, B: FoundryB, C: FoundryC },
};

/** Names shown in the picker at placement. Descriptive rather than
 *  cute: a player choosing between three silhouettes wants to know
 *  which one they are looking at, not a codename. */
/** Names shown in the picker. Partial for the same reason the registry
 *  is: a kind names only the variants it has. */
export const STRUCTURE_VARIANT_NAMES:
  Record<MegastructureKind, Partial<Record<StructureVariant, string>>> = {
  warp_gate:       { A: 'Octagon Ring', B: 'Hex Frame',   C: 'Torus' },
  weapons_station: { A: 'Cruciform',    B: 'Bastion',     C: 'Star Fort' },
  gravity_sink:    { A: 'Collar',       B: 'Drum Ring',   C: 'Deep Well' },
  deep_array:      { A: 'Great Dish',   B: 'Dish Spine',  C: 'Tilted Dish' },
  null_field:      { A: 'Pylon Cage',   B: 'Containment', C: 'Corner Cage' },
  mega_destroyer:  { A: 'Battle Station', B: 'Spinal Lance', C: 'Ringed Fortress',
                     D: 'Ribbed Dreadnought', E: 'Great Cylinder' },
  mobile_foundry:  { A: 'Gantry',       B: 'Cradle',      C: 'Ring Yard' },
};

/** The variant a structure gets when nobody chose one. */
export const DEFAULT_STRUCTURE_VARIANT: StructureVariant = 'A';

/**
 * The variants a given kind actually has, in picker order.
 *
 * Read off the registry rather than kept as a second list, because a
 * hand-maintained list of what art exists is a list that goes stale
 * the first time somebody adds a sprite and forgets.
 */
export function variantsFor(kind: MegastructureKind): StructureVariant[] {
  const reg = REGISTRY[kind] ?? {};
  return STRUCTURE_VARIANTS.filter(v => !!reg[v]);
}

export function isStructureVariant(v: unknown): v is StructureVariant {
  return v === 'A' || v === 'B' || v === 'C';
}

export const StructureIcon: React.FC<Props & {
  kind: MegastructureKind;
  variant?: StructureVariant | null;
}> = ({ kind, variant, ...rest }) => {
  const reg = REGISTRY[kind];
  // An unknown kind or a variant from a newer build must not blank the
  // map — fall back rather than render nothing.
  const Cmp = (reg && reg[(variant ?? DEFAULT_STRUCTURE_VARIANT) as StructureVariant])
    ?? reg?.[DEFAULT_STRUCTURE_VARIANT]
    ?? GateA;
  return <Cmp {...rest} />;
};
