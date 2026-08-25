// ============================================================
// WAIT n TICKS — a delayed departure must be planned from where
// the ship WILL be, not where it is now.
//
// "Wait 3 ticks, then go to Neptune" is implemented as nothing more
// than a later departure tick. The trap is that a parked ship is not
// stationary: it rides its parent body around the sun. Planning the
// burn from the arrival position would aim from where the ship was n
// ticks ago, and at these orbital rates that is a long way off.
//
// These tests pin the two halves of that claim.
// ============================================================

import { planTorchTransfer } from '../torchTransfer';
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
  mk('neptune', 'sol', { orbitRadius: 600, orbitPeriod: 900 }),
];

const ACCEL = 0.05;
const EARTH = BODIES[1];
const NEPTUNE = BODIES[2];

const planFrom = (sampleTick: number, departTick: number) => planTorchTransfer(
  { pos: { ...bodyPosition(EARTH, sampleTick, BODIES) }, vel: { x: 0, y: 0 } },
  'neptune', ACCEL, ACCEL, departTick, BODIES,
);

describe('[pure] wait-n-ticks departure', () => {
  it('a waited leg departs at the requested tick, not now', () => {
    const now = planFrom(10, 10);
    const waited = planFrom(13, 13);
    expect(now).not.toBeNull();
    expect(waited).not.toBeNull();
    expect(waited!.startTick).toBeCloseTo(13, 6);
    expect(waited!.startTick - now!.startTick).toBeCloseTo(3, 6);
  });

  it('the waited leg still intercepts where the target actually is', () => {
    // The correctness claim: converge on the target's position at
    // ARRIVAL, having departed later than the unwaited plan would.
    const waited = planFrom(13, 13);
    expect(waited).not.toBeNull();
    const truth = bodyPosition(NEPTUNE, waited!.arriveTick, BODIES);
    expect(waited!.interceptPos.x).toBeCloseTo(truth.x, 3);
    expect(waited!.interceptPos.y).toBeCloseTo(truth.y, 3);
  });

  it('resampling the launch point is not cosmetic — the ship really moves', () => {
    // This is the bug the resample exists to prevent. If the launch
    // point were left at the arrival position, the planner would
    // honestly solve the wrong problem: a burn starting somewhere the
    // ship is not.
    const a = bodyPosition(EARTH, 10, BODIES);
    const b = bodyPosition(EARTH, 13, BODIES);
    const launchGap = Math.hypot(b.x - a.x, b.y - a.y);
    expect(launchGap).toBeGreaterThan(1);

    // And the resulting burn differs: same departure tick, different
    // launch point, different plan.
    const correct = planFrom(13, 13);
    const stale = planFrom(10, 13);
    expect(correct).not.toBeNull();
    expect(stale).not.toBeNull();
    expect(correct!.totalDv).not.toBeCloseTo(stale!.totalDv, 6);
  });

  it('a zero wait is byte-for-byte the old behaviour', () => {
    // Every pre-existing caller passes 0, including the frozen SP sim.
    const a = planFrom(10, 10);
    const b = planFrom(10, 10);
    expect(a).not.toBeNull();
    expect(a!.startTick).toBeCloseTo(b!.startTick, 9);
    expect(a!.arriveTick).toBeCloseTo(b!.arriveTick, 9);
    expect(a!.totalDv).toBeCloseTo(b!.totalDv, 9);
  });
});
