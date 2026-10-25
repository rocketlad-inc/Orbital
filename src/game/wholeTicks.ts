// ============================================================
// Whole ticks, the way the server counts them.
//
// A planned leg's arriveTick is fractional (the torch planner's T), and
// the tick lands a hull on the first whole tick at or past it (room.js:
// arrival_at_tick <= tick). So the honest countdown is the CEILING.
// Panels mixed Math.round, toFixed(0) and ceil, so one trip read "T-11"
// in one place and "T-12" in another, and a colony ship's ETA moved by a
// tick when the clock started (playtest R2-C8).
// ============================================================

const EPS = 1e-6;

/** The whole tick on which something due at `at` actually happens. */
export function landingTick(at: number): number {
  return Math.ceil(at - EPS);
}

/** Whole ticks from `now` until `at` happens, never negative. */
export function ticksUntil(at: number, now: number): number {
  return Math.max(0, landingTick(at) - Math.floor(now + EPS));
}
