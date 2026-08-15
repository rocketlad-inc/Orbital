// ============================================================
// TRADE V2 — routes as objects (DESIGN-trade-v2), driven end to end
// through the REAL code: the tradeRoutesV2.js endpoints through their
// route table, the actions.js two-stop create, and room.js resolveTick
// walking stops, pacing guards, and running the stall clock.
//
// The one case that matters more than all the others is the FIRST one:
// a route laid through the OLD endpoint must behave exactly as the old
// ping-pong did. That equivalence is what makes the cutover safe for
// every live game.
//
// Run: npm run sim:trade2
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
      get: async (k) => kv.get(k),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k),
      setAlarm: async () => {},
      getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  };
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
    return JSON.parse(await res.text());
  }
  throw new Error(`no route matched ${method} ${path}`);
}

async function seed(tag, opts = {}) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
  };
  // GAME_ID_RE is 6-32 chars — a short prefix + a two-letter tag lands
  // under it and every endpoint rejects the whole sim with 'invalid
  // game id'. Same trap the cargo-hold sim hit.
  const G = `gtrv2${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0), ('uC','c@t','C','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'V2 Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','v2-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
  // A third power only where a case needs a raider — an extra faction
  // changes combat and diplomacy dynamics, so it stays opt-in.
  if (opts.thirdPlayer) {
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                      VALUES (?,?,2,'mars')`).bind(G, 'uC').run();
  }
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();

  const [A, B, C] = (await DB.prepare(
    `SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`)
    .bind(G).all()).results;

  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  await DB.prepare(`UPDATE game_factions SET metal = 1000, fuel = 0, gold = 1000, science = 0 WHERE game_id = ?`)
    .bind(G).run();
  // ZERO THE BACKGROUND ECONOMY. Settlements harvest body yields into
  // the pool every tick, so a pool delta measured across a multi-tick
  // wait is delivery PLUS income — which is exactly how a 30-gold
  // filter test read as 262. With yields flat, a pool delta is the
  // shipment and nothing else.
  await DB.prepare(
    `UPDATE game_bodies SET yield_metal = 0, yield_gold = 0, yield_science = 0 WHERE game_id = ?`,
  ).bind(G).run();

  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};

  const v2 = (await import('../worker/tradeRoutesV2.js')).routes;
  const legacy = (await import('../worker/actions.js')).routes;
  const trades = (await import('../worker/trades.js')).routes;

  let tickNow = 0;
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      tickNow += 1;
      await room.resolveTick(G, tickNow);
      await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run();
    }
  };

  const addShip = async (id, faction, cls, bodyId, opts = {}) => {
    await DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
       VALUES (?, ?, ?, ?, ?, ?, 2, 2, 0, 0, 0, 1,
               999, 999, 'active', 0, ?, ?, ?)`,
    ).bind(id, G, faction.id, opts.name ?? `Ship ${id}`, cls, bodyId,
           opts.hp ?? 60, opts.hp ?? 60, opts.dmg ?? (cls === 'freighter' ? 0 : 8)).run();
  };
  const addSettlement = async (id, faction, bodyId, opts = {}) => {
    await DB.prepare(
      `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
         hp, hp_max, population, surface_angle, created_at_tick,
         stockpile_metal, stockpile_gold, stockpile_science)
       VALUES (?, ?, ?, ?, ?, ?, 100, 100, 1, 0, 0, ?, ?, ?)`,
    ).bind(id, G, bodyId, faction.id, opts.type ?? 'station', opts.name ?? id,
           opts.metal ?? 0, opts.gold ?? 0, opts.science ?? 0).run();
    if (opts.terraform) {
      await DB.prepare(
        'UPDATE game_bodies SET terraformed_at_tick = 0, owner_faction_id = ? WHERE id = ? AND game_id = ?',
      ).bind(faction.id, bodyId, G).run();
    }
  };
  const pool = (f) => DB.prepare('SELECT metal, gold, science FROM game_factions WHERE id = ?').bind(f.id).first();
  // Ship upkeep drains the POOL every tick, so a pool delta measured
  // across a long wait is "delivered minus upkeep" — noisy by
  // construction, and what made a 30-gold filter read as 262. A
  // settlement's stockpile drain is exactly what was picked up, and
  // trades_completed is exactly whether it was delivered; neither moves
  // for any other reason.
  const stock = (id) => DB.prepare(
    'SELECT stockpile_metal AS metal, stockpile_gold AS gold, stockpile_science AS science FROM game_settlements WHERE id = ?',
  ).bind(id).first();
  const deliveries = (shipId) => DB.prepare(
    'SELECT trades_completed AS n FROM game_ships WHERE id = ?').bind(shipId).first().then(r => Number(r?.n ?? 0));
  const route = (id) => DB.prepare('SELECT * FROM game_trade_routes WHERE id = ?').bind(id).first();
  const crewOf = (id) => DB.prepare('SELECT * FROM game_trade_route_ships WHERE route_id = ? ORDER BY role, ship_id').bind(id).all().then(r => r.results ?? []);

  // Research lives in faction_techs rows, not a column on the faction.
  // Turning gating ON is what makes the carrier-cap ladder real in the
  // sim — with it off every faction gets the top cap and the gate is
  // never actually exercised.
  const grantTech = async (faction, track, level) => {
    await DB.prepare('UPDATE games SET gating_enabled = 1 WHERE id = ?').bind(G).run();
    await DB.prepare(
      `INSERT INTO faction_techs
         (game_id, faction_id, tech_id, status, started_at_tick, completed_at_tick, level)
       VALUES (?, ?, ?, 'completed', 0, 0, ?)
       ON CONFLICT(game_id, faction_id, tech_id) DO UPDATE SET level = excluded.level`,
    ).bind(G, faction.id, track, level).run();
  };

  return { env, DB, G, A, B, C, v2, legacy, trades, tick, tickOf: () => tickNow,
           addShip, addSettlement, pool, route, crewOf, grantTech, stock, deliveries };
}

const until = async (h, fn, limit = 40) => {
  for (let i = 0; i < limit; i++) {
    if (await fn()) return true;
    await h.tick(1);
  }
  return await fn();
};

// ============================================================
// 1. EQUIVALENCE: the OLD endpoint's two-stop route still ping-pongs —
//    pickup at origin, deliver to the pool at dest, repeat, with the
//    status flag mirroring the cursor the whole way.
// ============================================================
{
  const h = await seed('eq');
  await h.addShip('ship_eq1', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_eq_mars', h.A, `${h.G}:mars`, { terraform: true });
  // Stockpile at the CAPITAL (origin); dest is the terraformed mars dock.
  await h.DB.prepare(
    `UPDATE game_settlements SET stockpile_metal = 120, stockpile_gold = 40
      WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?`,
  ).bind(h.G, h.A.capital_body_id, h.A.id).run();

  const res = await callRoute(h.env, h.legacy, 'POST',
    `/api/games/${h.G}/trade-routes`, 'uA',
    { ship_id: 'ship_eq1', origin_body_id: h.A.capital_body_id, dest_body_id: `${h.G}:mars` });
  check('old endpoint still creates a route', !!res.ok, JSON.stringify(res).slice(0, 140));
  const rid = res.route.id;

  const stops = (await h.DB.prepare(
    'SELECT sequence, body_id, action FROM game_trade_route_stops WHERE route_id = ? ORDER BY sequence')
    .bind(rid).all()).results;
  check('…and it is a two-stop route under the hood',
    stops.length === 2 && stops[0].action === 'pickup' && stops[1].action === 'dropoff',
    JSON.stringify(stops));
  const crew = await h.crewOf(rid);
  check('…with a carrier crew row', crew.length === 1 && crew[0].role === 'carrier',
    JSON.stringify(crew));

  const capitalStock = (await h.DB.prepare(
    `SELECT id FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?`,
  ).bind(h.G, h.A.capital_body_id, h.A.id).first()).id;
  const delivered = await until(h, async () => (await h.deliveries('ship_eq1')) >= 1, 30);
  check('the freighter completed a delivery', delivered,
    `trades_completed=${await h.deliveries('ship_eq1')}`);
  const left = await h.stock(capitalStock);
  check('the origin stockpile was swept (120 metal + 40 gold picked up)',
    left.metal === 0 && left.gold === 0, JSON.stringify(left));
  const r = await h.route(rid);
  check("status keeps mirroring the cursor ('returning' after delivery)",
    r.status === 'returning' || r.status === 'outbound', r.status);
}

// ============================================================
// 2. THE MILK RUN: three pickups, one dropoff, one freighter — with a
//    metal-only filter respected at the second stop.
// ============================================================
{
  const h = await seed('mr');
  await h.addShip('ship_mr1', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_mr_mars',  h.A, `${h.G}:mars`,  { metal: 50, gold: 30 });
  await h.addSettlement('st_mr_venus', h.A, `${h.G}:venus`, { metal: 40, gold: 25 });
  // Capital is the dock (terraformed by seeding).
  const res = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA', {
    name: 'Milk Run',
    stops: [
      { body_id: `${h.G}:mars`,  action: 'pickup' },
      { body_id: `${h.G}:venus`, action: 'pickup', take_gold: 0, take_science: 0 },
      { body_id: h.A.capital_body_id, action: 'dropoff' },
    ],
    carrier_ship_ids: ['ship_mr1'],
  });
  check('composer create succeeds', !!res.ok, JSON.stringify(res).slice(0, 200));

  const done = await until(h, async () => (await h.deliveries('ship_mr1')) >= 1, 60);
  check('the milk run completed a delivery', done,
    `trades_completed=${await h.deliveries('ship_mr1')}`);
  const mars = await h.stock('st_mr_mars');
  const venus = await h.stock('st_mr_venus');
  check('stop 1 (no filter) was swept clean — metal AND gold',
    mars.metal === 0 && mars.gold === 0, JSON.stringify(mars));
  check('stop 2 (metal only) gave up its metal…', venus.metal === 0, JSON.stringify(venus));
  check('…and KEPT its gold — the filter is real', venus.gold === 25, JSON.stringify(venus));
}

// ============================================================
// 3. THE GAUGE CANNOT LIE: projection == what the tick actually loads,
//    for the same stops with the same stockpiles.
// ============================================================
{
  const h = await seed('pj');
  await h.addShip('ship_pj1', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_pj_mars',  h.A, `${h.G}:mars`,  { metal: 77, gold: 13 });
  await h.addSettlement('st_pj_venus', h.A, `${h.G}:venus`, { metal: 21, gold: 8 });
  const stops = [
    { body_id: `${h.G}:mars`,  action: 'pickup' },
    { body_id: `${h.G}:venus`, action: 'pickup' },
    { body_id: h.A.capital_body_id, action: 'dropoff' },
  ];
  const proj = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/project`, 'uA',
    { stops, ship_id: 'ship_pj1' });
  check('projection endpoint answers', !!proj.ok, JSON.stringify(proj).slice(0, 140));
  const projDelivered = proj.projection.delivered;

  const res = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA',
    { stops, carrier_ship_ids: ['ship_pj1'] });
  check('route created for the same stops', !!res.ok);
  const m0 = await h.stock('st_pj_mars');
  const v0 = await h.stock('st_pj_venus');
  await until(h, async () => (await h.deliveries('ship_pj1')) >= 1, 60);
  const m1 = await h.stock('st_pj_mars');
  const v1 = await h.stock('st_pj_venus');
  const sweptMetal = (m0.metal - m1.metal) + (v0.metal - v1.metal);
  const sweptGold  = (m0.gold  - m1.gold)  + (v0.gold  - v1.gold);
  check('the tick loaded EXACTLY what the gauge projected',
    sweptMetal === projDelivered.metal && sweptGold === projDelivered.gold,
    `projected ${projDelivered.metal}M/${projDelivered.gold}C, swept ${sweptMetal}M/${sweptGold}C`);
}

// ============================================================
// 4. STALL: the only carrier dies → 'stalled' with the clock running;
//    a freighter assigned at tick 29 rescues the route.
// ============================================================
{
  const h = await seed('st');
  await h.addShip('ship_st1', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_st_mars', h.A, `${h.G}:mars`, { metal: 500, terraform: true });
  const res = await callRoute(h.env, h.legacy, 'POST', `/api/games/${h.G}/trade-routes`, 'uA',
    { ship_id: 'ship_st1', origin_body_id: h.A.capital_body_id, dest_body_id: `${h.G}:mars` });
  const rid = res.route.id;
  await h.tick(2);
  await h.DB.prepare(
    `UPDATE game_ships SET status = 'destroyed', hp = 0, destroyed_at_tick = ? WHERE id = 'ship_st1'`)
    .bind(h.tickOf()).run();
  await h.tick(2);
  let r = await h.route(rid);
  check("dead carrier -> status 'stalled', clock set",
    r.status === 'stalled' && r.stalled_since_tick != null,
    `${r.status} / ${r.stalled_since_tick}`);
  check('not cancelled', r.cancelled_at_tick == null, String(r.cancelled_at_tick));

  await h.tick(27);   // 29 ticks on the clock
  r = await h.route(rid);
  check('still alive at 29 ticks stalled', r.cancelled_at_tick == null,
    `stalled_since=${r.stalled_since_tick} now=${h.tickOf()}`);

  await h.addShip('ship_st2', h.A, 'freighter', h.A.capital_body_id);
  const add = await callRoute(h.env, h.v2, 'POST',
    `/api/games/${h.G}/trade-routes/${rid}/ships`, 'uA',
    { role: 'carrier', ship_id: 'ship_st2' });
  check('assigning a freighter at the eleventh hour succeeds', !!add.ok,
    JSON.stringify(add).slice(0, 140));
  r = await h.route(rid);
  check('the stall clock STOPS the moment a freighter signs on',
    r.stalled_since_tick == null && r.ship_id === 'ship_st2',
    JSON.stringify({ s: r.stalled_since_tick, ship: r.ship_id }));
  await h.tick(5);
  r = await h.route(rid);
  check('the rescued route is alive and running', r.cancelled_at_tick == null, String(r.cancelled_at_tick));
}

// ============================================================
// 5. STALL EXPIRY: nobody helps, thirty ticks pass, the route cancels
//    itself.
// ============================================================
{
  const h = await seed('sx');
  await h.addShip('ship_sx1', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_sx_mars', h.A, `${h.G}:mars`, { metal: 500, terraform: true });
  const res = await callRoute(h.env, h.legacy, 'POST', `/api/games/${h.G}/trade-routes`, 'uA',
    { ship_id: 'ship_sx1', origin_body_id: h.A.capital_body_id, dest_body_id: `${h.G}:mars` });
  const rid = res.route.id;
  await h.tick(1);
  await h.DB.prepare(
    `UPDATE game_ships SET status = 'destroyed', hp = 0, destroyed_at_tick = ? WHERE id = 'ship_sx1'`)
    .bind(h.tickOf()).run();
  await h.tick(34);
  const r = await h.route(rid);
  check('unrescued route auto-cancels after the stall window',
    r.cancelled_at_tick != null, JSON.stringify({ c: r.cancelled_at_tick, s: r.stalled_since_tick }));
  const crew = await h.crewOf(rid);
  check('crew table is clean after the cancel', crew.length === 0, JSON.stringify(crew));
}

// ============================================================
// 6. TWO CARRIERS: one dies mid-run, the route promotes the survivor
//    and never stalls.
// ============================================================
{
  const h = await seed('mc');
  await h.addShip('ship_mc1', h.A, 'freighter', h.A.capital_body_id);
  await h.addShip('ship_mc2', h.A, 'freighter', h.A.capital_body_id);
  // Convoy Logistics (Society 7) is what lets a lane hold 2 carriers.
  await h.grantTech(h.A, 'industry', 7);
  await h.addSettlement('st_mc_mars', h.A, `${h.G}:mars`, { metal: 900 });
  const res = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA', {
    stops: [
      { body_id: `${h.G}:mars`, action: 'pickup' },
      { body_id: h.A.capital_body_id, action: 'dropoff' },
    ],
    carrier_ship_ids: ['ship_mc1', 'ship_mc2'],
  });
  check('two-carrier create passes the research gate', !!res.ok, JSON.stringify(res).slice(0, 160));
  const rid = res.route.id;
  await h.tick(3);
  await h.DB.prepare(
    `UPDATE game_ships SET status = 'destroyed', hp = 0, destroyed_at_tick = ? WHERE id = 'ship_mc1'`)
    .bind(h.tickOf()).run();
  await h.tick(3);
  const r = await h.route(rid);
  check('losing ONE of two carriers never stalls the lane',
    r.cancelled_at_tick == null && r.stalled_since_tick == null && r.ship_id === 'ship_mc2',
    JSON.stringify({ ship: r.ship_id, stalled: r.stalled_since_tick }));
  const before = await h.pool(h.A);
  const moved = await until(h, async () => (await h.pool(h.A)).metal > before.metal, 40);
  check('…and the survivor keeps delivering', moved, JSON.stringify(await h.pool(h.A)));
}

// ============================================================
// 7. GUARDS: assigned to the route, defensive stance set, departs and
//    arrives in LOCKSTEP with its carrier, re-attaches when the ward
//    dies.
// ============================================================
{
  const h = await seed('gd');
  await h.addShip('ship_gd1', h.A, 'freighter', h.A.capital_body_id);
  await h.addShip('ship_gd2', h.A, 'freighter', h.A.capital_body_id);
  await h.addShip('ship_gdG', h.A, 'corvette', h.A.capital_body_id, { dmg: 3 });
  await h.grantTech(h.A, 'industry', 7);
  await h.addSettlement('st_gd_mars', h.A, `${h.G}:mars`, { metal: 900 });
  const res = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA', {
    stops: [
      { body_id: `${h.G}:mars`, action: 'pickup' },
      { body_id: h.A.capital_body_id, action: 'dropoff' },
    ],
    carrier_ship_ids: ['ship_gd1', 'ship_gd2'],
    guard_ship_ids: ['ship_gdG'],
  });
  check('create with a guard succeeds', !!res.ok, JSON.stringify(res).slice(0, 160));
  const rid = res.route.id;
  const stance = await h.DB.prepare("SELECT stance FROM game_ships WHERE id = 'ship_gdG'").first();
  check("guard is in DEFENSIVE stance from assignment", stance.stance === 'defensive', stance.stance);

  // Lockstep: after a few ticks the guard must be at the same body as
  // its ward whenever the ward is parked.
  await h.tick(12);
  const ward0 = (await h.crewOf(rid)).find(c => c.role === 'guard')?.follow_ship_id;
  check('guard follows a named carrier', ward0 === 'ship_gd1' || ward0 === 'ship_gd2', String(ward0));
  // Lockstep is not "parked together" — they arrive and are dispatched
  // again within the same tick, so a parked-together moment may never
  // be observable. Lockstep MEANS every leg shares a departure tick, a
  // destination, and an arrival tick. That is what the nodes record.
  const wardLegs = (await h.DB.prepare(
    `SELECT committed_at_tick, arrival_at_tick, target_body_id
       FROM game_ship_nodes WHERE ship_id = ? ORDER BY sequence`).bind(ward0).all()).results ?? [];
  const guardLegs = (await h.DB.prepare(
    `SELECT committed_at_tick, arrival_at_tick, target_body_id
       FROM game_ship_nodes WHERE ship_id = 'ship_gdG' ORDER BY sequence`).all()).results ?? [];
  check('the guard actually flew the lane', guardLegs.length >= 2,
    `${guardLegs.length} legs`);
  const paired = guardLegs.filter(g => wardLegs.some(w =>
    w.committed_at_tick === g.committed_at_tick
    && w.arrival_at_tick === g.arrival_at_tick
    && w.target_body_id === g.target_body_id));
  check('every guard leg matches a ward leg exactly — same tick out, same tick in',
    guardLegs.length > 0 && paired.length === guardLegs.length,
    `${paired.length}/${guardLegs.length} legs in lockstep`);

  // Kill the ward: the guard re-attaches to the surviving carrier.
  await h.DB.prepare(
    `UPDATE game_ships SET status = 'destroyed', hp = 0, destroyed_at_tick = ? WHERE id = ?`)
    .bind(h.tickOf(), ward0).run();
  await h.tick(4);
  const guardRow = (await h.crewOf(rid)).find(c => c.role === 'guard');
  const survivor = ward0 === 'ship_gd1' ? 'ship_gd2' : 'ship_gd1';
  check('guard re-attaches to the surviving carrier',
    guardRow?.follow_ship_id === survivor,
    JSON.stringify({ follow: guardRow?.follow_ship_id, survivor }));
}

// ============================================================
// 8. CONSOLIDATION: a two-leg agreement becomes one freighter flying
//    both directions; the surplus freighter is RELEASED, terms keep
//    moving, loops count.
// ============================================================
{
  const h = await seed('cn');
  await h.addShip('ship_cnA', h.A, 'freighter', h.A.capital_body_id);
  await h.addShip('ship_cnB', h.B, 'freighter', h.B.capital_body_id);

  // Strike a recurring deal exactly as the trades panel does, then
  // commission both legs through /options like the real client.
  const prop = await callRoute(h.env, h.trades, 'POST', `/api/games/${h.G}/trades`, 'uA', {
    responder_faction_id: h.B.id,
    offer: { metal: 100 }, request: { gold: 50 },
    recurring: true,
  });
  check('recurring offer proposed', !!prop.trade?.id, JSON.stringify(prop).slice(0, 140));
  const acc = await callRoute(h.env, h.trades, 'POST',
    `/api/games/${h.G}/trades/${prop.trade.id}/accept`, 'uB', {});
  check('offer accepted', !acc.error, JSON.stringify(acc).slice(0, 140));
  const agRow = await h.DB.prepare('SELECT * FROM trade_agreements WHERE game_id = ?').bind(h.G).first();
  const agId = agRow?.id;
  check('a standing agreement exists', !!agId, JSON.stringify(agRow).slice(0, 140));

  const commissioned = [];
  for (const [uid, ship] of [['uA', 'ship_cnA'], ['uB', 'ship_cnB']]) {
    const opts = await callRoute(h.env, h.trades, 'GET',
      `/api/games/${h.G}/trade-agreements/${agId}/options`, uid, null);
    const dest = opts.targets?.[0];
    if (!dest) { commissioned.push({ uid, error: 'no targets', opts }); continue; }
    commissioned.push(await callRoute(h.env, h.trades, 'POST',
      `/api/games/${h.G}/trade-agreements/${agId}/commission`, uid,
      { ship_id: ship, dest_body_id: dest.body_id }));
  }
  check('both legs commissioned', commissioned.every(c => c.ok),
    JSON.stringify(commissioned).slice(0, 240));

  // A offers to consolidate on THEIR hull; B accepts.
  const off = await callRoute(h.env, h.v2, 'POST',
    `/api/games/${h.G}/trade-agreements/${agId}/consolidate`, 'uA', { ship_id: 'ship_cnA' });
  check('consolidation offered on the already-flying hull', !!off.ok, JSON.stringify(off).slice(0, 140));
  const accC = await callRoute(h.env, h.v2, 'POST',
    `/api/games/${h.G}/trade-agreements/${agId}/consolidate/accept`, 'uB', {});
  check('partner accepts', !!accC.ok, JSON.stringify(accC).slice(0, 200));
  const laneId = accC.route_id;

  const bLeg = await h.DB.prepare(
    `SELECT cancelled_at_tick FROM game_trade_routes WHERE ship_id = 'ship_cnB' AND agreement_id = ?`)
    .bind(agId).first();
  check("B's leg is cancelled — their freighter RELEASED, not consumed",
    bLeg?.cancelled_at_tick != null, JSON.stringify(bLeg));
  const bJob = await h.DB.prepare(
    `SELECT 1 AS x FROM game_trade_route_ships WHERE ship_id = 'ship_cnB' LIMIT 1`).first();
  check("…and free for new work (no crew row pins it)", !bJob, JSON.stringify(bJob));

  // Watch tick by tick for the two deliveries themselves — a pool delta
  // measured across the whole wait would be swamped by upkeep.
  let sawBMetal = false, sawAGold = false;
  let bPrev = (await h.pool(h.B)).metal;
  let aPrev = (await h.pool(h.A)).gold;
  for (let i = 0; i < 90 && !(sawBMetal && sawAGold); i++) {
    await h.tick(1);
    const bNow = (await h.pool(h.B)).metal;
    const aNow = (await h.pool(h.A)).gold;
    if (bNow > bPrev) sawBMetal = true;
    if (aNow > aPrev) sawAGold = true;
    bPrev = bNow; aPrev = aNow;
  }
  const lane = await h.route(laneId);
  check('B received metal (A -> B direction moved)', sawBMetal);
  check('A received gold (B -> A direction moved)', sawAGold);
  check('a full round trip counted only once both directions ran',
    Number(lane?.loops_completed ?? 0) >= 1, `loops=${lane?.loops_completed}`);
  check('the ONE hull carried both directions',
    (await h.crewOf(laneId)).filter(c => c.role === 'carrier').length === 1);
}

// ============================================================
// 9. LOOP MODE: "run 1 time, then park" retires the route cleanly.
// ============================================================
{
  const h = await seed('lp');
  await h.addShip('ship_lp1', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_lp_mars', h.A, `${h.G}:mars`, { metal: 60 });
  const res = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA', {
    stops: [
      { body_id: `${h.G}:mars`, action: 'pickup' },
      { body_id: h.A.capital_body_id, action: 'dropoff' },
    ],
    loop_mode: 'count', loop_count: 1,
    carrier_ship_ids: ['ship_lp1'],
  });
  check('run-once route created', !!res.ok, JSON.stringify(res).slice(0, 140));
  const rid = res.route.id;
  const done = await until(h, async () => (await h.route(rid))?.cancelled_at_tick != null, 60);
  const r = await h.route(rid);
  check('one loop, then the route retires itself', done && r.loops_completed >= 1,
    JSON.stringify({ c: r.cancelled_at_tick, loops: r.loops_completed }));
  const ship = await h.DB.prepare("SELECT status FROM game_ships WHERE id = 'ship_lp1'").first();
  const job = await h.DB.prepare("SELECT 1 AS x FROM game_trade_route_ships WHERE ship_id = 'ship_lp1'").first();
  check('the freighter parks, free for new orders', ship.status === 'active' && !job);
}

// ============================================================
// 10. GUARDS EARN THEIR UPKEEP — the claim that escorting needs NO new
//     combat code, actually tested. Two existing rules do all the work:
//       - target priority puts ARMED ships ahead of civilians, so a
//         raider must chew through the guard before the freighter
//       - defensive stance engages any faction aggressing at this body,
//         which is what lets a guard shoot back at all
//     Decision (Lorne): a guard defends the hull running the lane
//     whoever owns it — so this runs with the freighter belonging to
//     the PARTNER, not to the guard's owner.
// ============================================================
{
  // B's freighter runs a lane; A's corvette guards it; C raids.
  const h = await seed('cb', { thirdPlayer: true });
  const C = h.C;
  const lane = `${h.G}:mars`;
  await h.addSettlement('st_cb_mars', h.B, lane, { metal: 400, terraform: true });
  await h.addShip('ship_cbF', h.B, 'freighter', lane);       // the ward (B's)
  await h.addShip('ship_cbG', h.A, 'corvette', lane, { dmg: 6, hp: 90 });   // guard (A's)
  await h.addShip('ship_cbR', C, 'destroyer', lane, { dmg: 12, hp: 200 });  // raider

  await h.DB.prepare("UPDATE game_ships SET stance = 'defensive' WHERE id = 'ship_cbG'").run();
  await h.DB.prepare("UPDATE game_ships SET stance = 'attack' WHERE id = 'ship_cbR'").run();

  const hpOf = async (id) => Number((await h.DB
    .prepare('SELECT hp FROM game_ships WHERE id = ?').bind(id).first())?.hp ?? 0);
  const raider0 = await hpOf('ship_cbR');

  await h.tick(3);

  const freighterHp = await hpOf('ship_cbF');
  const raiderHp = await hpOf('ship_cbR');
  // Assert on WHO WAS AIMED AT, not on damage taken: combat v2 rolls
  // for whether a shot connects, so a guard can be shot at repeatedly
  // and still sit at full HP. last_target_id records the choice itself.
  const raiderTarget = (await h.DB
    .prepare("SELECT last_target_id FROM game_ships WHERE id = 'ship_cbR'").first())?.last_target_id;

  check('the raider AIMED at the guard, not the freighter',
    raiderTarget === 'ship_cbG', `aimed at ${raiderTarget}`);
  check('the freighter is untouched behind its escort — screening is real',
    freighterHp === 60, `freighter hp ${freighterHp}/60`);
  check("the guard shot back at a faction attacking a PARTNER's hull",
    raiderHp < raider0, `raider hp ${raiderHp}/${raider0}`);
}

// ============================================================
// 11. A guard does NOT start a fight. Defensive stance means the lane
//     can cross a neutral's space without dragging its owner into a war
//     nobody chose — the other half of decision #2.
// ============================================================
{
  const h = await seed('nf', { thirdPlayer: true });
  const C = h.C;
  const lane = `${h.G}:mars`;
  await h.addSettlement('st_nf_mars', h.A, lane, { metal: 200, terraform: true });
  await h.addShip('ship_nfG', h.A, 'corvette', lane, { dmg: 6, hp: 90 });
  await h.addShip('ship_nfN', C, 'frigate', lane, { dmg: 9, hp: 120 });
  await h.DB.prepare("UPDATE game_ships SET stance = 'defensive' WHERE id = 'ship_nfG'").run();
  // The neutral is NOT aggressing — parked, defensive.
  await h.DB.prepare("UPDATE game_ships SET stance = 'defensive' WHERE id = 'ship_nfN'").run();

  await h.tick(3);
  const neutralHp = Number((await h.DB
    .prepare("SELECT hp FROM game_ships WHERE id = 'ship_nfN'").first())?.hp ?? 0);
  check('a guard sharing orbit with a non-aggressor never opens fire',
    neutralHp === 120, `neutral hp ${neutralHp}/120`);
}

// ============================================================
// 12. REPRO (Lorne, live): "adding a guard to the route dismissed my
//     freighter." Reproduced on an AGREEMENT LEG, the shape in the
//     report — Titan->Luna had no ADD STOPS button, so it carried a
//     counterparty.
// ============================================================
{
  const h = await seed('gr');
  await h.addShip('ship_grA', h.A, 'freighter', h.A.capital_body_id);
  await h.addShip('ship_grB', h.B, 'freighter', h.B.capital_body_id);
  await h.addShip('ship_grG', h.A, 'corvette', h.A.capital_body_id, { dmg: 4 });

  const prop = await callRoute(h.env, h.trades, 'POST', `/api/games/${h.G}/trades`, 'uA', {
    responder_faction_id: h.B.id,
    offer: { metal: 100 }, request: { gold: 50 },
    recurring: true,
  });
  await callRoute(h.env, h.trades, 'POST', `/api/games/${h.G}/trades/${prop.trade.id}/accept`, 'uB', {});
  const agId = (await h.DB.prepare('SELECT id FROM trade_agreements WHERE game_id = ?').bind(h.G).first()).id;
  for (const [uid, ship] of [['uA', 'ship_grA'], ['uB', 'ship_grB']]) {
    const opts = await callRoute(h.env, h.trades, 'GET',
      `/api/games/${h.G}/trade-agreements/${agId}/options`, uid, null);
    await callRoute(h.env, h.trades, 'POST',
      `/api/games/${h.G}/trade-agreements/${agId}/commission`, uid,
      { ship_id: ship, dest_body_id: opts.targets[0].body_id });
  }
  const myLeg = await h.DB.prepare(
    `SELECT id FROM game_trade_routes WHERE agreement_id = ? AND ship_id = 'ship_grA'`).bind(agId).first();
  check('the leg has a carrier before any guard',
    (await h.crewOf(myLeg.id)).some(c => c.role === 'carrier' && c.ship_id === 'ship_grA'),
    JSON.stringify(await h.crewOf(myLeg.id)));

  const add = await callRoute(h.env, h.v2, 'POST',
    `/api/games/${h.G}/trade-routes/${myLeg.id}/ships`, 'uA',
    { role: 'guard', ship_id: 'ship_grG' });
  check('guard accepted onto the leg', !!add.ok, JSON.stringify(add).slice(0, 160));

  let crew = await h.crewOf(myLeg.id);
  check('THE CARRIER SURVIVES the guard assignment',
    crew.some(c => c.role === 'carrier' && c.ship_id === 'ship_grA'),
    JSON.stringify(crew));

  await h.tick(6);
  crew = await h.crewOf(myLeg.id);
  const rr = await h.route(myLeg.id);
  check('...and survives six ticks of the autopilot',
    crew.some(c => c.role === 'carrier' && c.ship_id === 'ship_grA'),
    JSON.stringify(crew));
  check('...with the route row still pointing at it',
    rr?.ship_id === 'ship_grA' && rr?.cancelled_at_tick == null,
    JSON.stringify({ ship: rr?.ship_id, cancelled: rr?.cancelled_at_tick }));
  check('the guard is still aboard too',
    crew.some(c => c.role === 'guard' && c.ship_id === 'ship_grG'),
    JSON.stringify(crew));
}

// ============================================================
// 13. REPRO (Lorne, live): a card reading "STALLED - no freighter" AND
//     "Runs it - Palashite" at the same time, with the remove button
//     refusing. Both symptoms are ONE state: the route row still names
//     a ship while the crew table has no row for it. The server is
//     right to stall (there is no crew), the CLIENT invented the
//     carrier from route.shipId, and removing it 404s because there is
//     nothing to remove.
// ============================================================
{
  const h = await seed('ph');
  await h.addShip('ship_ph1', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_ph_mars', h.A, `${h.G}:mars`, { metal: 300, terraform: true });
  const res = await callRoute(h.env, h.legacy, 'POST', `/api/games/${h.G}/trade-routes`, 'uA',
    { ship_id: 'ship_ph1', origin_body_id: h.A.capital_body_id, dest_body_id: `${h.G}:mars` });
  const rid = res.route.id;
  await h.tick(2);

  // Reproduce the orphaned state: crew row gone, route row still naming
  // the (alive) hull. However it arose in the live game, this is the
  // shape, and it must be recoverable.
  await h.DB.prepare('DELETE FROM game_trade_route_ships WHERE route_id = ?').bind(rid).run();
  await h.tick(1);

  const r1 = await h.route(rid);
  const crew1 = await h.crewOf(rid);
  check('the tick RE-CREWS an orphaned route from its own ship_id',
    crew1.some(c => c.role === 'carrier' && c.ship_id === 'ship_ph1'),
    JSON.stringify({ crew: crew1, ship: r1?.ship_id, stalled: r1?.stalled_since_tick }));
  check('...so it is not left stalled while naming a live freighter',
    !(r1?.stalled_since_tick != null && r1?.ship_id === 'ship_ph1' && crew1.length === 0),
    JSON.stringify({ stalled: r1?.stalled_since_tick, ship: r1?.ship_id, crew: crew1.length }));

  // THE JOURNEY THAT WAS BLOCKED: take the ship off, and only then is
  // it free for another lane. One job per hull is the rule, so a
  // composer that OFFERS an employed freighter is offering a move the
  // server will refuse — which is why the client now lists free hulls
  // only.
  await h.addSettlement('st_ph_venus', h.A, `${h.G}:venus`, { metal: 100 });
  const stops2 = [
    { body_id: `${h.G}:venus`, action: 'pickup' },
    { body_id: h.A.capital_body_id, action: 'dropoff' },
  ];
  const busy = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA',
    { stops: stops2, carrier_ship_ids: ['ship_ph1'] });
  check('an EMPLOYED freighter is refused, and says which job it has',
    busy?.error?.code === 'ship_busy', JSON.stringify(busy).slice(0, 160));

  const off = await callRoute(h.env, h.v2, 'DELETE',
    `/api/games/${h.G}/trade-routes/${rid}/ships/ship_ph1`, 'uA', null);
  check('THE SHIP CAN BE TAKEN OFF THE ROUTE', !!off.ok, JSON.stringify(off).slice(0, 160));
  check('...leaving no crew row behind',
    !(await h.crewOf(rid)).some(c => c.ship_id === 'ship_ph1'),
    JSON.stringify(await h.crewOf(rid)));

  // THE RESURRECTION: the tick used to re-crew any route with an empty
  // crew from its own ship_id, which silently put the removed freighter
  // straight back on the next pass.
  await h.tick(3);
  check('the removal STICKS across ticks — the ship stays off',
    !(await h.crewOf(rid)).some(c => c.ship_id === 'ship_ph1'),
    JSON.stringify(await h.crewOf(rid)));

  const freed = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA',
    { stops: stops2, carrier_ship_ids: ['ship_ph1'] });
  check('...and is then free to run a different lane', !!freed.ok,
    JSON.stringify(freed).slice(0, 160));
}

// ============================================================
// 14. THE PROPOSER PINS THE FREIGHTER (Lorne / Orbit Man). Accepting a
//     standing offer must BE the whole transaction — deal struck and
//     lane flying on that hull, both directions, with neither player
//     going back to commission a leg.
// ============================================================
{
  const h = await seed('pin');
  await h.addShip('ship_pinA', h.A, 'freighter', h.A.capital_body_id);
  await h.addSettlement('st_pin_a', h.A, h.A.capital_body_id, { metal: 400, terraform: true });
  await h.addSettlement('st_pin_b', h.B, h.B.capital_body_id, { metal: 400, terraform: true });

  const prop = await callRoute(h.env, h.trades, 'POST', `/api/games/${h.G}/trades`, 'uA', {
    responder_faction_id: h.B.id,
    offer: { metal: 100 }, request: { gold: 50 },
    recurring: true,
    ship_id: 'ship_pinA',
  });
  check('an offer can name the freighter that will fly it', !!prop.trade?.id,
    JSON.stringify(prop).slice(0, 180));

  const acc = await callRoute(h.env, h.trades, 'POST',
    `/api/games/${h.G}/trades/${prop.trade.id}/accept`, 'uB', {});
  check('the offer is accepted', !acc.error, JSON.stringify(acc).slice(0, 160));

  const lane = await h.DB.prepare(
    `SELECT * FROM game_trade_routes WHERE game_id = ? AND cancelled_at_tick IS NULL`).bind(h.G).first();
  check('ACCEPTING STARTED THE RUN — a lane exists with no further clicks',
    !!lane, JSON.stringify(lane));
  check('...on the freighter the proposer pinned',
    lane?.ship_id === 'ship_pinA', String(lane?.ship_id));
  check('...as ONE hull serving both directions',
    lane?.consolidated === 1 && lane?.counterparty_faction_id === h.B.id,
    JSON.stringify({ consolidated: lane?.consolidated, cp: lane?.counterparty_faction_id }));
  const crew = await h.crewOf(lane.id);
  check('...crewed and ready', crew.length === 1 && crew[0].role === 'carrier',
    JSON.stringify(crew));

  // And it actually moves goods, both ways, hands off.
  let sawB = false, sawA = false;
  let bPrev = (await h.pool(h.B)).metal;
  let aPrev = (await h.pool(h.A)).gold;
  for (let i = 0; i < 90 && !(sawB && sawA); i++) {
    await h.tick(1);
    const bNow = (await h.pool(h.B)).metal;
    const aNow = (await h.pool(h.A)).gold;
    if (bNow > bPrev) sawB = true;
    if (aNow > aPrev) sawA = true;
    bPrev = bNow; aPrev = aNow;
  }
  check('goods reach the partner without anyone commissioning a leg', sawB);
  check('and come back the other way on the same hull', sawA);

  // A hull already working cannot be pinned to a second lane.
  const busy = await callRoute(h.env, h.trades, 'POST', `/api/games/${h.G}/trades`, 'uA', {
    responder_faction_id: h.B.id,
    offer: { metal: 10 }, request: { gold: 5 },
    recurring: true,
    ship_id: 'ship_pinA',
  });
  check('an employed freighter is refused at OFFER time, not at acceptance',
    busy?.error?.code === 'ship_busy', JSON.stringify(busy).slice(0, 160));
}

// ============================================================
// 15. A GUARD ON AN AGREEMENT LEG ACTUALLY FLIES (Lorne, live: "the
//     ship I've assigned to guard a route ain't moving and it's still
//     marked idle"). Escort pacing used to live inside the stop walker,
//     so only self-haul and consolidated lanes moved their guards —
//     agreement legs, terraform runs and Dyson supply lines left them
//     parked forever.
// ============================================================
{
  const h = await seed('gl');
  await h.addShip('ship_glA', h.A, 'freighter', h.A.capital_body_id);
  await h.addShip('ship_glB', h.B, 'freighter', h.B.capital_body_id);
  // The guard starts somewhere else entirely — the reported shape: it
  // sat at a body that isn't even on the lane.
  await h.addSettlement('st_gl_mars', h.A, `${h.G}:mars`, { terraform: true });
  await h.addShip('ship_glG', h.A, 'corvette', `${h.G}:mars`, { dmg: 5 });

  const prop = await callRoute(h.env, h.trades, 'POST', `/api/games/${h.G}/trades`, 'uA', {
    responder_faction_id: h.B.id,
    offer: { metal: 100 }, request: { gold: 50 },
    recurring: true,
  });
  await callRoute(h.env, h.trades, 'POST', `/api/games/${h.G}/trades/${prop.trade.id}/accept`, 'uB', {});
  const agId = (await h.DB.prepare('SELECT id FROM trade_agreements WHERE game_id = ?').bind(h.G).first()).id;
  for (const [uid, ship] of [['uA', 'ship_glA'], ['uB', 'ship_glB']]) {
    const opts = await callRoute(h.env, h.trades, 'GET',
      `/api/games/${h.G}/trade-agreements/${agId}/options`, uid, null);
    await callRoute(h.env, h.trades, 'POST',
      `/api/games/${h.G}/trade-agreements/${agId}/commission`, uid,
      { ship_id: ship, dest_body_id: opts.targets[0].body_id });
  }
  const leg = await h.DB.prepare(
    `SELECT id FROM game_trade_routes WHERE agreement_id = ? AND ship_id = 'ship_glA'`).bind(agId).first();

  const before = (await h.DB.prepare(
    "SELECT parent_body_id FROM game_ships WHERE id = 'ship_glG'").first()).parent_body_id;
  const add = await callRoute(h.env, h.v2, 'POST',
    `/api/games/${h.G}/trade-routes/${leg.id}/ships`, 'uA',
    { role: 'guard', ship_id: 'ship_glG' });
  check('guard assigned to an agreement leg', !!add.ok, JSON.stringify(add).slice(0, 140));

  const flew = await until(h, async () => {
    const legs = (await h.DB.prepare(
      "SELECT COUNT(*) n FROM game_ship_nodes WHERE ship_id = 'ship_glG'").first()).n;
    return legs > 0;
  }, 8);
  check('THE GUARD IS GIVEN A LEG — it does not sit there forever', flew,
    `nodes=${(await h.DB.prepare("SELECT COUNT(*) n FROM game_ship_nodes WHERE ship_id = 'ship_glG'").first()).n}`);

  const moved = await until(h, async () => {
    const now = (await h.DB.prepare(
      "SELECT parent_body_id FROM game_ships WHERE id = 'ship_glG'").first()).parent_body_id;
    return now !== before;
  }, 40);
  const after = (await h.DB.prepare(
    "SELECT parent_body_id FROM game_ships WHERE id = 'ship_glG'").first()).parent_body_id;
  check('...and actually arrives somewhere new', moved, `${before} -> ${after}`);

  // It should end up WITH its ward, not wandering on its own.
  const together = await until(h, async () => {
    const g = (await h.DB.prepare("SELECT parent_body_id FROM game_ships WHERE id = 'ship_glG'").first()).parent_body_id;
    const w = (await h.DB.prepare("SELECT parent_body_id FROM game_ships WHERE id = 'ship_glA'").first()).parent_body_id;
    const gFly = await h.DB.prepare("SELECT 1 x FROM game_ship_nodes WHERE ship_id='ship_glG' AND status IN ('committed','in_transit') LIMIT 1").first();
    return !gFly && g === w;
  }, 40);
  check('...and ends up where its ward is', together);

  const crew = await h.crewOf(leg.id);
  check("the guard follows the leg's pinned freighter",
    crew.some(c => c.role === 'guard' && c.follow_ship_id === 'ship_glA'),
    JSON.stringify(crew));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
