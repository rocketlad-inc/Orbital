// ============================================================================
// shotPlan.ts — the director's arithmetic, kept pure so it can be tested.
//
// Two things a shot gets wrong without them (Lorne, 2026-10-21, over the
// Mega Destroyer clip: "an incoherent mess"):
//
//   ARC PANS. A long pan at close zoom slid the camera through empty space:
//   whole seconds of starfield with neither end on screen, and a launch at
//   the far end missed because the camera was still in transit. A pan whose
//   target starts off-screen now pulls back until both ends fit, moves, and
//   pushes back in, all inside the same `ms`.
//
//   STRIKE TIMING. A strike step fired while its Mega Destroyer was still in
//   flight does nothing (the server refuses an armed strike in flight), so
//   the clip ends on a world where nothing happens. The shot's tick steps
//   are known in advance and so is the hull's arrival, so the director can
//   say so before filming a single frame.
// ============================================================================

export interface Cam { x: number; y: number; scale: number }
export interface View { w: number; h: number }

const easeInOut = (u: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;

/** The part of the frame both ends must sit inside at the top of an arc. */
const ARC_FIT = 0.8;
/** A target further than this share of the frame's half-size from the
 *  centre counts as off-screen, so the pan arcs. */
const ARC_OFFSCREEN = 0.9;

/** Does a pan from `from` to a target at (tx, ty) need to pull back? True
 *  when, at either end's zoom, the far end would be off the frame. */
export function arcNeeded(from: Cam, tx: number, ty: number, toScale: number, view: View): boolean {
  const d = Math.hypot(tx - from.x, ty - from.y);
  const half = Math.min(view.w, view.h) / 2;
  return d * Math.min(from.scale, toScale) > half * ARC_OFFSCREEN;
}

/** The zoom at the top of an arc: both ends inside ARC_FIT of the frame,
 *  never closer than either end already is. */
export function arcApexScale(from: Cam, tx: number, ty: number, toScale: number, view: View): number {
  const d = Math.hypot(tx - from.x, ty - from.y);
  const fit = d > 0 ? (Math.min(view.w, view.h) * ARC_FIT) / d : Infinity;
  return Math.min(from.scale, toScale, fit);
}

/**
 * The camera at progress u (0..1) of a pan. Without an arc: position and
 * zoom both ease from start to end (zoom in log space, so it feels even).
 * With an arc: the zoom follows the plain ease with a dip that bottoms at
 * the apex halfway through, and the position moves mostly while pulled
 * back, so neither end ever leaves the frame for long.
 */
export function panCamera(u: number, from: Cam, tx: number, ty: number, toScale: number, arc: { apex: number } | null): Cam {
  const k = Math.min(1, Math.max(0, u));
  const lf = Math.log(from.scale), lt = Math.log(toScale);
  if (!arc) {
    const e = easeInOut(k);
    const scale = Math.exp(lf + (lt - lf) * e);
    // Travel at the zoom's pace on screen, not in the world: zooming out,
    // the start stays no further from centre than the end frame puts it;
    // zooming in, the target does. Moving the centre at the plain ease left
    // a close-up's subject before the view had widened (judges 2026-10-23:
    // a second of empty starfield off Ganymede). A pan at one zoom is plain.
    let g = e;
    if (lt < lf - 0.1) g = (from.scale / scale - 1) / (from.scale / toScale - 1);
    else if (lt > lf + 0.1) g = 1 - (toScale / scale - 1) / (toScale / from.scale - 1);
    return { x: from.x + (tx - from.x) * g, y: from.y + (ty - from.y) * g, scale };
  }
  const e = easeInOut(k);
  const plain = lf + (lt - lf) * e;
  // The dip that takes the plain curve down to the apex at the middle.
  const depth = Math.max(0, (lf + lt) / 2 - Math.log(arc.apex));
  // Along the eased clock, so the pull-back starts (and lands) at rest:
  // on the raw clock the dip began at full rate, and a pan off a close-up
  // shrank the world a quarter in its first frame.
  const scale = Math.exp(plain - depth * Math.sin(Math.PI * e));
  // Move while pulled back: the middle 70% of the time carries the travel.
  const ep = easeInOut((k - 0.15) / 0.7);
  return { x: from.x + (tx - from.x) * ep, y: from.y + (ty - from.y) * ep, scale };
}

export interface StepLike { at: number; do: string; n?: number; ship?: string }

/** Ticks the shot will have landed when step `i` fires, from `startTick`.
 *  Steps run in time order, and in list order at the same time. */
export function tickAtStep(steps: readonly StepLike[], i: number, startTick: number): number {
  const at = steps[i].at;
  let t = startTick;
  steps.forEach((s, j) => {
    if (s.do !== 'tick') return;
    if (s.at < at - 1e-9 || (Math.abs(s.at - at) <= 1e-9 && j < i)) t += Math.max(1, Math.round(s.n ?? 1));
  });
  return t;
}

/**
 * Strike steps that will fire before their hull has arrived. `arrivalOf`
 * answers the tick a ship lands (null when it is already parked, undefined
 * when there is no such ship). Each warning says when the strike could go.
 */
export function strikeTimingWarnings(
  steps: readonly StepLike[],
  startTick: number,
  arrivalOf: (ship: string) => number | null | undefined,
): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => {
    if (s.do !== 'strike' || !s.ship) return;
    const arrive = arrivalOf(s.ship);
    if (arrive === undefined) { out.push(`steps[${i}] strike at ${s.at}s: no ship ${s.ship} in this game`); return; }
    if (arrive === null) return;
    const at = tickAtStep(steps, i, startTick);
    if (at >= Math.ceil(arrive - 1e-9)) return;
    // The first tick step after which it has landed.
    let t = startTick;
    let ok: number | null = null;
    for (const st of [...steps].filter(x => x.do === 'tick').sort((a, b) => a.at - b.at)) {
      t += Math.max(1, Math.round(st.n ?? 1));
      if (t >= Math.ceil(arrive - 1e-9)) { ok = st.at; break; }
    }
    out.push(`steps[${i}] strike at ${s.at}s: ${s.ship} is still in flight then (tick ${at}, lands at tick ${Math.ceil(arrive)}); `
      + (ok != null ? `strike after the tick step at ${ok}s` : 'the shot never ticks far enough for it to land')
      + ', or the strike does nothing');
  });
  return out;
}
