// ============================================================
// mining — the numbers a player needs quoted back to them.
//
// These are MIRRORS of server constants, and the reason they live in one
// module instead of being typed into each panel is that the prose copies
// were already multiplying: shipParts.ts says "50/tick" in the Mining
// Rig blurb, BodyInspector says "fills at 50 a tick", and the meteoroid
// card says it again. Three hand-written copies of a tuning number is
// three chances to retune the server and leave the UI lying.
//
// miningMirrors.test.ts reads the worker sources and fails if either of
// these drifts, so the copy stays honest without anyone remembering to
// check.
// ============================================================

/** Units pulled from a rock per tick by one rigged freighter.
 *  MIRRORS MINE_RATE_PER_TICK in worker/room.js. */
export const MINE_RATE_PER_TICK = 50;

/** Base freighter hold. MIRRORS CARGO_CAP in worker/routeMath.js.
 *  A captain's cargo trait scales the real figure, which is why live
 *  panels prefer the server's `projection.hold_cap` and fall back to
 *  this — see RouteComposer. For "how many trips is this rock worth"
 *  the base is the right unit anyway: it is the number a player can
 *  reason with before assigning anyone. */
export const BASE_HOLD = 500;

/** Ticks a rigged freighter sits parked to fill one base hold.
 *  This is the whole risk of mining — it cannot leave while filling. */
export const TICKS_PER_HOLD = Math.ceil(BASE_HOLD / MINE_RATE_PER_TICK);

/** Whole freighter-loads still in a rock. Rounded UP, because a partial
 *  load is still a trip you have to make. */
export function loadsRemaining(remaining: number, holdCap: number = BASE_HOLD): number {
  if (!(remaining > 0) || !(holdCap > 0)) return 0;
  return Math.ceil(remaining / holdCap);
}

/** What a rock's mineral pays out as. Rocks carry metal or gold only —
 *  no science, because research drain clamps to income and a science
 *  rock would have paid into a bucket that cannot bank it. */
export function mineralUnit(kind: 'metal' | 'gold' | null | undefined): string {
  return kind === 'gold' ? 'credits' : 'metal';
}
