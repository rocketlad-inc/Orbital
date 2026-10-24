// A squadron that rode the Mega Destroyer in (a matched intercept) lands
// with it, so it comes in the same way: laid out at its world while still
// in flight, no roster dwell, no dart to its slot (the Battle of Earth
// take, 2026-10-24: ~50 px a frame a second after landing).
import { isImminentArrival } from '../arrivalApproach';
import type { Ship } from '../../types';

const flying = (extra: Partial<Ship> = {}): Ship => ({
  id: 'g:sq_0', class: 'destroyer', ownedBy: 'terra',
  transit: { currentTransfer: { targetBodyId: 'earth', arriveTick: 25 }, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } },
  ...extra,
} as unknown as Ship);
const rv = { plannedRendezvous: { meetTick: 24, followShipId: 'g:mega' } } as unknown as Partial<Ship>;

describe('arrivals: hulls on a matched intercept', () => {
  test('a plain arrival is admitted close to landing', () => {
    expect(isImminentArrival(flying(), 24.5)).toBe(true);
  });

  test('before the meeting it is still on its own course: not admitted', () => {
    expect(isImminentArrival(flying(rv), 23.9)).toBe(false);
  });

  test('once it has met its leader it lands with it: admitted', () => {
    expect(isImminentArrival(flying(rv), 24.5)).toBe(true);
  });

  test('a missile never is', () => {
    expect(isImminentArrival(flying({ class: 'missile' } as Partial<Ship>), 24.9)).toBe(false);
  });
});
