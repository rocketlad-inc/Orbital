// ============================================================
// Rendezvous — meeting a moving ship, not a place.
//
// DESIGN-transit-combat.md, "the missing order", step 2. The existing
// planner solves "arrive at a moving POINT": it matches position and
// nothing else. Meeting a ship means matching position AND velocity, so
// that the two hulls are still together the tick after they touch — and
// under R3 that is also the only kind of meeting worth having, because a
// crossing at high relative speed is the shot nobody lands.
//
// THE SHAPE: burn, coast, burn. One arc at the start to set up the
// approach, one at the end to kill the remaining relative velocity. It
// is the honest generalisation of the flip-and-burn every other transfer
// in this game flies — that is this same manoeuvre with the second arc
// exactly opposite the first, against a target sitting still.
//
//   v(T) = v0 + A + B
//   p(T) = p0 + v0·T + A·(T − t1/2) + B·(t2/2)
//
// where A and B are the two burns as Δv VECTORS, and their durations
// fall out of the engine: t1 = |A|/a, t2 = |B|/a. Four scalar equations,
// four unknowns (A and B), for any fixed meeting time T. Substituting
// B = Δv − A reduces it to a 2×2 solved by Newton.
//
// WHY THE SOLVER FAILING IS A FEATURE. There is no rule here that says
// interception should be hard. It just is: for most geometries there is
// no pair of burns that closes both the position and the velocity gap
// before the target reaches its destination, and the search returns
// null. "Possible but not easy" comes out of the arithmetic rather than
// out of a balance knob somebody has to tune.
// ============================================================

const EPS = 1e-9;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);

/**
 * Residual of the two-burn system for a candidate first burn `A`, at a
 * fixed meeting time `T`. Zero when the manoeuvre lands exactly on the
 * target's position with its velocity.
 *
 * B is not a free variable: the velocity equation pins it to Δv − A, so
 * only the position equation is left to solve.
 */
function residual(A, dv, dp, T, accel) {
  const B = sub(dv, A);
  const t1 = len(A) / accel;
  const t2 = len(B) / accel;
  // p0 + v0·T + A·(T − t1/2) + B·(t2/2) − p_target  ... with dp already
  // carrying (p_target − p0 − v0·T).
  const got = add(mul(A, T - t1 / 2), mul(B, t2 / 2));
  return { r: sub(got, dp), t1, t2, B };
}

/**
 * Solve the two-burn manoeuvre for a FIXED meeting time.
 * Returns null if Newton fails to converge or the burns cannot fit
 * inside the window (t1 + t2 > T means the engine is asked to thrust for
 * longer than the trip lasts).
 */
function solveAtTime(p0, v0, targetPos, targetVel, T, accel) {
  if (!(T > EPS) || !(accel > 0)) return null;
  const dv = sub(targetVel, v0);
  const dp = sub(sub(targetPos, p0), mul(v0, T));

  // Seed: split the velocity change evenly. For a target at rest this is
  // very close to the flip-and-burn answer, which is the case the rest of
  // the game already flies, so the common geometries start near home.
  let A = mul(dv, 0.5);

  for (let iter = 0; iter < 60; iter++) {
    const f0 = residual(A, dv, dp, T, accel);
    if (len(f0.r) < 1e-7) {
      const { t1, t2 } = f0;
      // The engine cannot burn for longer than the trip.
      if (t1 + t2 > T + 1e-6) return null;
      return { A: { ...A }, B: { ...f0.B }, t1, t2, T };
    }
    // Numerical Jacobian. The analytic one exists but carries |A| and
    // |Δv − A| through a quotient rule twice, and this is called a few
    // dozen times per candidate — nowhere near hot enough to justify the
    // transcription risk.
    const h = Math.max(1e-6, len(dv) * 1e-6, 1e-6);
    const fx = residual({ x: A.x + h, y: A.y }, dv, dp, T, accel).r;
    const fy = residual({ x: A.x, y: A.y + h }, dv, dp, T, accel).r;
    const j11 = (fx.x - f0.r.x) / h, j12 = (fy.x - f0.r.x) / h;
    const j21 = (fx.y - f0.r.y) / h, j22 = (fy.y - f0.r.y) / h;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) return null;      // singular: no local fix
    const dx = (f0.r.x * j22 - f0.r.y * j12) / det;
    const dy = (f0.r.y * j11 - f0.r.x * j21) / det;
    // Damped step — the |A| terms make the residual non-smooth near
    // A = 0, and an undamped Newton oscillates across it.
    A = { x: A.x - dx * 0.8, y: A.y - dy * 0.8 };
    if (!Number.isFinite(A.x) || !Number.isFinite(A.y)) return null;
  }
  return null;
}

/**
 * Find the EARLIEST feasible rendezvous with a moving target.
 *
 * @param p0,v0      our state at `startTick`
 * @param accel      our engine, units/tick²
 * @param stateAt    (tick) -> { pos, vel } for the target. In production
 *                   this is the target's stored launch plan run through
 *                   torchStateAt, so we solve against the SERVER's arc —
 *                   the one thing everybody agrees on.
 * @param startTick  when our burn begins
 * @param latestTick hard deadline: the target's own arrival. Meeting it
 *                   after it has parked is not a rendezvous, it is a
 *                   late visit, and step 1 of this feature already does
 *                   that better.
 *
 * Earliest rather than cheapest: fuel left this game's economy, so the
 * only currency is time, and meeting sooner means more of the flight
 * spent together — which is the entire point of matching in the first
 * place.
 */
export function solveRendezvous(p0, v0, accel, stateAt, startTick, latestTick, samples = 24) {
  const span = latestTick - startTick;
  if (!(span > EPS) || !(accel > 0)) return null;

  // Scan coarse-to-fine rather than bisecting: feasibility is not
  // monotone in T (a target that is braking hard can be easier to match
  // LATER than earlier), so a bisection can walk away from a solution
  // that a scan walks into.
  let best = null;
  for (let i = 1; i <= samples; i++) {
    const T = span * (i / samples);
    const st = stateAt(startTick + T);
    if (!st) continue;
    const sol = solveAtTime(p0, v0, st.pos, st.vel, T, accel);
    if (sol) { best = { ...sol, meetTick: startTick + T }; break; }
  }
  if (!best) return null;

  // Refine backwards: having found a feasible T, walk down for an
  // earlier one so the answer is not an artefact of the sample spacing.
  const step = span / samples;
  let lo = Math.max(EPS, best.T - step);
  let hi = best.T;
  for (let i = 0; i < 12; i++) {
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
 * Burn A from the start, coast, burn B so that it ends exactly at the
 * meeting. Past the meeting there is nothing to integrate: the two
 * states are identical by construction, so the follower simply IS the
 * target from then on — which is what holds Δv at 0 for the rest of the
 * flight instead of letting them drift apart after one tick.
 */
export function rendezvousStateAt(plan, t, followedStateAt) {
  const { p0, v0, accel, A, B, startTick, meetTick } = plan;
  if (t <= startTick) return { pos: { ...p0 }, vel: { ...v0 } };

  if (t >= meetTick) {
    const followed = followedStateAt ? followedStateAt(t) : null;
    if (followed) return followed;
    // No plan for the ship we were following (it arrived, or we never
    // had one) — hold the matched state rather than inventing motion.
    t = meetTick;
  }

  const t1 = len(A) / accel;
  const t2 = len(B) / accel;
  const T = meetTick - startTick;
  const e = Math.min(t, meetTick) - startTick;   // elapsed since burn start
  const brakeStart = T - t2;

  let pos = { ...p0 };
  let vel = { ...v0 };

  // --- arc 1 -------------------------------------------------------
  const b1 = Math.min(e, t1);
  if (b1 > 0) {
    const aDir = t1 > EPS ? mul(A, 1 / (accel * t1)) : { x: 0, y: 0 };
    pos = add(pos, add(mul(vel, b1), mul(aDir, 0.5 * accel * b1 * b1)));
    vel = add(vel, mul(aDir, accel * b1));
  }
  // --- coast -------------------------------------------------------
  const c = Math.max(0, Math.min(e, brakeStart) - t1);
  if (c > 0) pos = add(pos, mul(vel, c));
  // --- arc 2 -------------------------------------------------------
  const b2 = Math.max(0, e - brakeStart);
  if (b2 > 0) {
    const bDir = t2 > EPS ? mul(B, 1 / (accel * t2)) : { x: 0, y: 0 };
    pos = add(pos, add(mul(vel, b2), mul(bDir, 0.5 * accel * b2 * b2)));
    vel = add(vel, mul(bDir, accel * b2));
  }
  return { pos, vel };
}
