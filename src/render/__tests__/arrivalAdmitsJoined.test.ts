// A squadron that rides the Mega Destroyer in (a matched intercept) lands
// with it, so it comes in the same way: laid out at its world while still
// in flight, no roster dwell, no dart to its slot (the Battle of Earth
// take, 2026-10-24: ~50 px a frame a second after landing).
import { isImminentArrival } from '../arrivalApproach';
import type { Ship } from '../../types';

const flying = (extra: Partial<Ship> = {}): Ship => ({
  id: 'g:sq_0', class: 'destroyer', ownedBy: 'terra',
  transit: { currentTransfer: { targetBodyId: 'earth', arriveTick: 26 }, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } },
  ...extra,
} as unknown as Ship);
const rv = (meetTick: number) => ({ plannedRendezvous: { meetTick, followShipId: 'g:mega' } } as unknown as Partial<Ship>);

describe('arrivals: hulls on a matched intercept', () => {
  test('a plain arrival is admitted close to landing', () => {
    expect(isImminentArrival(flying(), 25)).toBe(true);
  });

  test('one that meets its leader before landing is admitted while the meeting is still ahead', () => {
    // The take: met at 25.18, landed at 26. The state's tick is whole, so
    // at 25 the meeting has not happened yet; at 26 it has landed.
    expect(isImminentArrival(flying(rv(25.18)), 25)).toBe(true);
    expect(isImminentArrival(flying(rv(25.18)), 24)).toBe(true);
  });

  test('one that is too far out is not, met or not', () => {
    expect(isImminentArrival(flying(rv(20)), 23)).toBe(false);
  });

  test('one that only meets its leader after this leg lands is not', () => {
    expect(isImminentArrival(flying(rv(27.5)), 25)).toBe(false);
  });

  test('a missile never is', () => {
    expect(isImminentArrival(flying({ class: 'missile' } as Partial<Ship>), 25.9)).toBe(false);
  });
});
