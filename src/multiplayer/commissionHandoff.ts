// ============================================================
// commissionHandoff — the other end of the app's buy button.
//
// In the Android app a Commission button opens the phone's browser on
// /?commission=buy&from=<surface>[&gift=1] (openCommissionInBrowser). Here,
// in that browser, the checkout starts by itself as soon as the player is
// signed in: the app's tap was the decision, and making them find the
// button a second time on a different screen is how a sale is lost.
//
// A TWA shares Chrome's cookies, so they are almost always signed in
// already; if not, the parameter waits in the URL through sign-in, as
// ?invite does. It is read once and stripped, so a reload or a back
// button never starts a second checkout.
// ============================================================

import { useEffect, useRef } from 'react';
import { startCommissionCheckout, CommissionSurface } from './api';
import { canBuyHere, sentToBrowser, COMMISSION_SURFACES } from './commission';
import { BROWSER_HANDOFF_PARAM } from '../platform/appShell';

export interface Handoff { surface: CommissionSurface; gift: boolean }

/** The handoff this URL asks for, or null. */
export function readHandoff(search: string): Handoff | null {
  const q = new URLSearchParams(search);
  if (q.get(BROWSER_HANDOFF_PARAM) !== 'buy') return null;
  const from = q.get('from') as CommissionSurface | null;
  return {
    surface: from && COMMISSION_SURFACES.includes(from) ? from : 'profile',
    gift: q.get('gift') === '1',
  };
}

function strip(): void {
  const url = new URL(window.location.href);
  for (const k of [BROWSER_HANDOFF_PARAM, 'from', 'gift']) url.searchParams.delete(k);
  window.history.replaceState({}, '', url.toString());
}

export function useCommissionHandoff(user: { is_premium?: boolean } | null): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !user) return;
    const h = readHandoff(window.location.search);
    if (!h) return;
    done.current = true;
    strip();
    // Never from inside the app, whatever the URL says.
    if (!canBuyHere()) return;
    // Already theirs: nothing to buy (a gift is still a gift).
    if (user.is_premium && !h.gift) return;
    void startCommissionCheckout(h.surface, { gift: h.gift }).then(url => {
      if (url) window.location.assign(url);
    });
  }, [user]);
}

/** Back in the app after the browser: read the account again, so a
 *  Commission bought there unlocks here at once (every return, since the
 *  player may come back before paying and again after). */
export function useRefreshOnReturn(refresh: () => Promise<void>): void {
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === 'visible' && sentToBrowser()) void refresh();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [refresh]);
}
