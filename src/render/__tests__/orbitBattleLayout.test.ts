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
import {
  buildScenario, fleetGeometry, SCENARIOS, SIZE_LADDERS, type ScenarioId, type SizeLadderId,
} from '../../battleSandbox/scenarios';
import { hullSize, blendRadius, DISPLAY_FLOOR_PX } from '../bodyPresentation';

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

test('a big swarm wraps the world, and nothing overlaps', () => {
  const ships = buildScenario('swarm');
  const L = layoutOrbitBattle(ships, MARS);
  expect(['ring', 'deep ring', 'crammed']).toContain(L.mode);
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
    expect(p.r).toBeLessThan(L.band.rOut + (s.clearR ?? s.size));
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

test('zooming out re-spreads the fight: no overlaps at any zoom', () => {
  // The whole point (Lorne): sprites keep the map's pixel sizes while
  // the world shrinks under them, so pulling back is when hulls pile up.
  for (const id of Object.keys(SCENARIOS) as ScenarioId[]) {
    // As the map: hulls size on the world's TRUE radius, the ring sits
    // round the DRAWN disc (true size, but never under the display floor),
    // down to where hulls fold into the count badge (10px true).
    for (const px of [400, 150, 60, 34, 20, 12]) {
      const hs = hullSize({ type: 'terrestrial', radius: px }, 1);
      const drawn = blendRadius(px, DISPLAY_FLOOR_PX.planet);
      const L = layoutOrbitBattle(buildScenario(id, 1, hs), drawn);
      expect({ id, px, overlaps: L.overlaps }).toEqual({ id, px, overlaps: 0 });
    }
  }
});

test('neighbouring shares keep a strip of open space between them', () => {
  for (const id of ['medium', 'large', 'swarm', 'three'] as ScenarioId[]) {
    const ships = buildScenario(id);
    const L = layoutOrbitBattle(ships, MARS);
    const S = L.sectors;
    for (let i = 0; i < S.length; i++) {
      const next = S[i + 1] ?? (L.mode === 'compact' || L.mode === 'wide' ? undefined : { ...S[0], start: S[0].start + Math.PI * 2 });
      if (!next) continue;
      const gap = next.start - S[i].end;
      expect(gap).toBeGreaterThan(0.05);
      // The middle third of the gap is empty of hull centres.
      const lo = S[i].end + gap / 3, hi = next.start - gap / 3;
      for (const p of L.placements.values()) {
        let t = p.theta;
        while (t < lo) t += Math.PI * 2;
        while (t - Math.PI * 2 >= lo) t -= Math.PI * 2;
        expect({ id, inGap: t > lo && t < hi }).toEqual({ id, inGap: false });
      }
    }
  }
});

test('a fleet is drawn as the map draws it: escorts behind, clear of the flagship', () => {
  const g = fleetGeometry('f', 'mega_destroyer', Array(28).fill('frigate'), 1);
  const flagR = g.flagSize / 2;
  for (const e of g.escorts) {
    expect(e.x).toBeLessThan(g.flagX);                      // astern
    expect(Math.hypot(e.x - g.flagX, e.y)).toBeGreaterThan(flagR + e.size / 2 - 1);
    expect(e.size).toBeLessThan(g.flagSize / 2);            // small glyphs
    expect(Math.hypot(e.x, e.y) + e.size * 0.42).toBeLessThanOrEqual(g.clearR + 1e-6);
  }
});

// The world's station sits OPPOSITE the fight (Lorne, 2026-10-06), and
// nothing overlaps it, at every size contrast on the test page.
const circMean = (ts: number[]) =>
  Math.atan2(ts.reduce((n, t) => n + Math.sin(t), 0), ts.reduce((n, t) => n + Math.cos(t), 0));
const angGap = (a: number, b: number) => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
};

test('the station sits on the far side of a battle that does not wrap', () => {
  for (const ladder of Object.keys(SIZE_LADDERS) as SizeLadderId[]) {
    const px = SIZE_LADDERS[ladder].px;
    for (const id of ['small', 'medium'] as ScenarioId[]) {
      const L = layoutOrbitBattle(buildScenario(id, 1, 1, px), MARS,
        { station: { id: 'station', clearR: px.station * 0.42 } });
      expect(L.station).toBeDefined();
      const fight = circMean([...L.placements.values()].map(p => p.theta));
      expect({ ladder, id, far: angGap(L.station!.theta, fight) > Math.PI * 0.75 })
        .toEqual({ ladder, id, far: true });
      expect({ ladder, id, overlaps: L.overlaps }).toEqual({ ladder, id, overlaps: 0 });
    }
  }
});

test('on a full lap the station takes the share farthest from the fronts, and hulls part round it', () => {
  for (const ladder of Object.keys(SIZE_LADDERS) as SizeLadderId[]) {
    const px = SIZE_LADDERS[ladder].px;
    const L = layoutOrbitBattle(buildScenario('swarm', 1, 1, px), MARS,
      { station: { id: 'station', clearR: px.station * 0.42 } });
    expect(['ring', 'deep ring', 'crammed']).toContain(L.mode);
    // The fronts are the gaps between shares; the station is well clear of all.
    const S = L.sectors;
    const fronts = S.map((s, i) => (s.end + (S[i + 1] ?? { start: S[0].start + Math.PI * 2 }).start) / 2);
    for (const f of fronts) expect(angGap(L.station!.theta, f)).toBeGreaterThan(Math.PI / 4);
    expect({ ladder, overlaps: L.overlaps }).toEqual({ ladder, overlaps: 0 });
  }
});

test('the planet-crossing check', () => {
  expect(crossesPlanet(-200, 0, 200, 0, MARS)).toBe(true);
  expect(crossesPlanet(-200, 180, 200, 180, MARS)).toBe(false);
});
