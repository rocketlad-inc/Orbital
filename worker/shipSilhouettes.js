// ---------------------------------------------------------------------
// SHIP SILHOUETTES, FOR THE HAND-ROLLED PNGs
//
// The battle card draws one hull per ship, and it draws the SAME hull
// the game draws. These are the hull paths out of src/components/
// ShipIcons.tsx -- the A variant of each class -- transcribed as
// polygons in the icon's own 32x32 box.
//
// WHY TRANSCRIBED AND NOT IMPORTED. The icons are React components
// returning SVG, and the Worker has no DOM, no SVG rasteriser and no
// business importing a .tsx. What crosses the boundary is the one thing
// that matters, the OUTLINE, in a form a scanline filler can take.
//
// WHY ONLY THE HULL. Each icon is a hull plus detail strokes -- canopy,
// engine flares, cargo blocks. At the size a widget row allows, roughly
// sixteen pixels, every one of those details is sub-pixel and turns a
// recognisable ship into grey mush. The silhouette is the part that
// still reads, which is also why the game's own convention makes the
// first child the hull and treats the rest as accents.
//
// IF AN ICON IS REDRAWN IN ShipIcons.tsx, this does not follow. That is
// a real cost and an accepted one: the alternative is a rasteriser in
// the Worker. A silhouette that is a class out of date still says
// "destroyer", which is the entire job it has here.
// ---------------------------------------------------------------------

/** The box the paths below are expressed in, matching the icons. */
export const ICON_BOX = 32;

/**
 * Hull outlines, nose to the RIGHT, as flat [x0,y0, x1,y1, ...] lists.
 *
 * Curves in the originals are flattened: the colony hull's quadratics
 * become a few straight segments, which at sixteen pixels is a
 * difference nobody can see and a great deal less code to be wrong.
 */
export const HULLS = {
  // CorvetteA — long pointed wedge.
  corvette: [4, 13, 20, 13, 28, 16, 20, 19, 4, 19],

  // FrigateA — swept wedge with a taller aft.
  frigate: [4, 14, 22, 12, 28, 16, 22, 20, 4, 18],

  // DestroyerA — hexagonal slab, the heaviest outline in the set.
  destroyer: [8, 10, 24, 10, 30, 16, 24, 22, 8, 22, 2, 16],

  // FreighterA — the cargo blocks ARE the silhouette here; the command
  // pod alone is a stub nobody would recognise. One boxy hull spanning
  // the containers, with the pod on the nose.
  freighter: [8, 9, 20, 9, 20, 13, 26, 13, 28, 16, 26, 19, 20, 19, 20, 23, 8, 23],

  // ColonyA — rounded ark, quadratics flattened to chamfers.
  colony: [6, 13, 22, 13, 27, 14, 29, 16, 27, 18, 22, 19, 6, 19, 4, 17, 4, 15],
};

/**
 * The game's own class mapping, from ShipIcons.iconClassFor: a mega
 * destroyer is drawn as a destroyer and a mobile foundry as a
 * freighter, and anything unrecognised falls back to a corvette rather
 * than to nothing.
 */
export function silhouetteFor(shipClass) {
  const c = String(shipClass || '').toLowerCase();
  if (c === 'mega_destroyer') return HULLS.destroyer;
  if (c === 'mobile_foundry') return HULLS.freighter;
  return HULLS[c] || HULLS.corvette;
}

/** Each outline own extent, measured once. */
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
const BOXES = new Map();
function boxOf(pts) {
  let b = BOXES.get(pts);
  if (!b) { b = bbox(pts); BOXES.set(pts, b); }
  return b;
}

/**
 * The height is exaggerated by this much relative to the width.
 *
 * THE ICONS ARE WIDE AND THIN. A corvette occupies a band six units
 * tall in a thirty-two unit box, and the game gets away with that
 * because it draws a stroke round the hull and shades it. A plain fill
 * has neither, so at widget size the same outline is a hairline -- the
 * first render of this card drew every ship as a dash. Stretching the
 * height keeps the class readable, and at sixteen pixels recognisable
 * beats faithful.
 */
const Y_BOOST = 1.5;

/**
 * Place a hull: fit the outline OWN WIDTH to `width` pixels, centred on
 * (cx, cy), and return a fresh point list ready for fillPoly.
 *
 * FITTED TO ITS OWN EXTENT, not to the 32-unit icon box. Scaling the
 * whole box would shrink every hull by however much empty margin its
 * icon happens to have, so a destroyer and a corvette would come out
 * different sizes for no reason a player could read. Fitting each to
 * its own outline makes the width uniform and lets the one real
 * difference between classes -- their SHAPE -- carry all the meaning:
 * darts are corvettes, slabs are destroyers, blocks are freighters.
 */
export function placeHull(shipClass, cx, cy, width) {
  const src = silhouetteFor(shipClass);
  const b = boxOf(src);
  const k = width / (b.w || 1);
  const ky = k * Y_BOOST;
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i += 2) {
    out[i] = cx + (src[i] - b.cx) * k;
    out[i + 1] = cy + (src[i + 1] - b.cy) * ky;
  }
  return out;
}

/** How tall a hull of this class comes out at a given width, so a row
 *  can be laid out without clipping the chunkiest ship in it. */
export function hullHeight(shipClass, width) {
  const b = boxOf(silhouetteFor(shipClass));
  return (b.h / (b.w || 1)) * width * Y_BOOST;
}
