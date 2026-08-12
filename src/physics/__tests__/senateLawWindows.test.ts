// [pure] Law windows: duration, expiry warnings, and repeal guards.
//
// These encode rules that live in worker/senate.js and are easy to break
// silently, because every one of them is invisible until a real game runs
// for a day:
//
//   - a slider law stands 24 ticks (a full term), not 7
//   - the 4h / 1h warnings convert WALL CLOCK to ticks using the game's
//     own tick_interval_ms, never a fixed tick count
//   - a threshold shorter than one tick still fires once, on the last
//     tick before the law lapses, instead of never firing
//   - a warning never fires for a law that has already lapsed
//   - repeal refuses anything that isn't a standing law
//
// Kept in step with EFFECT_TICKS, the warn sweep in resolveSenate, and
// buildBillPayload's repeal_law branch.

const EFFECT_TICKS = 24;
const HOUR_MS = 3600 * 1000;

/** Mirror of the sweep's threshold maths. */
function ticksForStage(hours: number, intervalMs: number): number {
  return Math.max(1, Math.floor((hours * HOUR_MS) / intervalMs));
}

/** Mirror of the sweep's row filter for one stage. */
function shouldWarn(opts: {
  hours: number;
  intervalMs: number;
  tick: number;
  effectUntilTick: number;
  alreadyStamped: boolean;
  repealed: boolean;
}): boolean {
  const { hours, intervalMs, tick, effectUntilTick, alreadyStamped, repealed } = opts;
  if (alreadyStamped || repealed) return false;
  if (!(intervalMs > 0)) return false;
  if (effectUntilTick <= tick) return false;              // already lapsed
  return effectUntilTick - tick <= ticksForStage(hours, intervalMs);
}

describe('[pure] slider law duration', () => {
  it('stands for a full 24-tick term', () => {
    expect(EFFECT_TICKS).toBe(24);
  });

  it('expires 24 ticks after the tick it passed on', () => {
    const passedAt = 37;
    expect(passedAt + EFFECT_TICKS).toBe(61);
  });
});

describe('[pure] expiry warning thresholds', () => {
  it('converts hours to ticks with the GAME clock, not a fixed count', () => {
    // hour-long ticks: 4h = 4 ticks, 1h = 1 tick
    expect(ticksForStage(4, 60 * 60 * 1000)).toBe(4);
    expect(ticksForStage(1, 60 * 60 * 1000)).toBe(1);
    // half-hour ticks: the same wall clock is twice the ticks
    expect(ticksForStage(4, 30 * 60 * 1000)).toBe(8);
    expect(ticksForStage(1, 30 * 60 * 1000)).toBe(2);
    // 30-second sim room
    expect(ticksForStage(1, 30 * 1000)).toBe(120);
  });

  it('still fires once when a threshold is shorter than one tick', () => {
    // Day-long ticks: "1 hour left" is never observable, but the warning
    // must not vanish — it fires on the last tick before the lapse.
    const dayMs = 24 * 60 * 60 * 1000;
    expect(ticksForStage(1, dayMs)).toBe(1);
    expect(shouldWarn({
      hours: 1, intervalMs: dayMs, tick: 60, effectUntilTick: 61,
      alreadyStamped: false, repealed: false,
    })).toBe(true);
  });

  it('fires the 4h warning only inside the window', () => {
    const base = {
      hours: 4, intervalMs: 60 * 60 * 1000,
      alreadyStamped: false, repealed: false,
    };
    // 5 ticks out — too early
    expect(shouldWarn({ ...base, tick: 56, effectUntilTick: 61 })).toBe(false);
    // exactly 4 ticks out — fires
    expect(shouldWarn({ ...base, tick: 57, effectUntilTick: 61 })).toBe(true);
    // 1 tick out — still inside the 4h window
    expect(shouldWarn({ ...base, tick: 60, effectUntilTick: 61 })).toBe(true);
  });

  it('never warns about a law that has already lapsed', () => {
    const base = {
      hours: 4, intervalMs: 60 * 60 * 1000,
      alreadyStamped: false, repealed: false,
    };
    expect(shouldWarn({ ...base, tick: 61, effectUntilTick: 61 })).toBe(false);
    expect(shouldWarn({ ...base, tick: 99, effectUntilTick: 61 })).toBe(false);
  });

  it('warns at most once per stage (the stamp is the guard)', () => {
    const base = {
      hours: 1, intervalMs: 60 * 60 * 1000,
      tick: 60, effectUntilTick: 61, repealed: false,
    };
    expect(shouldWarn({ ...base, alreadyStamped: false })).toBe(true);
    expect(shouldWarn({ ...base, alreadyStamped: true })).toBe(false);
  });

  it('does not warn about a law the chamber already repealed', () => {
    expect(shouldWarn({
      hours: 4, intervalMs: 60 * 60 * 1000, tick: 58, effectUntilTick: 61,
      alreadyStamped: false, repealed: true,
    })).toBe(false);
  });

  it('skips both stages when the tick interval is unusable', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(shouldWarn({
        hours: 4, intervalMs: bad, tick: 58, effectUntilTick: 61,
        alreadyStamped: false, repealed: false,
      })).toBe(false);
    }
  });
});

// Mirror of buildBillPayload's repeal_law guards.
type Target = {
  status: string;
  effectUntilTick: number | null;
  repealedAtTick: number | null;
} | null;

function repealRefusal(target: Target, nowTick: number, rivalPending: boolean): string | null {
  if (!target) return 'not_found';
  if (target.status !== 'passed') return 'not_a_law';
  if (target.repealedAtTick != null) return 'already_repealed';
  if (target.effectUntilTick == null || target.effectUntilTick <= nowTick) return 'not_in_force';
  if (rivalPending) return 'repeal_pending';
  return null;
}

describe('[pure] repeal guards', () => {
  const standing: Target = { status: 'passed', effectUntilTick: 61, repealedAtTick: null };

  it('accepts a law that is actually standing', () => {
    expect(repealRefusal(standing, 40, false)).toBeNull();
  });

  it('refuses a law that never passed', () => {
    expect(repealRefusal({ ...standing, status: 'failed' }, 40, false)).toBe('not_a_law');
    expect(repealRefusal({ ...standing, status: 'voting' }, 40, false)).toBe('not_a_law');
  });

  it('refuses a law whose window has already closed', () => {
    expect(repealRefusal({ ...standing, effectUntilTick: 40 }, 40, false)).toBe('not_in_force');
    // One-shot bills (reparations, chancellor) have no ongoing window.
    expect(repealRefusal({ ...standing, effectUntilTick: null }, 40, false)).toBe('not_in_force');
  });

  it('refuses a law already struck down', () => {
    expect(repealRefusal({ ...standing, repealedAtTick: 39 }, 40, false)).toBe('already_repealed');
  });

  it('refuses a second repeal racing the first', () => {
    // Two live repeals against one law means the loser resolves against
    // something already dead.
    expect(repealRefusal(standing, 40, true)).toBe('repeal_pending');
  });

  it('refuses an unknown law', () => {
    expect(repealRefusal(null, 40, false)).toBe('not_found');
  });
});
