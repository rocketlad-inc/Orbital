// ============================================================
// LEFT UNDEFENDED — which of your worlds a group order strips bare.
//
// A playtester sent all four home warships to Centauri A with one
// click (Fleet -> select 4 warships -> ISSUE 4 ORDERS): no question, no
// trip time, nothing saying the capital now had no guard, and the burn
// could not be undone a tick later. The send buttons ask first when
// this returns anything.
//
// Pure, so the rule is pinned by a test rather than by a component.
// ============================================================

import type { Settlement, Ship } from '../types';
import { isArmed } from './systemGrouping';

/** A fleet moves whole (useBulkTransfer expands a partial pick to the
 *  full formation), so the "who leaves" question must expand the same
 *  way or a half-picked fleet would hide the hulls that go with it. */
export function expandFleetIds(shipIds: string[], ships: Ship[]): string[] {
  const byId = new Map(ships.map(s => [s.id, s]));
  const fleets = new Set(
    shipIds
      .map(id => { const sh = byId.get(id); return sh?.fleetDetached ? null : sh?.fleetId; })
      .filter((f): f is string => !!f),
  );
  if (fleets.size === 0) return shipIds;
  return [...new Set([
    ...shipIds,
    ...ships.filter(s => s.fleetId && fleets.has(s.fleetId) && !s.fleetDetached).map(s => s.id),
  ])];
}

/**
 * Body ids of worlds `owner` holds a settlement at that would have no
 * armed hull of theirs parked there once `leavingIds` set off for
 * `destBodyId`. Only worlds a leaving warship is parked at count:
 * a world that was already unguarded is not this order's doing.
 */
export function worldsLeftUndefended(
  leavingIds: string[],
  destBodyId: string,
  ships: Ship[],
  settlements: Settlement[],
  owner: string = 'player',
): string[] {
  const leaving = new Set(leavingIds);
  const held = new Set(settlements.filter(s => s.ownedBy === owner).map(s => s.bodyId));
  const stripped = new Set<string>();
  for (const s of ships) {
    if (!leaving.has(s.id) || s.ownedBy !== owner || s.transit || !isArmed(s)) continue;
    const at = s.orbit?.parentBodyId;
    if (at && at !== destBodyId && held.has(at)) stripped.add(at);
  }
  for (const s of ships) {
    if (leaving.has(s.id) || s.ownedBy !== owner || s.transit || !isArmed(s)) continue;
    stripped.delete(s.orbit?.parentBodyId);
  }
  return [...stripped];
}
