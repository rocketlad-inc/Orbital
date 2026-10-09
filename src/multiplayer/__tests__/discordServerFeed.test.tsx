/**
 * "Post this game in your own Discord server" -- what each player sees.
 *
 * A Commission feature (2026-10-06). The card speaks to every player in
 * their own moment: the host connects (or is shown what the Commission
 * brings), another player can gift it to the host, and once connected
 * everyone sees where the feed goes. No buy button where nothing can be
 * sold (the Android app).
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { FeedView } from '../GameFeedSettings';

let mockSellable = true;
jest.mock('../commission', () => ({
  ...jest.requireActual('../commission'),
  canBuyHere: () => mockSellable,
  logCommission: jest.fn(),
  openCommissionInBrowser: jest.fn(),
}));
jest.mock('../api', () => ({
  apiFetch: jest.fn(async () => ({ ok: false })),
  startCommissionCheckout: jest.fn(async () => null),
}));

// eslint-disable-next-line import/first
import { DiscordServerFeed, SERVER_FEED_STEPS } from '../DiscordServerFeed';
// eslint-disable-next-line import/first
import { startCommissionCheckout } from '../api';
// eslint-disable-next-line import/first
import { openCommissionInBrowser } from '../commission';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (over: Partial<FeedView> = {}): FeedView => ({
  level: 'all', thread_url: null, following: false, discord_linked: false,
  forum_configured: true, is_host: true, discord_invite: null,
  server: null, host_name: 'Crimson', i_hold_commission: false, host_holds_commission: false,
  server_connect_ready: true,
  ...over,
});

function mount(v: FeedView) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => { createRoot(host).render(<DiscordServerFeed gameId="g1" view={v} onChange={() => {}} />); });
  return host;
}
const q = (h: HTMLElement, id: string) => h.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  mockSellable = true;
  try { localStorage.clear(); } catch { /* */ }
  (startCommissionCheckout as jest.Mock).mockClear();
});

test('a host without the Commission is shown what it brings, and can buy it', () => {
  const h = mount(view());
  expect(q(h, 'server-feed-pitch')).not.toBeNull();
  expect(q(h, 'server-feed-buy')?.textContent).toMatch(/Get the Commission/);
  act(() => { (q(h, 'server-feed-buy') as HTMLButtonElement).click(); });
  expect(startCommissionCheckout).toHaveBeenCalledWith('discord-feed', { gift: false });
});

test('another player can gift it to the host', () => {
  const h = mount(view({ is_host: false }));
  expect(q(h, 'server-feed-gift')).not.toBeNull();
  expect(q(h, 'server-feed-buy')?.textContent).toMatch(/Gift it to Crimson/);
  act(() => { (q(h, 'server-feed-buy') as HTMLButtonElement).click(); });
  expect(startCommissionCheckout).toHaveBeenCalledWith('discord-feed', { gift: true });
});

test('the pitch dismisses for good', () => {
  const h = mount(view());
  const notNow = Array.from(h.querySelectorAll('button')).find(b => b.textContent === 'Not now')!;
  act(() => { notNow.click(); });
  expect(q(h, 'server-feed-pitch')).toBeNull();
  expect(q(mount(view()), 'server-feed-pitch')).toBeNull();
});

test('the Android app sends the buyer to the browser, never to checkout', () => {
  mockSellable = false;
  const h = mount(view());
  expect(q(h, 'server-feed-pitch')).not.toBeNull();
  expect(q(h, 'server-feed-buy')).toBeNull();
  const out = q(h, 'server-feed-browser') as HTMLButtonElement;
  expect(out.textContent).toMatch(/in your browser/);
  act(() => { out.click(); });
  expect(openCommissionInBrowser).toHaveBeenCalledWith('discord-feed', { gift: false });
  expect(startCommissionCheckout).not.toHaveBeenCalled();
});

test('in the app, another player gifts it to the host from the browser too', () => {
  mockSellable = false;
  (openCommissionInBrowser as jest.Mock).mockClear();
  const h = mount(view({ is_host: false }));
  act(() => { (q(h, 'server-feed-browser') as HTMLButtonElement).click(); });
  expect(openCommissionInBrowser).toHaveBeenCalledWith('discord-feed', { gift: true });
});

test('a host holding the Commission gets the Connect button and the steps', () => {
  const h = mount(view({ host_holds_commission: true, i_hold_commission: true }));
  expect(q(h, 'server-feed-connect')?.textContent).toBe('Connect your server');
  const steps = Array.from(q(h, 'server-feed-howto')!.querySelectorAll('ol li')).map(li => li.textContent);
  expect(steps).toEqual(SERVER_FEED_STEPS);
  expect(q(h, 'server-feed-pitch')).toBeNull();
});

test('once connected, everyone sees where it posts; only the host can change it', () => {
  const server = { guild_name: 'Crimson Club', channel_name: 'orbital-news', kind: 'text' as const, url: 'https://discord.com/channels/g9/777', active: true };
  const asHost = mount(view({ server, host_holds_commission: true }));
  expect(q(asHost, 'server-feed')?.textContent).toMatch(/Posting to #orbital-news in Crimson Club/);
  expect(q(asHost, 'server-feed-disconnect')).not.toBeNull();
  const asPlayer = mount(view({ server, is_host: false, host_holds_commission: true }));
  expect(q(asPlayer, 'server-feed')?.textContent).toMatch(/Posting to #orbital-news/);
  expect(q(asPlayer, 'server-feed-disconnect')).toBeNull();
});

test('a lapsed Commission says the feed is paused and where it goes meanwhile', () => {
  const server = { guild_name: 'Crimson Club', channel_name: 'orbital-news', kind: 'forum' as const, url: null, active: false };
  const h = mount(view({ server }));
  expect(q(h, 'server-feed-paused')?.textContent).toMatch(/Orbital forum/);
});
