// ============================================================
// systemGrouping — "which PLANETARY system does this body belong to",
// and the single-most-relevant status label for a ship.
//
// Extracted from FleetPanel so the Outliner shows the SAME system
// headers and the SAME ship statuses. Two copies of this logic would
// drift, and a hull reading "In Combat" in one panel and "Orbiting" in
// the other is exactly the kind of contradiction that makes players
// stop trusting the UI.
//
// Grouping is PLANETARY, not stellar: "Jupiter System" (Jupiter + the
// Galileans), "Saturn System", "Earth System" (Earth + Luna). Grouping
// by star instead puts every body in the game under one "Sol System"
// header, which sorts nothing and tells the player nothing.
// ============================================================

import type { Body, Ship } from '../types';
import { AUTO_COMBAT_INTERVAL } from './combat';

/** Barycenter anchors orbit Sol on a fake, effectively-infinite period
 *  so the "every non-root orbits something" rule holds. Any period at
 *  this scale means "not a real orbit" — real bodies top out near 1.7e4
 *  (and ~4.7e4 after the 2x system scale), so there's no ambiguity. */
const PRETEND_ORBIT_PERIOD = 1e9;

/** A star, black hole, or barycenter anchor — the thing planets orbit.
 *  These do NOT head a planetary system; they're the level above it. */
export function isStellarAnchor(b: Body): boolean {
  return !b.parent
    || b.type === 'star'
    || b.type === 'black_hole'
    || b.orbitPeriod >= PRETEND_ORBIT_PERIOD;
}

/**
 * Build a memoized `bodyId -> planetary-system root id` resolver.
 *
 * The root is the body one level BELOW the stellar anchor: walk up until
 * the next step would land on a star/barycenter, and stop there. So Titan
 * and Enceladus both root to Saturn, while Saturn roots to itself. Bodies
 * that orbit the star directly (Ceres, lone asteroids) root to themselves.
 *
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
    // Climb while the CURRENT body still has a non-stellar parent — i.e.
    // stop on the body whose parent is the star. Stars themselves fall
    // straight through and root to themselves.
    while (cur && !isStellarAnchor(cur) && !seen.has(cur.id)) {
      const parent = cur.parent ? byId.get(cur.parent) : undefined;
      if (!parent || isStellarAnchor(parent)) break;
      seen.add(cur.id);
      chain.push(cur.id);
      cur = parent;
    }
    const root = cur?.id ?? bodyId;
    for (const id of chain) cache.set(id, root);
    cache.set(bodyId, root);
    return root;
  };
}

/**
 * Header for a planetary system.
 *
 * Only bodies that actually hold satellites get the "System" suffix —
 * "Jupiter System" reads right because there are four moons under it,
 * but "Midas System" for a bare asteroid is pretend grandeur for a
 * single rock. Those show as just "Midas".
 *
 * A star is never a "System" either: its planets each root to themselves,
 * so Sol's bucket contains nothing but Sol. Labelling that "Sol System"
 * would promise the whole solar system and deliver one star.
 */
export function systemLabel(bodies: Body[], rootId: string): string {
  const root = bodies.find(b => b.id === rootId);
  if (!root) return rootId.toUpperCase();
  const name = root.name.replace(/\s*Barycenter$/i, '');
  if (isStellarAnchor(root)) return name;
  const hasSatellites = bodies.some(b => b.parent === rootId);
  return hasSatellites ? `${name} System` : name;
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
