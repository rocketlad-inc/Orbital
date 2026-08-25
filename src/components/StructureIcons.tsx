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

export type StructureVariant = 'A' | 'B' | 'C';

export const STRUCTURE_VARIANTS: StructureVariant[] = ['A', 'B', 'C'];

interface Props {
  size?: number;
  color?: string;
  color2?: string;
  className?: string;
}

// ---------------------------------------------------------------------
// WARP GATE — a ring you fly through. The hole is the whole read, so
// every variant keeps an open centre and nothing crosses it.
// ---------------------------------------------------------------------

const GateA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Octagonal ring */}
    <path d="M12 3 L20 3 L29 12 L29 20 L20 29 L12 29 L3 20 L3 12 Z" />
    {/* Inner aperture */}
    <circle cx="16" cy="16" r="7" />
    {/* Four anchor pylons */}
    <path d="M16 3 L16 9" />
    <path d="M16 23 L16 29" />
    <path d="M3 16 L9 16" />
    <path d="M23 16 L29 16" />
  </IconFrame>
);

const GateB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Hex frame */}
    <path d="M16 2 L28 9 L28 23 L16 30 L4 23 L4 9 Z" />
    <circle cx="16" cy="16" r="6.5" />
    {/* Two heavy emitter blocks, top and bottom */}
    <path d="M12 4 L20 4 L20 8 L12 8 Z" />
    <path d="M12 24 L20 24 L20 28 L12 28 Z" />
  </IconFrame>
);

const GateC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Twin crescents facing each other — an aperture with no frame */}
    <path d="M11 4 A 13 13 0 0 0 11 28" />
    <path d="M21 4 A 13 13 0 0 1 21 28" />
    <circle cx="16" cy="16" r="4.5" />
    <path d="M11 16 L21 16" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// WEAPONS STATION — a gun with a station built round it. Barrels point
// OUT in every variant, so it reads as threat from any angle.
// ---------------------------------------------------------------------

const StationA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Cruciform fort */}
    <path d="M12 12 L12 5 L20 5 L20 12 L27 12 L27 20 L20 20 L20 27 L12 27 L12 20 L5 20 L5 12 Z" />
    {/* Four barrels */}
    <path d="M16 5 L16 1" />
    <path d="M16 27 L16 31" />
    <path d="M5 16 L1 16" />
    <path d="M27 16 L31 16" />
    <circle cx="16" cy="16" r="3" />
  </IconFrame>
);

const StationB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Turret drum */}
    <path d="M7 10 L25 10 L25 22 L7 22 Z" />
    {/* Twin heavy barrels */}
    <path d="M25 13 L32 13" />
    <path d="M25 19 L32 19" />
    {/* Mount */}
    <path d="M11 22 L11 27 L21 27 L21 22" />
    <circle cx="13" cy="16" r="2.5" />
  </IconFrame>
);

const StationC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Star fort — six bastions */}
    <path d="M16 3 L24 8 L24 24 L16 29 L8 24 L8 8 Z" />
    <path d="M8 8 L2 12 L8 16" />
    <path d="M24 8 L30 12 L24 16" />
    <circle cx="16" cy="16" r="4" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// GRAVITY SINK — something that pulls. Concentric and centre-heavy in
// every variant, so it reads as a well rather than a wall.
// ---------------------------------------------------------------------

const SinkA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Outer collar */}
    <circle cx="16" cy="16" r="13" />
    <circle cx="16" cy="16" r="8" />
    <circle cx="16" cy="16" r="3" />
    {/* Four capture arms */}
    <path d="M16 3 L16 8" />
    <path d="M16 24 L16 29" />
  </IconFrame>
);

const SinkB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Pincer claws */}
    <path d="M6 5 L6 27" />
    <path d="M26 5 L26 27" />
    <path d="M6 5 A 12 12 0 0 1 26 5" />
    <path d="M6 27 A 12 12 0 0 0 26 27" />
    <circle cx="16" cy="16" r="3.5" />
  </IconFrame>
);

const SinkC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Spoked disc */}
    <circle cx="16" cy="16" r="12" />
    <path d="M16 4 L16 28" />
    <path d="M4 16 L28 16" />
    <path d="M8 8 L24 24" />
    <path d="M24 8 L8 24" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// DEEP SPACE ARRAY — dishes. The one structure whose silhouette should
// read as LISTENING, so every variant is an open bowl.
// ---------------------------------------------------------------------

const ArrayA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* One big dish */}
    <path d="M4 20 A 14 14 0 0 1 28 20 Z" />
    {/* Feed horn on its mast */}
    <path d="M16 20 L16 8" />
    <circle cx="16" cy="7" r="2" />
    {/* Base */}
    <path d="M11 20 L11 27 L21 27 L21 20" />
  </IconFrame>
);

const ArrayB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Spine */}
    <path d="M4 16 L28 16" />
    {/* Three dishes along it */}
    <path d="M6 16 A 5 5 0 0 1 16 16 Z" />
    <path d="M14 16 A 4 4 0 0 1 22 16 Z" />
    <path d="M21 16 A 3.5 3.5 0 0 1 28 16 Z" />
    <path d="M16 16 L16 26" />
  </IconFrame>
);

const ArrayC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Fan of receivers on a mast */}
    <path d="M16 30 L16 12" />
    <path d="M16 12 L4 4" />
    <path d="M16 12 L28 4" />
    <path d="M16 12 L16 2" />
    <path d="M9 26 L23 26" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// NULL FIELD — a hole in the map. Broken, asymmetric outlines: it is
// the one structure that should look WRONG next to the others.
// ---------------------------------------------------------------------

const NullA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Hex with a bite out of it */}
    <path d="M16 3 L28 10 L28 22 L16 29 L4 22 L4 10 Z" />
    {/* Jagged inner void */}
    <path d="M11 13 L16 10 L21 13 L19 20 L13 20 Z" />
    <path d="M4 10 L11 13" />
    <path d="M28 22 L19 20" />
  </IconFrame>
);

const NullB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Spiked ring */}
    <circle cx="16" cy="16" r="10" />
    <path d="M16 6 L16 1" />
    <path d="M23 9 L27 5" />
    <path d="M26 16 L31 16" />
    <path d="M9 23 L5 27" />
    <circle cx="16" cy="16" r="3" />
  </IconFrame>
);

const NullC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Two offset crescents — nothing lines up */}
    <path d="M9 5 A 12 12 0 0 0 9 27" />
    <path d="M23 8 A 10 10 0 0 1 23 26" />
    <path d="M13 16 L19 16" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// MEGA DESTROYER — a ship, so this one DOES face right, like every
// other hull in the game. The spine is the read: the whole vessel is a
// mount for one gun.
// ---------------------------------------------------------------------

const DestroyerHullA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Long spinal hull */}
    <path d="M3 12 L22 12 L28 16 L22 20 L3 20 Z" />
    {/* The gun, protruding past the bow */}
    <path d="M28 16 L32 16" />
    {/* Reactor drums */}
    <circle cx="10" cy="16" r="2.5" />
    <circle cx="16" cy="16" r="2" />
    {/* Radiators */}
    <path d="M5 12 L5 6" />
    <path d="M5 20 L5 26" />
  </IconFrame>
);

const DestroyerHullB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Broad dreadnought */}
    <path d="M2 9 L20 9 L30 16 L20 23 L2 23 Z" />
    <path d="M30 16 L32 16" />
    <path d="M8 9 L8 23" />
    <circle cx="14" cy="16" r="3" />
  </IconFrame>
);

const DestroyerHullC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Hammerhead: the gun sits in a widened prow */}
    <path d="M3 13 L20 13 L20 7 L27 7 L27 25 L20 25 L20 19 L3 19 Z" />
    <path d="M27 16 L32 16" />
    <circle cx="11" cy="16" r="2.5" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// MOBILE FOUNDRY — a shipyard that moves. Open frames with something
// held INSIDE them: the silhouette should say "things are built here".
// ---------------------------------------------------------------------

const FoundryA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Gantry frame */}
    <path d="M3 8 L29 8 L29 24 L3 24 Z" />
    {/* The hull on the ways */}
    <path d="M9 14 L21 14 L24 16 L21 18 L9 18 Z" />
    {/* Cranes */}
    <path d="M9 8 L9 4" />
    <path d="M23 8 L23 4" />
  </IconFrame>
);

const FoundryB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Cradle — open at the top, work hanging below */}
    <path d="M3 10 L3 22 L29 22 L29 10" />
    <path d="M8 22 L8 28" />
    <path d="M24 22 L24 28" />
    <path d="M11 13 L21 13 L21 19 L11 19 Z" />
  </IconFrame>
);

const FoundryC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Ring yard */}
    <circle cx="16" cy="16" r="12" />
    <path d="M16 4 L16 28" />
    <path d="M10 12 L22 12 L22 20 L10 20 Z" />
  </IconFrame>
);

// ---------------------------------------------------------------------

type Reg = Record<StructureVariant, React.FC<Props>>;

const REGISTRY: Record<MegastructureKind, Reg> = {
  warp_gate:       { A: GateA, B: GateB, C: GateC },
  weapons_station: { A: StationA, B: StationB, C: StationC },
  gravity_sink:    { A: SinkA, B: SinkB, C: SinkC },
  deep_array:      { A: ArrayA, B: ArrayB, C: ArrayC },
  null_field:      { A: NullA, B: NullB, C: NullC },
  mega_destroyer:  { A: DestroyerHullA, B: DestroyerHullB, C: DestroyerHullC },
  mobile_foundry:  { A: FoundryA, B: FoundryB, C: FoundryC },
};

/** Names shown in the picker at placement. Descriptive rather than
 *  cute: a player choosing between three silhouettes wants to know
 *  which one they are looking at, not a codename. */
export const STRUCTURE_VARIANT_NAMES: Record<MegastructureKind, Record<StructureVariant, string>> = {
  warp_gate:       { A: 'Octagon Ring', B: 'Hex Frame',   C: 'Twin Crescent' },
  weapons_station: { A: 'Cruciform',    B: 'Turret Drum', C: 'Star Fort' },
  gravity_sink:    { A: 'Collar',       B: 'Pincer',      C: 'Spoked Disc' },
  deep_array:      { A: 'Great Dish',   B: 'Dish Spine',  C: 'Fan Mast' },
  null_field:      { A: 'Broken Hex',   B: 'Spiked Ring', C: 'Offset Arcs' },
  mega_destroyer:  { A: 'Spinal',       B: 'Dreadnought', C: 'Hammerhead' },
  mobile_foundry:  { A: 'Gantry',       B: 'Cradle',      C: 'Ring Yard' },
};

/** The variant a structure gets when nobody chose one. */
export const DEFAULT_STRUCTURE_VARIANT: StructureVariant = 'A';

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
