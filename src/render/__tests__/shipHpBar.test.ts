// Ship health bar shown with the hover/selection name label (2026-08-02).
//
// The bar must agree with the Fleet/Ship panels, which resolve max HP via
// effectiveShipMaxHp — server hp_max_effective wins when present (the only
// correct value for a RIVAL hull, whose armor tech the client never
// receives), else base x armor tech x captain rank. A bar computed off
// raw hpMax would read "full" on a ship the panels show as damaged.

import { effectiveShipMaxHp } from '../../game/combat';
import type { Ship } from '../../types';

/** Fill colour thresholds, mirroring drawShipHpBar (and the settlement bar). */
function hpTier(frac: number): 'good' | 'warn' | 'danger' {
  return frac > 0.5 ? 'good' : frac > 0.25 ? 'warn' : 'danger';
}
const fracOf = (ship: Ship, tech?: Parameters<typeof effectiveShipMaxHp>[1]) => {
  const max = effectiveShipMaxHp(ship, tech);
  return Math.max(0, Math.min(1, (ship.hp ?? max) / max));
};

const baseShip = (over: Partial<Ship>): Ship => ({
  id: 's1', name: 'Conqueror', class: 'corvette', ownedBy: 'player',
  hp: 40, hpMax: 40,
  orbit: { rp: 8, ra: 8, omega: 0, M0: 0, epoch: 0, direction: 1, period: 10, parentBodyId: 'earth' },
  ...over,
} as Ship);

describe('ship hp bar — fill fraction', () => {
  it('is full for an undamaged hull', () => {
    expect(fracOf(baseShip({ hp: 40, hpMax: 40 }))).toBe(1);
  });

  it('tracks damage', () => {
    expect(fracOf(baseShip({ hp: 20, hpMax: 40 }))).toBeCloseTo(0.5, 5);
    expect(fracOf(baseShip({ hp: 4, hpMax: 40 }))).toBeCloseTo(0.1, 5);
  });

  it('clamps rather than overflowing or going negative', () => {
    expect(fracOf(baseShip({ hp: 999, hpMax: 40 }))).toBe(1);
    expect(fracOf(baseShip({ hp: -5, hpMax: 40 }))).toBe(0);
  });

  it('never divides by zero on a malformed hull', () => {
    const f = fracOf(baseShip({ hp: 10, hpMax: 0 }));
    expect(Number.isFinite(f)).toBe(true);
  });
});

describe('ship hp bar — agrees with the panels on max HP', () => {
  it('honours the server ceiling, so a buffed hull does not read as overfull', () => {
    // Rank/armor pushed the real ceiling to 60; raw hpMax is still 40.
    const ship = baseShip({ hp: 48, hpMax: 40, hpMaxEffective: 60 });
    expect(effectiveShipMaxHp(ship, undefined)).toBe(60);
    expect(fracOf(ship)).toBeCloseTo(0.8, 5);
    // The naive hp/hpMax reading would have claimed >100%.
    expect(48 / 40).toBeGreaterThan(1);
  });

  it('a rival hull resolves purely from the server value (no tech available)', () => {
    const rival = baseShip({ ownedBy: 'enemy', hp: 30, hpMax: 40, hpMaxEffective: 60 });
    expect(fracOf(rival, undefined)).toBeCloseTo(0.5, 5);
  });
});

describe('ship hp bar — colour tiers match the settlement bar', () => {
  it('greens above half, ambers in the middle band, reds when critical', () => {
    expect(hpTier(1)).toBe('good');
    expect(hpTier(0.51)).toBe('good');
    expect(hpTier(0.5)).toBe('warn');    // boundary is exclusive on the high side
    expect(hpTier(0.26)).toBe('warn');
    expect(hpTier(0.25)).toBe('danger');
    expect(hpTier(0)).toBe('danger');
  });

  it('is monotonic — more damage never looks healthier', () => {
    const order = { good: 2, warn: 1, danger: 0 };
    let prev = Infinity;
    for (let f = 1; f >= 0; f -= 0.05) {
      const v = order[hpTier(f)];
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});
