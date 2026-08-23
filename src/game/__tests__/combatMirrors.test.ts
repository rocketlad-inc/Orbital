// THE DESIGNER AND THE YARD MUST AGREE ON WHAT A SHIP DOES.
//
// Combat numbers live twice: the client needs them to draw a design's
// stats before you build it, the server needs them to stamp
// damage_per_tick onto the hull that rolls out. worker/shipDesigns.js
// even says so — "MUST match computeDesignStats in src/game/shipParts.ts
// to the digit or the designer and the yard disagree" — and nothing
// enforced it.
//
// It cost something. The pacing pass halved every hull's damage, and
// DETONATOR_HP_FRAC escaped because a detonator is priced off the
// carrier's MAX HP rather than its guns. Nothing failed; ramming a
// warhead into someone just quietly became twice as good as shooting
// them, in a game where suicide runs were already the sharpest tool.
//
// So this compares the two sources directly. Hull stats, the part
// multipliers, and build ticks — every number where a mismatch is
// invisible until someone measures a fight.

import fs from 'fs';
import path from 'path';
import { SHIP_CLASSES } from '../shipClasses';

const repo = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
const designs = repo('worker/shipDesigns.js');
const factions = repo('worker/factions.js');
const actions = repo('worker/actions.js');
const clientParts = repo('../src/game/shipParts.ts'.replace('../', ''));

/** `const NAME = <number>` from a source file. */
function num(src: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*([\\d.]+)`).exec(src);
  if (!m) throw new Error(`could not find ${name}`);
  return Number(m[1]);
}

describe('part multipliers match across the boundary', () => {
  it.each(['WEAPON_DMG_PCT', 'SHIELD_HP_PCT', 'DETONATOR_HP_FRAC'])('%s', (k) => {
    expect(num(clientParts, k)).toBe(num(designs, k));
  });

  it('a detonator is not worth more than the guns it rode in on', () => {
    // The specific regression: guns halved, the warhead did not. This is
    // a ratio check rather than a value check, so it keeps meaning
    // something after the next retune.
    const frac = num(clientParts, 'DETONATOR_HP_FRAC');
    const corvette = SHIP_CLASSES.corvette;
    const destroyer = SHIP_CLASSES.destroyer;
    // One detonator on a corvette, against what a destroyer puts out in
    // a tick. A warhead worth more than two full volleys means ramming
    // has quietly become the dominant way to spend a hull.
    expect(corvette.hp * frac).toBeLessThan(destroyer.damagePerTick * 2);
  });
});

describe('hull stats match the server', () => {
  // worker/factions.js SHIP_COMBAT_STATS, parsed from source.
  const srv: Record<string, { hp: number; dmg: number }> = {};
  const i = factions.indexOf('SHIP_COMBAT_STATS');
  const block = factions.slice(i, factions.indexOf('\n};', i));
  for (const m of block.matchAll(/(\w+):\s*\{\s*hp:\s*([\d.]+),\s*damage_per_tick:\s*([\d.]+)/g)) {
    srv[m[1]] = { hp: Number(m[2]), dmg: Number(m[3]) };
  }

  it('parsed the server stat table', () => {
    expect(Object.keys(srv).length).toBeGreaterThanOrEqual(5);
  });

  it.each(Object.keys(srv))('%s', (cls) => {
    const c = (SHIP_CLASSES as Record<string, { hp: number; damagePerTick: number }>)[cls];
    expect(c ? cls : `${cls} MISSING from SHIP_CLASSES`).toBe(cls);
    expect({ hp: c.hp, dmg: c.damagePerTick }).toEqual(srv[cls]);
  });
});

describe('build times match the server', () => {
  const srv: Record<string, number> = {};
  const i = actions.indexOf('const SHIP_BUILD_COST');
  const block = actions.slice(i, actions.indexOf('\n};', i));
  for (const m of block.matchAll(/(\w+):\s*\{[^}]*build_ticks:\s*(\d+)/g)) {
    srv[m[1]] = Number(m[2]);
  }

  it('parsed the server build table', () => {
    expect(Object.keys(srv).length).toBeGreaterThanOrEqual(5);
  });

  it.each(Object.keys(srv))('%s', (cls) => {
    const c = (SHIP_CLASSES as Record<string, { buildTime: number }>)[cls];
    expect(c ? cls : `${cls} MISSING from SHIP_CLASSES`).toBe(cls);
    expect(c.buildTime).toBe(srv[cls]);
  });
});
