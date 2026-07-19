// ============================================================
// systemGrouping — "which star system does this body belong to", and
// the single-most-relevant status label for a ship.
//
// Extracted from FleetPanel so the Outliner shows the SAME system
// headers and the SAME ship statuses. Two copies of this logic would
// drift, and a hull reading "In Combat" in one panel and "Orbiting" in
// the other is exactly the kind of contradiction that makes players
// stop trusting the UI.
// ============================================================

import type { Body, Ship } from '../types';
import { AUTO_COMBAT_INTERVAL } from './combat';

/** Barycenter anchors orbit Sol on a fake, effectively-infinite period
 *  so the "every non-root orbits something" rule holds. Any period at
 *  this scale means "not a real orbit" — real bodies top out near 1.7e4
 *  (and ~4.7e4 after the 2x system scale), so there's no ambiguity. */
const PRETEND_ORBIT_PERIOD = 1e9;

/** A body roots its own star system when it orbits nothing (Sol) or is
 *  a barycenter anchor pinned to Sol by a pretend orbit. Without the
 *  period check, walking the parent chain files Centauri and Cygnus
 *  under Sol. */
export function isSystemRoot(b: Body): boolean {
  return !b.parent || b.orbitPeriod >= PRETEND_ORBIT_PERIOD;
}

/**
 * Build a memoized `bodyId -> system root id` resolver over a body list.
 * Cycle-guarded: a malformed parent chain degrades to "own system"
 * rather than hanging the panel.
 */
export function makeSystemRootOf(bodies: Body[]): (bodyId: string) => string {
  const byId = new Map(bodies.map(b => [b.id, b]));
  const cache = new Map<string, string>();
  return (bodyId: string): string => {
    const hit = cache.get(bodyId);
    if (hit) return hit;
    const chain: string[] = [];
    let cur = byId.get(bodyId);
    const seen = new Set<string>();
    while (cur && !isSystemRoot(cur) && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    const root = cur?.id ?? bodyId;
    for (const id of chain) cache.set(id, root);
    cache.set(bodyId, root);
    return root;
  };
}

/** "Centauri Barycenter" is the anchor's name, but the SYSTEM is just
 *  "Centauri" — drop the bookkeeping noun for the header. */
export function systemLabel(bodies: Body[], rootId: string): string {
  const root = bodies.find(b => b.id === rootId);
  if (!root) return rootId.toUpperCase();
  return `${root.name.replace(/\s*Barycenter$/i, '')} System`;
}

/** A ship counts as "In Combat" if it fired OR took a hit within this
 *  many ticks. Auto-combat resolves a volley every AUTO_COMBAT_INTERVAL
 *  ticks, so 2x gives one volley of grace — the badge stays lit between
 *  salvoes and clears a couple of ticks after the last shot. */
export const COMBAT_RECENT_TICKS = AUTO_COMBAT_INTERVAL * 2;

export type ShipStatus = { label: string; cls: string; title: string };

/**
 * Single most-relevant status for a ship, in precedence order. A ship in
 * flight can't be in auto-combat (that only happens between hulls sharing
 * a body), so transit/combat are mutually exclusive and the ordering is
 * safe.
 */
export function shipStatus(ship: Ship, currentTick: number, hpRatio: number): ShipStatus {
  if (ship.transit) {
    // Auto-retreat fires a server-side transfer to the nearest friendly
    // shipyard once HP falls to the threshold, so a below-threshold ship
    // in flight is fleeing, not making a routine trip.
    if (ship.retreatHpPct != null && hpRatio <= ship.retreatHpPct / 100) {
      return { label: 'Retreating', cls: 'retreating', title: 'Auto-retreating to a friendly shipyard (HP below threshold)' };
    }
    return { label: 'In Transit', cls: 'transit', title: 'Under torch burn between bodies' };
  }
  const lastActive = Math.max(ship.lastCombatTick ?? -Infinity, ship.lastDamagedTick ?? -Infinity);
  if (currentTick - lastActive <= COMBAT_RECENT_TICKS) {
    return { label: 'In Combat', cls: 'combat', title: 'Fired or took fire in the last few ticks' };
  }
  if (ship.plannedTransit) {
    return { label: 'Planned', cls: 'planned', title: 'A transfer is planned but not yet committed' };
  }
  if (ship.stance === 'hold') {
    return { label: 'Holding Fire', cls: 'holding', title: 'Standing order: never fire' };
  }
  return { label: 'Orbiting', cls: 'orbiting', title: 'Parked in a stable orbit' };
}
