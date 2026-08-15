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
function solveAtTime(p0, v0, targetPos, targetVel, T, accel, allowInfeasible = false) {
  if (!(T > EPS) || !(accel > 0)) return null;
  const dv = sub(targetVel, v0);
  const dp = sub(sub(targetPos, p0), mul(v0, T));

  // MULTI-START, because one seed is not enough and the failure is
  // invisible without measuring it.
  //
  // The residual carries |A| and |Δv − A|, so it has kinks where either
  // burn vanishes and a Jacobian that goes singular near them. Seeded
  // only at Δv/2, Newton converged on barely a third of candidate meet
  // times across a real interplanetary geometry — every other sample
  // came back "singular" or "hit the iteration cap", which the caller
  // could not distinguish from "no rendezvous exists here".
  //
  // That is how this solver ended up reporting whole classes of
  // interception as impossible when they were not: not bad arithmetic,
  // and not a coarse scan, but one starting guess in a landscape with
  // several basins.
  //
  // Seeds span the plausible shapes: split the burn evenly, put it all
  // in one arc or the other, and aim the first arc at the position error
  // (which is what the manoeuvre looks like when the target is barely
  // moving). Perpendicular variants break symmetry when the direct ones
  // land exactly on a kink.
  const dpLen = len(dp);
  const along = dpLen > EPS ? mul(dp, len(dv) / dpLen) : { x: 0, y: 0 };
  const perp = { x: -along.y, y: along.x };
  const seeds = [
    mul(dv, 0.5), mul(dv, 1), mul(dv, 0.25), mul(dv, 0.75),
    along, add(mul(dv, 0.5), mul(along, 0.5)),
    add(mul(dv, 0.5), mul(perp, 0.25)), sub(mul(dv, 0.5), mul(perp, 0.25)),
  ];
  let fallback = null;
  for (const seed of seeds) {
    const got = newtonFrom(seed, dv, dp, T, accel, allowInfeasible);
    if (!got) continue;
    if (got.slack >= -1e-6) return got;      // feasible: done
    // Infeasible but converged — keep the roomiest one so the caller
    // still gets a slack reading to steer by.
    if (allowInfeasible && (!fallback || got.slack > fallback.slack)) fallback = got;
  }
  return fallback;
}

/** One Newton run from one seed. Split out so the multi-start above
 *  reads as the policy it is, rather than being buried in a loop. */
function newtonFrom(seed, dv, dp, T, accel, allowInfeasible) {
  let A = { x: seed.x, y: seed.y };

  for (let iter = 0; iter < 60; iter++) {
    const f0 = residual(A, dv, dp, T, accel);
    if (len(f0.r) < 1e-7) {
      const { t1, t2 } = f0;
      // SLACK is how much of the window is left over after both burns.
      // Negative means the engine is being asked to thrust for longer
      // than the trip lasts — infeasible, but by a MEASURABLE amount,
      // and that measurement is what lets the caller tell "nowhere near"
      // from "just barely missed" and go looking nearby.
      const slack = T - (t1 + t2);
      if (slack < -1e-6 && !allowInfeasible) return null;
      return { A: { ...A }, B: { ...f0.B }, t1, t2, T, slack };
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
    let det = j11 * j22 - j12 * j21;
    // A singular Jacobian means this STEP has no unique solution, not
    // that the problem has none. Nudge along the diagonal and carry on;
    // bailing here was throwing away meet times that a different seed
    // (or the very next iterate) resolves cleanly.
    if (Math.abs(det) < 1e-12) {
      const eps = 1e-9 * (1 + Math.abs(j11) + Math.abs(j22));
      det = (j11 + eps) * (j22 + eps) - j12 * j21;
      if (Math.abs(det) < 1e-15) return null;
    }
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

  // SCAN ON SLACK, NOT ON YES/NO.
  //
  // The first version of this asked each sample "is this feasible?" and
  // took the first yes. That is a search over a boolean, and it stepped
  // straight over feasibility windows narrower than the sample spacing —
  // measurably: a 24-sample scan across a 14-tick haul reported "no
  // rendezvous exists" for a geometry where a 2000-sample scan found one.
  // The arithmetic was right the whole time and the answer was still
  // wrong, which is the worst way for a solver to be wrong.
  //
  // Slack (window minus total burn time) is continuous and peaks where
  // the manoeuvre is most comfortable, so scanning it turns "did I
  // happen to land on a feasible sample" into "where is this closest to
  // working" — and then the refinement below only has to walk downhill.
  const step = span / samples;
  const probe = (T) => {
    const st = stateAt(startTick + T);
    if (!st) return null;
    // FAST REJECT before Newton. Matching a target means ending on its
    // velocity, and building that difference takes at least
    // |Δv| / accel ticks of thrust no matter how the burns are arranged
    // or where anything is. If that alone overruns the window, no pair
    // of arcs can fit and there is nothing for a 60-iteration multi-start
    // to discover.
    //
    // This is most of the cost, because most candidates are hopeless:
    // the expensive path is not finding an answer, it is exhaustively
    // failing to. One subtraction and a hypot skips it.
    const need = Math.hypot(st.vel.x - v0.x, st.vel.y - v0.y) / accel;
    if (need > T + 1e-9) return null;
    return solveAtTime(p0, v0, st.pos, st.vel, T, accel, true);
  };

  // THE DEADLINE END GETS PROBED EXPLICITLY.
  //
  // Feasibility clusters against `latestTick`, and for a good reason: a
  // brachistochrone is slowest as it brakes into its destination, so the
  // velocity you have to match is smallest right at the end. Measured on
  // a real interplanetary haul, the only feasible window was the last
  // 0.16 ticks — against a uniform step of 0.59. A uniform scan steps
  // clean over it and reports "no rendezvous exists", which is the one
  // answer a solver must never give wrongly.
  //
  // These are catch-it-as-it-docks solutions and MEET AT DESTINATION
  // serves that case better, but "the good answer is elsewhere" is the
  // caller's judgement to make, not the solver's to make by omission.
  const marks = [];
  for (let i = 1; i <= samples; i++) {
    const T = span * (i / samples);
    const sol = probe(T);
    if (sol) marks.push({ T, slack: sol.slack, sol });
  }
  for (const f of [0.98, 0.99, 0.995, 0.999, 1]) {
    const T = span * f;
    const sol = probe(T);
    if (sol) marks.push({ T, slack: sol.slack, sol });
  }
  marks.sort((x, y) => x.T - y.T);
  if (marks.length === 0) return null;

  // Every local maximum of slack is a candidate window — including ones
  // that are still negative at the sample points but might cross zero
  // between them. Earliest first, because meeting sooner means more of
  // the flight spent together.
  const peaks = [];
  for (let i = 0; i < marks.length; i++) {
    const prev = marks[i - 1], next = marks[i + 1];
    const isPeak = (!prev || marks[i].slack >= prev.slack)
      && (!next || marks[i].slack >= next.slack);
    if (isPeak || marks[i].slack >= 0) peaks.push(marks[i]);
  }

  let best = null;
  for (const peak of peaks) {
    // Golden-ish refinement around the peak: sample the bracket finely
    // enough to catch a window the coarse pass could only hint at.
    const lo = Math.max(EPS, peak.T - step);
    const hi = Math.min(span, peak.T + step);
    for (let i = 0; i <= 24; i++) {
      const T = lo + (hi - lo) * (i / 24);
      const sol = probe(T);
      if (sol && sol.slack >= -1e-6) {
        const cand = { ...sol, meetTick: startTick + T };
        if (!best || cand.meetTick < best.meetTick) best = cand;
        break;                       // earliest inside this bracket
      }
    }
    // A feasible window earlier than this peak can't be beaten by a
    // later one, so stop hunting once we have one before the next peak.
    if (best && best.T <= peak.T) break;
  }
  if (!best) return null;

  // Walk the found solution back toward the earliest feasible instant,
  // so the answer isn't an artefact of where the bracket happened to
  // start.
  let lo = Math.max(EPS, best.T - step);
  let hi = best.T;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const sol = probe(mid);
    if (sol && sol.slack >= -1e-6) { best = { ...sol, meetTick: startTick + mid }; hi = mid; }
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
