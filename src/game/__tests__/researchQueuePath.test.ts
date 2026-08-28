// The research queue stores one entry per LEVEL, and duplicates are
// meaningful: ['propulsion','propulsion'] researches the next two
// levels. These assert the arithmetic behind "click Convoy Logistics
// and it queues the levels in between" — the player-reported gap.

import { levelsToQueue, TECH_MAX_LEVEL } from '../techs';

describe('levelsToQueue', () => {
  it('queues the gap between here and the target', () => {
    // The reported case: Propulsion 2, wants Convoy Logistics at 4.
    expect(levelsToQueue({ have: 2, target: 4 })).toBe(2);
  });

  it('counts the active project so a path is not double-queued', () => {
    // Already researching propulsion 3; only level 4 remains to queue.
    expect(levelsToQueue({ have: 2, active: true, target: 4 })).toBe(1);
  });

  it('counts what is already queued', () => {
    expect(levelsToQueue({ have: 2, queued: 2, target: 4 })).toBe(0);
    expect(levelsToQueue({ have: 2, queued: 1, target: 4 })).toBe(1);
  });

  it('counts the active project and the queue together', () => {
    // have 2 + researching 3 + one queued (4) = target already covered.
    expect(levelsToQueue({ have: 2, active: true, queued: 1, target: 4 })).toBe(0);
  });

  it('never returns negative for an already-owned level', () => {
    expect(levelsToQueue({ have: 7, target: 4 })).toBe(0);
  });

  it('clamps the target at the global cap', () => {
    expect(levelsToQueue({ have: 8, target: 99 })).toBe(TECH_MAX_LEVEL - 8);
  });

  it('queues a full track from nothing', () => {
    expect(levelsToQueue({ have: 0, target: TECH_MAX_LEVEL })).toBe(10);
  });
});
