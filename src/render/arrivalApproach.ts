// ============================================================
// arrivalApproach — AN ARRIVAL IS ONE MOTION.
//
// Lorne, 2026-10-23: "smoothen out the transition from transit to orbit
// ... make sure it's smooth and nice for the camera". Measured on the
// strike4 take (Ganymede to Europa: trace.jsonl, per-hull drawn spots at
// 30 fps), an arrival was four motions with three breaks between them:
//
//  1. The course runs to the world's CENTRE, so the in-flight draw held
//     it off at a standoff ring (keepOffDrawnDiscs). Reaching the ring
//     took the radial speed off in one frame (f360); inside it the hull
//     rode the ring round as the moon ran on under it, and when the
//     course point came within 5% of the ring's radius of the centre the
//     hold's bearing snapped to the approach side: every hull jumped
//     ~90 px (f366-367), and the continuity guard slid the fleet back
//     ~400 px in a straight line ACROSS the disc.
//  2. On landing (f372) the hull was new to the world's layout, which
//     re-solves only once a roster change has held for ROSTER_DWELL_MS,
//     so it stopped dead where it was drawn (heldInBattle) for 1.5 s...
//  3. ...and then glided round the world to its slot (f423).
//
// Now the world's layout takes a hull in while it is still in flight, a
// tick or two out (worldRosters: its arrival is in its flight plan), so
// its place exists before it lands; and the hull flies INTO that place
// (planCapture): it brakes in along its approach, clear of the disc, and
// as it slows it curves round the outside into its slot, which it
// reaches ARRIVAL_SETTLE_TICKS after landing. The parked draw follows the same
// path to its end (battleLocalPos), so the motion carries straight on
// through the landing. Nothing waits, nothing holds, nothing crosses the
// disc.
// ============================================================

import type { Ship } from '../types';
import { torchPositionFromSamples } from '../physics/torchTransfer';

type P = { x: number; y: number };
type Sample = { t: number; x: number; y: number };

/** A hull in flight joins its destination's layout when it lands within
 *  this many ticks: its place exists before its capture starts (a
 *  whole-tick arrival is admitted with the state two ticks before it;
 *  the capture is at most ARRIVAL_CAPTURE_TICKS long before it). */
export const ARRIVAL_ADMIT_TICKS = 2;
/** The capture starts this many ticks before the arrival (at most half
 *  the leg): from here the hull is measured against where its world will
 *  be when it lands, so it brakes straight in rather than looping past a
 *  moon running on under it. */
export const ARRIVAL_CAPTURE_TICKS = 1.5;
/** The turn into the slot: from this long before the arrival (while it is
 *  still braking in, so it never slows to a stop and sets off again)... */
export const ARRIVAL_TURN_TICKS = 0.8;
/** ...to this long after it, when the hull is in its place. */
export const ARRIVAL_SETTLE_TICKS = 0.6;
/** Its distance eases to the slot's over the end of the turn. */
const SETTLE_FROM_TICKS = 0.35;
/** Samples the capture is drawn with (the hull is lerped along them). */
const CAPTURE_SAMPLES = 64;
/** Share of the run-in over which the hull's distance hands over from
 *  the moving world to its arrival point. */
const DISTANCE_HANDOVER = 1;
/** Share of the run-in over which the floor is eased in. */
const FLOOR_IN = 0.4;

/**
 * A hull in flight that lands at its destination soon enough to be laid
 * out there now. Not a missile (it bursts), not a hull meeting another
 * in flight (it joins its leader's course), not one that leaves again on
 * landing (a queued leg, a trade-route run: route hulls land and relaunch
 * in one tick and are never drawn parked).
 */
export function isImminentArrival(
  s: Ship, currentTick: number, onRoute?: (s: Ship) => boolean,
): boolean {
  const leg = s.transit?.currentTransfer;
  if (!leg || !leg.targetBodyId) return false;
  if (s.class === 'missile') return false;
  // A hull meeting another in flight joins its leader's course; once it
  // HAS met it, it flies that course to the leader's world and lands with
  // it, so it comes in the same way. Left out, a squadron that rode the
  // Mega Destroyer in landed, sat out the roster dwell, then darted to its
  // slots at ~50 px a frame (the Battle of Earth take, 2026-10-24).
  if (s.plannedRendezvous && !(currentTick >= s.plannedRendezvous.meetTick)) return false;
  if (s.queuedTransits && s.queuedTransits.length > 0) return false;
  if (onRoute?.(s)) return false;
  return leg.arriveTick - currentTick <= ARRIVAL_ADMIT_TICKS;
}

/**
 * Every world's roster for its layout (battleLayoutLive): the hulls parked
 * there that the viewer can see, and (given `currentTick`) the visible
 * hulls about to land there (isImminentArrival). `arriving` names the
 * latter; MapCanvas's formation pass lays each roster out.
 */
export function worldRosters(
  ships: readonly Ship[],
  visible: (s: Ship) => boolean,
  opts: { currentTick?: number; onRoute?: (s: Ship) => boolean } = {},
): { byBody: Map<string, Ship[]>; arriving: Set<string> } {
  const byBody = new Map<string, Ship[]>();
  const arriving = new Set<string>();
  const add = (bodyId: string, s: Ship) => {
    const arr = byBody.get(bodyId) || [];
    arr.push(s);
    byBody.set(bodyId, arr);
  };
  for (const s of ships) {
    if (!visible(s)) continue;
    if (!s.transit) { add(s.orbit.parentBodyId, s); continue; }
    if (opts.currentTick != null && isImminentArrival(s, opts.currentTick, opts.onRoute)) {
      add(s.transit.currentTransfer.targetBodyId, s);
      arriving.add(s.id);
    }
  }
  return { byBody, arriving };
}

const smoother = (u: number) => { const k = Math.max(0, Math.min(1, u)); return k * k * k * (k * (k * 6 - 15) + 10); };
const wrapPi = (a: number) => { let d = a % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

/**
 * A hull's way in to its world, round the world's centre: where its
 * formation place is (distance and unwrapped bearing, world units),
 * sample by sample, before the turn into its slot is laid over it.
 */
export interface Capture {
  bodyId: string;
  arriveTick: number;
  /** The capture's first tick; before it the hull flies its course. */
  t0: number;
  /** The last tick of the turn: from here it is in its slot. */
  tEnd: number;
  pts: Array<{ t: number; r: number; phi: number }>;
  /** Turns of 2pi added to the slot's bearing (windingOf). */
  winding?: number;
}

/**
 * The hull's way in (Capture), from its own placed path (`placed`, world:
 * its course plus its formation place) and its formation's course
 * (`course`), round its destination (`world`: the centre at tick t).
 *
 * Its formation place rides on the COURSE, held clear of the world (the
 * course's distance from the centre is drawn floorR further out, so it
 * brakes as its course does and stops at floorR, never inside it, and no
 * hard stop at a ring); the formation offset is carried on that. A slot
 * astern of the lead or abreast of it is never nearer the centre than the
 * lead, so every hull stays clear and keeps its place in the arrowhead
 * (arrivalKeepsFormation).
 *
 * From the capture's start the course is measured from where the world
 * WILL be at the arrival rather than where it is. The course ends where
 * the world will be, and a moon runs on under its arrivals (Europa, 60 px
 * a frame in the take): measured from the moving moon, a hull coming in
 * ahead of it was caught up by it (the course looped past and back), and
 * one coming in from behind overtook it, straight through its centre.
 * Measured from the arrival point it comes straight in and stops. The
 * hand-over is made in DISTANCE AND BEARING (the frozen course's, plus
 * the difference from the true ones at the start, eased to nothing by
 * the time the course stops), never as a blend of the two positions: a
 * blend of two vectors pointing opposite ways passes through the centre,
 * and a bearing taken there spins (a lone hull in from behind its moon
 * swung half round it in two frames).
 */
export function planCapture(
  bodyId: string, placed: Sample[], course: Sample[], world: (t: number) => P, floorR: number,
  startTick: number, arriveTick: number,
): Capture | null {
  if (placed.length < 2 || course.length < 2 || !(floorR > 0)) return null;
  const leg = arriveTick - startTick;
  if (!(leg > 0)) return null;
  // Where the course comes to rest (a ceiled arrival leaves it at rest on
  // its intercept for the end of the leg: the take braked to rest at T8.7
  // and landed at T9).
  const qEnd = course[course.length - 1];
  let stop = arriveTick;
  for (let i = course.length - 1; i >= 0; i--) {
    if (Math.abs(course[i].x - qEnd.x) + Math.abs(course[i].y - qEnd.y) > 1e-9) break;
    stop = Math.min(stop, course[i].t);
  }
  // The capture starts ARRIVAL_CAPTURE_TICKS out, and at least half that
  // before the course stops (the world's run is taken off over that),
  // within the second half of the leg.
  const t0 = Math.max(
    startTick + 0.5 * leg,
    // Not before the layout has its place (worldRosters admits it with the
    // state of the tick ARRIVAL_ADMIT_TICKS before it lands).
    Math.ceil(arriveTick - 1e-9) - ARRIVAL_ADMIT_TICKS,
    Math.min(arriveTick - ARRIVAL_CAPTURE_TICKS, stop - 0.5 * ARRIVAL_CAPTURE_TICKS),
  );
  const tEnd = arriveTick + ARRIVAL_SETTLE_TICKS;
  const cEnd = world(arriveTick);
  // (A course already at rest when its capture starts, on a short leg,
  // still has its world's run taken off over a stretch, not at once.)
  const L = Math.max(stop - t0, 0.25 * (arriveTick - t0), 1e-6);
  // The true course (from the world) and the frozen one (from its arrival
  // point) at the capture's start: the differences in distance and
  // bearing, and how fast they are changing, which ease out over L.
  const polar = (t: number, from: P) => {
    const q = torchPositionFromSamples(course, t);
    return { d: Math.hypot(q.x - from.x, q.y - from.y), a: Math.atan2(q.y - from.y, q.x - from.x) };
  };
  const dt0 = Math.max(1e-6, L * 1e-3);
  const e0 = polar(t0, world(t0)), e1 = polar(t0 + dt0, world(t0 + dt0));
  const g0 = polar(t0, cEnd), g1 = polar(t0 + dt0, cEnd);
  // The distance's hand-over. Coming in AHEAD of its world (the world
  // running at it), the true distance is the longer: the difference is
  // eased out, and the drawn distance never falls short of the frozen
  // course's. Coming in from BEHIND (the world running away), the true
  // distance is the shorter, and a difference eased out could overshoot
  // through nothing before the course stopped (the hull drawn inside its
  // floor); there the drawn distance is the frozen course's times a ratio
  // easing to 1, which runs in exactly as the frozen course does.
  const Ld = DISTANCE_HANDOVER * L;
  const asRatio = e0.d < g0.d;
  const ratio = (e: { d: number }, g: { d: number }) => (g.d > 1e-9 ? e.d / g.d : 1);
  const dD0 = asRatio ? ratio(e0, g0) - 1 : e0.d - g0.d;
  const dD0v = ((asRatio ? ratio(e1, g1) - 1 : e1.d - g1.d) - dD0) / dt0 * Ld;
  const dA0 = wrapPi(e0.a - g0.a);
  const dA0v = wrapPi(wrapPi(e1.a - g1.a) - dA0) / dt0 * L;
  const ease = (t: number, v0: number, v0rate: number, span: number) => {
    const u = Math.max(0, Math.min(1, (t - t0) / span));
    return (2 * u * u * u - 3 * u * u + 1) * v0 + (u * u * u - 2 * u * u + u) * v0rate;
  };
  let ca: number | null = null, ga: number | null = null, fa: number | null = null;
  const unwrap = (prev: number | null, raw: number) => (prev == null ? raw : prev + wrapPi(raw - prev));
  const pts: Capture['pts'] = [];
  const at = (t: number) => {
    const q = torchPositionFromSamples(course, t);
    const p = torchPositionFromSamples(placed, t);
    let d: number, a: number;
    if (t <= t0) {
      // Its own course, from the world as it is.
      const c = world(t);
      const vx = q.x - c.x, vy = q.y - c.y;
      d = Math.hypot(vx, vy);
      // The course's bearing from the centre, held while it sits on it.
      if (d > floorR * 1e-4) ca = unwrap(ca, Math.atan2(vy, vx));
      a = ca ?? 0;
    } else {
      // The frozen course, plus what is left of the difference.
      const gx = q.x - cEnd.x, gy = q.y - cEnd.y;
      const gd = Math.hypot(gx, gy);
      if (ga == null) ga = g0.a;
      if (gd > floorR * 1e-4) ga = unwrap(ga, Math.atan2(gy, gx));
      const k = ease(t, dD0, dD0v, Ld);
      d = asRatio ? gd * Math.max(0, 1 + k) : Math.max(0, gd + k);
      a = ga + ease(t, dA0, dA0v, L);
    }
    // Clear of the world: floorR further out than the course, eased in
    // over the start of the capture. The hull then brakes exactly as its
    // course does and stops floorR short of the centre. (Drawn as
    // sqrt(d^2 + floorR^2), the course's last floorR of travel was
    // squeezed into a fraction of it, and a hull still running in fast
    // hit the floor at up to 30 px a frame per frame at a close-up.)
    const lift = t <= t0 ? 0 : smoother((t - t0) / (FLOOR_IN * L));
    const rr = Math.max(d + floorR * lift, floorR * (1 - lift));
    const fx = Math.cos(a) * rr + (p.x - q.x), fy = Math.sin(a) * rr + (p.y - q.y);
    const fr = Math.hypot(fx, fy);
    if (fr > floorR * 1e-4) fa = unwrap(fa, Math.atan2(fy, fx));
    pts.push({ t, r: fr, phi: fa ?? a });
  };
  for (const s of placed) if (s.t < t0) at(s.t);
  for (let i = 0; i <= CAPTURE_SAMPLES; i++) at(t0 + ((tEnd - t0) * i) / CAPTURE_SAMPLES);
  return { bodyId, arriveTick, t0, tEnd, pts };
}

/**
 * Where the hull is at tick `t` on its way in, world units from its
 * world's centre: its formation place (Capture) turning into `slot` (its
 * place in the layout now, world units from the centre) round the
 * outside, distance and bearing eased separately so it never cuts across
 * the world. In the slot, at rest on the world, from `tEnd` on.
 */
export function captureAt(cap: Capture, t: number, slot: P): P {
  const pts = cap.pts;
  let r: number, phi: number;
  if (t <= pts[0].t) { r = pts[0].r; phi = pts[0].phi; }
  else if (t >= pts[pts.length - 1].t) { r = pts[pts.length - 1].r; phi = pts[pts.length - 1].phi; }
  else {
    let i = 1;
    while (i < pts.length - 1 && pts[i].t < t) i++;
    const a = pts[i - 1], b = pts[i];
    const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    r = a.r + (b.r - a.r) * u;
    phi = a.phi + (b.phi - a.phi) * u;
  }
  return turnInto(cap, t, r, phi, slot);
}

/** The turn into the slot laid over the way in (r, phi at tick t). */
function turnInto(cap: Capture, t: number, r: number, phi: number, slot: P): P {
  const turnFrom = cap.arriveTick - ARRIVAL_TURN_TICKS;
  const settleFrom = cap.arriveTick - SETTLE_FROM_TICKS;
  const wa = smoother((t - turnFrom) / (cap.tEnd - turnFrom));
  const wr = smoother((t - settleFrom) / (cap.tEnd - settleFrom));
  const rS = Math.hypot(slot.x, slot.y);
  const thS = Math.atan2(slot.y, slot.x);
  const thStar = thS + Math.PI * 2 * windingOf(cap, thS);
  const rr = r + (rS - r) * wr;
  const aa = phi + (thStar - phi) * wa;
  return { x: Math.cos(aa) * rr, y: Math.sin(aa) * rr };
}

/**
 * Which way round the world the turn goes: the shorter way from where the
 * hull is pointing as the turn begins, chosen ONCE per arrival. Chosen
 * afresh each frame, a slot nearly opposite the approach crossed the
 * antipode as the battle wheel turned it, and the hull reversed its turn
 * in mid-flight (a lone hull in from the far side, 60 px a frame).
 */
function windingOf(cap: Capture, thS: number): number {
  if (cap.winding == null) {
    const ref = phiAt(cap, cap.arriveTick - ARRIVAL_TURN_TICKS);
    cap.winding = Math.round((ref - thS) / (Math.PI * 2));
  }
  return cap.winding;
}

function phiAt(cap: Capture, t: number): number {
  const pts = cap.pts;
  if (t <= pts[0].t) return pts[0].phi;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const a = pts[i - 1], b = pts[i];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return a.phi + (b.phi - a.phi) * u;
    }
  }
  return pts[pts.length - 1].phi;
}

/** The capture each hull is flying, kept from its last frame in flight
 *  so the parked draw carries it on to its end (battleLocalPos). */
const captures = new Map<string, Capture>();

export function noteCapture(shipId: string, cap: Capture | null): void {
  if (!cap) { captures.delete(shipId); return; }
  // The same arrival keeps the way round it chose (windingOf).
  const was = captures.get(shipId);
  if (was && was.bodyId === cap.bodyId && was.arriveTick === cap.arriveTick && was.winding != null) {
    cap.winding = was.winding;
  }
  if (captures.size > 2000) captures.clear();
  captures.set(shipId, cap);
}

/** The capture a hull parked at `bodyId` is still finishing at tick `t`. */
export function activeCapture(shipId: string, bodyId: string, t: number): Capture | null {
  const cap = captures.get(shipId);
  if (!cap) return null;
  if (t > cap.tEnd) { captures.delete(shipId); return null; }
  return cap.bodyId === bodyId ? cap : null;
}

/** Test hook. */
export function resetCaptures(): void {
  captures.clear();
}

/**
 * The hull's samples in flight, flying its capture into `slot` (world
 * units from the centre): its course up to the capture, then the capture
 * drawn densely to its end.
 */
export function captureSamples(cap: Capture, world: (t: number) => P, slot: P): Sample[] {
  return cap.pts.map(p => {
    const c = world(p.t);
    const rel = turnInto(cap, p.t, p.r, p.phi, slot);
    return { t: p.t, x: c.x + rel.x, y: c.y + rel.y };
  });
}
