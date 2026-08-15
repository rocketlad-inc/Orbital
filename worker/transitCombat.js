// ============================================================
// Transit combat — the arithmetic, with no database attached.
//
// Everything here is a pure function of numbers so the tick, the balance
// sim and the tests can all call it the same way. See
// DESIGN-transit-combat.md; the rules referenced below (R2/R3/R4) are
// that document's.
//
// THE ONE IDEA. Being hard to hit is two unrelated things, and the first
// draft of this design collapsed them into one:
//
//   AIM       — how fast the target sweeps ACROSS your sights. Only the
//               crossing (tangential) part of relative motion does this.
//               Something closing straight at you is boresighted: it sits
//               still in the reticle and grows.
//   EXPOSURE  — how much of the tick it was inside your range at all.
//               A contact crossing at 380 units/tick clears a 12-unit
//               envelope in 6% of a tick.
//
// Using total relative speed for both is why transit combat could only
// ever be a penalty: one input that only grows. Split them and the
// geometry starts mattering — a radial departure and a beam pass at the
// same speed differ by 45 percentage points.
// ============================================================

/** Reference crossing rate, units/tick. The scale on which sideways
 *  motion starts to matter.
 *
 *  MUST BE RECALIBRATED BEFORE STAGE 2. The value 45 was derived against
 *  TOTAL relative speed in the superseded model; against the crossing
 *  component alone it means something different. It is carried over as a
 *  starting point, not as a tuned number, and stage-1 telemetry is what
 *  replaces it. Host-tunable via `transit_evasion_v_ref`. */
export const V_REF = 45;

/** Floor on the AIM probability, applied before exposure scales it.
 *
 *  A mechanic that fires at 0.4% is a mechanic that does nothing. This
 *  floors the aimed shot at 1-in-20 and then lets exposure cut it
 *  honestly — so you never get a 5% shot at something you were in range
 *  of for 6% of a tick.
 *
 *  Footprint: at the parked, departure and moon-hop regimes this changes
 *  exactly ONE cell of the 15-cell hit matrix (destroyer->corvette). It
 *  only really engages in deep cruise, where the values it flattens
 *  (0.4% / 1.1% / 3.0%) were noise anyway. */
export const AIM_FLOOR = 0.05;

/** Weapon reach per hull, world units. Bigger gun, longer arm; the
 *  corvette's edge is that it can CLOSE, not that it can reach.
 *
 *  Unarmed hulls are 0: they never initiate. They remain perfectly
 *  targetable. Stations are absent on purpose — the defensive-umbrella
 *  stage was cut, so a settlement never initiates at range.
 *
 *  KEEP IN SYNC with SHIP_COMBAT_STATS in worker/factions.js. */
export const SHIP_RANGE = {
  corvette: 12,
  frigate: 16,
  destroyer: 20,
  freighter: 0,
  colony: 0,
};

/** Below this separation two points are treated as co-located and the
 *  line of sight between them is undefined. Guards the normalisation in
 *  crossingComponent — and the case is real, not theoretical: a ship
 *  departing a body an enemy is parked at starts the tick at essentially
 *  zero separation. */
const EPS = 1e-9;

/** Occlusion radius multiplier — mirrors OCCLUSION_FACTOR in
 *  src/game/visibility.ts, which pads a body a little for atmosphere and
 *  grazing shots. Sensors and guns must agree about what a planet blocks
 *  or you get a target you can see and cannot shoot. */
export const OCCLUSION_FACTOR = 1.1;

/**
 * Does the segment A→B pass through the disk of radius r at C?
 * Verbatim mirror of segmentIntersectsDisk in src/game/visibility.ts.
 */
export function segmentIntersectsDisk(a, b, c, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    const d2 = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
    return d2 < r * r;
  }
  let t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const d2 = (px - c.x) ** 2 + (py - c.y) ** 2;
  return d2 < r * r;
}

/**
 * R4 — line of sight between two points, given bodies that can block it.
 *
 * `bodies` is [{ x, y, radius }] already positioned for this tick. A body
 * the shooter or target is sitting AT does not block them: the pad from
 * OCCLUSION_FACTOR would otherwise have every parked hull unable to shoot
 * anything, including across its own orbit.
 */
export function hasLineOfSight(from, to, bodies) {
  for (const b of bodies) {
    const r = (b.radius ?? 0) * OCCLUSION_FACTOR;
    if (r <= 0) continue;
    // Skip the body either party is effectively standing on.
    const dFrom = Math.hypot(from.x - b.x, from.y - b.y);
    const dTo = Math.hypot(to.x - b.x, to.y - b.y);
    if (dFrom <= r || dTo <= r) continue;
    if (segmentIntersectsDisk(from, to, b, r)) return false;
  }
  return true;
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);

// ============================================================
// Where a ship in flight actually is.
//
// PORT, NOT A REDERIVATION. This mirrors singleStepTorch /
// stepTorchShip in src/physics/torchTransfer.ts step for step: same
// 1-tick substep, same midpoint thrust decision, same re-aim at the
// intercept during boost, same brake-against-velocity-relative-to-the-
// target, same arrival snap. Both sides run this algorithm over the
// SAME launch plan (migration 0088), which is the entire point — the
// server must not shoot from a point the client never drew.
//
// If you change one, change the other. A divergence here is invisible
// in every test that checks the two independently and shows up only as
// a hull taking damage from empty space.
// ============================================================

/** Matches MAX_SUBSTEP in src/physics/torchTransfer.ts. */
const MAX_SUBSTEP = 1;

/**
 * @param plan {launchX, launchY, launchVx, launchVy, accel, flipTick,
 *              startTick, arriveTick, interceptX, interceptY, targetBodyId}
 * @param bodyVelAt (bodyId, t) -> {x, y}, for the brake phase
 * @param t target tick
 */
export function torchStateAt(plan, bodyVelAt, t) {
  const pos = { x: plan.launchX, y: plan.launchY };
  const vel = { x: plan.launchVx, y: plan.launchVy };
  const end = Math.min(t, plan.arriveTick);
  let cur = plan.startTick;
  // Pre-launch: the ship is still parked. Callers gate on 'in_transit'
  // so this is defensive, but a coast is the honest answer.
  if (end <= cur) return { pos, vel };

  let guard = 0;
  while (cur < end - 1e-9) {
    // 10k substeps is ~10k ticks of transit; nothing in the game is
    // that long, so hitting this means a corrupt plan, not a long trip.
    if (++guard > 10000) break;
    const step = Math.min(MAX_SUBSTEP, end - cur);
    const midTick = cur + step / 2;
    const boosting = midTick < plan.flipTick;

    let tx = 0, ty = 0;
    if (boosting) {
      // Re-aimed at the intercept every substep — this is what curls the
      // path against the velocity inherited from the parking orbit.
      const dx = plan.interceptX - pos.x;
      const dy = plan.interceptY - pos.y;
      const d = Math.hypot(dx, dy);
      if (d >= 1e-9) { tx = dx / d; ty = dy / d; }
    } else {
      // Brake against velocity RELATIVE TO THE TARGET BODY, so the ship
      // arrives matching the target's motion rather than dead in space.
      const tv = bodyVelAt(plan.targetBodyId, midTick);
      const rvx = vel.x - tv.x;
      const rvy = vel.y - tv.y;
      const rv = Math.hypot(rvx, rvy);
      if (rv >= 1e-9) { tx = -rvx / rv; ty = -rvy / rv; }
    }

    const ax = tx * plan.accel;
    const ay = ty * plan.accel;
    pos.x += vel.x * step + 0.5 * ax * step * step;
    pos.y += vel.y * step + 0.5 * ay * step * step;
    vel.x += ax * step;
    vel.y += ay * step;
    cur += step;
  }

  // Arrival snap — pinned to the intercept carrying the target's own
  // velocity, exactly as the client does, so the handoff to a parked
  // orbit doesn't jump.
  if (end >= plan.arriveTick - 1e-9) {
    const tv = bodyVelAt(plan.targetBodyId, plan.arriveTick);
    return { pos: { x: plan.interceptX, y: plan.interceptY }, vel: { x: tv.x, y: tv.y } };
  }
  return { pos, vel };
}

/**
 * Closest approach between two segments over one tick (R2).
 *
 * Each combatant contributes where it is at tick start and where it is at
 * tick end. Straight segments are honest at this resolution: the torch
 * simulator already substeps at MAX_SUBSTEP = 1 tick, so one line per
 * tick is exactly the fidelity the simulation itself runs at.
 *
 * CLOSEST APPROACH, NOT DISTANCE-AT-AN-INSTANT, and this is not a
 * nicety. At 0.05 g a Titan->Enceladus hop peaks at 42 units/tick against
 * a 67-unit separation: two ships closing head-on cover more than half
 * the gap within a single tick. Sampling once per tick would miss most
 * crossings outright — bullet-through-paper. Solving for t* costs eight
 * multiplies and fixes it exactly.
 *
 * Returns r0 and w as well, because callers need them for the crossing
 * decomposition and recomputing them is how the two drift apart.
 */
export function closestApproach(a0, a1, b0, b1) {
  const r0 = sub(a0, b0);                       // separation at tick start
  const w = sub(sub(a1, a0), sub(b1, b0));      // relative motion over the tick
  const ww = dot(w, w);
  // ww === 0 is parallel travel at identical velocity — including the
  // commonest case in the game, two hulls parked at the same body. There
  // is no distinguished moment of closest approach, so take tick start.
  const tStar = ww < EPS ? 0 : Math.min(1, Math.max(0, -dot(r0, w) / ww));
  const dMin = len({ x: r0.x + tStar * w.x, y: r0.y + tStar * w.y });
  return { dMin, dv: Math.sqrt(ww), tStar, r0, w };
}

/**
 * The crossing (tangential) component of relative motion — the part that
 * actually makes a target hard to hit (R3).
 *
 * EVALUATED AT TICK START, OFF r0. NEVER AT CLOSEST APPROACH.
 *
 * At t* the separation is perpendicular to the relative velocity *by
 * definition* — that is what closest approach means (d/dt |r|^2 = 0
 * implies r . w = 0). Decompose there and every input returns w_t = |w|,
 * silently restoring the total-relative-speed model this replaces, with
 * every number still looking plausible. There is a test asserting exactly
 * this; if it fails, someone has moved the evaluation point.
 *
 * When the two start co-located the line of sight is undefined and the
 * motion is purely separation — radial by construction — so the crossing
 * component is zero. That is the parting-shot case and it is why a
 * fleeing ship gets shot at good odds rather than poor ones.
 */
export function crossingComponent(r0, w) {
  const d = len(r0);
  if (d < EPS) return 0;
  const ux = r0.x / d, uy = r0.y / d;
  const radial = w.x * ux + w.y * uy;           // closing (-) / opening (+)
  return len({ x: w.x - radial * ux, y: w.y - radial * uy });
}

/**
 * Aim penalty from crossing rate (R3). 1.0 = no penalty.
 *
 * Multiplies the DEFENDER's speed in the hit roll, so a mutual
 * engagement gets harder for both sides as the crossing rate rises —
 * which is the physical truth (you are both trying to track something
 * sliding across your sights) without inventing a second probability
 * multiplier.
 */
export function aimFactor(wT, vRef = V_REF) {
  return 1 + Math.max(0, wT) / (vRef > 0 ? vRef : V_REF);
}

/**
 * Fraction of the tick the target spent inside `range` (R3).
 *
 * Solved EXACTLY, as the overlap of the relative segment with the disk:
 * the set of t in [0,1] where |r0 + t·w| <= range. That is a quadratic,
 * and clamping its roots to the tick is what makes the partial cases
 * right.
 *
 * The obvious shortcut — chord length over speed, 2*sqrt(R^2 - dMin^2)/|w|
 * — is what this replaced, and it is wrong at exactly the moment the
 * mechanic exists for. It assumes the target ENTERS and EXITS the
 * envelope. A ship launching from a body the shooter is parked at starts
 * at the centre and only ever traverses the second half, so the chord
 * formula reported f = 1.00 ("never left") where the truth is 0.905 —
 * handing a fleeing hull's attacker a free upgrade from the design's
 * 63.8% parting shot to a full point-blank 70.5%.
 *
 * At |w| = 0 the pair is station-keeping relative to each other, so the
 * answer is simply whether they are within range at all.
 */
export function exposure(r0, w, range) {
  if (!(range > 0)) return 0;
  const a = w.x * w.x + w.y * w.y;
  const c = r0.x * r0.x + r0.y * r0.y - range * range;
  if (a < EPS) return c <= 0 ? 1 : 0;           // relative rest
  const b = 2 * (r0.x * w.x + r0.y * w.y);
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;                      // never inside the envelope
  const s = Math.sqrt(disc);
  const tEnter = Math.max(0, (-b - s) / (2 * a));
  const tExit = Math.min(1, (-b + s) / (2 * a));
  return Math.max(0, tExit - tEnter);
}

/**
 * The hit roll (R3), unchanged from DESIGN-combat-v2 except for the two
 * new terms.
 *
 * SPEED_CAP MUST NOT CLAMP defEff. The 1.176 cap bounds *design-time*
 * agility bought from engine parts. Clamping the product instead would
 * mean a fleeing freighter gained almost nothing and the whole mechanic
 * quietly did nothing. Cap the stat; never cap the product.
 *
 * The floor lands on the AIMED shot and exposure scales it afterwards,
 * in that order — flooring the final probability would hand out 5% shots
 * on contacts that were barely in range.
 */
export function hitChance(atkSpeed, defSpeed, k, f, floor = AIM_FLOOR) {
  const a2 = atkSpeed * atkSpeed;
  const d2 = (defSpeed * k) * (defSpeed * k);
  const aimed = a2 + d2 <= 0 ? 0 : a2 / (a2 + d2);
  return Math.max(floor, aimed) * f;
}

/**
 * The whole engagement in one call, for the tick and the sim.
 *
 * `sees` is the caller's line-of-sight result (R4) — passed in rather
 * than computed here because occlusion needs the body list and this
 * module deliberately owns no world state. False means no engagement at
 * all: not a reduced chance, no roll, and therefore no tracer to leak the
 * target's position through the fog.
 */
export function engagement(attacker, defender, opts = {}) {
  const range = opts.range ?? SHIP_RANGE[attacker.shipClass] ?? 0;
  const { dMin, dv, tStar, r0, w } = closestApproach(
    attacker.p0, attacker.p1, defender.p0, defender.p1,
  );
  const inRange = range > 0 && dMin <= range;
  const sees = opts.sees !== false;
  if (!inRange || !sees) {
    return { engaged: false, dMin, dv, tStar, wT: 0, k: 1, f: 0, p: 0 };
  }
  const wT = crossingComponent(r0, w);
  const k = aimFactor(wT, opts.vRef);
  const f = exposure(r0, w, range);
  const p = hitChance(attacker.speed, defender.speed, k, f, opts.floor);
  return { engaged: true, dMin, dv, tStar, wT, k, f, p };
}
