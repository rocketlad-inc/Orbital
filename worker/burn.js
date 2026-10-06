// ============================================================
// THE BURN EVERY SHIP FLIES IN MULTIPLAYER, IN ONE PLACE.
//
// A ship lights its engine at 0.05g, and the push BUILDS the longer it
// burns — EXPONENTIALLY: it doubles about every 11 ticks, so it barely
// moves at first and climbs steeply later, reaching 1g at 48 ticks and
// holding there. At the flip it turns round and brakes at BRAKE_MUL x
// whatever push it had reached, so it arrives at rest. A moon hop hardly
// gets up the build; a long haul spends most of its burn near the top,
// which is what makes the outer system crossable.
//
// Lorne, 2026-10-06, in steps: "build from launch" (linear, 0.05g -> 1g
// over 48 ticks), then, with moon hops too fast, "change the growth from
// linear to exponential, so it starts muuuuch slower but leads to the
// same result". At System scale 4 with one-hour ticks, typical routes
// (before today -> linear -> exponential):
//   Io-Callisto 9.7 -> 5.5 -> 6.7h     Earth-Mars 20.2 -> 9.8 -> 12.9h
//   Neptune-Pluto 54 -> 21 -> 28h      Pluto-Makemake 66 -> 24 -> 32h
// (A flat 1g push shipped for 21 minutes that day too, and was far too
// fast: Earth-Mars in 3.4h.)
//
// Legs already in flight keep the build they were committed with: a
// linear ramp (accel_ramp) or none. This file integrates all three.
//
// Mirrored by src/physics/torchTransfer.ts, which installs these values
// from /state (game.burn_*) and is held to this file by
// src/physics/__tests__/burnParity.test.ts.
// ============================================================

/** 1g: the push that carries a ship Sol -> Earth (132.6 units at the
 *  catalogue scale) in one tick on a symmetric burn. a = 4 * d / T^2. */
export const G_ANCHOR = 4 * 132.6;

/** Every hull's push at launch, in g. Engine parts and captain traits
 *  multiply the whole build (launch, rate and top) on the client. */
export const SHIP_ENGINE_G = 0.05;

/** Where the build tops out, in g (before parts). */
export const MAX_ENGINE_G = 1;

/** Ticks of burning to build from SHIP_ENGINE_G to MAX_ENGINE_G. */
export const RAMP_TICKS = 48;

/** Braking thrust as a multiple of the push reached at the flip. */
export const BRAKE_MUL = 9;

/** The base push before 2026-10-06. Kept only to scale the transit-
 *  combat speed thresholds, which were tuned against it. */
export const LEGACY_ENGINE_G = 0.05;

export const fromG = (g) => g * G_ANCHOR;

/** Base launch push, game units / tick^2. */
export const SHIP_ENGINE_ACCEL = fromG(SHIP_ENGINE_G);

/** Ticks for the push to grow by a factor of e, so it climbs from launch
 *  to the top in RAMP_TICKS: ~16 ticks (doubling every ~11). */
export const GROWTH_TAU = RAMP_TICKS / Math.log(MAX_ENGINE_G / SHIP_ENGINE_G);

/** The build for a hull that launches at `a0`: exponential (tau, in
 *  ticks) up to the top, proportional to a0 so engine parts lift the
 *  whole curve. ramp (the old linear rate) is 0: no new leg is linear. */
export function rampFor(a0) {
  const max = a0 * (MAX_ENGINE_G / SHIP_ENGINE_G);
  return { ramp: 0, max, tau: max > a0 ? GROWTH_TAU : 0 };
}

/**
 * Push, speed and distance after `tau` ticks of boosting from rest.
 *   etau > 0: a = min(max, a0 * e^(tau/etau)) — the build since the
 *             exponential switch (migration 0159, accel_tau)
 *   ramp > 0: a = min(max, a0 + ramp * tau)   — the linear build it
 *             replaced (migration 0158), still flown by legs committed
 *             with it
 *   neither:  a constant push (every leg before the build-up)
 */
export function boostState(tau, a0, ramp = 0, max = a0, etau = 0) {
  if (etau > 0 && max > a0) {
    // expm1 keeps the start of the curve exact, where it matters most.
    const grow = (t) => {
      const u = t / etau, em = Math.expm1(u);
      return { a: a0 * (em + 1), v: a0 * etau * em, x: a0 * etau * etau * (em - u) };
    };
    const tcE = etau * Math.log(max / a0);
    if (tau <= tcE) return grow(tau);
    const c = grow(tcE), s = tau - tcE;
    return { a: max, v: c.v + max * s, x: c.x + c.v * s + 0.5 * max * s * s };
  }
  if (!(ramp > 0) || !(max > a0)) return { a: a0, v: a0 * tau, x: 0.5 * a0 * tau * tau };
  const tc = (max - a0) / ramp;
  if (tau <= tc) {
    return {
      a: a0 + ramp * tau,
      v: a0 * tau + 0.5 * ramp * tau * tau,
      x: 0.5 * a0 * tau * tau + (ramp * tau * tau * tau) / 6,
    };
  }
  const vc = a0 * tc + 0.5 * ramp * tc * tc;
  const xc = 0.5 * a0 * tc * tc + (ramp * tc * tc * tc) / 6;
  const s = tau - tc;
  return { a: max, v: vc + max * s, x: xc + vc * s + 0.5 * max * s * s };
}

/** Distance covered by a whole leg that flips at `t1` (boost, then brake
 *  at k x the push reached to a stop). Increasing in t1. */
function legDistance(t1, a0, ramp, max, k, etau = 0) {
  const s = boostState(t1, a0, ramp, max, etau);
  return s.x + (s.v * s.v) / (2 * k * s.a);
}

/**
 * The leg over a straight-line distance `d`: when it flips (t1, ticks
 * after launch), how long it takes (T), how hard it brakes, its top
 * speed. Solved by bisection on the flip — exact to float precision.
 */
export function burnShape(d, a0, ramp = 0, max = a0, k = BRAKE_MUL, etau = 0) {
  if (!(d > 0) || !(a0 > 0)) return { t1: 0, T: 0, brake: k * a0, vPeak: 0 };
  let hi = 1;
  while (legDistance(hi, a0, ramp, max, k, etau) < d && hi < 1e9) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (legDistance(m, a0, ramp, max, k, etau) < d) lo = m; else hi = m;
  }
  const t1 = (lo + hi) / 2;
  const s = boostState(t1, a0, ramp, max, etau);
  const brake = k * s.a;
  return { t1, T: t1 + s.v / brake, brake, vPeak: s.v };
}

/** Trip time for a hull that launches at `a0`, with the build-up. What
 *  every server leg timer uses (trade, delivery, retreat, gate routing). */
export function legTicks(d, a0) {
  const { ramp, max, tau } = rampFor(a0);
  return burnShape(d, a0, ramp, max, BRAKE_MUL, tau).T;
}

/**
 * The plan that covers `d` in EXACTLY `T` — for legs the SERVER plans,
 * whose arrival is already fixed (ceiled to whole ticks, or paced to an
 * escort's carrier). Scaling every acceleration by s scales the distance
 * by s and leaves every time alone, so: find the flip whose trip lasts T
 * at the base build, then scale the whole build to fit d.
 */
export function shapeForArrival(d, T, a0 = SHIP_ENGINE_ACCEL) {
  const { ramp, max, tau } = rampFor(a0);
  const k = BRAKE_MUL;
  const tripOf = (t1) => { const s = boostState(t1, a0, ramp, max, tau); return t1 + s.v / (k * s.a); };
  let lo = 0, hi = T;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (tripOf(m) < T) lo = m; else hi = m;
  }
  const t1 = (lo + hi) / 2;
  const scale = d / legDistance(t1, a0, ramp, max, k, tau);
  const reached = boostState(t1, a0, ramp, max, tau).a;
  // tau is a TIME, so scaling every acceleration leaves it as it is.
  return {
    t1, accel: a0 * scale, ramp: ramp * scale, max: max * scale, brake: k * reached * scale, tau,
  };
}

/** Trip time over `d` at a CONSTANT push `a`, braking at k x it:
 *  T = sqrt(2d(1+k) / (a*k)). k = 1 gives the old 2*sqrt(d/a). */
export function burnTicks(d, a, k = BRAKE_MUL) {
  return Math.sqrt((2 * d * (1 + k)) / (a * k));
}

/** The constant push that covers `d` in exactly `T`. Inverse of burnTicks. */
export function boostAccelFor(d, T, k = BRAKE_MUL) {
  return (2 * d * (1 + k)) / (k * T * T);
}

// ---- Transit-combat speed scales ------------------------------------
// Its thresholds were tuned when every hull pushed a flat 0.05g on an even
// burn, against interplanetary cruise passes of 200-380 u/t and a one-tick
// departure burn of 26.5 u/t. These say how much faster the same moments
// are now, so the thresholds can move with them.

const LEGACY_ACCEL = fromG(LEGACY_ENGINE_G);
/** The route that peaked at 290 u/t (mid-cruise) on the legacy burn. */
const REF_CRUISE_V = 290;
const REF_D = (REF_CRUISE_V * REF_CRUISE_V) / LEGACY_ACCEL;

/** Peak speed on the reference route now, over then. */
export const CRUISE_SPEED_SCALE = (() => {
  const { ramp, max, tau } = rampFor(SHIP_ENGINE_ACCEL);
  return burnShape(REF_D, SHIP_ENGINE_ACCEL, ramp, max, BRAKE_MUL, tau).vPeak / REF_CRUISE_V;
})();

/** Speed one tick after lighting the engine, now over then. */
export const DEPARTURE_SPEED_SCALE = (() => {
  const { ramp, max, tau } = rampFor(SHIP_ENGINE_ACCEL);
  return boostState(1, SHIP_ENGINE_ACCEL, ramp, max, tau).v / LEGACY_ACCEL;
})();
