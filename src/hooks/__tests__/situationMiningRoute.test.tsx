// ============================================================
// Situation Report: a mining run is not a broken trade route.
//
// Player report, 2026-09-29 (Crimson_Song): "this alert is super
// confusing because I used the mining run button to make the route but
// it seems to be... unhappy?" -- "Trade route broken — No holding at
// MTR-05". The broken-route rule wanted a settlement of yours at both
// ends, and a mining run's pickup end is a meteoroid, which nobody holds.
// Each stop is now judged by what it does: a mine stop needs no holding.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSituationItems, SituationItem } from '../useSituationItems';
import type { GameState, Ship, TradeRoute } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = 'home';
const ROCK = 'mtr05';
const hauler = {
  id: 'fr1', name: 'Digger', class: 'freighter', ownedBy: 'player', hp: 100, hpMax: 100,
  orbit: { parentBodyId: HOME, radius: 2, angle0: 0, epoch: 0, direction: 1 },
} as unknown as Ship;

function route(extra: Partial<TradeRoute>): TradeRoute {
  return {
    id: 'r1', ownedBy: 'player', shipId: 'fr1', originBodyId: ROCK, destBodyId: HOME,
    status: 'outbound', cargo: { fuel: 0, ore: 0, credits: 0, science: 0 }, createdAtTick: 1,
    stops: [
      { sequence: 0, bodyId: ROCK, action: 'mine', takeMetal: true, takeGold: true },
      { sequence: 1, bodyId: HOME, action: 'dropoff', takeMetal: true, takeGold: true },
    ],
    ...extra,
  } as unknown as TradeRoute;
}

function state(routes: TradeRoute[], { ships = [hauler], holdHome = true } = {}): GameState {
  return {
    currentTick: 10,
    ships,
    bodies: [
      { id: HOME, name: 'Ceres', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 30, orbitPeriod: 50, angle0: 0 },
      { id: ROCK, name: 'MTR-05', type: 'meteoroid', radius: 0.1, mu: 0, orbitRadius: 31, orbitPeriod: 51, angle0: 1, mineralKind: 'metal', mineralRemaining: 400 },
      { id: 'theirs', name: 'Vesta', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 33, orbitPeriod: 53, angle0: 2 },
    ],
    settlements: holdHome
      ? [{ id: 'st1', name: 'Ceres City', type: 'city', ownedBy: 'player', bodyId: HOME, hp: 100, maxHp: 100 }]
      : [],
    fleets: [],
    factions: [{ id: 'player', name: 'Me', color: '#fff' }],
    factionResources: {},
    factionTech: {},
    tradeRoutes: routes,
    combatLog: [],
  } as unknown as GameState;
}

function broken(gs: GameState): SituationItem[] {
  let out: SituationItem[] = [];
  const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
  const root = createRoot(document.createElement('div'));
  act(() => { root.render(<Probe />); });
  act(() => root.unmount());
  return out.filter(i => i.category === 'broken_route');
}

describe('broken trade routes', () => {
  it('a fresh mining run (mine a rock, drop at home) is healthy', () => {
    expect(broken(state([route({})]))).toHaveLength(0);
  });

  it('a mining run whose delivery world is lost IS broken, and says where', () => {
    const b = broken(state([route({})], { holdHome: false }));
    expect(b).toHaveLength(1);
    expect(b[0].title).toBe('Trade route broken — No holding at Ceres');
  });

  it('a mining run that lost its freighter is broken', () => {
    expect(broken(state([route({})], { ships: [] }))[0]?.title).toBe('Trade route broken — Hauler lost');
  });

  it('a pickup at a world you do not hold is still broken', () => {
    const r = route({
      originBodyId: 'theirs',
      stops: [
        { sequence: 0, bodyId: 'theirs', action: 'pickup', takeMetal: true, takeGold: true },
        { sequence: 1, bodyId: HOME, action: 'dropoff', takeMetal: true, takeGold: true },
      ] as TradeRoute['stops'],
    });
    expect(broken(state([r]))[0]?.title).toBe('Trade route broken — No holding at Vesta');
  });

  it('an old route with no stop list is judged by its two ends, as before', () => {
    const r = route({ originBodyId: HOME, destBodyId: 'theirs', stops: undefined });
    expect(broken(state([r]))[0]?.title).toBe('Trade route broken — No holding at Vesta');
  });

  it('a partner lane that also picks up at THEIR world is healthy', () => {
    const r = route({
      originBodyId: HOME, destBodyId: 'theirs', counterpartyFactionId: 'rival',
      stops: [
        { sequence: 0, bodyId: HOME, action: 'pickup', takeMetal: true, takeGold: true },
        { sequence: 1, bodyId: 'theirs', action: 'dropoff', takeMetal: true, takeGold: true },
        { sequence: 2, bodyId: 'theirs', action: 'pickup', takeMetal: true, takeGold: true },
        { sequence: 3, bodyId: HOME, action: 'dropoff', takeMetal: true, takeGold: true },
      ] as TradeRoute['stops'],
    });
    expect(broken(state([r]))).toHaveLength(0);
  });
});
