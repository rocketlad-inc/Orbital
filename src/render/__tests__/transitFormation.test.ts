/**
 * Ships flying one course, in one formation (2026-10-09).
 *
 * Lorne, over a screenshot of Uranus: hulls on a shared course "are
 * overlapping too much, but also we are not showing their true trajectory
 * by offsetting themselves". The old lanes shifted each hull's whole line
 * 13px sideways: the 30-84px sprites still piled up, and a squadron drew a
 * fan of parallel courses, none of them the real one.
 *
 * Held here: one line (the lead's, on the true course), every hull in an
 * arrowhead round the true position, pointed along travel, with room
 * between the sprites.
 */
import {
  computeTransitFormations, formationSlot, formationSpacingPx, placeInFormation,
  courseDrawnByLead, shipIconSize, FORMATION_MIN_SQUEEZE, FORMATION_ROW_DEPTH,
} from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import type { Ship } from '../../types';

const course = (start = 10, target = 'mars', over: Record<string, unknown> = {}) => ({
  startTick: start, flipTick: start + 5, arriveTick: start + 10, targetBodyId: target,
  startPos: { x: 0, y: 0 }, interceptPos: { x: 1000, y: 0 },
  ...over,
});
const ship = (id: string, cls: string, c = course(), extra: Partial<Ship> = {}): Ship => ({
  id, class: cls, ownedBy: 'player',
  transit: { currentTransfer: c, pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 } },
  ...extra,
} as unknown as Ship);

// A straight course heading +x on screen, 1 world unit = 1 px.
const samples = [{ t: 10, x: 0, y: 0 }, { t: 20, x: 1000, y: 0 }];
const ctxFor = (f: ReturnType<typeof computeTransitFormations>, scale = 1) =>
  ({ camera: { x: 0, y: 0, scale }, t: 15, transitFormations: f } as unknown as RenderContext);
const at = (s: Array<{ t: number; x: number; y: number }>) => {
  // Linear lerp at t=15: halfway.
  const a = s[0], b = s[s.length - 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

describe('who flies together', () => {
  test('hulls on the same course share a formation; a lone hull does not', () => {
    const f = computeTransitFormations([
      ship('a', 'frigate'), ship('b', 'frigate'), ship('c', 'frigate', course(11)),
    ]);
    expect(f.get('a')?.count).toBe(2);
    expect(f.get('b')?.count).toBe(2);
    expect(f.has('c')).toBe(false);
  });

  test('the biggest hull leads, and the order is stable', () => {
    const ships = [ship('z', 'corvette'), ship('m', 'destroyer'), ship('a', 'corvette')];
    const f = computeTransitFormations(ships);
    expect(f.get('m')?.slot).toBe(0);
    expect(f.get('a')?.slot).toBe(1);
    expect(f.get('z')?.slot).toBe(2);
    expect(computeTransitFormations([...ships].reverse()).get('m')?.slot).toBe(0);
    expect(f.get('a')?.iconRest).toBe(shipIconSize('destroyer', false));
  });

  test('one course, though each hull left its own point on the orbit', () => {
    // Prod, the Terran expedition to Mars (T400 -> T424): ten hulls, flip
    // ticks 411.84675 .. 411.84875, start points up to 2.4 units apart.
    // The old lanes keyed on the exact flip tick and grouped none of them.
    const ships = [
      ['e0', 411.84733375177484, -689.575, 1308.659],
      ['e1', 411.8474602369961, -689.409, 1308.805],
      ['e6', 411.8467478566213, -690.64, 1307.873],
      ['e9', 411.84875444082985, -688.22, 1310.109],
    ].map(([id, flip, x, y]) => ship(id as string, 'destroyer', course(400, 'mars', {
      flipTick: flip, arriveTick: 424, startPos: { x, y }, interceptPos: { x: -1500, y: 2900 },
    })));
    const f = computeTransitFormations(ships);
    expect(f.size).toBe(4);
    expect(new Set([...f.values()].map(v => v.key)).size).toBe(1);
  });

  test('hulls from DIFFERENT worlds on the same tick to the same target do not merge', () => {
    const f = computeTransitFormations([
      ship('a', 'frigate', course(10, 'jupiter', { startPos: { x: 0, y: 0 } })),
      ship('b', 'frigate', course(10, 'jupiter', { startPos: { x: 0, y: 0 } })),
      ship('c', 'frigate', course(10, 'jupiter', { startPos: { x: 400, y: 300 } })),
    ]);
    expect(f.get('a')?.count).toBe(2);
    expect(f.has('c')).toBe(false);
  });

  test('a hull flying a rendezvous is not in the formation', () => {
    const f = computeTransitFormations([
      ship('a', 'frigate'), ship('b', 'frigate', course(), { plannedRendezvous: {} } as Partial<Ship>),
    ]);
    expect(f.size).toBe(0);
  });
});

describe('the arrowhead', () => {
  test('every slot is its own place, the lead on the line', () => {
    expect(formationSlot(0)).toEqual({ back: 0, side: 0 });
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const p = formationSlot(i);
      const k = `${p.back}:${p.side}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      expect(Math.abs(p.side)).toBeLessThanOrEqual(p.back);
    }
  });

  test('full rows sit balanced about the line', () => {
    for (const n of [3, 6, 10, 15]) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += formationSlot(i).side;
      expect(sum).toBe(0);
    }
  });
});

describe('placing the hulls', () => {
  test('the lead stays exactly on its course; the line belongs to it', () => {
    const f = computeTransitFormations([ship('a', 'frigate'), ship('b', 'frigate'), ship('c', 'frigate')]);
    const ctx = ctxFor(f);
    expect(placeInFormation('a', samples, ctx, 1)).toBe(samples);
    expect(courseDrawnByLead(ctx, 'a')).toBe(false);
    expect(courseDrawnByLead(ctx, 'b')).toBe(true);
    expect(courseDrawnByLead(ctx, 'lonely')).toBe(false);
    expect(courseDrawnByLead(ctx, undefined)).toBe(false);
  });

  test('followers fall in BEHIND the lead, either side of the line', () => {
    const f = computeTransitFormations([ship('a', 'frigate'), ship('b', 'frigate'), ship('c', 'frigate')]);
    const ctx = ctxFor(f);
    const lead = at(placeInFormation('a', samples, ctx, 1));
    const b = at(placeInFormation('b', samples, ctx, 1));
    const c = at(placeInFormation('c', samples, ctx, 1));
    expect(b.x).toBeLessThan(lead.x);
    expect(c.x).toBeLessThan(lead.x);
    expect(Math.sign(b.y)).toBe(-Math.sign(c.y));
    expect(b.y + c.y).toBeCloseTo(0);
  });

  test('the formation turns with the course', () => {
    const f = computeTransitFormations([ship('a', 'frigate'), ship('b', 'frigate')]);
    const down = [{ t: 10, x: 0, y: 0 }, { t: 20, x: 0, y: 1000 }];
    const b = at(placeInFormation('b', down, ctxFor(f), 1));
    expect(b.y).toBeLessThan(500);           // behind, travelling +y
  });

  test('no two sprites overlap, at every size a real course reached', () => {
    // Prod, 2026-10-09: shared courses of 2 to 25 hulls.
    for (const n of [2, 3, 5, 9, 12, 17, 25]) {
      for (const cls of ['corvette', 'frigate', 'destroyer']) {
        const ships = Array.from({ length: n }, (_, i) => ship(`s${String(i).padStart(2, '0')}`, cls));
        const f = computeTransitFormations(ships);
        const ctx = ctxFor(f);
        const pts = ships.map(s => at(placeInFormation(s.id, samples, ctx, 1)));
        const hull = shipIconSize(cls, false);
        let min = Infinity;
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
          }
        }
        // Never closer than the most-squeezed row depth.
        expect(min).toBeGreaterThanOrEqual(hull * FORMATION_ROW_DEPTH * FORMATION_MIN_SQUEEZE - 1e-6);
      }
    }
  });

  test('spacing is in screen pixels: the same at every zoom', () => {
    const f = computeTransitFormations([ship('a', 'frigate'), ship('b', 'frigate')]);
    for (const scale of [0.05, 1, 8]) {
      const ctx = ctxFor(f, scale);
      const lead = at(placeInFormation('a', samples, ctx, 1));
      const b = at(placeInFormation('b', samples, ctx, 1));
      const px = Math.hypot(lead.x - b.x, lead.y - b.y) * scale;
      expect(px).toBeCloseTo(Math.hypot(formationSpacingPx(f.get('b')!, 1).depth, formationSpacingPx(f.get('b')!, 1).abreast / 2));
    }
  });

  test('the shared course is never modified (it is the per-plan cache)', () => {
    const f = computeTransitFormations([ship('a', 'frigate'), ship('b', 'frigate')]);
    const before = JSON.stringify(samples);
    placeInFormation('b', samples, ctxFor(f), 1);
    expect(JSON.stringify(samples)).toBe(before);
  });
});
