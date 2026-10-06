// ============================================================
// SUN ROUTES — the Dyson Sphere fed by multi-freighter routes.
//
// Crimson_Song (Discord), 2026-10-04: "it wants me to do it manually for
// every freighter too. i can't add them to the route so i got a buncha
// individual routes." The legacy dyson route flies ONE pinned freighter;
// on prod one player was running 34 of them. The Sun is now a drop-off
// stop on the ordinary route walker, which crews up to the Convoy cap.
//
// Driven end to end through the REAL code: the v2 route endpoints and
// room.js resolveTick (which also runs the sphere's own reconcile, so a
// broken fixture shows up as a collapse, not as a pass).
//
// Run: npm run sim:dyson
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

const TARGET = 20000;

async function seed(tag, { need = TARGET } = {}) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
  };
  const G = `gdys${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Dyson Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','dys-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  // Research gating off: the Convoy techs that raise the freighters-per-
  // route cap are not what this sim is about.
  await DB.prepare("UPDATE games SET status='active', gating_enabled = 0 WHERE id = ?").bind(G).run();

  const [A, B] = (await DB.prepare(
    `SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`)
    .bind(G).all()).results;

  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  await DB.prepare(`UPDATE game_factions SET metal = 5000, fuel = 0, gold = 5000, science = 5000 WHERE game_id = ?`)
    .bind(G).run();
  await DB.prepare(
    `UPDATE game_bodies SET yield_metal = 0, yield_gold = 0, yield_science = 0 WHERE game_id = ?`,
  ).bind(G).run();

  // A's sphere: a foundation station at the Sun, and the meters.
  const SOL = `${G}:sol`;
  {
    const src = await DB.prepare('SELECT id FROM game_settlements WHERE game_id = ? AND owner_faction_id = ? LIMIT 1')
      .bind(G, A.id).first();
    const cols = (await DB.prepare('PRAGMA table_info(game_settlements)').all()).results.map(x => x.name);
    const over = { id: "'st_found'", body_id: `'${SOL}'`, type: "'station'", destroyed_at_tick: 'NULL' };
    await DB.prepare(`INSERT INTO game_settlements (${cols.join(', ')})
                      SELECT ${cols.map(c => over[c] ?? c).join(', ')} FROM game_settlements WHERE id = ?`).bind(src.id).run();
  }
  const acc = TARGET - need;
  await DB.prepare(
    `UPDATE games SET dyson_controller_faction_id = ?, dyson_foundation_settlement_id = 'st_found',
            dyson_target_fuel = 0, dyson_target_ore = ?, dyson_target_credits = ?, dyson_target_science = ?,
            dyson_acc_fuel = 0, dyson_acc_ore = ?, dyson_acc_credits = ?, dyson_acc_science = ?,
            dyson_max_hp = ?, dyson_hp = ?
      WHERE id = ?`,
  ).bind(A.id, TARGET, TARGET, TARGET, acc, acc, acc, TARGET * 3, acc * 3, G).run();

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
  const sphere = () => DB.prepare(
    `SELECT dyson_controller_faction_id AS ctrl, dyson_acc_ore AS m, dyson_acc_credits AS g,
            dyson_acc_science AS s FROM games WHERE id = ?`).bind(G).first();
  const pool = (f) => DB.prepare('SELECT metal, gold, science FROM game_factions WHERE id = ?').bind(f.id).first();
  return { env, DB, G, A, B, SOL, v2, tick, addShip, sphere, pool };
}

const until = async (h, fn, limit = 120) => {
  for (let i = 0; i < limit; i++) {
    if (await fn()) return true;
    await h.tick(1);
  }
  return await fn();
};
const createRoute = (h, stops, carriers, user = 'uA') =>
  callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/full`, user,
    { name: 'Sun run', stops, carrier_ship_ids: carriers });

// ------------------------------------------------------------------
// 1. Two freighters on ONE route feed the sphere: metal, credits AND
//    science, drawn from the treasury at the dock.
// ------------------------------------------------------------------
{
  const h = await seed('two');
  const dock = h.A.capital_body_id;
  await h.addShip('ship_fr1', h.A, dock);
  await h.addShip('ship_fr2', h.A, dock);
  const stops = [{ body_id: dock, action: 'pickup' }, { body_id: h.SOL, action: 'dropoff' }];
  const res = await createRoute(h, stops, ['ship_fr1', 'ship_fr2']);
  check('a route to the Sun with two freighters is accepted', !!res.ok, JSON.stringify(res).slice(0, 240));
  const routeId = res.route?.id ?? res.route_id ?? res.id;
  const before = await h.pool(h.A);
  const fed = await until(h, async () => Number((await h.sphere()).m) > 0);
  const s = await h.sphere();
  check('the sphere fills from the route', fed && Number(s.m) > 0, JSON.stringify(s));
  check('credits and science arrive too', Number(s.g) > 0 && Number(s.s) > 0, JSON.stringify(s));
  // Keep going until both hulls have delivered at least once.
  await until(h, async () => {
    const rows = (await h.DB.prepare(`SELECT trades_completed AS t FROM game_ships WHERE id IN ('ship_fr1','ship_fr2')`).all()).results;
    return rows.every(r => Number(r.t) > 0);
  });
  const rows = (await h.DB.prepare(`SELECT id, trades_completed AS t FROM game_ships WHERE id IN ('ship_fr1','ship_fr2')`).all()).results;
  check('BOTH freighters delivered to the sphere', rows.length === 2 && rows.every(r => Number(r.t) > 0), JSON.stringify(rows));
  const after = await h.pool(h.A);
  const s2 = await h.sphere();
  check('what the sphere gained came out of the treasury, nothing more',
    Number(before.metal) - Number(after.metal) >= Number(s2.m)
      && Number(before.science) - Number(after.science) >= Number(s2.s),
    JSON.stringify({ before, after, s2 }));
  check('the treasury never went negative',
    Number(after.metal) >= 0 && Number(after.gold) >= 0 && Number(after.science) >= 0, JSON.stringify(after));
  check('the sphere is still standing (its own tick did not collapse it)', s2.ctrl === h.A.id, JSON.stringify(s2));

  // A third freighter joins the SAME route.
  await h.addShip('ship_fr3', h.A, dock);
  if (routeId) {
    const add = await callRoute(h.env, h.v2, 'POST', `/api/games/${h.G}/trade-routes/${routeId}/ships`, 'uA',
      { ship_id: 'ship_fr3', role: 'carrier' });
    check('another freighter can be added to a Sun route', !!add.ok, JSON.stringify(add).slice(0, 240));
  } else {
    check('another freighter can be added to a Sun route', false, `no route id in ${JSON.stringify(res).slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------
// 2. Only the sphere's builder may feed it, and only as a drop-off.
// ------------------------------------------------------------------
{
  const h = await seed('rule');
  await h.addShip('ship_frB', h.B, h.B.capital_body_id);
  const rival = await createRoute(h, [
    { body_id: h.B.capital_body_id, action: 'pickup' }, { body_id: h.SOL, action: 'dropoff' },
  ], ['ship_frB'], 'uB');
  check('a rival cannot lay a route into your sphere', rival.error?.code === 'not_dyson_builder', JSON.stringify(rival));
  await h.addShip('ship_frA', h.A, h.A.capital_body_id);
  const pick = await createRoute(h, [
    { body_id: h.SOL, action: 'pickup' }, { body_id: h.A.capital_body_id, action: 'dropoff' },
  ], ['ship_frA']);
  check('nothing is picked up at the Sun', pick.error?.code === 'sol_dropoff_only', JSON.stringify(pick));
}

// ------------------------------------------------------------------
// 3. Nearly finished: the last 150 of each, no overshoot, no waste.
// ------------------------------------------------------------------
{
  const h = await seed('nf', { need: 150 });
  const dock = h.A.capital_body_id;
  await h.addShip('ship_nf1', h.A, dock);
  await h.addShip('ship_nf2', h.A, dock);
  const before = await h.pool(h.A);
  const res = await createRoute(h, [{ body_id: dock, action: 'pickup' }, { body_id: h.SOL, action: 'dropoff' }], ['ship_nf1', 'ship_nf2']);
  check('route accepted (near-finished sphere)', !!res.ok, JSON.stringify(res).slice(0, 200));
  await until(h, async () => Number((await h.sphere()).m) >= TARGET);
  await h.tick(10);
  const s = await h.sphere();
  const after = await h.pool(h.A);
  check('the sphere reaches its target exactly — never past it',
    Number(s.m) === TARGET && Number(s.g) === TARGET && Number(s.s) === TARGET, JSON.stringify(s));
  // Science, because ship upkeep also bills metal and credits every tick.
  check('two freighters drew only what was needed (150), not two holds',
    Number(before.science) - Number(after.science) === 150,
    JSON.stringify({ before, after }));
}

// ------------------------------------------------------------------
// 4. The sphere changes hands: the route parks with the cargo aboard.
// ------------------------------------------------------------------
{
  const h = await seed('lost');
  const dock = h.A.capital_body_id;
  await h.addShip('ship_ls1', h.A, dock);
  const res = await createRoute(h, [{ body_id: dock, action: 'pickup' }, { body_id: h.SOL, action: 'dropoff' }], ['ship_ls1']);
  check('route accepted (to be lost)', !!res.ok, JSON.stringify(res).slice(0, 200));
  // Load at the dock, then lose the sphere while the hull is outbound.
  await until(h, async () => {
    const c = await h.DB.prepare(`SELECT cargo_metal FROM game_trade_route_ships WHERE ship_id = 'ship_ls1'`).first();
    return Number(c?.cargo_metal ?? 0) > 0;
  });
  await h.DB.prepare('UPDATE games SET dyson_controller_faction_id = ? WHERE id = ?').bind(h.B.id, h.G).run();
  const s0 = await h.sphere();
  await h.tick(40);
  const s1 = await h.sphere();
  const crewRow = await h.DB.prepare(`SELECT cargo_metal FROM game_trade_route_ships WHERE ship_id = 'ship_ls1'`).first();
  const r = await h.DB.prepare(`SELECT status FROM game_trade_routes WHERE game_id = ?`).bind(h.G).first();
  check("nothing is poured into a sphere that is no longer yours", Number(s1.m) === Number(s0.m), JSON.stringify({ s0, s1 }));
  check('the route parks with its load aboard', r?.status === 'stalled' && Number(crewRow?.cargo_metal ?? 0) > 0,
    JSON.stringify({ r, crewRow }));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
