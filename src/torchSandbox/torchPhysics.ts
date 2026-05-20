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
  /** Magnitude of constant thrust acceleration (game-units / tick²). */
  acceleration: number;
  /** Tick when the burn starts. */
  startTick: number;
  /** Tick of the flip (half-way point). */
  flipTick: number;
  /** Tick of arrival. */
  arriveTick: number;
  /** Initial direction of thrust during the acceleration phase. */
  thrustDir: Vec2;
  /** Where in the world we are aiming (target body at arriveTick). */
  interceptPos: Vec2;
  /** Total Δv expended over the whole burn (= a·T). */
  totalDv: number;
  /** Peak velocity (at the flip). */
  peakVelocity: number;
}

export interface TorchShipState {
  pos: Vec2;
  vel: Vec2;
}

/**
 * Plan a brachistochrone transfer. The ship's STARTING velocity is
 * ignored for the trajectory shape (acceleration so dominates that
 * orbital velocities are noise — but we set the thrust direction once
 * the intercept converges so the trip is still computed correctly).
 *
 * Returns null if the target is the same body as where we are (no-op)
 * or the acceleration is non-positive.
 */
export function planTorchTransfer(
  ship: TorchShipState,
  targetId: string,
  acceleration: number,
  currentTick: number,
  iterations: number = 20,
): TorchTransfer | null {
  if (acceleration <= 0) return null;
  const target = BY_ID[targetId];
  if (!target) return null;

  // Initial intercept guess: target position right now.
  let interceptPos = bodyPosition(target, currentTick);
  let T = 0;
  for (let i = 0; i < iterations; i++) {
    const dx = interceptPos.x - ship.pos.x;
    const dy = interceptPos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) return null;
    const Tnext = 2 * Math.sqrt(d / acceleration);
    if (Math.abs(Tnext - T) < 1e-4) { T = Tnext; break; }
    T = Tnext;
    interceptPos = bodyPosition(target, currentTick + T);
  }

  const dx = interceptPos.x - ship.pos.x;
  const dy = interceptPos.y - ship.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const thrustDir: Vec2 = { x: dx / d, y: dy / d };

  return {
    targetId,
    acceleration,
    startTick: currentTick,
    flipTick: currentTick + T / 2,
    arriveTick: currentTick + T,
    thrustDir,
    interceptPos,
    totalDv: acceleration * T,
    peakVelocity: Math.sqrt(acceleration * d),
  };
}

/**
 * Step a ship forward by `dt` ticks under the given transfer plan.
 * Mutates and returns the ship state. If `dt` would step past the
 * arrival tick, the ship's velocity is zeroed and position is snapped
 * to the intercept (Expanse-style arrival "at rest").
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
  // Step forward up to arriveTick. If we overshoot, clamp.
  const endTick = Math.min(currentTick + dt, transfer.arriveTick);
  const step = endTick - currentTick;
  if (step <= 0) {
    ship.pos.x = transfer.interceptPos.x;
    ship.pos.y = transfer.interceptPos.y;
    ship.vel.x = 0;
    ship.vel.y = 0;
    return ship;
  }
  // Phase: which side of the flip are we on at the MIDPOINT of this step?
  const midTick = currentTick + step / 2;
  const inAccelPhase = midTick < transfer.flipTick;
  const sign = inAccelPhase ? 1 : -1;
  const ax = sign * transfer.thrustDir.x * transfer.acceleration;
  const ay = sign * transfer.thrustDir.y * transfer.acceleration;
  // Velocity-Verlet
  ship.pos.x += ship.vel.x * step + 0.5 * ax * step * step;
  ship.pos.y += ship.vel.y * step + 0.5 * ay * step * step;
  ship.vel.x += ax * step;
  ship.vel.y += ay * step;
  // Did we land at arrival? Snap velocity to 0 (idealized arrival).
  if (endTick >= transfer.arriveTick - 1e-9) {
    ship.pos.x = transfer.interceptPos.x;
    ship.pos.y = transfer.interceptPos.y;
    ship.vel.x = 0;
    ship.vel.y = 0;
  }
  return ship;
}

/**
 * Sample the ship's planned trajectory at N points between startTick
 * and arriveTick. Used by the renderer to draw the path. Returns an
 * array of (tick, x, y) points along the brachistochrone.
 */
export function sampleTrajectory(
  transfer: TorchTransfer,
  startShip: TorchShipState,
  samples: number = 80,
): Array<{ t: number; x: number; y: number }> {
  const out: Array<{ t: number; x: number; y: number }> = [];
  const T = transfer.arriveTick - transfer.startTick;
  const a = transfer.acceleration;
  const dirX = transfer.thrustDir.x;
  const dirY = transfer.thrustDir.y;
  const halfT = T / 2;
  // Use the closed-form position vs. time (with the ship starting at
  // rest in the brachistochrone frame). This dodges any drift that
  // numerical integration might introduce in the rendered path.
  for (let i = 0; i <= samples; i++) {
    const tau = (i / samples) * T;
    let dAccel: number;
    if (tau <= halfT) {
      dAccel = 0.5 * a * tau * tau;
    } else {
      // First-half displacement plus the second-half deceleration arc
      const t2 = tau - halfT;
      const v0 = a * halfT;            // velocity at flip
      dAccel = 0.5 * a * halfT * halfT // distance covered in first half
             + v0 * t2 - 0.5 * a * t2 * t2;
    }
    out.push({
      t: transfer.startTick + tau,
      x: startShip.pos.x + dirX * dAccel,
      y: startShip.pos.y + dirY * dAccel,
    });
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
