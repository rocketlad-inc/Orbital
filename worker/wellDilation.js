// ============================================================
// THE WELL — Cygnus X-1 slows everything that flies near it.
//
// Lorne, 2026-10-06: "the closer to the black hole you get, the longer
// transit takes". Gravitational time dilation, played straight: a leg
// that passes deep in the well takes longer, in proportion to how deep
// it goes and how much of the leg is spent there.
//
//   depth   1 + REF/d - REF/RADIUS at the leg's closest approach d,
//           capped at MAX. About x1.9 at Requiem's orbit, x1.4 at
//           Vellichor's, x1.2 at Echelon's, x1.1 at Reliquary's, and
//           nothing past RADIUS.
//   share   only the part of the leg inside RADIUS is slowed, so the
//           long crossing from Sol pays for the last few thousand units,
//           not the whole two hundred thousand.
//
// It is applied as the ENGINE the well leaves you, not as a delay: a
// factor f on the trip time is a 1/f^2 on the acceleration, so the
// flight plan stays a real burn that transit combat, the renderer and
// every client fly exactly as committed. The ship visibly crawls.
//
// KEEP IN SYNC with src/physics/wellDilation.ts (wellDilation.test).
// ============================================================

/** Distance at which the well doubles trip time, near enough (live units:
 *  Requiem orbits at 1000 since FAR_LOCAL_SCALE opened Cygnus up). */
export const WELL_REF = 1000;
/** Past this, the well has no effect. */
export const WELL_RADIUS = 10000;
/** However deep you go, at most this much slower. */
export const WELL_MAX = 3;

/** The slowdown at distance d from the hole, 1..WELL_MAX. */
export function wellDepthAt(d) {
  const dist = Math.max(1, Number(d) || 0);
  if (dist >= WELL_RADIUS) return 1;
  return Math.min(WELL_MAX, 1 + WELL_REF / dist - WELL_REF / WELL_RADIUS);
}

/**
 * How much slower a straight leg from `a` to `b` flies for the wells at
 * `wells` (each {x, y}). 1 means unaffected. The strongest well wins;
 * there is one black hole on the map.
 */
export function legDilation(a, b, wells) {
  if (!wells || wells.length === 0) return 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  let worst = 1;
  for (const w of wells) {
    // Closest approach of the segment to the hole.
    let t = len2 > 0 ? ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t - w.x, cy = a.y + dy * t - w.y;
    const dmin = Math.sqrt(cx * cx + cy * cy);
    const depth = wellDepthAt(dmin);
    if (depth <= 1) continue;
    // Share of the leg inside the well's radius.
    let share = 1;
    if (len > 0) {
      const half = Math.sqrt(Math.max(0, WELL_RADIUS * WELL_RADIUS - dmin * dmin));
      const along = t * len;                       // closest point, along the leg
      const lo = Math.max(0, along - half), hi = Math.min(len, along + half);
      share = Math.max(0, hi - lo) / len;
    }
    worst = Math.max(worst, 1 + (depth - 1) * share);
  }
  return worst;
}
