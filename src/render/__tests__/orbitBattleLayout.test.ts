/**
 * A battle that uses the whole orbit (prototype for the cramped-fleet
 * problem, Lorne 2026-10-06). The rules it promises:
 *   - a small fight stays compact; a big one widens around the world
 *   - no sprite overlaps while the band has room
 *   - each faction keeps a contiguous share of the orbit (friendlies
 *     together), and fleet-mates cluster within it
 *   - nothing is drawn inside the planet; the band is bounded
 *   - the same roster always lays out the same way (no jumping)
 */
import { layoutOrbitBattle, layoutTodayLines, crossesPlanet } from '../orbitBattleLayout';
import { buildScenario } from '../../battleSandbox/scenarios';

const MARS = 150;
const LUNA = 70;

const angleSpan = (thetas: number[]) => {
  // Smallest arc covering all angles.
  const s = [...thetas].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < s.length; i++) {
    const next = i + 1 < s.length ? s[i + 1] : s[0] + Math.PI * 2;
    maxGap = Math.max(maxGap, next - s[i]);
  }
  return Math.PI * 2 - maxGap;
};

test('a small fight stays compact', () => {
  const L = layoutOrbitBattle(buildScenario('small'), MARS);
  expect(L.mode).toBe('compact');
  const span = angleSpan([...L.placements.values()].map(p => p.theta));
  expect(span).toBeLessThan(1.9);
  expect(L.overlaps).toBe(0);
});

test('a large fight wraps the world, and nothing overlaps', () => {
  const ships = buildScenario('large');
  const L = layoutOrbitBattle(ships, MARS);
  expect(['ring', 'deep ring']).toContain(L.mode);
  expect(L.overlaps).toBe(0);
  // Today's rules overlap heavily on the same roster.
  expect(layoutTodayLines(ships, MARS).overlaps).toBeGreaterThan(50);
});

test('medium and three-way fights at Mars: no overlaps', () => {
  expect(layoutOrbitBattle(buildScenario('medium'), MARS).overlaps).toBe(0);
  expect(layoutOrbitBattle(buildScenario('three'), MARS).overlaps).toBe(0);
});

test('friendlies stay together: a faction holds one contiguous share', () => {
  const ships = buildScenario('large');
  const L = layoutOrbitBattle(ships, MARS);
  for (const f of ['a', 'b']) {
    const span = angleSpan(ships.filter(s => s.faction === f).map(s => L.placements.get(s.id)!.theta));
    const sec = L.sectors.find(s => s.faction === f)!;
    // Within its share, plus a ragged edge of a little over a ship.
    expect(span).toBeLessThan((sec.end - sec.start) + 0.6);
  }
});

test('fleet-mates cluster tighter than their faction', () => {
  const ships = buildScenario('large');
  const L = layoutOrbitBattle(ships, MARS);
  const a = ships.filter(s => s.faction === 'a');
  const fleets = [...new Set(a.map(s => s.fleet).filter(Boolean))] as string[];
  const factionSpan = angleSpan(a.map(s => L.placements.get(s.id)!.theta));
  for (const f of fleets) {
    const mates = a.filter(s => s.fleet === f);
    if (mates.length < 3) continue;
    expect(angleSpan(mates.map(s => L.placements.get(s.id)!.theta))).toBeLessThan(factionSpan * 0.6);
  }
});

test('nothing inside the planet; the band is bounded even when crammed', () => {
  const ships = buildScenario('large');
  const L = layoutOrbitBattle(ships, LUNA);
  for (const s of ships) {
    const p = L.placements.get(s.id)!;
    expect(p.r).toBeGreaterThan(LUNA);
    expect(p.r).toBeLessThan(L.band.rOut + s.size);
  }
});

test('the same roster lays out the same way every time', () => {
  const a = layoutOrbitBattle(buildScenario('medium'), MARS);
  const b = layoutOrbitBattle(buildScenario('medium'), MARS);
  for (const [id, p] of a.placements) {
    expect(b.placements.get(id)!.x).toBeCloseTo(p.x, 6);
    expect(b.placements.get(id)!.y).toBeCloseTo(p.y, 6);
  }
});

test('every ship points forward along its orbit, like the map', () => {
  const L = layoutOrbitBattle(buildScenario('large'), MARS);
  for (const p of L.placements.values()) {
    const tangent = Math.atan2(p.y, p.x) + Math.PI / 2;
    let d = (p.heading - tangent) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    expect(Math.abs(d)).toBeLessThanOrEqual(0.11 + 1e-9);
  }
});

test('the planet-crossing check', () => {
  expect(crossesPlanet(-200, 0, 200, 0, MARS)).toBe(true);
  expect(crossesPlanet(-200, 180, 200, 180, MARS)).toBe(false);
});
