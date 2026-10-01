// ============================================================
// "Hostile" means AT WAR, in the Situation Report and the threat list.
//
// Lorne, 2026-09-29: "I'm getting a lot of threatening warnings about
// ships I'm not at war with" -- "1 hostile inbound -> Ceres", "Vesta
// Station -- hostiles overhead", from empires nobody had declared on.
// War is declared now and peace is the default, but both checks still
// skipped only TREATY partners, so every neighbour without a pact read
// as an enemy. They now read gameState.warPairs, the list the tick's
// combat pass fires on.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { computeIncomingThreats } from '../threats';
import { useSituationItems, SituationItem } from '../../hooks/useSituationItems';
import type { GameState, Ship } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VESTA = 'vesta';
const CERES = 'ceres';
const AT_WAR = ['player|wonks'];

const inbound = {
  id: 'w1', name: 'Silly Frigate', class: 'frigate', ownedBy: 'wonks',
  hp: 100, hpMax: 100,
  orbit: { parentBodyId: CERES, radius: 2, angle0: 0, epoch: 0, direction: 1 },
  transit: { currentTransfer: { targetBodyId: VESTA, arriveTick: 28, startTick: 5 } },
} as unknown as Ship;
const overhead = {
  id: 'w2', name: 'Silly Corvette', class: 'corvette', ownedBy: 'wonks',
  hp: 100, hpMax: 100,
  orbit: { parentBodyId: VESTA, radius: 2, angle0: 0, epoch: 0, direction: 1 },
} as unknown as Ship;

function state(extra: Partial<GameState>): GameState {
  return {
    currentTick: 10,
    ships: [inbound, overhead],
    bodies: [
      { id: VESTA, name: 'Vesta', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 40, orbitPeriod: 60, angle0: 0 },
      { id: CERES, name: 'Ceres', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 42, orbitPeriod: 62, angle0: 1 },
    ],
    settlements: [{ id: 'st1', name: 'Vesta Station', type: 'station', ownedBy: 'player', bodyId: VESTA, hp: 100, maxHp: 100 }],
    fleets: [],
    factions: [{ id: 'player', name: 'Me', color: '#fff' }, { id: 'wonks', name: 'The Ministry of Silly Wonks', color: '#f0f' }],
    factionResources: {},
    factionTech: {},
    tradeRoutes: [],
    combatLog: [],
    ...extra,
  } as unknown as GameState;
}

function items(gs: GameState): SituationItem[] {
  let out: SituationItem[] = [];
  const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
  const root = createRoot(document.createElement('div'));
  act(() => { root.render(<Probe />); });
  act(() => root.unmount());
  return out;
}
const overheadRow = (xs: SituationItem[]) => xs.find(i => /Vesta Station/.test(i.title) && i.category === 'in_combat');

describe('incoming threats', () => {
  it('a neighbour you are not at war with is not a threat', () => {
    expect(computeIncomingThreats(state({ warPairs: [] }), 'player')).toHaveLength(0);
  });
  it('an empire at war with you is', () => {
    const t = computeIncomingThreats(state({ warPairs: AT_WAR }), 'player');
    expect(t).toHaveLength(1);
    expect(t[0].targetBodyId).toBe(VESTA);
  });
  it('a war between two OTHER empires does not make either your threat', () => {
    expect(computeIncomingThreats(state({ warPairs: ['rivals|wonks'] }), 'player')).toHaveLength(0);
  });
  it('a treaty no longer decides it: no pact and no war is still peace', () => {
    expect(computeIncomingThreats(state({ warPairs: [], peaceFactionIds: [] }), 'player')).toHaveLength(0);
  });
  it('single-player (no war data) keeps its everyone-is-hostile rule', () => {
    expect(computeIncomingThreats(state({}), 'player')).toHaveLength(1);
  });
});

describe('Situation Report: hostiles overhead', () => {
  it('a neighbour parked over your station is not "hostiles overhead"', () => {
    expect(overheadRow(items(state({ warPairs: [] })))).toBeUndefined();
  });
  it('an enemy parked there is', () => {
    const row = overheadRow(items(state({ warPairs: AT_WAR })));
    expect(row?.title).toBe('Vesta Station — hostiles overhead');
  });
});
