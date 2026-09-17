// ============================================================
// HULLS AND WORLDS ON THE OPEN MARKET (migration 0129).
//
// A ship or world sale needed a named buyer. An open listing is a sale
// addressed to nobody: everyone sees it, the first to claim it becomes
// the buyer, and from there it is the ordinary sale. Drives the real
// routes in worker/actions.js.
//
// Run: node sim/assetListings.mjs
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
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const req = { json: async () => body ?? {}, headers: new Map() };
    const res = await r.handle(req, env, {
      url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId },
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  throw new Error(`no route matched ${method} ${path}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gassets1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0), ('uC','c@t','C','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Asset Test','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','asset-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'venus'), (?,?,2,'mars')`).bind(G, 'uA', G, 'uB', G, 'uC').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active', current_tick = 5 WHERE id = ?").bind(G).run();
const [A, B, C] = (await DB.prepare(
  `SELECT id, name FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
const R = (await import('../worker/actions.js')).routes;
const base = `/api/games/${G}`;

const ships = (await DB.prepare(
  `SELECT id, name FROM game_ships WHERE game_id = ? AND owner_faction_id = ? AND status = 'active' AND parent_body_id IS NOT NULL`)
  .bind(G, A.id).all()).results;
if (ships.length < 2) throw new Error('seed gave A fewer than two parked hulls');
const [S1, S2] = ships;

// ---- listing ----
let r = await callRoute(env, R, 'POST', `${base}/asset-deals`, 'uA',
  { asset_kind: 'ship', asset_id: S1.id, open: true, price_metal: 0, price_credits: 0 });
check('an open listing still needs a price', r.status === 409 && r.body.error?.code === 'no_price', JSON.stringify(r.body));
r = await callRoute(env, R, 'POST', `${base}/asset-deals`, 'uA',
  { asset_kind: 'ship', asset_id: S1.id, open: true, price_metal: 200, price_credits: 50 });
check('a hull goes on the open market with no buyer named', r.status === 201, JSON.stringify(r.body));
const D1 = r.body.deal_id;
r = await callRoute(env, R, 'POST', `${base}/asset-deals`, 'uA',
  { asset_kind: 'ship', asset_id: S1.id, buyer_faction_id: B.id, price_metal: 10 });
check('and cannot be sold privately at the same time', r.status === 409 && r.body.error?.code === 'already_listed', JSON.stringify(r.body));

// ---- visibility ----
r = await callRoute(env, R, 'GET', `${base}/asset-listings`, 'uC');
const seen = r.body.listings?.find(l => l.id === D1);
check('every faction sees it, seller named, not flagged as theirs',
  !!seen && seen.mine === false && seen.seller_name === A.name && seen.asset_name === S1.name && seen.price_metal === 200,
  JSON.stringify(seen));
r = await callRoute(env, R, 'GET', `${base}/asset-listings`, 'uA');
check('the seller sees it flagged as theirs', r.body.listings?.find(l => l.id === D1)?.mine === true);
r = await callRoute(env, R, 'GET', `${base}/asset-deals`, 'uA');
const mine = r.body.deals?.find(d => d.id === D1);
check('in the seller\'s own deals it reads "to the open market", never "to yourself"',
  mine?.open_listing === true && mine.buyer_name === 'the open market' && mine.i_am_seller === true, JSON.stringify(mine));
r = await callRoute(env, R, 'GET', `${base}/asset-deals`, 'uB');
check('it is in nobody else\'s private deals', !r.body.deals?.some(d => d.id === D1));

// ---- the placeholder cannot be abused ----
r = await callRoute(env, R, 'POST', `${base}/asset-deals/${D1}/respond`, 'uA', { accept: true });
check('the seller cannot "accept" their own advert', r.status === 409 && r.body.error?.code === 'open_listing', JSON.stringify(r.body));
r = await callRoute(env, R, 'POST', `${base}/asset-deals/${D1}/claim`, 'uA');
check('nor claim it', r.status === 409 && r.body.error?.code === 'self_deal', JSON.stringify(r.body));

// ---- the claim, and the race ----
const [cb, cc] = await Promise.all([
  callRoute(env, R, 'POST', `${base}/asset-deals/${D1}/claim`, 'uB'),
  callRoute(env, R, 'POST', `${base}/asset-deals/${D1}/claim`, 'uC'),
]);
check('two buyers, one hull: exactly one claim wins', [cb, cc].filter(x => x.status === 200).length === 1, `${cb.status}/${cc.status}`);
const winner = cb.status === 200 ? B : C;
const row = await DB.prepare('SELECT buyer_faction_id, status, open_listing FROM trade_asset_deals WHERE id = ?').bind(D1).first();
check('the winner is the buyer of an ACTIVE sale — the state an accepted private sale reaches',
  row.buyer_faction_id === winner.id && row.status === 'active' && row.open_listing === 2, JSON.stringify(row));
r = await callRoute(env, R, 'GET', `${base}/asset-listings`, 'uA');
check('a claimed listing leaves the board', !r.body.listings?.some(l => l.id === D1));
r = await callRoute(env, R, 'GET', `${base}/asset-deals`, winner === B ? 'uB' : 'uC');
const bought = r.body.deals?.find(d => d.id === D1);
check('and sits in the buyer\'s deals, waiting on their payment', bought?.status === 'active' && bought.i_am_seller === false && bought.open_listing === false, JSON.stringify(bought));

// ---- withdrawn, and gone ----
r = await callRoute(env, R, 'POST', `${base}/asset-deals`, 'uA',
  { asset_kind: 'ship', asset_id: S2.id, open: true, price_credits: 80 });
const D2 = r.body.deal_id;
r = await callRoute(env, R, 'POST', `${base}/asset-deals/${D2}/cancel`, 'uA');
check('the seller can withdraw a listing', r.status === 200, JSON.stringify(r.body));
r = await callRoute(env, R, 'POST', `${base}/asset-deals/${D2}/claim`, 'uB');
check('a withdrawn listing cannot be claimed', r.status === 409, JSON.stringify(r.body));

r = await callRoute(env, R, 'POST', `${base}/asset-deals`, 'uA',
  { asset_kind: 'ship', asset_id: S2.id, open: true, price_credits: 80 });
const D3 = r.body.deal_id;
await DB.prepare("UPDATE game_ships SET status = 'destroyed' WHERE id = ?").bind(S2.id).run();
r = await callRoute(env, R, 'POST', `${base}/asset-deals/${D3}/claim`, 'uB');
check('a hull lost since it was listed is not sold', r.status === 409 && r.body.error?.code === 'asset_gone', JSON.stringify(r.body));
const voided = await DB.prepare('SELECT status, ended_reason FROM trade_asset_deals WHERE id = ?').bind(D3).first();
check('and the dead listing is voided, so it stops being advertised', voided.status === 'void' && voided.ended_reason === 'asset_gone', JSON.stringify(voided));

console.log(bad === 0 ? '\nALL ASSET-LISTING CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
