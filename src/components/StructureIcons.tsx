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
// WARP GATE — a big ring you fly through.
//
// Every variant is a RING with an open aperture, because that is what
// the original art was and what the name promises. The first pass had a
// twin-crescent version that read as a pair of brackets; a gate that
// does not read as a ring is not a gate, however handsome the shape.
// ---------------------------------------------------------------------

const GateA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Octagonal ring */}
    <path d="M12 3 L20 3 L29 12 L29 20 L20 29 L12 29 L3 20 L3 12 Z" />
    {/* The aperture */}
    <circle cx="16" cy="16" r="7" />
    {/* Flanges on the ring */}
    <path d="M16 3 L16 9" />
    <path d="M16 23 L16 29" />
    <path d="M3 16 L9 16" />
    <path d="M23 16 L29 16" />
  </IconFrame>
);

const GateB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Hex ring */}
    <path d="M16 2 L28 9 L28 23 L16 30 L4 23 L4 9 Z" />
    <circle cx="16" cy="16" r="6.5" />
    {/* Emitter housings, top and bottom */}
    <path d="M12 4 L20 4 L20 8 L12 8 Z" />
    <path d="M12 24 L20 24 L20 28 L12 28 Z" />
  </IconFrame>
);

const GateC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Segmented torus — the heaviest ring of the three */}
    <circle cx="16" cy="16" r="13" />
    <circle cx="16" cy="16" r="7" />
    {/* Three segment flanges, so it reads as assembled rather than cast */}
    <path d="M16 3 L16 9" />
    <path d="M27 22 L21 19" />
    <path d="M5 22 L11 19" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// WEAPONS STATION — a hull with turret sponsons and twin barrels.
//
// The original is a fort: stacked core boxes, sponsons on opposite
// corners, twin barrels each. Barrels point OUT in every variant so it
// reads as threat from any angle, and none of them is a bare drum —
// that read as a tank rather than an emplacement.
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
    {/* Slab hull */}
    <path d="M6 11 L26 11 L26 21 L6 21 Z" />
    {/* Sponsons on opposite corners */}
    <path d="M6 6 L13 6 L13 11" />
    <path d="M26 26 L19 26 L19 21" />
    {/* Twin barrels from each */}
    <path d="M9 6 L9 1" />
    <path d="M23 26 L23 31" />
  </IconFrame>
);

const StationC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Star fort — bastions on every face */}
    <path d="M16 3 L24 8 L24 24 L16 29 L8 24 L8 8 Z" />
    {/* Bastion barrels */}
    <path d="M8 8 L2 12" />
    <path d="M24 8 L30 12" />
    <path d="M8 24 L2 20" />
    <circle cx="16" cy="16" r="4" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// GRAVITY SINK — rings marching inward, holding a hole open.
//
// The original's note is the brief: "spokes reaching in toward nothing —
// the machinery holds a hole open". So every variant is concentric and
// centre-heavy. The first pass had a pincer version, which read as a
// grabber rather than a well: the sink does not close on you, it sits
// there and you fall in.
// ---------------------------------------------------------------------

const SinkA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Rings marching in */}
    <circle cx="16" cy="16" r="13" />
    <circle cx="16" cy="16" r="8" />
    <circle cx="16" cy="16" r="3" />
    <path d="M16 3 L16 8" />
    <path d="M16 24 L16 29" />
  </IconFrame>
);

const SinkB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Truss ring with generator drums on it */}
    <circle cx="16" cy="16" r="12" />
    <circle cx="16" cy="4" r="2.5" />
    <circle cx="16" cy="28" r="2.5" />
    <circle cx="4" cy="16" r="2.5" />
    <circle cx="28" cy="16" r="2.5" />
    <circle cx="16" cy="16" r="4" />
  </IconFrame>
);

const SinkC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Spokes reaching in toward nothing */}
    <circle cx="16" cy="16" r="12" />
    <path d="M16 4 L16 12" />
    <path d="M16 20 L16 28" />
    <path d="M4 16 L12 16" />
    <path d="M20 16 L28 16" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// DEEP SPACE ARRAY — dishes. THIS is the radar dish.
//
// Worth stating because it is easy to mix up with the Null Field: the
// Array listens and looks like it, the Null Field is an emitter caging a
// dark core. Every variant here is an open bowl on a mount, and the
// original is deliberately lopsided — a dish farm grows one antenna at a
// time — so none of them is symmetric.
// ---------------------------------------------------------------------

const ArrayA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* One great dish */}
    <path d="M3 20 A 14 14 0 0 1 29 20 Z" />
    {/* Feed horn on its mast */}
    <path d="M16 20 L16 8" />
    <circle cx="16" cy="7" r="2" />
    {/* Mount */}
    <path d="M11 20 L11 28 L21 28 L21 20" />
  </IconFrame>
);

const ArrayB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Truss spine with a big dish and two juniors */}
    <path d="M2 18 L30 18" />
    <path d="M3 18 A 7 7 0 0 1 17 18 Z" />
    <path d="M17 18 A 4 4 0 0 1 25 18 Z" />
    <path d="M25 18 A 3 3 0 0 1 31 18 Z" />
    <path d="M10 18 L10 27" />
  </IconFrame>
);

const ArrayC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Tilted main dish with a counterweight — lopsided on purpose */}
    <path d="M5 25 A 15 15 0 0 1 26 6 Z" />
    {/* Feed horn on its boom */}
    <path d="M14 16 L24 22" />
    <circle cx="25" cy="23" r="2" />
    {/* Counterweight arm */}
    <path d="M9 9 L4 5" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// NULL FIELD — heavy pylons caging a core darker than space.
//
// NOT a dish: that is the Deep Space Array. This is an emitter, and the
// original's whole idea is a cage around something you cannot see into,
// with a hard rim so the most alarming object on the board is not also
// the hardest to spot. The first pass had a broken hexagon and a spiked
// ring, which read as damaged rather than as deliberate.
// ---------------------------------------------------------------------

const NullA: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Four heavy pylons */}
    <path d="M13 2 L19 2 L19 11 L13 11 Z M13 21 L19 21 L19 30 L13 30 Z" />
    {/* The caged core */}
    <circle cx="16" cy="16" r="6.5" />
    {/* Side pylons */}
    <path d="M2 13 L11 13 L11 19 L2 19 Z" />
    <path d="M21 13 L30 13 L30 19 L21 19 Z" />
  </IconFrame>
);

const NullB: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Three pylons on a containment ring */}
    <circle cx="16" cy="16" r="11" />
    <path d="M13 1 L19 1 L19 8 L13 8 Z" />
    <path d="M25 24 L29 20 L24 15 L20 19 Z" />
    <path d="M7 24 L3 20 L8 15 L12 19 Z" />
    {/* The dark core */}
    <circle cx="16" cy="16" r="4.5" />
  </IconFrame>
);

const NullC: React.FC<Props> = (p) => (
  <IconFrame {...p}>
    {/* Diagonal cage — four pylons at the corners */}
    <path d="M4 4 L12 12 M28 4 L20 12 M4 28 L12 20 M28 28 L20 20" />
    <circle cx="16" cy="16" r="7" />
    <circle cx="16" cy="16" r="3" />
    <path d="M16 5 L16 9" />
  </IconFrame>
);

// ---------------------------------------------------------------------
// CONSTRUCTION SITE — scaffolding, in the same hand as everything else.
//
// A site stays scaffolding: that read was right the first time and is
// the one thing on the map that says "not finished yet". What changes
// is the treatment — it was the last object still drawn in gradients
// and greys, so a half-built gate and a finished one looked like they
// came from two different games.
//
// GENERIC RATHER THAN PER-KIND, on purpose. Twenty-eight scaffolds
// (seven kinds by four stages) would be a lot of art saying the same
// thing, and the map already answers "what is being built here" a
// better way: the finished silhouette is ghosted behind the frame in
// the last quarter. The scaffold's job is to say HOW FAR ALONG, and it
// does that by growing.
// ---------------------------------------------------------------------

/** Build stage 0-3, matching BUILD_STAGES in megastructureArt. */
export const StructureScaffold: React.FC<Props & { stage?: number }> = ({ stage = 0, ...rest }) => {
  const st = Math.max(0, Math.min(3, Math.round(stage)));
  return (
    <IconFrame {...rest}>
      {/* Keel: the base frame, always present. */}
      <path d="M4 26 L28 26 L28 29 L4 29 Z" />
      {/* Frame: uprights. */}
      {st >= 1 ? <path d="M7 26 L7 8 M25 26 L25 8" /> : <path d="M7 26 L7 20 M25 26 L25 20" />}
      {/* Plating: the cross braces that make it a structure. */}
      {st >= 2 ? <path d="M7 8 L25 8 M7 17 L25 17 M7 8 L25 17 M25 8 L7 17" />
        : <path d="M7 20 L25 20" />}
      {/* Fitting out: something taking shape inside the ways. */}
      {st >= 3 ? <path d="M12 11 L20 11 L20 22 L12 22 Z" /> : <path d="M15 22 L17 22" />}
    </IconFrame>
  );
};

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
