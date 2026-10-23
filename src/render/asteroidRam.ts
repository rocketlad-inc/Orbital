// ============================================================
// THE ASTEROID RAM, drawn (worker/room.js resolveAsteroidImpacts).
//
// Studio clip "An asteroid rammed into Mars" (2026-10-23):
//   - the rock was never on screen on its way in, only the red reticle
//     at the meeting point: as it closed on the world it folded into it
//     (bodyPresentation's sibling pass), like a trojan rock sitting on
//     its planet, and nothing was drawn;
//   - the impact flashed at the world's centre, and the biosphere it
//     killed burned under a Mega Destroyer's beam from the top of the
//     screen (the 'terraform_destroyed' row it writes played as a
//     Planet Killer strike).
// This holds what the map learns while the rock flies: the side of the
// world it is coming in on, so the strike lands there.
// ============================================================

import type { RamPlan } from '../types';

type V = { x: number; y: number };

/** Target body id -> unit vector from the target to the rock, the last
 *  time the rock was drawn on its way in (world axes). */
const approach = new Map<string, V>();

/** drawRammingBody calls this every frame the rock is drawn. */
export function noteRamApproach(targetBodyId: string, dx: number, dy: number): void {
  const d = Math.hypot(dx, dy);
  if (!(d > 1e-9)) return;
  if (approach.size > 64) approach.clear();
  approach.set(targetBodyId, { x: dx / d, y: dy / d });
}

/** Which side of `targetBodyId` the last rock came in on, if this client
 *  watched it. */
export function ramApproachDir(targetBodyId: string): V | null {
  return approach.get(targetBodyId) ?? null;
}

/** Test hook. */
export function resetRamApproach(): void {
  approach.clear();
}

/**
 * Where the impact lands: on the surface facing where the rock came from.
 * `dir` is the unit vector target -> rock; `R` the world's drawn radius in
 * the same units as `centre`. Without a direction, the centre (the old
 * behaviour, for a row nobody can place).
 */
export function impactPoint(centre: V, dir: V | null | undefined, R: number, depth = 0.85): V {
  if (!dir) return { x: centre.x, y: centre.y };
  const d = Math.hypot(dir.x, dir.y);
  if (!(d > 1e-9)) return { x: centre.x, y: centre.y };
  return { x: centre.x + (dir.x / d) * R * depth, y: centre.y + (dir.y / d) * R * depth };
}

/**
 * Which way the rock's thrusters push at tick `t`: at the meeting point
 * on the boost, against its speed relative to the target on the brake
 * (orbitalMechanics ramStep). The plume goes the other way. Positions
 * come in as functions of the tick so this stays pure.
 */
export function ramThrustDir(
  plan: Pick<RamPlan, 'flipTick' | 'interceptPos'>,
  t: number,
  rockAt: (t: number) => V,
  targetAt: (t: number) => V,
): V | null {
  const here = rockAt(t);
  let x: number, y: number;
  if (t < plan.flipTick) {
    x = plan.interceptPos.x - here.x; y = plan.interceptPos.y - here.y;
  } else {
    const dt = 0.02;
    const a = targetAt(t), b = targetAt(t + dt), ahead = rockAt(t + dt);
    x = -((ahead.x - b.x) - (here.x - a.x));
    y = -((ahead.y - b.y) - (here.y - a.y));
  }
  const d = Math.hypot(x, y);
  return d > 1e-12 ? { x: x / d, y: y / d } : null;
}

/** The rock's drawn radius on its way in, px: never smaller than a
 *  readable rock, and its own drawn size when that is bigger. */
export const RAM_ROCK_MIN_PX = 6;
export function ramRockRadiusPx(drawnR: number): number {
  return Math.max(RAM_ROCK_MIN_PX, drawnR);
}
