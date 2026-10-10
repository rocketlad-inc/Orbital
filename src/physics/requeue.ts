// ============================================================
// requeueAfter — a ship's queued legs, re-planned behind a new first leg.
//
// A queued leg is planned off whatever came before it WHEN IT WAS
// QUEUED: its launch point is where that predecessor parked the ship,
// its departure tick is when. Commit a different first leg and the old
// plan is wrong on both counts. Posted verbatim (as ShipPanel did until
// 2026-10-09) it tells the server the ship leaves for the next world
// from somewhere it never went, at a time before it got anywhere.
//
// Wil, UBGE T94-T104: an 8-hull squadron queued Ganymede -> Io, then was
// sent to Europa first. The Io legs went up unchanged (launch: Ganymede
// at T102.55), took off while the squadron was still flying to Europa,
// and the whole squadron was drawn, and fought, on the Ganymede -> Io
// course: "teleported to base in the middle of the fight".
//
// Here every queued leg is solved again with the chain planner, starting
// where the new first leg parks the ship. The waits BETWEEN queued legs
// are kept (the player asked for them); the first queued leg leaves as
// soon as the new first leg lands, since what it used to wait for is
// gone. An intercept in the queue cannot be re-solved without its
// target's course, so it and everything after it go up as they were
// (the server re-plans a leg that does not start where its ship is).
// ============================================================

import { planChainLegs, ChainStep } from './chainPlanner';
import type { Body, TorchTransferPlan } from '../types';

export function requeueAfter(
  queue: readonly TorchTransferPlan[],
  /** The new first leg, as it will be flown. Null = nothing to chain off
   *  (an intercept), so the queue goes up as it was. */
  first: TorchTransferPlan | null,
  bodies: Body[],
  accel: number,
): TorchTransferPlan[] {
  if (!first || queue.length === 0 || !(accel > 0)) return [...queue];
  const cut = queue.findIndex(q => !!q.rv);
  const plain = cut < 0 ? queue : queue.slice(0, cut);
  const rest = cut < 0 ? [] : queue.slice(cut);
  if (plain.length === 0) return [...queue];

  const steps: ChainStep[] = plain.map((q, i) => ({
    bodyId: q.targetBodyId,
    wait: i === 0 ? 0 : Math.max(0, Math.round(q.startTick - plain[i - 1].arriveTick)),
  }));
  const legs = planChainLegs({
    startPos: first.interceptPos,
    startVel: { x: 0, y: 0 },
    startTick: first.arriveTick,
    parkedAtBodyId: first.targetBodyId,
    steps,
    bodies,
    accel,
  }) as unknown as TorchTransferPlan[];
  // A leg the planner cannot solve ends the route there: the rest would
  // chain off a stop the ship never makes.
  if (legs.length < plain.length) return legs;
  return [...legs, ...rest];
}
