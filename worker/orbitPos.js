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

export const ORBITAL_SPEED_SCALE = 0.7;

const TWO_PI = Math.PI * 2;

/** Orbital angle of a body at tick `t`. Period is denominated in ticks. */
export function orbitAngle(angle0, period, t) {
  const p = Number(period) || 0;
  return (angle0 ?? 0) + (p > 0 ? (TWO_PI * t * ORBITAL_SPEED_SCALE / p) : 0);
}

/**
 * Fraction of a leg covered at time-fraction `f` under a symmetric
 * flip-and-burn: boost at constant acceleration to the midpoint, flip,
 * brake the rest of the way.
 *
 * Deliberately NOT linear, and the gap is not a rounding difference: at
 * quarter flight the ship has covered 12.5% of the leg where a straight
 * lerp says 25% — twice as far along as it really is.
 */
export function burnProgress(f) {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  return f <= 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f);
}
