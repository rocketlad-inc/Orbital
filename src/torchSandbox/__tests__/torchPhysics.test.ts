// ============================================================
// TORCH SANDBOX — Math tests
// ============================================================

import { BY_ID, bodyPosition } from '../bodies';
import {
  planTorchTransfer, stepTorchShip, sampleTrajectory,
  TorchShipState, fromG, asG,
} from '../torchPhysics';

describe('Torch transfer planner', () => {
  it('closed-form SYMMETRIC brachistochrone matches T = 2·√(d/a)', () => {
    // Treat Sol as a stationary target (it doesn't move).
    const ship: TorchShipState = { pos: { x: 100, y: 0 }, vel: { x: 0, y: 0 } };
    const a = 5;
    const plan = planTorchTransfer(ship, 'sol', a, a, 0);
    expect(plan).not.toBeNull();
    const T = plan!.arriveTick - plan!.startTick;
    const expectedT = 2 * Math.sqrt(100 / a);
    expect(T).toBeCloseTo(expectedT, 4);
    // Flip is at exactly the midpoint
    expect(plan!.flipTick).toBeCloseTo(plan!.startTick + T / 2, 6);
    // Peak velocity = sqrt(a·d)
    expect(plan!.peakVelocity).toBeCloseTo(Math.sqrt(a * 100), 4);
    // Total Δv = a · T = 2 · v_peak
    expect(plan!.totalDv).toBeCloseTo(2 * plan!.peakVelocity, 4);
  });

  it('iterative intercept converges on a moving target (Earth → Mars)', () => {
    // Ship parked at Earth's heliocentric position at t=0
    const earth = BY_ID['earth'];
    const earthPos = bodyPosition(earth, 0);
    const ship: TorchShipState = { pos: { ...earthPos }, vel: { x: 0, y: 0 } };
    const accel = fromG(1);  // 1g
    const plan = planTorchTransfer(ship, 'mars', accel, accel, 0);
    expect(plan).not.toBeNull();
    // intercept should be where Mars actually is at arrival
    const marsAtArrival = bodyPosition(BY_ID['mars'], plan!.arriveTick);
    expect(plan!.interceptPos.x).toBeCloseTo(marsAtArrival.x, 3);
    expect(plan!.interceptPos.y).toBeCloseTo(marsAtArrival.y, 3);
    // And the closed-form travel time matches the converged distance
    const dx = plan!.interceptPos.x - ship.pos.x;
    const dy = plan!.interceptPos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const T = plan!.arriveTick - plan!.startTick;
    expect(T).toBeCloseTo(2 * Math.sqrt(d / accel), 3);
  });

  it('zero-velocity ship on a stationary target traces a straight line', () => {
    const fakeTransfer = {
      targetId: 'sol',
      acceleration: 5,
      brakeAcceleration: 5,
      startTick: 0,
      flipTick: 5,
      arriveTick: 10,
      thrustDir: { x: 1, y: 0 },
      interceptPos: { x: 0, y: 0 },
      startPos: { x: -125, y: 0 },
      startVel: { x: 0, y: 0 },
      totalDv: 50,
      peakVelocity: 25,
    };
    let s: TorchShipState = { pos: { x: -125, y: 0 }, vel: { x: 0, y: 0 } };
    let t = 0;
    while (t < 10) {
      const dt = Math.min(0.05, 10 - t);
      s = stepTorchShip(s, fakeTransfer, t, dt);
      t += dt;
    }
    expect(s.pos.x).toBeCloseTo(0, 0);
    expect(s.pos.y).toBeCloseTo(0, 4);  // never strays off the x-axis
    expect(s.vel.x).toBeCloseTo(0, 6);  // arrived at-rest (Sol vel = 0)
    expect(s.vel.y).toBeCloseTo(0, 6);
  });

  it('a ship with inherited transverse velocity traces a CURVED path', () => {
    // Same fake transfer toward (0,0), but the ship starts with
    // sideways velocity. The integrated path should bend.
    const fakeTransfer = {
      targetId: 'sol',
      acceleration: 5,
      brakeAcceleration: 5,
      startTick: 0,
      flipTick: 5,
      arriveTick: 10,
      thrustDir: { x: 1, y: 0 },
      interceptPos: { x: 0, y: 0 },
      startPos: { x: -125, y: 0 },
      startVel: { x: 0, y: 4 },  // sideways
      totalDv: 50,
      peakVelocity: 25,
    };
    const samples = sampleTrajectory(
      fakeTransfer,
      { pos: { x: -125, y: 0 }, vel: { x: 0, y: 4 } },
      120,
    );
    // Find the maximum y excursion along the path. With sideways
    // velocity it must be > 0 — that's the curve.
    let maxY = 0;
    for (const p of samples) {
      if (p.y > maxY) maxY = p.y;
    }
    expect(maxY).toBeGreaterThan(0.5);  // visibly curved
    // Final arrival snaps to the intercept (0, 0)
    const last = samples[samples.length - 1];
    expect(last.x).toBeCloseTo(0, 0);
    expect(last.y).toBeCloseTo(0, 0);
  });

  it('asymmetric brachistochrone: hard-boost / gentle-brake spends more time braking', () => {
    // Stationary target at origin, ship starts at (-100, 0) at rest.
    // Boost at 10 units/tick², brake at 1 unit/tick².
    const ship: TorchShipState = { pos: { x: -100, y: 0 }, vel: { x: 0, y: 0 } };
    const plan = planTorchTransfer(ship, 'sol', 10, 1, 0);
    expect(plan).not.toBeNull();
    // Closed form: t1 = sqrt(2·d·brake / (boost·(boost+brake)))
    //             = sqrt(2·100·1 / (10·11)) = sqrt(200/110) ≈ 1.348
    const t1 = plan!.flipTick - plan!.startTick;
    const t2 = plan!.arriveTick - plan!.flipTick;
    expect(t1).toBeCloseTo(Math.sqrt(200 / 110), 3);
    // Brake duration is boost-duration · (boost/brake) = 10× longer
    expect(t2).toBeCloseTo(t1 * 10, 3);
    // Peak velocity = boost · t1
    expect(plan!.peakVelocity).toBeCloseTo(10 * t1, 4);
    // Total Δv = 2 · peak (boost adds v, brake subtracts v)
    expect(plan!.totalDv).toBeCloseTo(2 * plan!.peakVelocity, 3);
  });

  it('asymmetric brachistochrone: gentle-boost / hard-brake is opposite shape', () => {
    const ship: TorchShipState = { pos: { x: -100, y: 0 }, vel: { x: 0, y: 0 } };
    const plan = planTorchTransfer(ship, 'sol', 1, 10, 0);
    expect(plan).not.toBeNull();
    // t1 = sqrt(2·100·10 / (1·11)) = sqrt(2000/11) ≈ 13.48
    const t1 = plan!.flipTick - plan!.startTick;
    const t2 = plan!.arriveTick - plan!.flipTick;
    expect(t1).toBeCloseTo(Math.sqrt(2000 / 11), 3);
    // Brake duration is boost-duration · (1/10) → 10× shorter
    expect(t2).toBeCloseTo(t1 / 10, 3);
  });

  it('asymmetric trip ALWAYS takes longer than the matching symmetric trip', () => {
    // For the same distance, symmetric at max(boost, brake) is the
    // fastest brachistochrone. Asymmetric (lower of the two limits
    // dominates one phase) takes longer.
    const ship: TorchShipState = { pos: { x: -100, y: 0 }, vel: { x: 0, y: 0 } };
    const symmetric = planTorchTransfer(ship, 'sol', 10, 10, 0)!;
    const asymmetric = planTorchTransfer(ship, 'sol', 10, 1, 0)!;
    const symT = symmetric.arriveTick - symmetric.startTick;
    const asymT = asymmetric.arriveTick - asymmetric.startTick;
    expect(asymT).toBeGreaterThan(symT);
  });

  it('asG / fromG are inverses', () => {
    expect(asG(fromG(1))).toBeCloseTo(1, 6);
    expect(asG(fromG(3.5))).toBeCloseTo(3.5, 6);
  });

  it('Earth → Mars at 1g takes a reasonable handful of ticks', () => {
    const earth = BY_ID['earth'];
    const ship: TorchShipState = { pos: bodyPosition(earth, 0), vel: { x: 0, y: 0 } };
    const plan = planTorchTransfer(ship, 'mars', fromG(1), fromG(1), 0);
    expect(plan).not.toBeNull();
    const T = plan!.arriveTick - plan!.startTick;
    // 1 tick = 5.4 days; at 1g the Expanse cites Earth→Mars ≈ 2 days.
    // Our anchor was chosen so 1g takes 1 tick for the Sol→Earth distance.
    // Earth→Mars varies by phasing but should be on the order of 1 tick.
    expect(T).toBeGreaterThan(0.3);
    expect(T).toBeLessThan(2.5);
  });
});
