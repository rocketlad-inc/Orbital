import { solveLockstepThrottle, arrivalSpread, MIN_THROTTLE } from '../lockstep';

// A brachistochrone hull: T = 2*sqrt(d/a), so travel scales as
// 1/sqrt(mul). `base` is its travel time at full burn.
const fleet = (base: Record<string, number>, now = 0) =>
  (id: string, mul: number) =>
    (base[id] != null ? now + base[id] / Math.sqrt(mul) : null);

const landsOn = (t: number) => Math.ceil(t);

describe('solveLockstepThrottle', () => {
  it('brings a mixed-speed group onto one arrival tick', () => {
    const base = { fast: 4.0, mid: 7.0, slow: 11.0 };
    const arriveAt = fleet(base);
    const muls = solveLockstepThrottle(['fast', 'mid', 'slow'], arriveAt, 0);
    const ticks = ['fast', 'mid', 'slow']
      .map(id => landsOn(arriveAt(id, muls.get(id)!)!));
    expect(arrivalSpread(ticks)).toBe(0);
  });

  it('the slowest hull flies at full burn — it sets the pace', () => {
    const muls = solveLockstepThrottle(['fast', 'slow'], fleet({ fast: 4, slow: 11 }), 0);
    expect(muls.get('slow')).toBe(1);
    expect(muls.get('fast')).toBeLessThan(1);
  });

  it('never throttles above full burn — nobody gets a speed boost', () => {
    const muls = solveLockstepThrottle(['a', 'b', 'c'], fleet({ a: 4, b: 7, c: 11 }), 0);
    for (const m of muls.values()) expect(m).toBeLessThanOrEqual(1);
  });

  it('refuses to crawl below the floor', () => {
    // One derelict against a very fast hull: matching it exactly would
    // mean a near-standstill, which is worse than arriving apart.
    const muls = solveLockstepThrottle(['quick', 'derelict'], fleet({ quick: 1, derelict: 400 }), 0);
    expect(muls.get('quick')).toBeGreaterThanOrEqual(MIN_THROTTLE);
  });

  // REGRESSION — reported as "I sent a fleet off to Saturn, but they
  // left their destroyer behind".
  //
  // The server fires a leg when arrival_at_tick <= tick, so hulls
  // landing at 322.09 and 322.45 are already together. Nothing should
  // be done to a fleet whose hulls all ceil to the same tick.
  it('leaves a fleet alone when every hull already lands on one tick', () => {
    const base = {
      thorn: 3.1289, spear: 3.1288, ocypete: 3.0876,
      damselfly: 3.0876, scorpion: 3.0876,
    };
    const muls = solveLockstepThrottle(Object.keys(base), fleet(base, 319), 319);
    for (const m of muls.values()) expect(m).toBe(1);
  });

  it('acts when hulls land on DIFFERENT ticks', () => {
    // The real case behind the report: five corvettes land on 323, the
    // destroyer would land on 322. It should be slowed to 323, NOT held
    // at the origin for a tick.
    const base = { corvette: 3.09, destroyer: 2.45 };
    const arriveAt = fleet(base, 319);
    const muls = solveLockstepThrottle(['corvette', 'destroyer'], arriveAt, 319);
    expect(muls.get('corvette')).toBe(1);
    expect(muls.get('destroyer')).toBeLessThan(1);
    expect(landsOn(arriveAt('destroyer', muls.get('destroyer')!)!))
      .toBe(landsOn(arriveAt('corvette', 1)!));
  });

  it('drops hulls that cannot fly the leg, and keeps the rest', () => {
    const muls = solveLockstepThrottle(
      ['ok1', 'broken', 'ok2'],
      (id, mul) => (id === 'broken' ? null : 12 / Math.sqrt(mul)),
      0,
    );
    expect(muls.has('broken')).toBe(false);
    expect(muls.has('ok1')).toBe(true);
    expect(muls.has('ok2')).toBe(true);
  });

  it('a single hull is left at full burn', () => {
    const muls = solveLockstepThrottle(['solo'], fleet({ solo: 9 }), 0);
    expect(muls.get('solo')).toBe(1);
  });
});

describe('arrivalSpread', () => {
  it('is zero for one arrival or none', () => {
    expect(arrivalSpread([])).toBe(0);
    expect(arrivalSpread([7])).toBe(0);
  });
  it('is the gap between first and last', () => {
    expect(arrivalSpread([10, 14, 20])).toBe(10);
  });
});
