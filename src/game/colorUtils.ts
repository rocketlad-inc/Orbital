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

/** Minimum sRGB distance between two players' PRIMARY colors. Keep in
 *  sync with COLOR_MIN_DISTANCE in worker/lobby.js. */
export const COLOR_MIN_DISTANCE = 90;
