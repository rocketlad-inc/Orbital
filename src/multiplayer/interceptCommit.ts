// ============================================================
// One parked hull's intercept of a ship in flight, as an order.
//
// Shared by the ship panel (a fleet's other hulls) and the group bar
// (every parked hull of a selection): each hull solves its OWN intercept
// of the same target from where it sits — a shared target, not a shared
// trajectory — flies it locally so it does not sit parked until the next
// poll, and hands back the intent to post. Posting is the caller's, so a
// group goes to the server as one POST /transfers.
// ============================================================

import type { Ship } from '../types';
import { launchFromPlan, type TorchTransfer } from '../physics/torchTransfer';
import type { TransferIntent } from './MultiplayerActionsContext';

export interface InterceptCommitDeps {
  enqueueIntercept: (shipId: string, targetShipId: string, waitTicks?: number, opts?: { fromNow?: boolean }) => TorchTransfer | null;
  launchTorchTransfer: (shipId: string, targetBodyId: string) => unknown;
  previewRendezvous: (shipId: string, plan: Ship['plannedRendezvous'] | null) => void;
}

/** Plan, fly locally, and return the intent — or null when this hull has
 *  no course to the target at all. `matched` is a true rendezvous in
 *  flight; otherwise the hull meets them at their destination. */
export function planHullIntercept(
  shipId: string,
  targetShipId: string,
  deps: InterceptCommitDeps,
): { intent: TransferIntent; matched: boolean } | null {
  const leg = deps.enqueueIntercept(shipId, targetShipId, 0, { fromNow: true });
  if (!leg) return null;
  deps.launchTorchTransfer(shipId, leg.targetBodyId);
  if (leg.rv) {
    deps.previewRendezvous(shipId, {
      p0: { x: leg.startPos.x, y: leg.startPos.y },
      v0: { x: leg.startVel.x, y: leg.startVel.y },
      accel: leg.acceleration,
      A: leg.rv.A, B: leg.rv.B,
      startTick: leg.startTick,
      meetTick: leg.rv.meetTick,
      followShipId: leg.rv.followShipId,
    });
  }
  return {
    matched: !!leg.rv,
    intent: {
      shipId,
      targetBodyId: leg.targetBodyId,
      scheduledT: leg.startTick,
      arrivalT: leg.arriveTick,
      launch: launchFromPlan(leg),
      ...(leg.rv ? {
        rendezvous: {
          ax: leg.rv.A.x, ay: leg.rv.A.y,
          bx: leg.rv.B.x, by: leg.rv.B.y,
          meetTick: leg.rv.meetTick,
          followShipId: leg.rv.followShipId,
        },
      } : {}),
      dvPrograde: leg.totalDv,
      fuelCost: Math.round(leg.totalDv * 10),
      replace: true,
    },
  };
}
