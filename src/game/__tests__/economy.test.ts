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
import { SHIP_CLASSES, SHIP_UPKEEP, BUILDABLE_CLASSES, upkeepSplitFor } from '../shipClasses';
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

// ============================================================
// Upkeep currency split — the client mirror must agree with the worker.
//
// Upkeep is now a per-class TOTAL split across metal/credits by what a
// hull is MADE of, and that arithmetic exists twice: upkeepSplit in
// worker/shipDesigns.js (which bills) and upkeepSplitFor in
// src/game/shipClasses.ts (which quotes). The Economy tab shipped
// reading the OLD flat table for one deploy and showed freighters at
// "— metal / −4.00 credits" while the tick charged a metal share — a
// panel whose entire purpose is to be the truthful statement.
//
// The hull fallback is the drift-prone half: it depends on hull build
// costs, which live in THREE places (HULL_COST in the worker,
// SHIP_CLASSES here, SHIP_BUILD_COST in actions.js, the last spreading
// the first). Parse the worker's table and compare.
// ============================================================
describe('upkeep split matches the worker mirror', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../../worker/shipDesigns.js'),
    'utf8',
  );

  // Scoped to the HULL_COST block so this can't accidentally scrape
  // SHIP_PART_DEFS (which has the same metal:/gold: shape).
  const block = src.slice(
    src.indexOf('export const HULL_COST'),
    src.indexOf('export function upkeepSplit'),
  );
  const serverHull: Record<string, { metal: number; gold: number }> = {};
  const row = /(\w+):\s*\{\s*metal:\s*(\d+),\s*gold:\s*(\d+)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = row.exec(block)) !== null) {
    serverHull[m[1]] = { metal: Number(m[2]), gold: Number(m[3]) };
  }

  test('the worker HULL_COST table was actually found', () => {
    // Guards the regex: a rename would otherwise make the rest vacuous.
    expect(block.length).toBeGreaterThan(50);
    // BUILDABLE_CLASSES, not SHIP_CLASSES. The two diverged when capital
    // hulls arrived: a Mega Destroyer is a ship class with no hull cost
    // BECAUSE it has no shipyard path — it comes out of a megastructure
    // site. Comparing against every class would demand a price for
    // something that cannot be bought.
    expect(Object.keys(serverHull).sort()).toEqual([...BUILDABLE_CLASSES].sort());
  });

  test('capital hulls are deliberately absent from the yard price list', () => {
    // The gap IS the rule. If one of these ever gains a HULL_COST entry
    // it has quietly become buildable, and the megastructure that exists
    // to produce it has become optional.
    for (const cls of ['mega_destroyer', 'mobile_foundry']) {
      expect({ cls, priced: cls in serverHull }).toEqual({ cls, priced: false });
    }
  });

  test('every hull cost matches this module', () => {
    for (const [cls, cost] of Object.entries(serverHull)) {
      const mine = SHIP_CLASSES[cls as keyof typeof SHIP_CLASSES].cost;
      expect(`${cls}:${cost.metal}/${cost.gold}`).toBe(`${cls}:${mine.ore}/${mine.credits}`);
    }
  });

  test('the split preserves the class total exactly', () => {
    const loadouts: ShipPartId[][] = [
      [], ['kinetic'], ['energy'], ['kinetic', 'shield'], ['energy', 'armor'], ['engine'],
    ];
    for (const cls of Object.keys(SHIP_UPKEEP) as (keyof typeof SHIP_UPKEEP)[]) {
      const want = SHIP_UPKEEP[cls].credits + SHIP_UPKEEP[cls].ore;
      for (const parts of loadouts) {
        const u = upkeepSplitFor(cls, parts, partsCost);
        expect(u.credits + u.ore).toBeCloseTo(want, 9);
      }
    }
  });

  // Lorne, 2026-09-21: upkeep leans the way the WHOLE SHIP'S price leans,
  // hull + parts. Weighing the loadout alone ignored the hull — most of
  // the price — and billed 376 of 821 live hulls backwards.
  test('the split follows the whole build price, hull + parts', () => {
    const total = SHIP_UPKEEP.corvette.credits + SHIP_UPKEEP.corvette.ore;
    for (const parts of [['kinetic'], ['energy'], ['engine']] as ShipPartId[][]) {
      const u = upkeepSplitFor('corvette', parts, partsCost);
      const hull = SHIP_CLASSES.corvette.cost;
      const p = partsCost(parts, 'corvette');
      const share = (hull.ore + p.ore) / (hull.ore + p.ore + hull.credits + p.credits);
      expect(u.ore / total).toBeCloseTo(share, 9);
    }
    // The loadout still moves it, just no further than it moves the price.
    const kin = upkeepSplitFor('corvette', ['kinetic'], partsCost);
    const nrg = upkeepSplitFor('corvette', ['energy'], partsCost);
    expect(kin.ore).toBeGreaterThan(nrg.ore);
  });

  test('never backwards: a hull that costs mostly metal pays mostly metal', () => {
    // The commonest backwards hull on the live board: a freighter with
    // one (credit-side) engine is 54% metal to build, and used to pay
    // 75% of its upkeep in credits.
    const u = upkeepSplitFor('freighter', ['engine'], partsCost);
    expect(u.ore).toBeGreaterThan(u.credits);
  });

  // THE SERVER TABLES ARE HAND-WRITTEN, and a class missing from one is
  // a `continue` in the billing loop — not an error. That is exactly how
  // Mega Destroyers and Mobile Foundries ran for their whole existence:
  // quoted here at 12+12 and 10+10, billed nothing at all by the tick.
  test('every class quoted an upkeep is actually billed by the server', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../../worker', f), 'utf8');
    const room = read('room.js');
    const state = read('state.js');
    const schema = read('configSchema.js');
    for (const cls of Object.keys(SHIP_UPKEEP) as (keyof typeof SHIP_UPKEEP)[]) {
      const t = SHIP_UPKEEP[cls];
      if (t.credits + t.ore <= 0) continue;          // colony: free by design
      const row = new RegExp(`\\b${cls}:\\s*\\{\\s*gold:`);
      expect(`${cls} in room.js: ${row.test(room)}`).toBe(`${cls} in room.js: true`);
      expect(`${cls} in state.js: ${row.test(state)}`).toBe(`${cls} in state.js: true`);
      expect(`${cls} has a config rate: ${schema.includes(`'upkeep_${cls}_gold'`)}`)
        .toBe(`${cls} has a config rate: true`);
    }
  });

  test('a bare hull bills on its own build ratio, never credits-only', () => {
    const bare = upkeepSplitFor('corvette', [], partsCost);
    const hull = SHIP_CLASSES.corvette.cost;
    expect(bare.ore).toBeGreaterThan(0);
    expect(bare.ore).toBeCloseTo(
      SHIP_UPKEEP.corvette.credits * (hull.ore / (hull.ore + hull.credits)), 9,
    );
  });
});

// ============================================================
// THE 10x HULL LADDER (Lorne, 2026-09-21).
//
// "I want ship costs to move 10x each level. So Corvettes at 10 a ship
// (plus upgrades), Frigates 100 a ship (plus) and Destroyers 1000 a
// ship." In EACH currency. Stats climb ~5x per tier, so a bigger hull
// buys concentration at a higher price per point of power; parts scale
// with the hull they go on; upkeep is 1% of price per tick.
// ============================================================
describe('the 10x hull ladder', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const worker = (f: string) => fs.readFileSync(path.join(__dirname, '../../../worker', f), 'utf8');
  const { PART_PRICE_MULT, refitFee, SERVER_HULL_BASE } = require('../shipParts');

  test('hulls cost 10 / 100 / 1000 in each currency', () => {
    const { corvette, frigate, destroyer } = SHIP_CLASSES;
    expect([corvette.cost.ore, corvette.cost.credits]).toEqual([10, 10]);
    expect([frigate.cost.ore, frigate.cost.credits]).toEqual([100, 100]);
    expect([destroyer.cost.ore, destroyer.cost.credits]).toEqual([1000, 1000]);
  });

  test('stats climb ~5x a tier against a 10x price: bigger is concentration, not a bargain', () => {
    const hpPerPrice = (c: 'corvette' | 'frigate' | 'destroyer') =>
      SERVER_HULL_BASE[c].hp / (SHIP_CLASSES[c].cost.ore + SHIP_CLASSES[c].cost.credits);
    expect(SERVER_HULL_BASE.frigate.hp).toBe(SERVER_HULL_BASE.corvette.hp * 5);
    expect(SERVER_HULL_BASE.destroyer.hp).toBe(SERVER_HULL_BASE.frigate.hp * 5);
    expect(hpPerPrice('frigate')).toBeLessThan(hpPerPrice('corvette'));
    expect(hpPerPrice('destroyer')).toBeLessThan(hpPerPrice('frigate'));
  });

  test('the same part costs ~10x more on each bigger hull', () => {
    const k = (c: 'corvette' | 'frigate' | 'destroyer') => {
      const p = partsCost(['kinetic'], c);
      return p.ore + p.credits;
    };
    expect(k('corvette')).toBe(2);
    expect(k('frigate')).toBe(18);
    expect(k('destroyer')).toBe(180);
  });

  test('refits price parts at the hull they are fitted to', () => {
    const f = (c: 'corvette' | 'destroyer') => refitFee([], ['kinetic'], c);
    expect(f('destroyer').ore).toBeGreaterThan(f('corvette').ore * 50);
  });

  test('upkeep is 1% of the hull price per tick', () => {
    for (const c of ['corvette', 'frigate', 'destroyer'] as const) {
      const price = SHIP_CLASSES[c].cost.ore + SHIP_CLASSES[c].cost.credits;
      expect(SHIP_UPKEEP[c].credits + SHIP_UPKEEP[c].ore).toBeCloseTo(price / 100, 9);
    }
  });

  test('the worker prices parts with the same multipliers', () => {
    const src = worker('shipDesigns.js');
    const m = src.match(/PART_PRICE_MULT\s*=\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const server: Record<string, number> = {};
    for (const [, k, v] of Array.from(m![1].matchAll(/(\w+):\s*([\d.]+)/g))) server[k] = Number(v);
    expect(server).toEqual(PART_PRICE_MULT);
  });

  // JavaScript will not refuse a call that forgets the hull, and a part
  // priced without one silently falls back to x1 — a destroyer mount at
  // corvette-ish prices. So every server call site must name the class.
  test('every server price call names the hull it is pricing', () => {
    for (const f of ['actions.js', 'room.js', 'shipDesigns.js', 'state.js', 'fleets.js']) {
      const src = worker(f);
      const calls = Array.from(src.matchAll(/\b(partsCost|refitFee)\(([^;]*?)\);?\s*$/gm));
      for (const [line, fn, args] of calls) {
        if (/function\s+(partsCost|refitFee)/.test(line)) continue;
        const want = fn === 'refitFee' ? 3 : 2;
        const n = args.split(',').filter(a => a.trim()).length;
        expect(`${f}: ${fn}(${args}) has ${n} args`).toBe(`${f}: ${fn}(${args}) has ${want} args`);
      }
    }
  });
});
