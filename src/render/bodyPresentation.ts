// ============================================================
// How big a world LOOKS, and whether it can be told apart from the
// world it orbits — the one zoom rule every map layer answers to.
//
// THE PROBLEM (Lorne, 2026-09-26): "Planets and moons are so small for
// 99% of the zoom that you can't see them, despite vast usable space on
// the screen", and "the number icons are giving way to individual ships
// before we've zoomed enough to see planets". Worlds drew at true scale
// with a 3px floor, so Earth was a 3px dot for the first third of the
// zoom range and under 12px for more than half of it. Meanwhile parked
// hulls broke out of their count badge when the MOON SYSTEM spanned 80px
// (systemOpenness), which on a moon_scale-8 map happens while the planet
// itself is still a dot: a ring of 17-38px hulls around nothing.
//
// THREE ANSWERS, all measured on screen:
//
//   DRAWN RADIUS. A world never draws smaller than a floor for its class
//   (star 16, giant 12, rocky planet 9, dwarf 6, moon 5 px), blended into
//   true size with a p-norm so there is no kink: far out it is the floor,
//   close in it is exactly true scale, which the world menu's surface
//   view needs (it frames the TRUE radius).
//
//   FOLDING. A world whose drawn disc would touch the disc of the world
//   it orbits is not drawn: it folds into that parent, and its ship
//   count and its clicks go to the parent. Moons fold into their planet
//   until the moon system has room; the innermost planets fold into the
//   Sun at full zoom-out. That is what keeps the floors from piling up.
//
//   HULL REVEAL. Ships parked at a world stay a count badge until THAT
//   world is big enough on screen to orbit — its own true radius, never
//   its moon system's reach. A star keeps its own rule (its disc against
//   80px, Lorne 2026-09-23), since hulls park far out around it.
// ============================================================

import type { Body } from '../types';

/** A floor for each class, in canvas px. Order matters for the reading:
 *  a star is always the biggest thing in its system, a moon the smallest. */
export const DISPLAY_FLOOR_PX = {
  star: 16,
  giant: 12,
  planet: 9,
  dwarf: 6,
  moon: 5,
  minor: 4,
} as const;

/**
 * THE FLOOR GROWS AS YOU ZOOM IN. A fixed floor held Earth at the same 9px
 * across a 500x zoom (0.003 to 1.5) -- zooming in did nothing to the world
 * you were zooming toward, so the zoom never felt continuous. The floor is
 * multiplied by how much of the system fills the screen, raised to a small
 * power, so every notch grows the worlds a little until true size takes
 * over. Measured in SCREEN terms (the outermost giant's orbit against half
 * the viewport), not camera.scale, so a system_scale 2 map and a 4 map
 * behave the same. Clamped: never under 0.6x (the whole map fits), never
 * over 3x (a small rock must not balloon at close zoom).
 */
export const FLOOR_GROWTH_GAMMA = 0.35;
export const FLOOR_GROWTH_MIN = 0.6;
export const FLOOR_GROWTH_MAX = 3;

export function floorGrowth(systemSpan: number): number {
  if (!(systemSpan > 0)) return 1;
  return Math.max(FLOOR_GROWTH_MIN, Math.min(FLOOR_GROWTH_MAX, systemSpan ** FLOOR_GROWTH_GAMMA));
}

/** Clearance between two discs before the inner one is allowed to show,
 *  and the separation over which it fades in rather than popping. */
export const FOLD_GAP_PX = 4;
/** Room reserved between a world's disc and its first moon for the ships
 *  and station parked around it (a half-size hull, plus air). */
export const PARK_BAND_PX = 16;
export const FOLD_FADE_PX = 8;

/** Parked hulls appear once their world's TRUE radius is this many px,
 *  fully present FADE px later, full size at FULL px. */
export const HULL_OPEN_PX = 10;
export const HULL_FADE_PX = 8;
export const HULL_FULL_PX = 34;

/** A star opens its hulls on its own disc against this span. */
export const STAR_HULL_OPEN_PX = 80;
const STAR_HULL_FADE = 5 / 12;

const isStar = (b: Pick<Body, 'type'> | undefined | null) =>
  !!b && (b.type === 'star' || b.type === 'black_hole');

/** Which floor a body gets. Spellings vary by source (gas_giant from the
 *  client catalogue, gas-giant from older rows), so both are accepted. */
export function floorClass(
  body: Pick<Body, 'type'> & { mineralKind?: unknown },
  parent: Pick<Body, 'type'> | undefined | null,
): keyof typeof DISPLAY_FLOOR_PX | null {
  const t = String(body.type ?? '');
  // Rocks and structures already have their own glyph floors
  // (drawMeteoroidBody, drawMegastructureBody); leave them alone.
  if (body.mineralKind || t === 'megastructure') return null;
  if (t === 'star' || t === 'black_hole') return 'star';
  if (t === 'gas_giant' || t === 'gas-giant' || t === 'ice_giant' || t === 'ice-giant') return 'giant';
  if (t === 'dwarf') return 'dwarf';
  if (t === 'asteroid') return 'minor';
  if (t === 'moon') return 'moon';
  // Anything else orbiting a star reads as a planet; orbiting a planet,
  // as a moon.
  return parent && !isStar(parent) ? 'moon' : 'planet';
}

/** Smooth max of true size and floor: the floor far out, true size close
 *  in, no kink between. p = 4 hugs max() closely (1.19x the floor where
 *  they meet, within 2% of true once true is twice the floor). */
export function blendRadius(truePx: number, floorPx: number): number {
  if (floorPx <= 0) return Math.max(0, truePx);
  const t = Math.max(0, truePx);
  return Math.pow(t ** 4 + floorPx ** 4, 0.25);
}

/** Crossfade helper: 0 below a, 1 above a + w, linear between. */
const ramp = (v: number, a: number, w: number) => Math.max(0, Math.min(1, (v - a) / w));

export interface BodyPresentation {
  /** Drawn radius, px. */
  radius: Map<string, number>;
  /** 0 = folded into its parent (not drawn), 1 = fully shown. */
  shown: Map<string, number>;
  /** The visible world a folded body's ships and clicks belong to. */
  host: Map<string, string>;
  /** Screen px from a world's centre to the inner edge of its nearest
   *  SHOWN child (moon, structure): how far its parked ships and station
   *  may be drawn before they would sit outside their own moon. Absent =
   *  no shown child, no limit. */
  room: Map<string, number>;
  scale: number;
}

export interface PresentBody {
  id: string;
  type: Body['type'];
  radius: number;
  parent?: string | null;
  mineralKind?: unknown;
  orbitRadius?: number;
}

/**
 * The whole map's presentation for one frame.
 *
 * `screenPos` gives each body's canvas position this frame; folding
 * measures real on-screen separation (an eccentric orbit comes close and
 * goes far), not the nominal orbit radius.
 */
export function computePresentation(
  bodies: PresentBody[],
  scale: number,
  screenPos: (id: string) => { x: number; y: number } | null,
  /** Never folded: the selected world is what the player asked to see. */
  keepShown?: string | null,
  /** Viewport, for the floor growth. Omitted: no growth (1x). */
  viewport?: { w: number; h: number } | null,
  /** A wider parking band around ONE world: the selected ship's. A
   *  selected hull draws at full size, twice an ordinary parked hull, so
   *  its world's moons wait for room for IT before they unfold. */
  wideBand?: { bodyId: string; px: number } | null,
): BodyPresentation {
  const byId = new Map(bodies.map(b => [b.id, b]));
  // How much of the system fills the screen: the outermost giant's orbit
  // (Neptune on the shipped map) against half the short side.
  let growth = 1;
  if (viewport && viewport.w > 0 && viewport.h > 0) {
    let outer = 0;
    for (const b of bodies) {
      const parent = b.parent ? byId.get(b.parent) : null;
      if (floorClass(b, parent) === 'giant' && parent && isStar(parent)) {
        outer = Math.max(outer, b.orbitRadius ?? 0);
      }
    }
    if (outer > 0) growth = floorGrowth((outer * scale) / (0.5 * Math.min(viewport.w, viewport.h)));
  }
  const radius = new Map<string, number>();
  for (const b of bodies) {
    const parent = b.parent ? byId.get(b.parent) : null;
    const cls = floorClass(b, parent);
    const truePx = (b.radius ?? 0) * scale;
    radius.set(b.id, cls ? blendRadius(truePx, DISPLAY_FLOOR_PX[cls] * growth) : ownGlyphRadius(b, truePx));
  }

  // Parents before children, so a moon can see whether its planet has
  // itself folded into the star.
  const depth = (b: PresentBody) => {
    let d = 0;
    let cur: PresentBody | undefined = b;
    while (cur?.parent && d < 8) { cur = byId.get(cur.parent); d++; }
    return d;
  };
  const ordered = [...bodies].sort((a, b) => depth(a) - depth(b));

  const shown = new Map<string, number>();
  const host = new Map<string, string>();
  const sepOf = new Map<string, number>();
  for (const b of ordered) {
    const parent = b.parent ? byId.get(b.parent) : undefined;
    // Roots are never folded. Rocks and structures keep their own glyph
    // SIZE rules, but they fold like anything else: a trojan rock drawn
    // on top of the Sun, or a gate on top of its planet, is still a pile.
    if (!parent) {
      shown.set(b.id, 1);
      host.set(b.id, b.id);
      continue;
    }
    const parentShown = shown.get(parent.id) ?? 1;
    const parentHost = host.get(parent.id) ?? parent.id;
    let alpha = 1;
    const p = screenPos(b.id);
    const q = screenPos(parent.id);
    if (p && q) {
      const sep = Math.hypot(p.x - q.x, p.y - q.y);
      sepOf.set(b.id, sep);
      // ...plus the PARKING BAND: room for the parent's parked hulls and
      // station between its disc and this child, so a ship is never drawn
      // outside its own world's moon (see parkedRadiusMap).
      const band = wideBand && wideBand.bodyId === parent.id
        ? Math.max(PARK_BAND_PX, wideBand.px) : PARK_BAND_PX;
      const need = (radius.get(parent.id) ?? 0) + band + (radius.get(b.id) ?? 0) + FOLD_GAP_PX;
      alpha = ramp(sep, need, FOLD_FADE_PX);
    }
    // A moon of a folded planet folds with it.
    alpha = Math.min(alpha, parentShown);
    if (keepShown && b.id === keepShown) alpha = 1;
    shown.set(b.id, alpha);
    host.set(b.id, alpha >= 0.5 ? b.id : parentHost);
  }

  // SIBLINGS. Parent folding keeps a moon off its planet, but two worlds
  // on neighbouring orbits -- belt dwarfs, trojan rocks, two structures
  // over one planet -- can sit on each other with neither being the
  // other's parent. The lesser one folds into the greater: the bigger
  // class wins, then the bigger world. Pairs by grid cell, so the cost is
  // the number of near neighbours, not the square of the map.
  const live = ordered.filter(b => b.parent && (shown.get(b.id) ?? 0) >= 0.5);
  const cell = 48;
  const grid = new Map<string, PresentBody[]>();
  const at = new Map<string, { x: number; y: number }>();
  for (const b of live) {
    const p = screenPos(b.id);
    if (!p) continue;
    at.set(b.id, p);
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const arr = grid.get(k); if (arr) arr.push(b); else grid.set(k, [b]);
  }
  const rank = (b: PresentBody) => {
    const parent = b.parent ? byId.get(b.parent) : null;
    const cls = floorClass(b, parent);
    const byCls = cls ? RANK[cls] : (b.type === 'megastructure' ? 1.5 : 0.5);
    return byCls * 1e6 + (b.radius ?? 0);
  };
  // Greatest first, so a world that folds can never be the host of a
  // later fold (hosts are always still standing).
  const byRank = [...live].sort((a, b) => rank(b) - rank(a) || (a.id < b.id ? -1 : 1));
  for (const b of byRank) {
    if ((shown.get(b.id) ?? 0) < 0.5) continue;
    const p = at.get(b.id);
    if (!p) continue;
    const rb = radius.get(b.id) ?? 0;
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    const reach = Math.ceil((rb + 60) / cell);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const o of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (o.id === b.id || (shown.get(o.id) ?? 0) < 0.5) continue;
          if (rank(o) >= rank(b)) continue;
          const q = at.get(o.id)!;
          const sep = Math.hypot(p.x - q.x, p.y - q.y);
          const need = rb + (radius.get(o.id) ?? 0) + FOLD_GAP_PX;
          const a = Math.min(shown.get(o.id) ?? 1, ramp(sep, need, FOLD_FADE_PX));
          if (keepShown && o.id === keepShown) continue;
          shown.set(o.id, a);
          if (a < 0.5) host.set(o.id, host.get(b.id) ?? b.id);
        }
      }
    }
  }
  // A moon of a world that folded into a sibling goes with it.
  for (const b of ordered) {
    const parent = b.parent ? byId.get(b.parent) : undefined;
    if (!parent || (keepShown && b.id === keepShown)) continue;
    const ps = shown.get(parent.id) ?? 1;
    if (ps < (shown.get(b.id) ?? 1)) {
      shown.set(b.id, ps);
      if (ps < 0.5) host.set(b.id, host.get(parent.id) ?? parent.id);
    }
  }
  // ROOM before the first shown child, per parent (see the field doc).
  const room = new Map<string, number>();
  for (const b of bodies) {
    if (!b.parent || (shown.get(b.id) ?? 0) < 0.5) continue;
    const sep = sepOf.get(b.id);
    if (sep === undefined) continue;
    const edge = sep - (radius.get(b.id) ?? 0);
    const cur = room.get(b.parent);
    if (cur === undefined || edge < cur) room.set(b.parent, edge);
  }
  return { radius, shown, host, room, scale };
}

/**
 * Where something parked around a world is drawn, RADIALLY, on screen:
 * a map from true distance (world units) to screen px from the world's
 * centre, for one orbit with the given closest and farthest points.
 *
 * The band it must fit: outside the DRAWN disc by `clearPx` (half the
 * icon -- an enlarged world must not swallow its own fleet, and a big
 * hull parked at 1.3 radii of a giant sat across its limb) and inside
 * the world's first SHOWN moon by the same (Lorne, 2026-09-26: "are we
 * sure orbit radius won't be messed up by bigger worlds?" -- scaling a
 * parked orbit by the whole enlargement drew ships outside their own
 * planet's moon).
 *
 * If the true orbit already fits, it is untouched (null). Otherwise it is
 * SHIFTED out just enough to clear the disc, and COMPRESSED if it would
 * then pass the moon. Monotone, so the order is always disc, orbit, moon;
 * the ellipse keeps its shape whenever there is room for it. When there
 * is no band at all (the fold's PARK_BAND_PX makes that rare) clearing
 * the disc wins: a hull inside its planet is worse than one near a moon.
 *
 * Callers apply the SAME map to the hull, its orbit ring and its apsis
 * markers, so the hull is always on the ring the player sees.
 */
export function parkedRadiusMap(
  p: BodyPresentation | undefined | null,
  body: { id: string; radius: number },
  scale: number,
  periWorld: number,
  apoWorld: number,
  clearPx: number,
): ((worldR: number) => number) | null {
  if (!p) return null;
  const periPx = Math.max(1e-6, periWorld) * scale;
  const apoPx = Math.max(periWorld, apoWorld) * scale;
  const inner = drawnRadiusOf(p, body, scale) + clearPx;
  const room = p.room.get(body.id);
  const outer = room === undefined ? Infinity : room - clearPx;
  if (periPx >= inner && apoPx <= outer) return null;
  const shift = Math.max(0, inner - periPx);
  if (apoPx + shift <= outer || outer <= inner) {
    return (worldR) => worldR * scale + shift;
  }
  // Compress [peri, apo] into [inner, outer]; beyond apo (formation ranks)
  // continue at the same slope.
  const span = Math.max(1e-6, apoPx - periPx);
  const k = (outer - inner) / span;
  return (worldR) => inner + (worldR * scale - periPx) * k;
}

/** Class order for sibling folding: the greater world stays. */
const RANK: Record<keyof typeof DISPLAY_FLOOR_PX, number> = {
  star: 6, giant: 5, planet: 4, dwarf: 3, moon: 2, minor: 1,
};

/** Rocks and structures draw their own glyphs; this is the size those
 *  glyphs take on screen (drawMeteoroidBody's 4.5px glyph, the
 *  megastructure 5..46px clamp), so folding measures what is drawn. */
function ownGlyphRadius(b: PresentBody, truePx: number): number {
  if (b.type === 'megastructure') return Math.max(5, Math.min(truePx, 46));
  if (b.mineralKind) return Math.max(4.5, truePx);
  return Math.max(3, truePx);
}

/** Drawn radius, falling back to the old rule when no presentation was
 *  computed (lobby preview, tests, single-player callers). */
export function drawnRadiusOf(
  p: BodyPresentation | undefined | null,
  body: { id: string; radius: number },
  scale: number,
): number {
  return p?.radius.get(body.id) ?? Math.max(3, (body.radius ?? 0) * scale);
}

/** How far a drawn disc is inflated over true scale (>= 1). Things placed
 *  relative to the radius — a city on the surface, a station's ring —
 *  multiply by this, or the enlarged disc swallows them. */
export function inflationOf(
  p: BodyPresentation | undefined | null,
  body: { id: string; radius: number },
  scale: number,
): number {
  const truePx = (body.radius ?? 0) * scale;
  if (!p || truePx <= 0) return 1;
  return Math.max(1, drawnRadiusOf(p, body, scale) / truePx);
}

/**
 * Ships parked at `body`: 0 = count badge only, 1 = individual hulls.
 * Measured on the world's OWN true radius — you see a hull when you can
 * see the world it is parked at.
 */
export function hullReveal(body: { type: Body['type']; radius: number } | undefined | null, scale: number): number {
  if (!body) return 1;
  const truePx = (body.radius ?? 0) * scale;
  if (isStar(body)) return ramp(truePx / STAR_HULL_OPEN_PX, 1, STAR_HULL_FADE);
  return ramp(truePx, HULL_OPEN_PX, HULL_FADE_PX);
}

/** Parked hull size multiplier, 0.5 at reveal to 1 at HULL_FULL_PX. */
export function hullSize(body: { type: Body['type']; radius: number } | undefined | null, scale: number): number {
  if (!body) return 1;
  const truePx = (body.radius ?? 0) * scale;
  if (isStar(body)) {
    const open = truePx / STAR_HULL_OPEN_PX;
    return Math.max(0.5, Math.min(1, 0.5 + 0.5 * (open - 1) / (34 / 12 - 1)));
  }
  return 0.5 + 0.5 * ramp(truePx, HULL_OPEN_PX, HULL_FULL_PX - HULL_OPEN_PX);
}
