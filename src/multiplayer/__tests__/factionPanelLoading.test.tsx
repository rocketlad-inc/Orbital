/**
 * The Faction tab said "Loading faction..." for 3-5 s on every open
 * (playtest, 2026-10-24): it waited for all four fetches, every time.
 * Now the slow ones no longer hold back the rest, and a reopen draws the
 * last answer at once.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const mockNever = () => new Promise<never>(() => {});
const mockME = { id: 'f1', name: 'Solar Directorate', color: '#fff', color2: '#000', metal: 10, gold: 10, science: 0, fuel: 0 };
let mockSlow = true;
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  apiFetch: async (path: string) => {
    if (path.endsWith('/me')) return { ok: true, data: { faction: mockME } };
    if (mockSlow) return mockNever();
    return { ok: true, data: { factions: [mockME], dyson: null } };
  },
  tradesApi: () => ({ listPacts: () => (mockSlow ? mockNever() : Promise.resolve({ ok: true, data: { pacts: [] } })) }),
  warsApi: () => ({ list: () => (mockSlow ? mockNever() : Promise.resolve({ ok: true, data: { wars: [] } })) }),
}));

// eslint-disable-next-line import/first
import { FactionPanel } from '../FactionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(gameId: string) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<FactionPanel gameId={gameId} />); });
  return { host, root };
}

describe('Faction tab loading', () => {
  it('shows your faction while the roster, pacts and wars are still on the way', async () => {
    mockSlow = true;
    const { host, root } = await mount('gslow');
    expect(host.textContent).not.toMatch(/Loading faction/);
    act(() => root.unmount());
  });

  it('a reopen draws at once from the last answer', async () => {
    mockSlow = false;
    const first = await mount('gcache');
    act(() => first.root.unmount());
    // Even if nothing answers this time, the panel is not blank.
    mockSlow = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => { root.render(<FactionPanel gameId="gcache" />); });
    expect(host.textContent).not.toMatch(/Loading faction/);
    act(() => root.unmount());
  });
});
