/**
 * An ordered refit says WHERE and WHEN it will happen, or WHY it can't,
 * and the situation report shows both ends of it.
 *
 * Lorne, 2026-10-06: "Players keep reporting 'nothing happens' on
 * retrofit." The panel only ever said "fits on arrival at a friendly
 * world", and a refit that landed did so in silence.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { refitStatus } from '../refitStatus';
import { useSituationItems, SituationItem } from '../../hooks/useSituationItems';
import type { GameState, Ship } from '../../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DESIGN = { id: 'dsn1', shipClass: 'freighter', name: 'Scrapper', parts: ['mining'], isActive: false };

const ship = (over: Partial<Ship> = {}): Ship => ({
  id: 'g:s1', name: 'The Rotten Leviathan', class: 'freighter', ownedBy: 'player',
  orbit: { parentBodyId: 'mercury' }, parts: ['engine'], refitPendingDesignId: 'dsn1',
  hp: 74, maxHp: 74,
  ...over,
} as unknown as Ship);

const state = (over: Record<string, unknown> = {}): GameState => ({
  currentTick: 88,
  ships: [],
  bodies: [
    { id: 'mercury', name: 'Mercury', type: 'terrestrial', radius: 1, mu: 1, orbitRadius: 20, orbitPeriod: 30, angle0: 0 },
    { id: 'venus', name: 'Venus', type: 'terrestrial', radius: 1, mu: 1, orbitRadius: 30, orbitPeriod: 50, angle0: 1 },
    { id: 'ceres', name: 'Ceres', type: 'dwarf', radius: 1, mu: 1, orbitRadius: 60, orbitPeriod: 90, angle0: 2 },
  ],
  settlements: [
    { id: 'st1', name: 'Hermes', type: 'station', ownedBy: 'player', bodyId: 'mercury', hp: 100, maxHp: 100 },
    { id: 'st2', name: 'Aphro', type: 'city', ownedBy: 'player', bodyId: 'venus', hp: 100, maxHp: 100 },
  ],
  shipDesigns: [DESIGN],
  resources: { player: { ore: 1000, credits: 1000, fuel: 0, science: 0 } },
  tradeRoutes: [],
  fleets: [],
  factions: [{ id: 'player', name: 'Me', color: '#fff' }],
  factionTech: {},
  combatLog: [],
  ...over,
} as unknown as GameState);

const leg = (target: string, arriveTick: number) => ({ targetBodyId: target, arriveTick, startTick: 80 });

describe('where and when', () => {
  it('parked at a friendly world: next tick, there', () => {
    const st = refitStatus(ship(), state())!;
    expect(st.text).toBe('Fits at Mercury next tick');
    expect(st.blocked).toBeNull();
  });

  it('flying to a friendly world: that arrival, by tick', () => {
    const s = ship({ transit: { currentTransfer: leg('venus', 88.4) } } as Partial<Ship>);
    expect(refitStatus(s, state())!.text).toBe('Fits at Venus, tick 89');
  });

  it('on a route: the first friendly stop', () => {
    const s = ship({ orbit: { parentBodyId: 'ceres' }, transit: { currentTransfer: leg('ceres', 95) } } as Partial<Ship>);
    const gs = state({
      tradeRoutes: [{ id: 'r1', shipId: 'g:s1', originBodyId: 'ceres', destBodyId: 'venus', stops: [
        { sequence: 0, bodyId: 'ceres', action: 'mine' }, { sequence: 1, bodyId: 'venus', action: 'dropoff' },
      ] }],
    });
    expect(refitStatus(s, gs)!.text).toBe('Fits next time its route reaches Venus');
  });
});

describe('why not', () => {
  it('the treasury cannot cover the fee', () => {
    const st = refitStatus(ship(), state({ resources: { player: { ore: 0, credits: 0, fuel: 0, science: 0 } } }))!;
    expect(st.blocked?.reason).toBe('cant_afford');
    expect(st.text).toMatch(/^Waiting for \d+ metal/);
  });

  it('nowhere friendly on its course', () => {
    const s = ship({ orbit: { parentBodyId: 'ceres' } } as Partial<Ship>);
    expect(refitStatus(s, state())!.blocked?.reason).toBe('no_friendly_stop');
  });

  it('the design was deleted', () => {
    expect(refitStatus(ship(), state({ shipDesigns: [] }))!.blocked?.reason).toBe('design_gone');
  });

  it('no refit ordered, no status', () => {
    expect(refitStatus(ship({ refitPendingDesignId: null } as Partial<Ship>), state())).toBeNull();
  });
});

function items(gs: GameState): SituationItem[] {
  let out: SituationItem[] = [];
  const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
  const root = createRoot(document.createElement('div'));
  act(() => { root.render(<Probe />); });
  act(() => root.unmount());
  return out;
}

describe('the situation report', () => {
  it('says when a refit landed', () => {
    const gs = state({
      ships: [ship({ refitPendingDesignId: null, parts: ['mining'] } as Partial<Ship>)],
      recentRefits: [{ shipId: 'g:s1', tick: 87, shipName: 'The Rotten Leviathan', designName: 'Scrapper',
        bodyId: 'venus', bodyName: 'Venus' }],
    });
    const row = items(gs).find(i => i.category === 'refit_done');
    expect(row?.title).toBe('The Rotten Leviathan refitted to Scrapper');
    expect(row?.subtitle).toBe('at Venus, tick 87');
  });

  it('forgets it after ten ticks', () => {
    const gs = state({
      currentTick: 120,
      ships: [ship({ refitPendingDesignId: null } as Partial<Ship>)],
      recentRefits: [{ shipId: 'g:s1', tick: 87, shipName: 'x', designName: 'Scrapper', bodyId: 'venus', bodyName: 'Venus' }],
    });
    expect(items(gs).some(i => i.category === 'refit_done')).toBe(false);
  });

  it('flags an ordered refit that is going nowhere, and only that one', () => {
    const stuck = ship({ id: 'g:s2', name: 'Stuck', orbit: { parentBodyId: 'ceres' } } as Partial<Ship>);
    const fine = ship();
    const rows = items(state({ ships: [stuck, fine] })).filter(i => i.category === 'refit_waiting');
    expect(rows.map(r => r.title)).toEqual(['Stuck: refit to Scrapper is waiting']);
    expect(rows[0].subtitle).toMatch(/No friendly world on its course/);
  });
});
