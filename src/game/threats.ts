// ============================================================
// Threat detection — identify hostile ships in transit whose
// arrival body contains a target faction's ships or settlements.
// ============================================================

import { GameState } from '../types';

export interface IncomingThreat {
  attackerShipId: string;
  attackerName: string;
  attackerClass: string;
  attackerFaction: string;
  targetBodyId: string;
  targetBodyName: string;
  arrivalTime: number;
  ticksUntilArrival: number;
  threatenedShipCount: number;
  threatenedSettlementCount: number;
  /** Friendly names of the settlements at risk — for UI display. */
  threatenedSettlementNames: string[];
}

/**
 * Compute the list of hostile ships currently in transit whose destination
 * contains assets of `forFaction`. Returned threats are sorted by arrival
 * time, soonest first.
 */
export function computeIncomingThreats(
  gameState: GameState,
  forFaction: string,
): IncomingThreat[] {
  const threats: IncomingThreat[] = [];
  for (const ship of gameState.ships) {
    if (!ship.transfer) continue;
    if (ship.ownedBy === forFaction) continue;

    const targetBodyId = ship.transfer.arrivalBodyId;

    // Count target-faction assets at the destination body
    const threatenedShips = gameState.ships.filter(
      s => s.ownedBy === forFaction && !s.transfer && s.orbit.parentBodyId === targetBodyId,
    );
    const threatenedSettlements = gameState.settlements.filter(
      s => s.ownedBy === forFaction && s.bodyId === targetBodyId,
    );
    if (threatenedShips.length === 0 && threatenedSettlements.length === 0) continue;

    const body = gameState.bodies.find(b => b.id === targetBodyId);
    threats.push({
      attackerShipId: ship.id,
      attackerName: ship.name,
      attackerClass: ship.class,
      attackerFaction: ship.ownedBy,
      targetBodyId,
      targetBodyName: body?.name ?? targetBodyId,
      arrivalTime: ship.transfer.arrivalTime,
      ticksUntilArrival: Math.max(0, ship.transfer.arrivalTime - gameState.currentTick),
      threatenedShipCount: threatenedShips.length,
      threatenedSettlementCount: threatenedSettlements.length,
      threatenedSettlementNames: threatenedSettlements.map(s => s.name),
    });
  }
  return threats.sort((a, b) => a.ticksUntilArrival - b.ticksUntilArrival);
}

/**
 * Return the set of body IDs that have at least one incoming hostile threat
 * — convenient for renderer code that wants to flag threatened bodies.
 */
export function threatenedBodyIds(threats: IncomingThreat[]): Set<string> {
  const out = new Set<string>();
  for (const t of threats) out.add(t.targetBodyId);
  return out;
}
