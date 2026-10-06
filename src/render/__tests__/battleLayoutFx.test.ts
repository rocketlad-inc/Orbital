/**
 * "Rogue damage effects floating by" (Lorne, 2026-10-06, in the world
 * menu). With every world laid out (battleLayoutLive), a hull's place is
 * its spot in the layout, not its raw orbit point. Effects for a hull
 * that was NOT drawn this frame (culled off-screen) used to fall back to
 * the raw orbit point, so its fire and smoke floated in empty space; and
 * every station is hidden while a world menu is open, yet its fire was
 * still drawn at its orbit. These pin both.
 */
import { shipCanvasPos, settlementCanvasPos } from '../combatFx';
import { liveBattleFor, battleShipOffsetPx, battleScale, resetLiveBattles } from '../battleLayoutLive';
import { worldToCanvas, type RenderContext } from '../mapRenderer';
import { bodyPosition, localPositionAt } from '../../physics/orbitalMechanics';
import { shipDisplayTick, spinNowMs } from '../tickPhase';
import type { Ship, Settlement, Body } from '../../types';

beforeEach(() => resetLiveBattles());

const MARS = { id: 'mars', name: 'Mars', type: 'terrestrial', radius: 2.5, orbitRadius: 0, orbitPeriod: 0, angle0: 0 } as unknown as Body;
const orbit = { parentBodyId: 'mars', rp: 4, ra: 4, omega: 0, M0: 0, epoch: 0, period: 100, direction: 1 };
const ship = (id: string) => ({ id, ownedBy: 'a', class: 'destroyer', orbit } as unknown as Ship);

function rcFor(drawnR: number) {
  const units = [
    { id: 'lead', owner: 'a', group: 'f1', sizePx: 84, armed: true, escortRel: [0.5, 0.5, 0.5], escortIds: ['e1', 'e2', 'e3'] },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, owner: 'a', group: 's', sizePx: 30, armed: true })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, owner: 'b', group: 's2', sizePx: 48, armed: true })),
  ];
  const lb = liveBattleFor('mars', 2.5, 1, units, ['a', 'b'], 'stn');
  const rc = {
    bodies: [MARS], t: 0, nowMs: 1000,
    camera: { x: 0, y: 0, scale: drawnR / 2.5 },
    canvas: { width: 800, height: 600 },
    presentation: { radius: new Map([['mars', drawnR]]) },
    liveBattles: new Map([['mars', lb]]),
    shipHitboxes: new Map(),
    fleetSlots: new Map(),
  } as unknown as RenderContext;
  return { rc, lb };
}

test('an undrawn hull at a laid-out world resolves to its layout spot, not its raw orbit', () => {
  const { rc, lb } = rcFor(150);
  const got = shipCanvasPos(ship('a3'), rc)!;
  const bp = bodyPosition(MARS, 0, [MARS]);
  const c = worldToCanvas(bp.x, bp.y, rc);
  const k = battleScale(lb, 150);
  const off = battleShipOffsetPx(lb, 'a3', 1000, k)!;
  expect(got.x).toBeCloseTo(c.x + off.x, 6);
  expect(got.y).toBeCloseTo(c.y + off.y, 6);
  // ...which is NOT where the old fallback put it.
  const lp = localPositionAt(orbit as never, shipDisplayTick(0, 100, spinNowMs()));
  const raw = worldToCanvas(bp.x + lp.x, bp.y + lp.y, rc);
  expect(Math.hypot(got.x - raw.x, got.y - raw.y)).toBeGreaterThan(5);
});

test('an escort with no slot this frame resolves to its fleet’s block, not empty space', () => {
  const { rc, lb } = rcFor(150);
  const got = shipCanvasPos(ship('e2'), rc)!;
  const k = battleScale(lb, 150);
  const centre = battleShipOffsetPx(lb, 'e2', 1000, k)!;     // the block's centre
  const bp = bodyPosition(MARS, 0, [MARS]);
  const c = worldToCanvas(bp.x, bp.y, rc);
  expect(got.x).toBeCloseTo(c.x + centre.x, 6);
  expect(got.y).toBeCloseTo(c.y + centre.y, 6);
});

test('a drawn hull still resolves to where it was drawn', () => {
  const { rc } = rcFor(150);
  rc.shipHitboxes!.set('a3', { x: 11, y: 22, r: 9 });
  expect(shipCanvasPos(ship('a3'), rc)).toEqual({ x: 11, y: 22 });
});

test('a station the map did not draw this frame (world menu open) has no place for effects', () => {
  const { rc } = rcFor(150);
  const st = { id: 'stn', type: 'station', bodyId: 'mars', orbit, hp: 100, maxHp: 400 } as unknown as Settlement;
  rc.stationCanvasPos = new Map();
  expect(settlementCanvasPos(st, rc)).toBeNull();
  rc.stationCanvasPos.set('stn', { x: 300, y: 200 });
  expect(settlementCanvasPos(st, rc)).toEqual({ x: 300, y: 200 });
});
