// ============================================================
// "Are these two factions at peace?" — the one place that answers it.
//
// The rule mirrors worker/room.js's combat pass EXACTLY, and that pass
// was INVERTED: a pair shoots only while an open war has been declared
// between them. Peace is the default and costs nothing.
//
// WHAT THIS TAKES CHANGED WITH IT. It used to be built from pactPairs,
// because a treaty was the only thing that could stop a fight; it is now
// built from warPairs, because a declaration is the only thing that can
// start one. The predicate it RETURNS is unchanged in sense — "these two
// will not shoot" — which is why no caller had to invert anything.
//
// Pacts still exist and still matter, but they answer a different
// question now ("are these two allies", for escort cover and safe
// harbour) and are no longer what suppresses damage. A UI built on them
// would have promised a ceasefire to allies and denied it to the far
// larger group who are simply not fighting anybody.
//
// The predicate is PAIRWISE, and that is the whole point. The fleet
// list, the outliner and the group panel each used to test hostility
// against a VIEWER-centric set of "my peace partners", which gets two
// things wrong the moment you look at a ship you don't own:
//
//   1. Your own faction is never in your own peace list, so YOUR ships
//      counted as hostile to everyone else's. A player with a NAP saw
//      the partner's corvette badged "IN COMBAT" purely because his own
//      corvette was parked in the same orbit — while his own ship, at
//      the same body, read "ORBITING" (player report, 2026-08-13).
//   2. Third-party treaties were invisible. Two other factions with a
//      NAP between them read as fighting each other in your fleet list.
//
// gameState.pactPairs is built server-side from the same treaty query
// room.js uses, in the same rewritten id space as Ship.ownedBy, so a
// pairwise test against it agrees with what the tick will actually do.
// ============================================================

/** Unordered key for a faction pair. Both sides must agree on the
 *  ordering or half the lookups miss. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export type PeaceCheck = (a: string, b: string) => boolean;

/** Never at peace with anyone. Retained for callers that genuinely mean
 *  "treat every foreign faction as hostile" — tests and the SP path.
 *  It is NO LONGER the right default for a caller with no data: war is
 *  now declared, so the absence of data means nobody is fighting, not
 *  everybody. Shared instance so callers can compare identity. */
export const NO_PEACE: PeaceCheck = () => false;

/** At peace with everyone — what "no war data yet" means now. A client
 *  that has not loaded /state should draw a quiet map, not paint every
 *  neighbour as a combatant for one frame. */
export const ALWAYS_PEACE: PeaceCheck = () => true;

// warPairs array -> Set, cached by array identity. The provider only
// allocates a new array when /state actually changes, so per-frame and
// per-render callers rebuild nothing.
let cachedArr: readonly string[] | undefined;
let cachedSet: Set<string> | null = null;

/**
 * Build the at-peace predicate from the game's OPEN WARS.
 *
 * Takes `gameState.warPairs`, not pactPairs — see the header. No wars
 * means total peace, which is also what a brand-new game looks like.
 *
 * A faction against ITSELF is deliberately not special-cased: callers
 * skip same-owner comparisons already, and quietly answering "yes" would
 * let a real bug hide behind a true.
 */
export function makePeaceCheck(warPairs?: readonly string[]): PeaceCheck {
  if (!warPairs || warPairs.length === 0) return ALWAYS_PEACE;
  if (warPairs !== cachedArr) {
    cachedArr = warPairs;
    cachedSet = new Set(warPairs);
  }
  const set = cachedSet;
  if (!set) return ALWAYS_PEACE;
  return (a, b) => !set.has(pairKey(a, b));
}
