// ============================================================
// PAYING FOR A WORLD BY FREIGHTER -- drives the REAL handlers + tick.
//
// fartmaster (Discord), 2026-10-06: "Trading for a planet does not seem
// to work" -- every "Send a freighter" answered "the payment has to be
// delivered where the asset is". The row called the UNLOAD endpoint, and
// nothing could load a payment or fly it anywhere. And (Lorne's call)
// the payment may now land at ANY of the seller's settlements.
//
// Run: npm run sim:assetpay
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  };
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

async function seed(tag, { priceMetal = 600, priceCredits = 100 } = {}) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = `gpay${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Pay','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','pay-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active', gating_enabled = 0 WHERE id = ?").bind(G).run();
  const [A, B] = (await DB.prepare(
    'SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot').bind(G).all()).results;
  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  await DB.prepare('UPDATE game_factions SET metal = 5000, fuel = 0, gold = 5000, science = 0 WHERE game_id = ?').bind(G).run();
  await DB.prepare('UPDATE game_bodies SET yield_metal = 0, yield_gold = 0, yield_science = 0 WHERE game_id = ?').bind(G).run();

  // B's station on Mars: the world for sale.
  const MARS = `${G}:mars`;
  {
    const src = await DB.prepare('SELECT id FROM game_settlements WHERE game_id = ? AND owner_faction_id = ? LIMIT 1')
      .bind(G, B.id).first();
    const cols = (await DB.prepare('PRAGMA table_info(game_settlements)').all()).results.map(x => x.name);
    const over = { id: "'st_sale'", name: "'Thomas Station'", body_id: `'${MARS}'`, type: "'station'", destroyed_at_tick: 'NULL' };
    await DB.prepare(`INSERT INTO game_settlements (${cols.join(', ')})
                      SELECT ${cols.map(c => over[c] ?? c).join(', ')} FROM game_settlements WHERE id = ?`).bind(src.id).run();
  }

  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};
  const R = (await import('../worker/actions.js')).routes;
  let tickNow = 0;
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      tickNow += 1;
      await room.resolveTick(G, tickNow);
      await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run();
    }
  };
  const addFreighter = async (id, faction, bodyId) => DB.prepare(
    `INSERT INTO game_ships
      (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
       orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
       fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
     VALUES (?, ?, ?, ?, 'freighter', ?, 2, 2, 0, 0, 0, 1, 999, 999, 'active', 0, 60, 60, 0)`,
  ).bind(id, G, faction.id, id, bodyId).run();
  const base = `/api/games/${G}`;
  // B proposes the sale, A accepts.
  const prop = await callRoute(env, R, 'POST', `${base}/asset-deals`, 'uB',
    { asset_kind: 'settlement', asset_id: 'st_sale', buyer_faction_id: A.id, price_metal: priceMetal, price_credits: priceCredits });
  if (!prop.body.ok) throw new Error(`propose: ${JSON.stringify(prop.body)}`);
  const dealId = prop.body.deal_id;
  const acc = await callRoute(env, R, 'POST', `${base}/asset-deals/${dealId}/respond`, 'uA', { accept: true });
  if (!acc.body.ok) throw new Error(`accept: ${JSON.stringify(acc.body)}`);
  const deal = () => DB.prepare('SELECT * FROM trade_asset_deals WHERE id = ?').bind(dealId).first();
  const pool = (f) => DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(f.id).first();
  return { env, DB, G, A, B, R, MARS, base, dealId, deal, pool, tick, addFreighter };
}

const until = async (h, fn, limit = 150) => {
  for (let i = 0; i < limit; i++) { if (await fn()) return true; await h.tick(1); }
  return await fn();
};

// ------------------------------------------------------------------
// 1. Send freighters to the seller's CAPITAL (not the world for sale):
//    two runs because the price is more than a hold; the world changes
//    hands when the last of it lands.
// ------------------------------------------------------------------
{
  const h = await seed('send');
  await h.addFreighter('ship_pay1', h.A, h.A.capital_body_id);
  await h.addFreighter('ship_pay2', h.A, h.A.capital_body_id);
  await h.addFreighter('ship_pay3', h.A, h.A.capital_body_id);

  const list = await callRoute(h.env, h.R, 'GET', `${h.base}/asset-deals`, 'uA');
  const row = list.body.deals.find(d => d.id === h.dealId);
  check("the buyer's row lists the seller's capital as a place to pay",
    (row?.pay_dests ?? []).some(x => x.body_id === h.B.capital_body_id)
      && (row?.pay_dests ?? []).some(x => x.body_id === h.MARS),
    JSON.stringify(row?.pay_dests));

  const s1 = await callRoute(h.env, h.R, 'POST', `${h.base}/asset-deals/${h.dealId}/pay`, 'uA',
    { ship_id: 'ship_pay1', dest_body_id: h.B.capital_body_id });
  check('sending a freighter that is NOT at the asset is accepted (dispatched)',
    s1.body.ok === true && s1.body.dispatched === true, JSON.stringify(s1.body));
  check('it carries one hold of what is owed', s1.body.carrying?.metal === 400 && s1.body.carrying?.credits === 100,
    JSON.stringify(s1.body.carrying));
  const s2 = await callRoute(h.env, h.R, 'POST', `${h.base}/asset-deals/${h.dealId}/pay`, 'uA',
    { ship_id: 'ship_pay2', dest_body_id: h.B.capital_body_id });
  check('a second freighter carries only the remainder', s2.body.carrying?.metal === 200 && s2.body.carrying?.credits === 0,
    JSON.stringify(s2.body));
  const s3 = await callRoute(h.env, h.R, 'POST', `${h.base}/asset-deals/${h.dealId}/pay`, 'uA',
    { ship_id: 'ship_pay3', dest_body_id: h.B.capital_body_id });
  check('a third is refused: the rest is already on its way', s3.body.error?.code === 'covered', JSON.stringify(s3.body));

  const before = await h.pool(h.A);
  const done = await until(h, async () => (await h.deal()).status !== 'active');
  const d = await h.deal();
  const st = await h.DB.prepare("SELECT owner_faction_id FROM game_settlements WHERE id = 'st_sale'").first();
  const after = await h.pool(h.A);
  check('the deal settles once both runs land', done && d.status !== 'active' && d.status !== 'void', JSON.stringify(d));
  check('the world changes hands', st.owner_faction_id === h.A.id, JSON.stringify(st));
  check("the buyer's treasury paid the price (loaded at the dock)",
    Number(before.metal) - Number(after.metal) >= 600, JSON.stringify({ before, after }));
}

// ------------------------------------------------------------------
// 2. Only the asset or the seller's settlements take a payment.
// ------------------------------------------------------------------
{
  const h = await seed('dest');
  await h.addFreighter('ship_dst1', h.A, h.A.capital_body_id);
  const r = await callRoute(h.env, h.R, 'POST', `${h.base}/asset-deals/${h.dealId}/pay`, 'uA',
    { ship_id: 'ship_dst1', dest_body_id: h.A.capital_body_id });
  check("a payment cannot be 'delivered' to the buyer's own world", r.body.error?.code === 'bad_dest', JSON.stringify(r.body));
}

// ------------------------------------------------------------------
// 3. Already parked at a seller settlement with the freight aboard:
//    it pays on the spot (the old endpoint's job, wider destinations).
// ------------------------------------------------------------------
{
  const h = await seed('here', { priceMetal: 300, priceCredits: 0 });
  await h.addFreighter('ship_hre1', h.A, h.B.capital_body_id);
  await h.DB.prepare("UPDATE game_ships SET cargo_metal = 350 WHERE id = 'ship_hre1'").run();
  const r = await callRoute(h.env, h.R, 'POST', `${h.base}/asset-deals/${h.dealId}/pay`, 'uA', { ship_id: 'ship_hre1' });
  const st = await h.DB.prepare("SELECT owner_faction_id FROM game_settlements WHERE id = 'st_sale'").first();
  const hold = await h.DB.prepare("SELECT cargo_metal FROM game_ships WHERE id = 'ship_hre1'").first();
  check('a loaded freighter at a seller settlement pays at once and settles', r.body.settled === true && st.owner_faction_id === h.A.id,
    JSON.stringify({ r: r.body, st }));
  check('...and keeps what the price did not need', Number(hold.cargo_metal) === 50, JSON.stringify(hold));
}

// ------------------------------------------------------------------
// 4. The deal is called off while the payment is in flight: nothing is
//    poured into a dead deal; the load stays aboard.
// ------------------------------------------------------------------
{
  const h = await seed('off', { priceMetal: 300, priceCredits: 0 });
  await h.addFreighter('ship_off1', h.A, h.A.capital_body_id);
  const s = await callRoute(h.env, h.R, 'POST', `${h.base}/asset-deals/${h.dealId}/pay`, 'uA',
    { ship_id: 'ship_off1', dest_body_id: h.B.capital_body_id });
  check('dispatched (to be called off)', s.body.dispatched === true, JSON.stringify(s.body));
  await until(h, async () => {
    const d = await h.DB.prepare("SELECT loaded FROM trade_deliveries WHERE ship_id = 'ship_off1'").first();
    return Number(d?.loaded) === 1;
  });
  const c = await callRoute(h.env, h.R, 'POST', `${h.base}/asset-deals/${h.dealId}/cancel`, 'uB');
  check('the seller withdraws', c.body.ok === true, JSON.stringify(c.body));
  await until(h, async () => {
    const d = await h.DB.prepare("SELECT resolved_at_tick FROM trade_deliveries WHERE ship_id = 'ship_off1'").first();
    return d?.resolved_at_tick != null;
  });
  const hold = await h.DB.prepare("SELECT cargo_metal FROM game_ships WHERE id = 'ship_off1'").first();
  const st = await h.DB.prepare("SELECT owner_faction_id FROM game_settlements WHERE id = 'st_sale'").first();
  check('the payment stays aboard the freighter', Number(hold.cargo_metal) === 300, JSON.stringify(hold));
  check('and the world does not change hands', st.owner_faction_id === h.B.id, JSON.stringify(st));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
