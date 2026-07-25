// Captains (DESIGN-captains.md) — client-side contract tests. The trait
// table and tier boundaries here mirror worker/captains.js; if these
// break, the display and the server sim have drifted.

import {
  CAPTAIN_TRAITS, AVATAR_IDS, rankTier, traitMul, traitSummary,
} from '../captains';

describe('captain traits', () => {
  const SPEC_TRAITS = [
    'gunner', 'bulwark', 'wrench', 'voidrunner',
    'pathfinder', 'quartermaster', 'colonist',
  ];

  it('covers exactly the spec §3 trait bank', () => {
    expect(Object.keys(CAPTAIN_TRAITS).sort()).toEqual([...SPEC_TRAITS].sort());
  });

  it('every trait has display name, icon, and blurb', () => {
    for (const def of Object.values(CAPTAIN_TRAITS)) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.icon.length).toBeGreaterThan(0);
      expect(def.blurb.length).toBeGreaterThan(0);
    }
  });

  it('client-applied multipliers stay small (spec: 5–15%, flavor not parts)', () => {
    expect(CAPTAIN_TRAITS.bulwark.hpMul).toBeCloseTo(1.10);
    expect(CAPTAIN_TRAITS.voidrunner.accelMul).toBeCloseTo(1.10);
    for (const def of Object.values(CAPTAIN_TRAITS)) {
      if (def.hpMul) expect(def.hpMul).toBeLessThanOrEqual(1.15);
      if (def.accelMul) expect(def.accelMul).toBeLessThanOrEqual(1.15);
    }
  });

  it('traitMul composes multiplicatively and ignores unknown ids', () => {
    expect(traitMul(undefined, 'hpMul')).toBe(1);
    expect(traitMul([], 'hpMul')).toBe(1);
    expect(traitMul(['gunner'], 'hpMul')).toBe(1);          // gunner has no hpMul
    expect(traitMul(['bulwark'], 'hpMul')).toBeCloseTo(1.10);
    expect(traitMul(['bulwark', 'bulwark'], 'hpMul')).toBeCloseTo(1.21);
    expect(traitMul(['nonsense', 'bulwark'], 'hpMul')).toBeCloseTo(1.10);
  });

  it('traitSummary reads as icon Name — blurb, joined', () => {
    expect(traitSummary(['gunner'])).toBe('🎯 Gunner — +10% weapon damage');
    expect(traitSummary(['gunner', 'wrench'])).toContain(' · ');
    expect(traitSummary(['nope'])).toBe('');
    expect(traitSummary(undefined)).toBe('');
  });
});

describe('avatars', () => {
  it('ships 12 unique code-shipped ids (spec §4 — no uploads)', () => {
    expect(AVATAR_IDS.length).toBe(12);
    expect(new Set(AVATAR_IDS).size).toBe(12);
  });
});

describe('rankTier (fleet Captain column, spec §5.2)', () => {
  it('keeps the historical boundaries: 0/1/3/6/10', () => {
    expect(rankTier(0)).toBe('Rookie');
    expect(rankTier(1)).toBe('Regular');
    expect(rankTier(2)).toBe('Regular');
    expect(rankTier(3)).toBe('Veteran');
    expect(rankTier(5)).toBe('Veteran');
    expect(rankTier(6)).toBe('Elite');
    expect(rankTier(9)).toBe('Elite');
    expect(rankTier(10)).toBe('Ace');
    expect(rankTier(40)).toBe('Ace');
  });
});
