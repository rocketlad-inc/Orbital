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
export function solveLockstepWaits(
  ids: string[],
  arriveAt: (id: string, wait: number) => number | null,
  opts: { maxIters?: number; tolerance?: number } = {},
): Map<string, number> {
  const maxIters = opts.maxIters ?? 4;
  const tolerance = opts.tolerance ?? 0.5;
  const waits = new Map<string, number>();

  // Everyone's natural arrival, leaving now.
  const natural = new Map<string, number>();
  for (const id of ids) {
    const a = arriveAt(id, 0);
    if (a == null) continue;
    natural.set(id, a);
    waits.set(id, 0);
  }
  if (waits.size <= 1) return waits;

  // The slowest hull sets the pace and never waits: it is already the
  // constraint, and delaying it would only push the whole fleet later.
  let target = Math.max(...natural.values());

  for (let iter = 0; iter < maxIters; iter += 1) {
    let worst = 0;
    for (const id of [...waits.keys()]) {
      const w = waits.get(id) ?? 0;
      const a = arriveAt(id, w);
      if (a == null) continue;
      const err = target - a;
      if (Math.abs(err) > worst) worst = Math.abs(err);
      // Never negative: a hull cannot leave before now to catch up.
      waits.set(id, Math.max(0, Math.round(w + err)));
    }
    // A delayed hull can end up arriving LATER than the pace-setter if
    // the destination ran away from it. Let the target grow to the real
    // slowest rather than leaving that hull permanently behind the
    // formation it is supposed to be part of.
    let latest = target;
    for (const [id, w] of waits) {
      const a = arriveAt(id, w);
      if (a != null && a > latest) latest = a;
    }
    if (latest > target) { target = latest; continue; }
    if (worst <= tolerance) break;
  }
  return waits;
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
