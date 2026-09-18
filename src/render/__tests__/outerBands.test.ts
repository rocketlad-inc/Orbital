// ONE BAND PER PLACE PAST NEPTUNE.
//
// Reported from a screenshot: "I see way more than two color bands in
// the outer system, but you just told me everything is now filed as
// either a Plutino or a kuiper object."
//
// Both were true at once. systemGrouping had been taught that a moon
// does not make a Kuiper dwarf its own system, so the panels and the
// senate saw two outer groups — but this file kept its own older rule,
// "a star-orbiter that HAS moons is a planet system", and handed a lane
// to Orcus, Salacia, Varda, Haumea, Quaoar, Makemake and Eris on top of
// the belt band they were already inside. Seven extra rings.
//
// The map now asks findBelts who is in a belt BEFORE it decides who
// gets a lane, which is the same principle the file already states for
// clustering: a belt is one place everywhere, or nowhere.

import { computeSystemRegions } from '../systemRegions';
import { findBelts } from '../../game/systemGrouping';
import type { Body } from '../../types';

const body = (over: Partial<Body>): Body => ({
  id: 'x', name: 'X', type: 'terrestrial',
  orbitRadius: 100, orbitPeriod: 100, angle0: 0,
  radius: 4, soi: 0, color: '#fff',
  ...over,
} as Body);

/** The shipped outer system at system_scale 4, as the live map has it. */
const OUTER: Body[] = [
  body({ id: 'sol', name: 'Sol', type: 'star', parent: undefined, orbitRadius: 0, radius: 100 }),
  body({ id: 'earth', name: 'Earth', parent: 'sol', orbitRadius: 1488, radius: 6 }),
  body({ id: 'luna', name: 'Luna', type: 'moon', parent: 'earth', orbitRadius: 160, radius: 3 }),
  body({ id: 'jupiter', name: 'Jupiter', type: 'gas-giant', parent: 'sol', orbitRadius: 4600, radius: 14 }),
  body({ id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter', orbitRadius: 200, radius: 3 }),
  body({ id: 'uranus', name: 'Uranus', type: 'ice-giant', parent: 'sol', orbitRadius: 8800, radius: 10 }),
  body({ id: 'titania', name: 'Titania', type: 'moon', parent: 'uranus', orbitRadius: 180, radius: 3 }),
  body({ id: 'neptune', name: 'Neptune', type: 'ice-giant', parent: 'sol', orbitRadius: 12000, radius: 10 }),
  body({ id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune', orbitRadius: 200, radius: 4 }),

  // The plutinos: Pluto's ring, Orcus half a lap behind it.
  body({ id: 'pluto', name: 'Pluto', type: 'dwarf', parent: 'sol', orbitRadius: 15200, radius: 3 }),
  body({ id: 'charon', name: 'Charon', type: 'moon', parent: 'pluto', orbitRadius: 48, radius: 2 }),
  body({ id: 'orcus', name: 'Orcus', type: 'dwarf', parent: 'sol', orbitRadius: 15200, radius: 2.4 }),
  body({ id: 'vanth', name: 'Vanth', type: 'moon', parent: 'orcus', orbitRadius: 40, radius: 1.8 }),
  body({ id: 'ixion', name: 'Ixion', type: 'dwarf', parent: 'sol', orbitRadius: 15560, radius: 2 }),

  // The Kuiper belt, and past the 360-wide cliff the Far Reach. Four of
  // these carry moons, which is what used to evict them into lanes of
  // their own; three now do it on the far side of the gap, which is the
  // same regression in the newer band.
  body({ id: 'mani', name: 'Máni', type: 'dwarf', parent: 'sol', orbitRadius: 16800, radius: 2.2 }),
  body({ id: 'salacia', name: 'Salacia', type: 'dwarf', parent: 'sol', orbitRadius: 17920, radius: 2.2 }),
  body({ id: 'actaea', name: 'Actaea', type: 'moon', parent: 'salacia', orbitRadius: 32, radius: 1.6 }),
  body({ id: 'haumea', name: 'Haumea', type: 'dwarf', parent: 'sol', orbitRadius: 20160, radius: 2 }),
  body({ id: 'hiiaka', name: "Hi'iaka", type: 'moon', parent: 'haumea', orbitRadius: 24, radius: 1.8 }),
  body({ id: 'varuna', name: 'Varuna', type: 'dwarf', parent: 'sol', orbitRadius: 19040, radius: 2 }),
  body({ id: 'quaoar', name: 'Quaoar', type: 'dwarf', parent: 'sol', orbitRadius: 21280, radius: 2 }),
  body({ id: 'weywot', name: 'Weywot', type: 'moon', parent: 'quaoar', orbitRadius: 24, radius: 1.4 }),
  body({ id: 'varda', name: 'Varda', type: 'dwarf', parent: 'sol', orbitRadius: 25120, radius: 2.2 }),
  body({ id: 'makemake', name: 'Makemake', type: 'dwarf', parent: 'sol', orbitRadius: 24160, radius: 2 }),
  body({ id: 'mk2', name: 'MK 2', type: 'moon', parent: 'makemake', orbitRadius: 32, radius: 1.4 }),
  body({ id: 'eris', name: 'Eris', type: 'dwarf', parent: 'sol', orbitRadius: 27040, radius: 3 }),
  body({ id: 'dysnomia', name: 'Dysnomia', type: 'moon', parent: 'eris', orbitRadius: 40, radius: 1.8 }),
  body({ id: 'sedna', name: 'Sedna', type: 'dwarf', parent: 'sol', orbitRadius: 28000, radius: 2 }),

  // A rogue whose NOMINAL radius lands on Uranus but which sweeps from
  // inside the belt to past Eris.
  body({
    id: 'black_sky', name: 'Black Sky', type: 'asteroid', parent: 'sol',
    orbitRadius: 8800, radius: 1, orbit_rp: 1600, orbit_ra: 16000,
  } as Partial<Body>),
];

// THE MAP NEVER SEES THE DATABASE'S SPELLING. mapBodyType rewrites
// 'gas-giant' to 'gas_giant' at the /state boundary, so a fixture built
// with the hyphenated form exercises a dialect the real client does not
// have — which is exactly how this suite passed while the shipped map
// fused the asteroid belt and the Kuiper belt into one grey contested
// band and lost the Plutinos entirely. Every case runs in BOTH.
const DIALECT: Record<string, (t: string) => string> = {
  'database spelling': (t) => t,
  'client spelling': (t) =>
    t === 'gas-giant' ? 'gas_giant' : t === 'ice-giant' ? 'ice_giant' : t,
};

describe.each(Object.entries(DIALECT))('outer territory bands (%s)', (_name, retype) => {
  const BODIES = OUTER.map(b => ({ ...b, type: retype(b.type) } as Body));
  const regions = () => computeSystemRegions(BODIES);
  const bandsFor = (id: string) =>
    regions().filter(r => r.bodyIds.includes(id) && r.shape.kind === 'band');
  const OUTER_BODIES = BODIES;
  it('past the planets there are exactly three bands', () => {
    const outerBands = regions().filter(
      r => r.shape.kind === 'band' && r.shape.rInner > 13000,
    );
    expect(outerBands.map(r => r.label).sort())
      .toEqual(['Kuiper Belt', 'The Far Reach', 'The Plutinos']);
  });

  it('the cliff actually separates them', () => {
    // The whole point of the split: the belt has to END before the Far
    // Reach begins, or the two bands are one band wearing two names.
    const belt = regions().find(r => r.label === 'Kuiper Belt')!;
    const far = regions().find(r => r.label === 'The Far Reach')!;
    const bs = belt.shape as { rOuter: number };
    const fs = far.shape as { rInner: number };
    expect(fs.rInner).toBeGreaterThanOrEqual(bs.rOuter - 1);
    expect(far.bodyIds).toContain('sedna');
    expect(belt.bodyIds).not.toContain('sedna');
  });

  it('a Kuiper dwarf with a moon gets no lane of its own', () => {
    // The exact regression: each of these drew its own ring on top of
    // the belt after being given its real moon.
    for (const id of ['haumea', 'quaoar', 'makemake', 'eris', 'salacia', 'varda', 'orcus']) {
      const bands = bandsFor(id);
      expect(bands).toHaveLength(1);
      expect(['Kuiper Belt', 'The Far Reach', 'The Plutinos']).toContain(bands[0].label);
      expect(bands[0].label).not.toContain('System');
    }
  });

  it('their moons are inside the same band, not stray discs', () => {
    for (const [moon, world] of [['charon', 'pluto'], ['vanth', 'orcus'], ['actaea', 'salacia'],
      ['hiiaka', 'haumea'], ['weywot', 'quaoar'], ['mk2', 'makemake'], ['dysnomia', 'eris']]) {
      const m = bandsFor(moon);
      const w = bandsFor(world);
      expect(m).toHaveLength(1);
      expect(m[0].id).toBe(w[0].id);
    }
  });

  it('Pluto and Orcus share the Plutino band, and it is not the Kuiper one', () => {
    const p = bandsFor('pluto')[0];
    expect(p.label).toBe('The Plutinos');
    expect(bandsFor('orcus')[0].id).toBe(p.id);
    expect(bandsFor('haumea')[0].id).not.toBe(p.id);
    expect(bandsFor('sedna')[0].id).not.toBe(p.id);
  });

  it('a real planet still keeps its own system band', () => {
    for (const id of ['jupiter', 'uranus', 'neptune']) {
      const bands = bandsFor(id);
      expect(bands).toHaveLength(1);
      expect(bands[0].label).toContain('System');
    }
  });

  it('a crossing rogue holds no ring and never joins a planet', () => {
    // It is a belt MEMBER politically, but it must not stretch the
    // belt's lane, and it must not be filed under Uranus just because
    // its average orbit lands there.
    const belt = findBelts(OUTER_BODIES).find(b => b.label === 'Kuiper Belt')!;
    expect(belt.members.map(m => m.id)).toContain('black_sky');
    expect(belt.laneMembers.map(m => m.id)).not.toContain('black_sky');
    const uranusBand = bandsFor('uranus')[0];
    expect(uranusBand.label).toBe('Uranus System');
    expect(regions().find(r => r.id === uranusBand.id)!.bodyIds).not.toContain('black_sky');
  });

  it('an outer band held by one empire paints in that empire\'s colour', () => {
    // Reported from a screenshot: "there's a V for one empire over a
    // plutino, and I know that two plutinos belong to V, so why are
    // they not coloured for V?" They were held; the map had lost the
    // band. With the belts fused, the outer system read CONTESTED —
    // grey — no matter who held what.
    const FACTIONS = [{ id: 'fV', name: 'Tritalowda', color: '#26c6da', color2: '#0e7490' }];
    const claims = [
      { bodyId: 'pluto', ownedBy: 'fV' }, { bodyId: 'charon', ownedBy: 'fV' },
      { bodyId: 'haumea', ownedBy: 'fV' }, { bodyId: 'quaoar', ownedBy: 'fV' },
      { bodyId: 'eris', ownedBy: 'fV' },
    ];
    const rs = computeSystemRegions(BODIES, FACTIONS as never, [], claims);
    // One world claimed in each of the three outer bands, so all three
    // have to paint — the Far Reach included.
    for (const id of ['pluto', 'orcus', 'haumea', 'makemake', 'sedna']) {
      const band = rs.find(r => r.bodyIds.includes(id))!;
      expect(band).toBeDefined();
      expect(band.ownership.kind).toBe('exclusive');
      expect((band.ownership as { color: string }).color).toBe('#26c6da');
    }
  });

  it('no two bands past Neptune overlap', () => {
    const outer = regions()
      .filter(r => r.shape.kind === 'band' && r.shape.rInner > 13000)
      .map(r => r.shape as { rInner: number; rOuter: number })
      .sort((a, b) => a.rInner - b.rInner);
    for (let i = 1; i < outer.length; i++) {
      expect(outer[i].rInner).toBeGreaterThanOrEqual(outer[i - 1].rOuter - 1);
    }
  });
});
