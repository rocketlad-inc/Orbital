// A player read 9.6M 4.8C 6.6S on Mars in the world menu and
// 11.52M 5.76C 15.84S in the Economy tab for the same world, on the
// same tick. Both were right about different halves of the sum: the
// menu quoted the settlement's own output, the Economy tab also applied
// the Industry tech bonus and the Senate yield laws. These pin the
// multipliers so the two readouts cannot drift apart again.

import { empireYieldMultipliers, applyYieldMultipliers, NEUTRAL_YIELD } from '../yieldMultipliers';
import { GameState } from '../../types';

const stateWith = (industry: number, sliders?: Record<string, number>) => ({
  factionTech: { player: { levels: { industry }, researching: null, progress: 0, queue: [] } },
  activeSliders: sliders,
} as unknown as GameState);

describe('empireYieldMultipliers', () => {
  it('is neutral with no tech and no laws', () => {
    const m = empireYieldMultipliers(stateWith(0));
    expect(m).toEqual(NEUTRAL_YIELD);
  });

  it('applies +10% per Industry level to every resource', () => {
    const m = empireYieldMultipliers(stateWith(2));
    expect(m.ore).toBeCloseTo(1.2);
    expect(m.credits).toBeCloseTo(1.2);
    expect(m.science).toBeCloseTo(1.2);
    expect(m.fuel).toBeCloseTo(1.2);
  });

  it('stacks a Senate yield law on top, per resource', () => {
    // "Faster Research" is a science YIELD law: it doubles science and
    // leaves metal and credits alone.
    const m = empireYieldMultipliers(stateWith(2, { scienceYieldMultiplier: 2 }));
    expect(m.science).toBeCloseTo(2.4);
    expect(m.ore).toBeCloseTo(1.2);
    expect(m.credits).toBeCloseTo(1.2);
  });

  it('reproduces the reported Mars figures exactly', () => {
    // Settlement output on Mars at pop 6 with City Lab + Station Lab.
    const raw = { fuel: 0, ore: 9.6, credits: 4.8, science: 6.6 };
    const m = empireYieldMultipliers(stateWith(2, { scienceYieldMultiplier: 2 }));
    const out = applyYieldMultipliers(raw, m);
    expect(out.ore).toBeCloseTo(11.52, 2);
    expect(out.credits).toBeCloseTo(5.76, 2);
    expect(out.science).toBeCloseTo(15.84, 2);
  });

  it('treats a missing slider block as neutral', () => {
    const m = empireYieldMultipliers(stateWith(0, undefined));
    expect(m.science).toBe(1);
  });
});
