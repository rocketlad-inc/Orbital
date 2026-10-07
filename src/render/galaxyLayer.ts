// ============================================================
// THE GALAXY VIEW — one ring and one name per star system.
//
// Lorne, 2026-10-06: "Lets make the zoom all the way out more ready and
// capable for a multi solar system view. Add a new layer for when were
// all the way out there that shows a percentage bar around the system
// for the empire ownership, for each system. With a system label."
//
// At the far-system zoom floor all of Sol is ~20px across. The layers
// built for the system view (the territory wash, the sensor outline)
// shrink into a smudge there, so this layer takes over as they fade
// out: each system (Sol, Centauri, Cygnus) gets a ring split by how
// much of it each empire holds, and its name above.
//
// "How much of it" is WORLDS HELD: the share of the system's holdable
// worlds (planets, giants, moons, dwarfs, asteroids) that carry an
// empire's settlement, from the same fog-free claims the territory wash
// paints. A world two empires both hold counts half to each. Stars,
// barycenters, Lagrange points, meteoroids and structures are not
// ground anyone holds (the wash skips them for the same reason), and
// whatever nobody holds is the bare track.
//
// Pure apart from paintGalaxyRings, so the shares, the ring arcs and the
// fade are testable without a canvas.
// ============================================================
import type { Body } from '../types';
import { isBarycenter } from './bodyPresentation';

/** Sol's outermost world on screen, px: above FADE_FROM the layer is
 *  off, below FADE_TO it is fully on (the system view has shrunk into a
 *  token by then). */
export const GALAXY_FADE_FROM_PX = 70;
export const GALAXY_FADE_TO_PX = 45;
/** Ring radius floor, px, and how far it sits outside the outermost world. */
export const GALAXY_RING_MIN_PX = 40;
export const GALAXY_RING_PAD_PX = 10;
/** Ring stroke, px, and the gap between two empires' arcs. */
export const GALAXY_RING_WIDTH = 5;
export const GALAXY_RING_GAP_PX = 2;

export interface ClaimLike { bodyId: string; ownedBy: string }

export interface StarSystemShare { factionId: string; share: number }

export interface StarSystemSummary {
  /** The body the system is centred on: Sol, or a far barycenter. */
  anchorId: string;
  name: string;
  /** Outermost world, world units from the anchor (orbit radii summed up
   *  the parent chain, so a moon of a far planet counts its planet's). */
  outerR: number;
  /** Holdable worlds in the system. */
  worlds: number;
  /** One entry per empire holding any of it, share 0..1, largest first. */
  shares: StarSystemShare[];
}

const UNHOLDABLE = new Set(['star', 'black_hole', 'lagrange', 'meteoroid', 'megastructure']);

/** Can an empire hold this world? Mirrors what the territory wash lets
 *  claim ground (systemRegions), plus the stars themselves. */
export function isHoldableWorld(b: Body): boolean {
  if (b.destroyedAtTick != null) return false;
  if ((b as { obliteratedAtTick?: number | null }).obliteratedAtTick != null) return false;
  if (UNHOLDABLE.has(String(b.type))) return false;
  if (isBarycenter(b)) return false;
  if (b.mineralKind) return false;
  return !/sungate_/.test(b.id);
}

/** Which star system each body belongs to: climb parents to the first
 *  far barycenter, else to the root (Sol). Memoised per call. */
export function makeStarSystemOf(bodies: Body[]): (id: string) => string | null {
  const byId = new Map(bodies.map(b => [b.id, b]));
  const cache = new Map<string, string | null>();
  return (id: string) => {
    if (cache.has(id)) return cache.get(id)!;
    let cur = byId.get(id);
    const seen = new Set<string>();
    let out: string | null = null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (isBarycenter(cur) || !cur.parent) { out = cur.id; break; }
      cur = byId.get(cur.parent);
    }
    cache.set(id, out);
    return out;
  };
}

/** "Centauri Barycenter" -> "Centauri"; Sol stays Sol. */
export function starSystemName(anchor: Body): string {
  return anchor.name.replace(/\s*Barycenter$/i, '').trim() || anchor.name;
}

/** Every star system on the map with its worlds-held shares. */
export function summariseStarSystems(bodies: Body[], claims: readonly ClaimLike[]): StarSystemSummary[] {
  const systemOf = makeStarSystemOf(bodies);
  const byId = new Map(bodies.map(b => [b.id, b]));
  const holders = new Map<string, Set<string>>();
  for (const c of claims) {
    if (!c.ownedBy) continue;
    let s = holders.get(c.bodyId);
    if (!s) { s = new Set(); holders.set(c.bodyId, s); }
    s.add(c.ownedBy);
  }
  const anchors = bodies.filter(b => b.destroyedAtTick == null && (!b.parent || isBarycenter(b)));
  const out: StarSystemSummary[] = [];
  for (const anchor of anchors) {
    const held = new Map<string, number>();
    let worlds = 0;
    let outerR = 0;
    for (const b of bodies) {
      if (!isHoldableWorld(b) || systemOf(b.id) !== anchor.id) continue;
      worlds += 1;
      // Distance from the anchor: this orbit plus every parent's below it.
      let r = 0;
      let cur: Body | undefined = b;
      const seen = new Set<string>();
      while (cur && cur.id !== anchor.id && !seen.has(cur.id)) {
        seen.add(cur.id);
        r += Number(cur.orbitRadius) || 0;
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
      if (r > outerR) outerR = r;
      const who = holders.get(b.id);
      if (who && who.size > 0) {
        for (const f of who) held.set(f, (held.get(f) ?? 0) + 1 / who.size);
      }
    }
    if (worlds === 0) continue;
    const shares = [...held].map(([factionId, n]) => ({ factionId, share: n / worlds }))
      .sort((a, b) => b.share - a.share || (a.factionId < b.factionId ? -1 : 1));
    out.push({ anchorId: anchor.id, name: starSystemName(anchor), outerR, worlds, shares });
  }
  return out;
}

/** 0 = system view, 1 = galaxy view, from how big Sol's worlds are on screen. */
export function galaxyLayerAlpha(solOuterPx: number): number {
  if (!(solOuterPx > 0)) return 0;
  if (solOuterPx >= GALAXY_FADE_FROM_PX) return 0;
  if (solOuterPx <= GALAXY_FADE_TO_PX) return 1;
  return (GALAXY_FADE_FROM_PX - solOuterPx) / (GALAXY_FADE_FROM_PX - GALAXY_FADE_TO_PX);
}

/** Ring radius, px, for a system whose outermost world sits outerPx out. */
export function galaxyRingRadius(outerPx: number): number {
  return Math.max(GALAXY_RING_MIN_PX, outerPx + GALAXY_RING_PAD_PX);
}

export interface RingArc { factionId: string; a0: number; a1: number }

/**
 * The arcs of one ring, clockwise from twelve o'clock: the viewer's own
 * empire first (so "mine" is always in the same place), then everyone
 * else largest first. Each arc gives up GALAXY_RING_GAP_PX at its end so
 * neighbours never touch; an arc too small to survive the gap keeps a
 * sliver rather than vanishing (an empire with one rock still shows).
 */
export function ringArcs(shares: readonly StarSystemShare[], viewerId: string, radiusPx: number): RingArc[] {
  const ordered = [...shares].filter(s => s.share > 0).sort((a, b) => {
    if (a.factionId === viewerId) return -1;
    if (b.factionId === viewerId) return 1;
    return b.share - a.share || (a.factionId < b.factionId ? -1 : 1);
  });
  const total = ordered.reduce((s, x) => s + x.share, 0);
  const whole = total >= 0.9999 && ordered.length === 1;
  const gap = whole ? 0 : GALAXY_RING_GAP_PX / Math.max(1, radiusPx);
  const arcs: RingArc[] = [];
  let a = -Math.PI / 2;
  for (const s of ordered) {
    const span = Math.min(1, s.share) * Math.PI * 2;
    const draw = Math.max(span - gap, Math.min(span, 1.5 / Math.max(1, radiusPx)));
    arcs.push({ factionId: s.factionId, a0: a, a1: a + draw });
    a += span;
  }
  return arcs;
}

/** One ring as it goes on screen this frame. */
export interface GalaxyRing {
  summary: StarSystemSummary;
  x: number;
  y: number;
  r: number;
  /** Where the name sits (reserved with the label solver before text). */
  label: { x: number; y: number; w: number; h: number };
}

export const GALAXY_NAME_FONT = `800 13px 'Audiowide', sans-serif`;
export const GALAXY_SUB_FONT = `9px 'Audiowide', sans-serif`;
export const GALAXY_NAME_PX = 13;
export const GALAXY_SUB_PX = 9;
const LABEL_GAP = 7;

/** The label box above a ring, given the measured widths. */
export function galaxyLabelBox(x: number, y: number, r: number, nameW: number, subW: number) {
  const h = GALAXY_NAME_PX + 3 + GALAXY_SUB_PX;
  const w = Math.max(nameW, subW);
  return { x: x - w / 2, y: y - r - GALAXY_RING_WIDTH / 2 - LABEL_GAP - h, w, h };
}

/** "62% held" under the name: how much of the system is spoken for. */
export function galaxySubline(s: StarSystemSummary): string {
  const held = Math.round(100 * s.shares.reduce((t, x) => t + x.share, 0));
  return held <= 0 ? 'UNCLAIMED' : `${held}% HELD`;
}

export function paintGalaxyRings(
  c: CanvasRenderingContext2D,
  rings: readonly GalaxyRing[],
  alpha: number,
  viewerId: string,
  colorOf: (factionId: string) => string,
): void {
  if (alpha <= 0.01 || rings.length === 0) return;
  c.save();
  c.globalAlpha = c.globalAlpha * alpha;
  c.lineCap = 'butt';
  for (const ring of rings) {
    // Track: the unheld part of the system, and the casing under the arcs
    // so they read against the dim and the bright side of the fog alike.
    c.beginPath();
    c.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    c.lineWidth = GALAXY_RING_WIDTH + 3;
    c.strokeStyle = 'rgba(4, 8, 14, 0.85)';
    c.stroke();
    c.lineWidth = GALAXY_RING_WIDTH;
    c.strokeStyle = 'rgba(138, 160, 180, 0.28)';
    c.stroke();
    for (const arc of ringArcs(ring.summary.shares, viewerId, ring.r)) {
      c.beginPath();
      c.arc(ring.x, ring.y, ring.r, arc.a0, arc.a1);
      c.strokeStyle = colorOf(arc.factionId);
      c.stroke();
    }
    // Name and sub-line: text ink, never an empire's colour.
    const cx = ring.label.x + ring.label.w / 2;
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.lineJoin = 'round';
    c.font = GALAXY_NAME_FONT;
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(4, 8, 14, 0.9)';
    const name = ring.summary.name.toUpperCase();
    c.strokeText(name, cx, ring.label.y);
    c.fillStyle = '#dbe6f0';
    c.fillText(name, cx, ring.label.y);
    c.font = GALAXY_SUB_FONT;
    const sub = galaxySubline(ring.summary);
    const subY = ring.label.y + GALAXY_NAME_PX + 3;
    c.strokeText(sub, cx, subY);
    c.fillStyle = '#8aa0b4';
    c.fillText(sub, cx, subY);
  }
  c.restore();
}
