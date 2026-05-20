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
  /** Tick the burn started — used to flag freshly-detected threats. */
  departureTime: number;
  ticksUntilArrival: number;
  /** True when the burn began in the last FRESH_BURN_WINDOW ticks. The
   *  UI surfaces these with a "BURN INBOUND" pulse so the player sees
   *  the moment a hostile actually commits an attack. */
  isFreshBurn: boolean;
  threatenedShipCount: number;
  threatenedSettlementCount: number;
  /** True when the target body is owned by the player but currently
   *  has no ships or settlements stationed there. The threat is still
   *  meaningful (incoming claim-jumper) but the UI can phrase it
   *  differently than "your X ships are under attack". */
  targetBodyOwned: boolean;
  /** Friendly names of the settlements at risk — for UI display. */
  threatenedSettlementNames: string[];
}

/** A burn that started within this many ticks of "now" counts as
 *  freshly-detected. At the 7.5-min/tick cadence, 20 ticks ≈ 2.5 real
 *  hours — long enough to span a sim-speed-up but short enough that
 *  the player still feels the alert is "new". */
const FRESH_BURN_WINDOW = 20;

/**
 * Compute the list of hostile ships currently in transit whose
 * destination is meaningful to `forFaction`. A target is meaningful
 * if any of these hold at the arrival body:
 *   - forFaction has a ship orbiting there
 *   - forFaction has a settlement there
 *   - the body itself is owned by forFaction (claim-jumper case)
 *
 * Returned threats are sorted by arrival time, soonest first.
 */
export function computeIncomingThreats(
  gameState: GameState,
  forFaction: string,
): IncomingThreat[] {
  const threats: IncomingThreat[] = [];
  for (const ship of gameState.ships) {
    if (!ship.transfer) continue;
    // Self-filter — the original sensitivity bug was that own ships
    // were firing threats. Keep this guard tight.
    if (ship.ownedBy === forFaction) continue;

    const targetBodyId = ship.transfer.arrivalBodyId;
    const body = gameState.bodies.find(b => b.id === targetBodyId);

    // Three ways the target body matters to forFaction:
    const threatenedShips = gameState.ships.filter(
      s => s.ownedBy === forFaction && !s.transfer && s.orbit.parentBodyId === targetBodyId,
    );
    const threatenedSettlements = gameState.settlements.filter(
      s => s.ownedBy === forFaction && s.bodyId === targetBodyId,
    );
    const bodyOwned = body?.ownedBy === forFaction;
    if (
      threatenedShips.length === 0 &&
      threatenedSettlements.length === 0 &&
      !bodyOwned
    ) continue;

    threats.push({
      attackerShipId: ship.id,
      attackerName: ship.name,
      attackerClass: ship.class,
      attackerFaction: ship.ownedBy,
      targetBodyId,
      targetBodyName: body?.name ?? targetBodyId,
      arrivalTime: ship.transfer.arrivalTime,
      departureTime: ship.transfer.departureTime,
      ticksUntilArrival: Math.max(0, ship.transfer.arrivalTime - gameState.currentTick),
      isFreshBurn: gameState.currentTick - ship.transfer.departureTime <= FRESH_BURN_WINDOW,
      threatenedShipCount: threatenedShips.length,
      threatenedSettlementCount: threatenedSettlements.length,
      targetBodyOwned: bodyOwned,
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
