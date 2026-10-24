// ============================================================
// Situation Report: a finished building is news for a few ticks, not a
// standing decision.
//
// Playtest, 2026-10-24 (Dale): "Defense 1 complete" sat under NEEDS A
// DECISION for 7+ ticks. It now asks for a decision only while it is
// fresh and an upgrade here is affordable; then the free slot is the
// ordinary idle row (or nothing, when nothing can be paid for).
// ============================================================

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useSituationItems, SituationItem } from '../useSituationItems';
import type { GameState } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function state(tick: number, building: boolean, rich: boolean): GameState {
  return {
    currentTick: tick,
    ships: [],
    bodies: [{ id: 'home', name: 'Ceres', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 30, orbitPeriod: 50, angle0: 0 }],
    settlements: [{
      id: 'st1', name: 'Ceres City', type: 'city', ownedBy: 'player', bodyId: 'home', hp: 100, maxHp: 100,
      buildings: { defense: 1 },
      ...(building ? { buildingQueue: { kind: 'defense', targetLevel: 1, startTick: 0, completeTick: tick + 1 } } : {}),
    }],
    resources: { player: rich ? { ore: 100000, credits: 100000, fuel: 0, science: 0 } : { ore: 0, credits: 0, fuel: 0, science: 0 } },
    fleets: [],
    factions: [{ id: 'player', name: 'Me', color: '#fff' }],
    factionResources: {},
    factionTech: {},
    tradeRoutes: [],
    combatLog: [],
  } as unknown as GameState;
}

let out: SituationItem[] = [];
let gs: GameState;
const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
function run(seq: GameState[]): SituationItem[] {
  const root: Root = createRoot(document.createElement('div'));
  // Completions are seen as TRANSITIONS (an effect after the render), so
  // they show on the next /state, as in the game.
  for (const g of seq) { gs = g; act(() => { root.render(<Probe />); }); }
  act(() => root.unmount());
  return out.filter(i => i.category === 'building_done' || i.category === 'building_idle');
}

describe('building completions in the Situation Report', () => {
  it('fresh and affordable: a decision', () => {
    const r = run([state(10, true, true), state(11, false, true), state(11, false, true)]);
    expect(r.map(i => [i.category, i.tier])).toEqual([['building_done', 'decision']]);
  });

  it('a few ticks later it is the plain idle row, not a decision', () => {
    const r = run([state(10, true, true), state(11, false, true), state(18, false, true)]);
    expect(r.map(i => [i.category, i.tier])).toEqual([['building_idle', 'opportunity']]);
  });

  it('nothing affordable: news, never a decision', () => {
    const r = run([state(10, true, false), state(11, false, false), state(11, false, false)]);
    expect(r.map(i => [i.category, i.tier])).toEqual([['building_done', 'opportunity']]);
    expect(run([state(10, true, false), state(11, false, false), state(18, false, false)])).toEqual([]);
  });
});
