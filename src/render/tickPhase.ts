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

/** Real-time duration of one visual lap for a parked ship. 30s read as
 *  frantic next to the planets, which move at true (very slow) rate; 90s
 *  was still a touch fast, so this sits at ~half that pace. */
export const SHIP_VISUAL_ORBIT_MS = 180_000;

/**
 * The `t` to draw a PARKED ship's orbital angle at — true time plus a
 * cosmetic spin.
 *
 * Why this exists: at true rate a ship sweeps a healthy ~39 degrees per
 * tick, but an hour-long tick spreads that over an hour — about one
 * pixel a minute. It is genuinely animating and completely invisible.
 * This makes parked hulls circle their planet once every
 * SHIP_VISUAL_ORBIT_MS so the map reads as alive.
 *
 * What it does NOT touch: which body a ship orbits, its radius, or
 * anything the sim resolves. A parked ship's ANGLE around its planet
 * carries no gameplay meaning — auto-combat engages everything sharing a
 * body, and sensor ranges dwarf these few-unit orbits — so spinning it
 * costs nothing real. Planets keep their true positions, because a
 * planet's place along its orbit absolutely does matter.
 *
 * The spin is ADDITIVE on top of true time, which keeps each hull's
 * distinct phase: ships fan out around a body by differing `epoch`
 * (build tick) and `M0`, and adding the same offset to every ship's `t`
 * preserves those differences instead of stacking the whole fleet on one
 * point. Scaling by `period` converts "fraction of a lap" into this
 * particular orbit's time units, so every ship completes its lap in the
 * same wall-clock time regardless of radius, and none of them lap each
 * other.
 *
 * `nowMs` is taken modulo the lap so the number stays small; the angle
 * is mod 2*pi anyway, so the wrap is invisible.
 *
 * Ships under burn are excluded by the caller — a transit follows its
 * torch trajectory, and spinning that would be a lie about a position
 * the player is actively steering.
 */
/**
 * THE clock for the cosmetic spin. Every caller of shipDisplayTick must
 * use this one.
 *
 * The lap fraction is `nowMs % SHIP_VISUAL_ORBIT_MS`, so the ORIGIN of
 * the clock decides where on its orbit a hull is drawn. mapRenderer used
 * Date.now() (epoch) and combatFx used performance.now() (page load) —
 * unrelated origins, so the FX layer placed hulls at a different point
 * on the same orbit than the renderer drew them. Both now call this.
 *
 * Date.now() rather than performance.now() so the phase is shared by
 * every surface in the app regardless of when each one started.
 */
export function spinNowMs(): number {
  return Date.now();
}

export function shipDisplayTick(
  t: number,
  orbitPeriod: number | null | undefined,
  nowMs: number,
): number {
  if (!orbitPeriod || orbitPeriod <= 0 || !Number.isFinite(orbitPeriod)) return t;
  const lapFraction = (nowMs % SHIP_VISUAL_ORBIT_MS) / SHIP_VISUAL_ORBIT_MS;
  return t + orbitPeriod * lapFraction;
}
