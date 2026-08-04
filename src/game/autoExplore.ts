// ============================================================
// autoExplore — "send this scout to visit everything worth seeing".
//
// Picks an ORDER, not a route: the caller turns each body id into a
// real torch leg (gameContext.queueTorchTour). Ordering is
// nearest-neighbour greedy from the ship's current position, recomputed
// at each hop against where the PREVIOUS target sits at the time we'd
// arrive there — bodies orbit, so ordering against their positions
// "now" would plan a tour of where everything used to be.
//
// Deliberately not a travelling-salesman solve: legs are re-planned by
// the physics layer anyway, and greedy gets within a few percent of
// optimal on a handful of stops while staying readable.
// ============================================================

import type { Body, Settlement, Ship } from '../types';
import { makeSystemRootOf } from './systemGrouping';
import { bodyPosition, orbitWorldPos } from '../physics/orbitalMechanics';

/** How many hops one auto-explore order may queue. Each leg is a
 *  separate server post, and a grand tour of a full map would otherwise
 *  fire thirty of them off a single click. Also keeps the queued-leg
 *  list in ShipPanel readable. */
export const MAX_TOUR_LEGS = 10;

export type ExploreScope = 'system' | 'all';

/** Rough per-leg travel estimate used only for ORDERING. The real
 *  duration comes from planTorchTransfer; we just need something
 *  monotonic in distance to advance the clock between hops so later
 *  targets are evaluated at roughly the right time. */
const TICKS_PER_DISTANCE = 0.05;

/**
 * Ordered body ids for a scout to visit, nearest-first.
 *
 * Skipped: the star (a special-case destination — the Dyson ferry owns
 * it), the body the ship is already at, anything whose secret is
 * already revealed (nothing left to find), and bodies where the player
 * already holds a settlement (they've plainly been there).
 */
export function planExploreTour(
  ship: Ship,
  bodies: Body[],
  settlements: Settlement[],
  currentTick: number,
  scope: ExploreScope,
): string[] {
  const systemRootOf = makeSystemRootOf(bodies);
  const here = ship.orbit?.parentBodyId;
  const myRoot = here ? systemRootOf(here) : null;

  const settledBodyIds = new Set(
    settlements.filter(s => s.ownedBy === ship.ownedBy).map(s => s.bodyId),
  );

  const candidates = bodies.filter(b => {
    if (b.type === 'star' || b.type === 'black_hole') return false;
    if (b.id === here) return false;
    if (b.destroyedAtTick != null) return false;
    if (b.secret?.revealed) return false;
    if (settledBodyIds.has(b.id)) return false;
    if (scope === 'system') {
      if (!myRoot) return false;
      if (systemRootOf(b.id) !== myRoot) return false;
    }
    return true;
  });
  if (candidates.length === 0) return [];

  // Start from where the ship actually is. A ship mid-burn is measured
  // from its destination — the tour will chain off that arrival anyway.
  let cursor = shipAnchorPos(ship, bodies, currentTick);
  if (!cursor) return [];
  let clock = ship.transit?.currentTransfer?.arriveTick ?? currentTick;

  const remaining = new Map(candidates.map(b => [b.id, b]));
  const order: string[] = [];
  while (order.length < MAX_TOUR_LEGS && remaining.size > 0) {
    let bestId: string | null = null;
    let bestD = Infinity;
    let bestPos: { x: number; y: number } | null = null;
    for (const b of remaining.values()) {
      const p = bodyPosition(b, clock, bodies);
      const d = Math.hypot(p.x - cursor.x, p.y - cursor.y);
      if (d < bestD) { bestD = d; bestId = b.id; bestPos = p; }
    }
    if (!bestId || !bestPos) break;
    order.push(bestId);
    remaining.delete(bestId);
    cursor = bestPos;
    clock += Math.max(1, Math.round(bestD * TICKS_PER_DISTANCE));
  }
  return order;
}

/** Where to measure the tour from: a parked ship's own orbital
 *  position, or — for one already burning — the body it's heading to,
 *  since the tour chains onto that arrival. */
function shipAnchorPos(
  ship: Ship,
  bodies: Body[],
  currentTick: number,
): { x: number; y: number } | null {
  const inflight = ship.transit?.currentTransfer;
  if (inflight) {
    const dest = bodies.find(b => b.id === inflight.targetBodyId);
    if (dest) return bodyPosition(dest, inflight.arriveTick, bodies);
  }
  return orbitWorldPos(ship.orbit, currentTick, bodies);
}
