// WHERE ONE TERRITORY ENDS AND THE NEXT BEGINS.
//
// Reported as "why is Earth right on the edge of its own wash — can we
// even it out with Venus?" on a 4x map.
//
// Lanes are grown until they touch, so the map has no neutral strips
// between the coloured rings. The pass that does it met neighbours at
// the midpoint of their CENTRES, and a band's centre was the middle of
// its annulus. That is the planet for a planet's own lane, and nonsense
// for The Core, which runs from the star out past the inner planets: its
// middle lands halfway to the sun. Against a Core "centred" at 619,
// Earth's band was pulled in to 1054 — inside Venus's own orbit.

import { computeSystemRegions } from '../systemRegions';
import type { Body } from '../../types';

const body = (over: Partial<Body>): Body => ({
  id: 'x', name: 'X', type: 'terrestrial',
  orbitRadius: 100, orbitPeriod: 100, angle0: 0,
  radius: 4, soi: 0, color: '#fff',
  ...over,
} as Body);

/** The shipped inner system at system_scale 4 / moon_scale 8. */
const VENUS_R = 1072;
const EARTH_R = 1488;
const MARS_R = 2264;

const SOL_4X: Body[] = [
  body({ id: 'sol', name: 'Sol', type: 'star', parent: undefined, orbitRadius: 0, radius: 100 }),
  body({ id: 'mercury', name: 'Mercury', parent: 'sol', orbitRadius: 576, radius: 4 }),
  body({ id: 'venus', name: 'Venus', parent: 'sol', orbitRadius: VENUS_R, radius: 6 }),
  body({ id: 'earth', name: 'Earth', parent: 'sol', orbitRadius: EARTH_R, radius: 6 }),
  body({ id: 'luna', name: 'Luna', type: 'moon', parent: 'earth', orbitRadius: 160, radius: 3 }),
  body({ id: 'mars', name: 'Mars', parent: 'sol', orbitRadius: MARS_R, radius: 5 }),
];

function bandOf(id: string) {
  const r = computeSystemRegions(SOL_4X).find(
    x => x.bodyIds.includes(id) && x.shape.kind === 'band',
  );
  if (!r || r.shape.kind !== 'band') throw new Error(`no band for ${id}`);
  return r.shape;
}

describe('territory borders', () => {
  it('splits Venus and Earth exactly between the two worlds', () => {
    const midpoint = (VENUS_R + EARTH_R) / 2;
    expect(bandOf('venus').rOuter).toBeCloseTo(midpoint, 6);
    expect(bandOf('earth').rInner).toBeCloseTo(midpoint, 6);
  });

  it('splits Earth and Mars the same way', () => {
    const midpoint = (EARTH_R + MARS_R) / 2;
    expect(bandOf('earth').rOuter).toBeCloseTo(midpoint, 6);
    expect(bandOf('mars').rInner).toBeCloseTo(midpoint, 6);
  });

  // The specific failure: Earth's wash reaching back past Venus.
  it('never lets one planet\'s wash cross its neighbour\'s orbit', () => {
    expect(bandOf('earth').rInner).toBeGreaterThan(VENUS_R);
    expect(bandOf('mars').rInner).toBeGreaterThan(EARTH_R);
  });

  it('keeps every world inside its own territory', () => {
    for (const [id, r] of [['venus', VENUS_R], ['earth', EARTH_R], ['mars', MARS_R]] as const) {
      const b = bandOf(id);
      expect(r).toBeGreaterThan(b.rInner);
      expect(r).toBeLessThan(b.rOuter);
    }
  });

  it('leaves no overlap and no gap between neighbours', () => {
    const ordered = ['venus', 'earth', 'mars'].map(bandOf);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].rInner).toBeCloseTo(ordered[i - 1].rOuter, 6);
    }
  });
});
