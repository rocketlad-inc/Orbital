// THE UI MUST NOT QUOTE A NUMBER THE SERVER NO LONGER USES.
//
// src/game/mining.ts holds client copies of two server tuning constants,
// because the meteoroid card tells players "fills 50 a tick into a 500
// hold" and that sentence is worthless if it is stale. Retuning the mine
// rate is a one-line edit in worker/room.js, and nothing about that edit
// would prompt anyone to go re-read a React card.
//
// So this reads the worker sources and compares. It fails loudly on the
// retune rather than quietly at some later playtest where a player times
// a mining run with a stopwatch and finds the game lied.

import fs from 'fs';
import path from 'path';
import { MINE_RATE_PER_TICK, BASE_HOLD, TICKS_PER_HOLD, loadsRemaining } from '../mining';

const repo = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

/** Pull `NAME = <number>` out of a worker source. */
function serverConst(source: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(source);
  if (!m) throw new Error(`could not find ${name} — did it get renamed?`);
  return Number(m[1]);
}

describe('client mining constants mirror the server', () => {
  it('MINE_RATE_PER_TICK matches worker/room.js', () => {
    expect(MINE_RATE_PER_TICK)
      .toBe(serverConst(read('worker/room.js'), 'MINE_RATE_PER_TICK'));
  });

  it('BASE_HOLD matches CARGO_CAP in worker/routeMath.js', () => {
    expect(BASE_HOLD)
      .toBe(serverConst(read('worker/routeMath.js'), 'CARGO_CAP'));
  });
});

describe('derived mining figures', () => {
  it('derives the dwell from the two constants, not a third literal', () => {
    expect(TICKS_PER_HOLD).toBe(Math.ceil(BASE_HOLD / MINE_RATE_PER_TICK));
  });

  it('rounds loads UP — a partial load is still a trip', () => {
    // Stated against an EXPLICIT hold, so retuning BASE_HOLD does not
    // break a test about rounding. The first version used the default
    // and failed the moment the hold moved 500 -> 400, which is noise
    // rather than a caught regression.
    expect(loadsRemaining(400, 400)).toBe(1);
    expect(loadsRemaining(401, 400)).toBe(2);
    expect(loadsRemaining(1200, 400)).toBe(3);
  });

  it('uses BASE_HOLD when no cap is given', () => {
    expect(loadsRemaining(BASE_HOLD)).toBe(1);
    expect(loadsRemaining(BASE_HOLD + 1)).toBe(2);
  });

  it('reports nothing left for an exhausted rock', () => {
    expect(loadsRemaining(0)).toBe(0);
    expect(loadsRemaining(-5)).toBe(0);
  });

  it('honours a captain-boosted hold', () => {
    expect(loadsRemaining(1200, 600)).toBe(2);
  });
});
