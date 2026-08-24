import { solveLockstepWaits, arrivalSpread } from '../lockstep';

describe('solveLockstepWaits', () => {
  // A hull whose travel time does not depend on when it leaves: the
  // simplest case, and the one where wait = target - arrival is exact.
  const constantSpeed = (travel: Record<string, number>) =>
    (id: string, wait: number) => (travel[id] != null ? wait + travel[id] : null);

  it('makes a mixed-speed group arrive on the same tick', () => {
    const travel = { fast: 10, mid: 14, slow: 20 };
    const waits = solveLockstepWaits(['fast', 'mid', 'slow'], constantSpeed(travel));
    const arrive = (id: string) => (waits.get(id) ?? 0) + travel[id as keyof typeof travel];
    expect(arrivalSpread(['fast', 'mid', 'slow'].map(arrive))).toBe(0);
  });

  it('the slowest hull never waits — it sets the pace', () => {
    const waits = solveLockstepWaits(
      ['fast', 'slow'], constantSpeed({ fast: 10, slow: 20 }),
    );
    expect(waits.get('slow')).toBe(0);
    expect(waits.get('fast')).toBe(10);
  });

  it('never asks a hull to leave in the past', () => {
    const waits = solveLockstepWaits(
      ['a', 'b'], constantSpeed({ a: 30, b: 5 }),
    );
    for (const w of waits.values()) expect(w).toBeGreaterThanOrEqual(0);
  });

  it('converges when delay CHANGES travel time', () => {
    // The destination runs away: every tick of delay costs a fifth of a
    // tick more flight. wait = target - arrival is only a first guess
    // here, which is the whole reason the solver iterates.
    const travel: Record<string, number> = { fast: 10, slow: 20 };
    const arriveAt = (id: string, wait: number) =>
      (travel[id] != null ? wait + travel[id] + wait * 0.2 : null);
    const waits = solveLockstepWaits(['fast', 'slow'], arriveAt);
    const arrivals = ['fast', 'slow'].map(id => arriveAt(id, waits.get(id) ?? 0)!);
    expect(arrivalSpread(arrivals)).toBeLessThanOrEqual(1);
  });

  it('drops hulls that cannot fly the leg, and keeps the rest', () => {
    const waits = solveLockstepWaits(
      ['ok1', 'broken', 'ok2'],
      (id, wait) => (id === 'broken' ? null : wait + 12),
    );
    expect(waits.has('broken')).toBe(false);
    expect(waits.has('ok1')).toBe(true);
    expect(waits.has('ok2')).toBe(true);
  });

  it('a single hull is left alone', () => {
    const waits = solveLockstepWaits(['solo'], constantSpeed({ solo: 9 }));
    expect(waits.get('solo')).toBe(0);
  });

  it('an already-synchronised fleet is not disturbed', () => {
    const waits = solveLockstepWaits(
      ['a', 'b', 'c'], constantSpeed({ a: 12, b: 12, c: 12 }),
    );
    for (const w of waits.values()) expect(w).toBe(0);
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
