// ============================================================
// THE WELL — Cygnus X-1 slows everything that flies near it.
//
// Client copy of worker/wellDilation.js; the rationale lives there.
// A leg's trip time is multiplied by legDilation(), which the planner
// applies as 1/f^2 on its accelerations so the committed plan is still
// a real burn. KEEP IN SYNC (src/physics/__tests__/wellDilation.test.ts
// runs both on the same legs).
// ============================================================

export interface Point { x: number; y: number }

export const WELL_REF = 1000;
export const WELL_RADIUS = 10000;
export const WELL_MAX = 3;

/** The slowdown at distance d from the hole, 1..WELL_MAX. */
export function wellDepthAt(d: number): number {
  const dist = Math.max(1, Number(d) || 0);
  if (dist >= WELL_RADIUS) return 1;
  return Math.min(WELL_MAX, 1 + WELL_REF / dist - WELL_REF / WELL_RADIUS);
}

/** How much slower a straight leg from a to b flies; 1 = unaffected. */
export function legDilation(a: Point, b: Point, wells: Point[]): number {
  if (!wells || wells.length === 0) return 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  let worst = 1;
  for (const w of wells) {
    let t = len2 > 0 ? ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t - w.x, cy = a.y + dy * t - w.y;
    const dmin = Math.sqrt(cx * cx + cy * cy);
    const depth = wellDepthAt(dmin);
    if (depth <= 1) continue;
    let share = 1;
    if (len > 0) {
      const half = Math.sqrt(Math.max(0, WELL_RADIUS * WELL_RADIUS - dmin * dmin));
      const along = t * len;
      const lo = Math.max(0, along - half), hi = Math.min(len, along + half);
      share = Math.max(0, hi - lo) / len;
    }
    worst = Math.max(worst, 1 + (depth - 1) * share);
  }
  return worst;
}
