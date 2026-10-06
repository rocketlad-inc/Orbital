// ============================================================
// A FAR SYSTEM'S TERRITORY RINGS SIT ON ITS OWN WORLDS.
//
// Seen on staging (2026-10-06): around Centauri and Cygnus the map drew
// wide grey bands that lined up with nothing. They were SOL'S belts --
// the Asteroid Belt, the Kuiper bands, the Far Reach -- copied onto every
// far sun at Sol's radii, because the ring loop ran per STAR and found
// belts map-wide. The far worlds themselves orbit a BARYCENTER, not a
// sun, so they had no rings at all; a far dwarf was chained into Sol's
// Asteroid Belt by radius alone; and the trimming passes compared radii
// across systems, so the far lanes nibbled Sol's Core.
// ============================================================

import { computeSystemRegions } from '../systemRegions';
import { findBelts } from '../../game/systemGrouping';
import type { Body } from '../../types';

const B = (o: Partial<Body> & { id: string; type: Body['type'] }): Body => ({
  name: o.id, radius: 1, orbitRadius: 0, orbitPeriod: 100, angle0: 0, soi: 0, color: '#fff',
  ...o,
} as Body);

const sol = B({ id: 'sol', type: 'star', radius: 50, orbitPeriod: 0 });
const solSide = [
  sol,
  B({ id: 'mercury', type: 'terrestrial', parent: 'sol', orbitRadius: 580 }),
  B({ id: 'venus', type: 'terrestrial', parent: 'sol', orbitRadius: 1070 }),
  B({ id: 'earth', type: 'terrestrial', parent: 'sol', orbitRadius: 1490 }),
  B({ id: 'mars', type: 'terrestrial', parent: 'sol', orbitRadius: 2260 }),
  B({ id: 'ceres', type: 'dwarf', parent: 'sol', orbitRadius: 2880 }),
  B({ id: 'vesta', type: 'dwarf', parent: 'sol', orbitRadius: 2880 }),
  B({ id: 'pallas', type: 'dwarf', parent: 'sol', orbitRadius: 2900 }),
  B({ id: 'jupiter', type: 'gas_giant', parent: 'sol', orbitRadius: 3680 }),
  B({ id: 'io', type: 'moon', parent: 'jupiter', orbitRadius: 40 }),
];
const far = [
  B({ id: 'binary_barycenter', type: 'lagrange', parent: 'sol', orbitRadius: 265200, orbitPeriod: 7e11 }),
  B({ id: 'centauri_a', type: 'star', parent: 'binary_barycenter', orbitRadius: 18, radius: 8 }),
  B({ id: 'centauri_b', type: 'star', parent: 'binary_barycenter', orbitRadius: 28, radius: 6 }),
  B({ id: 'verdant', type: 'terrestrial', parent: 'binary_barycenter', orbitRadius: 400 }),
  B({ id: 'crimson', type: 'gas_giant', parent: 'binary_barycenter', orbitRadius: 850 }),
  B({ id: 'prismara', type: 'moon', parent: 'crimson', orbitRadius: 26 }),
  B({ id: 'cinder', type: 'terrestrial', parent: 'binary_barycenter', orbitRadius: 1400 }),
  // At the radius of Sol's Asteroid Belt, on purpose.
  B({ id: 'farspire', type: 'dwarf', parent: 'binary_barycenter', orbitRadius: 2800 }),
];

const shape = (rs: ReturnType<typeof computeSystemRegions>) =>
  rs.map(r => `${r.id} ${r.shape.starBodyId} ${Math.round(r.shape.rInner)}..${Math.round(r.shape.rOuter)}`).sort();

describe('far-system territory rings', () => {
  const both = computeSystemRegions([...solSide, ...far]);

  it('leaves every Sol ring exactly as it is without the far systems', () => {
    const solOnly = computeSystemRegions(solSide);
    expect(shape(both.filter(r => r.shape.starBodyId === 'sol'))).toEqual(shape(solOnly));
  });

  it('gives no far sun a copy of anything', () => {
    expect(both.filter(r => ['centauri_a', 'centauri_b'].includes(r.shape.starBodyId))).toEqual([]);
  });

  it('rings every far world around its barycenter, over its own orbit', () => {
    for (const id of ['verdant', 'crimson', 'cinder', 'farspire']) {
      const ring = both.find(r => r.bodyIds.includes(id));
      const orbit = far.find(b => b.id === id)!.orbitRadius;
      expect({ id, centre: ring?.shape.starBodyId }).toEqual({ id, centre: 'binary_barycenter' });
      expect(ring!.shape.rInner).toBeLessThan(orbit);
      expect(ring!.shape.rOuter).toBeGreaterThan(orbit);
    }
  });

  it('never files a far dwarf in Sol\'s Asteroid Belt', () => {
    const belt = findBelts([...solSide, ...far]).find(b => b.members.some(m => m.id === 'ceres'));
    expect(belt?.members.map(m => m.id)).not.toContain('farspire');
  });
});
