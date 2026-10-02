// ============================================================
// storyVerdict — reading an empire's game from its numbers.
//
// The admin game page used to answer "what are the yields" and "how do
// fights resolve". The playtesting question is different: for each
// empire, did it hit trouble, and did it come back? This turns the
// story endpoint's trajectory (worker/adminDashboard.js
// handleGameStory) into a verdict a person can scan in one line, with
// the evidence that produced it.
//
// Pure functions only, so the rules are tested rather than eyeballed.
// ============================================================

/** [tick, settlements, ships, metal, credits, science] */
export type StoryPoint = [number, number, number, number, number, number];

export type StoryEvent = {
  t: number;
  kind: string;
  f: string | null;
  o: string | null;
  d: Record<string, unknown>;
};

export type VerdictKey = 'out' | 'struggling' | 'recovered' | 'stalled' | 'growing' | 'new';

export type Verdict = {
  key: VerdictKey;
  label: string;
  /** One sentence of evidence: what in the numbers produced the label. */
  reason: string;
  /** Ticks where something went wrong for this empire, for markers. */
  setbacks: Array<{ t: number; what: string }>;
};

export const VERDICT_LABEL: Record<VerdictKey, string> = {
  out: 'Out',
  struggling: 'Struggling',
  recovered: 'Recovered',
  stalled: 'Stalled',
  growing: 'Growing',
  new: 'Just started',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Setbacks: a colony lost (a drop in the settlement count, or a
 * destroyed/seized event), the fleet cut to half its peak or less, or
 * falling into arrears. Consecutive arrears ticks count once.
 */
export function findSetbacks(
  factionId: string,
  series: StoryPoint[],
  events: StoryEvent[],
  arrearsTicks: number[],
): Array<{ t: number; what: string }> {
  const out: Array<{ t: number; what: string }> = [];
  for (const e of events) {
    if (e.kind === 'settlement_destroyed' && e.f === factionId) {
      out.push({ t: e.t, what: `lost ${e.d.name ?? 'a colony'}` });
    } else if (e.kind === 'settlement_seized' && e.o === factionId) {
      out.push({ t: e.t, what: `had ${e.d.name ?? 'a colony'} seized` });
    } else if (e.kind === 'faction_eliminated' && e.f === factionId) {
      out.push({ t: e.t, what: 'was eliminated' });
    }
  }
  // Settlement drops the events did not explain (older games, razing).
  const evTicks = new Set(out.map(s => s.t));
  for (let i = 1; i < series.length; i++) {
    const [t, s] = series[i];
    const prev = series[i - 1][1];
    if (s < prev && ![...evTicks].some(et => et > series[i - 1][0] && et <= t)) {
      out.push({ t, what: `dropped to ${plural(s, 'colony', 'colonies')}` });
    }
  }
  // Fleet halved: the first point at or below half the running peak,
  // once per collapse (re-arms after the fleet regrows past the peak).
  let peakShips = 0;
  let armed = true;
  for (const [t, , ships] of series) {
    if (ships > peakShips) { peakShips = ships; armed = true; }
    if (armed && peakShips >= 4 && ships <= peakShips / 2) {
      out.push({ t, what: `fleet cut to ${ships} from ${peakShips}` });
      armed = false;
    }
  }
  // One setback per unbroken run of arrears ticks.
  let prev: number | null = null;
  for (const t of [...arrearsTicks].sort((a, b) => a - b)) {
    if (prev == null || t > prev + 1) out.push({ t, what: 'fell into arrears' });
    prev = t;
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * One verdict per empire. Precedence, first match wins:
 *   out        eliminated (and not revived since), or no longer active
 *   new        fewer than 5 ticks of history - nothing to read yet
 *   struggling in arrears now, or colonies below their peak since a loss
 *   recovered  had a setback and is back at or above where it was
 *   growing    more colonies or a bigger fleet over the recent stretch
 *   stalled    nothing grew over the recent stretch
 * "Recent stretch" = the last quarter of the game so far, at least 10
 * ticks, so a long game is judged on its present, not its opening.
 */
export function verdictFor(args: {
  factionId: string;
  status: string;
  series: StoryPoint[];
  events: StoryEvent[];
  arrearsTicks: number[];
  currentTick: number;
}): Verdict {
  const { factionId, status, series, events, arrearsTicks, currentTick } = args;
  const setbacks = findSetbacks(factionId, series, events, arrearsTicks);
  const v = (key: VerdictKey, reason: string): Verdict => ({ key, label: VERDICT_LABEL[key], reason, setbacks });

  const elim = events.filter(e => e.f === factionId && e.kind === 'faction_eliminated').slice(-1)[0];
  const revived = events.filter(e => e.f === factionId && e.kind === 'faction_revived').slice(-1)[0];
  if ((elim && (!revived || revived.t < elim.t)) || (status && status !== 'active' && status !== 'vacated')) {
    const cause = elim?.d?.cause === 'no_settlements' ? ' after losing every colony' : '';
    return v('out', elim ? `Eliminated at T${elim.t}${cause}.` : `No longer in the game (${status}).`);
  }
  if (series.length < 2 || series[series.length - 1][0] - series[0][0] < 5) {
    return v('new', 'Too early to read: fewer than five ticks recorded.');
  }

  const last = series[series.length - 1];
  const [, colonies, ships] = last;
  const peakColonies = Math.max(...series.map(p => p[1]));
  const arrearsNow = arrearsTicks.length > 0 && Math.max(...arrearsTicks) >= currentTick - 2;
  if (arrearsNow) {
    const runFrom = [...arrearsTicks].sort((a, b) => b - a)
      .reduce((from, t) => (t === from - 1 ? t : from), Math.max(...arrearsTicks));
    return v('struggling', `In arrears since T${runFrom}: upkeep is costing more than the empire earns.`);
  }
  const lastLoss = setbacks.filter(s => /lost|seized|dropped/.test(s.what)).slice(-1)[0];
  if (colonies < peakColonies && lastLoss) {
    return v('struggling', `Down to ${plural(colonies, 'colony', 'colonies')} from a peak of ${peakColonies}; ${lastLoss.what} at T${lastLoss.t}.`);
  }
  if (setbacks.length > 0) {
    const s = setbacks[setbacks.length - 1];
    const before = [...series].reverse().find(p => p[0] < s.t) ?? series[0];
    const backColonies = colonies >= before[1];
    const backShips = ships >= before[2] || !/fleet/.test(s.what);
    if (backColonies && backShips) {
      return v('recovered', `${s.what[0].toUpperCase()}${s.what.slice(1)} at T${s.t}; back to ${plural(colonies, 'colony', 'colonies')} and ${plural(ships, 'ship')} now.`);
    }
  }

  const span = Math.max(10, Math.round((last[0] - series[0][0]) / 4));
  const ref = [...series].reverse().find(p => p[0] <= last[0] - span) ?? series[0];
  if (colonies > ref[1] || ships > ref[2]) {
    const bits = [];
    if (colonies > ref[1]) bits.push(`colonies ${ref[1]} → ${colonies}`);
    if (ships > ref[2]) bits.push(`ships ${ref[2]} → ${ships}`);
    return v('growing', `Since T${ref[0]}: ${bits.join(', ')}.`);
  }
  return v('stalled', `No new colonies or ships since T${ref[0]} (${plural(colonies, 'colony', 'colonies')}, ${plural(ships, 'ship')}).`);
}

/** Wall-clock ms -> approximate tick, from the story's [tick, ms] pairs. */
export function tickAt(ticks: Array<[number, number]>, ms: number): number | null {
  if (ticks.length === 0) return null;
  if (ms <= ticks[0][1]) return ticks[0][0];
  for (let i = 1; i < ticks.length; i++) {
    const [t1, m1] = ticks[i];
    if (ms <= m1) {
      const [t0, m0] = ticks[i - 1];
      return Math.round(t0 + ((ms - m0) / Math.max(1, m1 - m0)) * (t1 - t0));
    }
  }
  return ticks[ticks.length - 1][0];
}

/** "3h 20m" / "2d 4h" for how long a first step took. */
export function span(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return 'under a minute';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
