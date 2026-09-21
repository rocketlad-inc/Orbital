// THE REPORTED BUG: ShipPanel's DETACH / REJOIN / LEAVE / DISBAND /
// ADD SHIPS sent PATCH /fleets/fl_yyv7ai. game_fleets.id is
// "<gameId>:fl_yyv7ai" and the worker matches it exactly, so every one
// of them came back 404 "fleet not found" (reproduced on prod). The
// client strips the prefix when it maps state; FleetPanel put it back,
// ShipPanel never did.

import * as fs from 'fs';
import * as path from 'path';
import { fleetPath, qualifyFleetId } from '../fleetWire';

const GAME = 'Jt4AQbYy7M4l';

describe('fleetPath', () => {
  it('puts the game namespace back on a stripped fleet id', () => {
    expect(fleetPath(GAME, 'fl_yyv7ai')).toBe(`/fleets/${encodeURIComponent(`${GAME}:fl_yyv7ai`)}`);
  });

  it('keeps a sub-resource suffix after the id', () => {
    expect(fleetPath(GAME, 'fl_yyv7ai', '/orders'))
      .toBe(`/fleets/${encodeURIComponent(`${GAME}:fl_yyv7ai`)}/orders`);
  });

  it('never double-qualifies an id that already carries the prefix', () => {
    expect(qualifyFleetId(GAME, `${GAME}:fl_yyv7ai`)).toBe(`${GAME}:fl_yyv7ai`);
  });
});

// A unit test of the helper can't see a caller that skips it — that is
// exactly how ShipPanel broke. So: no source file may hand-build a
// per-fleet path. `/fleets` alone (create) is fine; `/fleets/${...}` is not.
const SRC = path.join(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') sourceFiles(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('per-fleet API paths', () => {
  it('are always built by fleetPath, never by hand from a stripped id', () => {
    const bad = /\/fleets\/\$\{/;
    const offenders = sourceFiles(SRC)
      .filter(f => !f.endsWith('fleetWire.ts'))
      .flatMap(f => fs.readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (bad.test(line) ? `${path.relative(SRC, f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null));
    expect(offenders).toEqual([]);
  });
});
