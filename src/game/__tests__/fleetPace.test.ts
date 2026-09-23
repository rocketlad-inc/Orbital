// Lorne: "Fleets should move at the speed of their slowest ship, as one
// unit." The QA battle test's fleets arrived smeared over 3-8 ticks.

import { shipEngineAccel, fleetEngineAccel } from '../fleetPace';
import type { Faction, Ship } from '../../types';

const FACTIONS = [{ id: 'player', engineG: 0.05 }] as unknown as Faction[];
const TECH = { player: { levels: { propulsion: 0 } } };
const hull = (id: string, over: Partial<Ship> = {}) =>
  ({ id, ownedBy: 'player', parts: [], hp: 100, ...over } as unknown as Ship);

const fast = hull('fast', { fleetId: 'F', parts: ['engine', 'engine'] as never });
const slow = hull('slow', { fleetId: 'F' });
const loner = hull('loner', { parts: ['engine'] as never });
const detached = hull('detached', { fleetId: 'F', fleetDetached: true, parts: ['engine', 'engine', 'engine'] as never });
const otherFleet = hull('other', { fleetId: 'G', parts: ['engine'] as never });
const SHIPS = [fast, slow, loner, detached, otherFleet];

describe('a fleet flies at its slowest ship', () => {
  it('the premise: engines make a hull faster on its own', () => {
    expect(shipEngineAccel(fast, FACTIONS, TECH)).toBeGreaterThan(shipEngineAccel(slow, FACTIONS, TECH));
  });

  it('the fast member is held to the slow member’s pace', () => {
    expect(fleetEngineAccel(fast, SHIPS, FACTIONS, TECH)).toBeCloseTo(shipEngineAccel(slow, FACTIONS, TECH), 10);
  });

  it('...so every member of the fleet plans with ONE acceleration', () => {
    expect(fleetEngineAccel(fast, SHIPS, FACTIONS, TECH))
      .toBeCloseTo(fleetEngineAccel(slow, SHIPS, FACTIONS, TECH), 10);
  });

  it('a hull in no fleet flies at its own pace', () => {
    expect(fleetEngineAccel(loner, SHIPS, FACTIONS, TECH)).toBe(shipEngineAccel(loner, FACTIONS, TECH));
  });

  it('a detached member flies alone — and does not slow or speed the fleet', () => {
    expect(fleetEngineAccel(detached, SHIPS, FACTIONS, TECH)).toBe(shipEngineAccel(detached, FACTIONS, TECH));
    expect(fleetEngineAccel(fast, SHIPS, FACTIONS, TECH)).toBeCloseTo(shipEngineAccel(slow, FACTIONS, TECH), 10);
  });

  it('another fleet is not held back by this one', () => {
    expect(fleetEngineAccel(otherFleet, SHIPS, FACTIONS, TECH)).toBe(shipEngineAccel(otherFleet, FACTIONS, TECH));
  });

  it('a destroyed mate no longer sets the pace', () => {
    const wreck = hull('wreck', { fleetId: 'F', hp: 0 });
    const withWreck = [fast, wreck];
    expect(fleetEngineAccel(fast, withWreck, FACTIONS, TECH)).toBe(shipEngineAccel(fast, FACTIONS, TECH));
  });
});
