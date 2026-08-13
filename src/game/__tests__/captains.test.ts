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

describe('ship-posting resolution (regression)', () => {
  // The captain bank printed raw ids ("⚓ s10_0_u8za4") because captain
  // shipIds were stripped of the "<gameId>:" prefix while client ship ids
  // keep it, so the exact-match lookup missed. Both forms must resolve.
  //
  // The MISS case then got its own placeholder, "ship not in view", which
  // rendered the captain as posted-but-unreachable: no reserve marker, a
  // REASSIGN button, and a chip naming a ship nobody could find. A
  // captain is aboard one of your ships or in the bank; there is no third
  // place ("where the fuck are these captains?" — Lorne). A miss now
  // resolves to null, identical to an unassigned captain, so the card
  // shows them as available and ASSIGN works.
  const ships = [{ id: 'GAME1:s10_0_u8za4', name: 'Osprey' }];
  const tail = (id: string) => id.slice(id.indexOf(':') + 1);
  const resolve = (id: string | null): string | null => {
    if (!id) return null;
    const hit = ships.find(s => s.id === id) ?? ships.find(s => tail(s.id) === tail(id));
    return hit?.name ?? null;
  };

  it('resolves a fully-qualified id', () => {
    expect(resolve('GAME1:s10_0_u8za4')).toBe('Osprey');
  });
  it('resolves a stripped id (the form that regressed)', () => {
    expect(resolve('s10_0_u8za4')).toBe('Osprey');
  });
  it('a posting to a ship that no longer exists reads as NO posting', () => {
    // The stranded case: the hull was destroyed and the server has not
    // released the captain yet (the sweep runs on the tick, and a
    // completed game never ticks again).
    expect(resolve('GAME1:s99_9_zzzzz')).toBeNull();
  });
  it('never leaks a raw id on a miss', () => {
    expect(resolve('GAME1:s99_9_zzzzz') ?? '').not.toContain('s99');
  });
  it('treats an unassigned captain as no posting', () => {
    expect(resolve(null)).toBeNull();
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
