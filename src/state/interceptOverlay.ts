// ============================================================
// What the map draws while an intercept picker is open: a ring on each
// group you can catch, the meeting at the door, and — while SHOW has the
// camera — a veil over everything outside the course.
//
// A plain module value the map's draw loop reads each frame, and nothing
// subscribes to it. Not React state on purpose: the map repaints every
// frame anyway, and putting this in context would re-render every panel
// on each pick (see feedback_no_external_store_for_camera — that store
// was SUBSCRIBED to; this one is only polled by the painter).
// ============================================================

export interface InterceptOverlayTarget {
  /** Lead hull of the group; the ring sits where that hull is drawn. */
  leadId: string;
  /** Standing colour (war / allied / peace / yours). */
  color: string;
  selected: boolean;
}

export interface InterceptOverlay {
  /** Which picker set it, so one closing never clears another's. */
  owner: string;
  targets: InterceptOverlayTarget[];
  /** A meeting at the door (world coordinates), when that is the pick. */
  meet: { x: number; y: number; label: string } | null;
  /** World box of the course while SHOW is on; the veil leaves it clear. */
  focus: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

let current: InterceptOverlay | null = null;

export function setInterceptOverlay(o: InterceptOverlay): void {
  current = o;
}

export function clearInterceptOverlay(owner: string): void {
  if (current?.owner === owner) current = null;
}

export function getInterceptOverlay(): InterceptOverlay | null {
  return current;
}
