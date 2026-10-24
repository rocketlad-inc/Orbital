// A BEAM WITH AN END IN FLIGHT STILL MAY NOT CROSS A WORLD AS DRAWN
// (QA-B R2; Studio clip "select-and-strike-europa", 8.83-9.07 s: beams
// from the arriving Terran group cut straight through Europa's centre).
// drawTracers skipped the world test whenever either end was in flight,
// trusting the server's line of sight; but the server measures the hulls
// where they truly are, and an arriving hull is drawn at its dwell spot
// beside the world. The drawn chord is what has to clear the world.

import { drawTracers, drawEngagementFire, spawnTracer } from '../combatFx';
import type { RenderContext } from '../mapRenderer';
import type { Body, Ship } from '../../types';

// jsdom has no 2D canvas: the baked glow sprites fall back to plain arcs.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

function countingCtx(): { ctx: CanvasRenderingContext2D; calls: () => number } {
  let n = 0;
  const target: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(target, {
    get(_t, key) {
      if (key in target) return target[key as string];
      return () => { n++; return { addColorStop: () => {} }; };
    },
    set(_t, key, value) { target[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls: () => n };
}

// Europa at the centre of an 800x600 canvas, drawn 100 px across.
const EUROPA = { id: 'europa', name: 'Europa', type: 'moon', radius: 1 } as unknown as Body;
const orbit = { parentBodyId: 'europa', rp: 2, ra: 2, omega: 0, M0: 0, epoch: 0, period: 100, direction: 1 };

const arriving = {
  id: 'g:strike0', ownedBy: 'terra', class: 'destroyer', hp: 100, damagePerTick: 10,
  lastCombatTick: 50, lastTargetId: 'g:def0',
  orbit: { ...orbit, parentBodyId: 'ganymede' },
  transit: { pos: { x: -3, y: 0 }, vel: { x: 0, y: 0 }, currentTransfer: { targetBodyId: 'europa' } },
} as unknown as Ship;
const defender = (id: string) => ({
  id, ownedBy: 'jove', class: 'destroyer', hp: 100, damagePerTick: 10, orbit,
} as unknown as Ship);

function rcWith(defenderAt: { x: number; y: number }, ctx: CanvasRenderingContext2D) {
  return {
    ctx, canvas: { width: 800, height: 600 }, camera: { x: 0, y: 0, scale: 100 },
    t: 50, bodies: [EUROPA], presentation: { radius: new Map([['europa', 100]]) },
    shipHitboxes: new Map([['g:def0', { ...defenderAt, r: 12 }]]), fleetSlots: new Map(),
  } as unknown as RenderContext;
}
// The arriving hull is DRAWN at its dwell spot, left of Europa.
const transitPos = new Map([['g:strike0', { x: 250, y: 300 }]]);

describe('one-shot tracers', () => {
  it('a shot from a hull in flight does not cross the world it is drawn beside', () => {
    const { ctx, calls } = countingCtx();
    const now = 100000;
    spawnTracer('g:strike0', 'g:def0', now);
    // The defender is drawn on the far side: the chord runs through the centre.
    drawTracers(rcWith({ x: 560, y: 300 }, ctx), [arriving, defender('g:def0')], [], now + 10, transitPos);
    expect(calls()).toBe(0);
  });

  it('...and still draws when the chord clears it', () => {
    const { ctx, calls } = countingCtx();
    const now = 200000;
    spawnTracer('g:strike0', 'g:def0', now);
    drawTracers(rcWith({ x: 300, y: 150 }, ctx), [arriving, defender('g:def0')], [], now + 10, transitPos);
    expect(calls()).toBeGreaterThan(0);
  });
});

describe('sustained fire', () => {
  const course = new Map([['g:strike0', { x: 0, y: 0 }], ['g:def0', { x: 1, y: 0 }]]);
  function sweep(defenderAt: { x: number; y: number }): number {
    const { ctx, calls } = countingCtx();
    const rc = rcWith(defenderAt, ctx);
    for (let ms = 0; ms < 6000; ms += 16) {
      drawEngagementFire(rc, [arriving, defender('g:def0')], [], ms, 50, transitPos, ['jove|terra'], true,
        undefined, undefined, course);
    }
    return calls();
  }

  it('a hull in flight firing at a defender behind the world draws no fire through it', () => {
    // The contested-world ambience may still draw; compare with a clear shot.
    const blocked = sweep({ x: 560, y: 300 });
    const clear = sweep({ x: 300, y: 150 });
    expect(clear).toBeGreaterThan(blocked + 20);
  });
});
