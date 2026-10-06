// ============================================================
// THE SITUATION REPORT FOLLOWS THE SUN GATES, MOMENT BY MOMENT.
//
// Lorne, 2026-10-06: "the situation log tracks each moment". The moments
// (worker/sunGates.js): a warning before EACH gate, the flight out of
// the Sun, the turn to brake, the unfolding at the landing site, the
// opening, and the first hull through. Each one has its own row, and
// each row is gone when its moment is.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSituationItems, SituationItem } from '../../hooks/useSituationItems';
import type { Body, GameState } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOL = { id: 'sol', name: 'Sol', type: 'star', radius: 50, mu: 1, orbitRadius: 0, orbitPeriod: 0, angle0: 0 } as Body;
const flyingGate = (from: number, until: number) => ({
  id: 'sungate_centauri', name: 'Centauri Gate', type: 'megastructure', parent: 'sol',
  radius: 2, mu: 1, orbitRadius: 25000, orbitPeriod: 16000, angle0: 0,
  emerge: { fromTick: from, untilTick: until },
} as unknown as Body);
const site = { id: 'sungate_centauri_site', name: 'Centauri Gate landing site', type: 'lagrange', parent: 'sol',
  radius: 2, mu: 1, orbitRadius: 25000, orbitPeriod: 16000, angle0: 0 } as unknown as Body;

function state(tick: number, extra: Partial<GameState>): GameState {
  return {
    currentTick: tick,
    ships: [], bodies: [SOL], settlements: [], fleets: [],
    factions: [{ id: 'player', name: 'Me', color: '#fff' }, { id: 'wonks', name: 'The Ministry of Silly Wonks', color: '#f0f' }],
    factionResources: {}, factionTech: {}, tradeRoutes: [], combatLog: [],
    ...extra,
  } as unknown as GameState;
}

function gateRows(gs: GameState): SituationItem[] {
  let out: SituationItem[] = [];
  const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
  const root = createRoot(document.createElement('div'));
  act(() => { root.render(<Probe />); });
  act(() => root.unmount());
  return out.filter(i => i.category === 'sun_gate');
}

describe('the sun gates in the Situation Report', () => {
  it('warns before the first gate, with a countdown', () => {
    const rows = gateRows(state(270, { sunGateTick: 270, sunGateNext: { emergeTick: 276, index: 0 } }));
    expect(rows.map(r => [r.title, r.subtitle])).toEqual([
      ['Something strange is emerging from the Sun', 'Out in 6 ticks'],
    ]);
  });

  it('warns before the SECOND gate too, as something else', () => {
    const rows = gateRows(state(310, { sunGateTick: 270, sunGateNext: { emergeTick: 316, index: 1 } }));
    expect(rows.map(r => r.title)).toEqual(['Something else is emerging from the Sun']);
  });

  it('says nothing between warnings', () => {
    expect(gateRows(state(300, { sunGateTick: 270, sunGateNext: null }))).toEqual([]);
  });

  it('follows the flight: out of the Sun, turned and braking, unfolding', () => {
    const at = (tick: number) => gateRows(state(tick, {
      sunGateTick: 270, sunGateNext: null, bodies: [SOL, flyingGate(276, 286), site],
    }))[0];
    expect(at(277).title).toBe('A gate to Centauri is burning out of the Sun');
    expect(at(282).title).toBe('The gate to Centauri has turned and is braking');
    expect(at(285).title).toBe('The gate to Centauri is unfolding at its landing site');
    // It points at the landing site: the place ships can actually go.
    expect(at(277).focus).toEqual({ kind: 'body', bodyId: 'sungate_centauri_site' });
    expect(at(277).subtitle).toMatch(/Opens at T\+286 \(9 ticks\)/);
  });

  it('announces the opening until someone goes through', () => {
    const open = { ...flyingGate(276, 286), emerge: undefined } as unknown as Body;
    const rows = gateRows(state(290, {
      sunGateTick: 270, sunGateNext: null, bodies: [SOL, open],
      megastructures: { sungate_centauri: { completedAtTick: 286 } } as unknown as GameState['megastructures'],
    }));
    expect(rows.map(r => r.title)).toEqual(['The Centauri Gate is open']);
  });

  it('then reports who was first through, from either end', () => {
    const open = { ...flyingGate(276, 286), emerge: undefined } as unknown as Body;
    const base = {
      sunGateTick: 270, sunGateNext: null, bodies: [SOL, open],
      megastructures: { sungate_centauri: { completedAtTick: 286 } } as unknown as GameState['megastructures'],
    };
    const rival = gateRows(state(292, { ...base,
      sunGateFirsts: [{ gateId: 'sungate_centauri', factionId: 'wonks', tick: 291, ship: 'Pathfinder', toSystem: 'Centauri' }],
    }));
    expect(rival.map(r => r.title)).toEqual(['The Ministry of Silly Wonks was first through the Centauri Gate']);
    expect(rival[0].subtitle).toMatch(/Pathfinder is crossing to Centauri/);
    const mine = gateRows(state(292, { ...base,
      sunGateFirsts: [{ gateId: 'sungate_centauri_far', factionId: 'player', tick: 291, ship: 'Homeward', toSystem: 'Sol' }],
    }));
    expect(mine.map(r => r.title)).toEqual(['You were first through the Centauri Gate']);
  });
});
