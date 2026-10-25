/**
 * A solo game on a custom map (Lorne, 2026-10-25): the solo setup offers
 * the Solar System or a custom map, your own or one from the gallery; with
 * the Commission the gallery lists, a pick caps the rivals at its start
 * worlds less yours, and START sends the map. Without the Commission the
 * choice shows locked and nothing is sent.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { generateMap, normalizeMap, startWorlds } from '../../game/customMap';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockMap = normalizeMap(generateMap({ seed: 'solo-test-1', starts: 3 }));
let mockCanHost = true;
const mockPosts: { path: string; body: unknown }[] = [];
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      mockPosts.push({ path, body: JSON.parse(init.body ?? '{}') });
      return { ok: true, data: { ok: true, game_id: 'g1' } };
    }
    if (path === '/api/maps') return { ok: true, data: { maps: [], can_host: mockCanHost } };
    if (path.startsWith('/api/maps/gallery?')) {
      return { ok: true, data: { items: [{ id: 'map_g1', name: 'Pip System', author: 'Maker', starts: 3 }], next: null } };
    }
    if (path === '/api/maps/gallery/map_g1') return { ok: true, data: { map: mockMap } };
    return { ok: false, status: 404, error: { code: 'not_found', message: 'nope' } };
  },
}));
// eslint-disable-next-line import/first
import { SoloCard } from '../MultiplayerLobby';

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const button = (root: HTMLElement, re: RegExp) =>
  [...root.querySelectorAll('button')].find(b => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const started: string[] = [];
  await act(async () => { root.render(<SoloCard onStarted={(id) => started.push(id)} />); });
  await act(async () => { button(host, /play solo|set up|jogar solo/i)?.click(); });
  await flush();
  return { host, root, started };
}

beforeEach(() => { mockPosts.length = 0; mockCanHost = true; });

test('a gallery map caps the rivals and goes with the START', async () => {
  expect(startWorlds(mockMap).worlds.length).toBe(3);
  const { host, root, started } = await mount();
  await act(async () => { button(host, /custom|personalizado|your own|seus/i)?.click(); });
  await flush();
  const pick = button(host, /Pip System/);
  expect(pick).toBeTruthy();
  await act(async () => { pick!.click(); });
  await flush();
  // Three start worlds: you and two rivals, so 3, 4 and 5 are off.
  const rivals = [1, 2, 3, 4, 5].map(n => [...host.querySelectorAll('[role="radiogroup"] button')]
    .find(b => b.textContent === String(n)) as HTMLButtonElement);
  expect(rivals.map(b => b.disabled)).toEqual([false, false, true, true, true]);
  await act(async () => { button(host, /^start|começar/i)?.click(); });
  await flush();
  expect(mockPosts).toHaveLength(1);
  expect(mockPosts[0].path).toBe('/api/solo');
  expect(mockPosts[0].body).toMatchObject({ map_id: 'map_g1', rivals: 2 });
  expect(started).toEqual(['g1']);
  act(() => root.unmount());
});

test('without the Commission the custom map is locked and nothing is sent with it', async () => {
  mockCanHost = false;
  const { host, root } = await mount();
  await act(async () => { button(host, /custom|personalizado|your own|seus/i)?.click(); });
  await flush();
  expect(button(host, /Pip System/)).toBeFalsy();
  expect(host.textContent).toMatch(/Commission|Comiss/i);
  act(() => root.unmount());
});
