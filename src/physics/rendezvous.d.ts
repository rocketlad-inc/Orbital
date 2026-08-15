// Types for worker/rendezvous.js, so the client solves with the SAME
// code the server evaluates against. A TypeScript mirror would be a
// second derivation of a trajectory, which is the failure this whole
// design exists to prevent.

export interface Vec2 { x: number; y: number }
export interface State { pos: Vec2; vel: Vec2 }

export interface RendezvousSolution {
  /** First burn, as a Δv vector. Duration = |A| / accel. */
  A: Vec2;
  /** Second burn — kills the remaining relative velocity. */
  B: Vec2;
  t1: number;
  t2: number;
  /** Trip length from the burn start to the meeting. */
  T: number;
  /** Absolute tick at which the two hulls match. */
  meetTick: number;
}

/**
 * Earliest feasible matched-velocity rendezvous, or null when no pair of
 * burns closes both the position and velocity gap before `latestTick`.
 * Returning null is the normal outcome for most geometries — that is the
 * difficulty gate, not a failure.
 */
export function solveRendezvous(
  p0: Vec2,
  v0: Vec2,
  accel: number,
  stateAt: (tick: number) => State | null,
  startTick: number,
  latestTick: number,
  samples?: number,
): RendezvousSolution | null;

export interface RendezvousPlan {
  p0: Vec2;
  v0: Vec2;
  accel: number;
  A: Vec2;
  B: Vec2;
  startTick: number;
  meetTick: number;
}

/**
 * Position/velocity on a rendezvous arc: burn, coast, burn, then BE the
 * followed ship. `followedStateAt` supplies that ship's own trajectory;
 * pass null to hold the matched state instead (target destroyed, or no
 * plan available).
 */
export function rendezvousStateAt(
  plan: RendezvousPlan,
  t: number,
  followedStateAt: ((tick: number) => State | null) | null,
): State;
