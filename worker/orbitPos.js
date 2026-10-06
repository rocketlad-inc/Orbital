// ============================================================
// Orbital angle + torch burn profile — ONE copy of each formula.
//
// This file exists because the same two formulas were written out by hand
// in several places and the copies disagreed:
//
//   - room.js's leg planner omitted ORBITAL_SPEED_SCALE entirely, so it
//     advanced planets 1/0.7 = 1.43x too fast when sizing freighter runs.
//   - state.js's fog-of-war pass placed in-transit ships on a straight
//     LINEAR lerp, while the client flies (and draws) a real flip-and-burn.
//
// Both built clean and read as correct. They just computed positions
// nothing else agreed with.
//
// KEEP IN SYNC with ORBITAL_SPEED_SCALE in src/physics/orbitalMechanics.ts
// and the torch model in src/physics/torchTransfer.ts.
// ============================================================

import { boostState } from './burn.js';

export const ORBITAL_SPEED_SCALE = 0.7;

const TWO_PI = Math.PI * 2;

/** Orbital angle of a body at tick `t`. Period is denominated in ticks. */
export function orbitAngle(angle0, period, t) {
  const p = Number(period) || 0;
  return (angle0 ?? 0) + (p > 0 ? (TWO_PI * t * ORBITAL_SPEED_SCALE / p) : 0);
}

/**
 * Fraction of a leg covered at time-fraction `f` under a flip-and-burn:
 * boost at constant acceleration, flip, brake the rest of the way.
 *
 * Deliberately NOT linear, and the gap is not a rounding difference: at
 * quarter flight on an even burn the ship has covered 12.5% of the leg
 * where a straight lerp says 25% — twice as far along as it really is.
 *
 * `k` is the leg's brake / boost ratio (burn.js BRAKE_MUL for every leg
 * planned since 2026-10-06; 1 for the even burns before it, whose rows
 * carry no brake_accel). The flip lands at F = k/(1+k) of the trip:
 * f^2/F on the way out, 1 - (1+k)(1-f)^2 on the way in.
 */
export function burnProgress(f, k = 1) {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  if (!(k > 0) || k === 1) return f <= 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f);
  const F = k / (1 + k);
  return f <= F ? (f * f) / F : 1 - (1 + k) * (1 - f) * (1 - f);
}

/** A leg row's brake / boost ratio: 1 for an even burn (no brake_accel). */
export function brakeRatioOf(accel, brakeAccel) {
  const a = Number(accel), b = Number(brakeAccel);
  return brakeAccel != null && a > 0 && b > 0 ? b / a : 1;
}

/**
 * Fraction of a leg covered at time-fraction `f`, for any leg the table
 * holds. A leg with a build-up (accel_ramp, migration 0158) follows its
 * own curve: the push grows from `accel` toward `max`, then it brakes at
 * `brake` from the flip until it stops. Anything else is a constant push
 * and goes through burnProgress with its brake ratio.
 *
 * @param leg {accel, brake, ramp, max, tau, startTick, flipTick, arriveTick}
 */
export function legProgress(f, leg) {
  const ramp = Number(leg.ramp) > 0 ? Number(leg.ramp) : 0;
  // The exponential build (accel_tau, migration 0159) or the linear one.
  const etau = Number(leg.tau) > 0 ? Number(leg.tau) : 0;
  if (!(ramp > 0) && !(etau > 0)) return burnProgress(f, brakeRatioOf(leg.accel, leg.brake));
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  const a0 = Number(leg.accel), max = Number(leg.max), brake = Number(leg.brake);
  const T = Number(leg.arriveTick) - Number(leg.startTick);
  const t1 = Number(leg.flipTick) - Number(leg.startTick);
  if (!(a0 > 0) || !(brake > 0) || !(T > 0) || !(t1 > 0)) return burnProgress(f);
  const s1 = boostState(t1, a0, ramp, max, etau);
  const total = s1.x + (s1.v * s1.v) / (2 * brake);
  if (!(total > 0)) return f;
  const tau = f * T;
  if (tau <= t1) return Math.min(1, boostState(tau, a0, ramp, max, etau).x / total);
  // Braking; an arrival ceiled past the stop just waits at the end.
  const u = Math.min(tau - t1, s1.v / brake);
  return Math.min(1, (s1.x + s1.v * u - 0.5 * brake * u * u) / total);
}
