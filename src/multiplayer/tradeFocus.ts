// Cross-links inside the trade dock: a standing DEAL (under PRIVATE) and
// the LANE that flies it (under ROUTES) are the same arrangement seen
// from two tabs, and until now neither could point at the other.
//
// The tabs mount and unmount as you switch, and their data arrives
// asynchronously, so "scroll to that card" cannot be a plain event: the
// card does not exist yet when the link is clicked. The request is held
// here until the destination tab has rendered the card, then consumed.

import { useEffect } from 'react';

export type TradeFocusKind = 'agreement' | 'route';

let pending: { kind: TradeFocusKind; id: string } | null = null;

/** Jump to the deal (kind 'agreement', PRIVATE tab) or to the lane that
 *  flies it (kind 'route', ROUTES tab). `id` is the agreement id either
 *  way — a lane is found by the deal it serves. */
export function focusTradeCard(kind: TradeFocusKind, agreementId: string): void {
  pending = { kind, id: agreementId };
  try {
    window.dispatchEvent(new CustomEvent('tradedock:tab', {
      detail: { tab: kind === 'agreement' ? 'private' : 'routes' },
    }));
    window.dispatchEvent(new CustomEvent('tradedock:focus'));
  } catch { /* noop */ }
}

function tryFocus(kind: TradeFocusKind): boolean {
  if (!pending || pending.kind !== kind) return true; // nothing for us
  const attr = kind === 'agreement' ? 'data-focus-agreement' : 'data-focus-route';
  const el = document.querySelector(`[${attr}="${CSS.escape(pending.id)}"]`) as HTMLElement | null;
  if (!el) return false;
  pending = null;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('trade-focus-flash');
  window.setTimeout(() => el.classList.remove('trade-focus-flash'), 2200);
  return true;
}

/** Mounted by the tab that owns cards of `kind`. Retries briefly, since
 *  the card usually arrives with the tab's first fetch. `dep` should
 *  change when the tab's data does. */
export function useTradeFocus(kind: TradeFocusKind, dep: unknown): void {
  useEffect(() => {
    let tries = 0;
    let timer: number | undefined;
    const attempt = () => {
      if (tryFocus(kind) || ++tries > 12) return;
      timer = window.setTimeout(attempt, 250);
    };
    attempt();
    const onFocus = () => { tries = 0; attempt(); };
    window.addEventListener('tradedock:focus', onFocus);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('tradedock:focus', onFocus);
    };
  }, [kind, dep]);
}
