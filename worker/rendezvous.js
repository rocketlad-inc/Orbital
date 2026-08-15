// ============================================================
// Rendezvous — meeting a moving ship, not a place.
//
// DESIGN-transit-combat.md, "the missing order", steps 2 and 3. The
// ordinary planner solves "arrive at a moving POINT": it matches
// position and nothing else. Meeting a SHIP means matching position AND
// velocity, so the two hulls are still together the tick after they
// touch — and under R3 that is the only kind of meeting worth having,
// because a crossing at high relative speed is the shot nobody lands.
//
// THE SHAPE: burn, coast, burn. One arc to set up the approach, one to
// kill the remaining relative velocity. It is the honest generalisation
// of the flip-and-burn every other transfer in this game flies — that is
// this same manoeuvre with the second arc exactly opposite the first,
// against a target sitting still.
//
//   v(T) = v0 + A + B
//   p(T) = p0 + v0·T + A·(T − t1/2) + B·(t2/2)
//
// A and B are the two burns as Δv VECTORS; their durations fall out of
// the engine, t = |Δv|/accel. Four scalar equations, four unknowns, for
// any fixed meeting time T. Substituting B = Δv − A leaves a 2×2 that
// Newton solves in a few dozen iterations.
//
// WHAT ACTUALLY GATES THIS, measured rather than assumed: the target's
// speed AT THE MEETING POINT, divided by your acceleration. That is how
// many ticks of burn you must spend, and it has nothing to do with the
// distance involved or the target's peak speed. Because a
// brachistochrone is slow at both ends and fast only in the middle,
// EVERY trip is matchable near its start or its end however long it is —
// a 3800-unit Pluto run peaks at 317 u/t (12 ticks of burn, hopeless)
// but is doing 27 u/t in its first tick and its last.
//
// The corollary, learned the embarrassing way: a STERN CHASE — launching
// after someone who is accelerating away — is close to impossible, and
// it is easy to sample only that case and conclude the whole feature is
// dead. It is not. Meeting something that is coming toward you, or
// braking into its destination, is comfortable.
// ============================================================

const EPS = 1e-9;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);

/**
 * Residual of the two-burn system for a candidate first burn `A` at a
 * fixed meeting time `T`. Zero when the manoeuvre lands exactly on the
 * target's position carrying its velocity.
 *
 * B is not free: the velocity equation pins it to Δv − A, leaving only
 * the position equation to solve.
 */
function residual(A, dv, dp, T, accel) {
  const B = sub(dv, A);
  const t1 = len(A) / accel;
  const t2 = len(B) / accel;
  const got = add(mul(A, T - t1 / 2), mul(B, t2 / 2));
  return { r: sub(got, dp), t1, t2, B };
}

/**
 * Solve the two-burn manoeuvre for a FIXED meeting time. Returns null
 * when Newton fails or the burns cannot fit inside the window — asking
 * the engine to thrust for longer than the trip lasts is not a
 * manoeuvre, it is an infeasible answer wearing one's clothes.
 */
export function solveAtTime(p0, v0, targetPos, targetVel, T, accel) {
  if (!(T > EPS) || !(accel > 0)) return null;
  const dv = sub(targetVel, v0);
  const dp = sub(sub(targetPos, p0), mul(v0, T));

  // Seed: split the velocity change evenly. Against a target at rest
  // that is very close to the flip-and-burn answer, which is the case
  // the rest of the game already flies — so common geometries start near
  // home and converge in a handful of steps.
  let A = mul(dv, 0.5);

  for (let iter = 0; iter < 80; iter++) {
    const f0 = residual(A, dv, dp, T, accel);
    if (len(f0.r) < 1e-6) {
      const { t1, t2 } = f0;
      if (t1 + t2 > T + 1e-6) return null;
      return { A: { ...A }, B: { ...f0.B }, t1, t2, T };
    }
    // Numerical Jacobian. The analytic one exists but carries |A| and
    // |Δv − A| through a quotient rule twice; this is called a few dozen
    // times per candidate, nowhere near hot enough to justify the
    // transcription risk.
    const h = Math.max(1e-6, len(dv) * 1e-6);
    const fx = residual({ x: A.x + h, y: A.y }, dv, dp, T, accel).r;
    const fy = residual({ x: A.x, y: A.y + h }, dv, dp, T, accel).r;
    const j11 = (fx.x - f0.r.x) / h, j12 = (fy.x - f0.r.x) / h;
    const j21 = (fx.y - f0.r.y) / h, j22 = (fy.y - f0.r.y) / h;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) return null;
    const dx = (f0.r.x * j22 - f0.r.y * j12) / det;
    const dy = (f0.r.y * j11 - f0.r.x * j21) / det;
    // Damped — the |A| terms make the residual non-smooth near A = 0 and
    // an undamped step oscillates across it.
    A = { x: A.x - dx * 0.8, y: A.y - dy * 0.8 };
    if (!Number.isFinite(A.x) || !Number.isFinite(A.y)) return null;
  }
  return null;
}

/**
 * Find the EARLIEST feasible rendezvous with a moving target.
 *
 * @param stateAt    (tick) -> { pos, vel } for the target. In production
 *                   this is their stored launch plan run through
 *                   torchStateAt, so we solve against the SERVER's arc —
 *                   the one thing every client agrees on.
 * @param latestTick their own arrival. Meeting them after they park is
 *                   not a rendezvous, and step 1 of this feature already
 *                   does that better.
 *
 * Earliest rather than cheapest: fuel left this game's economy, so the
 * only currency is time, and meeting sooner means more of the flight
 * spent together — which is the entire point of matching.
 */
export function solveRendezvous(p0, v0, accel, stateAt, startTick, latestTick, samples = 32) {
  const span = latestTick - startTick;
  if (!(span > EPS) || !(accel > 0)) return null;

  // Scan coarse-to-fine rather than bisecting: feasibility is NOT
  // monotone in T. A target braking hard is easier to match later than
  // earlier, so a bisection can walk away from a solution a scan walks
  // into.
  let best = null;
  for (let i = 1; i <= samples; i++) {
    const T = span * (i / samples);
    const st = stateAt(startTick + T);
    if (!st) continue;
    const sol = solveAtTime(p0, v0, st.pos, st.vel, T, accel);
    if (sol) { best = { ...sol, meetTick: startTick + T }; break; }
  }
  if (!best) return null;

  // Refine backwards so the answer is not an artefact of sample spacing.
  const step = span / samples;
  let lo = Math.max(EPS, best.T - step);
  let hi = best.T;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const st = stateAt(startTick + mid);
    const sol = st ? solveAtTime(p0, v0, st.pos, st.vel, mid, accel) : null;
    if (sol) { best = { ...sol, meetTick: startTick + mid }; hi = mid; }
    else lo = mid;
  }
  return best;
}

/**
 * Where a hull flying a rendezvous arc is at `t`.
 *
 * Burn A from the start, coast, burn B so it ends exactly at the
 * meeting. Past the meeting there is nothing to integrate: the two
 * states are identical by construction, so the follower simply IS the
 * ship it joined from then on. That is what holds Δv at zero for the
 * rest of the flight instead of letting them drift apart one tick after
 * they touch.
 */
export function rendezvousStateAt(plan, t, followedStateAt) {
  const { p0, v0, accel, A, B, startTick, meetTick } = plan;
  if (t <= startTick) return { pos: { ...p0 }, vel: { ...v0 } };

  if (t >= meetTick) {
    const followed = followedStateAt ? followedStateAt(t) : null;
    if (followed) return followed;
    // Nothing to follow — the ship we joined was destroyed, or arrived.
    // Hold the matched state rather than invent motion for it.
    t = meetTick;
  }

  const t1 = len(A) / accel;
  const t2 = len(B) / accel;
  const T = meetTick - startTick;
  const e = Math.min(t, meetTick) - startTick;
  const brakeStart = T - t2;

  let pos = { ...p0 };
  let vel = { ...v0 };

  const b1 = Math.min(e, t1);
  if (b1 > 0) {
    const aDir = t1 > EPS ? mul(A, 1 / (accel * t1)) : { x: 0, y: 0 };
    pos = add(pos, add(mul(vel, b1), mul(aDir, 0.5 * accel * b1 * b1)));
    vel = add(vel, mul(aDir, accel * b1));
  }
  const c = Math.max(0, Math.min(e, brakeStart) - t1);
  if (c > 0) pos = add(pos, mul(vel, c));
  const b2 = Math.max(0, e - brakeStart);
  if (b2 > 0) {
    const bDir = t2 > EPS ? mul(B, 1 / (accel * t2)) : { x: 0, y: 0 };
    pos = add(pos, add(mul(vel, b2), mul(bDir, 0.5 * accel * b2 * b2)));
    vel = add(vel, mul(bDir, accel * b2));
  }
  return { pos, vel };
}
