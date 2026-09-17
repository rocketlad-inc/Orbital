// ============================================================
// THE OPEN MARKET — offers with no named responder (migration 0127).
//
// Drives the REAL routes in worker/market.js and worker/trades.js:
// post, list, take, withdraw, the private counter link. The claim that
// matters most is that a take is nothing new — it lands as an ordinary
// accepted trade_offers row with its deliveries (or its standing
// agreement), so everything downstream is the private-deal machinery.
//
// Run: node sim/market.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

async function callRoute(env, routes, method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const req = { json: async () => body, headers: new Map() };
    const res = await r.handle(req, env, {
      url: new URL(`https://x${path}`),
      params: m.groups ?? {},
      session: { user_id: userId },
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  throw new Error(`no route matched ${method} ${path}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gmarket1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0), ('uC','c@t','C','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Market Test','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','market-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'venus'), (?,?,2,'mars')`).bind(G, 'uA', G, 'uB', G, 'uC').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active', current_tick = 10 WHERE id = ?").bind(G).run();
const [A, B, C] = (await DB.prepare(
  `SELECT id, user_id, name FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
await DB.prepare('UPDATE game_factions SET metal = 5000, gold = 5000, science = 5000 WHERE game_id = ?').bind(G).run();

const market = (await import('../worker/market.js'));
const trades = (await import('../worker/trades.js'));
const R = [...market.routes, ...trades.routes];
const base = `/api/games/${G}`;
const post = (uid, body) => callRoute(env, R, 'POST', `${base}/market`, uid, body);
const list = (uid) => callRoute(env, R, 'GET', `${base}/market`, uid);
const take = (uid, id) => callRoute(env, R, 'POST', `${base}/market/${id}/take`, uid, {});
const withdraw = (uid, id) => callRoute(env, R, 'POST', `${base}/market/${id}/withdraw`, uid, {});

// ---- posting: what the board refuses ----
let r = await post('uA', { offer: { metal: 500 }, request: {} });
check('a one-sided post is refused — a listing has a price', r.status === 400, JSON.stringify(r.body));
r = await post('uA', { offer: { metal: 500 }, request: { gold: 300 }, offer_pacts: ['nap'] });
check('a post cannot carry a treaty', r.status === 400, JSON.stringify(r.body));
r = await post('uA', { offer: { metal: 999999 }, request: { gold: 300 } });
check('cannot advertise what you do not hold', r.status === 400 && r.body.error?.code === 'insufficient_resources', JSON.stringify(r.body));
r = await post('uA', { offer: { fuel: 5, metal: 1 }, request: { gold: 300 } });
check('fuel stays untradeable on the market too', r.status === 400, JSON.stringify(r.body));

// ---- post + visibility ----
r = await post('uA', { offer: { metal: 500 }, request: { gold: 300 }, note: '  bulk ore  ' });
check('a two-sided post lands', r.status === 201 && r.body.post?.status === 'open', JSON.stringify(r.body));
const P1 = r.body.post.id;
check('the note is trimmed', r.body.post.note === 'bulk ore', String(r.body.post.note));
check('it expires TTL ticks out', r.body.post.expires_at_tick === 10 + market.MARKET_POST_TTL_TICKS, String(r.body.post.expires_at_tick));

let lb = await list('uB');
const seenByB = lb.body.posts.find(p => p.id === P1);
check('every other faction sees it, poster named', !!seenByB && seenByB.mine === false && seenByB.poster_name === A.name, JSON.stringify(seenByB));
let lc = await list('uC');
check('a third faction sees it too — the board is public', lc.body.posts.some(p => p.id === P1));
let la = await list('uA');
check('the poster sees it flagged as theirs', la.body.posts.find(p => p.id === P1)?.mine === true);

// ---- taking ----
r = await take('uA', P1);
check('you cannot take your own post', r.status === 400 && r.body.error?.code === 'own_post', JSON.stringify(r.body));

r = await take('uB', P1);
check('B takes it: the deal strikes', r.status === 200 && r.body.post?.status === 'filled' && r.body.trade?.status === 'accepted', JSON.stringify(r.body));
const T1 = r.body.trade?.id;
const offerRow = await DB.prepare('SELECT * FROM trade_offers WHERE id = ?').bind(T1).first();
check('it landed as an ordinary accepted private offer: poster proposes, taker responds',
  offerRow?.status === 'accepted' && offerRow.proposer_faction_id === A.id && offerRow.responder_faction_id === B.id
  && offerRow.market_post_id === P1, JSON.stringify(offerRow));
const legs = (await DB.prepare('SELECT sender_faction_id, recipient_faction_id, metal, gold FROM trade_deliveries WHERE trade_id = ?').bind(T1).all()).results ?? [];
check('with its two freight legs — goods still ride freighters', legs.length === 2
  && legs.some(l => l.sender_faction_id === A.id && l.metal === 500)
  && legs.some(l => l.sender_faction_id === B.id && l.gold === 300), JSON.stringify(legs));
const treasuries = (await DB.prepare('SELECT metal, gold FROM game_factions WHERE id IN (?, ?)').bind(A.id, B.id).all()).results;
check('nothing teleported: treasuries untouched at the handshake', treasuries.every(t => t.metal === 5000 && t.gold === 5000), JSON.stringify(treasuries));

r = await take('uC', P1);
check('a second taker is too late', r.status === 409 && r.body.error?.code === 'not_open', JSON.stringify(r.body));
lc = await list('uC');
check('a filled post leaves the board', !lc.body.posts.some(p => p.id === P1));
const tape = lc.body.recent.find(p => p.post_id === P1);
check('and shows on the public tape with both names', tape?.taker_name === B.name && tape?.poster_name === A.name, JSON.stringify(tape));

// ---- the race ----
r = await post('uA', { offer: { metal: 100 }, request: { gold: 50 } });
const P2 = r.body.post.id;
const [rb, rc] = await Promise.all([take('uB', P2), take('uC', P2)]);
const wins = [rb, rc].filter(x => x.status === 200).length;
check('two simultaneous takers: exactly one wins', wins === 1, `${rb.status} / ${rc.status}`);
const dealsFromP2 = (await DB.prepare(`SELECT COUNT(*) AS n FROM trade_offers WHERE market_post_id = ? AND status = 'accepted'`).bind(P2).first()).n;
check('and exactly one deal exists', dealsFromP2 === 1, String(dealsFromP2));

// ---- withdraw ----
r = await post('uA', { offer: { science: 40 }, request: { metal: 80 } });
const P3 = r.body.post.id;
r = await withdraw('uB', P3);
check('only the poster can withdraw', r.status === 403, JSON.stringify(r.body));
r = await withdraw('uA', P3);
check('the poster withdraws', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
r = await take('uB', P3);
check('a withdrawn post cannot be taken', r.status === 409, JSON.stringify(r.body));
r = await withdraw('uA', P3);
check('withdrawing twice is a clean 409', r.status === 409, JSON.stringify(r.body));

// ---- the cap ----
const capIds = [];
for (let i = 0; i < market.MARKET_MAX_OPEN_POSTS; i++) {
  const x = await post('uC', { offer: { metal: 10 + i }, request: { gold: 5 } });
  if (x.status === 201) capIds.push(x.body.post.id);
}
check(`a faction may hold ${market.MARKET_MAX_OPEN_POSTS} open posts`, capIds.length === market.MARKET_MAX_OPEN_POSTS, String(capIds.length));
r = await post('uC', { offer: { metal: 99 }, request: { gold: 5 } });
check('one more is refused', r.status === 409 && r.body.error?.code === 'too_many_posts', JSON.stringify(r.body));
await withdraw('uC', capIds[0]);
r = await post('uC', { offer: { metal: 99 }, request: { gold: 5 } });
check('withdrawing one frees a slot', r.status === 201, JSON.stringify(r.body));

// ---- expiry (lazy) ----
await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(10 + market.MARKET_POST_TTL_TICKS, G).run();
lb = await list('uB');
check('expired posts drop off the board', !lb.body.posts.some(p => capIds.includes(p.id)), JSON.stringify(lb.body.posts.map(p => p.id)));
r = await take('uB', capIds[1]);
check('and cannot be taken', r.status === 409 && r.body.error?.code === 'expired', JSON.stringify(r.body));
r = await post('uC', { offer: { metal: 7 }, request: { gold: 5 } });
check('nor do they count against the cap', r.status === 201, JSON.stringify(r.body));

// ---- standing post ----
r = await post('uB', { offer: { gold: 60 }, request: { metal: 120 }, recurring: true });
check('a standing post lands, flagged per-run, no hull pinned', r.status === 201 && r.body.post.recurring === true && r.body.post.has_ship === false, JSON.stringify(r.body));
const P4 = r.body.post.id;
r = await take('uA', P4);
check('taking it strikes', r.status === 200, JSON.stringify(r.body));
const ag = await DB.prepare('SELECT * FROM trade_agreements WHERE source_offer_id = ?').bind(r.body.trade?.id ?? '').first();
check('as a standing agreement at the posted rates', ag?.status === 'active' && ag.faction_a_id === B.id && ag.faction_b_id === A.id
  && ag.a_gold === 60 && ag.b_metal === 120, JSON.stringify(ag));

// ---- the private counter ----
r = await post('uA', { offer: { metal: 400 }, request: { gold: 400 } });
const P5 = r.body.post.id;
r = await callRoute(env, R, 'POST', `${base}/trades`, 'uB', {
  responder_faction_id: A.id, offer: { gold: 250 }, request: { metal: 400 }, market_post_id: P5,
});
check('a counter is a private offer to the poster, labelled with the post', r.status === 201 && r.body.trade?.market_post_id === P5
  && r.body.trade.responder_faction_id === A.id, JSON.stringify(r.body));
r = await callRoute(env, R, 'POST', `${base}/trades`, 'uB', {
  responder_faction_id: C.id, offer: { gold: 250 }, request: { metal: 400 }, market_post_id: P5,
});
check('the label cannot be hung on an offer to someone else', r.status === 400, JSON.stringify(r.body));
lc = await list('uC');
check('the post stays on the board while they haggle', lc.body.posts.some(p => p.id === P5));

// ---- a dead claim heals ----
await DB.prepare(`UPDATE market_posts SET filled_units = 1, taking_at_ms = 1 WHERE id = ?`).bind(P5).run();
r = await take('uC', P5);
check('a reservation stranded mid-take blocks the lot at first', r.status === 409, JSON.stringify(r.body));
lc = await list('uC');
check('and the next list call puts it back on the board', lc.body.posts.some(p => p.id === P5 && p.units_left === 1));

// ======================= SECOND PASS (0128) =======================
await DB.prepare('UPDATE games SET current_tick = 500 WHERE id = ?').bind(G).run();
for (const id of (await list('uA')).body.posts.filter(p => p.mine).map(p => p.id)) await withdraw('uA', id);
for (const id of (await list('uB')).body.posts.filter(p => p.mine).map(p => p.id)) await withdraw('uB', id);
for (const id of (await list('uC')).body.posts.filter(p => p.mine).map(p => p.id)) await withdraw('uC', id);
const takeBody = (uid, id, body) => callRoute(env, R, 'POST', `${base}/market/${id}/take`, uid, body);

// ---- sold in parts ----
r = await post('uA', { offer: { metal: 100, science: 5 }, request: { gold: 60 }, divisible: true });
check('a bundle cannot be sold in parts — no single unit price', r.status === 400, JSON.stringify(r.body));
r = await post('uA', { offer: { metal: 100 }, request: { gold: 60 }, divisible: true, recurring: true });
check('nor can a standing route', r.status === 400, JSON.stringify(r.body));
r = await post('uA', { offer: { metal: 1000 }, request: { gold: 601 }, divisible: true, ttl_hours: 24 });
check('a one-for-one post can', r.status === 201 && r.body.post.divisible === true && r.body.post.units_left === 1000, JSON.stringify(r.body));
const L1 = r.body.post.id;
check('ttl_hours is converted at the game tick length (24h at 1h ticks = 24)', r.body.post.expires_at_tick === 524 && r.body.post.ttl_ticks === 24, JSON.stringify(r.body.post));
r = await post('uA', { offer: { metal: 10 }, request: { gold: 6 }, ttl_hours: 5 });
check('an off-menu lifetime is refused', r.status === 400, JSON.stringify(r.body));

r = await takeBody('uB', L1, { units: 250 });
check('B buys 250 of 1000', r.status === 200 && r.body.terms?.offer?.metal === 250, JSON.stringify(r.body).slice(0, 300));
check('and pays pro rata, rounded UP for the poster (250*601/1000 = 150.25 -> 151)', r.body.terms?.request?.gold === 151, JSON.stringify(r.body.terms));
check('the post stays open with the remainder', r.body.post.status === 'open' && r.body.post.units_left === 750, JSON.stringify(r.body.post));
lb = await list('uC');
const l1c = lb.body.posts.find(p => p.id === L1);
check('the board shows what is LEFT, priced pro rata', l1c?.offer.metal === 750 && l1c?.request.gold === 451 && l1c?.original_offer.metal === 1000, JSON.stringify(l1c));
r = await takeBody('uC', L1, { units: 751 });
check('cannot buy more than is left', r.status === 409 && r.body.error?.code === 'not_enough_left', JSON.stringify(r.body));
r = await takeBody('uC', L1, { units: 0 });
check('nor zero', r.status === 400, JSON.stringify(r.body));
const [p1, p2] = await Promise.all([takeBody('uB', L1, { units: 500 }), takeBody('uC', L1, { units: 500 })]);
check('two 500-unit buyers racing for 750: exactly one wins', [p1, p2].filter(x => x.status === 200).length === 1, `${p1.status}/${p2.status}`);
r = await takeBody('uC', L1, {});
check('no amount named = everything left (the Discord button path)', r.status === 200 && r.body.terms?.offer?.metal === 250 && r.body.post.status === 'filled', JSON.stringify(r.body).slice(0, 300));
const soldRows = (await DB.prepare('SELECT units FROM market_fills WHERE post_id = ?').bind(L1).all()).results;
check('the tape holds one row per deal and they sum to the lot', soldRows.length === 3 && soldRows.reduce((s, x) => s + x.units, 0) === 1000, JSON.stringify(soldRows));
const minted = (await DB.prepare(`SELECT SUM(offer_metal) AS m, SUM(request_gold) AS g FROM trade_offers WHERE market_post_id = ? AND status = 'accepted'`).bind(L1).first());
check('and the minted deals carry exactly the metal posted; splitting never undercuts the poster', minted.m === 1000 && minted.g >= 601, JSON.stringify(minted));

// ---- going rates: real deals, one price per market ----
lb = await list('uB');
const mr = lb.body.rates.find(x => x.base === 'metal' && x.quote === 'gold');
check('metal has a going rate in credits from the fills', !!mr && mr.n >= 4 && mr.low <= mr.mid && mr.mid <= mr.high, JSON.stringify(lb.body.rates));
check('a credits-for-metal deal prices the SAME market, not a second one',
  market.pairPrice({ metal: 0, gold: 300, science: 0 }, { metal: 500, gold: 0, science: 0 })?.price === 0.6
  && market.pairPrice({ metal: 500, gold: 0, science: 0 }, { metal: 0, gold: 300, science: 0 })?.price === 0.6);
check('a bundle has no price', market.pairPrice({ metal: 5, gold: 0, science: 1 }, { metal: 0, gold: 3, science: 0 }) === null);
check('the list carries the caller tariff and the tick length', lb.body.my_tariff_pct === 0 && lb.body.tick_interval_ms === 3600000, JSON.stringify({ t: lb.body.my_tariff_pct, i: lb.body.tick_interval_ms }));

// ---- freighters named at the handshake ----
const addFreighter = (id, f, bodyId) => DB.prepare(
  `INSERT INTO game_ships
    (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES (?, ?, ?, ?, 'freighter', ?, 2, 2, 0, 0, 0, 1, 999, 999, 'active', 0, 60, 60, 0)`,
).bind(id, G, f.id, `Hauler ${id}`, bodyId).run();
const caps = (await DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ?').bind(G).all()).results;
const capOf = (f) => caps.find(c => c.id === f.id).capital_body_id;
for (const c of caps) {
  await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = 0 WHERE id = ?').bind(c.capital_body_id).run();
}
await addFreighter('ship_mkt_a1', A, capOf(A));
await addFreighter('ship_mkt_b1', B, capOf(B));
r = await post('uA', { offer: { metal: 80 }, request: { gold: 40 }, ship_id: 'ship_mkt_b1' });
check('cannot pin someone else\'s freighter to a post', r.status === 403, JSON.stringify(r.body));
r = await post('uA', { offer: { metal: 80 }, request: { gold: 40 }, ship_id: 'ship_mkt_a1' });
check('a one-time post can pin the poster\'s freighter', r.status === 201 && r.body.post.has_ship === true, JSON.stringify(r.body));
const H1 = r.body.post.id;
r = await takeBody('uB', H1, { ship_id: 'ship_mkt_b1' });
check('B takes it naming a freighter', r.status === 200, JSON.stringify(r.body).slice(0, 300));
check('both legs are crewed at the handshake', r.body.assigned?.mine?.ok === true && r.body.assigned?.poster?.ok === true, JSON.stringify(r.body.assigned));
const hl = (await DB.prepare('SELECT sender_faction_id, ship_id, status, dest_body_id FROM trade_deliveries WHERE trade_id = ?').bind(r.body.trade.id).all()).results;
check('each on its own hull, bound for the other side\'s capital dock',
  hl.find(l => l.sender_faction_id === A.id)?.ship_id === 'ship_mkt_a1' && hl.find(l => l.sender_faction_id === A.id)?.dest_body_id === capOf(B)
  && hl.find(l => l.sender_faction_id === B.id)?.ship_id === 'ship_mkt_b1' && hl.find(l => l.sender_faction_id === B.id)?.dest_body_id === capOf(A),
  JSON.stringify(hl));
r = await post('uA', { offer: { metal: 30 }, request: { gold: 15 } });
const H2 = r.body.post.id;
r = await takeBody('uB', H2, { ship_id: 'ship_mkt_b1' });
check('a busy freighter does not sink the deal — it strikes, the leg waits', r.status === 200 && r.body.assigned?.mine?.ok === false && !!r.body.assigned.mine.message, JSON.stringify(r.body.assigned));

// ---- the delivery record ----
await DB.prepare(`UPDATE trade_deliveries SET status = 'delivered', resolved_at_tick = 500 WHERE sender_faction_id = ? AND trade_id IN (SELECT id FROM trade_offers WHERE market_post_id = ?)`).bind(A.id, H1).run();
await DB.prepare('UPDATE games SET current_tick = 560 WHERE id = ?').bind(G).run();
r = await post('uA', { offer: { metal: 20 }, request: { gold: 10 } });
lb = await list('uB');
const recA = lb.body.posts.find(p => p.poster_faction_id === A.id)?.poster_record;
check('a poster shows legs landed and legs left to rot', recA?.delivered === 1 && recA?.stalled >= 1, JSON.stringify(recA));

// ---- lapse, renew, clear ----
r = await post('uC', { offer: { science: 9 }, request: { gold: 90 }, ttl_hours: 12 });
const X1 = r.body.post.id;
await DB.prepare('UPDATE games SET current_tick = 600 WHERE id = ?').bind(G).run();
lc = await list('uC');
check('a lapsed post leaves the board but shows to its poster', !lc.body.posts.some(p => p.id === X1) && lc.body.mine_expired.some(p => p.id === X1 && p.expired), JSON.stringify(lc.body.mine_expired.map(p => p.id)));
lb = await list('uB');
check('and to nobody else', !lb.body.mine_expired.some(p => p.id === X1));
const flagged = (await DB.prepare('SELECT lapse_notified FROM market_posts WHERE id = ?').bind(X1).first()).lapse_notified;
check('the lapse notice is claimed once', flagged === 1, String(flagged));
r = await callRoute(env, R, 'POST', `${base}/market/${X1}/renew`, 'uB', {});
check('only the poster can renew', r.status === 403, JSON.stringify(r.body));
r = await callRoute(env, R, 'POST', `${base}/market/${X1}/renew`, 'uC', {});
check('renew re-lists for the lifetime originally chosen', r.status === 200 && r.body.post.expires_at_tick === 612 && r.body.post.expired === false, JSON.stringify(r.body));
lb = await list('uB');
check('and it is back on the board', lb.body.posts.some(p => p.id === X1));

// ---- one round trip for the PRIVATE tab ----
const summary = (await import('../worker/tradeSummary.js'));
r = await callRoute(env, summary.routes, 'GET', `${base}/trade-summary`, 'uB');
const partsOk = ['me', 'factions', 'trades', 'pacts', 'agreements', 'asset_deals'].filter(k => r.body?.[k] == null);
check('trade-summary answers with all six parts', r.status === 200 && partsOk.length === 0, `missing: ${partsOk.join(',')} ${JSON.stringify(r.body).slice(0, 200)}`);
const direct = await callRoute(env, R, 'GET', `${base}/trades`, 'uB');
check('each part IS the real endpoint answer', JSON.stringify(r.body.trades) === JSON.stringify(direct.body), 'trades part differs from GET /trades');
check('and it is the caller own faction, not another', r.body.me?.faction?.id === B.id, JSON.stringify(r.body.me).slice(0, 120));
r = await callRoute(env, summary.routes, 'GET', `${base}/trade-summary`, 'uNobody');
check('no faction, no summary', r.status === 404, JSON.stringify(r.body));

// ---- the dead do not trade ----
await DB.prepare('UPDATE game_factions SET eliminated_at_tick = 5 WHERE id = ?').bind(A.id).run();
lc = await list('uC');
check('an eliminated faction\'s posts come down', !lc.body.posts.some(p => p.poster_faction_id === A.id));

console.log(bad === 0 ? '\nALL MARKET CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
