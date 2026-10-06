// ============================================================
// A FAR SYSTEM'S BARYCENTER IS ITS STAR, AND IS NOTHING.
//
// Seen on staging (2026-10-06): the Centauri Barycenter, an empty centre
// of mass carrying the type 'lagrange' (which on this map otherwise means
// a trojan ROCK), took a planet's floor and drew as a grey ball. Both
// Centauri suns orbit it, so they folded into it and vanished; its
// worlds, whose parent was not a star, all took a moon's tiny floor.
// ============================================================

import {
  computePresentation, floorClass, isBarycenter, DISPLAY_FLOOR_PX,
} from '../bodyPresentation';
import type { Body } from '../../types';

const B = (o: Partial<Body> & { id: string; type: Body['type'] }): Body => ({
  name: o.id, radius: 1, orbitRadius: 0, orbitPeriod: 0, angle0: 0, soi: 0, color: '#fff',
  ...o,
} as Body);

const sol = B({ id: 'sol', type: 'star', radius: 50 });
const bary = B({ id: 'g1:binary_barycenter', type: 'lagrange', parent: 'sol', radius: 1, orbitRadius: 265200 });
const starA = B({ id: 'g1:centauri_a', type: 'star', parent: 'g1:binary_barycenter', radius: 8, orbitRadius: 18 });
const starB = B({ id: 'g1:centauri_b', type: 'star', parent: 'g1:binary_barycenter', radius: 6, orbitRadius: 28 });
const verdant = B({ id: 'g1:verdant', type: 'terrestrial', parent: 'g1:binary_barycenter', radius: 4, orbitRadius: 400 });
const crimson = B({ id: 'g1:crimson', type: 'gas_giant', parent: 'g1:binary_barycenter', radius: 9, orbitRadius: 850 });
const prismara = B({ id: 'g1:prismara', type: 'moon', parent: 'g1:crimson', radius: 1.8, orbitRadius: 26 });
// Sol's own trojan rock: a REAL lagrange body, which must be left alone.
const trojan = B({ id: 'g1:hektor', type: 'lagrange', parent: 'sol', radius: 1, orbitRadius: 4600 });

describe('far-system barycenters', () => {
  it('knows a far barycenter, game-prefixed or not, and nothing else', () => {
    expect(isBarycenter(bary)).toBe(true);
    expect(isBarycenter({ id: 'bh_barycenter' } as Body)).toBe(true);
    expect(isBarycenter(trojan)).toBe(false);
    expect(isBarycenter(sol)).toBe(false);
  });

  it('its worlds are planets and giants, not moons', () => {
    expect(floorClass(verdant, bary)).toBe('planet');
    expect(floorClass(crimson, bary)).toBe('giant');
    expect(floorClass(prismara, crimson)).toBe('moon');
  });

  it('a trojan rock keeps the planet floor it always had', () => {
    expect(floorClass(trojan, sol)).toBe('planet');
  });

  it('the barycenter takes no space; its suns stay lit at every zoom', () => {
    const bodies = [sol, bary, starA, starB, verdant, crimson, prismara];
    // Zoomed far out: everything in the system lands on one pixel.
    const at = (id: string) => {
      if (id === 'sol') return { x: 0, y: 0 };
      return { x: 500, y: 300 };
    };
    const p = computePresentation(bodies, 0.0015, at, null, { w: 1200, h: 800 });
    expect(p.radius.get(bary.id)).toBe(0);
    // At least one sun shows (the pair may merge into the brighter one).
    const lit = [starA, starB].filter(s => (p.shown.get(s.id) ?? 0) >= 0.5);
    expect(lit.length).toBeGreaterThan(0);
    // The suns never fold into the empty point.
    expect([starA, starB].map(s => p.host.get(s.id))).not.toContain(bary.id);
  });

  it('a world still gets its proper floor, not a moon\'s', () => {
    const bodies = [sol, bary, starA, starB, verdant];
    const at = (id: string) => (id === 'g1:verdant' ? { x: 900, y: 300 } : id === 'sol' ? { x: -5000, y: 0 } : { x: 500, y: 300 });
    const p = computePresentation(bodies, 0.01, at, null, null);
    expect(p.radius.get(verdant.id)).toBeGreaterThanOrEqual(DISPLAY_FLOOR_PX.planet);
  });
});
