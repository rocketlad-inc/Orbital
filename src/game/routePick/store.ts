// ============================================================
// Route-pick store — "click the map to add a stop".
//
// The composer lives in a DOCK PANEL and the map is a sibling canvas
// with no shared ancestor that owns both, so the composer's
// onRequestMapPick prop had nowhere to come from and map picking was
// never actually wired: you could only choose stops from the list.
// That list is fine for a two-stop run and hopeless for "which of
// Jupiter's four moons did I mean".
//
// Rather than thread props through MapCanvas and mapRenderer — shared
// with single-player, where none of this exists — this mirrors the
// worldMenu store: a module-level flag the panel sets and the map
// reads. Single-player never enters pick mode, so every branch keyed
// off it is dead there.
// ============================================================

export interface RoutePickRequest {
  /** Bodies the composer will accept. Anything else is drawn dimmed and
   *  refuses the click, so "why did nothing happen" never arises. */
  eligibleBodyIds: Set<string>;
  /** Already on the route — still clickable (to re-add a stop) but
   *  marked, so a four-stop circuit reads as a circuit on the map. */
  chosenBodyIds: Set<string>;
  /** Called with the body the player clicked. */
  onPick: (bodyId: string) => void;
  /** Esc, or a second click on the Pick button. */
  onCancel: () => void;
}

let request: RoutePickRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to enter/leave. MapCanvas re-renders off this so the dim
 *  pass appears the moment the button is pressed. */
export function subscribeRoutePick(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function beginRoutePick(req: RoutePickRequest): void {
  request = req;
  emit();
}

export function endRoutePick(): void {
  if (!request) return;
  request = null;
  emit();
}

export function getRoutePick(): RoutePickRequest | null {
  return request;
}

export const isRoutePicking = (): boolean => request !== null;

/** Can this body be chosen right now? False for everything while not
 *  picking, so callers can ask without checking the mode first. */
export function isPickEligible(bodyId: string): boolean {
  return !!request && request.eligibleBodyIds.has(bodyId);
}

export function isPickChosen(bodyId: string): boolean {
  return !!request && request.chosenBodyIds.has(bodyId);
}

/** The map calls this on a body click while picking. Returns true when
 *  it consumed the click — the caller must then NOT run its usual
 *  select/fly-to behaviour, or picking a stop would also dive the
 *  camera into that world's menu. */
export function offerPick(bodyId: string): boolean {
  if (!request) return false;
  if (!request.eligibleBodyIds.has(bodyId)) return true;  // consumed, ignored
  request.onPick(bodyId);
  return true;
}

// ---------------------------------------------------------------
// FIT TO BOUNDS. focusBody frames ONE world, which is the wrong verb
// for a route: a milk run's whole point is the set of stops, and
// framing the last one you clicked hides the rest. This computes the
// camera that shows them all, with the caller applying it — the store
// stays free of camera plumbing.
// ---------------------------------------------------------------
export interface FitResult { x: number; y: number; scale: number }

/** Bodies ORBIT — there is no stored x/y to read, so the caller resolves
 *  each stop's position for the current tick (bodyPosition) and hands
 *  the points in. Keeping the geometry here and the ephemeris there is
 *  also what lets this be unit-tested without a renderer. */
export function fitToPoints(
  points: Array<{ x: number; y: number }>,
  viewport: { width: number; height: number },
  opts?: { padding?: number; minScale?: number; maxScale?: number },
): FitResult | null {
  const pts = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length === 0) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const pad = opts?.padding ?? 1.35;      // breathing room around the set
  const spanX = Math.max(1e-6, (maxX - minX) * pad);
  const spanY = Math.max(1e-6, (maxY - minY) * pad);
  // A single stop has no span at all; fall back to a readable view
  // rather than dividing by ~zero and slamming to maximum zoom.
  const single = (maxX - minX) < 1e-6 && (maxY - minY) < 1e-6;
  const raw = single
    ? (opts?.minScale ?? 0.35) * 4
    : Math.min(viewport.width / spanX, viewport.height / spanY);

  const scale = Math.max(opts?.minScale ?? 0.02, Math.min(opts?.maxScale ?? 50, raw));
  return { x: cx, y: cy, scale };
}

// ---------------------------------------------------------------
// FRAME THESE STOPS. The composer knows WHICH bodies matter; only the
// map knows where they are this tick and how big the viewport is. So
// the panel posts a request and the canvas fulfils it — the same
// direction the pick itself travels, and it keeps the composer clear
// of the game context it is forbidden from touching (it is a dock
// panel; see the styleWiring test).
// ---------------------------------------------------------------
let fitRequest: string[] | null = null;

export function requestRouteFit(bodyIds: string[]): void {
  fitRequest = bodyIds.slice();
  emit();
}

/** Consume-once: returns the pending request and clears it, so a frame
 *  that has already framed the set does not fight the player's own
 *  panning on every subsequent frame. */
export function takeRouteFit(): string[] | null {
  const r = fitRequest;
  fitRequest = null;
  return r;
}

// ---------------------------------------------------------------
// CLUSTERS. Zoomed out, Jupiter's moons are one smudge — a click there
// means "one of these four" and picking whichever happened to be first
// in the bodies array is a coin toss the player didn't ask to flip. The
// map posts the candidates; the composer asks which, in the panel the
// player is already looking at (a floating popover over a dimmed map
// would be a second place to look at the worst moment).
// ---------------------------------------------------------------
let clusterListener: ((ids: string[]) => void) | null = null;

export function setClusterHandler(fn: ((ids: string[]) => void) | null): void {
  clusterListener = fn;
}

/** Offer several overlapping candidates at once. Returns true if the
 *  click was consumed. One candidate picks immediately — a disambiguator
 *  with a single option is just a slower click. */
export function offerPickCluster(bodyIds: string[]): boolean {
  if (!request) return false;
  const eligible = bodyIds.filter(id => request!.eligibleBodyIds.has(id));
  if (eligible.length === 0) return true;          // consumed, nothing to pick
  if (eligible.length === 1) { request.onPick(eligible[0]); return true; }
  if (clusterListener) clusterListener(eligible);
  else request.onPick(eligible[0]);                // no UI mounted: don't stall
  return true;
}
