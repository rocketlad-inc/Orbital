// Pure helpers for the market board — kept apart from MarketPanel so
// they can be tested without mounting a panel that fetches.

export type MarketBundle = { metal: number; gold: number; science: number };
export type MarketKey = keyof MarketBundle;

export const MARKET_KEYS: MarketKey[] = ['metal', 'gold', 'science'];
/** Player-facing names. The server's 'gold' is the player's 'credits'. */
export const MARKET_LABEL: Record<MarketKey, string> = { metal: 'metal', gold: 'credits', science: 'science' };
const SHORT: Record<MarketKey, string> = { metal: 'metal', gold: 'cr', science: 'sci' };

export function nonZeroKeys(b: MarketBundle): MarketKey[] {
  return MARKET_KEYS.filter(k => (b[k] ?? 0) > 0);
}

/** Unit price, only when it means something: exactly one resource each
 *  way. "500 metal for 300 credits" is 0.60 cr per metal; a two-resource
 *  bundle has no single price and gets none. */
export function marketRate(post: { offer: MarketBundle; request: MarketBundle }): string | null {
  const o = nonZeroKeys(post.offer);
  const r = nonZeroKeys(post.request);
  if (o.length !== 1 || r.length !== 1) return null;
  const rate = post.request[r[0]] / post.offer[o[0]];
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const shown = rate >= 10 ? rate.toFixed(0) : rate >= 1 ? rate.toFixed(1) : rate.toFixed(2);
  return `${shown} ${SHORT[r[0]]} per ${SHORT[o[0]]}`;
}

export function bundleWords(b: MarketBundle): string {
  const keys = nonZeroKeys(b);
  return keys.length
    ? keys.map(k => `${Math.round(b[k]).toLocaleString('en-US')} ${MARKET_LABEL[k]}`).join(' + ')
    : 'nothing';
}
