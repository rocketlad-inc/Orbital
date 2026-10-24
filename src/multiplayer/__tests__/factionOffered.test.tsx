// ============================================================
// B7 (playtest 2026-10-24): the trial's Ally, having just offered a pact,
// read "Ally · NEUTRAL" in the Faction panel with only DECLARE WAR to
// press. A pact on the table reads PACT OFFERED with a way to answer it;
// a pact signed reads as the pact, never NEUTRAL.
// ============================================================

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FactionPanel } from '../FactionPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'G:f0';
const ALLY = 'G:f1';
const fac = (id: string, name: string, extra = {}) => ({
  id, user_id: id, slot: 0, name, color: '#0f0', status: 'active', capital_body_id: null,
  senate_weight: 1, reputation: 0, bodies_owned: 1, ship_count: 2, ...extra,
});

function route(opts: { offer: boolean; pact: boolean }) {
  return async (url: string) => {
    const u = String(url);
    const body = u.endsWith('/me') ? { faction: { ...fac(ME, 'Me'), metal: 0, fuel: 0, gold: 0, science: 0 } }
      : u.endsWith('/factions') ? { factions: [fac(ME, 'Me'), fac(ALLY, 'Outer Alliance', { computer: 1, personality: 'ally' })] }
      : u.endsWith('/pacts') ? { caller_faction_id: ME, pacts: opts.pact
        ? [{ id: 'p1', kind: 'nap', status: 'active', signed_at_tick: 2, expires_at_tick: null, counterparty_faction_ids: [ALLY] }] : [] }
      : u.endsWith('/wars') ? { wars: [] }
      : u.includes('/trades') ? { caller_faction_id: ME, trades: opts.offer ? [{
        id: 't1', proposer_faction_id: ALLY, responder_faction_id: ME, status: 'open',
        offer: { metal: 0, fuel: 0, gold: 0, science: 0 }, request: { metal: 0, fuel: 0, gold: 0, science: 0 },
        offer_pacts: ['nap'], request_pacts: [],
      }] : [] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

async function render(opts: { offer: boolean; pact: boolean }) {
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(route(opts));
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<FactionPanel gameId="Gabcdef1" />); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  const row = [...host.querySelectorAll('.fp-row')].find(r => r.textContent?.includes('Outer Alliance'));
  return { host, root, state: row?.querySelector('.fp-state')?.textContent ?? '' };
}

describe('the Faction panel names the relation a pact makes', () => {
  it('a pact offered to you reads PACT OFFERED, not NEUTRAL', async () => {
    const { root, state } = await render({ offer: true, pact: false });
    expect(state).toBe('PACT OFFERED');
    act(() => root.unmount());
  });
  it('a signed pact reads as the pact', async () => {
    const { root, state } = await render({ offer: false, pact: true });
    expect(state).toBe('☮ PEACE');
    act(() => root.unmount());
  });
  it('nothing between you is NEUTRAL', async () => {
    const { root, state } = await render({ offer: false, pact: false });
    expect(state).toBe('NEUTRAL');
    act(() => root.unmount());
  });
});
