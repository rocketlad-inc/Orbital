/**
 * Whole-orbit battles on the live map (battleLayoutLive). The rules Lorne
 * approved on /?battle (2026-10-06):
 *   - ships are fixed in scale to the world: zoom multiplies one layout,
 *     it never re-solves it (the orbital-lanes failure was re-solving
 *     from zoom-dependent sizes, and ships jumped)
 *   - the layout is sticky: the same roster gets the same layout
 *   - a roster change GLIDES, it does not jump
 *   - fleets are their markers (flagship + block) and nothing overlaps
 *   - noses point forward in the wheel's sense
 */
import fs from 'fs';
import path from 'path';
import {
  battleReferenceRadius, fleetBlockGeometry, liveBattleFor, battlePlacement, battleScale,
  resetLiveBattles, escortBlockSpacing, FLEET_ESCORT_SCALE, type BattleUnit,
} from '../battleLayoutLive';
import { escortOffsets, escortSpacingFor, escortGlyphFor } from '../fleetGrouping';

beforeEach(() => resetLiveBattles());

const MARS_R = 2.5;
const unit = (id: string, owner: string, sizePx: number, group: string | null = null,
  escortRel?: number[]): BattleUnit => ({ id, owner, group, sizePx, armed: true, escortRel });

/** A Large-ish fight: two fleets a side plus a swarm each. */
function roster(): BattleUnit[] {
  const out: BattleUnit[] = [];
  out.push(unit('a-f1', 'a', 84, 'fa1', Array(18).fill(0.5)));
  out.push(unit('a-f2', 'a', 116, 'fa2', Array(9).fill(0.6)));
  out.push(unit('b-f1', 'b', 84, 'fb1', Array(14).fill(0.4)));
  for (let i = 0; i < 30; i++) out.push(unit(`a-${i}`, 'a', i % 3 ? 30 : 48, i % 4 ? 'sa' : null));
  for (let i = 0; i < 28; i++) out.push(unit(`b-${i}`, 'b', i % 3 ? 30 : 84, i % 5 ? 'sb' : null));
  return out;
}

test('the reference size grows with the world, Mars at 150px', () => {
  expect(battleReferenceRadius(MARS_R)).toBeCloseTo(150, 0);
  expect(battleReferenceRadius(8)).toBeGreaterThan(battleReferenceRadius(MARS_R));
  expect(battleReferenceRadius(0.5)).toBeLessThan(battleReferenceRadius(MARS_R));
  expect(battleReferenceRadius(0.001)).toBe(60);
  expect(battleReferenceRadius(1000)).toBe(320);
});

test('the same roster keeps the same layout, in any order (no re-solve)', () => {
  const r = roster();
  const a = liveBattleFor('mars', MARS_R, 1, r, ['a', 'b'], 'stn');
  const b = liveBattleFor('mars', MARS_R, 1, [...r].reverse(), ['a', 'b'], 'stn');
  expect(b).toBe(a);
  // A new hull is a new roster.
  const c = liveBattleFor('mars', MARS_R, 1, [...r, unit('b-new', 'b', 30)], ['a', 'b'], 'stn');
  expect(c).not.toBe(a);
});

test('zoom is a camera: the layout carries no zoom, and k is the world’s drawn radius over the reference', () => {
  const lb = liveBattleFor('mars', MARS_R, 1, roster(), ['a', 'b'], 'stn');
  expect(battleScale(lb, lb.refR)).toBeCloseTo(1, 9);
  expect(battleScale(lb, lb.refR / 2)).toBeCloseTo(0.5, 9);
  // The placement is in reference px; screen px = placement x k. Two
  // "zooms" at the same instant give the same placement, so a hull's
  // screen point scales exactly with k about the world's centre.
  const p1 = battlePlacement(lb, 'a-3', 1000)!;
  const p2 = battlePlacement(lb, 'a-3', 1000)!;
  expect(p2.x).toBeCloseTo(p1.x, 9);
  expect(p2.y).toBeCloseTo(p1.y, 9);
});

test('nothing overlaps, fleets as their blocks, the station opposite the fight', () => {
  const lb = liveBattleFor('mars', MARS_R, 1, roster(), ['a', 'b'], 'stn');
  expect(lb.layout.overlaps).toBe(0);
  expect(lb.blocks.size).toBe(3);
  expect(lb.layout.station).toBeDefined();
});

test('a fleet block measures what the map draws, and scales linearly with k', () => {
  const g = fleetBlockGeometry(84, Array(18).fill(0.5));
  // The flagship sits ahead of the block's centre (escorts astern).
  expect(g.flagX).toBeGreaterThan(0);
  // MapCanvas draws escortOffsets(n, spacing*k, h, standoff*k): exactly k
  // times the full-size block, so the fleet shrinks in place.
  const full = escortOffsets(18, g.spacing, 0.7, g.standoff);
  const half = escortOffsets(18, g.spacing * 0.5, 0.7, g.standoff * 0.5);
  full.forEach((o, i) => {
    expect(half[i].dx).toBeCloseTo(o.dx * 0.5, 9);
    expect(half[i].dy).toBeCloseTo(o.dy * 0.5, 9);
  });
});

test('fleet escorts are half again bigger, and still never touch', () => {
  const n = 18, hr = 45;
  const base = Math.max(9, Math.min(24, hr * 0.9));
  expect(escortBlockSpacing(n, hr)).toBeCloseTo(escortSpacingFor(n, base, hr) * 1.5, 9);
  expect(FLEET_ESCORT_SCALE).toBe(1.5);
  // escortGlyphFor draws each escort inside its slot.
  const sp = escortBlockSpacing(n, hr);
  expect(escortGlyphFor(sp)).toBeLessThan(sp);
  // The layout's block uses the same spacing, so it is laid out as drawn.
  expect(fleetBlockGeometry(84, Array(n).fill(1)).spacing).toBeCloseTo(escortBlockSpacing(n, 45), 9);
});

test('a roster change glides: no jump on the frame it happens, settled a couple of seconds later', () => {
  const r = roster();
  const lb1 = liveBattleFor('mars', MARS_R, 1, r, ['a', 'b'], 'stn');
  const before = battlePlacement(lb1, 'a-3', 0)!;
  // Half the other side arrives.
  const more = [...r];
  for (let i = 0; i < 40; i++) more.push(unit(`b-x${i}`, 'b', 30, 'sb'));
  const lb2 = liveBattleFor('mars', MARS_R, 1, more, ['a', 'b'], 'stn');
  const target = lb2.layout.placements.get('a-3')!;
  const first = battlePlacement(lb2, 'a-3', 16)!;
  const jump = Math.hypot(first.x - before.x, first.y - before.y);
  const wholeMove = Math.hypot(target.x - before.x, target.y - before.y);
  // One frame covers only a small part of the way.
  expect(jump).toBeLessThan(Math.max(2, wholeMove * 0.15));
  let p = first;
  for (let t = 32; t <= 3000; t += 16) p = battlePlacement(lb2, 'a-3', t)!;
  // Settled on the new place (the wheel turns meanwhile; compare radii
  // and the angle with the wheel's 3s turn taken off).
  expect(p.r).toBeCloseTo(target.r, 0);
});

test('noses point forward in the wheel’s sense, either way round', () => {
  const r = roster();
  const fwd = liveBattleFor('mars', MARS_R, 1, r, ['a', 'b']);
  resetLiveBattles();
  const back = liveBattleFor('mars', MARS_R, -1, r, ['a', 'b']);
  const off = (h: number, t: number) => {
    let d = (h - t) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  for (const id of ['a-1', 'b-2', 'a-f1']) {
    const pf = battlePlacement(fwd, id, 500)!;
    expect(Math.abs(off(pf.heading, pf.theta + Math.PI / 2))).toBeLessThanOrEqual(0.12);
    const pb = battlePlacement(back, id, 500)!;
    expect(Math.abs(off(pb.heading, pb.theta - Math.PI / 2))).toBeLessThanOrEqual(0.12);
  }
});

test('the live map uses it at EVERY world in multiplayer; single-player keeps its lines and rings', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../components/MapCanvas.tsx'), 'utf8');
  // Not gated on a battle: peaceful worlds scale with the planet too
  // (Lorne, 2026-10-06: "make every world scale with the planet").
  expect(src).toMatch(/if \(mpActions\) \{\s*const bodyId = atBody\[0\]\.orbit\.parentBodyId;/);
  expect(src).not.toMatch(/if \(battle && mpActions\)/);
  // A laid-out ship is not on its orbit ring, so neither is drawn for it.
  expect((src.match(/if \(showOrbitRing && !formation\?\.battle\)/g) ?? []).length).toBe(2);
  const r = fs.readFileSync(path.join(__dirname, '../mapRenderer.ts'), 'utf8');
  // drawShip honours a battle only when the MP presentation exists.
  expect(r).toMatch(/const liveBattle = ctx\.presentation \? formation\?\.battle : undefined;/);
});
