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
import {
  CORE_MEMBER_IDS, CORE_LABEL, findBelts, isEccentricRogue,
} from '../game/systemGrouping';
import { deriveSecondary } from '../game/colorUtils';

// BELT_RATIO / BELT_MIN_MEMBERS / isBeltable used to live here. They moved
// to systemGrouping so the map, the panels, the outliner and the senate
// all cut the belts in the same place — the map drew one "Asteroid Belt"
// lane while the outliner listed eight separate systems and the senate
// paid eight votes for them.

/** Padding on a planet system's lane, as a factor of its outermost
 *  moon's orbit — enough that the moon sits inside the shading. */
const SYSTEM_DISC_PAD = 1.3;

// isEccentricRogue moved to systemGrouping — the senate needs the same
// judgement (a rock that crosses a dozen lanes belongs to no belt), and
// two copies of that test would drift. A rogue still renders, stays
// selectable and keeps its owner; it just claims no lane it only visits.

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
  | { kind: 'exclusive'; factionId: string; color: string; color2: string; factionName: string };

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
  /** Set when several same-owner bands were merged into this one: the
   *  original per-system labels + their sub-band radial extents (world
   *  units), so the renderer still names EACH constituent system on the
   *  combined territory instead of collapsing to one. Undefined for a
   *  normal single-system region (renderer falls back to `label`). */
  labels?: Array<{ label: string; anchorBodyId?: string; rInner: number; rOuter: number }>;
}

/** A political claim: some faction has a live settlement on this body.
 *  MP feeds these from the server's fog-FREE settlement_claims summary;
 *  SP derives them from its (never-fogged) settlements array. */
export interface SettlementClaim {
  bodyId: string;
  ownedBy: string;
}

/**
 * Ownership rule: WHOEVER HOLDS THE MAJORITY OF CLAIMED WORLDS IN THE
 * REGION OWNS IT.
 *
 * Per body, the claimant is the sole faction with settlements there; a
 * body shared by two factions (city captured, rival station overhead)
 * is politically torn and counts toward nobody. Then, across the
 * region's claimed bodies: a strict majority (> half) names the owner,
 * a tie reads CONTESTED, zero claims reads UNCLAIMED. So four colonies
 * against a rival's one still paint the belt your color — minority
 * presence doesn't veto the map, it just dilutes it toward CONTESTED
 * as it approaches parity.
 *
 * Claims — not the server's `owner_faction_id` column, and not the
 * fogged settlements list:
 *
 *   1. Settlement presence is the concrete, verifiable claim, immune
 *      to stale server-side ownership recomputes.
 *
 *   2. The claims feed is fog-FREE by design. Region ownership is the
 *      political map, and borders are common knowledge — without this,
 *      any system outside sensor range read UNCLAIMED even when a
 *      rival visibly runs seven colonies there (playtest report
 *      2026-07-19, Asteroid Belt). What fog still hides is everything
 *      else about those settlements: hp, buildings, stockpiles.
 */
function ownershipOf(
  members: Body[],
  claims: SettlementClaim[] | undefined,
  factions: Faction[] | undefined,
): RegionOwnership {
  const bodyIds = new Set(members.map(b => b.id));
  // body -> set of factions with a live settlement on it
  const perBody = new Map<string, Set<string>>();
  if (claims) {
    for (const cl of claims) {
      if (!bodyIds.has(cl.bodyId) || !cl.ownedBy) continue;
      let set = perBody.get(cl.bodyId);
      if (!set) perBody.set(cl.bodyId, (set = new Set()));
      set.add(cl.ownedBy);
    }
  }
  // Per-body fallback to the body's own ownership column, ONLY where no
  // settlement claim exists. The claims feed (fog-free, game-wide)
  // covers every settlement, so this catches just the exotic case of a
  // body the server credits to a faction without a settlement behind it
  // — the upstream motivating example was a held star. A live claim
  // always outvotes the column, so the stale-owner bug this function
  // was originally written to dodge stays non-representable.
  for (const b of members) {
    if (perBody.has(b.id)) continue;
    if (b.ownedBy) perBody.set(b.id, new Set([b.ownedBy]));
  }
  if (perBody.size === 0) return { kind: 'unowned' };

  // Worlds per sole claimant. Shared bodies count toward nobody but DO
  // count toward the claimed total, so planting a station on a rival's
  // world erodes their majority rather than being invisible.
  const worldsByFaction = new Map<string, number>();
  let claimedWorlds = 0;
  const everyone = new Set<string>();
  for (const owners of perBody.values()) {
    claimedWorlds++;
    for (const f of owners) everyone.add(f);
    if (owners.size === 1) {
      const f = owners.values().next().value as string;
      worldsByFaction.set(f, (worldsByFaction.get(f) ?? 0) + 1);
    }
  }

  let leader: string | null = null;
  let leaderWorlds = 0;
  for (const [f, n] of worldsByFaction) {
    if (n > leaderWorlds) { leader = f; leaderWorlds = n; }
  }
  if (leader && leaderWorlds * 2 > claimedWorlds) {
    const f = factions?.find(x => x.id === leader);
    const primary = f?.color ?? '#8a9fb3';
    return {
      kind: 'exclusive',
      factionId: leader,
      color: primary,
      // Secondary (two-tone §5): explicit pick, else derived from primary.
      // Drives the territory border stroke on the map.
      color2: f?.color2 || deriveSecondary(primary),
      factionName: f?.name ?? 'Unknown',
    };
  }
  return { kind: 'contested', factionIds: Array.from(everyone) };
}

/** Bridge for callers that only have settlements (SP): every live
 *  settlement is a claim. */
export function claimsFromSettlements(settlements: Settlement[] | undefined): SettlementClaim[] {
  return (settlements ?? [])
    .filter(s => !!s.ownedBy)
    .map(s => ({ bodyId: s.bodyId, ownedBy: s.ownedBy as string }));
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
  /** Fog-free claims (MP). Omitted → derived from `settlements` (SP,
   *  where nothing is fogged anyway). */
  claims?: SettlementClaim[],
): SystemRegion[] {
  const claimList = claims && claims.length > 0 ? claims : claimsFromSettlements(settlements);
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
      .filter(b => !isEccentricRogue(b))
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
    for (const b of orbiters) {
      const moons = childrenOf.get(b.id) ?? [];
      if (moons.length === 0) { solitaries.push(b); continue; }
      const members = [b, ...moons];
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
        ownership: ownershipOf(members, claimList, factions),
      });
    }

    // --- belts: runs of nearby rubble ---
    //
    // Clustering and naming come from systemGrouping.findBelts, the same
    // call the outliner, the fleet panel and the senate make. This file
    // used to own a private copy of that loop; a belt is now one place
    // everywhere or nowhere.
    const banded = new Set<string>();
    for (const belt of findBelts(alive)) {
      // laneMembers, NOT members: eccentric rogues belong to the belt
      // politically but hold none of its ring. Letting them into the
      // geometry would stretch the lane across half the outer system and
      // paint a second coat over Uranus and Pluto — the exact overlap
      // bug that put isEccentricRogue here in the first place. The
      // political wash is unchanged by their membership.
      const cluster = belt.laneMembers;
      const radii = cluster.map(b => b.orbitRadius);
      const rInner = Math.min(...radii);
      const rOuter = Math.max(...radii);
      const median = radii[Math.floor(radii.length / 2)];

      for (const b of cluster) banded.add(b.id);
      regions.push({
        id: `belt:${star.id}:${Math.round(median)}`,
        label: belt.label,
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
        ownership: ownershipOf(cluster, claimList, factions),
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
        ownership: ownershipOf([b], claimList, factions),
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
        ownership: ownershipOf(coreBodies, claimList, factions),
      });
    }
  }

  const centerOf = (r: SystemRegion): number =>
    r.shape.kind === 'band' ? (r.shape.rInner + r.shape.rOuter) / 2 : 0;

  // --- Merge adjacent same-owner territories ---
  //
  // Two orbit-adjacent bands held by the SAME faction are one territory,
  // not two. Drawn separately they read as different empires: the radial
  // alpha falloff shades the outer band fainter than the inner one, and
  // the secondary-colour border draws a rim at their shared boundary — so
  // a single faction's back-to-back holdings (e.g. Smiley Face Friends'
  // Neptune + Pluto systems) looked like two owners in two shades. Merge
  // each maximal run of consecutive same-faction exclusive bands, per
  // star, into one band spanning their combined radial extent. A band of a
  // DIFFERENT owner (or neutral) between them breaks the run, so only
  // genuinely adjacent holdings combine. The merged band keeps the
  // innermost sub-region's label + anchor; the individual body names still
  // render, so the constituent systems remain identifiable.
  {
    const byStar = new Map<string, SystemRegion[]>();
    for (const r of regions) {
      const arr = byStar.get(r.shape.starBodyId);
      if (arr) arr.push(r); else byStar.set(r.shape.starBodyId, [r]);
    }
    const removed = new Set<SystemRegion>();
    for (const arr of byStar.values()) {
      arr.sort((a, b) => centerOf(a) - centerOf(b));
      let i = 0;
      while (i < arr.length) {
        const head = arr[i];
        if (head.ownership.kind !== 'exclusive') { i++; continue; }
        const fid = head.ownership.factionId;
        // Snapshot head's OWN label + extent before the loop widens its
        // shape, so its label still sits on its own sub-band ring.
        const runLabels = [{
          label: head.label,
          anchorBodyId: head.shape.labelAnchorBodyId,
          rInner: head.shape.rInner,
          rOuter: head.shape.rOuter,
        }];
        let j = i + 1;
        while (
          j < arr.length
          && arr[j].ownership.kind === 'exclusive'
          && (arr[j].ownership as { factionId: string }).factionId === fid
        ) {
          const s = arr[j].shape;
          runLabels.push({
            label: arr[j].label,
            anchorBodyId: s.labelAnchorBodyId,
            rInner: s.rInner,
            rOuter: s.rOuter,
          });
          head.shape.rInner = Math.min(head.shape.rInner, s.rInner);
          head.shape.rOuter = Math.max(head.shape.rOuter, s.rOuter);
          head.bodyIds = head.bodyIds.concat(arr[j].bodyIds);
          removed.add(arr[j]);
          j++;
        }
        // Only a genuine merge (>1 band) keeps every constituent label.
        if (j > i + 1) head.labels = runLabels.filter(l => l.label);
        i = j;
      }
    }
    if (removed.size > 0) {
      for (let k = regions.length - 1; k >= 0; k--) {
        if (removed.has(regions[k])) regions.splice(k, 1);
      }
    }
  }

  // --- Overlap-splitting pass ---
  //
  // Two lanes covering the same radius get painted twice, and translucent
  // fills MIX. That invents colours belonging to no faction: Black Sky and
  // Uranus are both CIS at r=1100, and two coats of the same blue read as
  // a darker third shade; Augustín (CIS) over Pluto (unowned) muddies blue
  // into grey. Playtesters read the invented shades as extra empires.
  //
  // Relying on paint order can't fix it — whoever draws second still
  // blends with what's underneath. The overlap has to stop existing, so
  // co-orbital lanes split the contested span and each keeps a solid,
  // honest slice of it. This is what "separate them" means: a rock sharing
  // a planet's orbit gets its own thinner ring, not a wash over the
  // planet's.
  //
  // Runs BEFORE the border-touching pass below, which then closes any
  // residual seam — so the end state is adjacent, disjoint, touching.
  {
    const MIN_BAND = 4;
    const bands = regions
      .filter(r => r.shape.kind === 'band')
      .slice()
      .sort((a, b) => (centerOf(a) - centerOf(b)) || a.id.localeCompare(b.id));
    for (let i = 0; i + 1 < bands.length; i++) {
      const a = bands[i].shape, b = bands[i + 1].shape;
      if (b.rInner >= a.rOuter) continue;               // already disjoint
      const ca = centerOf(bands[i]), cb = centerOf(bands[i + 1]);
      // Co-orbital (identical centres) can't be split by midpoint, so
      // halve the span they contest instead.
      const boundary = Math.abs(cb - ca) > 1e-6
        ? (ca + cb) / 2
        : (Math.max(a.rInner, b.rInner) + Math.min(a.rOuter, b.rOuter)) / 2;
      a.rOuter = Math.max(a.rInner + MIN_BAND, Math.min(a.rOuter, boundary));
      b.rInner = Math.min(b.rOuter - MIN_BAND, Math.max(b.rInner, boundary));
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
  // "Gap" here strictly means later.rInner > earlier.rOuter.
  const byOrbit = regions.slice().sort((a, b) => centerOf(a) - centerOf(b));
  for (let i = 0; i + 1 < byOrbit.length; i++) {
    const earlier = byOrbit[i], later = byOrbit[i + 1];
    if (later.shape.rInner <= earlier.shape.rOuter) continue;   // overlap OR touching → skip
    const mid = (centerOf(earlier) + centerOf(later)) / 2;
    // Only ever GROW a lane toward its neighbour — never shrink one.
    earlier.shape.rOuter = Math.max(earlier.shape.rOuter, mid);
    later.shape.rInner  = Math.min(later.shape.rInner,  mid);
  }

  // Paint broad first, specific last. The splitting pass above makes the
  // lanes disjoint, so this no longer decides who survives a collision —
  // it's belt-and-braces for any residual sliver (rounding at a shared
  // boundary, or a future shape kind that isn't a plain annulus), keeping
  // the narrow faction-coloured ring on top of the wide neutral one
  // rather than under it.
  //
  // Tie-break puts owned ground on top of neutral, so a claim is never
  // hidden under an unowned rock that happens to share its lane.
  const claimRank = (r: SystemRegion) =>
    r.ownership.kind === 'exclusive' ? 2 : r.ownership.kind === 'contested' ? 1 : 0;
  const width = (r: SystemRegion) => r.shape.rOuter - r.shape.rInner;
  regions.sort((a, b) => (width(b) - width(a)) || (claimRank(a) - claimRank(b)));
  return regions;
}
