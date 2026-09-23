// ============================================================
// Which sensor circles the fog pass actually has to cut.
//
// The fog is a dark layer with one hole punched per friendly sensor
// source, every frame. That was every ship and settlement, unfiltered:
// at strategic zoom a sensor circle can be larger than the screen, so a
// 223-hull empire paid for up to 223 full-screen fills per frame, and a
// fleet sitting on one point stacked dozens of identical circles. The
// Wu Tang Clan's client spent 50ms (p95 368ms) per frame here
// (perf_heartbeats phases, 2026-09-23) while players whose hulls were
// spread out paid 0.3ms.
//
// Pure, so it can be tested without a canvas. Drops, in order:
//   - circles that miss the viewport,
//   - duplicates (same centre and radius to the pixel),
//   - circles inside a larger kept circle.
// And reports when one circle covers the whole viewport: then there is no
// fog to draw at all.
// ============================================================

export interface FogHole { x: number; y: number; r: number }

export function visibleFogHoles(
  holes: FogHole[],
  w: number,
  h: number,
): { holes: FogHole[]; coversAll: boolean } {
  const cand: FogHole[] = [];
  const seen = new Set<string>();
  for (const c of holes) {
    if (!(c.r >= 0.5)) continue;                          // too small (or NaN)
    if (c.x + c.r < 0 || c.x - c.r > w || c.y + c.r < 0 || c.y - c.r > h) continue;
    // Covers every corner -> the whole viewport is in sensor range.
    const inside = (px: number, py: number) => (px - c.x) ** 2 + (py - c.y) ** 2 <= c.r * c.r;
    if (inside(0, 0) && inside(w, 0) && inside(0, h) && inside(w, h)) {
      return { holes: [], coversAll: true };
    }
    const key = `${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.r)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cand.push(c);
  }
  // Largest first, so a circle is only ever tested against bigger ones.
  cand.sort((a, b) => b.r - a.r);
  const kept: FogHole[] = [];
  for (const c of cand) {
    let contained = false;
    for (const k of kept) {
      if (Math.hypot(c.x - k.x, c.y - k.y) + c.r <= k.r) { contained = true; break; }
    }
    if (!contained) kept.push(c);
  }
  return { holes: kept, coversAll: false };
}
