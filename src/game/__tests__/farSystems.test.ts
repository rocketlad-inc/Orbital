// ============================================================
// Centauri's two suns double a station's yield, and only there.
//
// Lorne (2026-10-06): "maybe double station yields in the binary
// system". The tick (worker/room.js), the standings estimate
// (worker/factions.js) and every client yield readout
// (settlementYield) must agree, so the rule and its list live in one
// place per side and are held together here.
// ============================================================

import { settlementYield } from '../settlements';
import {
  BINARY_SYSTEM_TEMPLATE_IDS, BINARY_STATION_MUL, isBinarySystemBody,
  BINARY_INNER_TEMPLATE_IDS, setBinaryCloseness, binaryClosenessFrom,
} from '../farSystems';
import type { Body, Settlement } from '../../types';
/* eslint-disable @typescript-eslint/no-var-requires */
const systems = require('../../../worker/systems.js');

const body = (id: string): Body => ({
  id, name: id, type: 'terrestrial', radius: 1, orbitRadius: 100, orbitPeriod: 100,
  angle0: 0, soi: 10, color: '#fff', resources: { fuel: 0, metal: 4, gold: 4, science: 4 },
} as unknown as Body);
const at = (b: Body, type: 'city' | 'station'): Settlement => ({
  id: `${b.id}-${type}`, bodyId: b.id, type, population: 1, buildings: {},
} as unknown as Settlement);

describe('the binary system', () => {
  it('client and server name the same worlds and the same factor', () => {
    expect([...BINARY_SYSTEM_TEMPLATE_IDS].sort()).toEqual([...systems.BINARY_SYSTEM_TEMPLATE_IDS].sort());
    expect(BINARY_STATION_MUL).toBe(systems.BINARY_STATION_MUL);
    // Every one of them is a far-system body.
    for (const id of BINARY_SYSTEM_TEMPLATE_IDS) expect(systems.FAR_SYSTEM_TEMPLATE_IDS.has(id)).toBe(true);
  });

  it('knows a game-prefixed body too', () => {
    expect(isBinarySystemBody({ id: 'g1:verdant' })).toBe(true);
    expect(isBinarySystemBody({ id: 'requiem' })).toBe(false);
  });

  it('scales a station in Centauri by its zone, and nothing else', () => {
    const crimson = body('crimson'), verdant = body('verdant'), earth = body('earth'), requiem = body('requiem');
    const sum = (y: ReturnType<typeof settlementYield>) => y.ore + y.credits + y.science + y.fuel;
    const sol = sum(settlementYield(at(earth, 'station'), earth));
    expect(sol).toBeGreaterThan(0);
    // Around both suns: x2, whatever the dance.
    setBinaryCloseness(0);
    expect(sum(settlementYield(at(crimson, 'station'), crimson))).toBeCloseTo(sol * 2, 9);
    // Around one sun: x1.5 with the suns apart, x3 together.
    expect(sum(settlementYield(at(verdant, 'station'), verdant))).toBeCloseTo(sol * 1.5, 9);
    setBinaryCloseness(1);
    expect(sum(settlementYield(at(verdant, 'station'), verdant))).toBeCloseTo(sol * 3, 9);
    expect(sum(settlementYield(at(crimson, 'station'), crimson))).toBeCloseTo(sol * 2, 9);
    // Cities and other systems: untouched.
    expect(sum(settlementYield(at(verdant, 'city'), verdant)))
      .toBeCloseTo(sum(settlementYield(at(earth, 'city'), earth)), 9);
    expect(sum(settlementYield(at(requiem, 'station'), requiem))).toBeCloseTo(sol, 9);
    setBinaryCloseness(0.5);
  });

  it('the server scales the same thing', () => {
    const base = { fuel: 1.1, metal: 0.8, gold: 1.0, science: 1.4 };
    expect(systems.stationTypeMul(base, 'station', { id: 'g1:crimson' }, 0).science).toBeCloseTo(2.8, 9);
    expect(systems.stationTypeMul(base, 'station', { id: 'g1:verdant' }, 0).science).toBeCloseTo(2.1, 9);
    expect(systems.stationTypeMul(base, 'station', { id: 'g1:verdant' }, 1).science).toBeCloseTo(4.2, 9);
    expect(systems.stationTypeMul(base, 'city', { id: 'g1:crimson' }, 1)).toBe(base);
    expect(systems.stationTypeMul(base, 'station', { id: 'g1:echelon' }, 1)).toBe(base);
    expect([...BINARY_INNER_TEMPLATE_IDS].sort()).toEqual([...systems.BINARY_INNER_TEMPLATE_IDS].sort());
  });

  it('client and server see the suns at the same point of the dance', () => {
    const { binaryCloseness } = require('../../../worker/binaryDance.js');
    const row = { orbit_rp: 276, orbit_ra: 644, orbit_omega: 0, orbit_m0: 0, orbit_period: 168 };
    const bodies = [
      { id: 'binary_barycenter', name: 'b', type: 'lagrange', radius: 1, orbitRadius: 0, orbitPeriod: 1e12, angle0: 0, soi: 0, color: '#fff' },
      { id: 'centauri_a', name: 'A', type: 'star', parent: 'binary_barycenter', radius: 16, orbitRadius: 460,
        orbitPeriod: 168, angle0: 0, soi: 320, color: '#fff', orbit_rp: 276, orbit_ra: 644, orbit_omega: 0, orbit_m0: 0 },
    ] as unknown as Body[];
    for (let tick = 0; tick < 240; tick += 7) {
      expect(binaryClosenessFrom(bodies, tick)).toBeCloseTo(binaryCloseness(row, tick), 9);
    }
  });
});
