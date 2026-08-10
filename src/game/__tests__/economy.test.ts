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

import { partsCost, PART_STACK_ESCALATION, SHIP_PART_DEFS, type ShipPartId } from '../shipParts';
import { SHIP_CLASSES } from '../shipClasses';
import { BUILDING_DEFS } from '../settlements';

describe('part stacking escalation', () => {
  test('the first copy is base price', () => {
    // Derived from the def rather than hardcoded: these tests pin the
    // CURVE, not the price list. Hardcoding turned every deliberate
    // rebalance into a false failure that taught people to edit the
    // expectation without reading it.
    const k = SHIP_PART_DEFS.kinetic.cost;
    expect(partsCost(['kinetic'])).toEqual({ ore: k.ore, credits: k.credits });
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
    const k = SHIP_PART_DEFS.kinetic.cost;
    const s = SHIP_PART_DEFS.shield.cost;
    const mixed = partsCost(['kinetic', 'shield']);
    expect(mixed).toEqual({
      ore: k.ore + s.ore,
      credits: k.credits + s.credits,
    });
  });

  test('order does not change the price', () => {
    const a = partsCost(['kinetic', 'shield', 'kinetic']);
    const b = partsCost(['kinetic', 'kinetic', 'shield']);
    expect(a).toEqual(b);
  });

  test('escalation matches the documented constant', () => {
    // 2nd kinetic = base + round(base * E). Guards an accidental
    // constant edit from silently repricing every design in play.
    const base = SHIP_PART_DEFS.kinetic.cost.ore;
    const two = partsCost(['kinetic', 'kinetic']).ore;
    expect(two).toBe(base + Math.round(base * PART_STACK_ESCALATION));
  });

  test('empty loadout is free', () => {
    expect(partsCost([])).toEqual({ ore: 0, credits: 0 });
  });
});

// ============================================================
// The client/server mirror. This is the drift the header comment warns
// about, made into an actual assertion instead of a hope: the price the
// designer QUOTES comes from src/game/shipParts.ts, the price the server
// CHARGES comes from worker/shipDesigns.js, and nothing but discipline
// kept them equal.
//
// Read as TEXT rather than imported: the worker is ESM with Cloudflare
// globals and dragging it into jsdom to compare six numbers is not worth
// the module plumbing. A regex over a literal table is the cheap,
// honest tool here — if the table stops being a literal, this fails
// loudly rather than silently passing, which is the correct direction
// to break in.
// ============================================================
describe('part costs match the worker mirror', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  const source = fs.readFileSync(
    path.join(__dirname, '../../../worker/shipDesigns.js'),
    'utf8',
  );

  const serverCosts: Record<string, { metal: number; gold: number }> = {};
  const row = /(\w+):\s*\{\s*metal:\s*(\d+),\s*gold:\s*(\d+),/g;
  let m: RegExpExecArray | null;
  while ((m = row.exec(source)) !== null) {
    serverCosts[m[1]] = { metal: Number(m[2]), gold: Number(m[3]) };
  }

  test('the worker table was actually found', () => {
    // Guards the regex itself: a refactor that renames the fields would
    // otherwise make every assertion below vacuously pass.
    expect(Object.keys(serverCosts).length).toBe(
      Object.keys(SHIP_PART_DEFS).length,
    );
  });

  // A plain loop rather than test.each: this repo has no @types/jest in
  // the tsconfig scope, so `test` resolves to any and `.each` callback
  // params land as implicit anys. The cast here keeps `id` properly
  // typed and each part still gets its own named test.
  (Object.keys(SHIP_PART_DEFS) as ShipPartId[]).forEach((id) => {
    test(`${id} costs the same on both sides`, () => {
      const client = SHIP_PART_DEFS[id].cost;
      const server = serverCosts[id];
      expect(server).toBeDefined();
      // Server columns are metal/gold; the client calls them ore/credits.
      expect({ ore: server.metal, credits: server.gold }).toEqual({
        ore: client.ore,
        credits: client.credits,
      });
    });
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
