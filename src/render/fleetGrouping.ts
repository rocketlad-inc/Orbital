// ============================================================
// fleetGrouping — one marker per fleet instead of one per hull.
//
// A 147-hull superfleet drew 147 sprites, 147 trajectory polylines, 147
// hitboxes and 147 selection rings, every frame, all of them stacked on
// essentially the same point. That is not a readable map and it is not
// a cheap one: Noah's report was "my game has slowed to a glacial
// crawl", and the picture he sent is a solid orange smear where a fleet
// should be.
//
// The fleet already knew how to answer this. Fleet.leadShipId is
// documented as "the ship whose position represents the fleet" — this
// module is the first thing to take that literally.
//
// WHAT STILL DRAWS ITSELF:
//   - every ship in no fleet
//   - the flagship, which now stands for the whole squadron
//   - DETACHED members, because detaching is the player saying "that one
//     is doing its own thing" and hiding it would delete the feature
//   - a fleet with no identifiable flagship, which collapses to nothing
//     and must not silently vanish from the map
//
// Pure and free of canvas or React on purpose: the draw loop is the
// hardest place in the codebase to test, so the decision of WHAT to draw
// lives out here where it can be checked directly.
// ============================================================

import type { Ship, Fleet } from '../types';

/** How many escort hulls ride around the flagship before the rest
 *  become a number. Twelve reads as "a formation" at a glance and costs
 *  a rounding error next to 147. */
export const MAX_ESCORT_SPRITES = 12;

export interface FleetMarker {
  fleetId: string;
  /** The hull whose position and sprite the marker is drawn at. */
  leadShipId: string;
  /** Total hulls the marker stands for, INCLUDING the flagship. */
  memberCount: number;
  /** How many escort dots to draw around it (never the flagship). */
  escorts: number;
  /** Members beyond flagship + escorts; 0 when the cluster shows them
   *  all. This is the "+N" on the badge. */
  overflow: number;
}

export interface FleetGrouping {
  /** Ship ids that draw as individual sprites this frame. */
  draws: Set<string>;
  /** Fleet marker keyed by its flagship's ship id, so the draw loop can
   *  ask "am I a fleet marker?" with the id it already has in hand. */
  markerByLeadShip: Map<string, FleetMarker>;
  /** Ship ids folded into a marker — skipped entirely by the renderer.
   *  Exposed so callers can assert the reduction rather than trust it. */
  collapsed: Set<string>;
}

/**
 * Decide what the map draws.
 *
 * `fleets` may be stale relative to `ships` by up to one poll — a hull
 * destroyed this tick is still listed in its fleet. Membership is taken
 * from the SHIPS (ship.fleetId), not from fleet.shipIds, so a dead
 * member cannot hold a slot in the count. fleet rows are consulted only
 * for which hull leads.
 */
export function groupFleetsForRender(
  ships: readonly Ship[],
  fleets: readonly Fleet[] | undefined,
): FleetGrouping {
  const draws = new Set<string>();
  const collapsed = new Set<string>();
  const markerByLeadShip = new Map<string, FleetMarker>();

  const leadOf = new Map<string, string>();
  for (const f of fleets ?? []) {
    if (f.leadShipId) leadOf.set(f.id, f.leadShipId);
  }

  // Live membership, counted off the ships themselves.
  const membersOf = new Map<string, Ship[]>();
  for (const s of ships) {
    const fid = s.fleetId;
    if (!fid || s.fleetDetached) continue;
    let list = membersOf.get(fid);
    if (!list) membersOf.set(fid, (list = []));
    list.push(s);
  }

  for (const s of ships) {
    const fid = s.fleetId;
    // No fleet, or detached from it: draws as itself, always.
    if (!fid || s.fleetDetached) { draws.add(s.id); continue; }

    const lead = leadOf.get(fid);
    const members = membersOf.get(fid) ?? [];

    // A fleet whose flagship is gone, unknown, or itself detached has
    // nothing to collapse ONTO. Every member draws individually rather
    // than the squadron disappearing off the map — the failure mode has
    // to be "too much detail", never "your fleet is invisible".
    if (!lead || !members.some(m => m.id === lead)) { draws.add(s.id); continue; }

    // Two hulls are not a crowd. Collapsing a pair hides one ship to
    // save one sprite, which is a worse map for no gain.
    if (members.length < 3) { draws.add(s.id); continue; }

    if (s.id === lead) {
      draws.add(s.id);
      const escorts = Math.min(members.length - 1, MAX_ESCORT_SPRITES);
      markerByLeadShip.set(s.id, {
        fleetId: fid,
        leadShipId: lead,
        memberCount: members.length,
        escorts,
        overflow: members.length - 1 - escorts,
      });
    } else {
      collapsed.add(s.id);
    }
  }

  return { draws, markerByLeadShip, collapsed };
}

/**
 * Escort offsets around the flagship, in SCREEN pixels.
 *
 * A wedge, not a ring: a ring reads as a station and gives the fleet no
 * heading, while a wedge trailing the flagship reads as a formation
 * under way and points where it is going. Deterministic in the index so
 * a hull holds its slot between frames instead of shimmering.
 *
 * `heading` is the flagship's facing in radians; pass 0 for a parked
 * fleet, where there is no direction to hold.
 */
export function escortOffsets(count: number, spacing: number, heading: number)
  : Array<{ dx: number; dy: number }> {
  const out: Array<{ dx: number; dy: number }> = [];
  // Rows of 2, 3, 4, ... widening behind the leader.
  let placed = 0;
  let row = 1;
  while (placed < count) {
    const inRow = Math.min(row + 1, count - placed);
    for (let i = 0; i < inRow; i++) {
      // Centre each row on the axis, offset back by the row index.
      const across = (i - (inRow - 1) / 2) * spacing;
      const back = row * spacing * 0.85;
      // Local frame has FORWARD along +x, so astern is -x and abeam is
      // y. Rotate that into the flagship's heading. (Written the other
      // way round first, which put the whole formation abeam instead of
      // behind — every escort flying alongside at a right angle.)
      const lx = -back;
      const ly = across;
      out.push({
        dx: lx * Math.cos(heading) - ly * Math.sin(heading),
        dy: lx * Math.sin(heading) + ly * Math.cos(heading),
      });
    }
    placed += inRow;
    row += 1;
  }
  return out;
}
