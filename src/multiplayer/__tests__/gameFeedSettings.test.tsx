// ============================================================
// The game-feed control (lobby + in-game Notifications window).
//
// Lorne, 2026-10-01: each game's Discord feed lives in its own forum
// post, and the HOST turns it on. The server half is sim/gameFeed.mjs;
// this pins what each player sees.
// ============================================================

import React, { act } from 'react';
import fs from 'fs';
import path from 'path';
import { createRoot } from 'react-dom/client';
import { GameFeedSettings, FeedView } from '../GameFeedSettings';
import { apiFetch } from '../api';

jest.mock('../api', () => ({ apiFetch: jest.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mockFetch = apiFetch as unknown as jest.Mock;

const view = (v: Partial<FeedView>): FeedView => ({
  level: 'off', thread_url: null, following: false, discord_linked: true,
  forum_configured: true, is_host: false, ...v,
});

async function render(v: FeedView) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, data: v });
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<GameFeedSettings gameId="G1abcdef" />); });
  await act(async () => { await Promise.resolve(); });
  return { host, root };
}

describe('the game-feed control', () => {
  it('the host gets the Off / Headlines / Everything picker', async () => {
    const { host, root } = await render(view({ is_host: true }));
    const sel = host.querySelector('[data-testid="game-feed-level"]') as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect([...sel.options].map(o => o.text)).toEqual(['Off', 'Headlines', 'Everything']);
    act(() => root.unmount());
  });

  it('a player sees the level but cannot change it', async () => {
    const { host, root } = await render(view({ level: 'headlines' }));
    expect(host.querySelector('[data-testid="game-feed-level"]')).toBeNull();
    expect(host.textContent).toMatch(/Headlines/);
    act(() => root.unmount());
  });

  it('off: no follow control, and it says only the host can turn it on', async () => {
    const { host, root } = await render(view({ is_host: true }));
    expect(host.querySelector('[data-testid="game-feed-follow"]')).toBeNull();
    expect(host.textContent).toMatch(/Only the host can turn it on/);
    act(() => root.unmount());
  });

  it('on, linked: follow, plus a link to the game\'s post', async () => {
    const { host, root } = await render(view({ level: 'all', thread_url: 'https://discord.com/channels/g/t' }));
    expect(host.querySelector('[data-testid="game-feed-follow"]')).not.toBeNull();
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://discord.com/channels/g/t');
    act(() => root.unmount());
  });

  it('on, not linked: says to link Discord instead of a dead toggle', async () => {
    const { host, root } = await render(view({ level: 'all', discord_linked: false }));
    expect(host.querySelector('[data-testid="game-feed-follow"]')).toBeNull();
    expect(host.textContent).toMatch(/Link your Discord account/);
    act(() => root.unmount());
  });

  it('on with no forum set up: warns that nothing will post yet', async () => {
    const { host, root } = await render(view({ level: 'all', forum_configured: false }));
    expect(host.textContent).toMatch(/not set up on the Discord server yet/);
    act(() => root.unmount());
  });

  it('invites a player who is not on the Orbital Discord yet', async () => {
    const { host, root } = await render(view({ level: 'all', discord_invite: 'https://discord.gg/abc' }));
    const a = host.querySelector('[data-testid="game-feed-invite"]');
    expect(a?.getAttribute('href')).toBe('https://discord.gg/abc');
    expect(host.textContent).toMatch(/Join the server to see this game's feed/);
    act(() => root.unmount());
  });

  it('the host changing the level PUTs it', async () => {
    const { host, root } = await render(view({ is_host: true }));
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, data: view({ is_host: true, level: 'headlines' }) });
    const sel = host.querySelector('[data-testid="game-feed-level"]') as HTMLSelectElement;
    await act(async () => {
      sel.value = 'headlines';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const put = mockFetch.mock.calls.find(c => c[1]?.method === 'PUT');
    expect(put?.[0]).toBe('/api/games/G1abcdef/feed');
    expect(JSON.parse(put?.[1].body)).toEqual({ level: 'headlines' });
    act(() => root.unmount());
  });
});

describe('where it lives', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
  it('in the lobby, before the game starts', () => {
    expect(read('../LobbyView.tsx')).toMatch(/!started && \(\s*<div style=\{\{ marginTop: 12 \}\}>\s*<GameFeedSettings gameId=\{roomId\} \/>/);
  });
  it('in the in-game Notifications window', () => {
    expect(read('../NotificationSettings.tsx')).toMatch(/<GameFeedSettings gameId=\{mpActions\.gameId\}/);
  });
});
