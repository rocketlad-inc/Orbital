// "This happens whenever I click on a planet in another solar system"
// (Discord, 2026-10-07): with a Centauri world open, every Sol planet,
// trajectory, escort and plume reached the canvas at 1.7e8-3.1e8 px, and
// a GTX 980 through ANGLE/D3D11 drew that as smeared bars and stretched
// hull icons across the screen. Nothing far off-canvas may reach the GPU.

import { farOffCanvas, safePolyline, drawBody, RenderContext } from '../mapRenderer';
import type { Body } from '../../types';

const W = 1440, H = 800;

/** A 2D context that records every call and every number it is handed. */
function recordingCtx() {
  const calls: Array<{ m: string; args: unknown[] }> = [];
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = { canvas: { width: W, height: H } };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.push({ m: prop, args });
        if (prop.startsWith('create')) return gradient;
        if (prop === 'measureText') return { width: 10 };
        if (prop === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        return undefined;
      };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function rc(ctx: CanvasRenderingContext2D, cam: { x: number; y: number; scale: number }, bodies: Body[]): RenderContext {
  return {
    ctx, canvas: { width: W, height: H } as HTMLCanvasElement,
    camera: { ...cam }, bodies, t: 0, nowMs: 0,
  } as unknown as RenderContext;
}

describe('farOffCanvas', () => {
  const r = rc(recordingCtx().ctx, { x: 0, y: 0, scale: 1 }, []);
  it('on screen and within a screen of the edge is drawable', () => {
    expect(farOffCanvas(r, 720, 400)).toBe(false);
    expect(farOffCanvas(r, -1000, 400)).toBe(false);
    expect(farOffCanvas(r, W + 1400, H + 1400)).toBe(false);
  });
  it('beyond a screen is not, unless its radius reaches back', () => {
    expect(farOffCanvas(r, -3000, 400)).toBe(true);
    expect(farOffCanvas(r, -3000, 400, 2000)).toBe(false);
    expect(farOffCanvas(r, -2.65e7, 400)).toBe(true);
  });
  it('a non-finite point is never drawn', () => {
    expect(farOffCanvas(r, NaN, 0)).toBe(true);
    expect(farOffCanvas(r, Infinity, 0)).toBe(true);
  });
});

describe('safePolyline', () => {
  it('a Sol-to-Centauri leg reaches the canvas trimmed to a screen of margin', () => {
    const { ctx, calls } = recordingCtx();
    const p = safePolyline(ctx, W, H);
    p.move(-2.65e7, 400);
    p.line(720, 400);
    p.line(3.1e8, 420);
    const nums = calls.flatMap(c => c.args.filter((v): v is number => typeof v === 'number'));
    expect(nums.length).toBeGreaterThan(0);
    for (const n of nums) expect(Math.abs(n)).toBeLessThanOrEqual(W + Math.max(W, H));
    // The on-screen point is kept, and the line stays one stroke through it.
    expect(calls.filter(c => c.m === 'moveTo')).toHaveLength(1);
    expect(calls.some(c => c.m === 'lineTo' && c.args[0] === 720 && c.args[1] === 400)).toBe(true);
  });
  it('a stretch entirely off-canvas is dropped, and the pen lifts across it', () => {
    const { ctx, calls } = recordingCtx();
    const p = safePolyline(ctx, W, H);
    p.move(100, 100);
    p.line(200, 100);          // on screen
    p.line(9e7, 9e7);          // leaves
    p.line(9e7, -9e7);         // far away, both ends off
    p.line(300, 300);          // comes back
    expect(calls.filter(c => c.m === 'moveTo').length).toBe(2);
    for (const c of calls) for (const v of c.args) if (typeof v === 'number') expect(Math.abs(v)).toBeLessThan(5e3);
  });
});

describe('drawBody', () => {
  const sol = { id: 'sol', name: 'Sol', type: 'star', radius: 100, orbitRadius: 0, orbitPeriod: 0, angle0: 0, soi: 0, color: '#ffd180' } as unknown as Body;
  it('Sol, seen from a Centauri world, never touches the canvas', () => {
    const { ctx, calls } = recordingCtx();
    // Camera on Centauri, 530400 units out, at world-menu zoom.
    drawBody(sol, rc(ctx, { x: 530400, y: 0, scale: 50 }, [sol]));
    expect(calls).toHaveLength(0);
  });
});
