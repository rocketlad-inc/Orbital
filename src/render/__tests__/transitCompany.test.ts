/**
 * Flying in company (2026-10-21).
 *
 * Lorne, over the Mega Destroyer clip: "ships in transit are overlapping
 * which hurts the look of the in transit battle". An intercept matches its
 * target, so from the meeting on the follower flies the target's own
 * course and was drawn exactly on top of it (a blue destroyer over the red
 * Mega Destroyer, every guard frigate on an escort).
 *
 * Held here: the followers' group stands abreast of the target's group,
 * clear of it, on the side it came in from; it eases over as it closes,
 * so nothing jumps; the target stays on its true line.
 */
import {
  computeTransitFormations, computeTransitCompany, placeInCompany, shipIconSize, COMPANY_GAP,
} from '../mapRenderer';
import type { RenderContext } from '../mapRenderer';
import type { Ship } from '../../types';

// The raid: a straight course heading +x, 1 world unit = 1 px.
const raid = {
  startTick: 10, flipTick: 15, arriveTick: 20, targetBodyId: 'earth',
  startPos: { x: 0, y: 0 }, interceptPos: { x: 1000, y: 0 },
};
const flier = (id: string, cls: string, extra: Partial<Ship> = {}): Ship => ({
  id, class: cls, ownedBy: 'f1',
  transit: { currentTransfer: raid, pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 } },
  ...extra,
} as unknown as Ship);
// A guard that set off from BELOW the course (canvas +y) to match the raid's lead.
const guard = (id: string, cls: string, p0y = 300): Ship => ({
  id, class: cls, ownedBy: 'player',
  transit: { currentTransfer: { ...raid, startTick: 12, startPos: { x: 200, y: p0y } }, pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 } },
  plannedRendezvous: {
    p0: { x: 200, y: p0y }, v0: { x: 0, y: 0 }, accel: 1, A: { x: 0, y: 0 }, B: { x: 0, y: 0 },
    startTick: 12, meetTick: 14, followShipId: 'mega',
  },
} as unknown as Ship);

const ships = [
  flier('mega', 'mega_destroyer'), flier('e1', 'frigate'), flier('e2', 'frigate'),
  guard('g1', 'destroyer'), guard('g2', 'frigate'), guard('g3', 'frigate'),
];
const formations = computeTransitFormations(ships);
const company = computeTransitCompany(ships, formations, []);
const ctxAt = (t: number, scale = 1) =>
  ({ camera: { x: 0, y: 0, scale }, t, bodies: [], transitFormations: formations, transitCompany: company } as unknown as RenderContext);
// Flying the raid's line exactly: where a matched follower is after the meeting.
const onTheLine = [{ t: 10, x: 0, y: 0 }, { t: 20, x: 1000, y: 0 }];
const at = (s: Array<{ t: number; x: number; y: number }>, t: number) => {
  const a = s[0], b = s[s.length - 1];
  const k = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
};

describe('flying in company', () => {
  test('every matched hull is in company with the group it joined; the target is not', () => {
    expect(company.get('g2')?.meetTick).toBe(14);
    expect(company.has('mega')).toBe(false);
    expect(company.has('e1')).toBe(false);
    expect(company.get('g1')).toMatchObject({ slot: 0, count: 3, targetCount: 3 });
    expect(company.get('g1')?.targetIconRest).toBe(shipIconSize('mega_destroyer', false));
  });

  test('once matched, the guard stands abreast of the raid, clear of it', () => {
    const p = at(placeInCompany('g1', onTheLine, ctxAt(16), 1), 16);
    // Level with the raid's lead along the course ...
    expect(p.x).toBeCloseTo(600, 0);
    // ... and off to the side by more than both hulls' half-widths.
    const clear = shipIconSize('mega_destroyer', false) / 2 + shipIconSize('destroyer', false) / 2
      + COMPANY_GAP * shipIconSize('mega_destroyer', false);
    expect(Math.abs(p.y)).toBeGreaterThan(clear);
  });

  test('on the side it came in from, so the two never cross', () => {
    // Came in from +y (below, on canvas): stays below.
    expect(at(placeInCompany('g1', onTheLine, ctxAt(16), 1), 16).y).toBeGreaterThan(0);
    const above = [flier('mega', 'mega_destroyer'), guard('h1', 'destroyer', -300)];
    const c2 = computeTransitCompany(above, computeTransitFormations(above), []);
    const ctx2 = { ...ctxAt(16), transitCompany: c2 } as unknown as RenderContext;
    expect(at(placeInCompany('h1', onTheLine, ctx2, 1), 16).y).toBeLessThan(0);
  });

  test('the guard holds its own arrowhead: escorts behind and beside their lead', () => {
    const lead = at(placeInCompany('g1', onTheLine, ctxAt(16), 1), 16);
    const wing = at(placeInCompany('g2', onTheLine, ctxAt(16), 1), 16);
    expect(wing.x).toBeLessThan(lead.x);
    expect(Math.hypot(wing.x - lead.x, wing.y - lead.y)).toBeGreaterThan(shipIconSize('frigate', false) / 2);
  });

  test('before the meeting it flies its own course, however close it is', () => {
    // Meets at T14. At T12.9 it is still on its own line, even right on
    // top of the raid: at system zoom two fleets are a few px apart long
    // before they meet, and sliding it early drew it off its course.
    expect(placeInCompany('g1', onTheLine, ctxAt(12.9), 1)).toBe(onTheLine);
  });

  test('it falls in over the last tick: part way at T13.5, all the way at the meeting', () => {
    const half = Math.abs(at(placeInCompany('g1', onTheLine, ctxAt(13.5), 1), 13.5).y);
    const full = Math.abs(at(placeInCompany('g1', onTheLine, ctxAt(14), 1), 14).y);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
    expect(Math.abs(at(placeInCompany('g1', onTheLine, ctxAt(16), 1), 16).y)).toBeCloseTo(full, 5);
  });

  test('a hull not on an intercept is never moved', () => {
    expect(placeInCompany('e1', onTheLine, ctxAt(16), 1)).toBe(onTheLine);
  });
});
