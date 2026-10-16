// Which stretch of a battle a vertical video covers.

import { highlightSpan } from '../recapVideo';

describe('the vertical video picks the deadliest stretch', () => {
  it('takes a short fight whole', () => {
    expect(highlightSpan([0, 2, 1], 10)).toEqual({ from: 0, to: 2.98 });
  });

  it('finds the window with the most deaths in a long fight', () => {
    const deaths = new Array(40).fill(0);
    deaths[25] = 3; deaths[27] = 2; deaths[30] = 4;   // all inside beats 21..30
    deaths[2] = 1;
    const s = highlightSpan(deaths, 10);
    expect(s.from).toBeLessThanOrEqual(25);
    expect(s.from + 9).toBeGreaterThanOrEqual(30);
    expect(s.to - s.from).toBeCloseTo(9.98);
  });

  it('prefers the later window on a tie, nearer the result', () => {
    const deaths = new Array(30).fill(0);
    deaths[3] = 2; deaths[25] = 2;
    expect(highlightSpan(deaths, 5).from).toBeGreaterThan(15);
  });
});
