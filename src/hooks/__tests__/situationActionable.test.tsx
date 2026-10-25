// ============================================================
// Situation Report: only nag about what the player can act on.
//
// Playtest R2-C3 (Dale, Rafaela): "Capital builds nothing" while every
// upgrade there was research-locked; a yard row about a hull nobody
// could build yet; and the freighter advice contradicting itself ("put
// it on a trade route" beside "no idle freighter, terraforming needs
// one").
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSituationItems, SituationItem } from '../useSituationItems';
import type { GameState } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function state(extra: Partial<GameState> = {}): GameState {
  return {
    currentTick: 10,
    gatingEnabled: true,
    ships: [],
    bodies: [{ id: 'home', name: 'Ceres', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 30, orbitPeriod: 50, angle0: 0, ownedBy: 'player', terraformedAtTick: 1 }],
    settlements: [{ id: 'st1', name: 'Capital', type: 'city', ownedBy: 'player', bodyId: 'home', hp: 100, maxHp: 100, buildings: {} }],
    resources: { player: { ore: 100000, credits: 100000, fuel: 0, science: 0 } },
    fleets: [],
    factions: [{ id: 'player', name: 'Me', color: '#fff' }],
    factionResources: {},
    factionTech: { player: { levels: {} } },
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

describe('building_idle respects research', () => {
  it('every first level locked: no "builds nothing" row', () => {
    expect(items(state()).some(i => i.category === 'building_idle')).toBe(false);
  });
  it('one unlocked upgrade it can pay for: the row is back', () => {
    const gs = state({ factionTech: { player: { levels: { industry: 1 } } } } as Partial<GameState>);
    expect(items(gs).some(i => i.category === 'building_idle')).toBe(true);
  });
  it('a building already started keeps upgrading whatever the gate says', () => {
    const gs = state({
      settlements: [{ id: 'st1', name: 'Capital', type: 'city', ownedBy: 'player', bodyId: 'home', hp: 100, maxHp: 100, buildings: { forge: 1 } }],
    } as unknown as Partial<GameState>);
    expect(items(gs).some(i => i.category === 'building_idle')).toBe(true);
  });
});

describe('idle freighters: one definition', () => {
  const freighter = {
    id: 'f1', name: 'Packhorse', class: 'freighter', ownedBy: 'player', hp: 50, hpMax: 50,
    orbit: { parentBodyId: 'home', radius: 2, angle0: 0, epoch: 0, direction: 1 },
  };
  const raw = { id: 'ariel', name: 'Ariel', type: 'moon', radius: 1, mu: 1, orbitRadius: 5, orbitPeriod: 9, angle0: 0, ownedBy: 'player', terraformedAtTick: null };
  it('a freighter listed as idle is counted as the free hauler for terraforming', () => {
    const gs = state({
      ships: [freighter],
      bodies: [...state().bodies, raw],
      // A paused route still names the ship; it is not working.
      tradeRoutes: [{ id: 'r1', ownedBy: 'player', shipId: 'f1', status: 'paused', kind: 'trade', originBodyId: 'home', destBodyId: 'home', stops: [] }],
    } as unknown as Partial<GameState>);
    const xs = items(gs);
    expect(xs.some(i => i.category === 'idle_freighter')).toBe(true);
    const tf = xs.find(i => i.category === 'terraform_unstarted');
    expect(tf?.subtitle).toMatch(/^1 idle freighter/);
  });
});
