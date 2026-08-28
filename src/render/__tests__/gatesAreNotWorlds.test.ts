// "Is the herald counting gates as worlds?" -- it was.
//
// A discovered stargate stands up two real BODIES: one orbiting the
// world that hid it, one in solar orbit. Neither takes a settlement,
// so neither is a place anyone can hold -- but both were left in the
// world lists, so Neptune reported 4 MOONS against its three real ones
// and the Solar Gate claimed a top-level column beside the planets.
//
// Same rule, and the same omission, as lagrange points and meteoroids.

import { computeSystemRegions } from '../systemRegions';
import type { Body } from '../../types';

const body = (over: Partial<Body>): Body => ({
  id: 'x', name: 'X', type: 'terrestrial',
  orbitRadius: 100, orbitPeriod: 100, angle0: 0,
  radius: 4, soi: 0, color: '#fff',
  ...over,
} as Body);

const SOL: Body[] = [
  body({ id: 'sol', name: 'Sol', type: 'star', parent: undefined, orbitRadius: 0, radius: 100 }),
  body({ id: 'earth', name: 'Earth', parent: 'sol', orbitRadius: 1488, radius: 6 }),
  body({ id: 'neptune', name: 'Neptune', type: 'ice_giant', parent: 'sol', orbitRadius: 9000, radius: 24 }),
  body({ id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune', orbitRadius: 200, radius: 3 }),
  body({ id: 'proteus', name: 'Proteus', type: 'moon', parent: 'neptune', orbitRadius: 260, radius: 2 }),
  body({ id: 'nereid', name: 'Nereid', type: 'moon', parent: 'neptune', orbitRadius: 320, radius: 2 }),
];

// What a discovered stargate adds: a gate in orbit of the host, and its
// twin in close solar orbit.
const GATES: Body[] = [
  body({ id: 'mega_aaa', name: 'Neptune Gate', type: 'megastructure', parent: 'neptune', orbitRadius: 400, radius: 2 }),
  body({ id: 'mega_bbb', name: 'Solar Gate', type: 'megastructure', parent: 'sol', orbitRadius: 300, radius: 2 }),
];

describe('gates are not worlds', () => {
  it('gives the solar gate no lane of its own', () => {
    const withGates = computeSystemRegions([...SOL, ...GATES], []);
    const claimed = withGates.flatMap(r => r.bodyIds);
    expect(claimed).not.toContain('mega_bbb');
    expect(claimed).not.toContain('mega_aaa');
  });

  it('leaves the planets lanes unchanged by a spawned gate pair', () => {
    const before = computeSystemRegions(SOL, []);
    const after = computeSystemRegions([...SOL, ...GATES], []);
    expect(after.length).toBe(before.length);
  });
});
