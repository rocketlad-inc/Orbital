// THE SENSOR EDGE IS THE OUTLINE OF WHAT YOU CAN SEE, AND ONLY THAT.
//
// sensorEdgeArcs turns a union of sensor circles into the arcs of its
// outline. Every point it returns must sit on the edge (inside no other
// circle), and every edge point must be returned (no gaps in the line).

import { sensorEdgeArcs, sensorEdgeLoops } from '../sensorEdge';
import type { FogHole } from '../fogHoles';

const TAU = Math.PI * 2;

function rng(seed: number) {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const insideOther = (cs: FogHole[], i: number, x: number, y: number) =>
  cs.some((o, j) => j !== i && (x - o.x) ** 2 + (y - o.y) ** 2 < (o.r - 1e-6) ** 2);

describe('sensor edge', () => {
  it('a lone circle is one full ring', () => {
    expect(sensorEdgeArcs([{ x: 0, y: 0, r: 10 }])).toEqual([{ x: 0, y: 0, r: 10, a0: 0, a1: TAU }]);
  });

  it('a circle inside another adds nothing; duplicates draw once', () => {
    const a = sensorEdgeArcs([{ x: 0, y: 0, r: 100 }, { x: 10, y: 0, r: 20 }]);
    expect(a).toHaveLength(1);
    expect(a[0].r).toBe(100);
    const d = sensorEdgeArcs([{ x: 5, y: 5, r: 30 }, { x: 5, y: 5, r: 30 }]);
    expect(d).toHaveLength(1);
  });

  it('two overlapping circles: each loses the arc inside the other', () => {
    const arcs = sensorEdgeArcs([{ x: 0, y: 0, r: 10 }, { x: 12, y: 0, r: 10 }]);
    expect(arcs).toHaveLength(2);
    // The left circle's arc faces left, away from the right one.
    const left = arcs.find(a => a.x === 0)!;
    const midA = (left.a0 + left.a1) / 2;
    expect(Math.cos(midA)).toBeLessThan(-0.99);
  });

  it('every returned point is on the edge, and every edge point is returned', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const cs: FogHole[] = [];
      const n = 2 + Math.floor(r() * 12);
      for (let i = 0; i < n; i++) cs.push({ x: r() * 400, y: r() * 300, r: 15 + r() * 120 });
      const arcs = sensorEdgeArcs(cs);
      // Sampled points on the arcs lie inside no other circle.
      for (const a of arcs) {
        const i = cs.findIndex(c => c.x === a.x && c.y === a.y && c.r === a.r);
        for (let k = 1; k < 20; k++) {
          const t = a.a0 + ((a.a1 - a.a0) * k) / 20;
          expect(insideOther(cs, i, a.x + Math.cos(t) * a.r, a.y + Math.sin(t) * a.r)).toBe(false);
        }
      }
      // And a point on any circle that is inside no other lies on an arc.
      for (let i = 0; i < cs.length; i++) {
        for (let k = 0; k < 24; k++) {
          const t = (TAU * (k + 0.5)) / 24;
          const x = cs[i].x + Math.cos(t) * cs[i].r, y = cs[i].y + Math.sin(t) * cs[i].r;
          if (insideOther(cs, i, x, y)) continue;
          const on = arcs.some(a => Math.abs(Math.hypot(x - a.x, y - a.y) - a.r) < 1e-6 && (() => {
            let ang = Math.atan2(y - a.y, x - a.x);
            while (ang < a.a0) ang += TAU;
            return ang <= a.a1 + 1e-9;
          })());
          // Points exactly on another circle's rim are ambiguous; skip those.
          const onRim = cs.some((o, j) => j !== i && Math.abs(Math.hypot(x - o.x, y - o.y) - o.r) < 1e-6);
          if (!onRim) expect(on).toBe(true);
        }
      }
    }
  });

  it('the outline chains into closed loops that use every arc once', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 13);
      const cs: FogHole[] = [];
      const n = 2 + Math.floor(r() * 14);
      for (let i = 0; i < n; i++) cs.push({ x: r() * 400, y: r() * 300, r: 15 + r() * 120 });
      const arcs = sensorEdgeArcs(cs);
      const loops = sensorEdgeLoops(arcs);
      expect(loops.reduce((t, l) => t + l.length, 0)).toBe(arcs.length);
      for (const loop of loops) {
        const ends = loop.map(a => [a.x + Math.cos(a.a1) * a.r, a.y + Math.sin(a.a1) * a.r]);
        const starts = loop.map(a => [a.x + Math.cos(a.a0) * a.r, a.y + Math.sin(a.a0) * a.r]);
        for (let k = 0; k < loop.length; k++) {
          const nx = starts[(k + 1) % loop.length];
          expect(Math.hypot(ends[k][0] - nx[0], ends[k][1] - nx[1])).toBeLessThan(0.75);
        }
      }
    }
  });
});
