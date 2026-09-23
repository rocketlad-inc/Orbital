// ============================================================
// Situation Report: a fleet arrival is ONE row, and a fallen capital
// is a NOW-tier alarm.
//
// QA battle test, 2026-09-22:
//   - a 70-hull fleet landed at Mars and NEEDS A DECISION listed 70
//     "<ship> arrived at Mars — Awaiting orders" rows (badge 74);
//   - the player's capital city fell and the report said nothing: one
//     ordinary event-log line, styled like a ship kill.
//
// Drives the real hook: ships in transit on the first render, parked on
// the second (that is how "arrived" is detected: the stamp lands in an
// effect), read back on the next poll's render.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSituationItems, SituationItem } from '../useSituationItems';
import type { GameState, Ship } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARS = 'mars';
const ship = (i: number, fleetId: string | null, inTransit: boolean): Ship => ({
  id: `s${i}`, name: `Havoc ${i}`, class: 'frigate', ownedBy: 'player',
  hp: 1000, hpMax: 1000, fleetId,
  orbit: { parentBodyId: MARS, radius: 2, angle0: 0, epoch: 0, direction: 1 },
  transit: inTransit ? { destBodyId: MARS } : undefined,
} as unknown as Ship);

function state(tick: number, ships: Ship[], extra: Partial<GameState> = {}): GameState {
  return {
    currentTick: tick,
    ships,
    bodies: [{ id: MARS, name: 'Mars', type: 'terrestrial', radius: 1, mu: 1, orbitRadius: 30, orbitPeriod: 50, angle0: 0 }],
    settlements: [],
    fleets: [{ id: 'f1', name: 'Earth Group', shipIds: ships.filter(s => s.fleetId === 'f1').map(s => s.id), leadShipId: 's0', ownedBy: 'player' }],
    factions: [{ id: 'player', name: 'Me', color: '#fff' }],
    factionResources: {},
    factionTech: {},
    tradeRoutes: [],
    combatLog: [],
    ...extra,
  } as unknown as GameState;
}

function run(states: GameState[]): SituationItem[] {
  let out: SituationItem[] = [];
  const Probe: React.FC<{ gs: GameState }> = ({ gs }) => {
    out = useSituationItems(gs, 'player');
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  for (const gs of states) act(() => { root.render(<Probe gs={gs} />); });
  act(() => root.unmount());
  return out;
}

describe('Situation Report — fleet arrivals', () => {
  const N = 70;
  const fleetShips = (inTransit: boolean) => Array.from({ length: N }, (_, i) => ship(i, 'f1', inTransit));

  it('a 70-hull fleet landing is ONE arrived row, named for the fleet', () => {
    const items = run([state(10, fleetShips(true)), state(11, fleetShips(false)), state(11, fleetShips(false))]);
    const arrived = items.filter(i => i.category === 'arrived');
    expect(arrived).toHaveLength(1);
    expect(arrived[0].title).toBe(`Earth Group (${N} ships) arrived at Mars`);
    expect(arrived[0].focus).toEqual({ kind: 'ship', shipId: 's0' });
  });

  it('loose hulls still get a row each', () => {
    const loose = (t: boolean) => [ship(100, null, t), ship(101, null, t)];
    const items = run([state(10, [...fleetShips(true), ...loose(true)]), state(11, [...fleetShips(false), ...loose(false)]), state(11, [...fleetShips(false), ...loose(false)])]);
    expect(items.filter(i => i.category === 'arrived')).toHaveLength(3);
  });

  it('a battered fleet is ONE damaged row naming its weakest hull', () => {
    const hurt = fleetShips(false).map((s, i) => ({ ...s, hp: i === 7 ? 200 : 400 } as Ship));
    const items = run([state(20, hurt)]);
    const dmg = items.filter(i => i.category === 'damaged');
    expect(dmg).toHaveLength(1);
    expect(dmg[0].title).toBe(`Earth Group: ${N} hulls damaged, weakest 20% HP`);
    expect(dmg[0].focus).toEqual({ kind: 'ship', shipId: 's7' });
  });
});

describe('Situation Report — capital lost', () => {
  const loss = { eventId: 'c30_setl', bodyId: 'earth', bodyName: 'Earth', tick: 30, killerName: 'Gold Test Pact' };

  it('raises a NOW row naming the world and the attacker', () => {
    const items = run([state(31, [], { capitalLoss: loss })]);
    const row = items.find(i => i.category === 'capital_lost');
    expect(row).toBeDefined();
    expect(row!.tier).toBe('now');
    expect(row!.title).toBe('Your capital on Earth has fallen');
    expect(row!.subtitle).toMatch(/Gold Test Pact/);
  });

  it('clears once a city of yours stands there again', () => {
    const city = { id: 'x', bodyId: 'earth', ownedBy: 'player', type: 'city' };
    const items = run([state(32, [], { capitalLoss: loss, settlements: [city] as unknown as GameState['settlements'] })]);
    expect(items.some(i => i.category === 'capital_lost')).toBe(false);
  });

  it('ages out after ten ticks', () => {
    const items = run([state(41, [], { capitalLoss: loss })]);
    expect(items.some(i => i.category === 'capital_lost')).toBe(false);
  });
});
