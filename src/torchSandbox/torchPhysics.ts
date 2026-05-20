// ============================================================
// TORCH SANDBOX — Brachistochrone transfer math
// ============================================================
// The Expanse model: ship under constant magnitude acceleration `a` the
// entire trip. First half: thrust toward the target's predicted arrival
// position. Half-way: flip 180°. Second half: thrust opposite (i.e.
// retrograde) to decelerate. Result: arrive at rest (relative to your
// thrust frame) right at the target.
//
// Compared to Hohmann / patched conics this gives:
//   * dramatically shorter trip times (Earth→Mars ≈ days, not months)
//   * effectively straight-line paths through space (curve is tiny
//     because the burn velocity dwarfs orbital velocities)
//   * always-on engines (the cost is total Δv = a·t)
//
// Implementation notes:
//
// 1. ITERATIVE INTERCEPT. The target moves. We start with the target's
//    current position, compute the trip time T to reach it from the
//    ship's current state, then re-predict the target at t_now + T, and
//    iterate. Usually converges in 5–10 passes.
//
// 2. CLOSED-FORM TRAVEL TIME. For a straight-line brachistochrone
//    starting at rest from distance d at constant acceleration a:
//      d = ½·a·(T/2)² + ½·a·(T/2)²  =  a·T²/4
//    so   T = 2·sqrt(d / a)
//    Peak velocity at flip: v_peak = a · T/2 = sqrt(a · d).
//
// 3. RELATIVE-VELOCITY MATCHING. When the ship and target both move,
//    arriving "at rest relative to target" means matching the target's
//    velocity. We approximate by aiming at the future target position
//    and using the closed-form above; for short fast burns this is
//    accurate to better than 1% (verified by integration test).

import { BODIES, BY_ID, Body, bodyPosition, bodyVelocity } from './bodies';

export interface Vec2 { x: number; y: number }

export interface TorchTransfer {
  /** Target body. */
  targetId: string;
  /** Boost acceleration during the first phase (game-units / tick²). */
  acceleration: number;
  /** Brake acceleration during the deceleration phase. Can differ from
   *  `acceleration` to model asymmetric profiles (e.g. hard kick →
   *  gentle brake, or slow ramp → emergency brake). When equal to
   *  `acceleration` this reduces to the symmetric brachistochrone. */
  brakeAcceleration: number;
  /** Tick when the burn starts. */
  startTick: number;
  /** Tick of the flip — boost ends, brake begins. For symmetric burns
   *  this is at the midpoint; for asymmetric burns the flip happens
   *  whenever the boost phase ends, which may be NOT at the time
   *  midpoint of the trip. */
  flipTick: number;
  /** Tick of arrival. */
  arriveTick: number;
  /** Initial direction of thrust during the acceleration phase. */
  thrustDir: Vec2;
  /** Where in the world we are aiming (target body at arriveTick). */
  interceptPos: Vec2;
  /** Ship state at launch — needed by the renderer to draw the
   *  actual curved path (inheriting initial orbital velocity). */
  startPos: Vec2;
  startVel: Vec2;
  /** Total Δv expended over the whole burn. For an asymmetric profile
   *  this is boost_g·t_boost + brake_g·t_brake = 2·peakVelocity. */
  totalDv: number;
  /** Peak velocity at the flip. v_peak = boost_g · t_boost. */
  peakVelocity: number;
}

export interface TorchShipState {
  pos: Vec2;
  vel: Vec2;
}

/**
 * Plan a brachistochrone transfer with independently chosen boost and
 * brake accelerations.
 *
 * Asymmetric math (in 1D, ignoring the inherited transverse velocity):
 *   - Boost phase, duration t1 at boost_g, peak velocity v = boost_g·t1
 *   - Brake phase, duration t2 = v / brake_g at brake_g
 *   - Distance covered:
 *       d = ½·boost_g·t1² + ½·brake_g·t2²
 *         = ½·boost_g·t1²·(1 + boost_g/brake_g)
 *   - Solving for t1: t1 = sqrt( 2·d·brake_g / (boost_g·(boost_g+brake_g)) )
 *   - Total trip time T = t1 + t2 = t1·(1 + boost_g/brake_g)
 *
 * Symmetric (brake_g = boost_g) reduces to the original T = 2·sqrt(d/a).
 *
 * The transverse-velocity inheritance handled by the integrator still
 * applies — this closed-form just gives the iterative intercept its
 * trip-time estimate.
 *
 * Returns null if either acceleration is non-positive, the target is
 * invalid, or the ship is already at the target.
 */
export function planTorchTransfer(
  ship: TorchShipState,
  targetId: string,
  boostAccel: number,
  brakeAccel: number,
  currentTick: number,
  iterations: number = 20,
): TorchTransfer | null {
  if (boostAccel <= 0 || brakeAccel <= 0) return null;
  const target = BY_ID[targetId];
  if (!target) return null;

  // Asymmetric brachistochrone trip-time given a straight-line distance.
  const tripTime = (d: number) => {
    const t1 = Math.sqrt(2 * d * brakeAccel / (boostAccel * (boostAccel + brakeAccel)));
    const t2 = (boostAccel * t1) / brakeAccel;
    return { T: t1 + t2, t1, t2 };
  };

  let interceptPos = bodyPosition(target, currentTick);
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
    interceptPos = bodyPosition(target, currentTick + T);
  }

  const dx = interceptPos.x - ship.pos.x;
  const dy = interceptPos.y - ship.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const thrustDir: Vec2 = { x: dx / d, y: dy / d };
  const vPeak = boostAccel * t1;

  return {
    targetId,
    acceleration: boostAccel,
    brakeAcceleration: brakeAccel,
    startTick: currentTick,
    flipTick: currentTick + t1,
    arriveTick: currentTick + T,
    thrustDir,
    interceptPos,
    startPos: { x: ship.pos.x, y: ship.pos.y },
    startVel: { x: ship.vel.x, y: ship.vel.y },
    totalDv: boostAccel * t1 + brakeAccel * (T - t1),
    peakVelocity: vPeak,
  };
}

/**
 * Step a ship forward by `dt` ticks under the given transfer plan.
 *
 * The thrust direction is recomputed AT EACH STEP — this is what gives
 * the trajectory its characteristic curve when the ship starts with
 * inherited orbital velocity:
 *
 *  - During the acceleration phase, we aim at the (fixed-at-plan-time)
 *    intercept point. As the ship's perpendicular drift pulls it off
 *    the straight Earth-to-intercept line, the thrust vector pivots
 *    to keep aimed at the destination — but the velocity built up so
 *    far still has the sideways component, so the path bends.
 *
 *  - During the deceleration phase we burn TRUE RETROGRADE (opposite
 *    the ship's actual velocity vector). This kills both the toward-
 *    target and the residual sideways motion, so the ship arrives
 *    at-rest in the target's frame.
 *
 * On arrival the ship snaps to the target's position AND velocity, so
 * the player ends up co-orbiting the target rather than continuing on
 * a heliocentric tangent.
 */
export function stepTorchShip(
  ship: TorchShipState,
  transfer: TorchTransfer | undefined,
  currentTick: number,
  dt: number,
): TorchShipState {
  if (!transfer || currentTick + dt < transfer.startTick) {
    // Coast: no thrust
    ship.pos.x += ship.vel.x * dt;
    ship.pos.y += ship.vel.y * dt;
    return ship;
  }
  const endTick = Math.min(currentTick + dt, transfer.arriveTick);
  const step = endTick - currentTick;
  if (step <= 0) return ship;

  // Direction is decided at the MIDPOINT of this step so we don't lurch
  // when the flip crosses the middle of a step.
  const midTick = currentTick + step / 2;
  const inAccelPhase = midTick < transfer.flipTick;

  let thrustX: number, thrustY: number;
  let thisAccel: number;
  if (inAccelPhase) {
    // Boost: aim at intercept, magnitude = boost_g.
    thisAccel = transfer.acceleration;
    const dx = transfer.interceptPos.x - ship.pos.x;
    const dy = transfer.interceptPos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-9) { thrustX = 0; thrustY = 0; }
    else { thrustX = dx / d; thrustY = dy / d; }
  } else {
    // Brake: kill velocity relative to target, magnitude = brake_g.
    thisAccel = transfer.brakeAcceleration;
    const target = BY_ID[transfer.targetId];
    const tv = bodyVelocity(target, midTick);
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

  // Arrival: snap to the PLANNED intercept (which equals the target's
  // position at arriveTick by construction of the planner) and match
  // the target's velocity so we end up co-orbiting it.
  if (endTick >= transfer.arriveTick - 1e-9) {
    const target = BY_ID[transfer.targetId];
    const tv = bodyVelocity(target, endTick);
    ship.pos.x = transfer.interceptPos.x;
    ship.pos.y = transfer.interceptPos.y;
    ship.vel.x = tv.x;
    ship.vel.y = tv.y;
  }
  return ship;
}

/**
 * Sample the ship's planned trajectory by NUMERICALLY INTEGRATING the
 * same step logic the simulator uses. This produces the actual curved
 * path the ship will fly — accounting for the inherited initial
 * velocity (e.g. Earth's orbital motion) and the continuous re-aim of
 * the thrust vector at the intercept point. The renderer can draw this
 * directly and it'll match the live burn.
 */
export function sampleTrajectory(
  transfer: TorchTransfer,
  startShip: TorchShipState,
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
    stepTorchShip(s, transfer, t, dt);
    t += dt;
    out.push({ t, x: s.pos.x, y: s.pos.y });
  }
  return out;
}

/**
 * Convert game-acceleration to "g" multiplier so the UI can show
 * "5.2g" — useful sanity-check. We define 1g = the acceleration that
 * would carry a ship from Sol to Earth (132.6 game units) in exactly
 * 1 tick: T = 2·sqrt(d/a) → 1 = 2·sqrt(132.6/a) → a = 530.4.
 *
 * That's an arbitrary anchor but it makes the slider feel meaningful
 * (the Expanse cites ~1g cruise, max-burn 5g+).
 */
export const G_ANCHOR = 4 * 132.6;  // ≈ 530.4 game-units / tick²

export function asG(accel: number): number {
  return accel / G_ANCHOR;
}

export function fromG(g: number): number {
  return g * G_ANCHOR;
}

// Re-export so consumers don't have to also import from bodies.ts
export { BODIES, BY_ID, bodyPosition, bodyVelocity };
export type { Body };
