// ============================================================
// Faction emblem artwork — 24 heraldic shapes on a 32×32 viewBox.
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
  spear: ({ title }) => wrap(<>
    <polygon points="16,1 21,11 16,9 11,11" />
    <rect x="14.5" y="9" width="3" height="22" />
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
    <path d="M10 4h12v5l-2 2v20h-8V11l-2-2z" />, title),
  pyramid: ({ title }) => wrap(<>
    <path d="M16 3 31 29H1z" />
    <path d="M16 3v26H1z" fill="#000" opacity="0.3" />
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
