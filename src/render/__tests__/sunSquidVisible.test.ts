// ============================================================
// THE SQUID SHOWS LIKE A SHIP (Lorne, 2026-10-07, watching The NEXT Zone:
// "make it so that the squid shows like ships do. It disappears when you
// zoom out").
//
// A sun gate in flight is a megastructure orbiting the Sun, so the
// presentation folded it like a world: into the Sun on the way out, and
// into any outer world it crossed, since a structure ranks below every
// world. Ships never fold. Neither does the squid now, while it flies.
// ============================================================

import { computePresentation, isInFlight } from '../bodyPresentation';
import type { Body } from '../../types';

const B = (o: Partial<Body> & { id: string; type: Body['type'] }): Body => ({
  name: o.id, radius: 1, orbitRadius: 0, orbitPeriod: 0, angle0: 0, soi: 0, color: '#fff',
  ...o,
} as Body);

const VIEW = { w: 1440, h: 960 };
const sol = B({ id: 'g:sol', type: 'star', radius: 50 });
const neptune = B({ id: 'g:neptune', type: 'ice_giant', parent: 'g:sol', radius: 12, orbitRadius: 12000 });
const squid = B({
  id: 'g:sungate_centauri', type: 'megastructure', parent: 'g:sol', radius: 3.8, orbitRadius: 27000,
  emerge: { fromTick: 291, untilTick: 301 } as Body['emerge'],
});
// Zoomed out to the whole outer system: Neptune ~100px from the Sun.
const SCALE = 100 / 12000;

function present(where: 'sun' | 'neptune', tick: number | null) {
  const pos: Record<string, { x: number; y: number }> = {
    'g:sol': { x: 720, y: 480 },
    'g:neptune': { x: 820, y: 480 },
    // Just off the Sun, early in the burn / right on top of Neptune.
    'g:sungate_centauri': where === 'sun' ? { x: 726, y: 480 } : { x: 822, y: 481 },
  };
  return computePresentation([sol, neptune, squid], SCALE, id => pos[id] ?? null, null, VIEW, null, tick);
}

describe('a sun gate in flight shows like a ship', () => {
  it('knows when it is flying', () => {
    expect(isInFlight(squid, 295)).toBe(true);
    expect(isInFlight(squid, 301)).toBe(false);
    expect(isInFlight(squid, null)).toBe(false);
    expect(isInFlight(neptune, 295)).toBe(false);
  });

  it('is not folded into the Sun as it leaves it', () => {
    expect(present('sun', 295).shown.get(squid.id)).toBe(1);
  });

  it('is not folded into a world it flies across, and folds nothing itself', () => {
    const p = present('neptune', 295);
    expect(p.shown.get(squid.id)).toBe(1);
    expect(p.shown.get(neptune.id)).toBe(1);
  });

  it('models the limit: without the clock (the old call) it folded both ways', () => {
    expect(present('sun', null).shown.get(squid.id)).toBeLessThan(0.5);
    expect(present('neptune', null).shown.get(squid.id)).toBeLessThan(0.5);
  });

  it('once landed it is a gate at rest again, and folds like any structure', () => {
    expect(present('neptune', 305).shown.get(squid.id)).toBeLessThan(0.5);
  });
});
