// ============================================================
// THE BURN EVERY SHIP FLIES IN MULTIPLAYER, IN ONE PLACE.
//
// A ship pushes toward its target at `boost`, flips, and brakes at
// BRAKE_MUL x boost so it arrives at rest. With the brake nine times
// harder than the push, the flip lands at 90% of the trip (time AND
// distance), and the trip takes 0.745x as long as an even 50/50 burn.
//
// Base thrust is 0.05g. It was raised to 1g on 2026-10-06 (the outer
// system took days to cross) and put back within the hour: 6x shorter
// trips everywhere (Earth-Mars ~20h -> ~3.4h) was far too fast. The hard
// brake alone stays: every trip is 0.745x what it was.
//
// Mirrored by src/physics/torchTransfer.ts, which installs these values
// from /state (game.burn_engine_g, game.burn_brake_mul) and is held to
// this file by src/physics/__tests__/burnParity.test.ts.
// ============================================================

/** 1g: the push that carries a ship Sol -> Earth (132.6 units at the
 *  catalogue scale) in one tick on a symmetric burn. a = 4 * d / T^2. */
export const G_ANCHOR = 4 * 132.6;

/** Every hull's base thrust, in g. Engine parts and captain traits
 *  multiply it on the client, where legs are planned. */
export const SHIP_ENGINE_G = 0.05;

/** Braking thrust as a multiple of the push. 1 = the old even burn. */
export const BRAKE_MUL = 9;

/** What the base thrust was before 2026-10-06. Kept only to scale the
 *  transit-combat speed thresholds, which were tuned against it. */
export const LEGACY_ENGINE_G = 0.05;

export const fromG = (g) => g * G_ANCHOR;

/** Base boost acceleration, game units / tick^2. */
export const SHIP_ENGINE_ACCEL = fromG(SHIP_ENGINE_G);

/** Share of the trip (in time) spent pushing; the flip comes here. */
export const FLIP_FRACTION = BRAKE_MUL / (1 + BRAKE_MUL);

/**
 * Trip time over a straight-line distance `d` at boost `a`, braking at
 * a * k. From v = a*t1 = (a*k)*t2 and d = a*t1^2/2 + (a*k)*t2^2/2:
 * T = sqrt(2d(1+k) / (a*k)). k = 1 gives the old 2*sqrt(d/a).
 */
export function burnTicks(d, a, k = BRAKE_MUL) {
  return Math.sqrt((2 * d * (1 + k)) / (a * k));
}

/**
 * The boost that covers `d` in exactly `T` (braking at k x boost) — for
 * legs the SERVER plans, whose arrival is already fixed (ceiled to whole
 * ticks, or paced to an escort's carrier). The inverse of burnTicks.
 */
export function boostAccelFor(d, T, k = BRAKE_MUL) {
  return (2 * d * (1 + k)) / (k * T * T);
}

/**
 * How much faster a cruising ship moves than it did at the legacy burn,
 * over the same route: peak speed is sqrt(2k/(1+k) * a * d), so the ratio
 * is sqrt(2k/(1+k) * g / legacy g): 1.34 at 0.05g with a 9x brake.
 */
export const CRUISE_SPEED_SCALE = Math.sqrt(
  ((2 * BRAKE_MUL) / (1 + BRAKE_MUL)) * (SHIP_ENGINE_G / LEGACY_ENGINE_G),
);

/** How much faster a hull is moving one tick after lighting its engine:
 *  linear in the push. */
export const DEPARTURE_SPEED_SCALE = SHIP_ENGINE_G / LEGACY_ENGINE_G;
