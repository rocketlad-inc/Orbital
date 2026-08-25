// ============================================================
// useBulkTransfer
//
// "Send these N ships to that body" — the loop behind every group
// move: plan a torch burn per hull, post it, and collect the server's
// per-ship rejections into one summary the caller can show.
//
// Extracted because this shape had been copy-pasted three times in
// FleetPanel (bulk transfer, fleet move, send-damaged-to-yards) and
// the map's shift-click group order would have made a fourth.
//
// Torch model: this fires the burn immediately, with no plan/commit
// preview step — the same choice FleetPanel's bulk button already
// made. Players who want the preview use the per-ship Transfer flow
// in ShipPanel.
// ============================================================

import { useCallback } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { launchFromPlan } from '../physics/torchTransfer';

export interface BulkTransferResult {
  /** Ships we managed to plan a burn for and posted to the server. */
  issued: number;
  /** Ships whose torch plan couldn't be built at all (no engine, no
   *  fuel, unreachable) — rejected before anything was sent. */
  unplannable: number;
  /** Human-readable server rejections, filled in asynchronously as the
   *  posts resolve (see the note on onRejection). */
  rejections: string[];
}

/**
 * Returns `run(shipIds, destBodyId, onRejection?)`.
 *
 * The returned counts are SYNCHRONOUS (what we planned and posted).
 * Server rejections land later — each ship's post resolves on its own,
 * so pass `onRejection` to render a running summary as they arrive
 * rather than awaiting a batch that has no single completion moment.
 */
export function useBulkTransfer() {
  const { gameState, launchTorchTransfer } = useGameContext();
  const mpActions = useMultiplayerActions();

  return useCallback(
    (
      shipIds: string[],
      destBodyId: string,
      onRejection?: (message: string, soFar: number, total: number) => void,
    ): BulkTransferResult => {
      const result: BulkTransferResult = { issued: 0, unplannable: 0, rejections: [] };
      const target = gameState.bodies.find(b => b.id === destBodyId);
      if (!target) return result;

      // A FLEET MOVES WHOLE. Selecting three hulls of a five-ship
      // squadron and hitting SEND used to fly three and leave two
      // behind — the formation coming apart with nothing on screen
      // saying so, which is the same bug the orders endpoint had.
      // Expanding here covers every caller: the group bar, the fleet
      // panel's bulk transfer, and send-damaged-to-yards.
      const fleets = new Set(
        shipIds
          .map(id => { const sh = gameState.ships.find(s => s.id === id); return sh?.fleetDetached ? null : sh?.fleetId; })
          .filter((f): f is string => !!f),
      );
      const expanded = fleets.size > 0
        ? [...new Set([
            ...shipIds,
            ...gameState.ships.filter(s => s.fleetId && fleets.has(s.fleetId) && !s.fleetDetached).map(s => s.id),
          ])]
        : shipIds;

      for (const sid of expanded) {
        const ship = gameState.ships.find(s => s.id === sid);
        if (!ship) { result.unplannable += 1; continue; }
        const plan = launchTorchTransfer(ship.id, destBodyId);
        if (!plan) { result.unplannable += 1; continue; }
        result.issued += 1;
        if (!mpActions) continue;          // SP: the local launch above is the whole move
        mpActions.transfer({
          shipId: ship.id,
          targetBodyId: plan.targetBodyId,
          scheduledT: plan.startTick,
          arrivalT: plan.arriveTick,
          launch: launchFromPlan(plan),
          dvPrograde: plan.totalDv,
          fuelCost: Math.round(plan.totalDv * 10),
          replace: true,
        }).then(res => {
          if (res.ok) return;
          const msg = humanizeMpError(res.code, res.error, 'transfer');
          result.rejections.push(msg);
          onRejection?.(msg, result.rejections.length, expanded.length);
        });
      }
      return result;
    },
    [gameState.bodies, gameState.ships, launchTorchTransfer, mpActions],
  );
}
