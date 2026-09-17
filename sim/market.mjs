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
const tape = lc.body.recent.find(p => p.id === P1);
check('and shows on the public tape with both names', tape?.taken_by_name === B.name && tape?.poster_name === A.name, JSON.stringify(tape));

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
await DB.prepare(`UPDATE market_posts SET status = 'taking', taking_at_ms = 1, taken_by_faction_id = ? WHERE id = ?`).bind(C.id, P5).run();
lc = await list('uC');
check('a claim abandoned mid-take goes back on the board', lc.body.posts.some(p => p.id === P5 && p.status === 'open'));

// ---- the dead do not trade ----
await DB.prepare('UPDATE game_factions SET eliminated_at_tick = 5 WHERE id = ?').bind(A.id).run();
lc = await list('uC');
check('an eliminated faction\'s posts come down', !lc.body.posts.some(p => p.poster_faction_id === A.id));

console.log(bad === 0 ? '\nALL MARKET CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
