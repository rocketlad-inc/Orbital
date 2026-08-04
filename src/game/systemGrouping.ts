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
import { getShipClass } from './shipClasses';

/** A hull is "armed" if it actually deals damage — server-authoritative
 *  damagePerTick when present (designer builds can arm OR disarm ANY
 *  class, so a freighter can carry guns and a "warship" can be stripped),
 *  else the class default. A stock freighter is 0 → unarmed. Combat
 *  status keys off THIS, not the class name. */
export function isArmed(s: Ship): boolean {
  return (s.damagePerTick ?? getShipClass(s.class).damagePerTick) > 0;
}

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
/** Exported so the MAP's region shading (render/systemRegions) collapses
 *  the same three bodies the panels do. Two lists would drift, and the
 *  map disagreeing with the outliner about what "The Core" contains is
 *  worse than not grouping at all. */
export const CORE_MEMBER_IDS = new Set(['sol', 'mercury', 'venus']);
export const CORE_LABEL = 'The Core';

/** A star, black hole, or barycenter anchor — the thing planets orbit.
 *  These do NOT head a planetary system; they're the level above it. */
export function isStellarAnchor(b: Body): boolean {
  return !b.parent
    || b.type === 'star'
    || b.type === 'black_hole'
    || b.orbitPeriod >= PRETEND_ORBIT_PERIOD;
}

// ---------------------------------------------------------------------------
// Belts
//
// A run of rubble in neighbouring orbits is ONE place. Fifteen dwarf
// planets each heading their own "system" is not a map of the solar
// system, it's a list of rocks — and it let a player buy fifteen senate
// votes by grabbing fifteen pebbles nobody would ever fight over.
//
// These constants and this clustering were already live in
// render/systemRegions.ts, where the map has drawn "Asteroid Belt" and
// "Kuiper Belt" lanes for a while. They moved here so the panels, the
// outliner, the map and the SENATE all group identically — the map
// saying "Asteroid Belt" while the outliner listed eight separate
// systems was the drift this closes.
// ---------------------------------------------------------------------------

/** Adjacent-orbit ratio below which two rocks belong to the same belt.
 *  Keeps the dense runs intact while leaving genuine long-range rogues
 *  (Black Sky, Vagrant, Sedna) as their own islands — they orbit alone,
 *  and calling them "the belt" would claim a neighbourhood that isn't
 *  there. */
export const BELT_RATIO = 1.25;

/** Fewer than this and it's a pair of neighbours, not a belt. */
export const BELT_MIN_MEMBERS = 3;

/** Rubble — the only things that form belts. */
export function isBeltable(b: Body): boolean {
  return b.type === 'asteroid' || b.type === 'dwarf';
}

/** Apoapsis:periapsis beyond which an orbit is a crossing trajectory
 *  rather than a lane. Circular bodies carry no rp/ra at all, so this
 *  only ever judges the seeded rogues. */
const ROGUE_ECCENTRICITY_RATIO = 1.5;

/**
 * A rogue on a long elliptical orbit doesn't occupy a RING — it crosses
 * a dozen. Black Sky runs 400 -> 4000, Vagrant 500 -> 5300, Augustín
 * 600 -> 7000, each sweeping from inside the asteroid belt out past
 * Eris, yet each carries a single nominal orbitRadius that lane maths
 * would treat as its home ring.
 *
 * This test exists ONLY to keep them out of belt GEOMETRY. Shading the
 * ring their nominal radius implies claims territory the rock doesn't
 * hold, and — because those nominal values collide with real planets —
 * painted a second coat over Uranus and Pluto. Every overlapping border
 * in the live outer system traced to exactly these three.
 *
 * They ARE belt members for every other purpose: a Kuiper object is a
 * Kuiper object, and the senate counts it toward the belt. See
 * Belt.laneMembers vs Belt.members.
 */
export function isEccentricRogue(b: Body): boolean {
  const rp = b.orbit_rp;
  const ra = b.orbit_ra;
  if (rp == null || ra == null || rp <= 0) return false;
  return ra > rp * ROGUE_ECCENTRICITY_RATIO;
}

export type Belt = {
  /** Synthetic system root id. Matches systemRegions' region id scheme. */
  id: string;
  label: string;
  /** Everyone in the belt, rogues included. Grouping, ownership, votes. */
  members: Body[];
  /** Only the rocks that occupy the belt's actual ring — what the
   *  political wash shades and what sets the lane's radial extent.
   *  A rogue belongs to the belt but holds none of its ring. */
  laneMembers: Body[];
};

/**
 * Cluster star-orbiting rubble into belts.
 *
 * Naming is STRUCTURAL, not a hard-coded body list: a belt whose median
 * orbit sits inside the outermost planet system is an asteroid belt,
 * beyond it a Kuiper belt. That keeps working for any seeded system,
 * not just Sol.
 */
export function findBelts(bodies: Body[]): Belt[] {
  const childCount = new Map<string, number>();
  for (const b of bodies) {
    if (b.parent) childCount.set(b.parent, (childCount.get(b.parent) ?? 0) + 1);
  }
  const anchors = new Set(bodies.filter(isStellarAnchor).map(b => b.id));

  // Star-orbiting rubble with no satellites of its own. A rock with a
  // moon (Pluto/Charon) is a system, not rubble.
  const isRubble = (b: Body) =>
    !!b.parent && anchors.has(b.parent) && !childCount.get(b.id) && isBeltable(b);

  // Clustering runs on ring-dwellers ONLY. A rogue's nominal radius is a
  // fiction, so letting it into the chain would drag a belt's extent
  // across half the outer system and, worse, decide the chain breaks.
  const rubble = bodies
    .filter(b => isRubble(b) && !isEccentricRogue(b))
    .sort((a, b) => a.orbitRadius - b.orbitRadius);

  const clusters: Body[][] = [];
  for (const b of rubble) {
    const last = clusters[clusters.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && b.orbitRadius <= prev.orbitRadius * BELT_RATIO) last.push(b);
    else clusters.push([b]);
  }

  const planetSystemRadii = bodies
    .filter(b => b.parent && anchors.has(b.parent) && (childCount.get(b.id) ?? 0) > 0)
    .map(b => b.orbitRadius);
  const outermostPlanetSystem = planetSystemRadii.length
    ? Math.max(...planetSystemRadii)
    : Infinity;

  const belts: Belt[] = [];
  let inner = 0, outer = 0;
  for (const cluster of clusters) {
    if (cluster.length < BELT_MIN_MEMBERS) continue;
    const radii = cluster.map(b => b.orbitRadius);
    const median = radii[Math.floor(radii.length / 2)];
    const label = median < outermostPlanetSystem
      ? (inner++ === 0 ? 'Asteroid Belt' : `Inner Belt ${inner}`)
      : (outer++ === 0 ? 'Kuiper Belt' : `Outer Belt ${outer}`);
    belts.push({
      id: `belt:${Math.round(median)}`, label,
      members: cluster.slice(), laneMembers: cluster,
    });
  }

  // Now fold the rogues in as MEMBERS. A Kuiper object is a Kuiper
  // object: it belongs to the belt for grouping, ownership and votes,
  // even though it holds none of the belt's ring and so never joins
  // laneMembers (which is what the political wash shades).
  //
  // Placed by APOAPSIS, not nominal radius. Black Sky's nominal 2200
  // sits inside Pluto's orbit and would file it as an inner-belt rock,
  // but it reaches out to 4000 — past every planet system. Reach is the
  // honest measure of where a crossing orbit lives.
  const beltClass = (belt: Belt): 'inner' | 'outer' => {
    const radii = belt.laneMembers.map(m => m.orbitRadius);
    return radii[Math.floor(radii.length / 2)] < outermostPlanetSystem ? 'inner' : 'outer';
  };
  for (const b of bodies) {
    if (!isRubble(b) || !isEccentricRogue(b)) continue;
    const reach = b.orbit_ra ?? b.orbitRadius;
    const want = reach < outermostPlanetSystem ? 'inner' : 'outer';
    const host = belts.find(belt => beltClass(belt) === want);
    // No belt of that class in this system — the rogue stays its own
    // system rather than being filed under a belt that doesn't exist.
    if (host) host.members.push(b);
  }
  return belts;
}

/** Memoized per bodies-array so the root resolver and the labeller agree
 *  without re-clustering on every call. */
const beltCache = new WeakMap<Body[], {
  byBody: Map<string, Belt>; byId: Map<string, Belt>;
}>();
function beltsOf(bodies: Body[]) {
  const hit = beltCache.get(bodies);
  if (hit) return hit;
  const byBody = new Map<string, Belt>();
  const byId = new Map<string, Belt>();
  for (const belt of findBelts(bodies)) {
    byId.set(belt.id, belt);
    // members, not laneMembers — a rogue roots to its belt even though
    // it is absent from the belt's shaded lane.
    for (const m of belt.members) byBody.set(m.id, belt);
  }
  const built = { byBody, byId };
  beltCache.set(bodies, built);
  return built;
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
  const belts = beltsOf(bodies);
  return (bodyId: string): string => {
    const hit = cache.get(bodyId);
    if (hit) return hit;
    // Belt membership outranks the parent walk: a belt rock's parent IS
    // the star, so without this it would root to itself.
    const belt = belts.byBody.get(bodyId);
    if (belt) { cache.set(bodyId, belt.id); return belt.id; }
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
  // Synthetic roots — no body carries these ids, so name them before the
  // lookup below falls through to shouting the raw id.
  if (rootId === CORE_SYSTEM_ID) return CORE_LABEL;
  const belt = beltsOf(bodies).byId.get(rootId);
  if (belt) return belt.label;
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
/** Does `ownedBy` have a living STATION at this body? Stations are the
 *  repair infrastructure (worker/room.js maintenance: +2 HP/tick), so
 *  this feeds the "Repairing" status. */
export function makeStationsAtBody(
  settlements: { bodyId: string; ownedBy: string; type: string; hp: number }[],
): (bodyId: string, ownedBy: string) => boolean {
  const owners = new Map<string, Set<string>>();
  for (const st of settlements) {
    if (st.type !== 'station' || st.hp <= 0) continue;
    let set = owners.get(st.bodyId);
    if (!set) { set = new Set(); owners.set(st.bodyId, set); }
    set.add(st.ownedBy);
  }
  return (bodyId, ownedBy) => owners.get(bodyId)?.has(ownedBy) ?? false;
}

/**
 * Is a hostile ARMED SHIP sharing this body right now? Stricter than
 * makeHostilesAtBody: ignores settlements and unarmed hulls, so it
 * answers "is a warship actually here to fight me". Used for freighters
 * and other non-combatants, which shouldn't read "In Combat" merely for
 * parking near an enemy city or a passing hauler — only when a warship
 * is on top of them. Ships under burn are excluded (they haven't
 * arrived; combat is at-body).
 */
export function makeArmedHostilesAtBody(
  ships: Ship[],
  /** Faction ids at PEACE with the viewer (NAP / defense-pact / intel-
   *  share / alliance). A ship from one of these is NOT hostile — the
   *  server never fires between peace partners, so the status must not
   *  read "In Combat" either (a NAP partner's warship shares your orbit
   *  without a shot). Omit for the legacy "any foreign faction" behavior
   *  (SP / tests, where there are no treaties). */
  friendly?: ReadonlySet<string>,
): (bodyId: string, ownedBy: string) => boolean {
  const owners = new Map<string, Set<string>>();
  for (const s of ships) {
    if (s.transit || !isArmed(s)) continue;
    let set = owners.get(s.orbit.parentBodyId);
    if (!set) { set = new Set(); owners.set(s.orbit.parentBodyId, set); }
    set.add(s.ownedBy);
  }
  return (bodyId, ownedBy) => {
    const set = owners.get(bodyId);
    if (!set) return false;
    for (const o of set) if (o !== ownedBy && !friendly?.has(o)) return true;
    return false;
  };
}

export function makeHostilesAtBody(
  ships: Ship[],
  settlements: { bodyId: string; ownedBy: string }[],
  /** Peace partners of the viewer — excluded from "hostile" (see
   *  makeArmedHostilesAtBody). Without this, a NAP partner's unarmed
   *  freighter parked in your orbit falsely flags your ships "In Combat"
   *  even though nothing fires (player report, 2026-07-24). */
  friendly?: ReadonlySet<string>,
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
    for (const o of set) if (o !== ownedBy && !friendly?.has(o)) return true;
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
  /** A friendly station shares this orbit (see makeStationsAtBody) —
   *  station repair is running on any damaged hull parked here. */
  friendlyStationPresent?: boolean,
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
  // Docked at a friendly station with hull damage → the maintenance pass
  // is actively healing it (+2 HP/tick). Ranked below combat: a ship
  // being shot AT a station is fighting first, patching second.
  if (friendlyStationPresent && hpRatio < 0.999) {
    return { label: 'Repairing', cls: 'repairing', title: 'Docked at a friendly station — hull repairing +2 HP/tick' };
  }
  if (ship.plannedTransit) {
    return { label: 'Planned', cls: 'planned', title: 'A transfer is planned but not yet committed' };
  }
  return { label: 'Orbiting', cls: 'orbiting', title: 'Parked in a stable orbit' };
}
