// A CITY FALLING HAS TO BE SEEN ON THE GLOBE (Studio clip "siege-of-a-
// shielded-world", 2026-10-23, 9.2 s / f276). The city fell only in the
// outliner: settlement_destroyed played the ship-death flash, 12-14 px,
// at the CENTRE of the world, six frames late. It plays at the city's own
// marker on the drawn surface now, in proportion to the world as drawn.

import { fxKindFor, ingestChronicleFx, drainVisibleFx, resetPendingFx, PendingFx } from '../pendingFx';
import { spawnSettlementFall, drawSettlementFalls, settlementFallPlace } from '../combatFx';
import type { RenderContext } from '../mapRenderer';
import type { Body, Settlement } from '../../types';

// jsdom has no 2D canvas: the baked glow sprites fall back to plain arcs.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

type Call = { name: string; args: number[] };

function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, key) {
      if (key in t) return t[key as string];
      return (...args: number[]) => { calls.push({ name: String(key), args }); return { addColorStop: () => {} }; };
    },
    set(t, key, value) { t[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function rcFor(ctx: CanvasRenderingContext2D, body: Body, drawnR: number): RenderContext {
  return {
    ctx, canvas: { width: 800, height: 600 }, camera: { x: 0, y: 0, scale: drawnR / (body.radius as number) },
    t: 40, nowMs: 0, bodies: [body], presentation: { radius: new Map([[body.id, drawnR]]) },
    factions: [{ id: 'terra', color: '#4ecdc4' }],
  } as unknown as RenderContext;
}

const city = (id: string, bodyId: string, surfaceAngle: number) => ({
  id, type: 'city', bodyId, ownedBy: 'terra', surfaceAngle, hp: 0, maxHp: 100,
} as unknown as Settlement);

/** How far the blast reaches: the largest arc centred on the city. */
function blastReach(calls: Call[], x: number, y: number): number {
  let r = 0;
  for (const c of calls) {
    if (c.name === 'arc' && Math.hypot(c.args[0] - x, c.args[1] - y) < 1) r = Math.max(r, c.args[2]);
  }
  return r;
}

describe('a settlement falling', () => {
  it('settlement_destroyed has its own effect, carrying which settlement', () => {
    expect(fxKindFor('settlement_destroyed')).toBe('settlement_fall');
    resetPendingFx();
    try { localStorage.clear(); } catch { /* jsdom */ }
    ingestChronicleFx('gf', [{ id: 'row1', kind: 'settlement_destroyed', bodyId: 'ganymede', settlementId: 'g:stl9' }]);
    const fired: PendingFx[] = [];
    drainVisibleFx(performance.now() + 1000, () => ({ x: 1, y: 1 }), fx => { fired.push(fx); });
    expect(fired[0]).toMatchObject({ kind: 'settlement_fall', bodyId: 'ganymede', settlementId: 'g:stl9' });
  });

  it('plays at the city marker on the drawn globe, not at the centre', () => {
    const GANY = { id: 'gany-f', type: 'moon', radius: 2 } as unknown as Body;
    const { ctx, calls } = recordingCtx();
    const rc = rcFor(ctx, GANY, 115);
    // At the city's surface angle, on the DRAWN limb.
    const place = settlementFallPlace(rc, { key: 'c1', bodyId: GANY.id, stl: city('c1', GANY.id, 0) })!;
    expect(place.x).toBeCloseTo(400 + 115, 5);
    expect(place.y).toBeCloseTo(300, 5);
    spawnSettlementFall('c1', GANY.id, city('c1', GANY.id, 0), null);
    drawSettlementFalls(rc, performance.now() + 120);
    const fireArcs = calls.filter(c => c.name === 'arc' && Math.hypot(c.args[0] - 515, c.args[1] - 300) < 30);
    expect(fireArcs.length).toBeGreaterThan(3);
    expect(calls.filter(c => c.name === 'arc' && Math.hypot(c.args[0] - 400, c.args[1] - 300) < 5
      && c.args[2] < 60)).toHaveLength(0);
  });

  it('is sized by the world as drawn', () => {
    const big = { id: 'big-f', type: 'moon', radius: 2 } as unknown as Body;
    const small = { id: 'small-f', type: 'moon', radius: 2 } as unknown as Body;
    const a = recordingCtx(), b = recordingCtx();
    spawnSettlementFall('cb', big.id, city('cb', big.id, Math.PI / 2), null);
    spawnSettlementFall('cs', small.id, city('cs', small.id, Math.PI / 2), null);
    const t = performance.now() + 300;
    drawSettlementFalls(rcFor(a.ctx, big, 160), t);
    drawSettlementFalls(rcFor(b.ctx, small, 40), t);
    const rb = blastReach(a.calls, 400, 300 + 160), rs = blastReach(b.calls, 400, 300 + 40);
    expect(rb).toBeGreaterThan(40);          // reads at a 320 px globe
    expect(rb / rs).toBeGreaterThan(2.5);    // and scales with it
  });

  it('plays once, whether the list-diff or the chronicle row gets there first', () => {
    const W = { id: 'once-f', type: 'moon', radius: 2 } as unknown as Body;
    spawnSettlementFall('s-once', W.id, city('s-once', W.id, 0), null);
    spawnSettlementFall('s-once', W.id, null, 'row-once');
    const { ctx, calls } = recordingCtx();
    drawSettlementFalls(rcFor(ctx, W, 100), performance.now() + 200);
    const single = calls.length;
    // A second fall at the same place would double the work.
    const again = recordingCtx();
    spawnSettlementFall('s-once-control', W.id, city('s-once-control', W.id, 0), null);
    drawSettlementFalls(rcFor(again.ctx, W, 100), performance.now() + 200);
    expect(again.calls.length).toBeGreaterThan(single * 1.5);
  });
});
