/**
 * The website end of the app's "get it in your browser" (2026-10-08).
 * The app opens /?commission=buy&surface=<surface>[&gift=1] in the phone's
 * browser; there, the checkout starts by itself once signed in, once.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

let mockSellable = true;
jest.mock('../commission', () => ({
  ...jest.requireActual('../commission'),
  canBuyHere: () => mockSellable,
}));
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  startCommissionCheckout: jest.fn(async () => null),
}));

// eslint-disable-next-line import/first
import { readHandoff, useCommissionHandoff } from '../commissionHandoff';
// eslint-disable-next-line import/first
import { commissionHandoffUrl } from '../commission';
// eslint-disable-next-line import/first
import { startCommissionCheckout } from '../api';
// eslint-disable-next-line import/first
import { captureAttribution, TAG_PARAMS } from '../attribution';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type U = { is_premium?: boolean } | null;
function Probe({ user }: { user: U }) { useCommissionHandoff(user); return null; }
function mount(user: U) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<Probe user={user} />); });
  return (next: U) => act(() => { root.render(<Probe user={next} />); });
}
const landOn = (url: string) => {
  const u = new URL(url);
  window.history.replaceState({}, '', `${u.pathname}${u.search}`);
};

beforeEach(() => {
  mockSellable = true;
  // CRA resets mocks between tests: give it its answer again.
  (startCommissionCheckout as jest.Mock).mockReset().mockResolvedValue(null);
  window.history.replaceState({}, '', '/');
});

test('the URL the app sends round-trips: surface and gift', () => {
  const url = commissionHandoffUrl('designer', { gift: true });
  expect(url).toBe('https://orbital-empire.com/?commission=buy&surface=designer&gift=1');
  expect(readHandoff(new URL(url).search)).toEqual({ surface: 'designer', gift: true });
  expect(readHandoff('?commission=buy&surface=nonsense')).toEqual({ surface: 'profile', gift: false });
  expect(readHandoff('?room=abc')).toBeNull();
});

test('signed in: the checkout starts once, and the parameter is gone', () => {
  landOn(commissionHandoffUrl('lobby-flag'));
  const rerender = mount({ is_premium: false });
  expect(startCommissionCheckout).toHaveBeenCalledTimes(1);
  expect(startCommissionCheckout).toHaveBeenCalledWith('lobby-flag', { gift: false });
  expect(window.location.search).toBe('');
  rerender({ is_premium: false });
  expect(startCommissionCheckout).toHaveBeenCalledTimes(1);
});

test('the surface survives the page load (attribution strips its own tags first)', () => {
  // Found on the dev server: the handoff once used ?from=, which signup
  // attribution owns and strips at startup, so every link-out sale was
  // labelled 'profile'.
  landOn(commissionHandoffUrl('skins'));
  captureAttribution();
  const q = new URL(commissionHandoffUrl('skins')).searchParams;
  expect(TAG_PARAMS.filter(k => q.has(k))).toEqual([]);
  mount({ is_premium: false });
  expect(startCommissionCheckout).toHaveBeenCalledWith('skins', { gift: false });
});

test('signed out: it waits for sign-in', () => {
  landOn(commissionHandoffUrl('profile', { gift: true }));
  const rerender = mount(null);
  expect(startCommissionCheckout).not.toHaveBeenCalled();
  expect(window.location.search).toContain('commission=buy');
  rerender({ is_premium: true });
  // Already a holder, but a gift is still a gift.
  expect(startCommissionCheckout).toHaveBeenCalledWith('profile', { gift: true });
});

test('a holder is not sent to buy it again', () => {
  landOn(commissionHandoffUrl('designer'));
  mount({ is_premium: true });
  expect(startCommissionCheckout).not.toHaveBeenCalled();
  expect(window.location.search).toBe('');
});

test('never from inside the app, whatever the URL says', () => {
  mockSellable = false;
  landOn(commissionHandoffUrl('designer'));
  mount({ is_premium: false });
  expect(startCommissionCheckout).not.toHaveBeenCalled();
});
