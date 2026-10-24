// ============================================================
// WHAT WAITS ON YOUR ANSWER REACHES NEEDS A DECISION (playtest B5/B6).
//
// An open Senate bill, a pact offered to you and a ceasefire offered to
// you each get a NEEDS A DECISION row. MultiplayerShell's polls publish
// them through situationFeed; nothing fed these rows before, so a bill
// passed and the Ally's pact sat unanswered with the report silent.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSituationItems, SituationItem, SituationMpData } from '../../hooks/useSituationItems';
import { publishSituation, clearSituation, currentSituation, onSituation } from '../../multiplayer/situationFeed';
import type { GameState } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gs = {
  currentTick: 3,
  ships: [], bodies: [], settlements: [], fleets: [],
  factions: [{ id: 'player', name: 'Me', color: '#fff' }, { id: 'g:f1', name: 'Outer Alliance', color: '#0f0' }],
  factionResources: {}, factionTech: {}, tradeRoutes: [], combatLog: [],
} as unknown as GameState;

function rows(mp: SituationMpData): SituationItem[] {
  let out: SituationItem[] = [];
  const Probe: React.FC = () => { out = useSituationItems(gs, 'player', mp); return null; };
  const root = createRoot(document.createElement('div'));
  act(() => { root.render(<Probe />); });
  act(() => root.unmount());
  return out.filter(i => ['vote_open', 'incoming_trade', 'ceasefire_offer'].includes(i.category));
}

describe('NEEDS A DECISION: votes, offers and ceasefires', () => {
  it('names a pact-only offer as the pact, not as a trade', () => {
    const [r] = rows({ incomingTrades: [{ id: 't1', proposer_faction_id: 'g:f1', proposer_faction_name: 'Outer Alliance', pacts: ['nap'], pactOnly: true }] });
    expect(r.tier).toBe('decision');
    expect(r.title).toBe('Outer Alliance offers a pact: Non-Aggression Pact');
    expect(r.focus).toEqual({ kind: 'panel', panel: 'trades' });
  });

  it('a ceasefire offered to you is a decision that opens Standing', () => {
    const [r] = rows({ ceasefireOffers: [{ war_id: 'w1', faction_id: 'g:f2', faction_name: 'Mars Combine' }] });
    expect(r.tier).toBe('decision');
    expect(r.title).toBe('Mars Combine offers a ceasefire');
    expect(r.focus).toEqual({ kind: 'panel', panel: 'standing' });
  });

  it('an open bill is a decision, and a NOW as it closes', () => {
    expect(rows({ openVotes: [{ id: 'p1', title: 'More Metal', vote_closes_at_tick: 13 }] })[0].tier).toBe('decision');
    expect(rows({ openVotes: [{ id: 'p1', title: 'More Metal', vote_closes_at_tick: 4 }] })[0].tier).toBe('now');
  });
});

describe('situationFeed', () => {
  afterEach(() => clearSituation());
  it('merges each poll\'s part and announces the whole', () => {
    const seen: SituationMpData[] = [];
    const off = onSituation(d => seen.push(d));
    publishSituation({ openVotes: [{ id: 'p1', title: 'More Metal', vote_closes_at_tick: 13 }] });
    publishSituation({ incomingTrades: [] });
    off();
    expect(seen[1].openVotes?.length).toBe(1);
    expect(currentSituation().incomingTrades).toEqual([]);
  });
  it('clears when the game is left', () => {
    publishSituation({ ceasefireOffers: [{ war_id: 'w', faction_id: 'f' }] });
    clearSituation();
    expect(currentSituation()).toEqual({});
  });
});
