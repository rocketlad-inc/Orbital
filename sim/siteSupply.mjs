// ============================================================
// SITE SUPPLY — a standing route that feeds a megastructure.
//
// The rule (Lorne): a supply run to a megastructure picks up at a
// TERRAFORMED world and delivers to the site. The treasury is only
// physically reachable at a dock, and a dock world's settlement
// stockpile is always empty — production at a terraformed world banks
// straight into the pool. So the pickup has to draw on the pool, or the
// freighter flies empty forever.
//
// That is exactly what prod was doing: five live supply routes, 32 to
// 86 completed loops each, every site meter still at zero, every hull
// empty. The route walker loaded pickups only from settlement
// stockpiles; the legacy megastructure route kind (which drew from the
// pool) had been superseded by the multi-stop composer without the
// rule coming along.
//
// Driven end to end through the REAL code: the v2 composer endpoints
// and room.js resolveTick.
//
// Run: node sim/siteSupply.mjs
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

async function seed(tag) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
  };
  const G = `gsite${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Site Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','site-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();

  const [A, B] = (await DB.prepare(
    `SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`)
    .bind(G).all()).results;

  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  await DB.prepare(`UPDATE game_factions SET metal = 5000, fuel = 0, gold = 5000, science = 0 WHERE game_id = ?`)
    .bind(G).run();
  // Flat economy, so the only thing moving the site meter is the route.
  await DB.prepare(
    `UPDATE game_bodies SET yield_metal = 0, yield_gold = 0, yield_science = 0 WHERE game_id = ?`,
  ).bind(G).run();

  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};
  const v2 = (await import('../worker/tradeRoutesV2.js')).routes;

  let tickNow = 0;
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      tickNow += 1;
      await room.resolveTick(G, tickNow);
      await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run();
    }
  };

  const addShip = async (id, faction, bodyId) => {
    await DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
       VALUES (?, ?, ?, ?, 'freighter', ?, 2, 2, 0, 0, 0, 1,
               999, 999, 'active', 0, 60, 60, 0)`,
    ).bind(id, G, faction.id, `Ship ${id}`, bodyId).run();
  };

  // A construction site orbiting the capital's planet, built the way
  // room.js places one: a megastructure body row plus its meter.
  const addSite = async (owner, parentBodyId, opts = {}) => {
    const id = `${G}:mega_${tag}${Math.random().toString(36).slice(2, 6)}`;
    await DB.prepare(
      `INSERT INTO game_bodies
         (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
          orbit_radius, orbit_period, angle0, color, owner_faction_id)
       VALUES (?, ?, 'mega_weapons_station', ?, 'megastructure', ?, 1.2, 0, 1, 6, 40, 0, '#ff8a6b', ?)`,
    ).bind(id, G, opts.name ?? 'Test Station', parentBodyId, owner.id).run();
    await DB.prepare(
      `INSERT INTO game_megastructures
         (body_id, game_id, kind, status, acc_metal, acc_credits,
          cost_metal, cost_credits, founded_by_faction_id, founded_at_tick, hp)
       VALUES (?, ?, 'weapons_station', 'building', ?, ?, ?, ?, ?, 0, 3000)`,
    ).bind(id, G, opts.accMetal ?? 0, opts.accCredits ?? 0,
           opts.costMetal ?? 7000, opts.costCredits ?? 5000, owner.id).run();
    return id;
  };

  const site = (id) => DB.prepare(
    'SELECT acc_metal, acc_credits, status FROM game_megastructures WHERE body_id = ?').bind(id).first();
  const pool = (f) => DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(f.id).first();
  const crew = (shipId) => DB.prepare(
    'SELECT * FROM game_trade_route_ships WHERE ship_id = ?').bind(shipId).first();

  return { env, DB, G, A, B, v2, tick, addShip, addSite, site, pool, crew };
}

const until = async (h, fn, limit = 80) => {
  for (let i = 0; i < limit; i++) {
    if (await fn()) return true;
    await h.tick(1);
  }
  return await fn();
};

const createRoute = (h, stops, carriers, user = 'uA') =>
  callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, user,
    { name: 'Supply', stops, carrier_ship_ids: carriers });

// ============================================================
// 1. THE PROD SHAPE: pick up at the terraformed capital, deliver to a
//    site. The meter must actually fill.
// ============================================================
{
  const h = await seed('pr');
  const dock = h.A.capital_body_id;
  const siteId = await h.addSite(h.A, dock);
  await h.addShip('ship_pr1', h.A, dock);

  const dockStock = await h.DB.prepare(
    `SELECT COALESCE(SUM(stockpile_metal),0) AS m FROM game_settlements
      WHERE game_id = ? AND body_id = ?`).bind(h.G, dock).first();
  check('precondition: the dock world\'s stockpile is empty (as on prod)',
    Number(dockStock.m) === 0, JSON.stringify(dockStock));

  const stops = [
    { body_id: dock, action: 'pickup' },
    { body_id: siteId, action: 'dropoff' },
  ];
  const proj = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/project`, 'uA',
    { stops, ship_id: 'ship_pr1' });
  check('projection answers', !!proj.ok, JSON.stringify(proj).slice(0, 160));

  const res = await createRoute(h, stops, ['ship_pr1']);
  check('supply route is accepted', !!res.ok, JSON.stringify(res).slice(0, 200));

  const filled = await until(h, async () => Number((await h.site(siteId)).acc_metal) > 0);
  const s = await h.site(siteId);
  check('the site meter FILLS — metal arrives', filled && Number(s.acc_metal) > 0, JSON.stringify(s));
  check('…and credits arrive too', Number(s.acc_credits) > 0, JSON.stringify(s));
  // The hold is 400 times the captain's cargo trait — and the tick can
  // seat a captain on an idle hull mid-run, so read who is aboard NOW
  // rather than assuming the bare 400.
  const cap = await h.DB.prepare(
    `SELECT c.traits_json FROM game_ships s LEFT JOIN game_captains c ON c.id = s.captain_id
      WHERE s.id = 'ship_pr1'`).first();
  const { holdCapFor } = await import('../worker/routeMath.js');
  const hold = holdCapFor(cap?.traits_json ?? null);
  console.log(`        (captain traits aboard: ${cap?.traits_json ?? 'none'} -> hold ${hold})`);
  check('one full hold per resource per trip',
    Number(s.acc_metal) === hold && Number(s.acc_credits) === hold, `${JSON.stringify(s)} hold=${hold}`);

  // Re-project with the SAME crew the tick just flew with. The site
  // still needs far more than a hold, so one more loop should deliver
  // exactly what the first one did.
  const proj2 = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/project`, 'uA',
    { stops, ship_id: 'ship_pr1' });
  const p = proj2.projection?.delivered ?? {};
  check('the composer gauge projects exactly what the tick delivers',
    Number(p.metal) === Number(s.acc_metal) && Number(p.gold) === Number(s.acc_credits),
    `projected ${p.metal}M/${p.gold}C, delivered ${s.acc_metal}M/${s.acc_credits}C`);

  const pl = await h.pool(h.A);
  check('the treasury is never driven negative', Number(pl.metal) >= 0 && Number(pl.gold) >= 0, JSON.stringify(pl));
}

// ============================================================
// 2. A NEARLY FINISHED SITE takes only what it still needs — no full
//    hold of treasury dragged across the system for the last 150 metal.
// ============================================================
{
  const h = await seed('nf');
  const dock = h.A.capital_body_id;
  const siteId = await h.addSite(h.A, dock, { accMetal: 6850, accCredits: 5000 });
  await h.addShip('ship_nf1', h.A, dock);
  const res = await createRoute(h, [
    { body_id: dock, action: 'pickup' },
    { body_id: siteId, action: 'dropoff' },
  ], ['ship_nf1']);
  check('near-finished: route accepted', !!res.ok, JSON.stringify(res).slice(0, 200));
  // Measured in the HOLD, not the pool: ship upkeep drains the pool
  // every tick, so a pool delta is draw plus upkeep. The hold moves for
  // exactly one reason.
  let maxM = 0, maxG = 0;
  await until(h, async () => {
    const c = await h.crew('ship_nf1');
    if (c) { maxM = Math.max(maxM, Number(c.cargo_metal)); maxG = Math.max(maxG, Number(c.cargo_gold)); }
    return (await h.site(siteId)).status === 'complete';
  });
  const s = await h.site(siteId);
  check('near-finished: the site completes', s.status === 'complete', JSON.stringify(s));
  check('near-finished: loaded 150 metal, not a 400 hold', maxM === 150, `max metal aboard ${maxM}`);
  check('near-finished: credits already met — none loaded', maxG === 0, `max credits aboard ${maxG}`);
}

// ============================================================
// 3. AN EMPTY TREASURY cannot go negative and cannot conjure cargo.
// ============================================================
{
  const h = await seed('et');
  const dock = h.A.capital_body_id;
  const siteId = await h.addSite(h.A, dock);
  await h.addShip('ship_et1', h.A, dock);
  const res = await createRoute(h, [
    { body_id: dock, action: 'pickup' },
    { body_id: siteId, action: 'dropoff' },
  ], ['ship_et1']);
  check('empty treasury: route accepted', !!res.ok, JSON.stringify(res).slice(0, 200));
  await h.DB.prepare('UPDATE game_factions SET metal = 120, gold = 0 WHERE id = ?').bind(h.A.id).run();
  await h.tick(30);
  const s = await h.site(siteId);
  const pl = await h.pool(h.A);
  check('empty treasury: pool never negative', Number(pl.metal) >= 0 && Number(pl.gold) >= 0, JSON.stringify(pl));
  check('empty treasury: site got at most what existed', Number(s.acc_metal) <= 120 && Number(s.acc_credits) === 0,
    JSON.stringify(s));
}

// ============================================================
// 4. AN ORDINARY DOCK-TO-DOCK ROUTE does not touch the treasury. The
//    pool draw is for construction supply only.
// ============================================================
{
  const h = await seed('dd');
  const dock = h.A.capital_body_id;
  await h.DB.prepare(
    `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
       hp, hp_max, population, surface_angle, created_at_tick)
     VALUES ('st_dd_mars', ?, ?, ?, 'station', 'Mars Dock', 100, 100, 1, 0, 0)`,
  ).bind(h.G, `${h.G}:mars`, h.A.id).run();
  await h.DB.prepare(
    'UPDATE game_bodies SET terraformed_at_tick = 0, owner_faction_id = ? WHERE id = ?',
  ).bind(h.A.id, `${h.G}:mars`).run();
  await h.addShip('ship_dd1', h.A, dock);
  const res = await createRoute(h, [
    { body_id: dock, action: 'pickup' },
    { body_id: `${h.G}:mars`, action: 'dropoff' },
  ], ['ship_dd1']);
  check('dock-to-dock: route accepted', !!res.ok, JSON.stringify(res).slice(0, 200));
  let maxAboard = 0;
  for (let i = 0; i < 40; i++) {
    await h.tick(1);
    const c = await h.crew('ship_dd1');
    if (c) maxAboard = Math.max(maxAboard, Number(c.cargo_metal), Number(c.cargo_gold));
  }
  check('dock-to-dock: the freighter never loaded treasury money', maxAboard === 0, `max aboard ${maxAboard}`);
}

// ============================================================
// 5. A SITE THAT CHANGED HANDS after the route was laid: no draw. Your
//    treasury is not poured into a hull bound for somebody else's gate.
// ============================================================
{
  const h = await seed('ch');
  const dock = h.A.capital_body_id;
  const siteId = await h.addSite(h.A, dock);
  await h.addShip('ship_ch1', h.A, dock);
  const res = await createRoute(h, [
    { body_id: dock, action: 'pickup' },
    { body_id: siteId, action: 'dropoff' },
  ], ['ship_ch1']);
  check('captured: route accepted while still ours', !!res.ok, JSON.stringify(res).slice(0, 200));
  await h.DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(h.B.id, siteId).run();
  let maxAboard = 0;
  for (let i = 0; i < 30; i++) {
    await h.tick(1);
    const c = await h.crew('ship_ch1');
    if (c) maxAboard = Math.max(maxAboard, Number(c.cargo_metal), Number(c.cargo_gold));
  }
  check('captured: no treasury ever drawn into the hold', maxAboard === 0, `max aboard ${maxAboard}`);
}

// ============================================================
// 6. TWO FREIGHTERS on one route share the site's remaining need — they
//    do not each haul a full hold toward a site that wants 500 total.
// ============================================================
{
  const h = await seed('tc');
  const dock = h.A.capital_body_id;
  const siteId = await h.addSite(h.A, dock, { accMetal: 6500, accCredits: 5000 });
  await h.addShip('ship_tc1', h.A, dock);
  await h.addShip('ship_tc2', h.A, dock);
  const res = await createRoute(h, [
    { body_id: dock, action: 'pickup' },
    { body_id: siteId, action: 'dropoff' },
  ], ['ship_tc1']);
  check('two carriers: route accepted', !!res.ok, JSON.stringify(res).slice(0, 200));
  // Sign the second hull on directly — the carrier-cap research ladder
  // is not what this case is about.
  await h.DB.prepare(
    `INSERT INTO game_trade_route_ships
       (id, game_id, route_id, ship_id, role, next_stop_seq,
        cargo_fuel, cargo_metal, cargo_gold, cargo_science, added_at_tick)
     VALUES (?, ?, ?, 'ship_tc2', 'carrier', 0, 0, 0, 0, 0, 0)`,
  ).bind(`${res.route.id}:c1`, h.G, res.route.id).run();
  let maxCommitted = 0;
  for (let i = 0; i < 25; i++) {
    await h.tick(1);
    const c1 = await h.crew('ship_tc1');
    const c2 = await h.crew('ship_tc2');
    const s = await h.site(siteId);
    maxCommitted = Math.max(maxCommitted,
      Number(c1?.cargo_metal ?? 0) + Number(c2?.cargo_metal ?? 0) + Number(s.acc_metal) - 6500);
  }
  const s = await h.site(siteId);
  check('two carriers: hulls plus meter never exceed the 500 still needed',
    maxCommitted <= 500, `max committed ${maxCommitted}`);
  check('two carriers: the site still gets its 500', Number(s.acc_metal) === 7000, JSON.stringify(s));
}

console.log(bad === 0 ? '\nALL SITE-SUPPLY CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
