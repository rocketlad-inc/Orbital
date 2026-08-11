// ============================================================
// Faction emblem artwork — 25 heraldic shapes on a 32×32 viewBox.
//
// Same conventions as ShipIcons: pure SVG, no external assets, drawn
// with `currentColor` so a caller sets the colour once via CSS and the
// shape inherits it. Every glyph is built from a handful of primitives
// (circle / polygon / path) and stays legible down to ~12px, which is
// the size a scoreboard chip actually renders at — detail that only
// reads at 48px is wasted here.
//
// Deliberately SILHOUETTES, not line art. A flag has to work as a solid
// stamp against a two-tone field; strokes disappear against a matching
// background, fills don't.
// ============================================================

import React from 'react';
import { EmblemId, resolveEmblem, EMBLEM_NAMES } from '../game/emblems';
import { deriveSecondary, emblemInk } from '../game/colorUtils';

interface GlyphProps { title?: string }

/** All glyphs share this frame so they optically match at one size. */
const wrap = (children: React.ReactNode, title?: string) => (
  <svg viewBox="0 0 32 32" width="100%" height="100%" fill="currentColor"
       aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}
    {children}
  </svg>
);

const GLYPHS: Record<EmblemId, (p: GlyphProps) => React.ReactElement> = {
  star: ({ title }) => wrap(
    <polygon points="16,3 20,12 30,13 22,19 25,29 16,23 7,29 10,19 2,13 12,12" />, title),
  sun: ({ title }) => wrap(<>
    <circle cx="16" cy="16" r="7" />
    {Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      return <rect key={i} x="15" y="1" width="2" height="6" rx="1"
        transform={`rotate(${(a * 180) / Math.PI} 16 16)`} />;
    })}
  </>, title),
  moon: ({ title }) => wrap(
    <path d="M21 4a13 13 0 1 0 0 24 15 15 0 0 1 0-24z" />, title),
  comet: ({ title }) => wrap(<>
    <circle cx="22" cy="10" r="6" />
    <path d="M18 14 4 28l3-11z" />
  </>, title),
  orbit: ({ title }) => wrap(<>
    <circle cx="16" cy="16" r="5" />
    <ellipse cx="16" cy="16" rx="14" ry="6" fill="none"
      stroke="currentColor" strokeWidth="2.5" transform="rotate(-25 16 16)" />
  </>, title),
  ring: ({ title }) => wrap(<>
    <circle cx="16" cy="16" r="7.5" />
    <ellipse cx="16" cy="16" rx="15" ry="4.5" fill="none"
      stroke="currentColor" strokeWidth="2.5" transform="rotate(20 16 16)" />
  </>, title),
  crown: ({ title }) => wrap(
    <path d="M3 24h26l2-15-8 6-6-11-6 11-8-6z" />, title),
  shield: ({ title }) => wrap(
    <path d="M16 2 4 7v10c0 7 5 11 12 13 7-2 12-6 12-13V7z" />, title),
  // Spear and Tower are the only two tall-narrow silhouettes, so they
  // are drawn wider than their real proportions would suggest: measured
  // in the browser, the natural versions came out 10 and 12 units across
  // against a 32 grid, which at a 12px chip is under 4 real pixels of
  // ink. Verticality still reads; anorexic verticality reads as nothing.
  spear: ({ title }) => wrap(<>
    <polygon points="16,1 23,12 16,9.5 9,12" />
    <rect x="13.5" y="9" width="5" height="22" />
  </>, title),
  trident: ({ title }) => wrap(<>
    <rect x="14.5" y="6" width="3" height="25" />
    <path d="M5 4v8a11 11 0 0 0 22 0V4h-3v8a8 8 0 0 1-16 0V4z" />
  </>, title),
  hammer: ({ title }) => wrap(<>
    <rect x="4" y="4" width="24" height="9" rx="2" />
    <rect x="13.5" y="13" width="5" height="18" />
  </>, title),
  anchor: ({ title }) => wrap(<>
    <circle cx="16" cy="5" r="3.5" />
    <rect x="14.5" y="8" width="3" height="21" />
    <rect x="8" y="10" width="16" height="3" rx="1.5" />
    <path d="M3 18c0 7 6 12 13 12s13-5 13-12h-3c0 5-4 9-10 9S6 23 6 18z" />
  </>, title),
  skull: ({ title }) => wrap(<>
    <path d="M16 2C9 2 4 7 4 14c0 4 2 7 5 9v5h14v-5c3-2 5-5 5-9 0-7-5-12-12-12z" />
    <circle cx="11.5" cy="14" r="3" fill="#000" opacity="0.55" />
    <circle cx="20.5" cy="14" r="3" fill="#000" opacity="0.55" />
  </>, title),
  wolf: ({ title }) => wrap(
    <path d="M4 6l5 5h14l5-5-2 10 3 4-8 3-1 6-4-4-4 4-1-6-8-3 3-4z" />, title),
  phoenix: ({ title }) => wrap(
    <path d="M16 2l4 8 10-4-6 9 8 5-11 1 3 9-8-6-8 6 3-9-11-1 8-5-6-9 10 4z" />, title),
  eye: ({ title }) => wrap(<>
    <path d="M2 16s6-9 14-9 14 9 14 9-6 9-14 9S2 16 2 16z" />
    <circle cx="16" cy="16" r="4.5" fill="#000" opacity="0.6" />
  </>, title),
  key: ({ title }) => wrap(<>
    <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="4" />
    <rect x="14" y="15" width="3.5" height="16" />
    <rect x="17.5" y="21" width="6" height="3" />
    <rect x="17.5" y="27" width="8" height="3" />
  </>, title),
  gear: ({ title }) => wrap(<>
    {Array.from({ length: 8 }, (_, i) => (
      <rect key={i} x="14" y="1" width="4" height="8"
        transform={`rotate(${i * 45} 16 16)`} />
    ))}
    <circle cx="16" cy="16" r="9" />
    <circle cx="16" cy="16" r="3.5" fill="#000" opacity="0.55" />
  </>, title),
  helix: ({ title }) => wrap(<>
    <path d="M9 2c0 8 14 12 14 20a8 8 0 0 1-2 8" fill="none"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    <path d="M23 2c0 8-14 12-14 20a8 8 0 0 0 2 8" fill="none"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </>, title),
  leaf: ({ title }) => wrap(
    <path d="M28 3C12 3 3 12 3 24c0 2 1 4 2 5C7 16 15 9 28 3z" />, title),
  wave: ({ title }) => wrap(<>
    <path d="M2 12c4-5 8-5 12 0s8 5 12 0l4 4c-4 5-8 5-12 0s-8-5-12 0z" />
    <path d="M2 22c4-5 8-5 12 0s8 5 12 0l4 4c-4 5-8 5-12 0s-8-5-12 0z" />
  </>, title),
  mountain: ({ title }) => wrap(
    <path d="M2 28 12 8l6 10 4-6 8 16z" />, title),
  tower: ({ title }) => wrap(
    <path d="M8 3h16v6l-3 3v19h-10V12L8 9z" />, title),
  pyramid: ({ title }) => wrap(<>
    <path d="M16 3 31 29H1z" />
    <path d="M16 3v26H1z" fill="#000" opacity="0.3" />
  </>, title),

  // ----- premium wing (Commander's Commission) -----
  // Same rules as the free set: solid silhouettes, legible at 12px.

  dragon: ({ title }) => wrap(<>
    {/* Head + jaw facing right, swept wing above, coiled tail below. */}
    <path d="M6 22 Q3 16 8 11 Q14 5 22 8 L29 11 L22 12.5 L26 16 L19 15.5 Q21 20 16 23 Q11 26 6 22z" />
    <path d="M10 8 L14 2 L17 7z" />
    <circle cx="23" cy="10" r="1" fill="#000" opacity="0.35" />
  </>, title),

  kraken: ({ title }) => wrap(<>
    {/* Dome head over four splayed tentacles. */}
    <path d="M8 13 Q8 4 16 4 Q24 4 24 13 L24 16 L8 16z" />
    <path d="M9 16 Q7 22 3 24 Q8 25 11 21z" />
    <path d="M13 16 Q12 24 9 29 Q14 27 15.5 20z" />
    <path d="M19 16 Q20 24 23 29 Q18 27 16.5 20z" />
    <path d="M23 16 Q25 22 29 24 Q24 25 21 21z" />
    <circle cx="12.5" cy="11" r="1.4" fill="#000" opacity="0.35" />
    <circle cx="19.5" cy="11" r="1.4" fill="#000" opacity="0.35" />
  </>, title),

  galaxy: ({ title }) => wrap(<>
    {/* Two-arm spiral around a core. */}
    <circle cx="16" cy="16" r="4" />
    <path d="M16 12 Q26 10 28 18 Q30 8 20 5 Q17 4 16 12z" />
    <path d="M16 20 Q6 22 4 14 Q2 24 12 27 Q15 28 16 20z" />
  </>, title),

  nova: ({ title }) => wrap(<>
    {/* Eight-point burst with a hollow shockwave ring. */}
    <path d="M16 1 L18.5 12 L16 9 L13.5 12z" />
    <path d="M16 31 L13.5 20 L16 23 L18.5 20z" />
    <path d="M1 16 L12 13.5 L9 16 L12 18.5z" />
    <path d="M31 16 L20 18.5 L23 16 L20 13.5z" />
    <path d="M5.4 5.4 L13 10 L10 10 L10 13z" />
    <path d="M26.6 26.6 L19 22 L22 22 L22 19z" />
    <path d="M26.6 5.4 L22 13 L22 10 L19 10z" />
    <path d="M5.4 26.6 L10 19 L10 22 L13 22z" />
    <circle cx="16" cy="16" r="4.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
  </>, title),

  raven: ({ title }) => wrap(<>
    {/* Perched profile, beak right, tail sweeping left-down. */}
    <path d="M9 25 Q6 14 12 9 Q18 4 24 8 L29 10 L24 11.5 Q25 16 21 20 L19 28 L16 27 L17 22 Q13 25 9 25z" />
    <path d="M9 25 L2 29 L10 27.5z" />
    <circle cx="23" cy="9.5" r="0.9" fill="#000" opacity="0.35" />
  </>, title),

  serpent: ({ title }) => wrap(<>
    {/* S-coil with a wedge head striking right. */}
    <path d="M7 27 Q2 22 7 18 Q12 14 9 10 Q7 6 12 4 Q10 8 14 10 Q19 13 14 18 Q9 23 13 26 Q10 28 7 27z" />
    <path d="M13 26 Q18 28 22 25 Q27 21 24 16 L30 13 L22 12 Q16 12 18 18 Q19 22 15 23z" />
    <circle cx="25" cy="14" r="0.9" fill="#000" opacity="0.35" />
  </>, title),

  swords: ({ title }) => wrap(<>
    {/* Two crossed blades, points up-out, guards near the base. */}
    <path d="M5 4 L20.5 22.5 L18 25 L2.5 6.5 L2.5 4z" />
    <path d="M27 4 L11.5 22.5 L14 25 L29.5 6.5 L29.5 4z" />
    <path d="M8.5 21 L11 18.5 L13.5 21 L11 23.5z" />
    <path d="M23.5 21 L21 18.5 L18.5 21 L21 23.5z" />
    <rect x="9" y="24" width="4" height="6" rx="1" transform="rotate(45 11 27)" />
    <rect x="19" y="24" width="4" height="6" rx="1" transform="rotate(-45 21 27)" />
  </>, title),

  atom: ({ title }) => wrap(<>
    <circle cx="16" cy="16" r="3.5" />
    <ellipse cx="16" cy="16" rx="14" ry="5.5" fill="none"
      stroke="currentColor" strokeWidth="2.2" />
    <ellipse cx="16" cy="16" rx="14" ry="5.5" fill="none"
      stroke="currentColor" strokeWidth="2.2" transform="rotate(60 16 16)" />
    <ellipse cx="16" cy="16" rx="14" ry="5.5" fill="none"
      stroke="currentColor" strokeWidth="2.2" transform="rotate(-60 16 16)" />
  </>, title),

  hourglass: ({ title }) => wrap(<>
    {/* Frame + pinched glass, sand pooled in both bulbs. */}
    <rect x="6" y="2" width="20" height="3.5" rx="1" />
    <rect x="6" y="26.5" width="20" height="3.5" rx="1" />
    <path d="M8 5.5 L24 5.5 Q24 12 18.5 16 Q24 20 24 26.5 L8 26.5 Q8 20 13.5 16 Q8 12 8 5.5z"
      fill="none" stroke="currentColor" strokeWidth="2.2" />
    <path d="M11 8 L21 8 Q20 12 16 14.5 Q12 12 11 8z" />
    <path d="M16 19 Q20 21.5 21 25 L11 25 Q12 21.5 16 19z" />
  </>, title),

  compass: ({ title }) => wrap(<>
    {/* Compass rose: long N-S-E-W points over short diagonals. */}
    <path d="M13 13 L6 6 L13 9z" opacity="0.55" />
    <path d="M19 13 L26 6 L19 9z" opacity="0.55" />
    <path d="M13 19 L6 26 L13 23z" opacity="0.55" />
    <path d="M19 19 L26 26 L19 23z" opacity="0.55" />
    <path d="M16 0.5 L19 13 L16 11 L13 13z" />
    <path d="M16 31.5 L13 19 L16 21 L19 19z" />
    <path d="M0.5 16 L13 13 L11 16 L13 19z" />
    <path d="M31.5 16 L19 19 L21 16 L19 13z" />
    <circle cx="16" cy="16" r="3" />
  </>, title),
  // Double V — the Double Victory campaign's mark: two concentric V
  // bands, the outer enclosing the inner.
  //
  // Drawn as two closed BANDS rather than an outline, because this file
  // is silhouettes: a stroked V vanishes against a same-coloured field,
  // and the negative space between the two V's is what makes the symbol
  // read as doubled rather than as a single chevron.
  //
  // Three widths had to be balanced against each other on the 32 grid,
  // because at a 12px chip each is well under one real pixel: the outer
  // arm (~4.8), the inner arm (~2.9), and — the one that actually
  // decides whether this reads as DOUBLE — the gap between them (~2.6).
  // Starve the gap and the two bands merge into a single fat wedge;
  // starve the inner arm and it disappears. Both are now at or above the
  // 2.5-unit strokes orbit/ring already rely on.
  // Classic storybook rocket, nose up, exhaust below. Drawn WIDE (12
  // units of barrel, fins out to 4.5/27.5) for the reason spear and
  // tower document above: a correctly-proportioned rocket is a sliver
  // at a 12px chip. The flame is a SEPARATE shape below the fins rather
  // than interior detail — interior detail disappears at chip size and
  // the silhouette is all that survives, and a rocket with no visible
  // exhaust just reads as a bullet.
  //
  // The exhaust is three TONGUES, not one teardrop. Rendered side by
  // side at 128/48/18px, a smooth teardrop reads as a solid tail fin —
  // it merges with the real fins into one diamond at chip size. The
  // jagged silhouette is what makes it read as fire, and jaggedness is
  // the one flame cue that survives being shrunk.
  rocket: ({ title }) => wrap(<>
    <path d="M16 1q6 7 6 15v5H10v-5q0-8 6-15z" />
    <path d="M10 15 4.5 25 10 21.5z" />
    <path d="M22 15 27.5 25 22 21.5z" />
    <path d="M11.4 22.6q0.6 3.4 2.2 5.6.5-1.6.6-3.2 1.1 3.4 1.8 6.1.9-2.8 2.1-6.1.2 1.6.6 3.2 1.7-2.2 2.3-5.6z" />
    <circle cx="16" cy="11" r="2.6" fill="#000" opacity="0.4" />
  </>, title),
  doublev: ({ title }) => wrap(<>
    <path d="M1 2.5 L16 30 L31 2.5 L25 2.5 L16 19.5 L7 2.5z" />
    <path d="M10 2.5 L16 15.5 L22 2.5 L18.75 2.5 L16 8.75 L13.25 2.5z" />
  </>, title),
};

export interface FactionEmblemProps {
  /** Stored emblem id. Unknown/absent falls back deterministically. */
  emblem?: string | null;
  /** Stable key for the fallback — pass the faction/member id so the
   *  same faction always draws the same shape everywhere on screen. */
  fallbackKey: string;
  size?: number;
  /** Defaults to inheriting via currentColor. */
  color?: string;
  /** Show the emblem's name to screen readers / on hover. */
  labelled?: boolean;
  style?: React.CSSProperties;
}

export const FactionEmblem: React.FC<FactionEmblemProps> = ({
  emblem, fallbackKey, size = 16, color, labelled, style,
}) => {
  const id = resolveEmblem(emblem, fallbackKey);
  const Glyph = GLYPHS[id];
  return (
    <span
      style={{
        display: 'inline-flex', width: size, height: size,
        color, flex: '0 0 auto', ...style,
      }}
      title={labelled ? EMBLEM_NAMES[id] : undefined}
    >
      <Glyph title={labelled ? EMBLEM_NAMES[id] : undefined} />
    </span>
  );
};

/**
 * The complete flag: two-tone field with the emblem stamped on it.
 *
 * This replaces the twoToneChip helper that was copy-pasted into both
 * FactionPanel and LobbyView. One component means a faction's flag can
 * never drift between the lobby and the match — which is the whole point
 * of an emblem, since a shorthand that renders differently in two places
 * is worse than no shorthand.
 */
export const FlagChip: React.FC<{
  color: string;
  color2?: string | null;
  emblem?: string | null;
  /** Stable fallback key — the faction id. */
  fallbackKey: string;
  size?: number;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
  // 16px, not the 10px the old flat swatch used: an emblem inside a 10px
  // chip renders at ~6px, which is under the legibility floor these
  // silhouettes were drawn to. A colour-only chip could be tiny; a chip
  // carrying a shape cannot.
}> = ({ color, color2, emblem, fallbackKey, size = 16, className, title, style }) => {
  const c2 = color2 || deriveSecondary(color);
  return (
    <span
      className={className}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, flex: '0 0 auto',
        background: `linear-gradient(135deg, ${color} 0%, ${color} 68%, ${c2} 68%, ${c2} 100%)`,
        ...style,
      }}
    >
      {/* Emblem occupies ~62% of the chip so the two-tone field still
          reads around it — the colour is still the primary ownership
          signal, the shape is the disambiguator on top of it. */}
      <FactionEmblem emblem={emblem} fallbackKey={fallbackKey}
                     size={Math.round(size * 0.62)} color={emblemInk(color)} />
    </span>
  );
};
