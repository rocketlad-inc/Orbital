// ============================================================
// TORCH SANDBOX — Math tests
// ============================================================

import { BY_ID, bodyPosition } from '../bodies';
import {
  planTorchTransfer, stepTorchShip, sampleTrajectory,
  TorchShipState, fromG, asG,
} from '../torchPhysics';

describe('Torch transfer planner', () => {
  it('closed-form brachistochrone matches T = 2·√(d/a) for a stationary target', () => {
    // Treat Sol as a stationary target (it doesn't move).
    const ship: TorchShipState = { pos: { x: 100, y: 0 }, vel: { x: 0, y: 0 } };
    const a = 5;
    const plan = planTorchTransfer(ship, 'sol', a, 0);
    expect(plan).not.toBeNull();
    const T = plan!.arriveTick - plan!.startTick;
    const expectedT = 2 * Math.sqrt(100 / a);
    expect(T).toBeCloseTo(expectedT, 4);
    // Flip is at exactly the midpoint
    expect(plan!.flipTick).toBeCloseTo(plan!.startTick + T / 2, 6);
    // Peak velocity = sqrt(a·d)
    expect(plan!.peakVelocity).toBeCloseTo(Math.sqrt(a * 100), 4);
    // Total Δv = a · T
    expect(plan!.totalDv).toBeCloseTo(a * T, 4);
  });

  it('iterative intercept converges on a moving target (Earth → Mars)', () => {
    // Ship parked at Earth's heliocentric position at t=0
    const earth = BY_ID['earth'];
    const earthPos = bodyPosition(earth, 0);
    const ship: TorchShipState = { pos: { ...earthPos }, vel: { x: 0, y: 0 } };
    const accel = fromG(1);  // 1g
    const plan = planTorchTransfer(ship, 'mars', accel, 0);
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

  it('numerical integration arrives at the intercept point on schedule', () => {
    const ship: TorchShipState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
    const accel = 10;
    const plan = planTorchTransfer(ship, 'sol', accel, 0);
    // Hack: target is Sol at origin, so intercept = (0,0). Trip is
    // d=0 → bail. Use a non-Sol target with a fake stationary position
    // instead. Easier: just verify with sampleTrajectory below.
    expect(plan).toBeNull();  // ship already AT the target

    // Test with a 100-unit straight trip via a fake transfer.
    const fakeStart: TorchShipState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
    const fakeTransfer = {
      targetId: 'sol',
      acceleration: 5,
      startTick: 0,
      flipTick: 5,
      arriveTick: 10,
      thrustDir: { x: 1, y: 0 },
      interceptPos: { x: 125, y: 0 },  // 5 · 10²/4 = 125
      totalDv: 50,
      peakVelocity: 25,
    };
    // Step through with dt=0.1 and check arrival
    let s: TorchShipState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
    let t = 0;
    while (t < 10) {
      const dt = Math.min(0.05, 10 - t);
      s = stepTorchShip(s, fakeTransfer, t, dt);
      t += dt;
    }
    // Arrived close to intercept (within numerical-integration tolerance)
    expect(s.pos.x).toBeCloseTo(125, 0);
    expect(s.pos.y).toBeCloseTo(0, 4);
    // Arrival velocity zeroed (snap-on-arrive)
    expect(s.vel.x).toBeCloseTo(0, 6);
    expect(s.vel.y).toBeCloseTo(0, 6);
    void fakeStart;
  });

  it('sampleTrajectory traces a monotonic path from start to intercept', () => {
    const ship: TorchShipState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
    const fakeTransfer = {
      targetId: 'sol',
      acceleration: 5,
      startTick: 0,
      flipTick: 5,
      arriveTick: 10,
      thrustDir: { x: 1, y: 0 },
      interceptPos: { x: 125, y: 0 },
      totalDv: 50,
      peakVelocity: 25,
    };
    const samples = sampleTrajectory(fakeTransfer, ship, 40);
    expect(samples.length).toBe(41);
    expect(samples[0].x).toBeCloseTo(0, 6);
    expect(samples[samples.length - 1].x).toBeCloseTo(125, 4);
    // Strictly increasing x (monotonic accel-then-decel cover)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].x).toBeGreaterThan(samples[i - 1].x - 1e-9);
    }
  });

  it('asG / fromG are inverses', () => {
    expect(asG(fromG(1))).toBeCloseTo(1, 6);
    expect(asG(fromG(3.5))).toBeCloseTo(3.5, 6);
  });

  it('Earth → Mars at 1g takes a reasonable handful of ticks', () => {
    const earth = BY_ID['earth'];
    const ship: TorchShipState = { pos: bodyPosition(earth, 0), vel: { x: 0, y: 0 } };
    const plan = planTorchTransfer(ship, 'mars', fromG(1), 0);
    expect(plan).not.toBeNull();
    const T = plan!.arriveTick - plan!.startTick;
    // 1 tick = 5.4 days; at 1g the Expanse cites Earth→Mars ≈ 2 days.
    // Our anchor was chosen so 1g takes 1 tick for the Sol→Earth distance.
    // Earth→Mars varies by phasing but should be on the order of 1 tick.
    expect(T).toBeGreaterThan(0.3);
    expect(T).toBeLessThan(2.5);
  });
});
