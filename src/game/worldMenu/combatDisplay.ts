// ============================================================
// World-menu combat display — MULTIPLAYER ONLY.
//
// Pure helpers mapping settlement HP (server-authoritative) to the
// menu's health bars and damage-fire intensity. Display only: no
// combat logic lives here, and none of this is reachable from SP.
// ============================================================

/** No flames at or above this hp ratio; below it, fire scales up. */
export const FIRE_THRESH = 0.85;

/** HP-bar color by ratio. Boundaries are exclusive on the high side:
 *  exactly 0.6 is amber, exactly 0.3 is red (spec I2). */
export function hpColor(ratio: number): string {
  return ratio > 0.6 ? '#66bb6a' : ratio > 0.3 ? '#ffb84d' : '#ef5350';
}

/** How many of a structure's fire anchor points should burn at the
 *  given hp ratio. Monotone non-decreasing as ratio drops; at least
 *  one flame once below FIRE_THRESH (spec I3). */
export function flameCount(ratio: number, anchorPoints: number): number {
  if (ratio >= FIRE_THRESH) return 0;
  return Math.max(1, Math.min(anchorPoints, Math.round((1 - ratio) * anchorPoints * 1.25)));
}
