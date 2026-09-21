// ============================================================
// Staging (and un-staging) a rendezvous PREVIEW without touching the
// rendezvous a ship is actually flying.
//
// Reported by Noah: "When clicking on fleets that are intercepting,
// sometimes their flight paths bug out. They'll jump around and act
// like they're travelling to the destination planet, but when you
// refresh, they're back on the intercepting flight path."
//
// One field, two meanings. Ship.plannedRendezvous was written as the
// panel's local preview — and the multiplayer mapper also fills it
// with the COMMITTED intercept the server sent back, because that is
// what the renderer samples to put the hull on its real course. The
// ShipPanel clears its preview whenever it closes or moves to another
// hull, and "clear" was `plannedRendezvous = undefined` — which erased
// the committed intercept too. With nothing to sample, the hull fell
// back to the plain flip-and-burn to the leg's target body (the
// destination planet), and stayed there until a reload re-mapped the
// state.
//
// So a preview is now MARKED staged, remembers the committed plan it
// was drawn over, and clearing only ever removes a staged preview.
// ============================================================

import type { Ship } from '../types';

type Rendezvous = NonNullable<Ship['plannedRendezvous']>;

/** The committed plan under whatever this ship is showing, if any. */
function committedOf(cur: Ship['plannedRendezvous']): Rendezvous | undefined {
  if (!cur) return undefined;
  return cur.staged ? cur.committedBehind : cur;
}

/**
 * The ship with `plan` staged as a preview, or with its preview
 * cleared when `plan` is null. A committed rendezvous is never lost:
 * staging draws over it, clearing hands it back.
 */
export function withRendezvousPreview(ship: Ship, plan: Rendezvous | null): Ship {
  const cur = ship.plannedRendezvous;
  const committed = committedOf(cur);
  if (!plan) {
    // Nothing staged: nothing to clear. Returning the same object also
    // means a cleanup on a committed hull costs no re-render.
    if (!cur?.staged) return ship;
    return { ...ship, plannedRendezvous: committed };
  }
  return {
    ...ship,
    plannedRendezvous: { ...plan, staged: true, committedBehind: committed },
  };
}
