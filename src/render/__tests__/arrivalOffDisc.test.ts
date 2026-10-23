/**
 * AN ARRIVAL COMES IN FROM OUTSIDE (the Dyson Sphere clip, 2026-10-23).
 * Fleets arriving at the Sun's orbit battle braked onto the ring with
 * their plumes laid 150 px across the Sun, and at f630 a whole purple
 * block sat on the limb over the disc: "ships flying out of the Sun".
 *
 * A braking hull flies nose-out: engine, plume AND its escort block (drawn
 * astern of the flagship as drawn) point at the world. The course runs to
 * the world's centre, and keepOffDrawnDiscs held the flagship at the disc's
 * edge plus 10 px, so the block and the flame lay over the disc, and over
 * the hulls already fighting there, through the roster dwell.
 *
 * Replayed through the calls MapCanvas makes: the flagship stops outside
 * the fight with its whole block, glides to its slot round the outside,
 * and its plume is clipped at the limb.
 */
import fs from 'fs';
import path from 'path';
import {
  keepOffDrawnDiscs, arrivalStandoffPx, flightReachPx, drawOffDiscs, shipIconSize,
} from '../mapRenderer';
import {
  liveBattleFor, resetLiveBattles, battlePlacement, seedBattleGlide, battleScale, escortBlockSpacing,
  ROSTER_DWELL_MS, type BattleUnit,
} from '../battleLayoutLive';
import { escortOffsets, escortStandoffFor, escortGlyphFor } from '../fleetGrouping';

beforeEach(() => resetLiveBattles());

const SCALE = 2.8;                 // camera px per world unit (the clip's)
const SUN_PX = 240;                // the Sun's drawn radius at that zoom
const N = 21;                      // escorts in the arriving block
const REL = 0.7;

const block = (id: string, owner: string, escorts: number): BattleUnit => ({
  id, owner, group: id, sizePx: 60, armed: true,
  escortRel: Array(escorts).fill(REL),
  escortIds: Array.from({ length: escorts }, (_, i) => `${id}-e${i}`),
});
const ring = (): BattleUnit[] => [
  block('terra-1', 'terra', 12), block('terra-2', 'terra', 12), block('mars-1', 'mars', 12),
  block('mars-2', 'mars', 12), block('jove-1', 'jove', 10), block('jove-2', 'jove', 8),
];

/** Every hull of the arriving block as the marker pass draws it in flight,
 *  flagship at `lead` (px from the Sun), nose `heading`: [x, y, half-size]. */
function drawnBlock(lead: { x: number; y: number }, heading: number, flagPx: number): Array<[number, number, number]> {
  const hbR = flagPx / 2 + 3;
  const spacing = escortBlockSpacing(N, hbR);
  const offs = escortOffsets(N, spacing, heading, escortStandoffFor(hbR, spacing));
  const half = Math.max(3, escortGlyphFor(spacing) * REL) / 2;
  return [[lead.x, lead.y, flagPx / 2], ...offs.map(o => [lead.x + o.dx, lead.y + o.dy, half] as [number, number, number])];
}

/** Where the flagship ends its run in to the Sun from straight below,
 *  with the destination disc held at R px. */
function stopAt(Rpx: number): { x: number; y: number } {
  const course = Array.from({ length: 41 }, (_, i) => ({ t: i / 40, x: 0, y: (600 * (40 - i)) / 40 }));
  const placed = keepOffDrawnDiscs(course, [{ at: () => ({ x: 0, y: 0 }), R: Rpx / SCALE, isDest: true }]);
  const last = placed[placed.length - 1];
  return { x: last.x * SCALE, y: last.y * SCALE };
}

test('a braking fleet stops with its whole block outside the Sun and outside the fight', () => {
  const lb = liveBattleFor('sol', 20, 1, ring(), ['jove', 'mars', 'terra']);
  const k = battleScale(lb, SUN_PX);
  const flagPx = shipIconSize('destroyer', false);
  const reach = flightReachPx(flagPx, Array(N).fill(REL));
  const lead = stopAt(arrivalStandoffPx(SUN_PX, lb, reach));
  // Nose out (braking): pointing away from the Sun.
  const heading = Math.atan2(lead.y, lead.x);
  for (const [x, y, h] of drawnBlock(lead, heading, flagPx)) {
    const inner = Math.hypot(x, y) - h;
    expect(inner).toBeGreaterThan(SUN_PX);              // never over the disc
    expect(inner).toBeGreaterThan(lb.outerR * k);       // nor over the ring of hulls
  }
  // The rule it replaces held the flagship at the limb plus 10 px, and laid
  // the block astern of it across the Sun (f630).
  const old = stopAt(SUN_PX + 10);
  const overDisc = drawnBlock(old, Math.atan2(old.y, old.x), flagPx)
    .filter(([x, y, h]) => Math.hypot(x, y) - h < SUN_PX).length;
  expect(overDisc).toBeGreaterThan(N / 3);
});

test('a lone hull stops off the disc by its own half-size; without a fight, at the limb', () => {
  const px = 30;
  const R = arrivalStandoffPx(SUN_PX, undefined, flightReachPx(px));
  const p = stopAt(R);
  expect(Math.hypot(p.x, p.y) - px / 2).toBeGreaterThan(SUN_PX + 9);
  expect(R).toBeLessThan(SUN_PX + 10 + px);
});

test('landed, it glides to its slot round the outside, never across the Sun', () => {
  const owners = ['jove', 'mars', 'terra'];
  const first = liveBattleFor('sol', 20, 1, ring(), owners, undefined, { nowMs: 0 });
  const k = battleScale(first, SUN_PX);
  const flagPx = shipIconSize('destroyer', false);
  const lead = stopAt(arrivalStandoffPx(SUN_PX, first, flightReachPx(flagPx, Array(N).fill(REL))));
  // Its slot: the roster with it, after the dwell.
  const units = [...ring(), block('terra-new', 'terra', N)];
  liveBattleFor('sol', 20, 1, units, owners, undefined, { nowMs: 100 });
  const now0 = 100 + ROSTER_DWELL_MS;
  const lb = liveBattleFor('sol', 20, 1, units, owners, undefined, { nowMs: now0 });
  const clearR = lb.blocks.get('terra-new')!.clearR;
  // MapCanvas seeds the glide from where it was drawn (reference px).
  seedBattleGlide('terra-new', Math.hypot(lead.x, lead.y) / k, Math.atan2(lead.y, lead.x), now0);
  let minInner = Infinity;
  for (let t = now0; t <= now0 + 3000; t += 16) {
    const p = battlePlacement(lb, 'terra-new', t)!;
    minInner = Math.min(minInner, (p.r - clearR) * k);
  }
  expect(minInner).toBeGreaterThan(SUN_PX);
});

test('a plume is clipped at the limb of the world it is braking into', () => {
  const calls: string[] = [];
  const g = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    rect: () => calls.push('rect'),
    arc: (x: number, y: number, r: number) => calls.push(`arc ${x},${y},${r}`),
    clip: (rule: string) => calls.push(`clip ${rule}`),
  } as unknown as CanvasRenderingContext2D;
  const sun = { x: 500, y: 300, r: SUN_PX };
  // Braking at the limb, flame toward the Sun.
  drawOffDiscs(g, [sun], 500, 300 + SUN_PX + 20, 150, () => calls.push('draw'));
  expect(calls).toEqual(['save', 'beginPath', 'rect', `arc 500,300,${SUN_PX}`, 'clip evenodd', 'draw', 'restore']);
  // Far from any disc: drawn as ever, no clip.
  calls.length = 0;
  drawOffDiscs(g, [sun], 500, 300 + SUN_PX + 400, 150, () => calls.push('draw'));
  expect(calls).toEqual(['draw']);
});

test('the map routes every hull plume through the disc clip, and arrivals through the standoff', () => {
  const r = fs.readFileSync(path.join(__dirname, '../mapRenderer.ts'), 'utf8');
  // Transit exhaust + hint, the landing plume, an escort's hint.
  expect((r.match(/drawOffDiscs\([^;]*?=>\s*drawThrust(Exhaust|Hint)\(/g) ?? []).length).toBe(4);
  const m = fs.readFileSync(path.join(__dirname, '../../components/MapCanvas.tsx'), 'utf8');
  expect(m).toMatch(/b\.id === destId\s*\?\s*arrivalStandoffPx\(drawnRadiusOf\(pres, b, sc\), renderContext\.liveBattles\?\.get\(b\.id\), reach\)/);
});
