// Research cards: the total for a track that CUTS a number carries a
// minus sign. Playtest, 2026-10-24: Construction read "-5% ship build
// cost (total +10%)".
import { TECH_DEFS, effectTotalText } from '../techs';

describe('effectTotalText', () => {
  it('Construction totals are a reduction, stopping at the 75% floor', () => {
    expect(effectTotalText(TECH_DEFS.construction, 2)).toBe('\u221210%');
    expect(effectTotalText(TECH_DEFS.construction, 20)).toBe('\u221275%');
  });
  it('the other tracks stay positive', () => {
    expect(effectTotalText(TECH_DEFS.weapons, 2)).toBe('+20%');
    expect(effectTotalText(TECH_DEFS.industry, 1)).toBe('+10%');
  });
});
