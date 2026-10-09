// The Event Log shows the headline in the player's language
// (combatLogDisplay[i]) while classifying it from the English text
// (combatLog[i]): the category kicker, icon and colour must not change when
// the language does, and faction names are still tinted.

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { GameContextProvider } from '../../state/gameContext';
import { EventLog } from '../EventLog';
import { setLang } from '../../i18n/core';
import type { GameState } from '../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EN = ['T+3  ⚠ Cerean Union diverts Rock 7 toward Venus — impact in T-9 ticks', 'T+4  Cerean Union founded city Alpha on Mars'];
const PT = ['T+3  ⚠ Cerean Union desvia Rock 7 rumo a Venus — impacto em 9 turnos', 'T+4  Cerean Union fundou Alpha (cidade) em Mars'];

function state(extra: Partial<GameState>): GameState {
  return {
    bodies: [], ships: [], fleets: [], settlements: [], orders: [], buildOrders: [],
    resources: {}, factionTech: {}, lastHarvestTick: 0, aiActivityLog: [], status: 'playing',
    currentTick: 5,
    factions: [{ id: 'f1', name: 'Cerean Union', color: '#ff0000' }],
    combatLog: EN,
    ...extra,
  } as unknown as GameState;
}

function mount(gs: GameState): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <GameContextProvider externalState={gs} externallyControlled>
        <EventLog />
      </GameContextProvider>,
    );
  });
  act(() => {
    window.dispatchEvent(new CustomEvent('dockrail:active', { detail: { active: 'eventlog' } }));
  });
  return host;
}

// GameContextProvider warns when no turn-based provider wraps it; irrelevant here.
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

afterEach(() => {
  act(() => setLang('en', false));
  document.body.innerHTML = '';
});

describe('EventLog display language', () => {
  it('shows the English headline when there is no display array (single-player)', () => {
    const host = mount(state({}));
    expect(host.textContent).toContain('diverts Rock 7');
  });

  it('shows the display headline and keeps the English classification', () => {
    const host = mount(state({ combatLogDisplay: PT }));
    expect(host.textContent).toContain('desvia Rock 7');
    expect(host.textContent).not.toContain('diverts Rock 7');
    // "founded" in the ENGLISH line is what makes this a Settlement row (the
    // Portuguese text says "fundou" and would classify as a generic Event).
    const kickers = Array.from(host.querySelectorAll('.event-log__row__kicker')).map(e => e.textContent);
    expect(kickers).toContain('Settlement');
    // faction names are tinted whatever the language
    const tinted = Array.from(host.querySelectorAll('.event-log__text span')).map(e => e.textContent);
    expect(tinted.some(x => x?.includes('Cerean Union'))).toBe(true);
  });
});
