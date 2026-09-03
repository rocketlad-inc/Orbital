/**
 * Fleet count badges — the pills that stand in for hulls once a system
 * is too small on screen to draw them individually.
 *
 * A badge answers "whose ships, how many, where" at a zoom where the
 * ships themselves are a smear. It has to answer one more thing that it
 * used to get wrong: whether they are actually THERE.
 *
 * In-transit hulls were counted straight into the destination's parked
 * tally, on the reasoning that "four at Callisto" is the useful number
 * at strategic zoom. It isn't. A garrison and an ETA are opposite
 * facts — one you can act with, one you have to brace for — and merging
 * them made the map contradict the fleet list: a colony ship reading
 * T-29 in the panel drew as a pill sitting on Haumea, and a hostile
 * still well out from Quaoar drew as though it had already arrived,
 * with its approach line running to it.
 *
 * So the two tallies stay separate the whole way through, and a segment
 * carries which one it came from. Kept in its own module (rather than
 * inline in MapCanvas's render pass) so the invariant is testable
 * without standing up a canvas.
 */

/** Per-faction head counts for one body or system: factionId -> hulls. */
export type FactionCounts = ReadonlyMap<string, number>;

export interface BadgeSegment {
  factionId: string;
  count: number;
  /** True when these hulls are still under way to this place. */
  arriving: boolean;
  /** What the pill prints — "3" parked, "→3" inbound. */
  label: string;
}

/** Prefix marking a segment as not-here-yet. Paired with a dashed pill
 *  border at the draw site, so the distinction survives both a
 *  colourblind reader and a 13px pill on a dark map. */
export const ARRIVING_PREFIX = '→';

/**
 * Order segments for display: the viewer's own fleet leads, then
 * everyone else by a stable id sort so segments don't reshuffle frame
 * to frame (which reads as flicker on a badge that redraws at 60fps).
 */
function byViewerThenId(viewerFactionId: string) {
  return (a: readonly [string, number], b: readonly [string, number]): number => {
    if (a[0] === b[0]) return 0;
    if (a[0] === viewerFactionId) return -1;
    if (b[0] === viewerFactionId) return 1;
    return a[0] < b[0] ? -1 : 1;
  };
}

/**
 * Build the ordered pill segments for one badge.
 *
 * Parked segments come first so the number you already have reads
 * before the number that is still on its way. Empty and non-positive
 * tallies are dropped — a badge never prints a zero.
 */
export function buildBadgeSegments(
  parked: FactionCounts,
  inbound: FactionCounts,
  viewerFactionId: string,
): BadgeSegment[] {
  const order = byViewerThenId(viewerFactionId);
  const take = (src: FactionCounts, arriving: boolean): BadgeSegment[] =>
    [...src.entries()]
      .filter(([, n]) => Number.isFinite(n) && n > 0)
      .sort(order)
      .map(([factionId, count]) => ({
        factionId,
        count,
        arriving,
        label: (arriving ? ARRIVING_PREFIX : '') + count,
      }));
  return [...take(parked, false), ...take(inbound, true)];
}
