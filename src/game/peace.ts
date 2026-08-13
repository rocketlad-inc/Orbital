// ============================================================
// "Are these two factions at peace?" — the one place that answers it.
//
// The rule mirrors worker/room.js's combat pass EXACTLY: an active NAP
// or defense pact between two factions suppresses damage between them.
// Intel-share is deliberately NOT peace — the server happily shoots
// between intel-share-only partners, so a UI that called them friendly
// would be promising a ceasefire that never happens.
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

/** Never at peace with anyone — single-player, and any caller with no
 *  treaty data. Shared instance so callers can compare identity. */
export const NO_PEACE: PeaceCheck = () => false;

// pactPairs array -> Set, cached by array identity. The provider only
// allocates a new array when /state actually changes, so per-frame and
// per-render callers rebuild nothing.
let cachedArr: readonly string[] | undefined;
let cachedSet: Set<string> | null = null;

/**
 * Build the at-peace predicate from the game's active pact pairs.
 *
 * A faction against ITSELF is deliberately not special-cased: callers
 * skip same-owner comparisons already, and quietly answering "yes" would
 * let a real bug hide behind a true.
 */
export function makePeaceCheck(pactPairs?: readonly string[]): PeaceCheck {
  if (!pactPairs || pactPairs.length === 0) return NO_PEACE;
  if (pactPairs !== cachedArr) {
    cachedArr = pactPairs;
    cachedSet = new Set(pactPairs);
  }
  const set = cachedSet;
  if (!set) return NO_PEACE;
  return (a, b) => set.has(pairKey(a, b));
}
