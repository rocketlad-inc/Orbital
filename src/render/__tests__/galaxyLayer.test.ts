// The galaxy view (Lorne, 2026-10-06): a ring per star system split by
// the worlds each empire holds, and the system's name.

import {
  summariseStarSystems, makeStarSystemOf, isHoldableWorld, galaxyLayerAlpha, galaxyRingRadius,
  ringArcs, galaxySubline, GALAXY_FADE_FROM_PX, GALAXY_FADE_TO_PX, GALAXY_RING_MIN_PX, GALAXY_RING_GAP_PX,
} from '../galaxyLayer';
import type { Body } from '../../types';

const B = (o: Partial<Body> & { id: string; type: Body['type'] }): Body => ({
  name: o.id, radius: 1, orbitRadius: 0, orbitPeriod: 100, angle0: 0, soi: 0, color: '#fff',
  ...o,
} as Body);

// Sol with four worlds (one a moon), Centauri with three round its
// barycenter (one via a sun), Cygnus with one, plus the things that are
// not ground: stars, the barycenters, a trojan, a rock, a structure.
const bodies: Body[] = [
  B({ id: 'sol', name: 'Sol', type: 'star', orbitPeriod: 0 }),
  B({ id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol', orbitRadius: 1490 }),
  B({ id: 'luna', name: 'Luna', type: 'moon', parent: 'earth', orbitRadius: 40 }),
  B({ id: 'mars', name: 'Mars', type: 'terrestrial', parent: 'sol', orbitRadius: 2270 }),
  B({ id: 'sedna', name: 'Sedna', type: 'dwarf', parent: 'sol', orbitRadius: 28000 }),
  B({ id: 'earth_l4', name: 'L4', type: 'lagrange', parent: 'sol', orbitRadius: 1490 }),
  B({ id: 'mtr_1', name: 'MTR-1', type: 'meteoroid', parent: 'sol', orbitRadius: 3000 }),
  B({ id: 'mega_1', name: 'Gate', type: 'megastructure', parent: 'mars', orbitRadius: 3 }),
  B({ id: 'binary_barycenter', name: 'Centauri Barycenter', type: 'lagrange', parent: 'sol', orbitRadius: 530400, orbitPeriod: 1e12 }),
  B({ id: 'centauri_a', name: 'Centauri A', type: 'star', parent: 'binary_barycenter', orbitRadius: 1449 }),
  B({ id: 'verdant', name: 'Verdant', type: 'terrestrial', parent: 'centauri_a', orbitRadius: 1120 }),
  B({ id: 'crimson', name: 'Crimson', type: 'gas_giant', parent: 'binary_barycenter', orbitRadius: 3800 }),
  B({ id: 'farspire', name: 'Farspire', type: 'dwarf', parent: 'binary_barycenter', orbitRadius: 5800 }),
  B({ id: 'bh_barycenter', name: 'Cygnus Barycenter', type: 'lagrange', parent: 'sol', orbitRadius: 680000, orbitPeriod: 1e12 }),
  B({ id: 'cygnus_x', name: 'Cygnus X', type: 'black_hole', parent: 'bh_barycenter', orbitRadius: 1050 }),
  B({ id: 'requiem', name: 'Requiem', type: 'terrestrial', parent: 'cygnus_x', orbitRadius: 1120 }),
];

describe('star systems', () => {
  const sys = makeStarSystemOf(bodies);
  it('a world belongs to the far barycenter above it, or to Sol', () => {
    expect(sys('luna')).toBe('sol');
    expect(sys('sedna')).toBe('sol');
    expect(sys('verdant')).toBe('binary_barycenter');   // via its sun
    expect(sys('crimson')).toBe('binary_barycenter');
    expect(sys('requiem')).toBe('bh_barycenter');        // via the black hole
    expect(sys('binary_barycenter')).toBe('binary_barycenter');
  });

  it('stars, barycenters, trojans, rocks and structures are not ground', () => {
    const held = bodies.filter(isHoldableWorld).map(b => b.id).sort();
    expect(held).toEqual(['crimson', 'earth', 'farspire', 'luna', 'mars', 'requiem', 'sedna', 'verdant']);
  });

  it('names come off the barycenter', () => {
    const names = summariseStarSystems(bodies, []).map(s => s.name).sort();
    expect(names).toEqual(['Centauri', 'Cygnus', 'Sol']);
  });

  it('the outermost world counts its parents\' orbits', () => {
    const by = new Map(summariseStarSystems(bodies, []).map(s => [s.anchorId, s]));
    expect(by.get('sol')!.outerR).toBe(28000);
    expect(by.get('binary_barycenter')!.outerR).toBe(5800);
    expect(by.get('bh_barycenter')!.outerR).toBe(1050 + 1120);
  });
});

describe('worlds held', () => {
  const claims = [
    { bodyId: 'earth', ownedBy: 'player' },
    { bodyId: 'luna', ownedBy: 'player' },
    { bodyId: 'mars', ownedBy: 'f2' },
    { bodyId: 'mars', ownedBy: 'player' },   // a world two empires hold
    { bodyId: 'mars', ownedBy: 'player' },   // two settlements, still one holder
    { bodyId: 'verdant', ownedBy: 'f2' },
    { bodyId: 'mega_1', ownedBy: 'f3' },     // not ground: ignored
  ];
  const by = new Map(summariseStarSystems(bodies, claims).map(s => [s.anchorId, s]));

  it('a share is held worlds over all worlds; a shared world splits evenly', () => {
    const sol = by.get('sol')!;
    expect(sol.worlds).toBe(4);
    expect(sol.shares).toEqual([
      { factionId: 'player', share: 2.5 / 4 },
      { factionId: 'f2', share: 0.5 / 4 },
    ]);
    expect(galaxySubline(sol)).toBe('75% HELD');
  });

  it('a far system counts its own worlds, and an empty one says so', () => {
    expect(by.get('binary_barycenter')!.shares).toEqual([{ factionId: 'f2', share: 1 / 3 }]);
    expect(by.get('bh_barycenter')!.shares).toEqual([]);
    expect(galaxySubline(by.get('bh_barycenter')!)).toBe('UNCLAIMED');
  });
});

describe('the ring', () => {
  it('starts at twelve o\'clock with the viewer, then largest first', () => {
    const arcs = ringArcs([
      { factionId: 'f2', share: 0.4 },
      { factionId: 'player', share: 0.1 },
      { factionId: 'f3', share: 0.2 },
    ], 'player', 40);
    expect(arcs.map(a => a.factionId)).toEqual(['player', 'f2', 'f3']);
    expect(arcs[0].a0).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('each arc is its share of the circle less a 2px gap', () => {
    const r = 40;
    const arcs = ringArcs([{ factionId: 'a', share: 0.5 }, { factionId: 'b', share: 0.25 }], 'x', r);
    expect(arcs[0].a1 - arcs[0].a0).toBeCloseTo(Math.PI - GALAXY_RING_GAP_PX / r, 9);
    expect(arcs[1].a0).toBeCloseTo(-Math.PI / 2 + Math.PI, 9);
    expect(arcs[1].a1 - arcs[1].a0).toBeCloseTo(Math.PI / 2 - GALAXY_RING_GAP_PX / r, 9);
  });

  it('one empire holding everything is a closed ring, and a single rock still shows', () => {
    const whole = ringArcs([{ factionId: 'a', share: 1 }], 'x', 40);
    expect(whole[0].a1 - whole[0].a0).toBeCloseTo(Math.PI * 2, 9);
    const tiny = ringArcs([{ factionId: 'a', share: 0.001 }], 'x', 40);
    expect(tiny[0].a1).toBeGreaterThan(tiny[0].a0);
  });
});

describe('when it shows', () => {
  it('off in the system view, on once Sol is a token, a ramp between', () => {
    expect(galaxyLayerAlpha(400)).toBe(0);
    expect(galaxyLayerAlpha(GALAXY_FADE_FROM_PX)).toBe(0);
    expect(galaxyLayerAlpha(GALAXY_FADE_TO_PX)).toBe(1);
    expect(galaxyLayerAlpha(17)).toBe(1);   // Sol at the far-system zoom floor
    const mid = galaxyLayerAlpha((GALAXY_FADE_FROM_PX + GALAXY_FADE_TO_PX) / 2);
    expect(mid).toBeCloseTo(0.5, 9);
  });

  it('every ring is at least the floor, and clears its outermost world', () => {
    expect(galaxyRingRadius(3)).toBe(GALAXY_RING_MIN_PX);
    expect(galaxyRingRadius(80)).toBeGreaterThan(80);
  });
});
