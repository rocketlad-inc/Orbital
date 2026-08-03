// ============================================================================
// lod.ts — THE ZOOM CONTRACT
//
// Every visual feature used to own its own visibility threshold, tuned in
// isolation: THRUST_FADE_LO/HI, SHIP_DRESSING_MIN_SCALE, the political
// wash's FadeBand, `camera.scale > 0.4` for body labels, MOON_ORBIT_MIN_
// PARENT_PX for rings and sprites. Each was reasonable alone; together
// they produced bands where five things faded at five different moments
// and nothing agreed about what "zoomed out" means.
//
// This file is the single table. A feature asks `lodAlpha(scale, FEATURE)`
// and gets 0..1 — 0 = don't draw, 1 = full, in between = crossfading.
// Changing when something appears is a one-line edit here, and the bands
// stay legible relative to each other because they're written together.
//
// ---------------------------------------------------------------------------
// THE FIVE BANDS (camera.scale)
//
//   L0  STRATEGIC     < 0.35    whole system; a chart, not a scene
//   L1  REGIONAL      0.35–1.2  inner system; political territory reads
//   L2  APPROACH      1.2–3     multi-body; interception decisions
//   L3  NEIGHBOURHOOD 3–12      one body + its traffic
//   L4  DEEP          > 12      moon rings, individual hulls, formations
//
// CAVEAT (load-bearing): camera.scale is NOT invariant across games —
// SYSTEM_SCALE=2 doubled heliocentric orbits for new games while games in
// progress kept the old geometry, so the same scale frames differently in
// each. Anything that must be exact about on-screen SIZE (sprite/ring
// handoff) keeps using measured pixels — see parentPx helpers in
// MapCanvas. This table governs everything where "roughly this zoomed in"
// is the honest requirement, which is all text and all decoration.
// ============================================================================

export const BAND = {
  L0_STRATEGIC: 0.35,
  L1_REGIONAL: 1.2,
  L2_APPROACH: 3,
  L3_NEIGHBOURHOOD: 12,
} as const;

/** [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd] in camera.scale.
 *  Infinity = never fades out. A feature is fully visible between
 *  fadeInEnd and fadeOutStart. */
type Band = readonly [number, number, number, number];

export const LOD: Record<string, Band> = {
  // ---- text -------------------------------------------------------------
  /** Major bodies: named at every zoom — they're the map's skeleton. */
  BODY_LABEL_MAJOR: [0, 0, Infinity, Infinity],
  /** Minor bodies (moons, rocks): only once their neighbourhood opens.
   *  At L0 these were half the text on screen and none of it actionable. */
  BODY_LABEL_MINOR: [0.5, 0.9, Infinity, Infinity],
  /** The `2M 4C 35` yield line. Actionable only when you can act on the
   *  body — at L0 it doubled the glyph count for no decision. */
  BODY_RESOURCES: [1.0, 1.6, Infinity, Infinity],
  /** System/region titles ("JUPITER SYSTEM"). Fade OUT once individual
   *  bodies are named, or the two label sets fight for the same pixels. */
  REGION_LABEL: [0.28, 0.5, 4, 7],
  /** Owner sub-line under a region title. Drops earlier than the title:
   *  two lines per region is what overprinted planets at L1. */
  REGION_SUB: [0.34, 0.6, 2.5, 4],

  // ---- decoration -------------------------------------------------------
  /** Political wash. Territorial read at a glance — and it turns out
   *  that read stays valuable much further in than the first cut
   *  assumed (Lorne, after seeing it retire at L2). It now survives the
   *  whole approach band and most of the neighbourhood band, only
   *  dissolving INSIDE the deep band — territory stays legible even once
   *  moon rings are on screen, and only lets go when the frame is a
   *  single planet's traffic. Text still wins contrast: labels draw
   *  last, over the wash. */
  //  NO fade-IN here. Adding one (0.2->0.45, my first cut) was a
  //  regression: the fully-zoomed-out strategic view sits near scale
  //  0.19, so that band silently erased the wash at precisely the zoom
  //  its territorial read matters most. The zoomed-out side is already
  //  governed by systemRegionOpacityFor()'s spans test, which — unlike a
  //  raw camera.scale threshold — is invariant to SYSTEM_SCALE. This
  //  entry now only governs the deep-zoom fade-OUT; the wash is visible
  //  everywhere else.
  POLITICAL_WASH: [0, 0, 10, 20],
  /** Torch plumes: pure decoration below L2. */
  THRUST_PLUME: [1.2, 2.5, Infinity, Infinity],
  /** Per-hull dressing (rank chevrons, wakes, trim). */
  SHIP_DRESSING: [1.2, 1.8, Infinity, Infinity],
  /** Orbit ellipses for heliocentric bodies. */
  ORBIT_LINES: [0.25, 0.5, Infinity, Infinity],
} as const;

/** 0..1 visibility for a feature at the current camera scale. */
export function lodAlpha(scale: number, band: Band): number {
  const [inA, inB, outA, outB] = band;
  if (scale <= inA) return 0;
  if (scale >= outB) return 0;
  let a = 1;
  if (scale < inB) a = (scale - inA) / Math.max(1e-6, inB - inA);
  if (scale > outA && outB !== Infinity) {
    a = Math.min(a, 1 - (scale - outA) / Math.max(1e-6, outB - outA));
  }
  return Math.max(0, Math.min(1, a));
}

export function bandOf(scale: number): 'L0' | 'L1' | 'L2' | 'L3' | 'L4' {
  if (scale < BAND.L0_STRATEGIC) return 'L0';
  if (scale < BAND.L1_REGIONAL) return 'L1';
  if (scale < BAND.L2_APPROACH) return 'L2';
  if (scale < BAND.L3_NEIGHBOURHOOD) return 'L3';
  return 'L4';
}

/** Ink budget: the maximum number of text labels allowed on screen at
 *  once, by band. This is the mechanism that makes density IMPOSSIBLE
 *  rather than merely unlikely — the solver drops the lowest-priority
 *  overflow instead of drawing everything and hoping it fits. L0 is
 *  tightest because that view had 40+ labels colliding into mush. */
export function labelBudget(scale: number): number {
  switch (bandOf(scale)) {
    case 'L0': return 14;
    case 'L1': return 22;
    case 'L2': return 28;
    default:   return 40;
  }
}
