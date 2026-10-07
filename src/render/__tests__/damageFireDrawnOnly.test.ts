/**
 * "The artifacts on the edge of the screen when having the game open for a
 * while are back with a VENGEANCE" (player report, 2026-10-06). Damage fire
 * and smoke never asked whether the hull was DRAWN: a crippled hull that was
 * culled, folded or fogged burned at a computed point in empty space, at the
 * screen edge, for as long as it stayed crippled.
 */
import { drawBattleDamageStates } from '../combatFx';
import type { RenderContext } from '../mapRenderer';
import type { Ship } from '../../types';

function countingCtx() {
  let calls = 0;
  const g = new Proxy({} as Record<string, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return (..._a: unknown[]) => { calls++; return { addColorStop() {} }; };
    },
    set(target, prop, v) { target[prop as string] = v; return true; },
  });
  return { g, calls: () => calls };
}

const MARS = { id: 'mars', name: 'Mars', type: 'terrestrial', radius: 2.5, orbitRadius: 0, orbitPeriod: 0, angle0: 0 };
const crippled = {
  id: 'hulk', ownedBy: 'a', class: 'destroyer', hp: 5, hpMax: 100,
  orbit: { parentBodyId: 'mars', rp: 4, ra: 4, omega: 0, M0: 0, epoch: 0, period: 100, direction: 1 },
} as unknown as Ship;

function rcWith(hitboxes: Map<string, { x: number; y: number; r: number }>) {
  const { g, calls } = countingCtx();
  const rc = {
    ctx: g, canvas: { width: 800, height: 600 },
    camera: { x: 0, y: 0, scale: 40 }, bodies: [MARS], t: 0, nowMs: 1000,
    shipHitboxes: hitboxes, fleetSlots: new Map(),
  } as unknown as RenderContext;
  return { rc, calls };
}

test('a crippled hull that was not drawn this frame does not burn in empty space', () => {
  const { rc, calls } = rcWith(new Map());
  drawBattleDamageStates(rc, [crippled], [], 1000);
  expect(calls()).toBe(0);
});

test('a crippled hull that WAS drawn still burns where it is', () => {
  const { rc, calls } = rcWith(new Map([['hulk', { x: 400, y: 300, r: 20 }]]));
  drawBattleDamageStates(rc, [crippled], [], 1000);
  expect(calls()).toBeGreaterThan(0);
});
