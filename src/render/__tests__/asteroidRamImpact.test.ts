/**
 * AN ASTEROID RAM LOOKS LIKE A ROCK HITTING A WORLD.
 *
 * Studio clip "An asteroid rammed into Mars" (2026-10-23), real client
 * frames:
 *  - the rock was never seen on its way in, only the red reticle at the
 *    meeting point: closing on Mars it folded into Mars as the lesser
 *    sibling (bodyPresentation) and was not drawn at all;
 *  - the impact flashed at Mars's centre, and the 'terraform_destroyed'
 *    row it writes played as a Mega Destroyer strike: a beam straight
 *    down from the top of the screen, the fire spreading from the top.
 */
import { ingestChronicleFx, drainVisibleFx, resetPendingFx, PendingFx } from '../pendingFx';
import { spawnSterilisation, drawSterilisations } from '../combatFx';
import { computePresentation } from '../bodyPresentation';
import { impactPoint, ramThrustDir, noteRamApproach, ramApproachDir, resetRamApproach, RAM_ROCK_MIN_PX } from '../asteroidRam';
import type { RenderContext } from '../mapRenderer';
import type { Body } from '../../types';
import { ramImpactFrom } from '../../../worker/ramImpact.js';

const W = 1200, H = 800;

function drainAll(): PendingFx[] {
  const fired: PendingFx[] = [];
  let now = performance.now();
  for (let i = 0; i < 10; i++) {
    now += 1000;
    drainVisibleFx(now, () => ({ x: 100, y: 100 }), (fx) => { fired.push(fx); });
  }
  return fired;
}

describe('its chronicle rows', () => {
  beforeEach(() => { resetPendingFx(); try { localStorage.clear(); } catch { /* jsdom */ } });

  it('the biosphere it kills burns as an impact, not a Planet Killer strike', () => {
    ingestChronicleFx('ram1', [
      { id: 'tf', kind: 'terraform_destroyed', bodyId: 'mars', cause: 'asteroid', from: { x: -0.6, y: -0.8 } },
      { id: 'im', kind: 'asteroid_impact', bodyId: 'mars', cause: 'asteroid', from: { x: -0.6, y: -0.8 } },
      // A Mega Destroyer's is unchanged.
      { id: 'md', kind: 'terraform_destroyed', bodyId: 'earth', cause: 'mega_destroyer' },
    ]);
    const fired = drainAll();
    // World strikes play the moment they can be seen, ahead of the
    // stagger (strikeLandsFirst.test.ts), so the two strikes come first.
    expect(fired.map(f => f.kind)).toEqual(['impact_scorch', 'sterilise', 'impact']);
    expect(fired.find(f => f.id === 'tf')!.from).toEqual({ x: -0.6, y: -0.8 });
    expect(fired.find(f => f.id === 'im')!.from).toEqual({ x: -0.6, y: -0.8 });
  });

  it('the server says which side it came in on', () => {
    // Launched up and to the left of where it met its target.
    const from = ramImpactFrom({ ram_start_pos_x: -30, ram_start_pos_y: -40, ram_intercept_pos_x: 0, ram_intercept_pos_y: 0 });
    expect(from.from_dx).toBeCloseTo(-0.6, 4);
    expect(from.from_dy).toBeCloseTo(-0.8, 4);
    expect(ramImpactFrom({ ram_start_pos_x: null })).toEqual({});
  });
});

describe('where it lands', () => {
  it('on the rim facing the rock, not the centre', () => {
    expect(impactPoint({ x: 10, y: 20 }, { x: -1, y: 0 }, 4)).toEqual({ x: 10 - 3.4, y: 20 });
    expect(impactPoint({ x: 10, y: 20 }, null, 4)).toEqual({ x: 10, y: 20 });
  });

  it('remembers the side it watched the rock come in on', () => {
    resetRamApproach();
    noteRamApproach('mars', -30, -40);
    expect(ramApproachDir('mars')!.x).toBeCloseTo(-0.6, 9);
    expect(ramApproachDir('mars')!.y).toBeCloseTo(-0.8, 9);
    expect(ramApproachDir('venus')).toBeNull();
  });

  it('burns the world from that side, with no gun beam', () => {
    const calls: Array<{ m: string; args: unknown[] }> = [];
    const target: Record<string, unknown> = { canvas: { width: W, height: H } };
    const ctx = new Proxy(target, {
      get(t, prop: string) {
        if (prop in t) return t[prop];
        return (...args: unknown[]) => {
          calls.push({ m: prop, args });
          if (prop.startsWith('create')) return { addColorStop: () => {} };
          return undefined;
        };
      },
      set(t, prop: string, v) { t[prop] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    const sol = { id: 'sol', type: 'star', radius: 20, parent: null, orbitRadius: 0, orbitPeriod: 1, angle0: 0 } as unknown as Body;
    const mars = { id: 'mars', type: 'terrestrial', radius: 2.5, parent: 'sol', orbitRadius: 283, orbitPeriod: 1e9, angle0: 0 } as unknown as Body;
    const rc = {
      ctx, canvas: { width: W, height: H } as HTMLCanvasElement,
      camera: { x: 283, y: 0, scale: 60 }, bodies: [sol, mars], t: 0, nowMs: 0,
    } as unknown as RenderContext;
    const t0 = 5_000_000;
    const spy = jest.spyOn(performance, 'now').mockImplementation(() => t0);
    spawnSterilisation('ram-tf', 'mars', { beam: false, from: { x: -1, y: 0 } });
    spy.mockRestore();
    const cp = { x: W / 2, y: H / 2 };
    const R = 2.5 * 60;
    // Into the fire.
    drawSterilisations(rc, t0 + 5200 * 0.45);
    // No beam: drawBeam strokes a line from the gun; nothing is stroked
    // from outside the world.
    const lines = calls.filter(c => c.m === 'moveTo').map(c => ({ x: c.args[0] as number, y: c.args[1] as number }));
    expect(lines.every(p => Math.hypot(p.x - cp.x, p.y - cp.y) < R * 1.1)).toBe(true);
    // The fire's glows, wherever they were drawn (sprite or fallback disc),
    // not counting the rings and the ash centred on the world.
    const glows: Array<{ x: number; y: number }> = [];
    for (const c of calls) {
      if (c.m === 'drawImage' && c.args.length >= 5) {
        glows.push({ x: (c.args[1] as number) + (c.args[3] as number) / 2, y: (c.args[2] as number) + (c.args[4] as number) / 2 });
      } else if (c.m === 'arc') {
        const p = { x: c.args[0] as number, y: c.args[1] as number };
        if (Math.hypot(p.x - cp.x, p.y - cp.y) > 1) glows.push(p);
      }
    }
    expect(glows.length).toBeGreaterThan(4);
    const mx = glows.reduce((a, p) => a + p.x, 0) / glows.length;
    const my = glows.reduce((a, p) => a + p.y, 0) / glows.length;
    expect(mx).toBeLessThan(cp.x - R * 0.25);           // the side it came from
    expect(Math.abs(my - cp.y)).toBeLessThan(R * 0.25); // not the top
  });
});

describe('the rock on its way in', () => {
  const sol = { id: 'sol', type: 'star', radius: 20, parent: null } as never;
  const mars = { id: 'mars', type: 'terrestrial', radius: 2.5, parent: 'sol', orbitRadius: 283 } as never;
  const rock = (ram: boolean) => ({
    id: 'midas', type: 'asteroid', radius: 0.6, parent: 'sol', orbitRadius: 345, mineralKind: 'metal',
    ...(ram ? { ramPlan: { arriveTick: 40 } } : {}),
  }) as never;
  // A Mars close-up: the rock just off Mars's disc, a moment from impact.
  const scale = 60;
  const pos = (id: string) => (id === 'mars' ? { x: 600, y: 400 } : id === 'midas' ? { x: 600 - 2.5 * 60 - 10, y: 400 } : { x: -1e5, y: 0 });

  it('is drawn, not folded into the world it is about to hit', () => {
    const p = computePresentation([sol, mars, rock(true)], scale, pos, null, { w: W, h: H }, null, 33.5);
    expect(p.shown.get('midas')).toBe(1);
    expect(p.radius.get('midas')!).toBeGreaterThanOrEqual(RAM_ROCK_MIN_PX);
  });
  it('a rock merely passing still folds as before', () => {
    const p = computePresentation([sol, mars, rock(false)], scale, pos, null, { w: W, h: H }, null, 33.5);
    expect(p.shown.get('midas')).toBe(0);
  });
  it('once it has arrived it is no longer in flight', () => {
    const p = computePresentation([sol, mars, rock(true)], scale, pos, null, { w: W, h: H }, null, 40);
    expect(p.shown.get('midas')).toBe(0);
  });

  it('its thrusters push at the meeting point, then brake against its closing speed', () => {
    const plan = { flipTick: 10, interceptPos: { x: 100, y: 0 } };
    const target = (t: number) => ({ x: 100 + t, y: 0 });
    // Boost: rock at the origin, pushing at the meeting point (+x).
    const boost = ramThrustDir(plan, 5, () => ({ x: 0, y: 0 }), target)!;
    expect(boost.x).toBeCloseTo(1, 9);
    // Brake: closing on the target at +3/tick relative: push is -x.
    const brake = ramThrustDir(plan, 12, (t) => ({ x: 80 + 4 * t, y: 0 }), target)!;
    expect(brake.x).toBeCloseTo(-1, 9);
  });
});
