// ------------------------------------------------------------
// ORBITAL LANES — where everything parked at a world is drawn.
//
// Ships, fleets, battle lines and the station used to be placed by
// four rules that never looked at each other: each hull on its own
// orbit pushed just clear of the disc, the station on its orbit with a
// few pixels' clearance, battle lines in world-unit arcs, fleet escorts
// in screen-space blocks. With the overhaul's big hulls they piled on
// top of one another (Lorne, 2026-10-01: "just too much overlapping").
//
// Here they share ONE screen-space layout per world, built outward from
// the drawn disc:
//
//   - LANES are rings. A lane is as wide as the tallest thing in it, and
//     the next starts a gap beyond it, so lanes never overlap.
//   - Along a lane, every item takes its own arc length (its hull, plus
//     its escort block for a fleet), so items never overlap either.
//   - PINNED items (the station) keep their own angle and the rest of
//     their lane flows around them.
//   - A BATTLE gives each side a wedge of a contested sector; each side
//     fills its wedge lane by lane, its ranks.
//   - CROWDED: everything first shrinks together (to MIN_SCALE) to fit
//     inside the world's budget; past that, more lanes are added outward
//     (Lorne chose "shrink, then extra rings" over stacking).
//
// Pure: no canvas, no game state, so it is tested on its own.
// ------------------------------------------------------------

export interface LaneItem {
  id: string;
  /** Arc length it needs along its lane, px at full scale (a fleet's
   *  includes its escort block astern). */
  length: number;
  /** Its extent across the lane, px at full scale. */
  height: number;
  /** From the item's FRONT (its direction of travel) to the point the
   *  caller draws it at, px at full scale. Defaults to the middle. */
  anchor?: number;
  /** Battle side (owner). */
  side?: string;
  /** Keeps this angle (radians, canvas frame). Placed first, in lane 0;
   *  the lane's other items flow around it. */
  pinned?: number;
}

export interface LaneWorld {
  /** Drawn radius of the world's disc, px. */
  discR: number;
  items: LaneItem[];
  /** Direction of travel round the world: +1 or -1 (canvas angle sense). */
  dir: number;
  /** Lanes should end by here, px from the centre (the next shown world,
   *  or a sensible reach); past it the whole layout shrinks first. */
  budgetR: number;
  /** Ring rotation for free lanes, radians at lane radius `discR`. */
  spin: number;
  /** Battle sides in fixed order, or null in peace. */
  sides?: string[] | null;
  /** Centre of the contested sector (radians), when sides is set. */
  battleCenter?: number;
}

export interface LanePlace {
  /** Radius of the lane, px from the world's centre. */
  r: number;
  /** Angle of the item's draw point (radians, canvas frame). */
  angle: number;
  /** Nose direction (radians): tangent, in the direction of travel. */
  heading: number;
  /** Size multiplier the layout settled on (1 = full). */
  scale: number;
  lane: number;
}

export interface LaneLayout {
  places: Map<string, LanePlace>;
  scale: number;
  /** Outer edge of the last lane, px. */
  outerR: number;
  /** Lanes used. */
  lanes: number;
}

/** Clear space between lanes and between items in a lane, px. */
export const LANE_GAP_PX = 6;
/** How far everything may shrink before lanes are added instead. */
export const LANE_MIN_SCALE = 0.55;
/** Gap between two sides' wedges, radians. */
const SIDE_GAP = 0.22;
/** A fight is drawn at most this many ranks deep before its sector
 *  widens round the world: a long fan out past the moon reads worse
 *  than lines wrapping the planet. */
const MAX_RANKS = 3;
/** The widest a battle sector grows, radians (most of the ring). */
const MAX_SECTOR = Math.PI * 1.7;

type Interval = [number, number];

const TAU = Math.PI * 2;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

/** [0, 2π) minus the given blocked arcs, as increasing intervals. */
function freeArcs(blocked: Interval[]): Interval[] {
  // Each blocked arc into [0, 2π), split where it wraps.
  const bs: Interval[] = [];
  for (const [a, b] of blocked) {
    const len = Math.min(TAU, Math.max(0, b - a));
    if (len >= TAU - 1e-9) return [];
    const s = norm(a);
    if (s + len <= TAU) bs.push([s, s + len]);
    else { bs.push([s, TAU]); bs.push([0, s + len - TAU]); }
  }
  bs.sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  let cur = 0;
  for (const [s, e] of bs) {
    if (e <= cur) continue;
    if (s > cur) out.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < TAU) out.push([cur, TAU]);
  return out.filter(([s, e]) => e - s > 1e-6);
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [s1, e1] of a) for (const [s2, e2] of b) {
    const s = Math.max(s1, s2), e = Math.min(e1, e2);
    if (e - s > 1e-6) out.push([s, e]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/**
 * Put as many of `queue` (in order) as fit into `arcs` on a lane of
 * radius `rc`, spreading the spare room evenly so the lane reads as a
 * ring rather than a queue. Returns how many were placed.
 */
function fill(
  queue: LaneItem[], arcs: Interval[], rc: number, s: number, gap: number, dir: number,
  lane: number, out: Map<string, LanePlace>,
): number {
  let qi = 0;
  for (const [a0, a1] of arcs) {
    if (qi >= queue.length) break;
    const span = (a1 - a0) * rc;
    // How many fit in this arc.
    let used = 0;
    const take: LaneItem[] = [];
    while (qi + take.length < queue.length) {
      const it = queue[qi + take.length];
      const need = it.length * s + gap;
      if (used + need > span + 1e-6) break;
      used += need;
      take.push(it);
    }
    if (!take.length) continue;
    // Even spread: spare room shared between the items.
    const spare = (span - used) / take.length;
    let u = 0;
    for (const it of take) {
      const len = it.length * s;
      const start = u + spare / 2 + gap / 2;
      // `u` runs WITH the direction of travel (from a0 when dir is +1,
      // from a1 when -1), so the item's FRONT is always its far end.
      const anchorFromFront = (it.anchor ?? it.length / 2) * s;
      const along = start + len - anchorFromFront;
      const angle = dir >= 0 ? a0 + along / rc : a1 - along / rc;
      out.set(it.id, {
        r: rc, angle, heading: angle + (Math.PI / 2) * (dir >= 0 ? 1 : -1), scale: s, lane,
      });
      u += len + gap + spare;
    }
    qi += take.length;
  }
  return qi;
}

function layoutAt(w: LaneWorld, s: number, sectorArg?: number): LaneLayout {
  const gap = LANE_GAP_PX * Math.max(0.6, s);
  const out = new Map<string, LanePlace>();
  const pinned = w.items.filter(i => i.pinned !== undefined);
  // Tallest first: big hulls hold the inner lanes, small ones the outer.
  // Stable on the caller's order otherwise, so slots do not shuffle.
  const free = w.items
    .map((it, i) => ({ it, i }))
    .filter(x => x.it.pinned === undefined)
    .sort((a, b) => b.it.height - a.it.height || a.i - b.i)
    .map(x => x.it);

  let rInner = w.discR + gap;
  let lane = 0;
  const dir = w.dir >= 0 ? 1 : -1;

  // Lane 0 holds the pinned items; what is left of it is free road.
  let blocked0: Interval[] = [];
  let pinW = 0;
  if (pinned.length) {
    pinW = Math.max(...pinned.map(p => p.height)) * s;
  }

  if (w.sides && w.sides.length > 1) {
    const sides = w.sides;
    const F = sides.length;
    const sector = sectorArg ?? baseSector(F);
    const wedge = Math.max(0.3, (sector - SIDE_GAP * (F - 1)) / F);
    const centre = w.battleCenter ?? 0;
    const queues = sides.map(sd => free.filter(it => it.side === sd));
    // Hulls with no side (should not happen) ride with the first.
    for (const it of free) if (!it.side || !sides.includes(it.side)) queues[0].push(it);
    const wedges: Interval[] = sides.map((_, k) => {
      const c = centre + (k - (F - 1) / 2) * (wedge + SIDE_GAP);
      return [c - wedge / 2, c + wedge / 2];
    });
    let guard = 0;
    while (queues.some(q => q.length) || (lane === 0 && pinned.length)) {
      const heads = queues.filter(q => q.length).map(q => q[0].height * s);
      const wl = Math.max(lane === 0 ? pinW : 0, ...heads, 1);
      const rc = rInner + wl / 2;
      let blocked: Interval[] = [];
      if (lane === 0 && pinned.length) {
        blocked0 = placePinned(pinned, rc, s, gap, out);
        blocked = blocked0;
      }
      const open = freeArcs(blocked);
      sides.forEach((_, k) => {
        const q = queues[k];
        if (!q.length) return;
        // The wedge, unwrapped into [0, 2π) as one or two arcs.
        const [a, b] = wedges[k];
        const wa = freeArcs([[b, a + TAU]]);
        const arcs = intersect(wa, open);
        const n = fill(q, arcs, rc, s, gap, dir, lane, out);
        q.splice(0, n);
      });
      rInner += wl + gap;
      lane++;
      if (++guard > 200) break;
    }
    return { places: out, scale: s, outerR: rInner, lanes: lane };
  }

  // Peace: lanes fill outward; free lanes turn with their radius.
  const queue = free.slice();
  let guard = 0;
  while (queue.length || (lane === 0 && pinned.length)) {
    const wl = Math.max(lane === 0 ? pinW : 0, queue.length ? queue[0].height * s : 0, 1);
    const rc = rInner + wl / 2;
    let arcs: Interval[];
    if (lane === 0 && pinned.length) {
      blocked0 = placePinned(pinned, rc, s, gap, out);
      arcs = freeArcs(blocked0);
    } else {
      // A free lane turns: inner lanes faster, as orbits do.
      const turn = w.spin * Math.pow(Math.max(1, w.discR) / rc, 1.5);
      arcs = [[turn, turn + TAU]];
    }
    const n = fill(queue, arcs, rc, s, gap, dir, lane, out);
    queue.splice(0, n);
    rInner += wl + gap;
    lane++;
    if (++guard > 200) break;
  }
  return { places: out, scale: s, outerR: rInner, lanes: lane };
}

/** Pinned items on lane 0 at their own angles; returns the arcs they hold. */
function placePinned(
  pinned: LaneItem[], rc: number, s: number, gap: number, out: Map<string, LanePlace>,
): Interval[] {
  const blocked: Interval[] = [];
  for (const p of pinned) {
    const a = p.pinned as number;
    const half = ((p.length * s) / 2 + gap) / rc;
    blocked.push([a - half, a + half]);
    out.set(p.id, { r: rc, angle: a, heading: a + Math.PI / 2, scale: s, lane: 0 });
  }
  return blocked;
}

const baseSector = (F: number) => Math.min(Math.PI * 1.15, 0.9 + 0.55 * F);

/** A battle at size `s`: the narrowest sector that holds every side
 *  within MAX_RANKS, widening round the world up to MAX_SECTOR. */
function battleAt(w: LaneWorld, s: number): LaneLayout {
  const F = w.sides!.length;
  let sector = baseSector(F);
  let best = layoutAt(w, s, sector);
  while (best.lanes > MAX_RANKS && sector < MAX_SECTOR - 1e-6) {
    sector = Math.min(MAX_SECTOR, sector * 1.25);
    best = layoutAt(w, s, sector);
  }
  return best;
}

/**
 * The layout for one world: shrink together until it fits the budget,
 * and past the smallest size, let the lanes run outward. A battle first
 * widens its sector, then shrinks.
 */
export function layoutLanes(w: LaneWorld): LaneLayout {
  if (!w.items.length) return { places: new Map(), scale: 1, outerR: w.discR, lanes: 0 };
  const at = (s: number) => (w.sides && w.sides.length > 1 ? battleAt(w, s) : layoutAt(w, s));
  let s = 1;
  let best = at(s);
  while (best.outerR > w.budgetR && s > LANE_MIN_SCALE + 1e-6) {
    s = Math.max(LANE_MIN_SCALE, s * 0.88);
    best = at(s);
  }
  return best;
}
