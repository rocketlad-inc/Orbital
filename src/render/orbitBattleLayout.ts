// ============================================================
// orbitBattleLayout — a battle that uses the WHOLE orbit (prototype).
//
// Lorne, 2026-10-06: "we are going to solve the cramped fleet problem."
// Today every faction in a fight is packed into a narrow arc inside an
// ~86-degree sector (MapCanvas BATTLE_SECTOR), because shots were never
// allowed to cross the planet. Past a few ranks the hulls overlap by
// design. This layout drops that rule: the orbit is a BAND OF ROOM, and
// a battle takes as much of it as its ships need.
//
//   small fight   stays compact: two clusters facing each other, as now
//   bigger        widens around the world, each faction a contiguous
//                 share sized to its ships, meeting at ragged fronts
//   a full lap    the sides meet on both flanks; the far ships fire
//                 ACROSS the planet
//   still more    the band deepens, and only past a depth limit do
//                 hulls overlap
//
// NATURE IS CHAOS. Nothing here is a line or a ring. Ships are scattered
// (seeded, so a hull keeps its place), then relaxed apart until their
// sprites do not touch; fleets pull toward their own centre, the edges
// of every cluster are noisy, and noses point forward along the orbit
// with the map's small jitter. Neighbouring shares keep a strip of no
// man's land between them.
//
// FLEETS, as the game draws them: a fleet marker (flagship plus its
// escort block, fleetGrouping) is ONE body here, with `clearR` covering
// the block. A swarm of separate hulls is many bodies sharing a `fleet`
// key, and clumps.
//
// Pure and screen-space: sprites are sized in pixels while the planet's
// size follows the zoom, so the layout is solved in pixels around a
// planet of a given drawn radius. Positions are relative to the planet's
// centre, at drift 0; the caller rotates the whole battle.
// ============================================================

export interface OBShip {
  id: string;
  faction: string;
  /** Fleet-mates cluster together; null = a loose hull. */
  fleet: string | null;
  /** Drawn sprite size in px (the square the icon is drawn into). */
  size: number;
  armed: boolean;
  /** Clearance radius in px, when the body is not one sprite: an in-game
   *  FLEET MARKER (flagship plus its escort block) is laid out as one
   *  body whose circle covers the whole block. Default size x CLEAR_FRAC. */
  clearR?: number;
}

export interface OBPlacement {
  id: string;
  x: number;
  y: number;
  /** Nose direction, radians (0 = +x). */
  heading: number;
  /** Polar position, for callers that want to rotate or wobble. */
  r: number;
  theta: number;
}

export type OBMode = 'compact' | 'wide' | 'ring' | 'deep ring' | 'crammed';

export interface OBLayout {
  placements: Map<string, OBPlacement>;
  /** Each faction's share of the orbit, radians (start < end, may exceed 2pi). */
  sectors: Array<{ faction: string; start: number; end: number }>;
  band: { rIn: number; rOut: number };
  mode: OBMode;
  /** Pairs of sprites still overlapping after relaxation. */
  overlaps: number;
}

// ---------------------------------------------------------------- tuning

/** Fraction of the sprite box a hull really fills: clearance radius. */
export const CLEAR_FRAC = 0.42;
/** Random packing of discs fills about this much of the area. */
const PACKING = 0.6;
/** A battle at or under this angle is "compact" (today's look). */
const COMPACT_MAX = 1.9;
/** Comfortable band depth, in average ship diameters. */
const DEPTH_COMFORT = 3.2;
/** Deepest the band grows before ships are allowed to overlap. Deep on
 *  purpose: zoomed out, 200 hulls round a 60px world need about seven
 *  diameters, and at 6 they were squeezed into 391 touching pairs.
 *  Not overlapping as you zoom out is the point (Lorne). */
const DEPTH_MAX_DIAMS = 12;
/** Relaxation passes. */
const ITERATIONS = 90;
/** No man's land between neighbouring shares, in TYPICAL (median) hull
 *  diameters of arc at mid-band. Lorne: "put a little distance between
 *  the borders of the portions". Every border gets one, full lap too. */
const SHARE_GAP_DIAMS = 1.6;

// ---------------------------------------------------------------- rng

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
/** Signed shortest angular difference a - b, in (-pi, pi]. */
const angDiff = (a: number, b: number) => {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
};

// ---------------------------------------------------------------- layout

export function layoutOrbitBattle(
  ships: readonly OBShip[],
  planetR: number,
  opts: { seed?: number; factionOrder?: string[] } = {},
): OBLayout {
  const placements = new Map<string, OBPlacement>();
  if (ships.length === 0) {
    return { placements, sectors: [], band: { rIn: planetR, rOut: planetR }, mode: 'compact', overlaps: 0 };
  }
  const seed = opts.seed ?? 1;
  const factions = opts.factionOrder
    ?? [...new Set(ships.map(s => s.faction))].sort();
  const clear = (s: OBShip) => s.clearR ?? s.size * CLEAR_FRAC;
  const avgDiam = ships.reduce((n, s) => n + 2 * clear(s), 0) / ships.length;
  const maxClear = Math.max(...ships.map(clear));
  // The TYPICAL SPRITE (a lone hull, or a fleet's flagship), for the
  // band's depth and the gaps. Measured in fleet BLOCKS, seven fleets
  // asked for a band 600px deep and a moat between the shares.
  const diams = ships.map(s => 2 * s.size * CLEAR_FRAC).sort((a, b) => a - b);
  const medDiam = diams[Math.floor(diams.length / 2)];

  // The band starts just off the planet's limb.
  const rIn = planetR + maxClear + Math.max(4, planetR * 0.04);

  // Room each ship needs, and in all.
  const areaOf = (s: OBShip) => (Math.PI * clear(s) ** 2) / PACKING;
  const areaBy = new Map<string, number>();
  for (const s of ships) areaBy.set(s.faction, (areaBy.get(s.faction) ?? 0) + areaOf(s));
  const A = [...areaBy.values()].reduce((a, b) => a + b, 0);

  // NO MAN'S LAND. Every border between two shares is a gap of
  // `gapPx` of arc, which costs room like ships do: gapPx x depth each.
  const F = factions.length;
  const gapPx = F < 2 ? 0 : SHARE_GAP_DIAMS * medDiam;

  // Angle needed at band depth D, with the F-1 gaps of a partial lap:
  // A + (F-1) gapPx D = theta * D * (rIn + D/2).
  const thetaAt = (D: number) => (A + Math.max(0, F - 1) * gapPx * D) / (D * (rIn + D / 2));
  // Depth of a full lap, which has F gaps (the last share meets the first).
  const ringDepth = () => {
    const a = TAU / 2, b = TAU * rIn - F * gapPx;
    return (-b + Math.sqrt(b * b + 4 * a * A)) / (2 * a);
  };

  // Compact first: a small fight keeps a blob-like depth (never thinner
  // than a ship and a half), so two corvettes read as two clusters. The
  // band is always deep enough for its biggest body (a fleet block).
  const dComfort = Math.max(DEPTH_COMFORT * medDiam, maxClear * 2.2);
  const dMax = Math.max(DEPTH_MAX_DIAMS * medDiam, planetR * 0.9, maxClear * 2.6);
  let depth = Math.min(dComfort, Math.max(medDiam * 1.6, maxClear * 2.2, Math.sqrt(A) * 0.75));
  let theta = thetaAt(depth);
  let mode: OBMode = theta <= COMPACT_MAX ? 'compact' : 'wide';
  let squeeze = 1;                       // < 1 = clearances shrink (overlap allowed)
  if (theta > COMPACT_MAX) {
    depth = dComfort;
    theta = thetaAt(depth);
  }
  if (theta >= TAU) {
    theta = TAU;
    depth = ringDepth();
    mode = depth <= dComfort * 1.05 ? 'ring' : 'deep ring';
    if (depth > dMax) {
      // Past the deepest band: pack tighter rather than stand further off.
      const cap = TAU * dMax * (rIn + dMax / 2) - F * gapPx * dMax;
      squeeze = Math.sqrt(Math.max(0.05, cap / A));
      depth = dMax;
      mode = 'crammed';
    }
  }
  const rOut = rIn + depth;
  const full = theta >= TAU - 1e-9;

  // FACTION SHARES. Contiguous, sized to each side's ships, ordered so
  // hostile neighbours share a front, with a gap at every border: F-1 on
  // a partial lap, F on a full one.
  const gap = gapPx / (rIn + depth / 2);
  const nGaps = F < 2 ? 0 : full ? F : F - 1;
  const usable = Math.max(theta * 0.3, theta - gap * nGaps);
  const sectors: OBLayout['sectors'] = [];
  let cursor = full ? -((areaBy.get(factions[0]) ?? 0) / A) * usable / 2 : -theta / 2;
  for (const f of factions) {
    const w = usable * ((areaBy.get(f) ?? 0) / A);
    sectors.push({ faction: f, start: cursor, end: cursor + w });
    cursor += w + gap;
  }
  const sectorOf = new Map(sectors.map(s => [s.faction, s]));
  // THE FRONTS: the middle of every gap between one faction's share and
  // another's. On a full lap the last share meets the first, so two
  // factions have two fronts (one on each flank of the world).
  const fronts = new Map<string, number[]>();
  for (let i = 0; i < sectors.length; i++) {
    const cur = sectors[i];
    const next = sectors[i + 1] ?? (full ? sectors[0] : undefined);
    if (!next || next.faction === cur.faction) continue;
    const edge = i + 1 < sectors.length ? (cur.end + next.start) / 2 : cur.end + gap / 2;
    for (const f of [cur.faction, next.faction]) {
      const arr = fronts.get(f) ?? [];
      arr.push(edge);
      fronts.set(f, arr);
    }
  }

  // FLEET SHARES inside each faction share, by area again.
  const fleetSector = new Map<string, { start: number; end: number }>();
  for (const sec of sectors) {
    const mine = ships.filter(s => s.faction === sec.faction);
    const groups = new Map<string, number>();
    for (const s of mine) {
      const key = s.fleet ?? `loose:${sec.faction}`;
      groups.set(key, (groups.get(key) ?? 0) + areaOf(s));
    }
    const total = [...groups.values()].reduce((a, b) => a + b, 0) || 1;
    // Loose hulls sit at the back of the share, fleets nearer the front.
    const keys = [...groups.keys()].sort((a, b) =>
      (a.startsWith('loose:') ? 1 : 0) - (b.startsWith('loose:') ? 1 : 0) || (a < b ? -1 : 1));
    let c = sec.start;
    for (const k of keys) {
      const w = (sec.end - sec.start) * ((groups.get(k) ?? 0) / total);
      fleetSector.set(`${sec.faction}|${k}`, { start: c, end: c + w });
      c += w;
    }
  }
  const fleetKey = (s: OBShip) => `${s.faction}|${s.fleet ?? `loose:${s.faction}`}`;

  // SCATTER INTO CLUMPS. A fleet is a blob, not a row: each fleet gets an
  // ANCHOR somewhere in its share (a seeded angle off its share's middle,
  // a seeded depth in the band), and its hulls start in a loose cloud
  // around it. A loose hull (no fleet) is its own anchor, dropped
  // anywhere in its faction's share: the stragglers.
  //
  // Spreading every hull evenly through the band, the first cut, packed
  // them into tidy concentric rows -- exactly the "clean circling lines"
  // this is meant to avoid. Clumps with gaps between them is what a
  // battle actually looks like.
  const anchorOf = new Map<string, { x: number; y: number; spread: number }>();
  const fleetArea = new Map<string, number>();
  for (const s of ships) fleetArea.set(fleetKey(s), (fleetArea.get(fleetKey(s)) ?? 0) + areaOf(s));
  const anchorAt = (key: string, fs: { start: number; end: number }, loose: boolean) => {
    const R = rng(hash(key) ^ (seed * 2654435761));
    const span = fs.end - fs.start;
    const a = loose
      ? fs.start + R() * span
      : (fs.start + fs.end) / 2 + (R() - 0.5) * span * 0.35;
    const r = rIn + depth * (loose ? 0.15 + R() * 0.85 : 0.25 + R() * 0.5);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  };
  type Body = {
    s: OBShip; x: number; y: number; c: number; stray: number;
    ax: number; ay: number; pull: number; press: number;
  };
  const bodies: Body[] = ships.map(s => {
    const R = rng(hash(s.id) ^ seed);
    const loose = s.fleet == null;
    const fk = fleetKey(s);
    const key = loose ? `${fk}|${s.id}` : fk;
    let anc = anchorOf.get(key);
    if (!anc) {
      const fs = loose ? sectorOf.get(s.faction)! : fleetSector.get(fk)!;
      const p = anchorAt(key, fs, loose);
      // A blob's natural radius from the room its hulls need.
      anc = { ...p, spread: Math.sqrt((fleetArea.get(fk) ?? areaOf(s)) / Math.PI) };
      anchorOf.set(key, anc);
    }
    // Gaussian-ish start around the anchor (two uniforms summed).
    const g1 = (R() + R() - 1), g2 = (R() + R() - 1);
    const sp = loose ? avgDiam * 0.5 : anc.spread * 0.8;
    return {
      s,
      x: anc.x + g1 * sp,
      y: anc.y + g2 * sp,
      c: clear(s) * squeeze,
      // How far past its faction's edge this hull may wander, in radians
      // of the band: most stay home, a few lean into the front -- but
      // never more than a quarter of the way into the gap, so the no
      // man's land between the shares stays open.
      stray: (R() ** 2) * (gap > 0 ? gap * 0.25 : 0.9 * avgDiam / (rIn + depth / 2)),
      ax: anc.x,
      ay: anc.y,
      // Fleet hulls hold to their blob; a straggler barely does.
      pull: loose ? 0.004 : 0.03 + R() * 0.02,
      // How hard this hull leans toward the nearest front: warships
      // press, freighters and colony ships hang back. Varied per hull so
      // the front line is ragged rather than ruled.
      press: s.armed ? 0.5 + R() * 0.5 : 0.08,
    };
  });

  // RELAX. Push overlapping hulls apart; keep each near its anchor (the
  // blob), off the planet, inside a soft outer edge, and in its faction's
  // share (ragged). There is deliberately NO pull toward a preferred
  // altitude: that is what drew the rows.
  const n = bodies.length;
  for (let it = 0; it < ITERATIONS; it++) {
    const late = it > ITERATIONS * 0.7;
    for (let i = 0; i < n; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const need = a.c + b.c + 2;
        const d2 = dx * dx + dy * dy;
        if (d2 >= need * need) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (need - d) / 2;
        const ux = d2 > 0 ? dx / d : Math.cos(i + j);
        const uy = d2 > 0 ? dy / d : Math.sin(i + j);
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
      }
    }
    for (const b of bodies) {
      // Hold the blob together (eased off at the end so separation wins).
      const k = late ? b.pull * 0.25 : b.pull;
      b.x += (b.ax - b.x) * k;
      b.y += (b.ay - b.y) * k;
      let r = Math.hypot(b.x, b.y) || 1;
      let t = Math.atan2(b.y, b.x);
      // Off the planet, always.
      const rMin = planetR + b.c + 3;
      if (r < rMin) r = rMin;
      // A soft outer edge: a preference, not a wall, so outlines stay uneven.
      if (r > rOut + b.c) r -= (r - rOut - b.c) * 0.2;
      // PRESS TOWARD THE FRONT. The nearest border with an enemy pulls
      // the hull (and its fleet's anchor) along the orbit; separation,
      // which works across factions too, stops the two sides at contact.
      // That is what makes the fronts: ragged, touching, firing.
      const myFronts = fronts.get(b.s.faction);
      if (myFronts && myFronts.length > 0) {
        let near = myFronts[0];
        let nd = Math.abs(angDiff(near, t));
        for (const f of myFronts) {
          const d = Math.abs(angDiff(f, t));
          if (d < nd) { nd = d; near = f; }
        }
        const step = Math.min(nd, (late ? 0.0015 : 0.006) * b.press) * Math.sign(angDiff(near, t));
        t += step;
        // The blob's anchor advances with its hulls.
        const ar = Math.hypot(b.ax, b.ay);
        const at = Math.atan2(b.ay, b.ax) + step * 0.5;
        b.ax = Math.cos(at) * ar;
        b.ay = Math.sin(at) * ar;
      }
      // Faction share, ragged.
      const sec = sectorOf.get(b.s.faction)!;
      if (!full || F > 1) {
        const mid = (sec.start + sec.end) / 2;
        const half = (sec.end - sec.start) / 2;
        const off = angDiff(t, mid);
        const over = Math.abs(off) - (half + b.stray);
        if (over > 0) t -= Math.sign(off) * over * 0.35;
      }
      b.x = Math.cos(t) * r;
      b.y = Math.sin(t) * r;
    }
  }
  // Final separation-only passes: whatever the anchors still squeeze,
  // pushed apart so the sprites do not touch.
  for (let it = 0; it < 30; it++) {
    for (let i = 0; i < n; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const need = a.c + b.c + 2;
        const d2 = dx * dx + dy * dy;
        if (d2 >= need * need) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (need - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
      }
    }
    for (const b of bodies) {
      let r = Math.hypot(b.x, b.y) || 1;
      let t = Math.atan2(b.y, b.x);
      const rMin = planetR + b.c + 3;
      if (r < rMin) r = rMin;
      // Keep the no man's land open while separating, except on the
      // last few passes, where touching sprites matter more.
      if (gap > 0 && it < 22) {
        const sec = sectorOf.get(b.s.faction)!;
        const off = angDiff(t, (sec.start + sec.end) / 2);
        const over = Math.abs(off) - ((sec.end - sec.start) / 2 + b.stray);
        if (over > 0) t -= Math.sign(off) * over * 0.5;
      }
      b.x = Math.cos(t) * r;
      b.y = Math.sin(t) * r;
    }
  }

  let overlaps = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bodies[i], b = bodies[j];
      // Against TRUE sprite size: a crammed band squeezes `c`, and counting
      // against the squeezed radius reported 0 while sprites touched.
      if (Math.hypot(a.x - b.x, a.y - b.y) < (clear(a.s) + clear(b.s)) * 0.9) overlaps++;
    }
  }
  // HEADINGS: FORWARD IN ORBIT, as on the map today -- the prograde
  // tangent (theta + pi/2 for the battle's wheel direction), with the
  // map's own small off-parallel jitter (BATTLE_LINE_JITTER_H, 0.22 rad
  // peak to peak). The first cut pointed every nose at the nearest enemy,
  // which scrambled the clumps (Lorne: "Where are these things pointing?
  // I want all ships pointing forward in their orbits, like it is now").
  for (const b of bodies) {
    const R = rng(hash(b.s.id) ^ (seed * 7919));
    const jitter = (R() - 0.5) * 0.22;
    const heading = Math.atan2(b.y, b.x) + Math.PI / 2 + jitter;
    placements.set(b.s.id, {
      id: b.s.id, x: b.x, y: b.y, heading,
      r: Math.hypot(b.x, b.y), theta: wrap(Math.atan2(b.y, b.x)),
    });
  }

  return { placements, sectors, band: { rIn, rOut }, mode, overlaps };
}

// ------------------------------------------------- today's rules (compare)

/**
 * TODAY'S battle lines, approximated in screen space for side-by-side
 * comparison: every faction in a narrow arc inside an ~86-degree sector
 * (MapCanvas BATTLE_SECTOR 1.5), ranks with a 22px separation floor and
 * a 26px rank gap, at most four ranks, after which hulls overlap.
 * Constants mirror mapRenderer's BATTLE_LINE_* values; the park radius
 * is approximated as just off the planet.
 */
export function layoutTodayLines(
  ships: readonly OBShip[],
  planetR: number,
  opts: { seed?: number; factionOrder?: string[] } = {},
): OBLayout {
  const placements = new Map<string, OBPlacement>();
  const factions = opts.factionOrder ?? [...new Set(ships.map(s => s.faction))].sort();
  const F = factions.length;
  const SECTOR = 1.5;
  const spacing = F > 1 ? SECTOR / (F - 1) : 0;
  const width = Math.min(spacing * 0.55, 0.8) || 0.8;
  const r0 = planetR * 1.18 + 14;
  const sep = Math.max(r0 * 0.2, 22);
  const gap = Math.max(r0 * 0.3, 26);
  const maxRanks = Math.floor(0.9 / 0.3) + 1;
  const sectors: OBLayout['sectors'] = [];
  factions.forEach((f, k) => {
    const centre = -SECTOR / 2 + spacing * k;
    sectors.push({ faction: f, start: centre - width / 2, end: centre + width / 2 });
    const mine = ships.filter(s => s.faction === f)
      .sort((a, b) => (a.fleet ?? '~').localeCompare(b.fleet ?? '~') || a.id.localeCompare(b.id));
    const byArc = Math.max(1, Math.floor((r0 * width) / sep));
    const perRank = Math.max(byArc, Math.ceil(mine.length / maxRanks));
    mine.forEach((s, i) => {
      const rank = Math.floor(i / perRank);
      const idx = i % perRank;
      const inRank = Math.min(perRank, mine.length - rank * perRank);
      const sweep = rank % 2 === 0 ? 1 : -1;
      let within = inRank > 1 ? ((idx / (inRank - 1)) - 0.5) * width * sweep : 0;
      if (inRank === 1 && rank > 0) within = (width / 4) * sweep;
      const R = rng(hash(s.id));
      const step = inRank > 1 ? width / (inRank - 1) : width;
      const t = centre + within + (R() - 0.5) * step * 0.42;
      const r = r0 + rank * gap + (R() - 0.5) * 6;
      const dir = 1;
      placements.set(s.id, {
        id: s.id, x: Math.cos(t) * r, y: Math.sin(t) * r,
        heading: t + (Math.PI / 2) * dir + (R() - 0.5) * 0.22,
        r, theta: wrap(t),
      });
    });
  });
  let overlaps = 0;
  const list = [...placements.values()];
  const sizeOf = new Map(ships.map(s => [s.id, s.clearR ?? s.size * CLEAR_FRAC]));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < ((sizeOf.get(a.id) ?? 0) + (sizeOf.get(b.id) ?? 0)) * 0.9) overlaps++;
    }
  }
  const rOut = Math.max(...list.map(p => p.r), r0);
  return { placements, sectors, band: { rIn: r0, rOut }, mode: 'compact', overlaps };
}

/** Does the segment a->b pass through the planet disk (centre 0,0)? */
export function crossesPlanet(ax: number, ay: number, bx: number, by: number, planetR: number): boolean {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
  const px = ax + dx * t, py = ay + dy * t;
  return px * px + py * py < planetR * planetR;
}
