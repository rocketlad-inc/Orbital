// A struck living world dissolves into its raw face across the fire
// (drawnTerraformFraction). The raw face is a second real-map globe, and
// nothing had asked for it while the world drew living: the first frame
// of the dissolve was the first request, the globe was still loading, and
// the body fell through to the PROCEDURAL texture, a different-looking
// planet, for the frames the map took to arrive (one frame on the
// Studio's stepped clock, a few in live play). Mega Destroyer over Venus,
// 2026-10-23: a hard cut where the surface should dissolve.
//
// (The clip that reported it was filmed on the build before 73011cd9,
// where drawnTerraformFraction itself still SWAPPED living for raw at
// k 0.5; the in-between frames counted below guard that too.)
//
// The fake getGlobe loads a globe the frame AFTER it is first asked for,
// as the browser does: nothing is ever ready on its first request.

let mockFrame = 0;
const mockAsked = new Map<string, number>();
const mockImg = (key: string) => ({ key, complete: true, naturalWidth: 512 });
const mockProcedural: string[] = [];

jest.mock('../planetTexture', () => {
  const actual = jest.requireActual('../planetTexture');
  return {
    ...actual,
    getGlobe: (body: { id: string }, terraformed = false) => {
      const key = actual.globeKeyOf(body, terraformed);
      if (!key) return null;
      if (!mockAsked.has(key)) mockAsked.set(key, mockFrame);
      return (mockAsked.get(key) as number) < mockFrame ? mockImg(key) : null;
    },
    getPlanetTexture: (body: { id: string }) => { mockProcedural.push(`raw@${mockFrame}`); return actual.getPlanetTexture(body); },
    getTerraformedTexture: (body: { id: string }) => { mockProcedural.push(`tf@${mockFrame}`); return actual.getTerraformedTexture(body); },
  };
});

/* eslint-disable import/first */
import { drawBody, drawnTerraformFraction } from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import { spawnSterilisation } from '../combatFx';
import type { Body } from '../../types';
/* eslint-enable import/first */

function fakeCtx() {
  const noop = () => undefined;
  const grad = { addColorStop: noop };
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return () => grad;
    },
    set(target, prop, v) { target[prop] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

const venusLiving = {
  id: 'g1:venus', name: 'Venus', type: 'terrestrial', parent: 'sol',
  orbitRadius: 0, orbitPeriod: 0, angle0: 0, radius: 6, soi: 50, color: '#d9b26f',
  terraformedAtTick: 3,
} as unknown as Body;
// The tick that sterilises it also un-terraforms it.
const venusStruck = { ...venusLiving, terraformedAtTick: null, sterilisedAtTick: 40 } as unknown as Body;

function rc(body: Body, t: number, nowMs: number): RenderContext {
  return {
    ctx: fakeCtx(), canvas: { width: 1920, height: 1080 },
    camera: { x: 0, y: 0, scale: 20 }, bodies: [body], t, nowMs,
    settlements: [], buildOrders: [],
  } as unknown as RenderContext;
}

test('a struck living world never drops to the procedural texture as it dissolves', () => {
  // jsdom has no 2D canvas; the painters it cannot run only log.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // Living, for a few frames: its globe loads.
  for (mockFrame = 1; mockFrame <= 3; mockFrame++) drawBody(venusLiving, rc(venusLiving, 39.5, mockFrame * 33));
  mockProcedural.length = 0;

  // The strike tick lands; the death waits a few frames to be framed.
  for (; mockFrame <= 6; mockFrame++) drawBody(venusStruck, rc(venusStruck, 40.1, mockFrame * 33));
  spawnSterilisation('strike-venus', venusStruck.id);
  const t0 = performance.now();

  // The whole death, frame by frame at 30 fps, through the dissolve.
  const seen: number[] = [];
  for (let i = 0; i <= 160; i++, mockFrame++) {
    const ctx = rc(venusStruck, 40.2, t0 + i * (1000 / 30));
    seen.push(drawnTerraformFraction(venusStruck, ctx));
    drawBody(venusStruck, ctx);
  }
  // It did dissolve, living -> raw, across many frames...
  expect(seen[0]).toBe(1);
  expect(seen[seen.length - 1]).toBe(0);
  expect(seen.filter(f => f > 0 && f < 1).length).toBeGreaterThan(20);
  // ...and every one of them was the real globe, never the stand-in.
  expect(mockProcedural).toEqual([]);
});
