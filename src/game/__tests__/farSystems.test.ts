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
import { BINARY_SYSTEM_TEMPLATE_IDS, BINARY_STATION_MUL, isBinarySystemBody } from '../farSystems';
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

  it('doubles a station in Centauri, and nothing else', () => {
    const verdant = body('verdant'), earth = body('earth'), requiem = body('requiem');
    const sum = (y: ReturnType<typeof settlementYield>) => y.ore + y.credits + y.science + y.fuel;
    expect(sum(settlementYield(at(earth, 'station'), earth))).toBeGreaterThan(0);
    expect(sum(settlementYield(at(verdant, 'station'), verdant)))
      .toBeCloseTo(sum(settlementYield(at(earth, 'station'), earth)) * 2, 9);
    expect(sum(settlementYield(at(verdant, 'city'), verdant)))
      .toBeCloseTo(sum(settlementYield(at(earth, 'city'), earth)), 9);
    expect(sum(settlementYield(at(requiem, 'station'), requiem)))
      .toBeCloseTo(sum(settlementYield(at(earth, 'station'), earth)), 9);
  });

  it('the server doubles the same thing', () => {
    const base = { fuel: 1.1, metal: 0.8, gold: 1.0, science: 1.4 };
    expect(systems.stationTypeMul(base, 'station', { id: 'g1:crimson' }).science).toBeCloseTo(2.8, 9);
    expect(systems.stationTypeMul(base, 'city', { id: 'g1:crimson' })).toBe(base);
    expect(systems.stationTypeMul(base, 'station', { id: 'g1:echelon' })).toBe(base);
  });
});
