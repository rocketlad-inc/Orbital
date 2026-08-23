// ============================================================
// CHAIN PLANNER — the itinerary solver behind group and fleet
// CHAIN ORDERS.
//
// The single-ship path builds a chain one click at a time through
// React state. This solves the whole thing at once, and the two must
// agree: same waits, same resample rule, same legs.
// ============================================================

import { planChainLegs, carryParkedShip } from '../chainPlanner';
import { bodyPosition } from '../orbitalMechanics';
import { Body } from '../../types';

const mk = (id: string, parent: string | null, extra: Partial<Body> = {}): Body => ({
  id, name: id, type: 'terrestrial', parent,
  radius: 2, soi: 10, mu: 1,
  orbitRadius: parent ? 100 : 0, orbitPeriod: parent ? 50 : 0, angle0: 0,
  color: '#fff',
  ...extra,
} as unknown as Body);

const BODIES: Body[] = [
  mk('sol', null, { type: 'star', radius: 50 } as Partial<Body>),
  mk('earth', 'sol', { orbitRadius: 186, orbitPeriod: 365 }),
  mk('mars', 'sol', { orbitRadius: 280, orbitPeriod: 687 }),
  mk('neptune', 'sol', { orbitRadius: 600, orbitPeriod: 900 }),
];

const ACCEL = 0.05;
const base = (steps: Array<{ bodyId: string; wait: number }>) => planChainLegs({
  startPos: { ...bodyPosition(BODIES[1], 0, BODIES) },
  startVel: { x: 0, y: 0 },
  startTick: 0,
  parkedAtBodyId: 'earth',
  steps,
  bodies: BODIES,
  accel: ACCEL,
});

describe('[pure] chain planner', () => {
  it('solves every leg in order and chains each off the last arrival', () => {
    const legs = base([
      { bodyId: 'mars', wait: 0 },
      { bodyId: 'neptune', wait: 0 },
    ]);
    expect(legs).toHaveLength(2);
    expect(legs[0].targetBodyId).toBe('mars');
    expect(legs[1].targetBodyId).toBe('neptune');
    // Leg 2 departs exactly when leg 1 parks — no wait asked for.
    expect(legs[1].startTick).toBeCloseTo(legs[0].arriveTick, 6);
  });

  it('a wait pushes the NEXT departure by exactly that many ticks', () => {
    const none = base([{ bodyId: 'mars', wait: 0 }, { bodyId: 'neptune', wait: 0 }]);
    const held = base([{ bodyId: 'mars', wait: 0 }, { bodyId: 'neptune', wait: 7 }]);
    expect(held[1].startTick - none[1].startTick).toBeCloseTo(7, 6);
    // The first leg is untouched — a wait delays what follows it.
    expect(held[0].startTick).toBeCloseTo(none[0].startTick, 6);
    expect(held[0].arriveTick).toBeCloseTo(none[0].arriveTick, 6);
  });

  it('a LEADING wait delays the first leg', () => {
    const now = base([{ bodyId: 'mars', wait: 0 }]);
    const later = base([{ bodyId: 'mars', wait: 5 }]);
    expect(later[0].startTick - now[0].startTick).toBeCloseTo(5, 6);
  });

  it('every leg still intercepts where its target actually is', () => {
    const legs = base([
      { bodyId: 'mars', wait: 4 },
      { bodyId: 'neptune', wait: 3 },
    ]);
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      const body = BODIES.find(b => b.id === leg.targetBodyId)!;
      const truth = bodyPosition(body, leg.arriveTick, BODIES);
      expect(leg.interceptPos.x).toBeCloseTo(truth.x, 3);
      expect(leg.interceptPos.y).toBeCloseTo(truth.y, 3);
    }
  });

  it('a waiting ship rides its body rather than holding still', () => {
    // The shared rule. If this returned the input unchanged, every
    // waited leg in the game would launch from a stale point.
    const at = bodyPosition(BODIES[1], 0, BODIES);
    const carried = carryParkedShip(at, BODIES[1], 0, 9, BODIES);
    const truth = bodyPosition(BODIES[1], 9, BODIES);
    expect(carried.x).toBeCloseTo(truth.x, 6);
    expect(carried.y).toBeCloseTo(truth.y, 6);
    // ...and a zero-length wait moves nothing.
    const still = carryParkedShip(at, BODIES[1], 0, 0, BODIES);
    expect(still.x).toBeCloseTo(at.x, 9);
    expect(still.y).toBeCloseTo(at.y, 9);
  });

  it('returns the legs it could solve rather than a broken tail', () => {
    // An unreachable step truncates; the caller reports it. Legs after
    // a failure are meaningless because they assumed it flew.
    const legs = base([
      { bodyId: 'mars', wait: 0 },
      { bodyId: 'nowhere', wait: 0 },
      { bodyId: 'neptune', wait: 0 },
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0].targetBodyId).toBe('mars');
  });

  it('no steps, no legs — and no throw', () => {
    expect(base([])).toHaveLength(0);
  });
});
