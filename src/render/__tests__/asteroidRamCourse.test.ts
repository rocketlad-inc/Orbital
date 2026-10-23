/**
 * A RAMMED ROCK FLIES INTO ITS TARGET, NOT TO A STOP BESIDE IT.
 *
 * Studio clip "An asteroid rammed into Mars" (prod 20092a06, 2026-10-23):
 * with the rock un-folded and floored at 6 px (b9486bbb) it was still
 * never seen on its way in. The burn is timed for a rock starting at rest
 * (planTorchTransfer, studio fireRam), but the rock leaves its orbit with
 * that orbit's speed, so the bare burn braked to a stop ~520 units off
 * Mars, rode along beside it, and was snapped onto the meeting point at
 * arrival. At Mars's zoom that is 18,000 px off screen: the rock, and the
 * hull parked on Midas with it (st_cam_midas, ~560 units off on the
 * impact frame), were drawn far outside the shot, and the impact flashed
 * on the side the rock had stopped on.
 */
import { bodyPosition } from '../../physics/orbitalMechanics';
import { planTorchTransfer, fromG } from '../../physics/torchTransfer';
import { ramStateAt, ramPlanOf } from '../../../worker/transitCombat.js';
import { drawRammingBody } from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import { ramApproachDir, resetRamApproach } from '../asteroidRam';
import type { Body } from '../../types';

const RAM_ASTEROID_G = 0.005;   // BodyInspector / worker RAM_ASTEROID_G

const sol = { id: 'sol', type: 'star', radius: 20 } as unknown as Body;
const mars = {
  id: 'mars', parent: 'sol', type: 'terrestrial', radius: 3,
  orbitRadius: 1500, orbitPeriod: 2400, angle0: 2.6,
} as unknown as Body;
const midasBase = {
  id: 'midas', parent: 'sol', type: 'asteroid', radius: 0.6,
  orbitRadius: 2700, orbitPeriod: 700, angle0: -0.6,
} as unknown as Body;

function rammed(start: number) {
  const bodies0 = [sol, mars, midasBase];
  const pos = bodyPosition(midasBase, start, bodies0);
  const a = bodyPosition(midasBase, start - 0.01, bodies0);
  const b = bodyPosition(midasBase, start + 0.01, bodies0);
  const vel = { x: (b.x - a.x) / 0.02, y: (b.y - a.y) / 0.02 };
  const accel = fromG(RAM_ASTEROID_G);
  const p = planTorchTransfer({ pos, vel }, 'mars', accel, accel, start, bodies0)!;
  const ramPlan = {
    targetBodyId: 'mars', startTick: p.startTick, flipTick: p.flipTick, arriveTick: p.arriveTick,
    acceleration: p.acceleration, startPos: p.startPos, startVel: p.startVel,
    interceptPos: p.interceptPos, totalDv: p.totalDv, ownedBy: 'f0',
  };
  const rock = { ...midasBase, ramPlan } as unknown as Body;
  return { rock, bodies: [sol, mars, rock], plan: ramPlan };
}

describe('the rammed rock on its way in', () => {
  const { rock, bodies, plan } = rammed(10);

  it('the plan has an inherited speed worth planning for (the fixture is honest)', () => {
    expect(Math.hypot(plan.startVel.x, plan.startVel.y)).toBeGreaterThan(5);
    expect(plan.arriveTick - plan.startTick).toBeGreaterThan(20);
  });

  it('is on the target the tick before it hits, not parked beside it', () => {
    for (const before of [0.05, 0.25]) {
      const t = plan.arriveTick - before;
      const r = bodyPosition(rock, t, bodies);
      const m = bodyPosition(mars, t, bodies);
      expect(Math.hypot(r.x - m.x, r.y - m.y)).toBeLessThan(mars.radius);
    }
  });

  it('closes on the target all the way in: never further off than a tenth of the trip once braking', () => {
    const span = plan.arriveTick - plan.startTick;
    const d0 = Math.hypot(plan.startPos.x - plan.interceptPos.x, plan.startPos.y - plan.interceptPos.y);
    let prev = Infinity;
    for (let u = 0.6; u < 1; u += 0.02) {
      const t = plan.startTick + u * span;
      const r = bodyPosition(rock, t, bodies);
      const m = bodyPosition(mars, t, bodies);
      const gap = Math.hypot(r.x - m.x, r.y - m.y);
      expect(gap).toBeLessThan(prev + 1e-6);
      expect(gap).toBeLessThan(d0 * 0.5);
      prev = gap;
    }
  });

  it('does not jump at arrival', () => {
    const a = bodyPosition(rock, plan.arriveTick - 1e-3, bodies);
    const b = bodyPosition(rock, plan.arriveTick, bodies);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.05);
  });

  it('the impact lands on the side the map drew it crossing the limb', () => {
    // The flash used ramApproachDir: the last rock -> world direction
    // drawRammingBody saw. The rock stopped short, so that was the side it
    // was parked on (the lower-right limb in the clip), not where it came in.
    resetRamApproach();
    const ctx = new Proxy({ canvas: { width: 960, height: 540 } } as Record<string, unknown>, {
      get(t, prop: string) {
        if (prop in t) return t[prop];
        return () => (prop.startsWith('create') ? { addColorStop: () => {} } : undefined);
      },
      set(t, prop: string, v) { t[prop] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    const noCanvas = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    let crossing: { x: number; y: number } | null = null;
    for (let t = plan.arriveTick - 4; t < plan.arriveTick; t += 1 / 15) {
      const m = bodyPosition(mars, t, bodies);
      const r = bodyPosition(rock, t, bodies);
      if (!crossing && Math.hypot(r.x - m.x, r.y - m.y) <= mars.radius) {
        crossing = { x: r.x - m.x, y: r.y - m.y };
      }
      const rc = {
        ctx, canvas: { width: 960, height: 540 } as HTMLCanvasElement,
        camera: { x: m.x, y: m.y, scale: 36 }, bodies, t, nowMs: 0,
      } as unknown as RenderContext;
      drawRammingBody(rock, rc);
    }
    noCanvas.mockRestore();
    expect(crossing).not.toBeNull();
    const dir = ramApproachDir('mars')!;
    const c = Math.hypot(crossing!.x, crossing!.y);
    expect(dir.x * crossing!.x / c + dir.y * crossing!.y / c).toBeGreaterThan(0.95);
  });

  it('the server puts it (and what is parked on it) where the map draws it', () => {
    const row = {
      ram_start_pos_x: plan.startPos.x, ram_start_pos_y: plan.startPos.y,
      ram_start_vel_x: plan.startVel.x, ram_start_vel_y: plan.startVel.y,
      ram_acceleration: plan.acceleration, ram_flip_tick: plan.flipTick,
      ram_start_tick: plan.startTick, ram_arrive_tick: plan.arriveTick,
      ram_intercept_pos_x: plan.interceptPos.x, ram_intercept_pos_y: plan.interceptPos.y,
      ram_target_body_id: 'mars',
    };
    const marsVel = (_id: string, t: number) => {
      const a = bodyPosition(mars, t - 1e-4, bodies), b = bodyPosition(mars, t + 1e-4, bodies);
      return { x: (b.x - a.x) / 2e-4, y: (b.y - a.y) / 2e-4 };
    };
    const span = plan.arriveTick - plan.startTick;
    for (const u of [0.1, 0.4, 0.7, 0.95]) {
      const t = plan.startTick + u * span;
      const s = ramStateAt(ramPlanOf(row), marsVel, t).pos;
      const c = bodyPosition(rock, t, bodies);
      expect(Math.hypot(s.x - c.x, s.y - c.y)).toBeLessThan(0.05);
    }
  });
});
