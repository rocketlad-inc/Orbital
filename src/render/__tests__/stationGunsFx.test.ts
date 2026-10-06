// "Stations without weapons visually shoot back invading forces."
// (Franz, map playtest 2026-10.)
//
// The server only lets a station fire once its Weapons module is built
// and never lets a city fire (worker/room.js, "Station return-fire"), but
// it stamps last_combat_tick on a settlement the first time it is HIT —
// so an ungunned station under attack carried a fresh "fired" stamp and
// the FX layer drew it shooting back. In multiplayer MapCanvas passes
// settlementHasGuns, and a settlement without guns is never a shooter.

import { drawEngagementFire, settlementHasGuns } from '../combatFx';
import type { RenderContext } from '../mapRenderer';
import type { Body, Settlement, Ship } from '../../types';

/** A 2D context that only counts what is asked of it. */
function countingCtx(): { ctx: CanvasRenderingContext2D; calls: () => number } {
  let n = 0;
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, key) {
      if (key in target) return target[key as string];
      return (..._args: unknown[]) => {
        n++;
        return { addColorStop: () => {} };   // gradients
      };
    },
    set(_t, key, value) { target[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls: () => n };
}

const earth = { id: 'earth', type: 'planet', radius: 6 } as unknown as Body;

const raider = {
  id: 'raider', ownedBy: 'f1', class: 'destroyer', hp: 100, damagePerTick: 10,
  orbit: { parentBodyId: 'earth', radius: 10, period: 100, phase: 0 },
} as unknown as Ship;

const station = (buildings: Record<string, number> | undefined, type: 'station' | 'city' = 'station') => ({
  id: `stl-${type}-${JSON.stringify(buildings ?? {})}`, type, bodyId: 'earth', ownedBy: 'f0',
  hp: 500, maxHp: 500, buildings,
  // The server's first-hit stamp: "fired" this tick, aimed at the raider.
  lastCombatTick: 50, lastTargetId: 'raider',
} as unknown as Settlement);

/** Total canvas work over a 4-second sweep of animation time, so the
 *  shooter's duty cycle is sampled whatever its phase. */
function drawWork(stl: Settlement, gate?: (s: Settlement) => boolean): number {
  const { ctx, calls } = countingCtx();
  const rc = {
    ctx, canvas: { width: 800, height: 600 }, camera: { x: 0, y: 0, scale: 4 },
    t: 50, bodies: [earth],
    shipHitboxes: new Map([['raider', { x: 440, y: 300, r: 8 }]]),
    fleetSlots: new Map(),
  } as unknown as RenderContext;
  const ships = [raider];
  const stls = [stl];
  for (let ms = 0; ms < 4000; ms += 16) {
    drawEngagementFire(rc, ships, stls, ms, 50, undefined, ['f0|f1'], false, undefined, gate);
  }
  return calls();
}

describe('stations without guns do not shoot back (multiplayer)', () => {
  it('an UNARMED station stamped by a hit draws no fire at all', () => {
    expect(drawWork(station(undefined), settlementHasGuns)).toBe(0);
    expect(drawWork(station({ shipyard: 1 }), settlementHasGuns)).toBe(0);
  });

  it('a city draws no fire either', () => {
    expect(drawWork(station({ weapons: 2 }, 'city'), settlementHasGuns)).toBe(0);
  });

  it('a station WITH a Weapons module still fires', () => {
    expect(drawWork(station({ weapons: 1 }), settlementHasGuns)).toBeGreaterThan(0);
  });

  it('without the gate (legacy callers) the old behaviour is unchanged', () => {
    expect(drawWork(station(undefined))).toBeGreaterThan(0);
  });
});
