// ============================================================
// ROUTE HANDOFF — what happens to a freighter's cargo and its job when
// a route ends or is replaced.
//
// Three player reports, one cluster of code:
//   - "assigned a loaded freighter to a new route and it deleted
//     everything in the cargo hold" — the two-stop create cancelled the
//     old route and dropped its crew rows, and on a walker route the
//     crew row IS the cargo.
//   - "one of my freighters can't be assigned to any routes because the
//     game thinks it's already running one" — the legacy retire paths
//     ended the route and left the crew row behind, and the busy check
//     did not care whether the route was live.
//   - a terraform run that arrived with cargo aboard was sent on
//     without topping up, and a fresh load overwrote the hold.
//
// Driven end to end through the REAL code: the legacy two-stop create in
// actions.js, the v2 endpoints, and room.js resolveTick.
//
// Run: node sim/routeHandoff.mjs
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
  const G = `ghand${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Handoff Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','hand-seed',0,3600000,0,0)`).bind(G).run();
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
  await DB.prepare(
    `UPDATE game_bodies SET yield_metal = 0, yield_gold = 0, yield_science = 0 WHERE game_id = ?`,
  ).bind(G).run();

  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};
  const v2 = (await import('../worker/tradeRoutesV2.js')).routes;
  const legacy = (await import('../worker/actions.js')).routes;

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
  const addSettlement = async (id, faction, bodyId, opts = {}) => {
    await DB.prepare(
      `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
         hp, hp_max, population, surface_angle, created_at_tick,
         stockpile_metal, stockpile_gold, stockpile_science)
       VALUES (?, ?, ?, ?, 'station', ?, 100, 100, 1, 0, 0, ?, ?, ?)`,
    ).bind(id, G, bodyId, faction.id, id, opts.metal ?? 0, opts.gold ?? 0, opts.science ?? 0).run();
    await DB.prepare(
      `UPDATE game_bodies SET owner_faction_id = ?${opts.terraform ? ', terraformed_at_tick = 0' : ''}
        WHERE id = ? AND game_id = ?`,
    ).bind(faction.id, bodyId, G).run();
  };
  const addSite = async (owner, parentBodyId, opts = {}) => {
    const id = `${G}:mega_${tag}${Math.random().toString(36).slice(2, 6)}`;
    await DB.prepare(
      `INSERT INTO game_bodies
         (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
          orbit_radius, orbit_period, angle0, color, owner_faction_id)
       VALUES (?, ?, 'mega_weapons_station', 'Test Station', 'megastructure', ?, 1.2, 0, 1, 6, 40, 0, '#ff8a6b', ?)`,
    ).bind(id, G, parentBodyId, owner.id).run();
    await DB.prepare(
      `INSERT INTO game_megastructures
         (body_id, game_id, kind, status, acc_metal, acc_credits,
          cost_metal, cost_credits, founded_by_faction_id, founded_at_tick, hp)
       VALUES (?, ?, 'weapons_station', 'building', ?, ?, ?, ?, ?, 0, 3000)`,
    ).bind(id, G, opts.accMetal ?? 0, opts.accCredits ?? 0,
           opts.costMetal ?? 7000, opts.costCredits ?? 5000, owner.id).run();
    return id;
  };

  const crew = (shipId) => DB.prepare(
    'SELECT c.*, r.cancelled_at_tick FROM game_trade_route_ships c JOIN game_trade_routes r ON r.id = c.route_id WHERE c.ship_id = ?')
    .bind(shipId).all().then(x => x.results ?? []);
  const route = (id) => DB.prepare('SELECT * FROM game_trade_routes WHERE id = ?').bind(id).first();
  const ship = (id) => DB.prepare('SELECT * FROM game_ships WHERE id = ?').bind(id).first();
  const pool = (f) => DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(f.id).first();
  const freeFreighters = () => callRoute(env, v2, 'GET', `/api/games/${G}/free-freighters`, 'uA', {});

  return { env, DB, G, A, B, v2, legacy, tick, addShip, addSettlement, addSite,
           crew, route, ship, pool, freeFreighters };
}

const until = async (h, fn, limit = 80) => {
  for (let i = 0; i < limit; i++) {
    if (await fn()) return true;
    await h.tick(1);
  }
  return await fn();
};

const legacyCreate = (h, shipId, origin, dest) =>
  callRoute(h.env, h.legacy, 'POST', `/api/games/${h.G}/trade-routes`, 'uA',
    { ship_id: shipId, origin_body_id: origin, dest_body_id: dest });

// ============================================================
// 1. REPLACING A LOADED ROUTE KEEPS THE CARGO. A freighter mid-run with
//    120M/40C aboard gets a new two-stop route; the new route must open
//    with exactly that load.
// ============================================================
{
  const h = await seed('rp');
  const dock = h.A.capital_body_id;
  await h.addSettlement('st_rp_mars', h.A, `${h.G}:mars`, { metal: 120, gold: 40 });   // raw: pickup only
  await h.addSettlement('st_rp_venus', h.A, `${h.G}:venus`, { terraform: true });        // a second dock
  await h.addShip('ship_rp1', h.A, `${h.G}:mars`);
  const res = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, 'uA', {
    name: 'Old Run',
    stops: [{ body_id: `${h.G}:mars`, action: 'pickup' }, { body_id: dock, action: 'dropoff' }],
    carrier_ship_ids: ['ship_rp1'],
  });
  check('replace: old route accepted', !!res.ok, JSON.stringify(res).slice(0, 160));
  const oldId = res.route.id;
  const loaded = await until(h, async () => {
    const [c] = await h.crew('ship_rp1');
    return c && Number(c.cargo_metal) === 120 && Number(c.cargo_gold) === 40;
  }, 20);
  check('replace: freighter loaded 120M/40C on the old run', loaded, JSON.stringify(await h.crew('ship_rp1')));

  const rep = await legacyCreate(h, 'ship_rp1', dock, `${h.G}:venus`);
  check('replace: new two-stop route accepted', !!rep.ok, JSON.stringify(rep).slice(0, 200));
  const rows = await h.crew('ship_rp1');
  const live = rows.filter(c => c.cancelled_at_tick == null);
  check('replace: exactly one live crew row', live.length === 1 && rows.length === 1, JSON.stringify(rows));
  check('replace: the new route OPENS WITH THE CARGO — 120M/40C, nothing lost',
    live[0] && Number(live[0].cargo_metal) === 120 && Number(live[0].cargo_gold) === 40,
    JSON.stringify(live[0]));
  const old = await h.route(oldId);
  check('replace: old route is cancelled and its row is zeroed',
    old.cancelled_at_tick != null && Number(old.cargo_metal) === 0 && Number(old.cargo_gold) === 0,
    JSON.stringify({ c: old.cancelled_at_tick, m: old.cargo_metal, g: old.cargo_gold }));
  const s = await h.ship('ship_rp1');
  check('replace: the hull itself holds nothing (cargo lives on the route)',
    Number(s.cargo_metal) === 0 && Number(s.cargo_gold) === 0, JSON.stringify({ m: s.cargo_metal, g: s.cargo_gold }));
  // And the cargo actually reaches the new destination.
  const delivered = await until(h, async () => Number((await h.ship('ship_rp1')).trades_completed ?? 0) >= 1, 60);
  check('replace: the carried-over load is delivered on the new route', delivered);
}

// ============================================================
// 2. A FINISHED TERRAFORM RUN FREES ITS FREIGHTER. When the world's
//    meter fills, the route retires AND the crew row goes with it — so
//    the ship is assignable again (Peddler).
// ============================================================
{
  const h = await seed('tf');
  const dock = h.A.capital_body_id;
  await h.addSettlement('st_tf_mars', h.A, `${h.G}:mars`);   // raw, mine: a terraform target
  await h.addShip('ship_tf1', h.A, dock);
  const res = await legacyCreate(h, 'ship_tf1', dock, `${h.G}:mars`);
  check('terraform: route accepted', !!res.ok, JSON.stringify(res).slice(0, 200));
  check('terraform: kind is terraform', (await h.route(res.route.id)).kind === 'terraform');
  const retired = await until(h, async () => (await h.route(res.route.id)).cancelled_at_tick != null, 60);
  check('terraform: route retires once the payload is delivered', retired);
  check('terraform: NO crew row survives the retire', (await h.crew('ship_tf1')).length === 0,
    JSON.stringify(await h.crew('ship_tf1')));
  const free = await h.freeFreighters();
  check('terraform: the freighter is listed as free again',
    !!free.ok && (free.freighters ?? []).some(f => f.id === 'ship_tf1'), JSON.stringify(free).slice(0, 200));
  const again = await legacyCreate(h, 'ship_tf1', dock, dock === `${h.G}:earth` ? `${h.G}:luna` : `${h.G}:earth`);
  check('terraform: it can be put on another route (no "already running another route")',
    !!again.ok || again.error?.code !== 'ship_busy', JSON.stringify(again).slice(0, 160));
}

// ============================================================
// 3. TOP-UP AT THE DOCK. A terraform freighter sitting at the dock with
//    50M/50C (and 7 fuel) already aboard fills to the need; nothing
//    aboard is overwritten.
// ============================================================
{
  const h = await seed('tu');
  const dock = h.A.capital_body_id;
  await h.addSettlement('st_tu_mars', h.A, `${h.G}:mars`);
  await h.addShip('ship_tu1', h.A, dock);
  const res = await legacyCreate(h, 'ship_tu1', dock, `${h.G}:mars`);
  check('top-up: route accepted', !!res.ok, JSON.stringify(res).slice(0, 200));
  // Simulate a hold folded in from an earlier route: partly loaded, at
  // the dock, not yet dispatched.
  await h.DB.prepare(
    `UPDATE game_trade_routes SET cargo_fuel = 7, cargo_metal = 50, cargo_gold = 50, status = 'returning' WHERE id = ?`,
  ).bind(res.route.id).run();
  await h.DB.prepare(`UPDATE game_ship_nodes SET status = 'cancelled' WHERE ship_id = 'ship_tu1'`).run();
  await h.DB.prepare(`UPDATE game_ships SET parent_body_id = ? WHERE id = 'ship_tu1'`).bind(dock).run();
  await h.tick(1);
  const r = await h.route(res.route.id);
  check('top-up: metal topped up to the 124 the world needs (50 aboard + 74 drawn)',
    Number(r.cargo_metal) === 124, `cargo_metal=${r.cargo_metal}`);
  check('top-up: credits likewise', Number(r.cargo_gold) === 124, `cargo_gold=${r.cargo_gold}`);
  check('top-up: the 7 fuel already aboard was NOT wiped', Number(r.cargo_fuel) === 7, `cargo_fuel=${r.cargo_fuel}`);
  const done = await until(h, async () => {
    const b = await h.DB.prepare('SELECT terraform_completes_at_tick FROM game_bodies WHERE id = ?')
      .bind(`${h.G}:mars`).first();
    return b?.terraform_completes_at_tick != null;
  }, 60);
  check('top-up: the world gets its full payload in one trip', done);
}

// ============================================================
// 4. LEGACY MEGASTRUCTURE RUN: actually ends when the site completes,
//    frees the crew, and never debits a treasury it cannot cover.
// ============================================================
{
  const h = await seed('mg');
  const dock = h.A.capital_body_id;
  const siteId = await h.addSite(h.A, dock, { costMetal: 300, costCredits: 300 });
  await h.addShip('ship_mg1', h.A, dock);
  await h.DB.prepare('UPDATE game_factions SET metal = 120, gold = 5000 WHERE id = ?').bind(h.A.id).run();
  const res = await legacyCreate(h, 'ship_mg1', dock, siteId);
  check('mega: route accepted', !!res.ok, JSON.stringify(res).slice(0, 200));
  check('mega: kind is megastructure', (await h.route(res.route.id)).kind === 'megastructure');
  await h.tick(1);
  const r1 = await h.route(res.route.id);
  const p1 = await h.pool(h.A);
  check('mega: loads only what the treasury has — 120 metal, not 300', Number(r1.cargo_metal) === 120,
    `cargo_metal=${r1.cargo_metal}`);
  check('mega: treasury never negative', Number(p1.metal) >= 0 && Number(p1.gold) >= 0, JSON.stringify(p1));
  await h.DB.prepare('UPDATE game_factions SET metal = 5000 WHERE id = ?').bind(h.A.id).run();
  const complete = await until(h, async () =>
    (await h.DB.prepare('SELECT status FROM game_megastructures WHERE body_id = ?').bind(siteId).first())?.status === 'complete', 80);
  check('mega: the site completes', complete);
  const ended = await until(h, async () => (await h.route(res.route.id)).cancelled_at_tick != null, 10);
  check('mega: the route ENDS (cancelled_at_tick set, not just status)', ended,
    JSON.stringify(await h.route(res.route.id)));
  check('mega: crew freed', (await h.crew('ship_mg1')).length === 0);
}

console.log(bad === 0 ? '\nALL ROUTE-HANDOFF CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
