// ============================================================
// FLEET FORMATION — which hulls stand together, and where.
//
// Peacetime placement leaves every hull at its own orbital phase, so a
// fleet was scattered around the ring: the one thing that is supposed
// to read as a unit read as strangers sharing a parking orbit.
//
// This decides the GROUPING only. The actual placement reuses the
// battle-line machinery in mapRenderer (ranks, proportional
// separation, screen-space floor, depth cap, per-hull jitter) rather
// than inventing a second rule — a formation is a battle line that is
// not fighting anyone.
//
// Extracted from MapCanvas's render loop so it can be tested. It used
// to be inline in a function that needs a canvas to run, which meant
// the one part that was actually new was the one part nothing could
// check.
// ============================================================

import { hashStr } from './planetTexture';

export interface FleetFormationGroup {
  fleetId: string;
  /** Members in a deterministic order — the index within this array is
   *  the hull's slot in the formation. */
  members: string[];
  /** Bearing the formation holds, radians in [0, 2π). */
  arcCenter: number;
}

/** Tight, so a formation reads as ONE object. A battle line is wider
 *  because it is meant to read as a firing front. */
export const FLEET_ARC_WIDTH = 0.5;

/**
 * Group the hulls parked at one body into formations.
 *
 * A fleet with fewer than two hulls PRESENT is not a formation and is
 * omitted — its lone ship falls through to the normal ring and keeps
 * its true orbital position. A fleet split across two worlds therefore
 * forms at neither until two of its ships are actually together, which
 * is the honest reading of what is on screen.
 *
 * The bearing is hashed from the FLEET ID so a squadron holds the same
 * heading frame to frame. Hashing the membership instead would swing
 * the whole formation across the planet the moment one hull died.
 */
export function fleetFormationGroups(
  ships: Array<{ id: string; fleetId?: string | null }>,
): FleetFormationGroup[] {
  const byFleet = new Map<string, string[]>();
  for (const s of ships) {
    if (!s.fleetId) continue;
    const list = byFleet.get(s.fleetId) || [];
    list.push(s.id);
    byFleet.set(s.fleetId, list);
  }
  const out: FleetFormationGroup[] = [];
  for (const [fleetId, members] of byFleet) {
    if (members.length < 2) continue;
    out.push({
      fleetId,
      members: members.slice().sort((a, b) => a.localeCompare(b)),
      // hashStr is unsigned; 6283 milliradians ≈ 2π.
      arcCenter: (hashStr(fleetId) % 6283) / 1000,
    });
  }
  // Stable order so two fleets at one body never trade arcs between
  // frames purely because the ship list came back differently.
  return out.sort((a, b) => a.fleetId.localeCompare(b.fleetId));
}
