// A HULL IS DRAWN WHERE ITS BURN PUTS IT.
//
// The map draws every leg as a straight line and used to slide the hull
// along it at one even speed, so a ship building to 1g over a long haul
// looked as slow at the end as at launch (Lorne, 2026-10-06: "show them
// accelerating"). A shaped multiplayer burn is now timed along its line:
// slow off the mark, gathering speed, braking hard at the end — at the
// same point the server's fog and gravity sink put it (orbitPos.js).

import { torchTrajectorySamples } from '../mapRenderer';
import { torchPositionFromSamples, boostState, burnShape, burnFractionAt } from '../../physics/torchTransfer';
import { legProgress } from '../../../worker/orbitPos.js';
import type { TorchTransferPlan } from '../../types';

// Pluto -> Makemake at the burn Lorne approved: launch 0.05g, building to
// 1g over 48 ticks, brake 9x the push reached.
const G = 530.4;
const a0 = 0.05 * G;
const max = 1 * G;
const ramp = (max - a0) / 48;
const d = 28530;
const shape = burnShape(d, a0, ramp, max, 9);

const shaped = (): TorchTransferPlan => ({
  targetBodyId: 'makemake',
  acceleration: a0, brakeAcceleration: shape.brake, accelRamp: ramp, accelMax: max,
  startTick: 100, flipTick: 100 + shape.t1, arriveTick: 100 + Math.ceil(shape.T),
  thrustDir: { x: 1, y: 0 },
  startPos: { x: 0, y: 0 }, startVel: { x: 0, y: 0 }, interceptPos: { x: d, y: 0 },
  totalDv: 0, peakVelocity: shape.vPeak,
});

describe('a shaped burn is drawn on its own speed curve', () => {
  it('creeps off the line, gathers speed, and stops on the intercept', () => {
    const plan = shaped();
    const samples = torchTrajectorySamples(plan, []);
    const at = (f: number) => torchPositionFromSamples(samples, 100 + shape.T * f).x / d;
    // Half the trip in time is nowhere near half the distance: the push
    // has only just started building.
    expect(at(0.5)).toBeLessThan(0.3);
    expect(at(0.25)).toBeLessThan(0.06);
    // Monotonic, and it ends exactly on the intercept.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].t).toBeGreaterThan(samples[i - 1].t);
      expect(samples[i].x).toBeGreaterThanOrEqual(samples[i - 1].x);
    }
    expect(samples[samples.length - 1]).toEqual({ t: plan.arriveTick, x: d, y: 0 });
  });

  it('draws the hull where the server places it for fog and the gravity sink', () => {
    const plan = shaped();
    const samples = torchTrajectorySamples(plan, []);
    const T = plan.arriveTick - plan.startTick;
    const leg = {
      accel: a0, brake: shape.brake, ramp, max,
      startTick: plan.startTick, flipTick: plan.flipTick, arriveTick: plan.arriveTick,
    };
    for (const f of [0.1, 0.3, 0.6, 0.85, 0.93, 0.96, 0.99]) {
      const t = plan.startTick + T * f;
      expect(burnFractionAt(plan, t)).toBeCloseTo(legProgress(f, leg), 9);
      // The drawn (piecewise) position stays within half a percent.
      expect(Math.abs(torchPositionFromSamples(samples, t).x / d - legProgress(f, leg))).toBeLessThan(0.005);
    }
    // And the curve is the physics: distance at the flip is the boost's.
    expect(burnFractionAt(plan, plan.flipTick))
      .toBeCloseTo(boostState(shape.t1, a0, ramp, max).x / d, 9);
  });

  it('single player\'s flat, even burn keeps the plain two-point line', () => {
    const flat = { ...shaped(), brakeAcceleration: a0, accelRamp: undefined, accelMax: undefined };
    expect(torchTrajectorySamples(flat, [])).toHaveLength(2);
  });
});
