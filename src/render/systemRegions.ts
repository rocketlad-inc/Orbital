// ============================================================
// systemRegions — strategic "who owns what" grouping for the
// zoomed-out map.
//
// At full-system zoom the per-body detail (icons, labels, dashed
// ownership rings, ship pips) collapses into an unreadable smear
// around the inner planets. This module derives the coarse political
// units a player actually thinks in — "the Saturn System", "the
// Asteroid Belt" — so the renderer can shade those regions instead.
//
// Derived STRUCTURALLY from the live body graph, not a hardcoded
// table, so it works for any seeded system (including the far
// Centauri / Cygnus groups) without a parallel list to maintain:
//
//   planet system  a star-orbiting body that HAS moons. Shaded as a
//                  disc centred on it, sized to enclose its moons.
//   belt           3+ star-orbiting asteroids/dwarfs at similar
//                  orbital radii. Shaded as an annulus band.
//                  Terrestrials/giants are never banded — belts are
//                  made of rubble, and without that rule Mars gets
//                  swallowed by the asteroid belt (283 vs 345 units
//                  is inside any sane clustering ratio).
//   solitary       anything else star-orbiting (lone rogue rocks,
//                  moonless inner planets). Small disc, unlabelled —
//                  the body's own label already says what it is.
//
// Ownership per the spec: exclusively-owned regions take the owner's
// colour and say whose they are; contested and unowned both read
// grey — a contested region is deliberately NOT a second faction
// colour, because "someone is fighting here" is the signal, not who.
// ============================================================

import { Body, Faction, Settlement } from '../types';
import { CORE_MEMBER_IDS, CORE_LABEL } from '../game/systemGrouping';

/** Consecutive rubble bodies join one belt while each is within this
 *  factor of the previous orbit radius. 1.25 keeps Sol's real belts
 *  intact (345→390, 1900→2400) while leaving the lone rogues
 *  (Black Sky 1100, Vagrant 1450, Sedna 3500) as their own islands. */
const BELT_RATIO = 1.25;

/** Minimum members before a cluster is a "belt" rather than a pair of
 *  neighbours that happen to sit near each other. */
const BELT_MIN_MEMBERS = 3;

/** Padding on a planet system's lane, as a factor of its outermost
 *  moon's orbit — enough that the moon sits inside the shading. */
const SYSTEM_DISC_PAD = 1.3;

/** Half-lane as a fraction of the distance to the nearest neighbouring
 *  orbit. Below 0.5 so two adjacent rings leave a visible seam. */
const LANE_GAP_FRACTION = 0.40;
/** Floor + ceiling as fractions of the orbit radius: the floor keeps a
 *  crowded inner planet from getting a hairline ring (and covers the
 *  zero-gap case of two bodies sharing an orbit), the ceiling stops a
 *  lone outer body like Sedna from washing half the map. */
const LANE_MIN_FRACTION = 0.035;
const LANE_MAX_FRACTION = 0.12;

export type RegionOwnership =
  | { kind: 'unowned' }
  | { kind: 'contested'; factionIds: string[] }
  | { kind: 'exclusive'; factionId: string; color: string; factionName: string };

/**
 * Every region is an annulus centred on its star — the orbital band the
 * faction holds, not a puddle around wherever its planet happens to be
 * standing right now. A planet system owns its whole lane around the
 * sun; that's what "territory" means on this map.
 *
 * `labelAnchorBodyId` parks the label at that body's current angle
 * rather than a fixed point on the ring, which both ties the name to
 * the thing it describes and stops a dozen concentric rings from
 * stacking every label in one vertical column.
 */
export type RegionShape = {
  kind: 'band';
  starBodyId: string;
  rInner: number;
  rOuter: number;
  labelAnchorBodyId?: string;
};

export interface SystemRegion {
  id: string;
  /** "Saturn System" / "Asteroid Belt". Empty for solitaries, which
   *  are shaded but not labelled. */
  label: string;
  shape: RegionShape;
  bodyIds: string[];
  ownership: RegionOwnership;
}

/**
 * Ownership is derived from LIVE SETTLEMENTS in the region — who has
 * boots on the ground — rather than the server's `owner_faction_id`
 * on the body. Two reasons:
 *
 *   1. Matches the mental model. A player who has ships parked at a
 *      body but no settlement doesn't own it; a player whose
 *      settlement was just destroyed doesn't own it either. Settlement
 *      presence is the concrete, verifiable claim.
 *
 *   2. Immune to stale `owner_faction_id`. That column is
 *      server-derived from settlement counts, but any missed
 *      recompute (a code path that destroys settlements without
 *      calling recomputeBodyOwnership) would leave the wrong owner
 *      showing forever. Playtester report (2026-07-19): a system was
 *      showing attributed to another faction even though only Sean's
 *      faction had settlements in it. Reading settlements directly
 *      makes that class of bug non-representable.
 */
function ownershipOf(
  members: Body[],
  settlements: Settlement[] | undefined,
  factions: Faction[] | undefined,
): RegionOwnership {
  const owners = new Set<string>();
  const bodyIds = new Set(members.map(b => b.id));
  if (settlements) {
    for (const s of settlements) if (bodyIds.has(s.bodyId) && s.ownedBy) owners.add(s.ownedBy);
  }
  if (owners.size === 0) return { kind: 'unowned' };
  if (owners.size > 1) return { kind: 'contested', factionIds: Array.from(owners) };
  const id = Array.from(owners)[0];
  const f = factions?.find(x => x.id === id);
  return {
    kind: 'exclusive',
    factionId: id,
    color: f?.color ?? '#8a9fb3',
    factionName: f?.name ?? 'Unknown',
  };
}

/** Rubble — the only things that form belts. */
function isBeltable(b: Body): boolean {
  return b.type === 'asteroid' || b.type === 'dwarf';
}

/**
 * Derive the political regions of every star system on the map.
 *
 * Pure: no canvas, no camera. The renderer turns these into shading.
 */
export function computeSystemRegions(
  bodies: Body[],
  factions?: Faction[],
  settlements?: Settlement[],
): SystemRegion[] {
  const alive = bodies.filter(b => b.destroyedAtTick == null);
  const childrenOf = new Map<string, Body[]>();
  for (const b of alive) {
    if (!b.parent) continue;
    const arr = childrenOf.get(b.parent) ?? [];
    arr.push(b);
    childrenOf.set(b.parent, arr);
  }

  const stars = alive.filter(b => b.type === 'star' || b.type === 'black_hole');
  const regions: SystemRegion[] = [];

  for (const star of stars) {
    const orbiters = (childrenOf.get(star.id) ?? [])
      .slice()
      .sort((a, b) => a.orbitRadius - b.orbitRadius);

    // How wide a lane each orbiter gets. Driven by the distance to its
    // nearest neighbour so rings fill their orbital neighbourhood
    // without swallowing the next one in — a fixed fraction of orbit
    // radius would make the inner planets invisibly thin and the outer
    // ones overlap. Duplicated radii (Uranus and Black Sky share one)
    // would give a zero gap, hence the proportional floor.
    const radii = orbiters.map(o => o.orbitRadius);
    const laneHalfWidth = (b: Body): number => {
      const r = b.orbitRadius;
      let gap = Infinity;
      for (const other of radii) {
        const d = Math.abs(other - r);
        if (d > 1e-6 && d < gap) gap = d;
      }
      if (!Number.isFinite(gap)) gap = r;
      return Math.min(
        Math.max(gap * LANE_GAP_FRACTION, r * LANE_MIN_FRACTION),
        r * LANE_MAX_FRACTION,
      );
    };

    // --- planet systems: star-orbiters that have moons ---
    const solitaries: Body[] = [];
    const planetSystemRadii: number[] = [];
    for (const b of orbiters) {
      const moons = childrenOf.get(b.id) ?? [];
      if (moons.length === 0) { solitaries.push(b); continue; }
      const members = [b, ...moons];
      planetSystemRadii.push(b.orbitRadius);
      // At minimum the lane covers the moon system itself, so the band
      // never reads as narrower than the thing it represents.
      const outermost = Math.max(...moons.map(m => m.orbitRadius));
      const half = Math.max(laneHalfWidth(b), outermost * SYSTEM_DISC_PAD);
      regions.push({
        id: `sys:${b.id}`,
        label: `${b.name} System`,
        shape: {
          kind: 'band',
          starBodyId: star.id,
          rInner: Math.max(0, b.orbitRadius - half),
          rOuter: b.orbitRadius + half,
          labelAnchorBodyId: b.id,
        },
        bodyIds: members.map(m => m.id),
        ownership: ownershipOf(members, settlements, factions),
      });
    }

    // --- belts: runs of nearby rubble ---
    const rubble = solitaries.filter(isBeltable);
    const clusters: Body[][] = [];
    for (const b of rubble) {
      const last = clusters[clusters.length - 1];
      const prev = last?.[last.length - 1];
      if (prev && b.orbitRadius <= prev.orbitRadius * BELT_RATIO) last.push(b);
      else clusters.push([b]);
    }

    // A belt inside the outermost planet system is the "asteroid" belt;
    // beyond it, the "kuiper" belt. Naming off structure rather than a
    // body-id table keeps it sensible for other seeded systems too.
    const outermostPlanetSystem = planetSystemRadii.length
      ? Math.max(...planetSystemRadii)
      : Infinity;
    let innerBelts = 0;
    let outerBelts = 0;
    const banded = new Set<string>();

    for (const cluster of clusters) {
      if (cluster.length < BELT_MIN_MEMBERS) continue;
      const radii = cluster.map(b => b.orbitRadius);
      const rInner = Math.min(...radii);
      const rOuter = Math.max(...radii);
      const median = radii[Math.floor(radii.length / 2)];
      const isInner = median < outermostPlanetSystem;
      let label: string;
      if (isInner) label = innerBelts++ === 0 ? 'Asteroid Belt' : `Inner Belt ${innerBelts}`;
      else label = outerBelts++ === 0 ? 'Kuiper Belt' : `Outer Belt ${outerBelts}`;

      for (const b of cluster) banded.add(b.id);
      regions.push({
        id: `belt:${star.id}:${Math.round(median)}`,
        label,
        shape: {
          kind: 'band',
          starBodyId: star.id,
          // Widen slightly so the outermost members sit inside the
          // shading rather than riding its edge.
          rInner: rInner * 0.92,
          rOuter: rOuter * 1.08,
          // Anchor on a middle member so the belt's label sits among
          // its rocks instead of colliding with the planet rings.
          labelAnchorBodyId: cluster[Math.floor(cluster.length / 2)].id,
        },
        bodyIds: cluster.map(b => b.id),
        ownership: ownershipOf(cluster, settlements, factions),
      });
    }

    // --- solitaries: lone rocks + moonless planets ---
    // Also full lanes. A moonless planet is still a "system" to the
    // player (Mars has no moons here but reads as Mars System), and a
    // claim on it is a claim on that orbit. Named only when it's a
    // planet — a lone rogue rock doesn't need a second label next to
    // the one the body already draws.
    for (const b of solitaries) {
      if (banded.has(b.id)) continue;
      // Core members get one merged lane below, not a lane each.
      if (CORE_MEMBER_IDS.has(b.id)) continue;
      const half = laneHalfWidth(b);
      const isPlanet = b.type === 'terrestrial' || b.type === 'gas_giant' || b.type === 'ice_giant';
      regions.push({
        id: `solo:${b.id}`,
        label: isPlanet ? `${b.name} System` : '',
        shape: {
          kind: 'band',
          starBodyId: star.id,
          rInner: Math.max(0, b.orbitRadius - half),
          rOuter: b.orbitRadius + half,
          labelAnchorBodyId: b.id,
        },
        bodyIds: [b.id],
        ownership: ownershipOf([b], settlements, factions),
      });
    }

    // --- The Core: Sol + Mercury + Venus as one lane ---
    //
    // A disc rather than an annulus (rInner 0), so the star sits INSIDE
    // its own territory instead of in a hole at the middle of the map.
    // Two scorched rocks and the sun aren't three separate theatres;
    // they're the place everything else orbits.
    //
    // Membership is shared with the panels via CORE_MEMBER_IDS — the map
    // and the outliner must agree on what The Core contains.
    // The star is not among its own `orbiters`, so pull it in explicitly
    // — "include the sun in the Core" is the whole point.
    const planets = orbiters.filter(b => CORE_MEMBER_IDS.has(b.id));
    const coreBodies = CORE_MEMBER_IDS.has(star.id) ? [star, ...planets] : planets;
    if (coreBodies.length) {
      // Outer edge follows the outermost core planet's own lane, so the
      // Core meets its neighbour (Earth) on the same shared border the
      // rest of the lanes use.
      const rOuter = planets.length
        ? Math.max(...planets.map(b => b.orbitRadius + laneHalfWidth(b)))
        : laneHalfWidth(star);
      // Anchor on the outermost planet: a label pinned to the star would
      // land dead centre, on top of the sun.
      const anchor = planets.length
        ? planets.reduce((a, b) => (b.orbitRadius > a.orbitRadius ? b : a))
        : star;
      regions.push({
        id: `core:${star.id}`,
        label: CORE_LABEL,
        shape: {
          kind: 'band',
          starBodyId: star.id,
          rInner: 0,
          rOuter,
          labelAnchorBodyId: anchor.id,
        },
        bodyIds: coreBodies.map(b => b.id),
        ownership: ownershipOf(coreBodies, settlements, factions),
      });
    }
  }

  // --- Border-touching pass ---
  //
  // Compute each region's orbital CENTER, sort by it, and for each pair
  // of orbit-adjacent regions with a gap between them, extend both edges
  // to meet at the mid-radius of their centers. Playtester feedback:
  // between the concentric coloured rings there was a visible ~20% neutral
  // strip (each lane's half-width covered 0.40 of the gap; two of them
  // covered 0.80, leaving 20%). Adjacent rings now share a border.
  //
  // Overlaps are left alone — Pluto genuinely orbits inside the Kuiper
  // belt and Black Sky shares Uranus's orbit; the paint order below
  // handles those. "Gap" here strictly means later.rInner > earlier.rOuter.
  const centerOf = (r: SystemRegion): number =>
    r.shape.kind === 'band' ? (r.shape.rInner + r.shape.rOuter) / 2 : 0;
  const byOrbit = regions.slice().sort((a, b) => centerOf(a) - centerOf(b));
  for (let i = 0; i + 1 < byOrbit.length; i++) {
    const earlier = byOrbit[i], later = byOrbit[i + 1];
    if (later.shape.rInner <= earlier.shape.rOuter) continue;   // overlap OR touching → skip
    const mid = (centerOf(earlier) + centerOf(later)) / 2;
    // Only ever GROW a lane toward its neighbour — never shrink one.
    earlier.shape.rOuter = Math.max(earlier.shape.rOuter, mid);
    later.shape.rInner  = Math.min(later.shape.rInner,  mid);
  }

  // Paint broad first, specific last. Rings genuinely overlap — Pluto
  // orbits INSIDE the Kuiper belt, Black Sky shares Uranus's orbit
  // exactly — and without this the wide grey belt would bury the narrow
  // faction-coloured ring sitting inside it.
  //
  // Tie-break puts owned ground on top of neutral, so a claim is never
  // hidden under an unowned rock that happens to share its lane.
  const claimRank = (r: SystemRegion) =>
    r.ownership.kind === 'exclusive' ? 2 : r.ownership.kind === 'contested' ? 1 : 0;
  const width = (r: SystemRegion) => r.shape.rOuter - r.shape.rInner;
  regions.sort((a, b) => (width(b) - width(a)) || (claimRank(a) - claimRank(b)));
  return regions;
}
