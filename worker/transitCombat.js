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

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);

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
 * Chord of a circle of radius `range` at perpendicular offset `dMin`,
 * divided by how fast the pair is closing through it. This is the term
 * that keeps a head-on pass hard: perfect aim, almost no time to use it.
 *
 * At |w| = 0 the pair is station-keeping relative to each other and never
 * leaves the envelope, so exposure is total.
 */
export function exposure(dv, dMin, range) {
  if (!(range > 0)) return 0;
  if (dv < EPS) return 1;                       // relative rest: always in range
  const half = range * range - dMin * dMin;
  if (half <= 0) return 0;                      // never actually inside
  return Math.min(1, 2 * Math.sqrt(half) / dv);
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
  const f = exposure(dv, dMin, range);
  const p = hitChance(attacker.speed, defender.speed, k, f, opts.floor);
  return { engaged: true, dMin, dv, tStar, wT, k, f, p };
}
