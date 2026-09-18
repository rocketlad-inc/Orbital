import fs from 'fs';
import path from 'path';
import {
  marketRate, bundleWords, nonZeroKeys, pairPrice, compareToGoingRate, costForUnits,
  afterTariff, fmtTicksAsTime, unitCostForTaker, goingRateText,
} from '../marketMath';

const b = (metal = 0, gold = 0, science = 0) => ({ metal, gold, science });

describe('market board — price and wording', () => {
  it('quotes a unit price only for a one-for-one swap', () => {
    expect(marketRate({ offer: b(500), request: b(0, 300) })).toBe('0.60 cr per metal');
    // Quoted as the MARKET is quoted, whichever way the post faces:
    // 100 credits for 250 metal is metal at 0.40, not "2.5 metal per cr".
    expect(marketRate({ offer: b(0, 100), request: b(250) })).toBe('0.40 cr per metal');
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

describe('market board — one price per market', () => {
  it('prices both sides of a market the same way', () => {
    expect(pairPrice(b(500), b(0, 300))).toEqual({ base: 'metal', quote: 'gold', price: 0.6 });
    expect(pairPrice(b(0, 300), b(500))).toEqual({ base: 'metal', quote: 'gold', price: 0.6 });
    // No credits involved: metal is the quote.
    expect(pairPrice(b(0, 0, 10), b(400))).toEqual({ base: 'science', quote: 'metal', price: 40 });
    expect(pairPrice(b(500, 0, 1), b(0, 300))).toBeNull();
    expect(pairPrice(b(500), b(300))).toBeNull();
  });

  const rates = [{ base: 'metal' as const, quote: 'gold' as const, low: 0.5, high: 0.7, mid: 0.6, n: 5 }];

  it('judges a post from the taker\'s chair', () => {
    // Post SELLS metal at 0.45: you are buying, cheaper is better.
    expect(compareToGoingRate({ offer: b(1000), request: b(0, 450) }, rates)).toEqual({ pct: 25, better: true });
    expect(compareToGoingRate({ offer: b(1000), request: b(0, 900) }, rates)).toEqual({ pct: 50, better: false });
    // Post BUYS metal at 0.9 credits each: you are selling, dearer is better.
    expect(compareToGoingRate({ offer: b(0, 900), request: b(1000) }, rates)).toEqual({ pct: 50, better: true });
    // Inside 3% is "about the going rate" and gets no label.
    expect(compareToGoingRate({ offer: b(1000), request: b(0, 610) }, rates)).toBeNull();
    // One fill is an anecdote, not a rate.
    expect(compareToGoingRate({ offer: b(1000), request: b(0, 450) }, [{ ...rates[0], n: 1 }])).toBeNull();
  });

  it('prints a range, or one number when there is no spread', () => {
    expect(goingRateText(rates[0])).toBe('metal 0.50–0.70 cr');
    expect(goingRateText({ ...rates[0], low: 0.6, high: 0.6 })).toBe('metal 0.60 cr');
  });

  it('sorts "I need metal" by what a unit costs, bundles last', () => {
    expect(unitCostForTaker({ offer: b(500), request: b(0, 300) }, 'metal')).toBe(0.6);
    expect(unitCostForTaker({ offer: b(500, 0, 1), request: b(0, 300) }, 'metal')).toBe(Infinity);
    expect(unitCostForTaker({ offer: b(0, 300), request: b(500) }, 'metal')).toBe(Infinity);
  });
});

describe('market board — lots, tariff, clock', () => {
  it('charges pro rata, rounded up for the poster, never zero', () => {
    expect(costForUnits(1000, 601, 250)).toBe(151);   // 150.25
    expect(costForUnits(1000, 601, 1000)).toBe(601);
    expect(costForUnits(1000, 10, 1)).toBe(1);         // 0.01 -> 1
    // Splitting an order can never pay less than buying it whole.
    expect(costForUnits(1000, 601, 500) + costForUnits(1000, 601, 500)).toBeGreaterThanOrEqual(601);
  });

  it('MIRRORS the server: same rounding, same quote rule', () => {
    const worker = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker', 'market.js'), 'utf8');
    expect(worker).toMatch(/Math\.max\(1, Math\.ceil\(\(units \* r\[rK\]\) \/ o\[oK\]\)\)/);
    expect(worker).toMatch(/const quote = \(o\[0\] === 'gold' \|\| r\[0\] === 'gold'\) \? 'gold' : 'metal';/);
    const client = fs.readFileSync(path.join(__dirname, '..', 'marketMath.ts'), 'utf8');
    expect(client).toMatch(/Math\.max\(1, Math\.ceil\(\(units \* requestTotal\) \/ offerTotal\)\)/);
  });

  it('skims the tariff off what you receive, rounding down', () => {
    expect(afterTariff(500, 10)).toBe(450);
    expect(afterTariff(333, 10)).toBe(299);
    expect(afterTariff(500, 0)).toBe(500);
    expect(afterTariff(500, 250)).toBe(0);
  });

  it('shows ticks as wall-clock time at the game\'s own tick length', () => {
    expect(fmtTicksAsTime(71, 3600000)).toBe('2d 23h');
    expect(fmtTicksAsTime(72, 3600000)).toBe('3d');
    expect(fmtTicksAsTime(5, 3600000)).toBe('5h');
    expect(fmtTicksAsTime(72, 2000)).toBe('2m');
    expect(fmtTicksAsTime(3, 2000)).toBe('under a minute');
    expect(fmtTicksAsTime(90, 60000)).toBe('1h 30m');
  });
});

// Source guards: the shape of the feature that a refactor must not lose.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('market — wiring', () => {
  const dock = read('multiplayer/TradeDock.tsx');
  const composer = read('multiplayer/TradeComposer.tsx');
  const panel = read('multiplayer/MarketPanel.tsx');
  const worker = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker', 'market.js'), 'utf8');

  it('MARKET is the first of four tabs and the default', () => {
    expect(dock).toMatch(/type TradeTab = 'market' \| 'private' \| 'routes' \| 'treaties';/);
    expect(dock).toMatch(/useState<TradeTab>\('market'\)/);
    // The fourth tab is STANDING now, not Treaties: war became a thing
    // you declare, so the tab that used to list paperwork leads with who
    // you are at war with and the button that changes it.
    const order = ['Market', 'Private', 'Routes', 'Standing']
      .map(l => dock.replace(/\r/g, '').indexOf(`\n              ${l}`));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
  });

  it('a deep link is not overridden by the open-on-pending rule', () => {
    expect(dock).toMatch(/pendingRef\.current > 0 && !deepLinkRef\.current/);
  });

  it('the composer can address the open market, goods only', () => {
    expect(composer).toMatch(/<option value=\{MARKET\}>/);
    expect(composer).toMatch(/marketApi\(gameId\)\.post\(/);
    // No treaty riders on a market post: a treaty needs a named partner.
    expect(composer).toMatch(/showPacts=\{!recurring && !isMarket\}/);
    // A hull or world CAN be listed openly (0129); only a counter, which
    // answers a goods post, is held to goods.
    expect(composer).toMatch(/disabled=\{isCounter \|\| !!prefill\}/);
    // A listing has a price: both sides.
    expect(composer).toMatch(/isMarket \? \(offerTotal > 0 && requestTotal > 0\)/);
  });

  it('a counter to a post is a private offer carrying the post id', () => {
    expect(panel).toMatch(/marketPostId: composer\.post\.id/);
    expect(composer).toMatch(/market_post_id: prefill\?\.marketPostId/);
  });

  it('NO WAR GATING (parked by Lorne): the market worker reads no pacts, treaties or embargoes', () => {
    const code = worker.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // The tariff slider IS read — to tell a taker what will land — but
    // nothing about who is at war or under embargo may be.
    expect(code).not.toMatch(/FROM treaties|JOIN treaties|treaty_signatories|trade_embargo|war_authorization|getActiveSliders/);
  });

  it('both composers render at page level, above the dock', () => {
    const route = read('multiplayer/RouteComposer.tsx');
    expect(composer).toMatch(/return createPortal\(/);
    expect(composer).toMatch(/zIndex: 5000/);
    expect(route).toMatch(/return createPortal\(/);
    expect(read('multiplayer/RouteComposer.css')).toMatch(/z-index: 5000;/);
  });

  it('the take confirm offers a freighter, the amount box and the tariff', () => {
    expect(panel).toMatch(/\/free-freighters/);
    expect(panel).toMatch(/ship_id: !post\.recurring && shipId \? shipId : undefined/);
    expect(panel).toMatch(/units: post\.divisible \? q : undefined/);
    expect(panel).toMatch(/afterTariff\(get\.metal, tariffPct\)/);
  });

  it('new posts reach the rail badge and the Situation Report', () => {
    expect(dock).toMatch(/countUnseenPosts\(gameId, postsRef\.current\)/);
    expect(dock).toMatch(/new CustomEvent\('market:unseen'/);
    expect(read('components/SituationLog.tsx')).toMatch(/addEventListener\('market:unseen'/);
    expect(read('hooks/useSituationItems.ts')).toMatch(/category: 'market_new'/);
    expect(panel).toMatch(/markMarketSeen\(gameId, res\.data\.posts\)/);
  });

  it('PRIVATE asks once, refreshes on room events, and pacts have their own tab', () => {
    const priv = read('multiplayer/TradesPanel.tsx');
    expect(priv).toMatch(/await api\.summary\(\)/);
    expect(priv).toMatch(/kind === 'trade' \|\| kind === 'market'/);
    expect(priv).not.toMatch(/setInterval\(refresh, 5000\)/);
    expect(priv).toMatch(/if \(view === 'treaties'\)/);
    expect(priv).not.toMatch(/title="Standing pacts"/);
    expect(dock).toMatch(/<TradesPanel gameId=\{gameId\} view="treaties" \/>/);
    const summary = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker', 'tradeSummary.js'), 'utf8');
    // Composed from the real handlers, so no visibility rule is restated.
    expect(summary).toMatch(/r\.handle\(new Request\(url, \{ method: 'GET' \}\), env/);
  });

  it('a deal and its lane point at each other', () => {
    const priv = read('multiplayer/TradesPanel.tsx');
    const routesTab = read('multiplayer/SettlementTradeTab.tsx');
    expect(priv).toMatch(/focusTradeCard\('route', a\.id\)/);
    expect(priv).toMatch(/data-focus-agreement=\{a\.id\}/);
    expect(routesTab).toMatch(/focusTradeCard\('agreement', r\.agreementId!\)/);
    expect(routesTab).toMatch(/data-focus-route=\{r\.agreementId \?\? undefined\}/);
  });

  it('the dock always says whether a freighter is idle', () => {
    expect(dock).toMatch(/<FreighterStrip onPutToWork=/);
    const strip = read('multiplayer/FreighterStrip.tsx');
    // Same employment rule as ROUTES: routes AND one-off shipments.
    expect(strip).toMatch(/employedShipIds\(\s*gameState\.tradeRoutes \?\? \[\],\s*\(gameState\.tradeDeliveries/);
  });

  it('hulls and worlds can go on the open market', () => {
    const actions = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker', 'actions.js'), 'utf8');
    // No buyer named, first claim wins, and the guarded UPDATE is the race.
    expect(composer).toMatch(/\.\.\.\(isMarket \? \{ open: true \} : \{ buyer_faction_id: responderId \}\)/);
    expect(panel).toMatch(/api\.claimAsset\(l\.id\)/);
    expect(actions).toMatch(/WHERE id = \? AND status = 'offered' AND open_listing = 1/);
    // The seller stands in the buyer column until it is claimed, so they
    // must never be able to "accept" their own advert.
    expect(actions).toMatch(/if \(Number\(deal\.open_listing\) === 1\) \{\s*return err\(409, 'open_listing'/);
  });

  it('a sale is validated on its own fields, not the goods columns', () => {
    expect(composer).toMatch(/assetMode\s*\? \(assetRef !== '' && askTotal > 0\)/);
    expect(composer).toMatch(/display: assetMode \? 'none' : 'grid'/);
  });

  it('a take runs the ordinary accept path', () => {
    expect(worker).toMatch(/await handleAccept\(req, env, \{\s*session, params: \{ gameId, tradeId \},\s*\}\)/);
  });
});
