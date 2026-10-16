// Hulls parked at the star orbit on the GAME'S star μ: a custom map's sun
// is seeded with Sol's μ times its mass (worker/factions.js), Sol with 0,
// which falls back to the constant (2026-10-15 audit).

import { muOf, GRAVITATIONAL_PARAMS, parentMuForParking } from '../orbitalMechanics';
import type { Body } from '../../types';

const star = (mu: number): Body => ({
  id: 'sol', name: 'Star', type: 'star', orbitRadius: 0, orbitPeriod: 0, angle0: 0,
  radius: 50, soi: 0, color: '#ffd180', mu,
} as Body);

describe('the star\'s mu', () => {
  it('Sol (seeded mu 0) keeps the solar constant', () => {
    expect(muOf('sol', [star(0)])).toBe(GRAVITATIONAL_PARAMS.SOL);
    expect(muOf('sol', [])).toBe(GRAVITATIONAL_PARAMS.SOL);
  });

  it('a custom star\'s own mu is used', () => {
    const heavy = GRAVITATIONAL_PARAMS.SOL * 2.5;
    expect(muOf('sol', [star(heavy)])).toBe(heavy);
    expect(parentMuForParking(star(heavy))).toBe(heavy);
  });
});
