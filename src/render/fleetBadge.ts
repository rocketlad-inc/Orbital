/**
 * Fleet count badges — the pills that stand in for PARKED hulls once a
 * system is too small on screen to draw them individually.
 *
 * Strictly ships that are AT the body. A hull under way is drawn at its
 * real position instead (MapCanvas's transit branch), never counted
 * onto the world it is travelling to: that conflation is what made the
 * map contradict the fleet list — a colony ship reading T-29 in the
 * panel drawn as a pill sitting on Haumea, and a hostile still well out
 * from Quaoar drawn on Quaoar with its approach line running to it, so
 * the line looked like it ended at a marker with no ship.
 *
 * A ship's position is not a detail the map gets to round off. If a
 * badge shows a number, those ships are there.
 *
 * Extracted from MapCanvas's render pass so the ordering and
 * no-phantom-counts rules are testable without standing up a canvas.
 */

/** Per-faction head counts for one body or system: factionId -> hulls. */
export type FactionCounts = ReadonlyMap<string, number>;

export interface BadgeSegment {
  factionId: string;
  /** Hulls actually at this place. Always ≥ 1. */
  count: number;
  /** What the pill prints. */
  label: string;
}

/**
 * Build the ordered pill segments for one badge — one per faction
 * present.
 *
 * The viewer's own fleet leads, then everyone else by a stable id sort
 * so pills don't reshuffle frame to frame (which reads as flicker on a
 * badge that redraws at 60fps). Non-positive tallies are dropped: a
 * badge never prints a zero.
 */
export function buildBadgeSegments(
  parked: FactionCounts,
  viewerFactionId: string,
): BadgeSegment[] {
  const segs: BadgeSegment[] = [];
  for (const [factionId, raw] of parked) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) continue;
    const count = Math.floor(raw);
    segs.push({ factionId, count, label: String(count) });
  }
  segs.sort((a, b) => {
    if (a.factionId === b.factionId) return 0;
    if (a.factionId === viewerFactionId) return -1;
    if (b.factionId === viewerFactionId) return 1;
    return a.factionId < b.factionId ? -1 : 1;
  });
  return segs;
}
