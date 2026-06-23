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
  /** Multiplayer only: the id of the server `game_ship_nodes` row this
   *  plan was reconstructed from. Lets the UI cancel a queued leg on the
   *  server (not just locally). Undefined for single-player and for
   *  not-yet-committed local preview legs. */
  nodeId?: string;
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
): TorchTransfer | null {
  if (boostAccel <= 0 || brakeAccel <= 0) return null;
  const target = bodies.find(b => b.id === targetBodyId);
  if (!target) return null;

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
    thisAccel = transfer.acceleration;
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
  let elapsed = 0;
  while (elapsed < dt) {
    const step = Math.min(MAX_SUBSTEP, dt - elapsed);
    singleStepTorch(ship, transfer, currentTick + elapsed, step, bodies);
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

export function asG(accel: number): number {
  return accel / G_ANCHOR;
}

export function fromG(g: number): number {
  return g * G_ANCHOR;
}
