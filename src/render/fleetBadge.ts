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
 * ONE PILL PER FACTION, not one per fact. The first cut gave arrivals
 * their own pill, which was clearer in isolation and worse on the map:
 * every extra pill widens the strip, the strip has to win a slot from
 * labelLayer's twelve, and a badge that cannot find a free slot is
 * DROPPED rather than stacked. Widening the strip to fix "ships that
 * aren't there" would have bought it with "ships that aren't drawn at
 * all" — in the Kuiper cluster, the same neighbourhood the reports came
 * from. So a faction gets one pill carrying both numbers: "2→1" is two
 * parked and one inbound, and it is narrower than the two-pill form by
 * a whole emblem slot.
 *
 * Kept in its own module (rather than inline in MapCanvas's render
 * pass) so the invariant is testable without standing up a canvas.
 */

/** Per-faction head counts for one body or system: factionId -> hulls. */
export type FactionCounts = ReadonlyMap<string, number>;

export interface BadgeSegment {
  factionId: string;
  /** Hulls actually at this place. May be 0 for a pure inbound pill. */
  parked: number;
  /** Hulls still under way to it. May be 0. */
  inbound: number;
  /** What the pill prints — "2", "→1", or "2→1". */
  label: string;
  /** True when NOTHING has arrived yet, so the whole pill is a
   *  prediction. Drawn with a dashed border: the shape itself says
   *  "not here". A mixed pill keeps a solid border — there really are
   *  ships there — and lets the arrow carry the rest. */
  pending: boolean;
}

/** Marks the inbound half of a label. Paired with a dashed border on a
 *  pure-inbound pill, so the distinction survives both a colourblind
 *  reader and a 13px pill on a dark map. */
export const ARRIVING_PREFIX = '→';

/**
 * Build the ordered pill segments for one badge.
 *
 * The viewer's own fleet leads, then everyone else by a stable id sort
 * so pills don't reshuffle frame to frame (which reads as flicker on a
 * badge that redraws at 60fps). A faction with no live hulls either way
 * is dropped — a badge never prints a zero.
 */
export function buildBadgeSegments(
  parked: FactionCounts,
  inbound: FactionCounts,
  viewerFactionId: string,
): BadgeSegment[] {
  const clean = (n: number | undefined): number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

  const factionIds = new Set<string>([...parked.keys(), ...inbound.keys()]);
  const segs: BadgeSegment[] = [];
  for (const factionId of factionIds) {
    const p = clean(parked.get(factionId));
    const i = clean(inbound.get(factionId));
    if (p === 0 && i === 0) continue;
    segs.push({
      factionId,
      parked: p,
      inbound: i,
      label: (p > 0 ? String(p) : '') + (i > 0 ? ARRIVING_PREFIX + i : ''),
      pending: p === 0,
    });
  }

  segs.sort((a, b) => {
    if (a.factionId === b.factionId) return 0;
    if (a.factionId === viewerFactionId) return -1;
    if (b.factionId === viewerFactionId) return 1;
    return a.factionId < b.factionId ? -1 : 1;
  });
  return segs;
}
