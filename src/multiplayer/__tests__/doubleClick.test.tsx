/**
 * A second click on the same thing while its request is still out gets
 * THAT request's answer, not a refusal from a duplicate request.
 *
 * Prod, five days to 2026-10-05: founding a station answers in ~1.7s
 * with no feedback on the button, players click again ~0.3s later, and
 * the duplicate came back "this body already has a station" although
 * the first click had worked (46 times, 10 players; the same shape for
 * building upgrades and cancelling builds).
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MultiplayerActionsProvider, useMultiplayerActions } from '../MultiplayerActionsContext';
import type { MultiplayerActions } from '../MultiplayerActionsContext';
import { apiFetch } from '../api';

jest.mock('../api', () => ({ apiFetch: jest.fn() }));
const mockFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

/** Each call parks until the test settles it, like a slow server. */
function slowServer() {
  const calls: Array<{ path: string; method: string; settle: (r: unknown) => void }> = [];
  mockFetch.mockImplementation((path: string, init?: RequestInit) => new Promise(resolve => {
    calls.push({ path, method: init?.method ?? 'GET', settle: resolve as (r: unknown) => void });
  }) as ReturnType<typeof apiFetch>);
  return calls;
}

function grab(): MultiplayerActions {
  let actions: MultiplayerActions | null = null;
  const Probe = () => { actions = useMultiplayerActions(); return null; };
  const host = document.createElement('div');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => { createRoot(host).render(<MultiplayerActionsProvider gameId="g1"><Probe /></MultiplayerActionsProvider>); });
  return actions!;
}

const OK = { ok: true, status: 201, data: {} };
const OCCUPIED = {
  ok: false, status: 409,
  error: { code: 'occupied', message: 'this body already has a station' },
};

beforeEach(() => mockFetch.mockReset());

test('a double click on BUILD STATION sends one request and both clicks hear it worked', async () => {
  const calls = slowServer();
  const a = grab();
  const first = a.deploySettlement({ bodyId: 'mars', type: 'station', name: 'Ares' });
  const second = a.deploySettlement({ bodyId: 'mars', type: 'station', name: 'Ares' });
  expect(calls).toHaveLength(1);
  // Were a second request sent, the server would refuse it as occupied.
  await act(async () => { calls[0].settle(OK); calls[1]?.settle(OCCUPIED); });
  await expect(first).resolves.toEqual({ ok: true });
  await expect(second).resolves.toEqual({ ok: true });
});

test('once the first answer is in, the next click is a new request', async () => {
  const calls = slowServer();
  const a = grab();
  const first = a.deploySettlement({ bodyId: 'mars', type: 'station' });
  await act(async () => { calls[0].settle(OK); });
  await first;
  const again = a.deploySettlement({ bodyId: 'mars', type: 'station' });
  expect(calls).toHaveLength(2);
  await act(async () => { calls[1].settle(OCCUPIED); });
  await expect(again).resolves.toMatchObject({ ok: false, code: 'occupied' });
});

test('different targets are never merged', async () => {
  const calls = slowServer();
  const a = grab();
  a.deploySettlement({ bodyId: 'mars', type: 'station' });
  a.deploySettlement({ bodyId: 'mars', type: 'city' });
  a.deploySettlement({ bodyId: 'luna', type: 'station' });
  a.queueBuilding('s1', 'lab');
  a.queueBuilding('s1', 'shipyard');
  a.cancelBuild('o1');
  a.cancelBuild('o2');
  expect(calls).toHaveLength(7);
});

test('a double click on a building upgrade or a cancel sends one request', () => {
  const calls = slowServer();
  const a = grab();
  a.queueBuilding('s1', 'lab'); a.queueBuilding('s1', 'lab');
  a.cancelBuilding('s1', 'q1'); a.cancelBuilding('s1', 'q1');
  a.cancelBuild('o1'); a.cancelBuild('o1');
  expect(calls.map(c => c.method)).toEqual(['POST', 'DELETE', 'DELETE']);
});
