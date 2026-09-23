// ============================================================
// useBulkChain
//
// "These N ships all fly this whole route" — the multi-leg sibling of
// useBulkTransfer. Where that hook sends a group to one body, this one
// sends a group through an ordered chain of legs and waits.
//
// Each ship gets its OWN solution to the chain, not a copy of one
// ship's plan: they start from different orbits, so leg 1 differs, and
// every later leg chains off that ship's own arrival. Only the
// ITINERARY is shared.
//
// Posting order matters. The first leg goes up with replace:true, which
// cancels whatever that hull was already doing server-side; the rest
// append with replace:false. Every leg of every hull now goes in ONE
// POST /transfers, which the server applies in order (so the replace
// always lands first) and which refuses a hull's later legs once an
// earlier one is refused, as posting them one by one used to.
// ============================================================

import { useCallback } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions, TransferIntent } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { launchFromPlan } from '../physics/torchTransfer';
import { planChainLegs, ChainStep } from '../physics/chainPlanner';
import { orbitWorldPos, orbitWorldVelocity } from '../physics/orbitalMechanics';
import { fleetEngineAccel } from '../game/fleetPace';

export interface BulkChainResult {
  /** Ships whose full chain was solved and posted. */
  issued: number;
  /** Ships we could not solve even the first leg for. */
  unplannable: number;
  /** Ships that got a SHORTER chain than asked for — the planner ran
   *  out somewhere in the middle. Reported because a silently truncated
   *  route is a ship parked somewhere nobody meant to leave it. */
  truncated: number;
}

export type { ChainStep };

/**
 * Returns `run(shipIds, steps, onRejection?)`.
 *
 * Counts are synchronous (what we solved and dispatched). Server
 * rejections arrive later, per ship, via `onRejection`.
 */
export function useBulkChain() {
  const { gameState } = useGameContext();
  const mpActions = useMultiplayerActions();

  return useCallback(
    (
      shipIds: string[],
      steps: ChainStep[],
      onRejection?: (message: string) => void,
    ): BulkChainResult => {
      const result: BulkChainResult = { issued: 0, unplannable: 0, truncated: 0 };
      if (steps.length === 0) return result;

      // A FLEET FLIES THE WHOLE ROUTE. Same expansion useBulkTransfer
      // does: naming any member of a squadron commits all of it, or a
      // chain issued to a selection would split the formation at the
      // first leg.
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

      const intents: TransferIntent[] = [];
      for (const sid of expanded) {
        const ship = gameState.ships.find(s => s.id === sid);
        if (!ship) { result.unplannable += 1; continue; }

        // AT THE FLEET'S PACE. This used each hull's own engine, so a
        // squadron sent down a route split up at the first leg, fast
        // hulls ahead — the bug the single-destination paths already
        // fixed (fleetPace.ts). Loose hulls fly at their own rating.
        const accel = fleetEngineAccel(ship, gameState.ships, gameState.factions, gameState.factionTech);

        const tick = gameState.currentTick;
        const legs = planChainLegs({
          startPos: orbitWorldPos(ship.orbit, tick, gameState.bodies),
          startVel: orbitWorldVelocity(ship.orbit, tick, gameState.bodies),
          startTick: tick,
          parkedAtBodyId: ship.orbit?.parentBodyId ?? null,
          steps,
          bodies: gameState.bodies,
          accel,
        });

        if (legs.length === 0) { result.unplannable += 1; continue; }
        if (legs.length < steps.length) result.truncated += 1;
        result.issued += 1;

        if (!mpActions) continue;  // SP has no server to tell.
        legs.forEach((leg, i) => intents.push({
          shipId: ship.id,
          targetBodyId: leg.targetBodyId,
          scheduledT: leg.startTick,
          arrivalT: leg.arriveTick,
          launch: launchFromPlan(leg),
          dvPrograde: leg.totalDv,
          fuelCost: Math.round(leg.totalDv * 10),
          replace: i === 0,
        }));
      }
      if (mpActions && intents.length > 0) {
        void mpActions.transferMany(intents).then(results => {
          // One message per hull, not per leg: a refused first leg
          // refuses the rest of its route too (chain_broken).
          const told = new Set<string>();
          results.forEach((res, k) => {
            if (res.ok || told.has(intents[k].shipId)) return;
            told.add(intents[k].shipId);
            onRejection?.(humanizeMpError(res.code, res.error, 'transfer'));
          });
        });
      }
      return result;
    },
    [gameState, mpActions],
  );
}
