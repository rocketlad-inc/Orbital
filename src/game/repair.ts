// ============================================================
// Ship repair helpers — the client half of the repair loop.
//
// Server rules (worker/room.js, maintenance pass): a hull parked at a
// body with a friendly STATION heals 2 HP/tick plus 5 per SHIPYARD level
// on that station, up to its rank/armor-buffed cap; Damage Control
// (armor 5) adds a trickle anywhere. The auto-retreat standing order
// routes hulls to the nearest friendly body whose station has a SHIPYARD
// (a proper dry dock) — which is now also where repair is fastest.
//
// These helpers mirror that server-side "nearest shipyard" choice so
// the one-shot "Send to shipyard" buttons (ShipPanel, FleetPanel) pick
// the same destination the auto-retreat would.
// ============================================================

import { Body, Settlement, Ship } from '../types';
import { bodyPosition } from '../physics/orbitalMechanics';

/** Bodies where `ownedBy` has a living station with a shipyard (≥1) —
 *  the same destination filter the server's auto-retreat uses. */
export function shipyardBodyIds(settlements: Settlement[], ownedBy: string): Set<string> {
  const out = new Set<string>();
  for (const s of settlements) {
    if (s.type !== 'station' || s.ownedBy !== ownedBy) continue;
    if (s.hp <= 0) continue;
    if ((s.buildings?.shipyard ?? 0) >= 1) out.add(s.bodyId);
  }
  return out;
}

/** Nearest shipyard body for a parked ship, by world distance at `tick`
 *  (straight-line, matching the server's retreat pass). Returns null if
 *  the faction has no yards, or the only yard is where the ship already
 *  sits (no move to make — station repair is already running). */
export function nearestShipyardBodyId(
  ship: Ship,
  settlements: Settlement[],
  bodies: Body[],
  tick: number,
): string | null {
  const yards = shipyardBodyIds(settlements, ship.ownedBy);
  if (yards.size === 0) return null;
  const here = bodies.find(b => b.id === ship.orbit.parentBodyId);
  if (!here) return null;
  const herePos = bodyPosition(here, tick, bodies);
  let best: string | null = null;
  let bestD2 = Infinity;
  for (const yardId of yards) {
    if (yardId === ship.orbit.parentBodyId) return null; // already home
    const yb = bodies.find(b => b.id === yardId);
    if (!yb) continue;
    const p = bodyPosition(yb, tick, bodies);
    const dx = p.x - herePos.x;
    const dy = p.y - herePos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = yardId; }
  }
  return best;
}

/** Damaged = below base max hull. (The repair cap can sit above hpMax
 *  with rank/armor bonuses, but "visibly dinged" is the intuitive bar
 *  for sending a ship home.) */
export function isDamagedShip(ship: Ship): boolean {
  const max = ship.hpMax ?? 0;
  return max > 0 && (ship.hp ?? max) < max;
}
