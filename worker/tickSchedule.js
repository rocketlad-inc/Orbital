// ============================================================
// TICK SPEED BY TIME OF DAY (migration 0171).
//
// The host sets periods in a time zone: "from 08:00, a tick every 30
// minutes; from 00:00, every hour". Each runs until the next one's start,
// wrapping at midnight. The game moves faster while everyone is awake and
// slower overnight, so staying up buys less.
//
// Two rules make it predictable:
//   - A tick never runs past a period's start. The 07:40 tick of an
//     hourly night is followed by one at 08:00 sharp, then every 30
//     minutes. Everyone can say when the day speed begins.
//   - games.tick_interval_ms always holds the speed IN FORCE (the alarm
//     rewrites it), so the countdown, the Herald, the market and the
//     emails, which all read it, carry on unchanged.
//
// Pure: no D1, no Date.now(). Time zones through Intl, which Workers
// carry, so daylight saving moves the clock the way the players' does.
// Mirrored for display in src/game/tickSchedule.ts.
// ============================================================

export const MAX_PERIODS = 4;
const DAY_MIN = 24 * 60;

/** "08:00" -> 480, or null. */
export function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Check and normalise a schedule from the host. Returns
 * { schedule } (sorted by start time) or { error }.
 * `allowed` is the set of tick lengths the game accepts.
 */
export function normalizeSchedule(raw, allowed) {
  if (!raw || typeof raw !== 'object') return { error: 'schedule must be an object' };
  if (!validTimeZone(raw.tz)) return { error: 'unknown time zone' };
  const periods = Array.isArray(raw.periods) ? raw.periods : null;
  if (!periods || periods.length < 2 || periods.length > MAX_PERIODS) {
    return { error: `a schedule has 2 to ${MAX_PERIODS} periods` };
  }
  const out = [];
  for (const p of periods) {
    const at = parseHHMM(p?.at);
    if (at == null) return { error: 'each period starts at a time like 08:00' };
    const ms = Number(p?.interval_ms);
    if (!Number.isInteger(ms) || (allowed && !allowed.has(ms))) {
      return { error: 'each period needs one of the tick speeds' };
    }
    if (out.some(o => o.min === at)) return { error: 'two periods start at the same time' };
    out.push({ min: at, at: String(p.at), interval_ms: ms });
  }
  out.sort((a, b) => a.min - b.min);
  return { schedule: { tz: raw.tz, periods: out.map(({ at, interval_ms }) => ({ at, interval_ms })) } };
}

/** Parse the stored column; null for none or garbage (flat speed). */
export function readSchedule(json) {
  if (!json) return null;
  try {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    const n = normalizeSchedule(s, null);
    return n.schedule ?? null;
  } catch { return null; }
}

/** Minutes into the local day at `ms`, and the zone's UTC offset then. */
function localClock(tz, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const v = (t) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'));
  const wholeSec = Math.floor(ms / 1000) * 1000;
  return { min: (v('hour') % 24) * 60 + v('minute'), sec: v('second'), offsetMs: asUtc - wholeSec };
}

/** The period in force at `ms`. */
export function periodAt(schedule, ms) {
  const { min } = localClock(schedule.tz, ms);
  const ps = schedule.periods.map(p => ({ ...p, min: parseHHMM(p.at) }));
  // The last one to have started today, else the last of yesterday.
  let cur = null;
  for (const p of ps) if (p.min <= min) cur = p;
  return cur ?? ps[ps.length - 1];
}

export function intervalAt(schedule, ms) {
  return periodAt(schedule, ms).interval_ms;
}

/** The first period start strictly after `ms`, as epoch ms. */
export function nextBoundaryAfter(schedule, ms) {
  const here = localClock(schedule.tz, ms);
  let best = Infinity;
  for (const p of schedule.periods) {
    const at = parseHHMM(p.at);
    let dMin = (at - here.min + DAY_MIN) % DAY_MIN;
    if (dMin === 0) dMin = DAY_MIN;
    // Wall-clock arithmetic, then corrected by any change of UTC offset
    // in between: across a daylight-saving jump, "08:00" is still 08:00.
    let t = ms - here.sec * 1000 - (ms % 1000) + dMin * 60_000;
    const there = localClock(schedule.tz, t);
    t -= there.offsetMs - here.offsetMs;
    if (t <= ms) t += DAY_MIN * 60_000;
    best = Math.min(best, t);
  }
  return best;
}

/** When the tick after one at `ms` falls: a step at the speed in force,
 *  cut short at the next period's start. */
export function nextTickAt(schedule, ms) {
  const step = ms + intervalAt(schedule, ms);
  const edge = nextBoundaryAfter(schedule, ms);
  return Math.min(step, edge);
}
