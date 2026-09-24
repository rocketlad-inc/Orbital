// THE RUINS' PRICE EXISTS TWICE AND HAS TO AGREE (0142).
//
// worker/actions.js charges WRECK_SEIZE_COST -- a colony ship's hull price,
// derived from SHIP_BUILD_COST.colony -- and the world menu's RuinsCard
// quotes it on the button BEFORE the click. A drift is a button that says
// one price and a treasury that pays another. Parsed rather than imported:
// the worker module pulls in the auth chain, which jsdom cannot load.

import fs from 'fs';
import path from 'path';
import { WRECK_SEIZE_COST } from '../../multiplayer/RuinsCard';

const actions = fs.readFileSync(
  path.resolve(__dirname, '../../..', 'worker/actions.js'), 'utf8');

describe('wreck seize price', () => {
  it('the server charges a colony ship’s price', () => {
    expect(actions).toMatch(
      /export const WRECK_SEIZE_COST = \{ metal: SHIP_BUILD_COST\.colony\.metal, gold: SHIP_BUILD_COST\.colony\.gold \};/);
  });

  it('and the button quotes the same numbers', () => {
    const colony = /colony:\s*\{\s*fuel: 0,\s*metal: (\d+),\s*gold: (\d+)/.exec(actions);
    expect(colony).not.toBeNull();
    expect(WRECK_SEIZE_COST.ore).toBe(Number(colony![1]));
    expect(WRECK_SEIZE_COST.credits).toBe(Number(colony![2]));
  });

  it('every building comes back one level lower, and a level-1 one is lost', () => {
    // The rule the card previews, pinned against the server's function.
    const i = actions.indexOf('export function wreckBuildingsAfterSeize(');
    const body = actions.slice(i, actions.indexOf('\n}', i));
    expect(body).toMatch(/Math\.floor\(Number\(lvl\) \|\| 0\) - 1/);
    expect(body).toMatch(/if \(next > 0\) out\[kind\] = next;/);
  });
});
