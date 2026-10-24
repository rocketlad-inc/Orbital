/**
 * THE LEVIATHAN STAYS WITH THE WORLD IT IS EATING.
 *
 * Studio clip "The Leviathan attacks Europa" (2026-10-23), real client
 * frames at 30 fps:
 *  - f294: the beast halved in size in one frame and slid out of the
 *    bottom of the shot. It leaves for its next meal on the tick it
 *    breaks a world; its parked look was noted at its bare hull size, not
 *    the 4.4-world-radii size it is drawn at over a world, so the flight
 *    started from half of what was on screen.
 *  - 10-12.8 s: the break's arms grew from that off-screen hull, so the
 *    world was crushed by tentacles with no animal attached.
 *  - its charge ring opened 83% full (a 4-tick wind-up divided by the Mega
 *    Destroyer's 24) and ran far past the frame at the close-up.
 *  - its death, had it come, played at a frozen point in space while the
 *    world sped on, and the carcass popped up at a second spot.
 *
 * These drive the real draw calls (drawShip, drawTransitShip, drawKaijuFx)
 * through a recording canvas, frame by frame, the way MapCanvas does.
 */
import { drawShip, drawTransitShip, RenderContext, strikeChargeFrac } from '../mapRenderer';
import {
  spawnKaijuStrike, spawnKaijuDeath, drawKaijuFx, resetKaijuFx, lastKaijuDrawn, kaijuCarcassPose,
  KAIJU_BREAK_MS, KAIJU_DEATH_MS, KAIJU_RELEASE_MS, KAIJU_CARCASS_SETTLE_MS,
} from '../kaijuFx';
import { bodyPosition } from '../../physics/orbitalMechanics';
import type { Body, Ship } from '../../types';

const W = 1440, H = 800;

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
        if (prop === 'measureText') return { width: 10 };
        if (prop === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        return undefined;
      };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const sol = { id: 'sol', name: 'Sol', type: 'star', radius: 20, parent: null, orbitRadius: 0, orbitPeriod: 1, angle0: 0, color: '#ff0' } as unknown as Body;
/** Europa, on a slow orbit unless a test speeds it up. */
const europaOn = (period: number) => ({
  id: 'europa', name: 'Europa', type: 'moon', radius: 1.6, parent: 'sol',
  orbitRadius: 300, orbitPeriod: period, angle0: 0.3, color: '#ccc',
} as unknown as Body);

let clock = 1_000_000;
beforeEach(() => {
  resetKaijuFx();
  clock += 1_000_000;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

/** One frame at tick `t`, the camera held where Europa was at `camT`. */
function frame(bodies: Body[], t: number, scale: number, camT = t) {
  const { ctx, calls } = recordingCtx();
  const europa = bodies.find(b => b.id === 'europa')!;
  const e = bodyPosition(europa, camT, bodies);
  const rc = {
    ctx, canvas: { width: W, height: H } as HTMLCanvasElement,
    camera: { x: e.x, y: e.y, scale }, bodies, t, nowMs: clock, factions: [],
  } as unknown as RenderContext;
  return { rc, calls };
}

let n = 0;
function beast(extra: Partial<Ship> = {}): Ship {
  return {
    id: `g${++n}:leviathan`, name: 'Leviathan', class: 'kaiju', ownedBy: 'g:leviathan_f', hp: 1000,
    orbit: { rp: 6, ra: 6, omega: 0, M0: 0, epoch: 0, direction: 1, period: 400, parentBodyId: 'europa' },
    ...extra,
  } as unknown as Ship;
}

/** The same hull, gone into flight: a straight leg away from Europa. */
function flying(s: Ship, bodies: Body[], t0: number): { ship: Ship; samples: Array<{ t: number; x: number; y: number }> } {
  const e = bodyPosition(bodies.find(b => b.id === 'europa')!, t0, bodies);
  const from = { x: e.x + 6, y: e.y };
  const samples = [] as Array<{ t: number; x: number; y: number }>;
  // 40 world units a tick, straight down the screen.
  for (let k = 0; k <= 60; k++) samples.push({ t: t0 + k * 0.1, x: from.x, y: from.y + 40 * k * 0.1 });
  const plan = {
    targetBodyId: 'sol', acceleration: 1, brakeAcceleration: 1, startTick: t0, flipTick: t0 + 3, arriveTick: t0 + 6,
    thrustDir: { x: 0, y: 1 }, interceptPos: { x: from.x, y: from.y + 240 }, startPos: from, startVel: { x: 0, y: 0 },
    totalDv: 6, peakVelocity: 3,
  };
  return { ship: { ...s, transit: { pos: from, vel: { x: 0, y: 40 }, currentTransfer: plan } } as Ship, samples };
}

const at = () => lastKaijuDrawn().at!;
const canvasOf = (rc: RenderContext, x: number, y: number) => ({
  x: W / 2 + (x - rc.camera.x) * rc.camera.scale, y: H / 2 + (y - rc.camera.y) * rc.camera.scale,
});

describe('leaving a world', () => {
  it('the first frame of its flight is the size it was drawn parked (f294 halved)', () => {
    const bodies = [sol, europaOn(1e9)];
    const s = beast();
    for (let k = 0; k < 4; k++) {
      clock += 33;
      const { rc } = frame(bodies, 10 + k * 0.03, 60);
      drawShip(s, rc, false);
    }
    const parked = at().size;
    // Over a world it is drawn 4.4 drawn radii across (here 4.4 x 96 px).
    expect(parked).toBeCloseTo(4.4 * 1.6 * 60, 0);
    clock += 33;
    const f = flying(s, bodies, 10.12);
    const { rc } = frame(bodies, 10.13, 60);
    drawTransitShip(f.ship, rc, false, f.samples);
    expect(at().ms).toBe(clock);                       // it was drawn this frame
    expect(at().size / parked).toBeGreaterThan(0.95);
  });
});

describe('a break it is still playing when it leaves', () => {
  it('holds the beast on the world, arms and all, then lets it go', () => {
    const bodies = [sol, europaOn(1e9)];
    const s = beast();
    let rc0: RenderContext | null = null;
    for (let k = 0; k < 4; k++) {
      clock += 33;
      const { rc } = frame(bodies, 10 + k * 0.03, 60);
      drawShip(s, rc, false);
      rc0 = rc;
    }
    const parkedAt = canvasOf(rc0!, at().x, at().y);
    const parkedSize = at().size;
    // The world breaks; the same /state has the beast on its way out.
    spawnKaijuStrike('brk', 'europa', 'break');
    const f = flying(s, bodies, 10.12);
    const europaPx = { x: W / 2, y: H / 2 };
    // 2.5 s on: the arms are still round the world (they let go at 64%).
    clock += 2500;
    const t = 10.12 + 2.5;
    const { rc, calls } = frame(bodies, t, 60);
    drawTransitShip(f.ship, rc, false, f.samples);
    expect(at().ms).toBe(clock);
    const drawn = canvasOf(rc, at().x, at().y);
    expect(Math.hypot(drawn.x - parkedAt.x, drawn.y - parkedAt.y)).toBeLessThan(2);
    expect(at().size).toBeCloseTo(parkedSize, 3);
    // Every arm, and everything else the break draws, is on and around
    // the world and the beast holding it: nothing reaches in from the
    // course 100 world units (6000 px) down the screen.
    calls.length = 0;
    drawKaijuFx(rc, clock);
    const pts = calls.filter(c => c.m === 'moveTo' || c.m === 'lineTo').map(c => ({ x: c.args[0] as number, y: c.args[1] as number }));
    expect(pts.length).toBeGreaterThan(20);
    const far = Math.max(...pts.map(p => Math.hypot(p.x - europaPx.x, p.y - europaPx.y)));
    expect(far).toBeLessThan(900);

    // The arms let go: it eases from the world into its flight...
    const armsOff = clock - 2500 + KAIJU_BREAK_MS * 0.64;
    clock = armsOff + KAIJU_RELEASE_MS / 2;
    const easing = frame(bodies, t + 1.6, 60);
    drawTransitShip(f.ship, easing.rc, false, f.samples);
    expect(at().ms).toBe(clock);
    const mid = canvasOf(easing.rc, at().x, at().y);
    expect(mid.y - parkedAt.y).toBeGreaterThan(500);
    expect(at().size).toBeLessThan(parkedSize);
    // ...and then flies its course, held by nothing (here, far off screen).
    clock = armsOff + KAIJU_RELEASE_MS + 50;
    const later = frame(bodies, t + 2.2, 60);
    drawTransitShip(f.ship, later.rc, false, f.samples);
    expect(at().ms).not.toBe(clock);
  });

  it('a strike that is not holding it leaves its flight alone', () => {
    const bodies = [sol, europaOn(1e9)];
    const s = beast();
    clock += 33;
    drawShip(s, frame(bodies, 10, 60).rc, false);
    const f = flying(s, bodies, 10.05);
    clock += 3000;
    const { rc } = frame(bodies, 13, 60);
    drawTransitShip(f.ship, rc, false, f.samples);
    // Never drawn (it is 120 units off screen, culled), never pulled back.
    expect(at().ms).not.toBe(clock);
  });
});

describe('its charge ring', () => {
  it('fills against the wind-up it actually has, and stays inside the view', () => {
    const bodies = [sol, europaOn(1e9)];
    const s = beast({ strikeReadyTick: 14, strikeChargeTicks: 4 } as Partial<Ship>);
    clock += 33;
    const { rc, calls } = frame(bodies, 10, 150);
    drawShip(s, rc, false);
    const top = -Math.PI / 2;
    const charge = calls.find(c => c.m === 'arc' && Math.abs((c.args[3] as number) - top) < 1e-9);
    expect(charge).toBeDefined();
    const filled = ((charge!.args[4] as number) - top) / (Math.PI * 2);
    expect(filled).toBeLessThan(0.02);                  // armed this tick: empty, not 83%
    expect(charge!.args[2] as number).toBeLessThanOrEqual(0.42 * Math.min(W, H) + 1e-6);
  });
  it('a Mega Destroyer with no length from the server keeps its 24 ticks', () => {
    expect(strikeChargeFrac({ strikeReadyTick: 22 }, 10)).toBeCloseTo(0.5, 9);
    expect(strikeChargeFrac({ strikeReadyTick: 14, strikeChargeTicks: 4 }, 12)).toBeCloseTo(0.5, 9);
  });
});

describe('its death and its carcass', () => {
  it('dies where it was drawn, riding the world, and the carcass settles from there', () => {
    // A fast Europa: 2 ticks move it ~40 px at this zoom.
    const bodies = [sol, europaOn(400)];
    const s = beast();
    clock += 33;
    const { rc } = frame(bodies, 10, 60, 10);
    drawShip(s, rc, false);
    const diedAt = canvasOf(rc, at().x, at().y);
    const size = at().size;
    const t0 = clock;
    spawnKaijuDeath('live:g:leviathan', '');
    const own = { x: 50, y: 50, heading: 0, size: 90 };

    // Still dying: no carcass yet.
    expect(kaijuCarcassPose(rc, own, t0 + KAIJU_DEATH_MS * 0.5).alpha).toBe(0);

    // Its lights going out: the carcass shows through where the animal is,
    // at its size, and goes where the world goes.
    const late = t0 + KAIJU_DEATH_MS * 0.95;
    const a = kaijuCarcassPose(rc, own, late);
    expect(a.alpha).toBeGreaterThan(0.9);
    expect(a.size).toBeCloseTo(size, 6);
    expect(Math.hypot(a.x - diedAt.x, a.y - diedAt.y)).toBeLessThan(size * 0.3);
    const moved = frame(bodies, 12, 60, 10).rc;
    const b = kaijuCarcassPose(moved, own, late);
    const e0 = bodyPosition(bodies[1], 10, bodies), e1 = bodyPosition(bodies[1], 12, bodies);
    const shift = { x: (e1.x - e0.x) * 60, y: (e1.y - e0.y) * 60 };
    expect(Math.hypot(shift.x, shift.y)).toBeGreaterThan(20);
    expect(Math.hypot(b.x - a.x - shift.x, b.y - a.y - shift.y)).toBeLessThan(1);

    // Then it settles onto its own orbit, at its own size.
    const done = kaijuCarcassPose(rc, own, t0 + KAIJU_DEATH_MS + KAIJU_CARCASS_SETTLE_MS + 10);
    expect(done).toEqual({ ...own, alpha: 1 });
  });

  it('a carcass with no death played here is drawn as it is', () => {
    const { rc } = frame([sol, europaOn(1e9)], 10, 60);
    expect(kaijuCarcassPose(rc, { x: 1, y: 2, heading: 3, size: 4 }, clock)).toEqual({ x: 1, y: 2, heading: 3, size: 4, alpha: 1 });
  });
});
