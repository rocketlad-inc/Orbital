/**
 * THE LEVIATHAN'S NAME RIDES ITS HEAD, IN FRAME.
 *
 * Studio clip "The Leviathan attacks Io" (judges, 2026-10-23): the beast's
 * name label ("Unkn…") was cut off by the right icon rail at x~945, then
 * rode ~185 px right of the head all clip (f302: label x=905, head x=720).
 * The hull rule put a name half the SPRITE's width right of its centre,
 * and the beast is drawn 4.4 world radii across.
 *
 * Driven through the real draw calls (drawShip parked, drawTransitShip
 * held by a strike) on a 960 px frame, as the clip was shot.
 */
import { drawShip, drawTransitShip, RenderContext, kaijuLabelAt } from '../mapRenderer';
import { spawnKaijuStrike, resetKaijuFx, lastKaijuDrawn } from '../kaijuFx';
import { bodyPosition } from '../../physics/orbitalMechanics';
import type { Body, Ship } from '../../types';

const W = 960, H = 540;
const RAIL = 56;
const NAME = 'Unknown contact';

type Call = { m: string; args: unknown[] };
function recordingCtx() {
  const calls: Call[] = [];
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = { canvas: { width: W, height: H } };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.push({ m: prop, args });
        if (prop.startsWith('create')) return gradient;
        if (prop === 'measureText') return { width: 9 * String(args[0]).length * 0.62 };
        if (prop === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        return undefined;
      };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const sol = { id: 'sol', name: 'Sol', type: 'star', radius: 20, parent: null, orbitRadius: 0, orbitPeriod: 1, angle0: 0, color: '#ff0' } as unknown as Body;
const io = {
  id: 'io', name: 'Io', type: 'moon', radius: 1.6, parent: 'sol', orbitRadius: 300, orbitPeriod: 1e9, angle0: 0.3, color: '#ccc',
} as unknown as Body;
const bodies = [sol, io];

let clock = 9_000_000;
beforeEach(() => {
  resetKaijuFx();
  clock += 1_000_000;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

function frame(t: number, scale: number, cam: { x: number; y: number }) {
  const { ctx, calls } = recordingCtx();
  const rc = {
    ctx, canvas: { width: W, height: H } as HTMLCanvasElement,
    camera: { x: cam.x, y: cam.y, scale }, bodies, t, nowMs: clock, factions: [],
  } as unknown as RenderContext;
  return { rc, calls };
}

const beast = (): Ship => ({
  id: 'g:leviathan', name: NAME, class: 'kaiju', ownedBy: 'g:leviathan_f', hp: 1000,
  orbit: { rp: 6, ra: 6, omega: 0, M0: 0, epoch: 0, direction: 1, period: 400, parentBodyId: 'io' },
} as unknown as Ship);

const canvasOf = (rc: RenderContext, x: number, y: number) => ({
  x: W / 2 + (x - rc.camera.x) * rc.camera.scale, y: H / 2 + (y - rc.camera.y) * rc.camera.scale,
});

/** The camera that puts the beast's drawn centre at canvas x = 720. */
function cameraPuttingBeastAt720(s: Ship, scale: number) {
  const e = bodyPosition(io, 10, bodies);
  clock += 33;
  const first = frame(10, scale, e);
  drawShip(s, first.rc, false);
  const at = lastKaijuDrawn().at!;
  const c = canvasOf(first.rc, at.x, at.y);
  return { x: e.x + (c.x - 720) / scale, y: e.y + (c.y - H / 2) / scale };
}

function labelOf(calls: Call[]) {
  const t = calls.find(c => c.m === 'fillText' && c.args[0] === NAME);
  expect(t).toBeDefined();
  return { x: t!.args[1] as number, y: t!.args[2] as number, w: 9 * NAME.length * 0.62 };
}

/** Where its head (its eyes) is drawn: drawSunSquid puts them 0.24u
 *  behind the centre along its heading, u = size / 6. */
function headOf(rc: RenderContext) {
  const at = lastKaijuDrawn().at!;
  const c = canvasOf(rc, at.x, at.y);
  const u = at.size / 6;
  return { x: c.x - Math.cos(at.heading) * 0.24 * u, y: c.y - Math.sin(at.heading) * 0.24 * u };
}

describe('the Leviathan\'s name', () => {
  it('parked over its world: beside the head, clear of the dock rail', () => {
    const s = beast();
    const cam = cameraPuttingBeastAt720(s, 60);
    clock += 33;
    const { rc, calls } = frame(10.01, 60, cam);
    drawShip(s, rc, false);
    const size = lastKaijuDrawn().at!.size;
    expect(size).toBeGreaterThan(300);            // drawn huge over the world
    const lab = labelOf(calls);
    const head = headOf(rc);
    // Within a short gap of the head, not half the 400 px animal away.
    expect(Math.abs(lab.x - head.x)).toBeLessThan(60 + lab.w);
    expect(Math.abs(lab.y + 6 - head.y)).toBeLessThan(2);
    // Never under the rail or off the frame.
    expect(lab.x + lab.w).toBeLessThanOrEqual(W - RAIL);
    expect(lab.x).toBeGreaterThanOrEqual(0);
  });

  it('held on its world by a strike while its flight has begun: the same', () => {
    const s = beast();
    const cam = cameraPuttingBeastAt720(s, 60);
    spawnKaijuStrike('brk', 'io', 'break');
    clock += 1500;
    const e = bodyPosition(io, 10.5, bodies);
    const from = { x: e.x + 6, y: e.y };
    const samples = Array.from({ length: 61 }, (_, k) => ({ t: 10.5 + k * 0.1, x: from.x, y: from.y + 40 * k * 0.1 }));
    const plan = {
      targetBodyId: 'sol', acceleration: 1, brakeAcceleration: 1, startTick: 10.5, flipTick: 13.5, arriveTick: 16.5,
      thrustDir: { x: 0, y: 1 }, interceptPos: { x: from.x, y: from.y + 240 }, startPos: from, startVel: { x: 0, y: 0 },
      totalDv: 6, peakVelocity: 3,
    };
    const flying = { ...s, transit: { pos: from, vel: { x: 0, y: 40 }, currentTransfer: plan } } as Ship;
    const { rc, calls } = frame(10.6, 60, cam);
    drawTransitShip(flying, rc, false, samples);
    expect(lastKaijuDrawn().at!.ms).toBe(clock);     // drawn held, this frame
    const lab = labelOf(calls);
    const head = headOf(rc);
    expect(Math.abs(lab.x - head.x)).toBeLessThan(60 + lab.w);
    expect(lab.x + lab.w).toBeLessThanOrEqual(W - RAIL);
  });

  it('flips to the head\'s left when the right would run under the rail', () => {
    const near = kaijuLabelAt({ x: 900, y: 200 }, 0, 360, 80, W);
    expect(near.left).toBe(true);
    expect(near.x + 80).toBeLessThan(near.head.x);
    const open = kaijuLabelAt({ x: 300, y: 200 }, 0, 360, 80, W);
    expect(open.left).toBe(false);
    expect(open.x).toBeGreaterThan(open.head.x);
    // A phone's dock is along the bottom: no right inset there.
    const phone = kaijuLabelAt({ x: 250, y: 200 }, 0, 120, 60, 375);
    expect(phone.x + 60).toBeLessThanOrEqual(375 - 4);
  });
});
