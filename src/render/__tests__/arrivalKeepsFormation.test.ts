/**
 * AN ARRIVING FORMATION KEEPS ITS SHAPE.
 *
 * Studio clip "Select and strike at Europa" (judges, 2026-10-23, 9.2-10.5 s):
 * 11 selected hulls arrived at Europa and showed as ~4. trace.jsonl, f300:
 * st_strike_0/3/9, 2/5/8 and 1/4/10 sat on the same world point to 0.1
 * unit, three hulls to a spot, through the roster dwell, and then glided
 * to their battle slots from that one spot.
 *
 * Cause: a formation in flight is the lead's course plus a fixed offset per
 * slot (placeInFormation), and the course runs into the world's CENTRE.
 * keepOffDrawnDiscs held an arrival off the destination by pushing each
 * hull out on ITS OWN ray from the centre, so by the arrival tick (course
 * at the centre) each hull sat where its offset pointed: slots straight
 * astern of one another, and the arrowhead's parallel diagonals, landed on
 * one point. heldInBattle then holds every arrival exactly where it was
 * last drawn until the world's layout takes it in.
 *
 * Replayed with the real slot table: the stop now holds the COURSE off the
 * disc and carries each hull's slot offset, so the hulls stop as the
 * arrowhead they flew in, every one outside the standoff.
 */
import { keepOffDrawnDiscs, formationSlot } from '../mapRenderer';

const SCALE = 4;                  // px per world unit
const R_PX = 200;                 // the arrival standoff (arrivalStandoffPx)
const DEPTH_PX = 34, ABREAST_PX = 34;
const HULLS = 11;
const centre = () => ({ x: 0, y: 0 });

/** The lead's course: straight in from 700 px below to the world's centre. */
const course = Array.from({ length: 81 }, (_, i) => ({ t: i / 80, x: 0, y: (700 * (80 - i)) / 80 / SCALE }));
/** Course heading (unit, canvas): straight up the screen. */
const tan = { x: 0, y: -1 };

/** Each hull's placed samples: the course plus its arrowhead slot offset,
 *  exactly as placeInFormation lays it. */
function placedFor(slot: number) {
  const { back, side } = formationSlot(slot);
  const along = (-back * DEPTH_PX) / SCALE;
  const across = (side * ABREAST_PX) / 2 / SCALE;
  const dx = tan.x * along + tan.y * across;
  const dy = tan.y * along - tan.x * across;
  return course.map(p => ({ t: p.t, x: p.x + dx, y: p.y + dy }));
}

function stops(withCourse: boolean) {
  return Array.from({ length: HULLS }, (_, slot) => {
    const out = keepOffDrawnDiscs(placedFor(slot), [{ at: centre, R: R_PX / SCALE, isDest: true }],
      withCourse ? course : undefined);
    const last = out[out.length - 1];
    return { x: last.x * SCALE, y: last.y * SCALE };
  });
}

function closestPair(pts: Array<{ x: number; y: number }>): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) best = Math.min(best, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  }
  return best;
}

test('the old per-hull push stacked slots on one point (the bug, measured)', () => {
  expect(closestPair(stops(false))).toBeLessThan(1);
});

test('eleven hulls stop as eleven: the arrowhead they flew in, outside the standoff', () => {
  const pts = stops(true);
  // At least half a slot apart: no two hulls drawn on one spot.
  expect(closestPair(pts)).toBeGreaterThan(Math.min(DEPTH_PX, ABREAST_PX) / 2);
  for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(R_PX - 1e-6);
  // The lead stops on the course side of the world, at the standoff.
  expect(pts[0].x).toBeCloseTo(0, 6);
  expect(pts[0].y).toBeCloseTo(R_PX, 6);
});

test('a lone hull on its own course stops exactly where it did', () => {
  const lone = keepOffDrawnDiscs(course, [{ at: centre, R: R_PX / SCALE, isDest: true }], course);
  const old = keepOffDrawnDiscs(course, [{ at: centre, R: R_PX / SCALE, isDest: true }]);
  expect(lone).toEqual(old);
});
