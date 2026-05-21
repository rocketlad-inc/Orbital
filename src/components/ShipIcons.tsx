// ============================================================
// Ship Icons — three SVG silhouette options per ship class.
// All icons face right (prograde) on a 32×32 viewBox.
// They use currentColor so they inherit text color from CSS.
// ============================================================

import React from 'react';

// A/B/C — the original three; D/E/F — new candidates added for player
// selection (gallery at ?icons). The picker dropdown at ship construction
// lets the player override the default per-build.
export type ShipIconVariant = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type ShipIconClass = 'corvette' | 'frigate' | 'destroyer' | 'freighter';

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
}

const SVG = ({ size = 24, color, className, children }: IconProps & { children: React.ReactNode }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    stroke={color ?? 'currentColor'}
    strokeWidth={1.5}
    strokeLinejoin="round"
    strokeLinecap="round"
    className={className}
    aria-hidden
  >
    {children}
  </svg>
);

// ===== CORVETTE — fast, light attack craft =====

/** Corvette A: sharp dart with twin engine flares */
export const CorvetteA: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Hull: long pointed wedge */}
    <path d="M4 13 L20 13 L28 16 L20 19 L4 19 Z" />
    {/* Cockpit canopy */}
    <path d="M14 13 L18 14.5 L18 17.5 L14 19" />
    {/* Twin engine flares trailing behind */}
    <path d="M4 14 L1 14" />
    <path d="M4 18 L1 18" />
  </SVG>
);

/** Corvette B: arrowhead with stub wings */
export const CorvetteB: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Sleek delta fuselage */}
    <path d="M6 16 L26 12 L30 16 L26 20 L6 16 Z" />
    {/* Stub wings flaring up/down */}
    <path d="M14 13 L10 8 L16 12" />
    <path d="M14 19 L10 24 L16 20" />
    {/* Cockpit dot */}
    <circle cx="22" cy="16" r="1.2" fill="currentColor" stroke="none" />
  </SVG>
);

/** Corvette C: angular gunship with prominent rail */
export const CorvetteC: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Cigar fuselage */}
    <path d="M6 14 L24 14 L28 16 L24 18 L6 18 Z" />
    {/* Top-mounted rail gun */}
    <path d="M14 14 L14 10 L24 10 L24 14" />
    <path d="M24 10 L30 10" />
    {/* Aft engine bell */}
    <path d="M4 13 L6 14 L6 18 L4 19" />
  </SVG>
);

// ===== FRIGATE — balanced warship =====

/** Frigate A: cruciform with command tower */
export const FrigateA: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Main hull */}
    <path d="M4 14 L22 12 L28 16 L22 20 L4 18 Z" />
    {/* Cross wings (vertical) */}
    <path d="M14 6 L18 12 L14 12 Z" />
    <path d="M14 26 L18 20 L14 20 Z" />
    {/* Bridge dome */}
    <circle cx="20" cy="16" r="2" />
  </SVG>
);

/** Frigate B: diamond hull with side sponsons */
export const FrigateB: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Diamond fuselage */}
    <path d="M6 16 L18 10 L28 16 L18 22 Z" />
    {/* Side weapon sponsons */}
    <path d="M14 11 L14 7 L18 9" />
    <path d="M14 21 L14 25 L18 23" />
    {/* Forward gun barrel */}
    <path d="M28 16 L31 16" />
    {/* Engine glow */}
    <path d="M6 14 L3 15 L3 17 L6 18" />
  </SVG>
);

/** Frigate C: classic tube with three weapon mounts */
export const FrigateC: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Long fuselage */}
    <rect x="5" y="13" width="22" height="6" rx="1" />
    {/* Three turret mounts on top */}
    <circle cx="11" cy="12" r="1.5" />
    <circle cx="16" cy="12" r="1.5" />
    <circle cx="21" cy="12" r="1.5" />
    {/* Pointed nose */}
    <path d="M27 13 L31 16 L27 19" />
    {/* Aft engines */}
    <path d="M5 14 L2 14" />
    <path d="M5 18 L2 18" />
  </SVG>
);

// ===== DESTROYER — heavy hitter =====

/** Destroyer A: hexagonal armored hulk */
export const DestroyerA: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Hexagon hull */}
    <path d="M8 10 L24 10 L30 16 L24 22 L8 22 L2 16 Z" />
    {/* Main forward cannon */}
    <path d="M24 14 L31 14 L31 18 L24 18" />
    {/* Top/bottom secondary turrets */}
    <circle cx="14" cy="13" r="1.5" />
    <circle cx="14" cy="19" r="1.5" />
    <circle cx="20" cy="13" r="1.5" />
    <circle cx="20" cy="19" r="1.5" />
  </SVG>
);

/** Destroyer B: wide battle wedge with layered prow */
export const DestroyerB: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Main wedge */}
    <path d="M4 10 L20 10 L30 16 L20 22 L4 22 Z" />
    {/* Inner layer / armor plating */}
    <path d="M8 13 L20 13 L26 16 L20 19 L8 19" />
    {/* Triple engine block at the back */}
    <path d="M4 11 L2 11 L2 13 L4 13" />
    <path d="M4 15 L2 15 L2 17 L4 17" />
    <path d="M4 19 L2 19 L2 21 L4 21" />
  </SVG>
);

/** Destroyer C: capital ship with bridge tower */
export const DestroyerC: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Long fuselage */}
    <path d="M4 14 L26 14 L30 16 L26 18 L4 18 Z" />
    {/* Bridge / command tower stacked above */}
    <path d="M14 14 L14 8 L20 8 L22 11 L20 14" />
    {/* Forward main gun */}
    <path d="M30 16 L32 16" />
    {/* Belly hangar */}
    <path d="M10 18 L10 22 L20 22 L20 18" />
    {/* Aft thruster */}
    <path d="M4 15 L2 16 L4 17" />
  </SVG>
);

// ===== FREIGHTER — cargo hauler =====

/** Freighter A: stacked container blocks */
export const FreighterA: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Cargo container blocks */}
    <rect x="8" y="9" width="6" height="6" />
    <rect x="14" y="9" width="6" height="6" />
    <rect x="8" y="17" width="6" height="6" />
    <rect x="14" y="17" width="6" height="6" />
    {/* Forward command pod */}
    <path d="M20 13 L26 13 L28 16 L26 19 L20 19" />
    {/* Engine */}
    <path d="M8 14 L4 14 L4 18 L8 18" />
  </SVG>
);

/** Freighter B: tug pulling a cargo pod */
export const FreighterB: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Cargo pod (rear, large) */}
    <rect x="4" y="11" width="13" height="10" rx="1" />
    {/* Connecting strut */}
    <path d="M17 14 L21 14 M17 18 L21 18" />
    {/* Tug section */}
    <path d="M21 11 L27 11 L30 16 L27 21 L21 21 Z" />
    {/* Tug cockpit */}
    <circle cx="26" cy="16" r="1.3" />
  </SVG>
);

/** Freighter C: bulk hauler with bridge on top */
export const FreighterC: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Bulk hull */}
    <path d="M4 12 L22 12 L28 16 L22 20 L4 20 Z" />
    {/* Bridge superstructure */}
    <path d="M8 12 L8 7 L16 7 L18 10 L16 12" />
    {/* Cargo hatches on belly */}
    <path d="M10 20 L10 23 L14 23 L14 20" />
    <path d="M16 20 L16 23 L20 23 L20 20" />
    {/* Aft engines */}
    <path d="M4 13 L1 13 M4 19 L1 19" />
  </SVG>
);

// ============================================================
// CANDIDATE icons (D / E / F per class) — proposed additions for the
// player-choosable picker. Reviewable in the gallery at ?icons; the
// final set will be kept in the dropdown, the rest removed.
// ============================================================

// ===== CORVETTE candidates =====

/** Corvette D — NEEDLE: razor-thin interceptor with stabilizers */
export const CorvetteD: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Long needle nose */}
    <path d="M2 16 L8 14 L24 15 L31 16 L24 17 L8 18 Z" />
    {/* Vertical stabilizers (top + bottom) */}
    <path d="M14 14 L13 9 L17 9 L17 14" />
    <path d="M14 18 L13 23 L17 23 L17 18" />
    {/* Cockpit */}
    <circle cx="22" cy="16" r="1" fill="currentColor" stroke="none" />
  </SVG>
);

/** Corvette E — DART-FIN: swept arrow with a single rear tail fin */
export const CorvetteE: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Arrowhead */}
    <path d="M4 16 L20 11 L30 16 L20 21 Z" />
    {/* Big tail fin behind */}
    <path d="M4 16 L1 9 L7 12" />
    <path d="M4 16 L1 23 L7 20" />
    {/* Forward laser barrel */}
    <path d="M30 16 L32 16" />
  </SVG>
);

/** Corvette F — RAPTOR: bird-like with forward beak + rear talons */
export const CorvetteF: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Beak / nose */}
    <path d="M16 16 L30 14 L30 18 Z" />
    {/* Body */}
    <path d="M6 12 L16 12 L18 16 L16 20 L6 20 Z" />
    {/* Talons / engine claws */}
    <path d="M6 12 L2 8 L4 14" />
    <path d="M6 20 L2 24 L4 18" />
    {/* Eye dot */}
    <circle cx="24" cy="16" r="1" fill="currentColor" stroke="none" />
  </SVG>
);

// ===== FRIGATE candidates =====

/** Frigate D — STARSHIP: saucer + nacelles silhouette */
export const FrigateD: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Saucer (forward) */}
    <ellipse cx="22" cy="16" rx="8" ry="5" />
    {/* Neck */}
    <path d="M14 15 L18 15 M14 17 L18 17" />
    {/* Twin nacelles (rear, top + bottom) */}
    <path d="M4 10 L14 10 L14 14 L4 14 Z" />
    <path d="M4 18 L14 18 L14 22 L4 22 Z" />
    {/* Nacelle tips */}
    <circle cx="14" cy="12" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="0.8" fill="currentColor" stroke="none" />
  </SVG>
);

/** Frigate E — HAWK: wing-prominent with an underslung weapons pod */
export const FrigateE: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Central fuselage */}
    <path d="M6 14 L24 14 L30 16 L24 18 L6 18 Z" />
    {/* Big swept wings */}
    <path d="M10 14 L4 8 L18 13" />
    <path d="M10 18 L4 24 L18 19" />
    {/* Underslung weapons pod */}
    <rect x="14" y="20" width="6" height="2.5" />
    {/* Cockpit */}
    <circle cx="22" cy="16" r="1.2" fill="currentColor" stroke="none" />
  </SVG>
);

/** Frigate F — CARRIER: hangar-bay maw with bridge tower above */
export const FrigateF: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Boxy hull */}
    <path d="M4 12 L24 12 L30 16 L24 20 L4 20 Z" />
    {/* Forward hangar opening */}
    <path d="M24 14 L30 16 L24 18 Z" />
    {/* Bridge tower on top */}
    <path d="M8 12 L10 7 L16 7 L18 12" />
    {/* Aft engine block */}
    <path d="M4 13 L1 14 L1 18 L4 19" />
  </SVG>
);

// ===== DESTROYER candidates =====

/** Destroyer D — DREADNOUGHT: armored brick with multiple turrets */
export const DestroyerD: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Brick hull */}
    <rect x="4" y="9" width="22" height="14" rx="1" />
    {/* Forward ramming prow */}
    <path d="M26 11 L31 16 L26 21" />
    {/* Six turrets */}
    <circle cx="10" cy="12" r="1.5" />
    <circle cx="15" cy="12" r="1.5" />
    <circle cx="20" cy="12" r="1.5" />
    <circle cx="10" cy="20" r="1.5" />
    <circle cx="15" cy="20" r="1.5" />
    <circle cx="20" cy="20" r="1.5" />
  </SVG>
);

/** Destroyer E — RAILGUN: long sniper spike dominating the silhouette */
export const DestroyerE: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Long rail barrel */}
    <path d="M14 15 L32 15 L32 17 L14 17 Z" />
    {/* Compact aft hull */}
    <path d="M2 11 L14 11 L14 21 L2 21 Z" />
    {/* Rail support struts */}
    <path d="M14 15 L18 12" />
    <path d="M14 17 L18 20" />
    {/* Hull blisters */}
    <circle cx="6" cy="13" r="1" />
    <circle cx="6" cy="19" r="1" />
  </SVG>
);

/** Destroyer F — BROADSIDE: flat wide profile with side gun batteries */
export const DestroyerF: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Wide flat hull */}
    <path d="M4 13 L26 13 L30 16 L26 19 L4 19 Z" />
    {/* Top gun batteries (three barrels each side) */}
    <path d="M8 13 L8 9" />
    <path d="M13 13 L13 9" />
    <path d="M18 13 L18 9" />
    {/* Bottom gun batteries */}
    <path d="M8 19 L8 23" />
    <path d="M13 19 L13 23" />
    <path d="M18 19 L18 23" />
    {/* Forward gun */}
    <path d="M30 16 L32 16" />
    {/* Aft engine block */}
    <path d="M4 14 L1 15 L1 17 L4 18" />
  </SVG>
);

// ===== FREIGHTER candidates =====

/** Freighter D — TANKER: chained cylindrical fuel tanks behind a tug */
export const FreighterD: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Aft tank */}
    <ellipse cx="6" cy="16" rx="4" ry="3" />
    {/* Mid tank */}
    <ellipse cx="14" cy="16" rx="4" ry="3" />
    {/* Connector struts */}
    <path d="M10 15 L10 17 M18 15 L18 17" />
    {/* Forward tug */}
    <path d="M18 13 L26 13 L30 16 L26 19 L18 19 Z" />
    {/* Tug cockpit */}
    <circle cx="25" cy="16" r="1" fill="currentColor" stroke="none" />
  </SVG>
);

/** Freighter E — RING: torus cargo ring around a central spine */
export const FreighterE: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Central spine */}
    <path d="M2 16 L30 16" strokeWidth={2.5} />
    {/* Cargo ring (front) */}
    <ellipse cx="18" cy="16" rx="3.5" ry="7" />
    {/* Aft engine */}
    <path d="M2 14 L4 12 L8 12 L8 20 L4 20 L2 18 Z" />
    {/* Forward nose */}
    <circle cx="30" cy="16" r="1" fill="currentColor" stroke="none" />
  </SVG>
);

/** Freighter F — BARGE: flat slab with stacked container columns */
export const FreighterF: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Flat slab hull */}
    <rect x="3" y="13" width="22" height="6" />
    {/* Container column 1 */}
    <rect x="5" y="8" width="4" height="5" />
    <rect x="5" y="19" width="4" height="5" />
    {/* Container column 2 */}
    <rect x="11" y="8" width="4" height="5" />
    <rect x="11" y="19" width="4" height="5" />
    {/* Container column 3 */}
    <rect x="17" y="8" width="4" height="5" />
    <rect x="17" y="19" width="4" height="5" />
    {/* Forward bridge */}
    <path d="M25 13 L29 13 L31 16 L29 19 L25 19" />
  </SVG>
);

// ============================================================
// Selector — render any (class, variant) combination
// ============================================================

const REGISTRY: Record<ShipIconClass, Record<ShipIconVariant, React.FC<IconProps>>> = {
  corvette:  { A: CorvetteA,  B: CorvetteB,  C: CorvetteC,  D: CorvetteD,  E: CorvetteE,  F: CorvetteF  },
  frigate:   { A: FrigateA,   B: FrigateB,   C: FrigateC,   D: FrigateD,   E: FrigateE,   F: FrigateF   },
  destroyer: { A: DestroyerA, B: DestroyerB, C: DestroyerC, D: DestroyerD, E: DestroyerE, F: DestroyerF },
  freighter: { A: FreighterA, B: FreighterB, C: FreighterC, D: FreighterD, E: FreighterE, F: FreighterF },
};

/** Human-readable names for each variant, surfaced in the picker
 *  dropdown and the ?icons gallery. */
export const ICON_VARIANT_NAMES: Record<ShipIconClass, Record<ShipIconVariant, string>> = {
  corvette:  { A: 'Dart',      B: 'Delta',     C: 'Gunship',     D: 'Needle',     E: 'Dart-Fin',   F: 'Raptor'   },
  frigate:   { A: 'Cruciform', B: 'Diamond',   C: 'Triple-Turret', D: 'Starship', E: 'Hawk',       F: 'Carrier'  },
  destroyer: { A: 'Hexagon',   B: 'Wedge',     C: 'Capital',     D: 'Dreadnought', E: 'Railgun',   F: 'Broadside' },
  freighter: { A: 'Containers', B: 'Tug',      C: 'Bulk',        D: 'Tanker',     E: 'Ring',       F: 'Barge'    },
};

/** Every variant id, ordered for the gallery + picker. */
export const ALL_VARIANTS: ShipIconVariant[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Player-chosen default icon variant per class. */
export const DEFAULT_SHIP_ICONS: Record<ShipIconClass, ShipIconVariant> = {
  corvette: 'B',
  frigate: 'B',
  destroyer: 'B',
  freighter: 'A',
};

export interface ShipIconProps extends IconProps {
  shipClass: ShipIconClass;
  variant?: ShipIconVariant;
}

export const ShipIcon: React.FC<ShipIconProps> = ({ shipClass, variant, ...rest }) => {
  const v = variant ?? DEFAULT_SHIP_ICONS[shipClass];
  const Component = REGISTRY[shipClass][v];
  return <Component {...rest} />;
};
