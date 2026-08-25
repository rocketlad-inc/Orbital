// ============================================================
// LOCKSTEP ARRIVAL — a fleet lands as a fleet.
//
// Hulls in one squadron rarely fly alike: engine rating is per faction
// but fitted engine parts are per hull, so a five-ship fleet sent to
// one world arrives smeared over several ticks. The fast ships get
// there first, alone, and get beaten in detail — which is the exact
// opposite of the reason you put them in a fleet.
//
// THE FAST SHIPS WAIT, RATHER THAN THE SLOW ONES HURRYING. There is no
// way to make a hull arrive sooner than its own burn allows, so the
// only lever is delaying departure — which the wait machinery already
// provides. It also keeps the formation together AT THE ORIGIN until
// the last moment, where it is defended, rather than strung out across
// the gap.
//
// WHY IT ITERATES. Delaying a departure changes the intercept
// geometry: the destination has moved, so travel time is not the same
// as it was for an immediate burn. wait = target - arrival is
// therefore a first guess, not an answer, and the correction is
// applied again until it settles.
// ============================================================

/**
 * Solve the per-hull departure delays that make a group arrive together.
 *
 * `arriveAt(id, wait)` must return the tick that hull would arrive if
 * it departed `wait` ticks from now, or null if it cannot fly the leg
 * at all. It is called repeatedly, so it must be side-effect free.
 *
 * Returns a wait per hull. Hulls whose leg cannot be solved are absent
 * from the map — the caller decides whether to fly the rest or refuse,
 * and a fleet that can only partly reach a destination is worth saying
 * out loud either way.
 */
/** Never throttle a hull below this fraction of its own burn. A fleet
 *  crawling to match one derelict is worse than arriving apart. */
export const MIN_THROTTLE = 0.15;

/**
 * Solve the per-hull ENGINE THROTTLE that makes a group land together.
 *
 * `arriveAt(id, mul)` returns the tick that hull would arrive flying at
 * `mul` times its own acceleration, or null if it cannot fly the leg.
 * Side-effect free: it is called repeatedly.
 *
 * WHY THROTTLE AND NOT DELAY. The first version held the fast hulls at
 * the origin so everyone landed together. That was tactically right and
 * looked broken: a player sent six ships to Saturn, watched five leave
 * and one sit there, and reported it as the fleet leaving its destroyer
 * behind. Arriving together is the goal; LEAVING together is the part
 * you can see, and a formation that matches speed to its slowest member
 * gets both. That is also what a real formation does.
 *
 * ARRIVALS RESOLVE ON WHOLE TICKS — the server fires a leg when
 * arrival_at_tick <= tick — so hulls landing at 322.09 and 322.45 are
 * already together and nothing is done to them.
 *
 * The first guess is exact for a brachistochrone: T = 2*sqrt(d/a), so
 * stretching travel from t0 to t1 needs a1 = a0 * (t0/t1)^2. It still
 * iterates, because a slower crossing meets the destination somewhere
 * else and the distance is not what it was.
 */
export function solveLockstepThrottle(
  ids: string[],
  arriveAt: (id: string, mul: number) => number | null,
  now: number,
  opts: { maxIters?: number } = {},
): Map<string, number> {
  const maxIters = opts.maxIters ?? 5;
  const muls = new Map<string, number>();
  const natural = new Map<string, number>();

  for (const id of ids) {
    const a = arriveAt(id, 1);
    if (a == null) continue;
    natural.set(id, a);
    muls.set(id, 1);
  }
  if (muls.size <= 1) return muls;

  const landsOn = (a: number) => Math.ceil(a);
  const target = Math.max(...[...natural.values()].map(landsOn));
  // Already landing on one tick: leave the fleet alone. Throttling to
  // fix a fraction of a tick would slow the fleet for nothing.
  if (Math.min(...[...natural.values()].map(landsOn)) === target) return muls;

  // Aim just inside the target tick so rounding cannot push a hull over
  // into the next one.
  const aimAt = target - 0.05;

  for (const id of [...muls.keys()]) {
    let mul = 1;
    for (let iter = 0; iter < maxIters; iter += 1) {
      const a = arriveAt(id, mul);
      if (a == null) break;
      if (landsOn(a) === target) break;
      const travel = Math.max(1e-6, a - now);
      const want = Math.max(1e-6, aimAt - now);
      // a1 = a0 * (t0/t1)^2 — exact for the closed-form burn, a good
      // guess once the moving target is added back in.
      const next = mul * (travel / want) ** 2;
      if (!Number.isFinite(next)) break;
      mul = Math.max(MIN_THROTTLE, Math.min(1, next));
      if (mul === MIN_THROTTLE) break;   // as slow as it is allowed to fly
    }
    muls.set(id, mul);
  }
  return muls;
}

/**
 * How far apart a set of arrivals is, in ticks. Used to report what
 * lockstep actually bought — and to say nothing when a fleet was
 * already together, rather than claiming credit for it.
 */
export function arrivalSpread(arrivals: number[]): number {
  if (arrivals.length < 2) return 0;
  return Math.max(...arrivals) - Math.min(...arrivals);
}
