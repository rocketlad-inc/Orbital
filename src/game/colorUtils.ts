// ============================================================
// Faction color utilities — two-tone factions (§5).
//
// Rule: PRIMARY = ownership (all meaning). SECONDARY = decoration
// only — meaning must never be encoded solely in the secondary
// (colorblind safety).
//
// deriveSecondary mirrors the same rule implemented server-side in
// worker/factions.js so a faction with no explicit color2 renders
// identically whether the fallback runs on the server or the client.
// ============================================================

const HEX6 = /^#?[0-9a-fA-F]{6}$/;

function parseHex(hex: string): [number, number, number] | null {
  if (!HEX6.test(hex)) return null;
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Derive a secondary (trim) color from a primary: lighten dark colors,
 * darken light ones, by ~35%. Deterministic, so every render surface
 * agrees on the fallback for factions without an explicit color2.
 */
export function deriveSecondary(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return '#888888';
  const [r, g, b] = rgb;
  // Perceived luminance (Rec. 601 weights) decides direction.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const f = 0.35;
  if (lum > 0.5) {
    return toHex(r * (1 - f), g * (1 - f), b * (1 - f));
  }
  return toHex(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
}

/**
 * Euclidean distance between two colors in sRGB space (0..~441).
 * Used to enforce perceptual separation between PRIMARY picks in the
 * lobby (mirrors worker/lobby.js — threshold 90 there).
 */
export function colorDistance(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return Infinity;
  const dr = ca[0] - cb[0];
  const dg = ca[1] - cb[1];
  const db = ca[2] - cb[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// COLOR_MIN_DISTANCE (90) is GONE (Lorne). Primary uniqueness is now
// exact-match only: two players may not fly the SAME colour, but near
// neighbours are allowed. The distance rule ate the swatch grid — every
// pick knocked out a ball of colour space around it, and a few seated
// players left nothing distinct to choose.
//
// colorDistance above is deliberately kept: it's still the right way to
// ASK how close two colours are (the colour sim reports near-identical
// pairs as information), it just no longer forbids anything.

/** Ink candidates for an emblem. Not pure black/white: a hard #000 on a
 *  mid tone reads as a hole, and these two sit against the app's dark
 *  chrome without glaring. */
const EMBLEM_INK_LIGHT = '#f2f6fa';
const EMBLEM_INK_DARK = '#12181f';

/** WCAG relative luminance. Note this is NOT the Rec. 601 luma
 *  deriveSecondary uses — 601 is a perceptual brightness approximation
 *  from analogue video, and it disagrees with measured contrast on
 *  saturated colours. */
function relLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Ink to stamp an emblem in so it stays readable ON a faction's primary.
 *
 * Picks whichever candidate MEASURES higher contrast rather than
 * splitting on a brightness threshold. A threshold gets saturated
 * mid-tones wrong: rose (#ec407a) sits at 0.44 Rec.601 luma, so a
 * "dark → use white ink" rule chose white and scored 3.47:1, while dark
 * ink on the same swatch scores 4.76:1. Measuring both and taking the
 * better one has no such blind spot, and costs one extra multiply.
 */
export function emblemInk(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return EMBLEM_INK_LIGHT;
  const bg = relLuminance(rgb);
  const ratio = (ink: string) => {
    const l = relLuminance(parseHex(ink)!);
    return (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05);
  };
  return ratio(EMBLEM_INK_DARK) > ratio(EMBLEM_INK_LIGHT)
    ? EMBLEM_INK_DARK : EMBLEM_INK_LIGHT;
}
