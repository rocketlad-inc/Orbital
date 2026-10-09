// ============================================================
// Situation Report rows speak the player's language.
//
// The rows are memoised, so a language switch has to be an input to the
// memo: same gameState, new language, new words. And the damaged-fleet
// fold used to read the HP figure back out of the English title with a
// regex; in Portuguese that must still name the weakest hull.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSituationItems, SituationItem } from '../useSituationItems';
import { setLang } from '../../i18n/core';
import type { GameState, Ship } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARS = 'mars';
const ship = (i: number): Ship => ({
  id: `s${i}`, name: `Havoc ${i}`, class: 'frigate', ownedBy: 'player',
  hp: i === 1 ? 200 : 400, hpMax: 1000, fleetId: 'f1',
  orbit: { parentBodyId: MARS, radius: 2, angle0: 0, epoch: 0, direction: 1 },
} as unknown as Ship);

const gs = {
  currentTick: 20,
  ships: [ship(0), ship(1), ship(2)],
  bodies: [{ id: MARS, name: 'Mars', type: 'terrestrial', radius: 1, mu: 1, orbitRadius: 30, orbitPeriod: 50, angle0: 0 }],
  settlements: [],
  fleets: [{ id: 'f1', name: 'Earth Group', shipIds: ['s0', 's1', 's2'], leadShipId: 's0', ownedBy: 'player' }],
  factions: [{ id: 'player', name: 'Me', color: '#fff' }],
  factionResources: {},
  factionTech: {},
  tradeRoutes: [],
  combatLog: [],
  capitalLoss: { eventId: 'c1', bodyId: 'earth', bodyName: 'Earth', tick: 19, killerName: 'Rivals' },
} as unknown as GameState;

describe('Situation Report — language', () => {
  afterEach(() => { act(() => setLang('en', false)); });

  it('recomputes the same state in the new language', () => {
    let out: SituationItem[] = [];
    const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
    const root = createRoot(document.createElement('div'));
    act(() => { root.render(<Probe />); });
    expect(out.find(i => i.category === 'capital_lost')!.title).toBe('Your capital on Earth has fallen');

    act(() => setLang('pt-BR', false));
    act(() => { root.render(<Probe />); });
    const row = out.find(i => i.category === 'capital_lost')!;
    expect(row.title).toBe('Sua capital em Earth caiu');
    expect(row.subtitle).toBe('Destruída por Rivals. Retome o mundo ou funde uma nova cidade.');
    act(() => root.unmount());
  });

  it('the damaged-fleet row still names the weakest hull in Portuguese', () => {
    act(() => setLang('pt-BR', false));
    let out: SituationItem[] = [];
    const Probe: React.FC = () => { out = useSituationItems(gs, 'player'); return null; };
    const root = createRoot(document.createElement('div'));
    act(() => { root.render(<Probe />); });
    const dmg = out.filter(i => i.category === 'damaged');
    expect(dmg).toHaveLength(1);
    expect(dmg[0].title).toBe('Earth Group: 3 cascos danificados, o mais fraco com 20% de HP');
    act(() => root.unmount());
  });
});
