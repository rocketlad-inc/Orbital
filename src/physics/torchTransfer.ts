// ============================================================
// Torch Transfer — production constant-thrust simulation
// ============================================================
//
// Production-grade port of `src/torchSandbox/torchPhysics.ts`. The
// sandbox uses a statically-imported `BODIES` constant; this module
// takes the bodies array as a parameter so it works against the live
// game state, which can mutate bodies (ownership, settlements, etc.)
// without affecting the orbital math.
//
// Model: ship under constant acceleration `a` aimed at a moving
// target. Boost phase: thrust toward predicted intercept. Flip:
// thrust reverses to retrograde (relative to ship velocity). Brake
// phase: cancels velocity so the ship arrives at-rest in the target
// body's frame. Final step (orbit insertion) is handled by the game
// loop, not this math module — see Phase 1 of the migration plan.
//
// Compared to the Bezier system this REPLACES:
//   - precomputed cubic-Bezier curves   → integrated state-vector path
//   - Hohmann-derived arrival tick      → emergent arrival from sim
//   - ship.orbit during transit         → ship.transit.{pos,vel}
//   - departureDv / arrivalDv at start  → continuous fuel drain per tick
//
// Symmetric and asymmetric brachistochrone are both supported (same
// math the sandbox uses) — for the production engine we'll use a
// symmetric profile keyed off faction research engine-g for v1.
//
// Travel-time formula (symmetric):  T = 2·√(d / a)
// (Asymmetric: t1 = √(2·d·brake / (boost·(boost+brake))), T = t1·(1+boost/brake))

import { bodyPosition, bodyWorldVelocity } from './orbitalMechanics';
import type { Body } from '../types';

export interface Vec2 { x: number; y: number }

/** A planned or active torch transfer. */
export interface TorchTransfer {
  /** Body the ship is flying toward. */
  targetBodyId: string;
  /** Boost-phase acceleration, game-units per tick². */
  acceleration: number;
  /** Brake-phase acceleration. Equal to `acceleration` for symmetric
   *  burns (the v1 default — research-gated single engine-g per
   *  faction). Asymmetric profiles are math-supported but not exposed
   *  in the production UI yet. */
  brakeAcceleration: number;
  /** Tick the burn started (ship.transit existed from this tick). */
  startTick: number;
  /** Tick of the flip — boost ends, brake begins. For symmetric burns
   *  this is the trip-time midpoint. */
  flipTick: number;
  /** Tick the burn ends and the ship inserts into a parking orbit. */
  arriveTick: number;
  /** Held by a Gravity Sink: which one, and until when.
   *
   *  Physics does not use these — the hold is applied server-side by
   *  pushing arriveTick out. They ride along so the RENDERER can draw a
   *  tether from the sink to the hull, because a fleet that arrives
   *  eight ticks late with nothing on screen to explain it is the most
   *  confusing thing the structures can do to a player. */
  sinkBodyId?: string | null;
  sinkHeldUntilTick?: number | null;
  /** World-frame thrust direction at launch. The integrator re-aims
   *  every step toward the intercept (which is fixed); this is the
   *  initial value for renderer convenience. */
  thrustDir: Vec2;
  /** Target body's predicted position at arriveTick. The integrator's
   *  arrival snap goes here. */
  interceptPos: Vec2;
  /** Ship's heliocentric state at the moment the plan was committed.
   *  Renderer integrates from here to produce the curved-path preview;
   *  also useful for diagnostics ("the ship started here"). */
  startPos: Vec2;
  startVel: Vec2;
  /** Total Δv = a_boost·t_boost + a_brake·t_brake. Equal to 2·v_peak
   *  for any brachistochrone profile (symmetric or asymmetric). Drives
   *  fuel cost. */
  totalDv: number;
  /** Peak speed at the flip, used for diagnostics and UI readouts. */
  peakVelocity: number;
  /** Multiplayer, since 2026-10-06 (migration 0158): the push BUILDS
   *  while boosting — `acceleration` at launch, growing by accelRamp per
   *  tick up to accelMax. Absent = a flat push (single player, and every
   *  leg committed before the build-up). */
  accelRamp?: number;
  accelMax?: number;
  /** ...or, since the exponential switch (migration 0159), grows by a
   *  factor of e every accelTau ticks up to accelMax. A leg carries one
   *  of accelRamp / accelTau, never both. */
  accelTau?: number;
  /** Multiplayer only: the id of the server `game_ship_nodes` row this
   *  plan was reconstructed from. Lets the UI cancel a queued leg on the
   *  server (not just locally). Undefined for single-player and for
   *  not-yet-committed local preview legs. */
  nodeId?: string;
  /** A matched-velocity INTERCEPT rather than a plain flip-and-burn.
   *
   *  The server stores these two burns but never simulates them: a
   *  rendezvous IS a transfer to the target's destination, drawn as a
   *  burn/coast/burn arc that matches their velocity on the way. So
   *  this rides on the leg purely so the commit path can post it, and
   *  so the step list can say INTERCEPT rather than GO TO.
   *
   *  Distinct from ship.plannedRendezvous, which is ONE staged match
   *  per ship and drives the preview arc. A chained intercept is leg N
   *  of a plan, so it cannot use that slot. */
  rv?: {
    A: Vec2;
    B: Vec2;
    meetTick: number;
    followShipId: string;
  };
}

/** State-vector ship state — what a ship carries during a transit. */
export interface TorchShipState {
  pos: Vec2;
  vel: Vec2;
}

/**
 * Plan a brachistochrone transfer. Returns null if the ship is already
 * at the target, the target is unknown, or either acceleration is
 * non-positive.
 *
 * The planner is iterative: target's position depends on arrival time,
 * which depends on the distance the ship has to cover, which depends on
 * target position. Converges in 5–10 passes for realistic geometries.
 */
export function planTorchTransfer(
  ship: TorchShipState,
  targetBodyId: string,
  boostAccel: number,
  brakeAccel: number,
  currentTick: number,
  bodies: Body[],
  iterations: number = 20,
  /** Multiplayer's build-up (mpRampFor). With it the push grows from
   *  boostAccel by ramp.ramp per tick up to ramp.max, and the brake is
   *  (brakeAccel / boostAccel) x the push reached at the flip. Absent =
   *  the flat push this always planned. */
  ramp?: BurnRamp,
): TorchTransfer | null {
  if (boostAccel <= 0 || brakeAccel <= 0) return null;
  const target = bodies.find(b => b.id === targetBodyId);
  if (!target) return null;
  if (ramp && ramp.max > boostAccel && (ramp.ramp > 0 || (ramp.tau ?? 0) > 0)) {
    return planRampedTransfer(ship, target, boostAccel, brakeAccel / boostAccel, ramp, currentTick, bodies, iterations);
  }

  // Closed-form trip time for a straight-line distance d.
  const tripTime = (d: number) => {
    const t1 = Math.sqrt(2 * d * brakeAccel / (boostAccel * (boostAccel + brakeAccel)));
    const t2 = (boostAccel * t1) / brakeAccel;
    return { T: t1 + t2, t1 };
  };

  let interceptPos = bodyPosition(target, currentTick, bodies);
  let T = 0;
  let t1 = 0;
  for (let i = 0; i < iterations; i++) {
    const dx = interceptPos.x - ship.pos.x;
    const dy = interceptPos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) return null;
    const tt = tripTime(d);
    if (Math.abs(tt.T - T) < 1e-4) { T = tt.T; t1 = tt.t1; break; }
    T = tt.T;
    t1 = tt.t1;
    interceptPos = bodyPosition(target, currentTick + T, bodies);
  }

  const dx = interceptPos.x - ship.pos.x;
  const dy = interceptPos.y - ship.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const thrustDir: Vec2 = { x: dx / d, y: dy / d };
  const vPeak = boostAccel * t1;
  const t2 = T - t1;

  return {
    targetBodyId,
    acceleration: boostAccel,
    brakeAcceleration: brakeAccel,
    startTick: currentTick,
    flipTick: currentTick + t1,
    arriveTick: currentTick + T,
    thrustDir,
    interceptPos,
    startPos: { x: ship.pos.x, y: ship.pos.y },
    startVel: { x: ship.vel.x, y: ship.vel.y },
    totalDv: boostAccel * t1 + brakeAccel * t2,
    peakVelocity: vPeak,
  };
}

// ---- The build-up (multiplayer, migration 0158) ----------------------
// MIRRORS worker/burn.js boostState / burnShape. burnParity.test.ts holds
// the two to each other.

/** How a leg's push builds: exponential (tau, ticks to grow by e) or the
 *  older linear rate (ramp, units/tick^3), and where it tops out. */
export interface BurnRamp { ramp: number; max: number; tau?: number }

/** Push, speed and distance after `tau` ticks of boosting from rest.
 *  etau > 0 is the exponential build (migration 0159), ramp > 0 the
 *  linear one (0158), neither a flat push. MIRRORS worker/burn.js. */
export function boostState(
  tau: number, a0: number, ramp = 0, max = a0, etau = 0,
): { a: number; v: number; x: number } {
  if (etau > 0 && max > a0) {
    const grow = (t: number) => {
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

function legDistance(t1: number, a0: number, ramp: number, max: number, k: number, etau = 0): number {
  const s = boostState(t1, a0, ramp, max, etau);
  return s.x + (s.v * s.v) / (2 * k * s.a);
}

/** The leg over a straight-line distance `d`: flip t1, trip T, brake,
 *  top speed. Bisection on the flip, exactly as the server solves it. */
export function burnShape(
  d: number, a0: number, ramp = 0, max = a0, k = 1, etau = 0,
): { t1: number; T: number; brake: number; vPeak: number } {
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

/** A plan's build-up, normalised: exponential (tau > 0), linear (ramp >
 *  0), or null for a flat push. The one reader every helper below uses. */
export function buildOf(p: TorchTransfer): { ramp: number; max: number; tau: number } | null {
  if (!(p.accelMax != null && p.accelMax > p.acceleration)) return null;
  if (p.accelTau != null && p.accelTau > 0) return { ramp: 0, max: p.accelMax, tau: p.accelTau };
  if (p.accelRamp != null && p.accelRamp > 0) return { ramp: p.accelRamp, max: p.accelMax, tau: 0 };
  return null;
}

/** The boosting push at tick `t`: the flat push, or wherever the leg's
 *  build has got to. */
export function pushAt(p: TorchTransfer, t: number): number {
  const b = buildOf(p);
  if (!b) return p.acceleration;
  const tau = Math.max(0, t - p.startTick);
  return b.tau > 0
    ? Math.min(b.max, p.acceleration * Math.exp(tau / b.tau))
    : Math.min(b.max, p.acceleration + b.ramp * tau);
}

// ---- Where a shaped burn is, for DRAWING ------------------------------
// The map draws every leg as a straight line (STRAIGHT_LINE_TRAJECTORIES)
// and used to slide the hull along it at one even speed, so a hull that
// builds to 1g over a long haul looked exactly as slow as a moon hop. These
// put it where its burn says: creeping off the line at launch, gathering
// speed, then braking hard at the end. Mirrors worker/orbitPos.js
// legProgress, which places the same hull for fog and the gravity sink.

/** A multiplayer burn with a shape to show: a hard brake or a build-up.
 *  Single player's flat, even burns never are, so nothing drawn for it
 *  changes. */
export function isShapedBurn(p: TorchTransfer): boolean {
  return p.brakeAcceleration !== p.acceleration || buildOf(p) != null;
}

function boostOf(p: TorchTransfer, tau: number) {
  const b = buildOf(p);
  return b
    ? boostState(tau, p.acceleration, b.ramp, b.max, b.tau)
    : boostState(tau, p.acceleration);
}

/** The tick the brake brings the hull to rest (at or before arrival: a
 *  server-ceiled arrival can leave it parked on the intercept a while). */
export function burnStopTick(p: TorchTransfer): number {
  const t1 = p.flipTick - p.startTick;
  if (!(t1 > 0) || !(p.brakeAcceleration > 0)) return p.arriveTick;
  return Math.min(p.arriveTick, p.flipTick + boostOf(p, t1).v / p.brakeAcceleration);
}

/** Share of the leg's line covered at tick `t`, on the leg's own burn. */
export function burnFractionAt(p: TorchTransfer, t: number): number {
  const T = p.arriveTick - p.startTick;
  const t1 = p.flipTick - p.startTick;
  const tau = t - p.startTick;
  if (!(T > 0)) return 1;
  if (tau <= 0) return 0;
  if (!(t1 > 0) || !(p.brakeAcceleration > 0) || !(p.acceleration > 0)) return Math.min(1, tau / T);
  const s1 = boostOf(p, t1);
  const total = s1.x + (s1.v * s1.v) / (2 * p.brakeAcceleration);
  if (!(total > 0)) return Math.min(1, tau / T);
  if (tau <= t1) return Math.min(1, boostOf(p, tau).x / total);
  const u = Math.min(tau - t1, s1.v / p.brakeAcceleration);
  return Math.min(1, (s1.x + s1.v * u - 0.5 * p.brakeAcceleration * u * u) / total);
}

/** How far up its build-up the push is at tick `t`, 0 (launch) to 1
 *  (top). A flat push is always 1. */
export function pushShareAt(p: TorchTransfer, t: number): number {
  const b = buildOf(p);
  if (!b) return 1;
  return (pushAt(p, t) - p.acceleration) / (b.max - p.acceleration);
}

function planRampedTransfer(
  ship: TorchShipState, target: Body, a0: number, k: number, r: BurnRamp,
  currentTick: number, bodies: Body[], iterations: number,
): TorchTransfer | null {
  let interceptPos = bodyPosition(target, currentTick, bodies);
  let shape = { t1: 0, T: 0, brake: k * a0, vPeak: 0 };
  for (let i = 0; i < iterations; i++) {
    const dx = interceptPos.x - ship.pos.x;
    const dy = interceptPos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) return null;
    const next = burnShape(d, a0, r.ramp, r.max, k, r.tau ?? 0);
    const done = Math.abs(next.T - shape.T) < 1e-4;
    shape = next;
    if (done) break;
    interceptPos = bodyPosition(target, currentTick + shape.T, bodies);
  }
  const dx = interceptPos.x - ship.pos.x;
  const dy = interceptPos.y - ship.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  return {
    targetBodyId: target.id,
    acceleration: a0,
    brakeAcceleration: shape.brake,
    // Exponential (tau) or linear (ramp): the leg carries whichever it is.
    ...((r.tau ?? 0) > 0 ? { accelTau: r.tau } : { accelRamp: r.ramp }),
    accelMax: r.max,
    startTick: currentTick,
    flipTick: currentTick + shape.t1,
    arriveTick: currentTick + shape.T,
    thrustDir: { x: dx / d, y: dy / d },
    interceptPos,
    startPos: { x: ship.pos.x, y: ship.pos.y },
    startVel: { x: ship.vel.x, y: ship.vel.y },
    // Whatever was built up on the way out is braked away on the way in.
    totalDv: 2 * shape.vPeak,
    peakVelocity: shape.vPeak,
  };
}

/**
 * Step a ship's (pos, vel) forward by `dt` ticks under the given
 * transfer plan. Mutates the ship in place AND returns it for chaining.
 *
 * - Before startTick: coast (no thrust applied).
 * - Boost phase: thrust toward fixed intercept point. Re-aimed each
 *   step, which is what curls the path against inherited velocity.
 * - Brake phase: thrust opposite to ship's velocity RELATIVE TO the
 *   target body. Kills both transverse and along-track velocity so the
 *   ship arrives at-rest in target's frame.
 * - On arrival: snaps pos to interceptPos and vel to target's velocity.
 *
 * Arrival snap is intentional. The game-loop caller then performs the
 * parking-orbit insertion (Phase 1).
 */
/** Maximum integrator step in ticks.
 *
 *  The thrust direction re-aims at the start of each step (boost: vector to
 *  intercept; brake: opposite of velocity relative to target). The renderer's
 *  sampleTorchTrajectory takes many tiny steps and gets a smoothly-curving
 *  arc. If the simulator is called with a huge dt in one go — which happens
 *  in MP whenever /state polls back ("integrate from launch to currentTick"
 *  in one step ≈ 50 ticks for a Mars transfer) — the thrust direction stays
 *  frozen at the midpoint of that giant chunk and the ship goes nearly
 *  straight. Result: ship icon visibly drifts off the rendered trajectory
 *  line. By clamping the per-iteration step to MAX_SUBSTEP and looping, the
 *  simulator and the renderer agree to within roundoff. */
const MAX_SUBSTEP = 1;

/** Substeps per trip on a HARD-BRAKE leg (brake != boost). Matches
 *  BURN_SUBSTEPS in worker/transitCombat.js torchStateAt — keep in sync.
 *  At 1g a leg lasts a few ticks and its 9x brake a tenth of that, so a
 *  whole-tick step would boost straight through the brake. A hundredth
 *  of the trip gives the brake ten steps, and no step straddles the flip.
 *  An even burn (every single-player leg, every leg committed before
 *  migration 0155) steps exactly as it always did. */
const BURN_SUBSTEPS = 100;

function singleStepTorch(
  ship: TorchShipState,
  transfer: TorchTransfer | undefined,
  currentTick: number,
  dt: number,
  bodies: Body[],
): TorchShipState {
  if (!transfer || currentTick + dt < transfer.startTick) {
    ship.pos.x += ship.vel.x * dt;
    ship.pos.y += ship.vel.y * dt;
    return ship;
  }
  const endTick = Math.min(currentTick + dt, transfer.arriveTick);
  const step = endTick - currentTick;
  if (step <= 0) return ship;

  // Decide thrust direction at the midpoint so we don't lurch through
  // the flip.
  const midTick = currentTick + step / 2;
  const inAccelPhase = midTick < transfer.flipTick;

  let thrustX: number, thrustY: number;
  let thisAccel: number;
  if (inAccelPhase) {
    // A building push (multiplayer, migrations 0158 / 0159): the push at
    // this step's midpoint. Without a build it is the flat push, as always.
    thisAccel = pushAt(transfer, midTick);
    const dx = transfer.interceptPos.x - ship.pos.x;
    const dy = transfer.interceptPos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-9) { thrustX = 0; thrustY = 0; }
    else { thrustX = dx / d; thrustY = dy / d; }
  } else {
    thisAccel = transfer.brakeAcceleration;
    const target = bodies.find(b => b.id === transfer.targetBodyId);
    const tv = target ? bodyWorldVelocity(target, midTick, bodies) : { x: 0, y: 0 };
    const rvx = ship.vel.x - tv.x;
    const rvy = ship.vel.y - tv.y;
    const rv = Math.sqrt(rvx * rvx + rvy * rvy);
    if (rv < 1e-9) { thrustX = 0; thrustY = 0; }
    else { thrustX = -rvx / rv; thrustY = -rvy / rv; }
  }

  const ax = thrustX * thisAccel;
  const ay = thrustY * thisAccel;
  ship.pos.x += ship.vel.x * step + 0.5 * ax * step * step;
  ship.pos.y += ship.vel.y * step + 0.5 * ay * step * step;
  ship.vel.x += ax * step;
  ship.vel.y += ay * step;

  if (endTick >= transfer.arriveTick - 1e-9) {
    const target = bodies.find(b => b.id === transfer.targetBodyId);
    const tv = target ? bodyWorldVelocity(target, endTick, bodies) : { x: 0, y: 0 };
    ship.pos.x = transfer.interceptPos.x;
    ship.pos.y = transfer.interceptPos.y;
    ship.vel.x = tv.x;
    ship.vel.y = tv.y;
  }
  return ship;
}

export function stepTorchShip(
  ship: TorchShipState,
  transfer: TorchTransfer | undefined,
  currentTick: number,
  dt: number,
  bodies: Body[],
): TorchShipState {
  if (dt <= 0) return ship;
  // Subdivide the requested dt into ≤MAX_SUBSTEP chunks so the thrust
  // direction re-aims at the same cadence the renderer's sampler uses.
  // Without this, a single large step ends up frozen at one midpoint
  // direction and the ship visibly drifts off the rendered arc.
  const hardBrake = !!transfer && (transfer.brakeAcceleration !== transfer.acceleration
    || buildOf(transfer) != null);
  const fine = hardBrake
    ? Math.min(MAX_SUBSTEP, Math.max(1e-6, (transfer!.arriveTick - transfer!.startTick) / BURN_SUBSTEPS))
    : MAX_SUBSTEP;
  let elapsed = 0;
  while (elapsed < dt) {
    let step = Math.min(fine, dt - elapsed);
    const at = currentTick + elapsed;
    if (hardBrake && at < transfer!.flipTick - 1e-9) step = Math.min(step, transfer!.flipTick - at);
    singleStepTorch(ship, transfer, at, step, bodies);
    elapsed += step;
    // Arrival snap inside singleStepTorch already pinned the state to
    // interceptPos + target velocity. No more meaningful integration to do.
    if (transfer && currentTick + elapsed >= transfer.arriveTick - 1e-9) break;
  }
  return ship;
}

/**
 * Sample the integrated trajectory for renderer use. Same step logic as
 * the simulator, so the drawn path matches what the ship will actually
 * fly (including curve from inherited orbital velocity).
 */
export function sampleTorchTrajectory(
  transfer: TorchTransfer,
  startShip: TorchShipState,
  bodies: Body[],
  samples: number = 120,
): Array<{ t: number; x: number; y: number }> {
  const out: Array<{ t: number; x: number; y: number }> = [];
  const T = transfer.arriveTick - transfer.startTick;
  if (T <= 0) return out;
  const s: TorchShipState = {
    pos: { x: startShip.pos.x, y: startShip.pos.y },
    vel: { x: startShip.vel.x, y: startShip.vel.y },
  };
  out.push({ t: transfer.startTick, x: s.pos.x, y: s.pos.y });
  let t = transfer.startTick;
  const dt = T / samples;
  for (let i = 0; i < samples; i++) {
    stepTorchShip(s, transfer, t, dt, bodies);
    t += dt;
    out.push({ t, x: s.pos.x, y: s.pos.y });
  }
  return out;
}

/**
 * Linearly interpolate a position on a previously-sampled torch trajectory
 * for time `t`. Same array the renderer connects with lineTo, so a ship
 * drawn at this position lands ON the visible polyline — not next to it.
 *
 * Why the helper exists: the renderer used to draw the ship at
 * `ship.transit.pos` (a fresh integration from launch state) while the
 * trajectory line was sampled at 80 fixed points and connected with
 * straight segments. Even when both integrations were numerically
 * identical at the sample times, the ship between samples followed the
 * true curve while the line followed a chord — so the ship visibly
 * floated off the polyline mid-segment. By driving the ship from the
 * same samples + lerp, ship and line coincide exactly at every t.
 *
 * Falls back to the curve endpoints when `t` is outside the sampled
 * range (callers can still draw a ship that's pre-launch or already
 * arrived without bounds-checking themselves).
 */
export function torchPositionFromSamples(
  samples: Array<{ t: number; x: number; y: number }>,
  t: number,
): { x: number; y: number } {
  if (samples.length === 0) return { x: 0, y: 0 };
  if (t <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  // Linear scan is fine — samples is ~80 entries and called per ship per frame.
  // If this ever becomes hot, swap for a binary search keyed on sample t.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t >= t) {
      const a = samples[i - 1];
      const b = samples[i];
      const span = b.t - a.t;
      // Guard against duplicate-t samples (shouldn't happen but be defensive).
      if (span <= 0) return { x: a.x, y: a.y };
      const u = (t - a.t) / span;
      return {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
      };
    }
  }
  return { x: last.x, y: last.y };
}

/**
 * Unit tangent of the sample polyline at time `t` — the direction the
 * ship is travelling AT THE POINT THE LINE PUTS IT, by finite
 * difference on torchPositionFromSamples. This is what ties a transit
 * ship's nose to its drawn trajectory: probing the same polyline the
 * ship is lerped along is on-the-line by construction, curved or
 * straight, where "point at the target body" drifts off the dashes
 * (they run to the plan's frozen intercept point, not the body's live
 * position).
 *
 * Probes forward; when `t` is clamped at the arrival end (forward
 * probe degenerate) probes backward and flips, so the final frames
 * keep the last segment's direction instead of collapsing to null.
 * Returns null only for degenerate polylines (<2 samples, zero span).
 */
export function trajectoryTangentAt(
  samples: Array<{ t: number; x: number; y: number }>,
  t: number,
): { x: number; y: number } | null {
  if (samples.length < 2) return null;
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  if (!(t1 > t0)) return null;
  const eps = (t1 - t0) / 200;
  // Clamp into the polyline's span BEFORE probing: for a `t` past the
  // arrival tick (the frames between arriving and leaving transit),
  // both raw probes would clamp to the last sample and degenerate to
  // null — clamped, the backward probe still reads the final segment.
  const tc = Math.max(t0, Math.min(t1, t));
  const a = torchPositionFromSamples(samples, tc);
  let b = torchPositionFromSamples(samples, tc + eps);
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-12) {
    b = torchPositionFromSamples(samples, tc - eps);
    dx = a.x - b.x;
    dy = a.y - b.y;
  }
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return null;
  return { x: dx / d, y: dy / d };
}

/**
 * 1g anchor: the acceleration that would carry a ship from Sol to
 * Earth (orbitRadius ≈ 132.6 game-units) in exactly 1 tick under a
 * symmetric brachistochrone. Picked so the slider readout matches
 * intuition — Expanse cruise is ~1g, max combat burn is ~5g.
 *
 *   T = 2·√(d/a)  →  1 = 2·√(132.6/a)  →  a = 530.4
 */
export const G_ANCHOR = 4 * 132.6;

/** Default research-level-0 engine g per faction. Picked to give ~3-7
 *  day trips inner system, 2-3 weeks to the Kuiper belt — enough room
 *  for engine research to feel impactful (each tier ~halves trip
 *  times). */
export const DEFAULT_ENGINE_G = 0.05;

/** Default engine acceleration in game units / tick², derived from
 *  DEFAULT_ENGINE_G and the 1g anchor. */
export const DEFAULT_ENGINE_ACCEL = DEFAULT_ENGINE_G * G_ANCHOR;

/**
 * MULTIPLAYER'S BURN, installed from /state (game.burn_*, owned by
 * worker/burn.js).
 *
 * Since 2026-10-06 every multiplayer hull launches at 0.05g, the push
 * builds to 1g over 48 ticks of burning, and it brakes at nine times the
 * push it reached. Single-player never installs a profile, and with none
 * installed every helper below returns exactly what the planners always
 * used: the faction's g (or the 0.05g default), an even burn, no build.
 */
export interface MpBurnProfile {
  engineG: number;
  brakeMul: number;
  /** Top of the build, in g (0 or <= engineG = no build). */
  maxG?: number;
  /** Ticks of burning to build from engineG to maxG. */
  rampTicks?: number;
  /** Exponential build (worker/burn.js GROWTH_TAU): ticks for the push to
   *  grow by e. Absent = the linear build over rampTicks. */
  growthTau?: number;
}
let mpBurn: MpBurnProfile | null = null;

/** Called by the MP provider when /state lands; null on unmount. */
export function setMpBurnProfile(p: MpBurnProfile | null): void {
  mpBurn = p && p.engineG > 0 && p.brakeMul > 0
    ? { engineG: p.engineG, brakeMul: p.brakeMul, maxG: p.maxG, rampTicks: p.rampTicks, growthTau: p.growthTau }
    : null;
}

/** The build-up for a hull that launches at `a0` (its own push, parts and
 *  all — the whole curve scales with it, as on the server). Exponential
 *  when the server sends a growth tau, else linear. Undefined outside
 *  multiplayer or without a build, which plans a flat push. */
export function mpRampFor(a0: number): BurnRamp | undefined {
  if (!mpBurn || !(a0 > 0)) return undefined;
  const { engineG, maxG, rampTicks, growthTau } = mpBurn;
  if (!(maxG != null && maxG > engineG)) return undefined;
  const max = a0 * (maxG / engineG);
  if (growthTau != null && growthTau > 0) return { ramp: 0, max, tau: growthTau };
  if (!(rampTicks != null && rampTicks > 0)) return undefined;
  return { ramp: (max - a0) / rampTicks, max };
}

/** A hull's base engine g: multiplayer's, else the faction's stored g. */
export function baseEngineG(factionEngineG: number | undefined): number {
  return mpBurn ? mpBurn.engineG : (factionEngineG ?? DEFAULT_ENGINE_G);
}

/** The braking thrust for a leg that pushes at `boost`. */
export function brakeAccelFor(boost: number): number {
  return mpBurn ? boost * mpBurn.brakeMul : boost;
}

export function asG(accel: number): number {
  return accel / G_ANCHOR;
}

export function fromG(g: number): number {
  return g * G_ANCHOR;
}

/**
 * The part of a torch plan the SERVER needs to own the trajectory
 * (DESIGN-transit-combat.md stage 0, migration 0088).
 *
 * Until now only the client knew where a ship was mid-flight, because
 * only the client built the plan. That is fine while ships in transit
 * are combat-proof and fatal the moment they aren't: a server that
 * re-derived arcs independently would give two derivations of one truth,
 * and shots would come from where the ship isn't drawn.
 *
 * So the planner's output — not a re-derivation of it — is what gets
 * recorded. Every transfer intent runs through here rather than
 * spelling out the six fields at each of its call sites, because six
 * fields copied eight times is seven chances to transpose vx and vy.
 */
export function launchFromPlan(plan: TorchTransfer): {
  x: number; y: number; vx: number; vy: number; accel: number; flipTick: number;
  brakeAccel: number; accelRamp?: number; accelMax?: number; accelTau?: number;
} {
  return {
    x: plan.startPos.x,
    y: plan.startPos.y,
    vx: plan.startVel.x,
    vy: plan.startVel.y,
    accel: plan.acceleration,
    flipTick: plan.flipTick,
    // The brake (migration 0155). Without it the server would store an
    // even burn and fly the hull past its own flip at the wrong thrust.
    brakeAccel: plan.brakeAcceleration,
    // The build-up (migrations 0158 / 0159). Without it the server would
    // fly a flat push and the hull would fall behind its own arc.
    ...(plan.accelMax != null && plan.accelTau != null
      ? { accelTau: plan.accelTau, accelMax: plan.accelMax }
      : plan.accelRamp != null && plan.accelMax != null
        ? { accelRamp: plan.accelRamp, accelMax: plan.accelMax } : {}),
  };
}
