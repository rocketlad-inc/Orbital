// ============================================================
// requeueAfter — queued legs follow the NEW first leg (2026-10-09).
//
// Wil, UBGE: a squadron queued Ganymede -> Io, was then sent to Europa
// first, and ShipPanel re-posted the queued Io leg verbatim: launching
// from Ganymede, before the squadron reached Europa. The server flew it,
// and the squadron jumped across the Jovian system.
// ============================================================

import { requeueAfter } from '../requeue';
import { planChainLegs } from '../chainPlanner';
import { bodyPosition } from '../orbitalMechanics';
import type { Body, TorchTransferPlan } from '../../types';

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
  mk('venus', 'sol', { orbitRadius: 120, orbitPeriod: 225, angle0: 2 }),
  mk('neptune', 'sol', { orbitRadius: 600, orbitPeriod: 900 }),
];
const ACCEL = 0.05;
const from = (bodyId: string, t: number, steps: Array<{ bodyId: string; wait: number }>) => planChainLegs({
  startPos: { ...bodyPosition(BODIES.find(b => b.id === bodyId)!, t, BODIES) },
  startVel: { x: 0, y: 0 }, startTick: t, parkedAtBodyId: bodyId,
  steps, bodies: BODIES, accel: ACCEL,
}) as unknown as TorchTransferPlan[];

describe('[pure] queued legs after a new first leg', () => {
  // The OLD route: Earth -> Neptune queued from Earth at T0.
  const oldQueue = from('earth', 0, [{ bodyId: 'neptune', wait: 3 }]);
  // The NEW first leg: Earth -> Mars, committed at T0.
  const [newFirst] = from('earth', 0, [{ bodyId: 'mars', wait: 0 }]);

  it('the old queued leg launches from the wrong place (the bug)', () => {
    const marsAtArrival = bodyPosition(BODIES[2], newFirst.arriveTick, BODIES);
    const d = Math.hypot(oldQueue[0].startPos.x - marsAtArrival.x, oldQueue[0].startPos.y - marsAtArrival.y);
    expect(d).toBeGreaterThan(50);
    expect(oldQueue[0].startTick).toBeLessThan(newFirst.arriveTick);
  });

  it('is re-planned to leave from where the new first leg parks, when it parks', () => {
    const [leg] = requeueAfter(oldQueue, newFirst, BODIES, ACCEL);
    expect(leg.targetBodyId).toBe('neptune');
    expect(leg.startTick).toBeCloseTo(newFirst.arriveTick, 6);
    expect(Math.hypot(leg.startPos.x - newFirst.interceptPos.x, leg.startPos.y - newFirst.interceptPos.y)).toBeLessThan(1e-6);
  });

  it('keeps the waits between queued legs', () => {
    const q = from('earth', 0, [{ bodyId: 'venus', wait: 0 }, { bodyId: 'neptune', wait: 5 }]);
    const out = requeueAfter(q, newFirst, BODIES, ACCEL);
    expect(out).toHaveLength(2);
    expect(out[1].startTick - out[0].arriveTick).toBeCloseTo(5, 6);
  });

  it('an intercept first leg (null) or an empty queue leaves the queue as it was', () => {
    expect(requeueAfter(oldQueue, null, BODIES, ACCEL)).toEqual(oldQueue);
    expect(requeueAfter([], newFirst, BODIES, ACCEL)).toEqual([]);
  });

  it('a queued intercept and what follows it go up unchanged', () => {
    const rvLeg = { ...oldQueue[0], rv: { A: { x: 0, y: 0 }, B: { x: 0, y: 0 }, meetTick: 99, followShipId: 's' } };
    const q = [...from('earth', 0, [{ bodyId: 'venus', wait: 0 }]), rvLeg];
    const out = requeueAfter(q, newFirst, BODIES, ACCEL);
    expect(out).toHaveLength(2);
    expect(out[0].startTick).toBeCloseTo(newFirst.arriveTick, 6);
    expect(out[1]).toBe(rvLeg);
  });
});
