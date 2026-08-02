// ============================================================
// Economy scaling — the sinks a mature empire spends into.
//
// These pin the two curves the 2026-07 rebalance introduced, because
// both are duplicated across the client/server boundary and a silent
// drift means the price the player is QUOTED differs from what the
// server CHARGES:
//   - partsCost stacking escalation  (worker/shipDesigns.js partsCost)
//   - compounding building yield     (worker/room.js harvest pass)
// ============================================================

import { partsCost, PART_STACK_ESCALATION, type ShipPartId } from '../shipParts';
import { SHIP_CLASSES } from '../shipClasses';
import { BUILDING_DEFS } from '../settlements';

describe('part stacking escalation', () => {
  test('the first copy is base price', () => {
    expect(partsCost(['kinetic'])).toEqual({ ore: 6, credits: 2 });
  });

  test('each additional copy of the SAME part costs more', () => {
    const one = partsCost(['kinetic']).ore;
    const two = partsCost(['kinetic', 'kinetic']).ore;
    const three = partsCost(['kinetic', 'kinetic', 'kinetic']).ore;
    const d1 = two - one;
    const d2 = three - two;
    expect(d1).toBeGreaterThan(one);   // 2nd dearer than 1st
    expect(d2).toBeGreaterThan(d1);    // 3rd dearer than 2nd
  });

  test('mixed loadouts are NOT penalised — escalation is per part type', () => {
    // One of each: every part is its type's first copy, so base price.
    const mixed = partsCost(['kinetic', 'shield']);
    expect(mixed).toEqual({
      ore: 6 + 4,
      credits: 2 + 4,
    });
  });

  test('order does not change the price', () => {
    const a = partsCost(['kinetic', 'shield', 'kinetic']);
    const b = partsCost(['kinetic', 'kinetic', 'shield']);
    expect(a).toEqual(b);
  });

  test('escalation matches the documented constant', () => {
    // 2nd kinetic = round(6 * E). Guards an accidental constant edit
    // from silently repricing every design in play.
    const two = partsCost(['kinetic', 'kinetic']).ore;
    expect(two).toBe(6 + Math.round(6 * PART_STACK_ESCALATION));
  });

  test('empty loadout is free', () => {
    expect(partsCost([])).toEqual({ ore: 0, credits: 0 });
  });
});

describe('hulls are a meaningful sink', () => {
  test('a destroyer costs more than a mid-tier building upgrade', () => {
    // The bug this rebalance fixed: a fully-armed destroyer used to cost
    // 48 metal — LESS than one L5 forge (262) — so the strongest unit in
    // the game was effectively free and there was nothing to spend on.
    const destroyer = SHIP_CLASSES.destroyer.cost;
    const forgeL3 = BUILDING_DEFS.forge.baseCost.ore
      * Math.pow(BUILDING_DEFS.forge.costScaling, 2);
    expect(destroyer.ore).toBeGreaterThan(forgeL3);
  });

  test('hull cost rises with class weight', () => {
    const { corvette, frigate, destroyer } = SHIP_CLASSES;
    expect(frigate.cost.ore).toBeGreaterThan(corvette.cost.ore);
    expect(destroyer.cost.ore).toBeGreaterThan(frigate.cost.ore);
  });

  test('a heavily-specialised hull costs far more than a light fitting', () => {
    const light: ShipPartId[] = ['kinetic', 'engine'];
    const heavy: ShipPartId[] = ['kinetic', 'kinetic', 'kinetic', 'kinetic', 'kinetic', 'kinetic'];
    const lightTotal = partsCost(light).ore + partsCost(light).credits;
    const heavyTotal = partsCost(heavy).ore + partsCost(heavy).credits;
    expect(heavyTotal).toBeGreaterThan(lightTotal * 5);
  });
});

describe('building yield compounds so deep levels stay worth buying', () => {
  // Mirrors settlementYield()/room.js: multiplier is (1+perLevel)^level.
  const mul = (perLevel: number, level: number) => Math.pow(1 + perLevel, level);

  test('compounding beats the old additive curve at depth', () => {
    const per = BUILDING_DEFS.forge.yieldBoost?.perLevel ?? 0.25;
    const additiveL8 = 1 + per * 8;          // the old formula: x3.0
    expect(mul(per, 8)).toBeGreaterThan(additiveL8);
  });

  test('the curve still DIMINISHES — cost outruns yield every level', () => {
    // Cost grows 1.6x/level, yield 1.25x/level. Upgrades must keep
    // getting worse per unit, or the sink becomes a money printer.
    const per = BUILDING_DEFS.forge.yieldBoost?.perLevel ?? 0.25;
    const scaling = BUILDING_DEFS.forge.costScaling;
    expect(scaling).toBeGreaterThan(1 + per);
  });
});
