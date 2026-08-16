// THE CLIENT MUST NOT QUOTE A PRICE THE SERVER WILL NOT HONOUR.
//
// Costs are defined twice on purpose — the client needs them to render a
// button and grey it out, the server needs them to charge. Several of
// these definitions carry a "Mirrors worker/... exactly" comment saying
// so. A comment is not a mechanism: today the hold moved 500 -> 400 and
// a hand-written 500 in room.js would have been left behind, so hauling
// and mining disagreed about how big a freighter is inside one tick.
//
// This reads BOTH sources and compares. It covers the pairs where a
// mismatch is silent and expensive:
//
//   building cost / scaling / build ticks / hostType
//   hull cost
//   ship part cost
//
// hostType is in here because it is the same failure wearing different
// clothes: a client that thinks the telescope goes on a city renders a
// button the server refuses with wrong_host.

import fs from 'fs';
import path from 'path';
import { BUILDING_DEFS } from '../settlements';
import { SHIP_PART_DEFS, ALL_PART_IDS } from '../shipParts';

const repo = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
const actions = repo('worker/actions.js');
const designs = repo('worker/shipDesigns.js');

/** The server's BUILDING_DEFS, parsed from source. */
function serverBuildings() {
  const i = actions.indexOf('const BUILDING_DEFS');
  const block = actions.slice(i, actions.indexOf('\n};', i));
  const out: Record<string, {
    hostType: string; metal: number; gold: number; scaling: number; ticks: number;
  }> = {};
  // Entries may span lines and carry comments between fields, so match
  // each key then read its fields out of the following slice.
  for (const m of block.matchAll(/^ {2}(\w+):\s*\{/gm)) {
    const rest = block.slice(m.index!, m.index! + 600);
    const host = /hostType:\s*'(\w+)'/.exec(rest);
    const metal = /metal:\s*(\d+)/.exec(rest);
    const gold = /gold:\s*(\d+)/.exec(rest);
    const scal = /costScaling:\s*([\d.]+)/.exec(rest);
    const tick = /baseTicks:\s*(\d+)/.exec(rest);
    if (host && metal && gold && scal && tick) {
      out[m[1]] = {
        hostType: host[1], metal: +metal[1], gold: +gold[1],
        scaling: +scal[1], ticks: +tick[1],
      };
    }
  }
  return out;
}

describe('building prices match the server', () => {
  const srv = serverBuildings();

  it('parsed the server catalogue', () => {
    expect(Object.keys(srv).length).toBeGreaterThanOrEqual(8);
  });

  it.each(Object.keys(BUILDING_DEFS))('%s', (kind) => {
    const s = srv[kind];
    const c = (BUILDING_DEFS as Record<string, {
      hostType: string; baseCost: { ore: number; credits: number };
      costScaling: number; baseBuildTicks: number;
    }>)[kind];
    // Every client building must exist server-side, or the menu offers
    // something that cannot be built at all.
    expect(s ? kind : `${kind} MISSING from worker BUILDING_DEFS`).toBe(kind);
    expect({
      hostType: c.hostType,
      metal: c.baseCost.ore,
      gold: c.baseCost.credits,
      scaling: c.costScaling,
      ticks: c.baseBuildTicks,
    }).toEqual(s);
  });
});

describe('hull prices match the server', () => {
  const i = designs.indexOf('export const HULL_COST');
  const block = designs.slice(i, designs.indexOf('};', i));
  const srv: Record<string, { metal: number; gold: number }> = {};
  for (const m of block.matchAll(/(\w+):\s*\{\s*metal:\s*(\d+),\s*gold:\s*(\d+)/g)) {
    srv[m[1]] = { metal: +m[2], gold: +m[3] };
  }

  // Imported lazily: shipClasses pulls in render-side types in some
  // builds, and this test only needs the numbers.
  const clientSrc = repo('src/game/shipClasses.ts');

  it.each(Object.keys(srv))('%s', (hull) => {
    // Classes are declared as `const CORVETTE: ShipClassDef = { ... }`,
    // keyed by CONSTANT NAME rather than an `id` field — the first draft
    // of this test searched for `id: 'corvette'` and found nothing,
    // which is a test failing on its own assumption rather than a drift.
    const at = clientSrc.search(new RegExp(`const ${hull.toUpperCase()}: ShipClassDef`));
    expect(at).toBeGreaterThan(-1);
    const around = clientSrc.slice(at, at + 1400);
    const cost = /cost:\s*\{\s*fuel:\s*\d+,\s*ore:\s*(\d+),\s*credits:\s*(\d+)/.exec(around);
    expect(cost).toBeTruthy();
    expect({ metal: +cost![1], gold: +cost![2] }).toEqual(srv[hull]);
  });
});

describe('ship part prices match the server', () => {
  const i = designs.indexOf('export const SHIP_PART_DEFS');
  const block = designs.slice(i, designs.indexOf('\n};', i));
  const srv: Record<string, { metal: number; gold: number }> = {};
  for (const m of block.matchAll(/(\w+):\s*\{\s*metal:\s*(\d+),\s*gold:\s*(\d+)/g)) {
    srv[m[1]] = { metal: +m[2], gold: +m[3] };
  }

  it('parsed the server part catalogue', () => {
    expect(Object.keys(srv).length).toBeGreaterThanOrEqual(ALL_PART_IDS.length);
  });

  it.each(ALL_PART_IDS)('%s', (id) => {
    const c = SHIP_PART_DEFS[id].cost as { ore?: number; credits?: number };
    expect({ metal: c.ore ?? 0, gold: c.credits ?? 0 }).toEqual(srv[id]);
  });
});
