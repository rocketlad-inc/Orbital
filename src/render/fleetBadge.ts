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

/** Most pills on one line of a badge. */
export const BADGE_ROW_MAX = 4;

export interface BadgeLayout {
  /** The whole badge, the box the label solver places. */
  w: number;
  h: number;
  /** Each pill's offset inside that box, in entry order. */
  pills: Array<{ x: number; y: number; w: number }>;
}

/**
 * Lay a badge's pills out in rows of at most BADGE_ROW_MAX, balanced
 * (8 -> 4 + 4, 5 -> 3 + 2) and centred, so a short last row sits under
 * the middle of the one above.
 *
 * Eight empires parked at one place printed a single strip of eight
 * pills, ~400px wide, off a system 20px across at full zoom-out. Nowhere
 * near the system had room for it, so the label solver hung it a screen
 * away, where it read as stray icons (Lorne, 2026-10-06). Four or fewer
 * stay one row, exactly as before.
 */
export function layoutBadgePills(
  widths: readonly number[],
  pillH: number,
  gap: number,
  perRow: number = BADGE_ROW_MAX,
): BadgeLayout {
  const n = widths.length;
  if (n === 0) return { w: 0, h: 0, pills: [] };
  const rowCount = Math.ceil(n / Math.max(1, perRow));
  const per = Math.ceil(n / rowCount);
  const rows: number[][] = [];
  for (let i = 0; i < n; i += per) {
    rows.push(Array.from({ length: Math.min(per, n - i) }, (_, k) => i + k));
  }
  const rowW = rows.map(r => r.reduce((s, i) => s + widths[i], 0) + gap * (r.length - 1));
  const w = Math.max(...rowW);
  const h = rows.length * pillH + (rows.length - 1) * gap;
  const pills: BadgeLayout['pills'] = new Array(n);
  rows.forEach((r, ri) => {
    let x = (w - rowW[ri]) / 2;
    for (const i of r) {
      pills[i] = { x, y: ri * (pillH + gap), w: widths[i] };
      x += widths[i] + gap;
    }
  });
  return { w, h, pills };
}
