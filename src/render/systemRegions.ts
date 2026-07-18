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

import { Body, Faction } from '../types';

/** Consecutive rubble bodies join one belt while each is within this
 *  factor of the previous orbit radius. 1.25 keeps Sol's real belts
 *  intact (345→390, 1900→2400) while leaving the lone rogues
 *  (Black Sky 1100, Vagrant 1450, Sedna 3500) as their own islands. */
const BELT_RATIO = 1.25;

/** Minimum members before a cluster is a "belt" rather than a pair of
 *  neighbours that happen to sit near each other. */
const BELT_MIN_MEMBERS = 3;

/** Padding on a planet system's disc, as a factor of its outermost
 *  moon's orbit — enough that the moon sits inside the shading. */
const SYSTEM_DISC_PAD = 1.3;

export type RegionOwnership =
  | { kind: 'unowned' }
  | { kind: 'contested'; factionIds: string[] }
  | { kind: 'exclusive'; factionId: string; color: string; factionName: string };

export type RegionShape =
  /** Disc centred on a body (follows it as it orbits). */
  | { kind: 'disc'; anchorBodyId: string; worldRadius: number }
  /** Annulus centred on the star. */
  | { kind: 'band'; starBodyId: string; rInner: number; rOuter: number };

export interface SystemRegion {
  id: string;
  /** "Saturn System" / "Asteroid Belt". Empty for solitaries, which
   *  are shaded but not labelled. */
  label: string;
  shape: RegionShape;
  bodyIds: string[];
  ownership: RegionOwnership;
}

function ownershipOf(members: Body[], factions: Faction[] | undefined): RegionOwnership {
  const owners = new Set<string>();
  for (const b of members) if (b.ownedBy) owners.add(b.ownedBy);
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

    // --- planet systems: star-orbiters that have moons ---
    const solitaries: Body[] = [];
    const planetSystemRadii: number[] = [];
    for (const b of orbiters) {
      const moons = childrenOf.get(b.id) ?? [];
      if (moons.length === 0) { solitaries.push(b); continue; }
      const outermost = Math.max(...moons.map(m => m.orbitRadius));
      const members = [b, ...moons];
      planetSystemRadii.push(b.orbitRadius);
      regions.push({
        id: `sys:${b.id}`,
        label: `${b.name} System`,
        shape: {
          kind: 'disc',
          anchorBodyId: b.id,
          worldRadius: Math.max(outermost * SYSTEM_DISC_PAD, b.radius * 6),
        },
        bodyIds: members.map(m => m.id),
        ownership: ownershipOf(members, factions),
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
        },
        bodyIds: cluster.map(b => b.id),
        ownership: ownershipOf(cluster, factions),
      });
    }

    // --- solitaries: lone rocks + moonless planets ---
    for (const b of solitaries) {
      if (banded.has(b.id)) continue;
      regions.push({
        id: `solo:${b.id}`,
        label: '',                       // body's own label already reads
        shape: { kind: 'disc', anchorBodyId: b.id, worldRadius: Math.max(b.radius * 8, 6) },
        bodyIds: [b.id],
        ownership: ownershipOf([b], factions),
      });
    }
  }

  // Bands paint first so a planet system's disc sits on top of a belt
  // it overlaps (Pluto sits inside the Kuiper band's radius range).
  regions.sort((a, b) => {
    const rank = (r: SystemRegion) => (r.shape.kind === 'band' ? 0 : 1);
    return rank(a) - rank(b);
  });
  return regions;
}
