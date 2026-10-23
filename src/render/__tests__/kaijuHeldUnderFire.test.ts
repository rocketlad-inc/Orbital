/**
 * THE GUARDS FIGHT THE BEAST THEY CAN SEE.
 *
 * Studio clip "The Leviathan attacks Io" (judges, 2026-10-23, ~10.0-11.6 s):
 * the outliner flipped every guard from IN COMBAT to ORBITING and the fire
 * stopped, while the beast was still drawn wrapped round Io, crushing it.
 * The server is right: the Leviathan leaves for its next meal on the tick
 * it breaks a world (worker/kaiju.js), so the fight at Io ended with that
 * tick. But the client holds the beast on the world until its arms let go
 * (kaijuFlightPose), playing out the strike the guards fought it through,
 * and the guns fell silent beside it: "the fleet giving up".
 *
 * Now the guards keep firing at the beast WHERE IT IS DRAWN while a strike
 * holds it on their world, and stop when its arms let go and it is
 * visibly leaving. No rule changes: the server's combat is untouched.
 */
import { drawEngagementFire } from '../combatFx';
import { RenderContext } from '../mapRenderer';
import {
  spawnKaijuStrike, noteKaijuDrawn, resetKaijuFx, kaijuHeldAt, KAIJU_BREAK_MS,
} from '../kaijuFx';
import type { Body, Ship } from '../../types';

const W = 960, H = 540, SCALE = 4;

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
        return undefined;
      };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const io = { id: 'io', name: 'Io', type: 'moon', radius: 1.2, parent: null, orbitRadius: 0, orbitPeriod: 1, angle0: 0, color: '#ccc' } as unknown as Body;
const GUARD_PX = { x: 300, y: 120 };
const BEAST_PX = { x: 600, y: 120 };
const toWorld = (p: { x: number; y: number }) => ({ x: (p.x - W / 2) / SCALE, y: (p.y - H / 2) / SCALE });

const guard = {
  id: 'g:guard_0', name: 'Guard', ownedBy: 'jove', class: 'destroyer', hp: 100, damagePerTick: 10,
  lastCombatTick: 20, lastTargetId: 'g:leviathan',
  orbit: { rp: 3, ra: 3, omega: 0, M0: 0, epoch: 0, direction: 1, period: 100, parentBodyId: 'io' },
} as unknown as Ship;
/** The beast, already in flight (the break tick sent it on its way). */
const beast = {
  id: 'g:leviathan', name: 'Leviathan', ownedBy: 'g:leviathan_f', class: 'kaiju', hp: 900,
  orbit: { rp: 6, ra: 6, omega: 0, M0: 0, epoch: 0, direction: 1, period: 400, parentBodyId: 'io' },
  transit: { pos: { x: 400, y: 0 }, vel: { x: 0, y: 40 }, currentTransfer: { targetBodyId: 'europa', startTick: 20, flipTick: 23, arriveTick: 26 } },
} as unknown as Ship;

let clock = 3_000_000;
beforeEach(() => {
  resetKaijuFx();
  clock += 1_000_000;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  // jsdom has no canvas: the glow sprite cache logs on every miss.
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** Canvas work landing on the beast, over a sweep of wall time. The
 *  beast is noted as drawn held on Io each frame, as drawTransitShip does. */
function fireAtBeast(fromMs: number, toMs: number): { work: number; nearBeast: number } {
  let work = 0, nearBeast = 0;
  const bw = toWorld(BEAST_PX);
  for (let ms = fromMs; ms < toMs; ms += 16) {
    clock = ms;
    noteKaijuDrawn(beast.id, bw.x, bw.y, 0, 360,
      { bodyId: 'io', parked: false, bx: 0, by: 0, R: io.radius * SCALE, scale: SCALE });
    const { ctx, calls } = recordingCtx();
    const rc = {
      ctx, canvas: { width: W, height: H }, camera: { x: 0, y: 0, scale: SCALE },
      t: 20.5, nowMs: ms, bodies: [io], factions: [],
      shipHitboxes: new Map([[guard.id, { x: GUARD_PX.x, y: GUARD_PX.y, r: 14 }]]),
      fleetSlots: new Map(),
    } as unknown as RenderContext;
    drawEngagementFire(rc, [guard, beast], [], ms, 20, new Map(), ['g:leviathan_f|jove']);
    work += calls.length;
    for (const c of calls) {
      if (c.m !== 'moveTo' && c.m !== 'lineTo' && c.m !== 'arc') continue;
      const x = c.args[0] as number, y = c.args[1] as number;
      if (Math.hypot(x - BEAST_PX.x, y - BEAST_PX.y) < 120) nearBeast++;
    }
  }
  return { work, nearBeast };
}

describe('guards and the Leviathan held on their world', () => {
  it('keep firing at it where it is drawn while its arms are round the world', () => {
    const t0 = clock;
    spawnKaijuStrike('brk', 'io', 'break');
    const during = fireAtBeast(t0 + 1000, t0 + 3500);
    expect(during.work).toBeGreaterThan(0);
    expect(during.nearBeast).toBeGreaterThan(0);
  });

  it('stop once its arms let go and it is leaving', () => {
    const t0 = clock;
    spawnKaijuStrike('brk', 'io', 'break');
    const after = fireAtBeast(t0 + KAIJU_BREAK_MS * 0.66, t0 + KAIJU_BREAK_MS * 0.66 + 2000);
    expect(after.work).toBe(0);
  });

  it('never fire at a beast in flight that no strike holds', () => {
    // No strike playing: it is simply a hull flying away from Io.
    const after = fireAtBeast(clock + 100, clock + 2000);
    expect(after.work).toBe(0);
    expect(kaijuHeldAt(clock)).toBeNull();
  });
});
