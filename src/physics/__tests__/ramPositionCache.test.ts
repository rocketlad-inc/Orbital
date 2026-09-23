// [pure] A redirected asteroid's position is cached per plan, not
// re-integrated from launch on every call.
//
// 2026-09-23: with a live ram on the board, one player's canvas draw time
// climbed 31 -> 62 -> 94 -> 211ms per frame as the rock flew
// (perf_heartbeats), while everyone else drew in 9ms. ramBodyPosition
// integrated from startTick on every call, one step per tick, and the map
// calls it dozens of times a frame. These pin two things: the cached path
// is the SAME path, and a late-flight call no longer costs the whole
// flight.

import { bodyPosition } from '../orbitalMechanics';
import type { Body, RamPlan } from '../../types';

const SOL = { id: 'sol', name: 'Sol', type: 'star', radius: 5, mu: 1000, orbitRadius: 0, orbitPeriod: 1, angle0: 0 } as unknown as Body;
const EARTH = {
  id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol', radius: 1, mu: 1, soi: 5,
  orbitRadius: 400, orbitPeriod: 300, angle0: 0.3,
} as unknown as Body;

const plan: RamPlan = {
  targetBodyId: 'earth', startTick: 100.25, flipTick: 180.5, arriveTick: 260.75,
  acceleration: 0.02, startPos: { x: -600, y: 250 }, startVel: { x: 0.4, y: -0.3 },
  interceptPos: { x: 120, y: 380 }, totalDv: 3, ownedBy: 'f1',
};
const rock = { id: 'rock', name: 'Rock', type: 'asteroid', parent: 'sol', radius: 0.5, mu: 0, orbitRadius: 650, orbitPeriod: 900, angle0: 2, ramPlan: plan } as unknown as Body;
const BODIES = [SOL, EARTH, rock];

/** The integrator exactly as it was before the cache: from launch, every call. */
function reference(t: number) {
  if (t <= plan.startTick) return plan.startPos;
  if (t >= plan.arriveTick) return plan.interceptPos;
  let px = plan.startPos.x, py = plan.startPos.y, vx = plan.startVel.x, vy = plan.startVel.y;
  let cur = plan.startTick;
  while (cur < t) {
    const dt = Math.min(1, t - cur);
    const mid = cur + dt / 2;
    let ax: number, ay: number;
    if (mid < plan.flipTick) {
      const dx = plan.interceptPos.x - px, dy = plan.interceptPos.y - py;
      const d = Math.hypot(dx, dy);
      ax = plan.acceleration * dx / d; ay = plan.acceleration * dy / d;
    } else {
      // Earth's velocity on its circular orbit, by central difference of
      // the real position function (what bodyWorldVelocityRaw returns).
      const h = 1e-3;
      const a = bodyPosition(EARTH, mid - h, BODIES), b = bodyPosition(EARTH, mid + h, BODIES);
      const tvx = (b.x - a.x) / (2 * h), tvy = (b.y - a.y) / (2 * h);
      const rvx = vx - tvx, rvy = vy - tvy, rv = Math.hypot(rvx, rvy);
      ax = -plan.acceleration * rvx / rv; ay = -plan.acceleration * rvy / rv;
    }
    px += vx * dt + 0.5 * ax * dt * dt; py += vy * dt + 0.5 * ay * dt * dt;
    vx += ax * dt; vy += ay * dt; cur += dt;
  }
  return { x: px, y: py };
}

describe('[pure] ram position cache', () => {
  it('matches the from-launch integrator across boost, flip and brake', () => {
    // Visited out of order, so a cache that only works front-to-back fails.
    for (const t of [250.3, 101, 180.49, 180.51, 130.7, 259.9, 200, 100.26]) {
      const got = bodyPosition(rock, t, BODIES);
      const want = reference(t);
      expect(got.x).toBeCloseTo(want.x, 1);
      expect(got.y).toBeCloseTo(want.y, 1);
    }
  });

  it('a late-flight call costs about one step, not the whole flight', () => {
    bodyPosition(rock, 259.5, BODIES);            // warm the cache once
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) bodyPosition(rock, 259.5 - (i % 7) * 0.013, BODIES);
    const cached = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) reference(259.5 - (i % 7) * 0.013);
    const fromLaunch = (performance.now() - t1) * (2000 / 50);
    // 2000 cached calls must beat the old cost of 2000 calls by a wide margin.
    expect(cached * 10).toBeLessThan(fromLaunch);
  });
});
