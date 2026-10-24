/**
 * ZOOMING INTO A RAMMED ROCK MUST NOT COST MORE THE CLOSER YOU GET.
 *
 * Sam, 2026-10-22: "Zooming into an asteroid that has planetary thrusters
 * active absolutely shreds the FPS". drawRammingBody strokes the leg still
 * to fly and the target's path to the meeting point DASHED, and handed the
 * canvas every point unclipped. Zoomed in on the rock, the course reaches
 * millions of px off screen and the dash pattern is rasterised along all
 * of it: measured in headless Chrome at 2880x1800, the overlay took 109 ms
 * a frame at scale 1000 (93 ms of it dashing 2.2M px of line) against
 * 16 ms with the dashes off. Every stroke is now clipped to the screen
 * plus a screen of margin (safePolyline), so the dashed length stays a
 * few screens however far in you zoom.
 */
import { bodyPosition } from '../../physics/orbitalMechanics';
import { planTorchTransfer, fromG } from '../../physics/torchTransfer';
import { drawRammingBody } from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import type { Body } from '../../types';

const sol = { id: 'sol', type: 'star', radius: 20 } as unknown as Body;
const mars = {
  id: 'mars', name: 'Mars', parent: 'sol', type: 'terrestrial', radius: 3,
  orbitRadius: 1500, orbitPeriod: 2400, angle0: 2.6,
} as unknown as Body;
const midasBase = {
  id: 'midas', name: 'Midas', parent: 'sol', type: 'asteroid', radius: 0.6,
  orbitRadius: 2700, orbitPeriod: 700, angle0: -0.6, color: '#8a7f70',
} as unknown as Body;

function rammed() {
  const start = 10;
  const b0 = [sol, mars, midasBase];
  const pos = bodyPosition(midasBase, start, b0);
  const a = bodyPosition(midasBase, start - 0.01, b0);
  const b = bodyPosition(midasBase, start + 0.01, b0);
  const vel = { x: (b.x - a.x) / 0.02, y: (b.y - a.y) / 0.02 };
  const acc = fromG(0.005);
  const p = planTorchTransfer({ pos, vel }, 'mars', acc, acc, start, b0)!;
  const ramPlan = {
    targetBodyId: 'mars', startTick: p.startTick, flipTick: p.flipTick, arriveTick: p.arriveTick,
    acceleration: p.acceleration, startPos: p.startPos, startVel: p.startVel,
    interceptPos: p.interceptPos, totalDv: p.totalDv, ownedBy: 'f0',
  };
  const rock = { ...midasBase, ramPlan } as unknown as Body;
  return { rock, bodies: [sol, mars, rock], plan: ramPlan };
}

const W = 2880, H = 1800;

/** A canvas that measures what it is asked to draw: total dashed line
 *  length, how far off screen a DASHED path reaches (its cost), and how
 *  far off screen anything at all is handed over (far coordinates break
 *  some GPUs: farOffCanvas). */
function recordingCtx() {
  const s = { dashed: 0, farDashed: 0, farAny: 0, dash: false, x: 0, y: 0 };
  // How far outside the canvas a point (or the nearest edge of a circle
  // of radius r round it) is handed over.
  const note = (x: number, y: number, r = 0) => {
    const off = Math.max(Math.max(-x, -y, x - W, y - H, 0) - r, 0);
    if (off > s.farAny) s.farAny = off;
    if (s.dash && off > s.farDashed) s.farDashed = off;
  };
  const target: Record<string, unknown> = {
    canvas: { width: W, height: H },
    setLineDash: (d: number[]) => { s.dash = d.length > 0; },
    moveTo: (x: number, y: number) => { s.x = x; s.y = y; note(x, y); },
    lineTo: (x: number, y: number) => {
      if (s.dash) s.dashed += Math.hypot(x - s.x, y - s.y);
      s.x = x; s.y = y; note(x, y);
    },
    arc: (x: number, y: number, r: number) => note(x, y, r),
  };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return () => (prop.startsWith('create') ? { addColorStop: () => {} } : undefined);
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, s };
}

describe('the ram overlay zoomed in on the rock', () => {
  const { rock, bodies, plan } = rammed();
  const t = plan.startTick + 0.5 * (plan.arriveTick - plan.startTick);
  const here = bodyPosition(rock, t, bodies);

  const draw = (scale: number) => {
    const { ctx, s } = recordingCtx();
    const noCanvas = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const rc = {
      ctx, canvas: { width: W, height: H } as HTMLCanvasElement,
      camera: { x: here.x, y: here.y, scale }, bodies, t, nowMs: 0,
    } as unknown as RenderContext;
    drawRammingBody(rock, rc);
    noCanvas.mockRestore();
    return s;
  };

  it('the fixture puts the course far off screen when zoomed in (honest test)', () => {
    const d = Math.hypot(plan.interceptPos.x - here.x, plan.interceptPos.y - here.y);
    expect(d * 1000).toBeGreaterThan(20 * W);
  });

  it.each([200, 1000, 5000, 20000])('dashed line stays a few screens long at scale %d', (scale) => {
    const s = draw(scale);
    // Screen plus a screen of margin each way, two dashed polylines.
    expect(s.dashed).toBeLessThan(2 * 2 * Math.hypot(3 * W, 3 * H));
  });

  it.each([1000, 20000])('no dashed path reaches more than a screen off at scale %d', (scale) => {
    const s = draw(scale);
    expect(s.farDashed).toBeLessThanOrEqual(Math.max(W, H) + 1);
    // ...and nothing at all is handed over at far-system distances.
    expect(s.farAny).toBeLessThan(50 * Math.max(W, H));
  });

  it('zoomed out, the whole course is still drawn', () => {
    const s = draw(0.5);
    const d = Math.hypot(plan.interceptPos.x - here.x, plan.interceptPos.y - here.y);
    expect(s.dashed).toBeGreaterThan(d * 0.5 * 0.9);
  });
});
