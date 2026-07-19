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

/**
 * The inner system reads as one place, not three. Sol, Mercury and Venus
 * are close enough that splitting them into three headers — two of which
 * are a single scorched rock apiece — is noise. They group as "The Core".
 *
 * Earth and Mars stay their own systems: both hold satellites, both are
 * somewhere you actually campaign, and folding them in would bury them.
 */
export const CORE_SYSTEM_ID = 'core';
const CORE_MEMBER_IDS = new Set(['sol', 'mercury', 'venus']);
const CORE_LABEL = 'The Core';

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
    const rawRoot = cur?.id ?? bodyId;
    // Sol/Mercury/Venus collapse into one synthetic root. Applied to the
    // ROOT, not the body, so a hypothetical moon of Venus follows its
    // planet into the Core instead of heading a system of its own.
    const root = CORE_MEMBER_IDS.has(rawRoot) ? CORE_SYSTEM_ID : rawRoot;
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
  // Synthetic root — no body carries this id, so name it before the
  // lookup below falls through to shouting the raw id.
  if (rootId === CORE_SYSTEM_ID) return CORE_LABEL;
  const root = bodies.find(b => b.id === rootId);
  if (!root) return rootId.toUpperCase();
  const name = root.name.replace(/\s*Barycenter$/i, '');
  if (isStellarAnchor(root)) return name;
  const hasSatellites = bodies.some(b => b.parent === rootId);
  return hasSatellites ? `${name} System` : name;
}

/** Legacy fallback window, used only when a caller can't supply presence
 *  info. See shipStatus for why a timestamp alone is a poor combat test. */
export const COMBAT_RECENT_TICKS = AUTO_COMBAT_INTERVAL * 2;

export type ShipStatus = { label: string; cls: string; title: string };

/**
 * Is anyone hostile sharing this body right now?
 *
 * Mirrors combat.ts: hostilities need two factions co-located, and both
 * ships and settlements count as combatants. Ships under burn are excluded
 * — they haven't arrived, so they aren't fighting anyone yet.
 */
export function makeHostilesAtBody(
  ships: Ship[],
  settlements: { bodyId: string; ownedBy: string }[],
): (bodyId: string, ownedBy: string) => boolean {
  const owners = new Map<string, Set<string>>();
  const add = (bodyId: string, owner: string) => {
    let set = owners.get(bodyId);
    if (!set) { set = new Set(); owners.set(bodyId, set); }
    set.add(owner);
  };
  for (const s of ships) if (!s.transit) add(s.orbit.parentBodyId, s.ownedBy);
  for (const st of settlements) add(st.bodyId, st.ownedBy);
  return (bodyId, ownedBy) => {
    const set = owners.get(bodyId);
    if (!set) return false;
    for (const o of set) if (o !== ownedBy) return true;
    return false;
  };
}

/**
 * Single most-relevant status for a ship, in precedence order. A ship in
 * flight can't be in auto-combat (that only happens between hulls sharing
 * a body), so transit/combat are mutually exclusive and the ordering is
 * safe.
 *
 * `hostilesPresent` is what actually decides "In Combat". The old test —
 * "fired or was hit within COMBAT_RECENT_TICKS" — latched the badge onto
 * ships sitting alone in a quiet orbit for six ticks after the shooting
 * stopped, which at an hour per tick is most of a day claiming a battle
 * that already ended. Combat is a property of the CURRENT situation: if a
 * hostile shares the body, a volley is coming; if not, the fight is over
 * no matter what the timestamps say.
 */
export function shipStatus(
  ship: Ship,
  currentTick: number,
  hpRatio: number,
  hostilesPresent?: boolean,
): ShipStatus {
  if (ship.transit) {
    // Auto-retreat fires a server-side transfer to the nearest friendly
    // shipyard once HP falls to the threshold, so a below-threshold ship
    // in flight is fleeing, not making a routine trip.
    if (ship.retreatHpPct != null && hpRatio <= ship.retreatHpPct / 100) {
      return { label: 'Retreating', cls: 'retreating', title: 'Auto-retreating to a friendly shipyard (HP below threshold)' };
    }
    return { label: 'In Transit', cls: 'transit', title: 'Under torch burn between bodies' };
  }
  // Holding fire outranks combat: a ship under a never-fire standing order
  // isn't fighting, and saying "In Combat" would hide the very order that
  // explains why it's sitting there taking hits.
  if (ship.stance === 'hold') {
    return { label: 'Holding Fire', cls: 'holding', title: 'Standing order: never fire' };
  }
  const contested = hostilesPresent ?? (
    // No presence info — fall back to the old timestamp window.
    currentTick - Math.max(ship.lastCombatTick ?? -Infinity, ship.lastDamagedTick ?? -Infinity)
      <= COMBAT_RECENT_TICKS
  );
  if (contested) {
    return { label: 'In Combat', cls: 'combat', title: 'A hostile force shares this orbit' };
  }
  if (ship.plannedTransit) {
    return { label: 'Planned', cls: 'planned', title: 'A transfer is planned but not yet committed' };
  }
  return { label: 'Orbiting', cls: 'orbiting', title: 'Parked in a stable orbit' };
}
