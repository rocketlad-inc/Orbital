// ============================================================
// tickPhase — where we are BETWEEN two server ticks, 0..1.
//
// Multiplayer resolves the sim on the server every tick_interval_ms —
// as long as an hour of real time. The client held every ship and planet
// at the last resolved tick, so the solar system stood perfectly still
// for an hour and then teleported.
//
// Nothing about the position math needed to change: bodyPosition,
// localPositionAt and torchPositionFromSamples all take a continuous
// `t` and always have. Only the VALUE fed to them was quantized. Adding
// the fraction of the current tick that has elapsed makes everything
// glide, and — because the fraction reaches exactly 1.0 as the next tick
// lands — a body arrives at its next-tick position at the instant the
// server says it's there. No easing, no catch-up, no drift.
//
// Single-player needs none of this: its local sim loop already advances
// currentTick by a fractional delta at 20Hz (gameContext), which is why
// saveGame has to Math.floor it. Smoothing there would double-count and
// run the system fast, so SP is detected (no tickIntervalMs) and passed
// through untouched.
// ============================================================

/**
 * Fraction of the way from the last tick to the next, clamped to [0, 1].
 *
 * Returns 0 — a dead stop at the last resolved tick — whenever the
 * cadence isn't trustworthy:
 *   - `nextTickAt` is null: the game is paused or still in setup.
 *   - Turn-based games park `next_tick_at` ~24h out (worker/actions.js),
 *     which makes `remaining` enormous and the raw phase deeply
 *     negative. Clamping pins it at 0 rather than creeping.
 *
 * Clamping the top end matters just as much: if the server tick runs
 * late, `remaining` goes negative and the raw phase exceeds 1. Letting
 * that through would extrapolate a body PAST its next known position
 * into a future nobody has simulated. Instead it parks on the next-tick
 * position and waits for the server to catch up.
 */
export function tickPhase(
  nextTickAt: number | null | undefined,
  tickIntervalMs: number | null | undefined,
  nowMs: number,
): number {
  if (nextTickAt == null) return 0;
  if (!tickIntervalMs || tickIntervalMs <= 0) return 0;
  const phase = 1 - (nextTickAt - nowMs) / tickIntervalMs;
  if (!Number.isFinite(phase)) return 0;
  return phase < 0 ? 0 : phase > 1 ? 1 : phase;
}

/**
 * The tick value to RENDER at — `currentTick` plus the elapsed fraction
 * of the tick in flight. Feed this to any position function instead of
 * the raw tick.
 *
 * This is a display-only value. Game logic, saves and anything comparing
 * against server-authoritative tick numbers must keep using the integer
 * `currentTick`: a ship is at tick 41, it is not at tick 41.6.
 */
export function smoothedTick(
  currentTick: number,
  nextTickAt: number | null | undefined,
  tickIntervalMs: number | null | undefined,
  nowMs: number,
): number {
  // Single-player: currentTick is already continuous. Leave it alone.
  if (tickIntervalMs == null) return currentTick;
  return currentTick + tickPhase(nextTickAt, tickIntervalMs, nowMs);
}
