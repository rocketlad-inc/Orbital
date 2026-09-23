// [pure] The fog pass cuts only the sensor circles that change the picture.
//
// 2026-09-23: The Wu Tang Clan's client spent 50ms (p95 368ms) per frame
// painting fog, one full circle per friendly ship, most of them
// screen-sized and stacked on the same point. See fogHoles.ts.

import { visibleFogHoles } from '../fogHoles';

const W = 1920, H = 1080;

describe('[pure] visibleFogHoles', () => {
  it('a 64-hull fleet on one point is one hole, not 64', () => {
    const fleet = Array.from({ length: 64 }, () => ({ x: 900.2, y: 500.4, r: 300 }));
    expect(visibleFogHoles(fleet, W, H).holes).toHaveLength(1);
  });

  it('a circle covering the whole view means no fog to draw at all', () => {
    const r = visibleFogHoles([{ x: 960, y: 540, r: 5000 }, { x: 10, y: 10, r: 20 }], W, H);
    expect(r.coversAll).toBe(true);
    expect(r.holes).toHaveLength(0);
  });

  it('drops circles entirely off screen', () => {
    const r = visibleFogHoles([{ x: -500, y: 500, r: 100 }, { x: 500, y: 5000, r: 100 }, { x: 500, y: 500, r: 100 }], W, H);
    expect(r.holes).toEqual([{ x: 500, y: 500, r: 100 }]);
  });

  it('keeps a circle that pokes into the view from off screen', () => {
    expect(visibleFogHoles([{ x: -50, y: 500, r: 100 }], W, H).holes).toHaveLength(1);
  });

  it('drops a circle nested inside a larger one, keeps overlapping ones', () => {
    const r = visibleFogHoles([
      { x: 500, y: 500, r: 50 },    // inside the big one
      { x: 520, y: 500, r: 400 },   // big
      { x: 1300, y: 500, r: 200 },  // overlaps the big one's edge, not inside
    ], W, H);
    expect(r.holes.map(h => h.r).sort((a, b) => a - b)).toEqual([200, 400]);
  });

  it('223 scattered screen-sized circles collapse to the few that matter', () => {
    const many = Array.from({ length: 223 }, (_, i) => ({ x: 900 + (i % 5), y: 500 + (i % 3), r: 900 - (i % 7) }));
    const r = visibleFogHoles(many, W, H);
    expect(r.holes.length).toBeLessThanOrEqual(20);   // 223 -> 15 measured
  });
});
