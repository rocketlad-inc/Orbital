// WHEN DOES A MOON SYSTEM OPEN?
//
// Moon rings, ship sprites and the hull-size ramp all key off one
// question: has this planet's system opened enough on screen to be worth
// drawing in detail. That question used to be answered by measuring the
// PARENT PLANET — rings appear once the planet is >= 12px.
//
// That reading is invariant in the wrong direction. A planet's radius
// does not change when the map spreads, but the moon system around it
// does. At moon_scale 8 you have to zoom out to fit Jupiter's moons on
// screen, which shrinks Jupiter to about 9px and switches the rings off
// at exactly the zoom where you want them.
//
// systemOpenness takes the LARGER of two readings — the system's own
// extent, and the old planet rule. The max matters: it guarantees no
// existing game loses rings it has today, while a spread system opens
// far earlier because its rings are the thing that got bigger.

import { systemOpenness, MOON_SYSTEM_OPEN_PX, MOON_ORBIT_MIN_PARENT_PX } from '../mapRenderer';
import type { Body } from '../../types';

const body = (over: Partial<Body>): Body => ({
  id: 'x', name: 'X', type: 'terrestrial',
  orbitRadius: 100, orbitPeriod: 100, angle0: 0,
  radius: 4, soi: 0, color: '#fff',
  ...over,
} as Body);

/** A planet and its outermost moon. */
function system(planetRadius: number, moonReach: number) {
  const planet = body({ id: 'p', radius: planetRadius, parent: 'sol' });
  const moon = body({ id: 'm', parent: 'p', orbitRadius: moonReach, radius: 1 });
  return [planet, moon];
}

/** Camera scale at which the system first opens. */
function opensAt(planetRadius: number, moonReach: number): number {
  const bodies = system(planetRadius, moonReach);
  const planet = bodies[0];
  let lo = 0.0001, hi = 1000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (systemOpenness(planet, bodies, mid) >= 1) hi = mid; else lo = mid;
  }
  return hi;
}

describe('systemOpenness', () => {
  it('is zero for a body that is not there', () => {
    expect(systemOpenness(undefined, [], 1)).toBe(0);
  });

  it('a moonless body falls back to the planet rule alone', () => {
    const solo = body({ id: 'p', radius: 6, parent: 'sol' });
    // 12px hinge on a radius-6 body means scale 2 exactly.
    expect(systemOpenness(solo, [solo], 2)).toBeCloseTo(1, 5);
    expect(systemOpenness(solo, [solo], 1)).toBeLessThan(1);
  });

  it('opens when the SYSTEM spans the threshold, whatever the planet', () => {
    // Jupiter-ish planet, moons spread 8x. The planet is far under 12px
    // here; the system is what has opened.
    const bodies = system(8, 600);
    const scale = MOON_SYSTEM_OPEN_PX / 600;
    expect(systemOpenness(bodies[0], bodies, scale)).toBeCloseTo(1, 5);
    expect((bodies[0].radius ?? 0) * scale).toBeLessThan(MOON_ORBIT_MIN_PARENT_PX);
  });
});

describe('spreading the map opens systems EARLIER, never later', () => {
  // Shipped geometry, and the same systems at moon_scale 8.
  const SHIPPED: Array<[string, number, number]> = [
    ['earth', 3, 20], ['mars', 2.5, 19], ['jupiter', 8, 75],
    ['saturn', 7, 65], ['uranus', 5, 50], ['neptune', 5, 78], ['pluto', 1.5, 6],
  ];

  it.each(SHIPPED)('%s: an unspread game opens no later than the old rule', (_id, r, reach) => {
    // The old rule was purely the planet: scale = 12 / radius.
    const oldRule = MOON_ORBIT_MIN_PARENT_PX / r;
    // Taking the max of both readings can only open the system sooner.
    expect(opensAt(r, reach)).toBeLessThanOrEqual(oldRule + 1e-9);
  });

  it.each(SHIPPED)('%s: at moon_scale 8 the rings appear much further out', (_id, r, reach) => {
    const unspread = opensAt(r, reach);
    const spread = opensAt(r, reach * 8);
    // Further out = opens at a SMALLER camera scale.
    expect(spread).toBeLessThan(unspread);
  });

  it('jupiter at moon_scale 8 opens ~9x further out than the old rule', () => {
    const oldRule = MOON_ORBIT_MIN_PARENT_PX / 8;        // 1.5
    const spread = opensAt(8, 600);                       // 80/600
    expect(oldRule / spread).toBeGreaterThan(8);
  });
});
