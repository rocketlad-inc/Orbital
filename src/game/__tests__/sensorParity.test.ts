// THE SENSOR EDGE THE MAP DRAWS IS THE ONE THE SERVER USES.
//
// The server decides which hulls you can see (worker/state.js
// buildFriendlySensors) and the map draws the edge of your coverage from
// its own copy of the rules (visibility.ts coverageRings). Every number
// that differs between the two puts revealed hulls outside the drawn
// line, which is how this was found (2026-10-05). These read the
// server's source and hold the client's copies to it.

import fs from 'fs';
import path from 'path';
import {
  SHIP_SENSOR_RANGE, SETTLEMENT_SENSOR_RANGE, TELESCOPE_SENSOR_BONUS, PATHFINDER_SENSOR_MUL,
  coverageRings, setSensorScale,
} from '../visibility';
import type { Body, Ship, Settlement } from '../../types';

const state = fs.readFileSync(path.resolve(__dirname, '../../../worker/state.js'), 'utf8');

describe('sensor parity with the server', () => {
  it('telescope bonus and pathfinder multiplier match', () => {
    expect(state).toMatch(new RegExp(`TELESCOPE_SENSOR_BONUS = ${TELESCOPE_SENSOR_BONUS};`));
    expect(state).toMatch(new RegExp(`'pathfinder'\\)\\) \\{\\s*range \\*= ${PATHFINDER_SENSOR_MUL};`));
  });

  it('ship and settlement base reach match', () => {
    const SENSOR_SCALE = 2;
    for (const [cls, v] of Object.entries(SHIP_SENSOR_RANGE)) {
      expect(state).toMatch(new RegExp(`${cls}: ${v / SENSOR_SCALE} \\* SENSOR_SCALE`));
    }
    for (const [type, v] of Object.entries(SETTLEMENT_SENSOR_RANGE)) {
      expect(state).toMatch(new RegExp(`${type}: ${v / SENSOR_SCALE} \\* SENSOR_SCALE`));
    }
  });

  it('coverageRings counts telescopes, pathfinders and arrays', () => {
    setSensorScale(1);
    const body = { id: 'mars', parent: undefined, orbitRadius: 0, type: 'terrestrial', radius: 1 } as unknown as Body;
    const st = { id: 'c', ownedBy: 'player', type: 'city', bodyId: 'mars', buildings: { telescope: 2 } } as unknown as Settlement;
    const ship = {
      id: 's', ownedBy: 'player', class: 'frigate', captainTraits: ['pathfinder'],
      orbit: { parentBodyId: 'mars', rp: 1, ra: 1, omega: 0, M0: 0, epoch: 0, period: 0, direction: 1 },
    } as unknown as Ship;
    const rings = coverageRings('player', [ship], [st], [body], 0, new Set(), undefined, [{ bodyId: 'mars', range: 1100 }]);
    const ranges = rings.map(r => Math.round(r.range)).sort((a, b) => a - b);
    expect(ranges).toEqual([
      Math.round(SHIP_SENSOR_RANGE.frigate * PATHFINDER_SENSOR_MUL),
      1100,
      SETTLEMENT_SENSOR_RANGE.city + 2 * TELESCOPE_SENSOR_BONUS,
    ].sort((a, b) => a - b));
  });
});
