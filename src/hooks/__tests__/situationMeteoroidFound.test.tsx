// ============================================================
// Situation Report: a meteoroid your sensors found is ore to collect.
//
// Playtest, 2026-10-24: "Survey found MTR-16 — 825 credits" read like a
// payout, and the credits never reached the treasury, because a find
// banks nothing; the ore stays in the rock until a freighter mines it.
// Priya also never saw a find in the Situation Report. It is now a row
// there until a hull or a route of yours is working the rock.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSituationItems, SituationItem } from '../useSituationItems';
import type { GameState, Ship, TradeRoute } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROCK = 'mtr16';
const find = { bodyId: ROCK, tick: 5, name: 'MTR-16', kind: 'gold' as const, tons: 825 };

function state({ tick = 10, ships = [] as Ship[], routes = [] as TradeRoute[], left = 825 } = {}): GameState {
  return {
    currentTick: tick,
    ships,
    bodies: [
      { id: 'home', name: 'Ceres', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 30, orbitPeriod: 50, angle0: 0 },
      { id: ROCK, name: 'MTR-16', type: 'meteoroid', radius: 0.1, mu: 0, orbitRadius: 31, orbitPeriod: 51, angle0: 1, mineralKind: 'gold', mineralRemaining: left },
    ],
    settlements: [],
    fleets: [],
    factions: [{ id: 'player', name: 'Me', color: '#fff' }],
    factionResources: {},
    factionTech: {},
    tradeRoutes: routes,
    combatLog: [],
    recentMeteoroidFinds: [find],
  } as unknown as GameState;
}

function rows(gs: GameState): SituationItem[] {
  let out: SituationItem[] = [];
  const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
  const root = createRoot(document.createElement('div'));
  act(() => { root.render(<Probe />); });
  act(() => root.unmount());
  return out.filter(i => i.category === 'meteoroid_found');
}

describe('meteoroid finds in the Situation Report', () => {
  it('a fresh find is a row that says the ore still has to be mined', () => {
    const r = rows(state());
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('Meteoroid found: MTR-16');
    expect(r[0].subtitle).toBe('825 credits to mine; send a freighter to bring it home.');
    expect(r[0].tier).toBe('opportunity');
    expect(r[0].focus).toEqual({ kind: 'body', bodyId: ROCK });
  });

  it('goes once a freighter of yours is mining it', () => {
    const digger = { id: 'f1', name: 'Digger', class: 'freighter', ownedBy: 'player', hp: 100, hpMax: 100, miningBodyId: ROCK,
      orbit: { parentBodyId: ROCK, radius: 1, angle0: 0, epoch: 0, direction: 1 } } as unknown as Ship;
    expect(rows(state({ ships: [digger] }))).toHaveLength(0);
  });

  it('goes once a route of yours mines it', () => {
    const r = { id: 'r1', ownedBy: 'player', stops: [{ sequence: 0, bodyId: ROCK, action: 'mine' }] } as unknown as TradeRoute;
    expect(rows(state({ routes: [r] }))).toHaveLength(0);
  });

  it('goes when the rock is worked out, or the find is old news', () => {
    expect(rows(state({ left: 0 }))).toHaveLength(0);
    expect(rows(state({ tick: 100 }))).toHaveLength(0);
  });
});
