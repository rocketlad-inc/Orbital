// Lorne, 2026-10-21: "Can we have the ship explode in place, and then its
// debris orbit the world?" The blast and the wreck used to be fixed points
// in space; the world moved on without them.

jest.mock('../../physics/orbitalMechanics', () => ({
  // A world sliding along x at 10 units a tick.
  bodyPosition: (_b: unknown, t: number) => ({ x: 1000 + 10 * t, y: 0 }),
  localPositionAt: (o: { period: number }, t: number) => {
    const a = (2 * Math.PI * t) / o.period;
    return { x: Math.cos(a), y: Math.sin(a) };
  },
}));
jest.mock('../lightweightMode', () => ({ isLightweight: () => false }));

import { anchorToBody, anchoredWorldPos, orbitSense } from '../fxAnchor';
import { SHIP_VISUAL_ORBIT_MS } from '../tickPhase';

const body: any = { id: 'saturn', radius: 5 };
const rc = (t: number): any => ({ t, bodies: [body], camera: { scale: 1 }, presentation: undefined });

describe('a kill at a world stays at the world', () => {
  let now = 1_000_000;
  beforeEach(() => { jest.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => jest.restoreAllMocks());

  it('the blast holds its place around the world as the world moves', () => {
    // Died 3 units off the world's centre, straight "up", at tick 0.
    const a = anchorToBody({ x: 1000, y: 3 }, body, rc(0))!;
    expect(a).not.toBeNull();
    const later = anchoredWorldPos(a, rc(5), false)!;
    // The world moved 50 units; the blast moved with it, still 3 above.
    expect(later.x).toBeCloseTo(1050);
    expect(later.y).toBeCloseTo(3);
  });

  it('the debris laps the world at the parked fleet\'s pace', () => {
    const a = anchorToBody({ x: 1003, y: 0 }, body, rc(0), 1)!;
    now += SHIP_VISUAL_ORBIT_MS / 4;              // a quarter lap later
    const p = anchoredWorldPos(a, rc(0), true)!;
    expect(p.x).toBeCloseTo(1000);
    expect(p.y).toBeCloseTo(3);                   // same distance, a quarter round
    now += (SHIP_VISUAL_ORBIT_MS * 3) / 4;        // and all the way back
    const q = anchoredWorldPos(a, rc(0), true)!;
    expect(q.x).toBeCloseTo(1003);
    expect(q.y).toBeCloseTo(0);
  });

  it('it circles the way the hull did', () => {
    expect(orbitSense({ orbit: { period: 100 } } as any, 0)).toBe(1);
    const a = anchorToBody({ x: 1003, y: 0 }, body, rc(0), -1)!;
    now += SHIP_VISUAL_ORBIT_MS / 4;
    expect(anchoredWorldPos(a, rc(0), true)!.y).toBeCloseTo(-3);
  });

  it('a kill far out in space is not pinned to the nearest world', () => {
    expect(anchorToBody({ x: 1000, y: 500 }, body, rc(0))).toBeNull();
  });
});
