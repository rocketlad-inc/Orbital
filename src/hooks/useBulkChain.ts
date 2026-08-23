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
// Posting order matters and is why this is async per ship. The first
// leg goes up with replace:true, which cancels whatever that hull was
// already doing server-side; the rest append with replace:false. Post
// them concurrently and an append can land before the replace and be
// cancelled by it — the same race commitTransferLocal awaits around.
// ============================================================

import { useCallback } from 'react';
import { useGameContext } from '../state/gameContext';
import { useMultiplayerActions } from '../multiplayer/MultiplayerActionsContext';
import { humanizeMpError } from '../multiplayer/errorMessages';
import { launchFromPlan } from '../physics/torchTransfer';
import { planChainLegs, ChainStep } from '../physics/chainPlanner';
import { orbitWorldPos, orbitWorldVelocity } from '../physics/orbitalMechanics';
import { fromG, DEFAULT_ENGINE_G } from '../physics/torchTransfer';
import { engineGModifier } from '../game/techs';
import { engineAccelMultiplier } from '../game/shipParts';

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

      for (const sid of shipIds) {
        const ship = gameState.ships.find(s => s.id === sid);
        if (!ship) { result.unplannable += 1; continue; }

        // Same accel derivation the single-ship planner uses: faction
        // engine rating x tech x fitted engine parts.
        const faction = gameState.factions.find(f => f.id === ship.ownedBy);
        const tech = gameState.factionTech?.[ship.ownedBy];
        const accel = fromG(faction?.engineG ?? DEFAULT_ENGINE_G)
          * engineGModifier(tech)
          * engineAccelMultiplier(ship.parts, tech?.levels?.propulsion ?? 0);

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

        // Sequential per ship: the replace must land before the appends.
        void (async () => {
          for (let i = 0; i < legs.length; i += 1) {
            const leg = legs[i];
            const res = await mpActions.transfer({
              shipId: ship.id,
              targetBodyId: leg.targetBodyId,
              scheduledT: leg.startTick,
              arrivalT: leg.arriveTick,
              launch: launchFromPlan(leg),
              dvPrograde: leg.totalDv,
              fuelCost: Math.round(leg.totalDv * 10),
              replace: i === 0,
            });
            if (!res.ok) {
              onRejection?.(humanizeMpError(res.code, res.error, 'transfer'));
              // Stop this ship's chain: later legs were solved assuming
              // this one flies. Posting them anyway would leave a hull
              // with a route whose first move never happened.
              break;
            }
          }
        })();
      }
      return result;
    },
    [gameState, mpActions],
  );
}
