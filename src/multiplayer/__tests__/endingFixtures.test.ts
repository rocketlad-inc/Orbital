// The end-of-game page is designed on REAL data: these fixtures are what
// worker/ending.js produced (scripts/ending-from-prod.mjs, read-only) for three
// finished production games. This test keeps the contract (endingTypes.ts), the
// producer and the fixtures from drifting apart: every fixture is validated
// against the contract TEXT by the same checker the server sim uses.
//
// Regenerate a fixture:  node scripts/ending-from-prod.mjs <gameId>

import fs from 'fs';
import path from 'path';
import type { EndingPayload } from '../endingTypes';

// The checker is a plain ESM module shared with sim/ending.mjs (no types).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkEndingShape, checkEndingInvariants, parseContract } = require('../../../sim/endingShape.mjs');

const CONTRACT = fs.readFileSync(path.join(__dirname, '..', 'endingTypes.ts'), 'utf8');
const FIXTURES: Array<{ id: string; name: string; victory: string }> = [
  { id: 'sMu08u1ySzRJ', name: 'The NEXT Zone', victory: 'engineering' },
  { id: 'ghhqbPbWz64Y', name: 'The MEGA Zone', victory: 'chancellor' },
  { id: 'CAWEFbsSGyBI', name: '6X 30min', victory: 'domination' },
];
const load = (id: string): EndingPayload =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '__fixtures__', `ending.${id}.json`), 'utf8'));

describe('ending contract', () => {
  it('parses every interface the page relies on', () => {
    const defs = parseContract(CONTRACT);
    for (const name of ['EndingAward', 'EndingFaction', 'EndingSeries', 'EndingBattle', 'EndingPayload']) {
      expect(defs[name]).toBeDefined();
    }
  });

  it('rejects a payload that drifted from the contract', () => {
    const p = load(FIXTURES[0].id) as unknown as Record<string, unknown>;
    expect(checkEndingShape({ ...p, surprise: 1 }, CONTRACT).length).toBeGreaterThan(0);
    const { awards: _awards, ...noAwards } = p;
    expect(checkEndingShape(noAwards, CONTRACT).length).toBeGreaterThan(0);
  });
});

describe.each(FIXTURES)('real-game fixture $name ($id)', ({ id, name, victory }) => {
  const p = load(id);

  it('matches the contract exactly', () => {
    expect(checkEndingShape(p, CONTRACT)).toEqual([]);
  });

  it('keeps the rules the type cannot say (order, alignment, bounds, no emails)', () => {
    expect(checkEndingInvariants(p)).toEqual([]);
  });

  it('is the game it claims to be', () => {
    expect(p.game.id).toBe(id);
    expect(p.game.name).toBe(name);
    expect(p.game.victoryType).toBe(victory);
    expect(p.factions[0].isWinner).toBe(true);
    expect(p.factions.filter(f => f.isMe)).toHaveLength(1);   // generated as the winner
  });

  it('has real awards and a real series', () => {
    expect(p.awards.length).toBeGreaterThanOrEqual(8);
    expect(p.series.ticks.length).toBeGreaterThan(50);
    expect(p.series.ticks[0]).toBe(1);
    expect(p.series.ticks[p.series.ticks.length - 1]).toBe(p.game.currentTick);
  });
});
