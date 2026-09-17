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

export function fmtPrice(p: number): string {
  return p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2);
}

/** Unit price, only when it means something: exactly one resource each
 *  way. "500 metal for 300 credits" is 0.60 cr per metal; a two-resource
 *  bundle has no single price and gets none. */
export function marketRate(post: { offer: MarketBundle; request: MarketBundle }): string | null {
  // Quoted the way the MARKET is quoted, not the way this post happens
  // to face: "90 credits for 120 metal" is metal at 0.75 cr, the same
  // number a metal-for-credits post would show. Seen on the live board
  // as "1.3 metal per cr" beside a "0.65 cr per metal" neighbour — two
  // prices for one market, not comparable at a glance.
  const p = pairPrice(post.offer, post.request);
  if (!p) return null;
  return `${fmtPrice(p.price)} ${SHORT[p.quote]} per ${SHORT[p.base]}`;
}

export function bundleWords(b: MarketBundle): string {
  const keys = nonZeroKeys(b);
  return keys.length
    ? keys.map(k => `${Math.round(b[k]).toLocaleString('en-US')} ${MARKET_LABEL[k]}`).join(' + ')
    : 'nothing';
}

// ---- one price per market --------------------------------------------
//
// MIRROR of pairPrice in worker/market.js. "500 metal for 300 credits"
// and "300 credits for 500 metal" are the SAME market seen from its two
// sides, so both price as 0.60 credits per metal. Credits are the quote
// when either side is credits; otherwise metal is.

export type PairPrice = { base: MarketKey; quote: MarketKey; price: number };

export function pairPrice(offer: MarketBundle, request: MarketBundle): PairPrice | null {
  const o = nonZeroKeys(offer);
  const r = nonZeroKeys(request);
  if (o.length !== 1 || r.length !== 1 || o[0] === r[0]) return null;
  const quote: MarketKey = (o[0] === 'gold' || r[0] === 'gold') ? 'gold' : 'metal';
  const base = o[0] === quote ? r[0] : o[0];
  const price = o[0] === quote ? offer[o[0]] / request[r[0]] : request[r[0]] / offer[o[0]];
  if (!Number.isFinite(price) || price <= 0) return null;
  return { base, quote, price };
}

export type GoingRate = { base: MarketKey; quote: MarketKey; low: number; high: number; mid: number; n: number };

export function goingRateText(r: GoingRate): string {
  const range = r.n > 1 && fmtPrice(r.low) !== fmtPrice(r.high)
    ? `${fmtPrice(r.low)}–${fmtPrice(r.high)}`
    : fmtPrice(r.mid);
  return `${MARKET_LABEL[r.base]} ${range} ${SHORT[r.quote]}`;
}

/** How a post compares with what that market has recently gone for —
 *  from the TAKER's chair. A post that GIVES the base resource is one you
 *  buy from, so cheaper is better; a post that gives the quote is one you
 *  sell to, so dearer is better. Null inside 3%: "about the going rate"
 *  is not worth a label. */
export function compareToGoingRate(
  post: { offer: MarketBundle; request: MarketBundle },
  rates: GoingRate[],
): { pct: number; better: boolean } | null {
  const p = pairPrice(post.offer, post.request);
  if (!p) return null;
  const r = rates.find(x => x.base === p.base && x.quote === p.quote);
  if (!r || r.n < 2 || r.mid <= 0) return null;
  const diff = (p.price - r.mid) / r.mid;
  if (Math.abs(diff) < 0.03) return null;
  const takerBuysBase = nonZeroKeys(post.offer)[0] === p.base;
  return { pct: Math.round(Math.abs(diff) * 100), better: takerBuysBase ? diff < 0 : diff > 0 };
}

/** MIRROR of priceForUnits in worker/market.js: pro rata, rounded UP in
 *  the poster's favour, never less than 1. */
export function costForUnits(offerTotal: number, requestTotal: number, units: number): number {
  if (offerTotal <= 0) return 0;
  return Math.max(1, Math.ceil((units * requestTotal) / offerTotal));
}

/** What lands after the Senate's receive-side tariff skim. */
export function afterTariff(amount: number, tariffPct: number): number {
  const t = Math.max(0, Math.min(100, tariffPct));
  return Math.floor(amount * (1 - t / 100));
}

/** Ticks as wall-clock time, at this game's tick length. "71t left" told
 *  nobody anything; "2d 23h" does. */
export function fmtTicksAsTime(ticks: number, tickIntervalMs: number): string {
  const ms = Math.max(0, ticks) * Math.max(1, tickIntervalMs);
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 && hours < 6 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function ttlLabel(hours: number): string {
  return hours < 24 ? `${hours} hours` : hours === 24 ? '1 day' : `${hours / 24} days`;
}

/** Sort key for "I need X": what one unit of X costs the taker, in
 *  whatever the post wants. Bundles sort last. */
export function unitCostForTaker(post: { offer: MarketBundle; request: MarketBundle }, need: MarketKey): number {
  const o = nonZeroKeys(post.offer);
  const r = nonZeroKeys(post.request);
  if (o.length !== 1 || r.length !== 1 || o[0] !== need) return Number.POSITIVE_INFINITY;
  return post.request[r[0]] / post.offer[o[0]];
}
