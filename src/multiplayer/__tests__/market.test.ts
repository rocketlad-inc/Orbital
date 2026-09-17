import fs from 'fs';
import path from 'path';
import { marketRate, bundleWords, nonZeroKeys } from '../marketMath';

const b = (metal = 0, gold = 0, science = 0) => ({ metal, gold, science });

describe('market board — price and wording', () => {
  it('quotes a unit price only for a one-for-one swap', () => {
    expect(marketRate({ offer: b(500), request: b(0, 300) })).toBe('0.60 cr per metal');
    expect(marketRate({ offer: b(0, 100), request: b(250) })).toBe('2.5 metal per cr');
    expect(marketRate({ offer: b(0, 0, 10), request: b(0, 400) })).toBe('40 cr per sci');
  });

  it('gives no price to a bundle, a gift, or nonsense', () => {
    expect(marketRate({ offer: b(500, 0, 20), request: b(0, 300) })).toBeNull();
    expect(marketRate({ offer: b(500), request: b(0, 300, 5) })).toBeNull();
    expect(marketRate({ offer: b(500), request: b() })).toBeNull();
    expect(marketRate({ offer: b(), request: b(0, 300) })).toBeNull();
  });

  it('says credits, never gold', () => {
    expect(bundleWords(b(1500, 300))).toBe('1,500 metal + 300 credits');
    expect(bundleWords(b())).toBe('nothing');
    expect(nonZeroKeys(b(0, 1, 0))).toEqual(['gold']);
  });
});

// Source guards: the shape of the feature that a refactor must not lose.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('market — wiring', () => {
  const dock = read('multiplayer/TradeDock.tsx');
  const composer = read('multiplayer/TradeComposer.tsx');
  const panel = read('multiplayer/MarketPanel.tsx');
  const worker = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker', 'market.js'), 'utf8');

  it('MARKET is the first of three tabs and the default', () => {
    expect(dock).toMatch(/type TradeTab = 'market' \| 'private' \| 'routes';/);
    expect(dock).toMatch(/useState<TradeTab>\('market'\)/);
    const order = ['Market', 'Private', 'Routes'].map(l => dock.indexOf(`\n              ${l}`));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('a deep link is not overridden by the open-on-pending rule', () => {
    expect(dock).toMatch(/pendingRef\.current > 0 && !deepLinkRef\.current/);
  });

  it('the composer can address the open market, goods only', () => {
    expect(composer).toMatch(/<option value=\{MARKET\}>/);
    expect(composer).toMatch(/marketApi\(gameId\)\.post\(/);
    // No treaty riders and no hull/world sale on a market post.
    expect(composer).toMatch(/showPacts=\{!recurring && !isMarket\}/);
    expect(composer).toMatch(/disabled=\{isCounter \|\| isMarket \|\| !!prefill\}/);
    // A listing has a price: both sides.
    expect(composer).toMatch(/isMarket \? \(offerTotal > 0 && requestTotal > 0\)/);
  });

  it('a counter to a post is a private offer carrying the post id', () => {
    expect(panel).toMatch(/marketPostId: composer\.post\.id/);
    expect(composer).toMatch(/market_post_id: prefill\?\.marketPostId/);
  });

  it('NO WAR GATING (parked by Lorne): the market worker reads no pacts, treaties or embargoes', () => {
    const code = worker.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/FROM treaties|JOIN treaties|treaty_signatories|trade_embargo|war_authorization|getSliderResolver/);
  });

  it('a take runs the ordinary accept path', () => {
    expect(worker).toMatch(/await handleAccept\(req, env, \{\s*session, params: \{ gameId, tradeId \},\s*\}\)/);
  });
});
