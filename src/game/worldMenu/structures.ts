// ============================================================
// THE STRUCTURES ON A WORLD — one under every tag, always.
//
// Lorne, 2026-10-20 ("rework the buildings ... they don't match the new
// look, aren't consistently there, and aren't providing much
// affordance"), picked from the canvas mock: every surface structure has
// a body on the world whatever its state — a silhouette when built, a
// dashed pad when it is an open plot, the same pad padlocked when
// research gates it, scaffold while it builds — standing straight under
// its tag.
//
// Pure numbers shared by the canvas (render/structureArt.ts draws) and
// the DOM overlay (tags, stems and hit areas): how tall each structure
// stands, so a stem ends on its roof and a tag never sits on one.
// Lengths are in STRUCTURE UNITS; one unit is structureUnit(r) screen px
// for a planet of screen radius r, so the art scales with the world.
// ============================================================

export const SURFACE_STRUCTURES = ['forge', 'mint', 'lab', 'shields', 'missile_silo'] as const;
export type SurfaceStructure = typeof SURFACE_STRUCTURES[number];

/** Screen px per structure unit for a planet of screen radius `r`. */
export function structureUnit(r: number): number {
  return r * 0.0026;
}

/** Three silhouettes per structure (Lorne's pick): levels 1-2 draw the
 *  first, 3-5 the second, 6 and up the third. 0 = not built: a plot. */
export function tierOf(level: number): 0 | 1 | 3 | 6 {
  return level >= 6 ? 6 : level >= 3 ? 3 : level >= 1 ? 1 : 0;
}

const HEIGHTS: Record<SurfaceStructure, Record<1 | 3 | 6, number>> = {
  forge: { 1: 30, 3: 53, 6: 81 },
  mint: { 1: 21, 3: 36, 6: 51 },
  lab: { 1: 29, 3: 48, 6: 71 },
  shields: { 1: 28, 3: 42, 6: 58 },
  missile_silo: { 1: 26, 3: 28, 6: 36 },
};
/** A plot's marker (pad + post + plus / padlock). */
export const PLOT_HEIGHT = 24;
/** The crane over a building site. */
export const SITE_HEIGHT = 66;

/** How tall a structure stands, in units: where its stem ends. */
export function structureTop(kind: string, level: number, building: boolean): number {
  if (building) return SITE_HEIGHT;
  const t = tierOf(level);
  if (t === 0) return PLOT_HEIGHT;
  return HEIGHTS[kind as SurfaceStructure]?.[t] ?? 40;
}

/** Half the footprint, in units: how much limb a structure takes. */
export function structureHalfWidth(kind: string, level: number): number {
  const t = tierOf(level);
  if (t === 0) return 21;
  if (kind === 'missile_silo') {
    const perRow = Math.min(15, 5 * Math.max(1, level));
    return (6 + 4.2 * perRow) / 2 + 2;
  }
  return { forge: 26, mint: 24, lab: 26, shields: 22 }[kind] ?? 24;
}
