// ============================================================
// Ship Icons — three SVG silhouette options per ship class.
// All icons face right (prograde) on a 32×32 viewBox.
// They use currentColor so they inherit text color from CSS.
// ============================================================

import React from 'react';
import { lighten, darken } from '../render/colors';

// A/B/C — the original three; D/E/F — the first expansion; G/H/I — the
// 2026-08 expansion (more icon options, DESIGN-fleet-economy follow-up).
// The picker dropdown at ship construction lets the player override the
// default per-build. Server validators accept /^[A-I]$/ — keep in sync.
export type ShipIconVariant = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
export type ShipIconClass = 'corvette' | 'frigate' | 'destroyer' | 'freighter' | 'colony';

interface IconProps {
  size?: number;
  color?: string;
  /** Two-tone factions (§5): secondary livery color. The hull is painted
   *  in the primary; every DETAIL element (cockpit, wings, engines,
   *  turrets — i.e. every child after the first) is painted in the
   *  secondary, so the ship itself reads two-tone with no ring. Decoration
   *  only — ownership meaning stays in the primary (colorblind safety);
   *  absent color2 falls back to a single-color ship. */
  color2?: string;
  className?: string;
  /** Component avatar (DESIGN-fleet-economy follow-up): fitted parts
   *  render as PHYSICAL HARDWARE on the hull — a nose barrel that grows
   *  per kinetic copy, a glowing energy emitter, armor plating strips,
   *  longer engine plumes, a red detonator core, and a shield bubble
   *  enclosing the ship (UX-juror adjudicated). Below 40px only the two
   *  big-silhouette reads survive scaling (shield bubble + plume); the
   *  greebles render at designer/panel scale. Undefined = plain hull. */
  parts?: readonly string[];
}

/** Fixed semantic colors for part hardware — deliberately NOT faction
 *  colors, so "what is this ship carrying" reads the same on every hull. */
const HW = {
  kinetic: '#c9d4de',
  energy: '#7fd4ff',
  shield: '#4ecdc4',
  armor: '#8a94a0',
  plume: '#ff9e4a',
  detonator: '#ff5e5e',
};

const countOf = (parts: readonly string[], id: string) =>
  parts.reduce((n, p) => n + (p === id ? 1 : 0), 0);

/** Part hardware overlay. Icons share a geometry contract: face +x,
 *  midline y=16, nose ≈x=29, engine bell ≈x=4 — anchors below lean on it. */
const PartHardware: React.FC<{ parts: readonly string[]; size: number }> = ({ parts, size }) => {
  const nKinetic = countOf(parts, 'kinetic');
  const nEnergy = countOf(parts, 'energy');
  const nShield = countOf(parts, 'shield');
  const nArmor = countOf(parts, 'armor');
  const nEngine = countOf(parts, 'engine');
  const nDet = countOf(parts, 'detonator');
  // Small sizes keep only the reads that survive scaling: is it tanky
  // (bubble), is it fast (plume). Everything else is one click away.
  const greebles = size >= 40;
  return (
    <g>
      {nEngine > 0 && (
        // Exhaust plume behind the bell — longer per booster.
        <path
          d={`M4.5 14.6 L${Math.max(0.5, 4 - 1.4 * nEngine)} 16 L4.5 17.4 Z`}
          fill={HW.plume} fillOpacity={0.85} stroke="none"
        />
      )}
      {greebles && nKinetic > 0 && (
        // One nose barrel that grows longer + thicker per copy — the
        // "I bolted on a bigger gun" read without hardpoint clutter.
        <path
          d={`M28 14.6 L${Math.min(31.5, 28.5 + 1.2 * nKinetic)} 14.6`}
          stroke={HW.kinetic} strokeWidth={0.9 + 0.45 * nKinetic} strokeLinecap="round"
        />
      )}
      {greebles && nEnergy > 0 && (
        // Charged emitter under the nose — brighter halo per copy.
        <>
          <circle cx="27.5" cy="18" r={1.6 + 0.5 * nEnergy} fill={HW.energy} fillOpacity={0.22} stroke="none" />
          <circle cx="27.5" cy="18" r={0.9 + 0.25 * nEnergy} fill={HW.energy} stroke="none" />
        </>
      )}
      {greebles && nArmor > 0 && (
        // Riveted plating strips along the dorsal + keel lines.
        <g stroke={HW.armor} strokeWidth={1.6} strokeLinecap="round">
          {Array.from({ length: Math.min(3, nArmor) }).map((_, i) => (
            <React.Fragment key={i}>
              <path d={`M${11 + i * 4.5} 11.2 L${13.5 + i * 4.5} 11.2`} />
              <path d={`M${11 + i * 4.5} 20.8 L${13.5 + i * 4.5} 20.8`} />
            </React.Fragment>
          ))}
        </g>
      )}
      {greebles && nDet > 0 && (
        // The self-destruct core — unmistakably red, amidships.
        <path
          d="M14 14.4 L15.6 16 L14 17.6 L12.4 16 Z"
          fill={HW.detonator} stroke="none"
        />
      )}
      {nShield > 0 && (
        // Shield bubble enclosing the whole hull — the tanky-at-a-glance
        // read. Opacity + weight scale with the array count.
        <ellipse
          cx="16" cy="16" rx="14" ry="10.5"
          fill="none" stroke={HW.shield}
          strokeOpacity={Math.min(0.85, 0.3 + 0.18 * nShield)}
          strokeWidth={0.8 + 0.25 * nShield}
        />
      )}
    </g>
  );
};

// Monotonic id counter so every rendered icon gets unique def ids
// (clipPaths / gradients). SVGs rendered into the DOM share one id
// namespace per document; a raw fixed id would cross-wire icons.
let svgUid = 0;

const SVG = ({ size = 24, color, color2, className, parts, children }: IconProps & { children: React.ReactNode }) => {
  // Convention across every icon: the FIRST child is the hull, the rest
  // are detail accents. The hull gets the full shaded treatment (solid
  // primary fill + keel shade + dorsal highlight + baked engine glow);
  // detail children are recolored in the secondary. No per-icon edits —
  // the two-tone livery lives in the silhouette.
  const primary = color ?? 'currentColor';
  const accent = color2 || primary;
  const kids = React.Children.toArray(children) as React.ReactElement[];
  const hull = kids[0];
  const details = kids.slice(1);

  // Shading needs to derive tints from the primary, which only works
  // for hex colors (the map-raster path always passes hex). DOM/UI
  // contexts using currentColor keep the previous flat treatment.
  const shaded = typeof primary === 'string' && primary.startsWith('#');
  const idBase = shaded ? `si${svgUid++}` : '';
  const hullClipId = `${idBase}h`;
  const dorsalClipId = `${idBase}d`;
  const glowId = `${idBase}g`;
  const keelShade = shaded ? darken(primary, 0.6) : primary;
  const dorsalLight = shaded ? lighten(primary, 1.3) : primary;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke={primary}
      strokeWidth={1.5}
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      {shaded && hull && (
        <defs>
          {/* Hull silhouette as a clip so the keel shade never bleeds
              outside the ship. */}
          <clipPath id={hullClipId}>
            {React.cloneElement(hull, { stroke: 'none', fill: 'none' })}
          </clipPath>
          {/* Top-half clip for the dorsal highlight (icons are built on
              a y=16 midline; stop just above it so the highlight reads
              as top-lit, not a full outline). */}
          <clipPath id={dorsalClipId}>
            <rect x="0" y="0" width="32" height="15.5" />
          </clipPath>
          {/* Warm engine glow — baked at ~30% intensity; the live
              canvas thrust flame still layers on during burns. */}
          <radialGradient id={glowId} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffdca8" stopOpacity="0.95" />
            <stop offset="0.45" stopColor="#ff9e4a" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ff7a2e" stopOpacity="0" />
          </radialGradient>
        </defs>
      )}
      {hull && React.cloneElement(hull, {
        stroke: primary,
        fill: primary,
        fillOpacity: shaded ? 1 : 0.5,
      })}
      {shaded && hull && (
        <>
          {/* Keel shade: darkened bottom half, clipped to the hull. */}
          <rect
            x="0" y="16" width="32" height="16"
            fill={keelShade} fillOpacity={0.4} stroke="none"
            clipPath={`url(#${hullClipId})`}
          />
          {/* 1px dorsal highlight along the hull's top edge. */}
          {React.cloneElement(hull, {
            stroke: dorsalLight,
            strokeWidth: 1,
            fill: 'none',
            clipPath: `url(#${dorsalClipId})`,
          })}
        </>
      )}
      {details.map((d, i) => {
        // Preserve a detail's own fill intent: solid dots (fill set) get
        // filled in the accent; open lines (fill 'none'/unset) stay
        // stroke-only in the accent.
        const hadFill = d.props?.fill && d.props.fill !== 'none';
        return React.cloneElement(d, {
          key: i,
          stroke: accent,
          ...(hadFill ? { fill: accent } : {}),
        });
      })}
      {/* Always-on engine glow dot at the bell (icons face +x, bell
          sits at roughly x=4, y=16 across the set). Drawn last so it
          reads over the aft hull edge. */}
      {shaded && (
        <circle
          cx="4" cy="16" r="4.5"
          fill={`url(#${glowId})`} stroke="none" opacity={0.32}
        />
      )}
      {/* Component avatar: fitted parts as physical hardware, drawn over
          everything so the loadout reads at a glance. */}
      {parts && parts.length > 0 && <PartHardware parts={parts} size={size} />}
    </svg>
  );
};

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
// G / H / I — the 2026-08 expansion (player ask: more icon options).
// Same house rules: hull is the FIRST child, details after; face +x,
// midline y=16, bell ≈x=4, nose ≈x=29.
// ============================================================

// ===== CORVETTE G/H/I =====

/** Corvette G — VIPER: twin-boom raider with a central pod */
export const CorvetteG: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Central pod hull */}
    <path d="M6 13 L20 13 L29 16 L20 19 L6 19 L3 16 Z" />
    {/* Twin booms above/below */}
    <path d="M8 13 L8 9 L18 9" />
    <path d="M8 19 L8 23 L18 23" />
    {/* Cockpit dot */}
    <circle cx="23" cy="16" r="1.1" fill="currentColor" stroke="none" />
  </SVG>
);

/** Corvette H — SCYTHE: curved blade profile */
export const CorvetteH: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Curved blade hull */}
    <path d="M4 19 Q13 8 30 14 L26 18 Q14 13 7 21 Z" />
    {/* Tail fin */}
    <path d="M5 20 L2 25 L8 22" />
    {/* Edge glint dot */}
    <circle cx="24" cy="15.5" r="1" fill="currentColor" stroke="none" />
  </SVG>
);

/** Corvette I — WASP: pinched waist with a stinger nose */
export const CorvetteI: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Two-lobe body */}
    <path d="M4 14 L10 13 L13 15 L22 13 L29 16 L22 19 L13 17 L10 19 L4 18 Z" />
    {/* Stinger */}
    <path d="M29 16 L32 16" />
    {/* Swept wing pair at the waist */}
    <path d="M12 14 L9 9 L15 13" />
    <path d="M12 18 L9 23 L15 19" />
  </SVG>
);

// ===== FRIGATE G/H/I =====

/** Frigate G — TRIDENT: triple-prong prow */
export const FrigateG: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Body */}
    <path d="M4 13 L18 13 L24 16 L18 19 L4 19 Z" />
    {/* Three prongs */}
    <path d="M22 13 L30 12" />
    <path d="M24 16 L32 16" />
    <path d="M22 19 L30 20" />
    {/* Bridge dome */}
    <circle cx="12" cy="16" r="1.6" />
  </SVG>
);

/** Frigate H — MANTA: wide ray silhouette */
export const FrigateH: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Ray body */}
    <path d="M5 16 Q12 6 29 16 Q12 26 5 16 Z" />
    {/* Tail */}
    <path d="M5 16 L1 16" />
    {/* Eye dots */}
    <circle cx="24" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="24" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
  </SVG>
);

/** Frigate I — LANCE: spear hull behind a shield boss */
export const FrigateI: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Spear hull */}
    <path d="M4 14 L22 14 L31 16 L22 18 L4 18 Z" />
    {/* Shield boss amidships */}
    <circle cx="12" cy="16" r="3.2" />
    {/* Aft fins */}
    <path d="M6 14 L4 10 L9 13" />
    <path d="M6 18 L4 22 L9 19" />
  </SVG>
);

// ===== DESTROYER G/H/I =====

/** Destroyer G — CITADEL: fortress hull with twin towers */
export const DestroyerG: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Fortress hull */}
    <rect x="4" y="11" width="22" height="10" rx="1" />
    {/* Twin towers */}
    <path d="M8 11 L8 7 L12 7 L12 11" />
    <path d="M18 11 L18 7 L22 7 L22 11" />
    {/* Ram prow */}
    <path d="M26 12 L31 16 L26 20" />
    {/* Keel battery */}
    <path d="M10 21 L10 24 M15 21 L15 24 M20 21 L20 24" />
  </SVG>
);

/** Destroyer H — HAMMER: hammerhead prow on a long haft */
export const DestroyerH: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Haft + head as one silhouette */}
    <path d="M3 14 L21 14 L21 10 L27 10 L27 22 L21 22 L21 18 L3 18 Z" />
    {/* Head face plate */}
    <path d="M27 12 L30 12 M27 20 L30 20" />
    {/* Aft engine block */}
    <path d="M3 15 L1 15 L1 17 L3 17" />
    {/* Hull blisters */}
    <circle cx="9" cy="16" r="1" />
    <circle cx="15" cy="16" r="1" />
  </SVG>
);

/** Destroyer I — LEVIATHAN: segmented long hull with dorsal spines */
export const DestroyerI: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Long segmented hull */}
    <path d="M3 13 L28 13 L31 16 L28 19 L3 19 Z" />
    {/* Segment joints */}
    <path d="M9 13 L9 19 M15 13 L15 19 M21 13 L21 19" />
    {/* Dorsal spines */}
    <path d="M11 13 L12 9 L13 13" />
    <path d="M17 13 L18 9 L19 13" />
    {/* Aft thruster */}
    <path d="M3 14 L1 16 L3 18" />
  </SVG>
);

// ===== FREIGHTER G/H/I =====

/** Freighter G — CLIPPER: sleek fast hauler with a window strip */
export const FreighterG: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Sleek hull */}
    <path d="M4 14 L24 12 L30 16 L24 20 L4 18 Z" />
    {/* Cargo window strip */}
    <rect x="9" y="14.5" width="10" height="3" rx="1" />
    {/* Aft engines */}
    <path d="M4 15 L1 15 M4 17 L1 17" />
  </SVG>
);

/** Freighter H — GANTRY: crane frame carrying a slung container */
export const FreighterH: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Slab hull */}
    <rect x="4" y="14" width="21" height="5" rx="1" />
    {/* Gantry frame */}
    <path d="M7 14 L7 8 L22 8 L22 14" />
    {/* Slung container */}
    <rect x="11" y="9.5" width="6" height="4" />
    {/* Forward cab */}
    <path d="M25 14 L28 14 L30 16.5 L28 19 L25 19" />
  </SVG>
);

/** Freighter I — HIVE: hex-cell cluster hauler */
export const FreighterI: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Hex cluster hull */}
    <path d="M6 12 L14 10 L22 12 L25 16 L22 20 L14 22 L6 20 L4 16 Z" />
    {/* Cell walls */}
    <path d="M10 12 L10 20 M15 10.5 L15 21.5 M20 12 L20 20" />
    {/* Nose pod */}
    <path d="M25 14 L29 16 L25 18" />
  </SVG>
);

// ===== COLONY SHIP — consumable settler transport =====

/** Colony A — ARK: rounded hull with a habitat dome. One silhouette
 *  serves all six variant slots — the class is a consumable one-shot,
 *  so per-build icon variety matters less than instant readability
 *  ("that's the settler ship"). */
export const ColonyA: React.FC<IconProps> = (p) => (
  <SVG {...p}>
    {/* Rounded hull */}
    <path d="M6 13 L22 13 Q28 13 29 16 Q28 19 22 19 L6 19 Q4 16 6 13 Z" />
    {/* Habitat dome on top */}
    <path d="M11 13 Q11 7 17 7 Q23 7 23 13" />
    {/* Dome porthole */}
    <circle cx="17" cy="10.5" r="1.2" />
    {/* Belly landing struts */}
    <path d="M10 19 L10 22 M20 19 L20 22" />
    {/* Aft engine */}
    <path d="M6 14 L2 15 L2 17 L6 18" />
  </SVG>
);

// ============================================================
// Selector — render any (class, variant) combination
// ============================================================

const REGISTRY: Record<ShipIconClass, Record<ShipIconVariant, React.FC<IconProps>>> = {
  corvette:  { A: CorvetteA,  B: CorvetteB,  C: CorvetteC,  D: CorvetteD,  E: CorvetteE,  F: CorvetteF,  G: CorvetteG,  H: CorvetteH,  I: CorvetteI  },
  frigate:   { A: FrigateA,   B: FrigateB,   C: FrigateC,   D: FrigateD,   E: FrigateE,   F: FrigateF,   G: FrigateG,   H: FrigateH,   I: FrigateI   },
  destroyer: { A: DestroyerA, B: DestroyerB, C: DestroyerC, D: DestroyerD, E: DestroyerE, F: DestroyerF, G: DestroyerG, H: DestroyerH, I: DestroyerI },
  freighter: { A: FreighterA, B: FreighterB, C: FreighterC, D: FreighterD, E: FreighterE, F: FreighterF, G: FreighterG, H: FreighterH, I: FreighterI },
  colony:    { A: ColonyA,    B: ColonyA,    C: ColonyA,    D: ColonyA,    E: ColonyA,    F: ColonyA,    G: ColonyA,    H: ColonyA,    I: ColonyA    },
};

/** Human-readable names for each variant, surfaced in the picker
 *  dropdown and the ?icons gallery. */
export const ICON_VARIANT_NAMES: Record<ShipIconClass, Record<ShipIconVariant, string>> = {
  corvette:  { A: 'Dart',      B: 'Delta',     C: 'Gunship',     D: 'Needle',     E: 'Dart-Fin',   F: 'Raptor',   G: 'Viper',    H: 'Scythe',    I: 'Wasp'      },
  frigate:   { A: 'Cruciform', B: 'Diamond',   C: 'Triple-Turret', D: 'Starship', E: 'Hawk',       F: 'Carrier',  G: 'Trident',  H: 'Manta',     I: 'Lance'     },
  destroyer: { A: 'Hexagon',   B: 'Wedge',     C: 'Capital',     D: 'Dreadnought', E: 'Railgun',   F: 'Broadside', G: 'Citadel', H: 'Hammer',    I: 'Leviathan' },
  freighter: { A: 'Containers', B: 'Tug',      C: 'Bulk',        D: 'Tanker',     E: 'Ring',       F: 'Barge',    G: 'Clipper',  H: 'Gantry',    I: 'Hive'      },
  colony:    { A: 'Ark',       B: 'Ark',       C: 'Ark',         D: 'Ark',        E: 'Ark',        F: 'Ark',      G: 'Ark',      H: 'Ark',       I: 'Ark'       },
};

/** Every variant id, ordered for the gallery + picker. */
export const ALL_VARIANTS: ShipIconVariant[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

/** Player-chosen default icon variant per class. */
export const DEFAULT_SHIP_ICONS: Record<ShipIconClass, ShipIconVariant> = {
  corvette: 'B',
  frigate: 'B',
  destroyer: 'B',
  freighter: 'A',
  colony: 'A',
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
