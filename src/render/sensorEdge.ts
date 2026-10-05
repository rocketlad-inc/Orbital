// ------------------------------------------------------------
// The edge of what you can see: the outline of your sensor coverage.
//
// Coverage is a union of circles (every hull, settlement and ally that
// carries sensors). Its edge is the parts of those circles that no other
// circle covers, which this returns as arcs, so the map can draw ONE
// clean line round everything you can see rather than a tangle of
// overlapping rings. Pure: screen-space circles in, arcs out.
// ------------------------------------------------------------

import type { FogHole } from './fogHoles';

export interface EdgeArc {
  x: number;
  y: number;
  r: number;
  /** From a0 to a1, increasing, radians (a1 may exceed 2π). */
  a0: number;
  a1: number;
}

const TAU = Math.PI * 2;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

/**
 * The outline of the union of `circles`, as arcs. Circles inside another
 * contribute nothing; a circle untouched by the rest is one full arc.
 */
export function sensorEdgeArcs(circles: FogHole[]): EdgeArc[] {
  const out: EdgeArc[] = [];
  const n = circles.length;
  for (let i = 0; i < n; i++) {
    const c = circles[i];
    if (!(c.r > 0)) continue;
    // Arcs of this circle that another one covers.
    const covered: Array<[number, number]> = [];
    let swallowed = false;
    for (let j = 0; j < n && !swallowed; j++) {
      if (j === i) continue;
      const o = circles[j];
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d >= c.r + o.r) continue;                     // apart
      if (d + c.r <= o.r) {                             // inside o
        // Identical circles: keep the first, drop the rest.
        if (d < 1e-9 && Math.abs(o.r - c.r) < 1e-9 && j > i) continue;
        swallowed = true;
        break;
      }
      if (d + o.r <= c.r) continue;                     // o inside this
      // The arc of c inside o, centred on the direction to o.
      const mid = Math.atan2(o.y - c.y, o.x - c.x);
      const cos = (c.r * c.r + d * d - o.r * o.r) / (2 * c.r * d);
      const half = Math.acos(Math.max(-1, Math.min(1, cos)));
      covered.push([mid - half, mid + half]);
    }
    if (swallowed) continue;
    if (!covered.length) {
      out.push({ x: c.x, y: c.y, r: c.r, a0: 0, a1: TAU });
      continue;
    }
    // Merge the covered arcs on [0, 2π), then take what is left.
    const bs: Array<[number, number]> = [];
    for (const [a, b] of covered) {
      const len = b - a;
      if (len >= TAU - 1e-9) { bs.length = 0; bs.push([0, TAU]); break; }
      const s = norm(a);
      if (s + len <= TAU) bs.push([s, s + len]);
      else { bs.push([s, TAU]); bs.push([0, s + len - TAU]); }
    }
    bs.sort((p, q) => p[0] - q[0]);
    const free: Array<[number, number]> = [];
    let cur = 0;
    for (const [s, e] of bs) {
      if (e <= cur) continue;
      if (s > cur) free.push([cur, s]);
      cur = Math.max(cur, e);
    }
    if (cur < TAU) free.push([cur, TAU]);
    // An arc running through angle 0 is one arc, not two.
    if (free.length > 1 && free[0][0] === 0 && free[free.length - 1][1] === TAU) {
      const last = free.pop()!;
      free[0] = [last[0], free[0][1] + TAU];
    }
    for (const [a0, a1] of free) {
      if (a1 - a0 > 1e-6) out.push({ x: c.x, y: c.y, r: c.r, a0, a1 });
    }
  }
  return out;
}
