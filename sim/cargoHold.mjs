// ============================================================
// The freighter's hold is PHYSICAL: cargo persists until delivered.
//
// Before migration 0088, cargo lived only on the trade-route row, so
// every path that ended a route with goods aboard TELEPORTED the load
// to the faction pool — cancel a route mid-haul and the freight arrived
// home instantly from deep space, making cancel the fastest (and free-est)
// freight service in the game.
//
// The rule now (Lorne): "Cargo should remain in a freighter until
// delivered either automatically or manually." These tests drive the
// REAL handlers (actions.js route table, faked session) and the REAL
// room.js resolveTick, and assert the whole lifecycle:
//
//   cancel  → cargo moves route → ship, pool untouched (mid-flight)
//   cancel parked at its OWN world → the load goes back there instead:
//             a raw world's stockpile, or the pool at a terraformed one
//             (nothing teleports; CMDR Poopypants, 2026-10-05)
//   unload  → manual delivery: ship (+ own-route) cargo → pool, once
//   re-route→ the hold folds into the new route and the machine
//             DELIVERS it at the new destination (the automatic half)
//   pirate  → a killer loots what was physically aboard, hold included
//
// Run: npm run sim:hold
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
    const url = new URL(`https://x${path}`);
    return await r.handle(req, env, { url, params: m.groups ?? {}, session: { user_id: userId } });
  }
  throw new Error(`no route matched ${method} ${path}`);
}
const readJson = async (res) => JSON.parse(await res.text());

async function seed(tag) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
  };
  const G = `gchold${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Hold Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','hold-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
  const rows = (await DB.prepare(
    `SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`)
    .bind(G).all()).results;
  const [A, B] = rows;
  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  for (const [f, shipId, dmg] of [[A, 'ship_A1', 0], [B, 'ship_B1', 0], [B, 'gun_B1', 7]]) {
    await DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
       VALUES (?, ?, ?, ?, ?, ?,
               2, 2, 0, 0, 0, 1,
               999, 999, 'active', 0, 60, 60, ?)`,
    ).bind(shipId, G, f.id, shipId, dmg > 0 ? 'corvette' : 'freighter', f.capital_body_id, dmg).run();
  }
  await DB.prepare(`UPDATE game_factions SET metal = 1000, fuel = 0, gold = 1000, science = 0 WHERE game_id = ?`)
    .bind(G).run();
  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};
  const { routes } = await import('../worker/actions.js');
  let tickNow = 0;
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      tickNow += 1;
      await room.resolveTick(G, tickNow);
      await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run();
    }
  };
  const pool = async (fid) => await DB.prepare(
    'SELECT metal, fuel, gold, science FROM game_factions WHERE id = ?').bind(fid).first();
  const hold = async (sid) => await DB.prepare(
    'SELECT cargo_fuel, cargo_metal, cargo_gold, cargo_science FROM game_ships WHERE id = ?').bind(sid).first();
  return { env, DB, G, A, B, routes, tick, pool, hold };
}

async function main() {
  // ---- 1. CANCEL keeps cargo aboard --------------------------------
  const h = await seed('1');
  const { env, DB, G, A, routes, pool, hold } = h;
  // A live logistics route with a loaded hold, mid-run.
  await DB.prepare(
    `INSERT INTO game_trade_routes
       (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
        status, kind, cargo_fuel, cargo_metal, cargo_gold, cargo_science, created_at_tick)
     VALUES ('r1', ?, ?, 'ship_A1', ?, 'luna', 'outbound', 'logistics', 0, 120, 80, 0, 0)`,
  ).bind(G, A.id, A.capital_body_id).run();
  // MID-HAUL means in flight. (This fixture used to leave the hull
  // parked at home, which is not mid-haul -- and is now a legal drop.)
  await DB.prepare(
    `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, scheduled_t, fuel_cost,
                                  status, target_body_id, arrival_at_tick)
     VALUES ('fly1', ?, 'ship_A1', 0, 'absolute', 0, 0, 'in_transit', ?, 999)`).bind(G, h.B.capital_body_id).run();

  const before = await pool(A.id);
  const res1 = await readJson(await callRoute(env, routes, 'DELETE', `/api/games/${G}/trade-routes/r1`, 'uA', null));
  check('cancel succeeds', res1.ok === true, JSON.stringify(res1));
  const after = await pool(A.id);
  const hd = await hold('ship_A1');
  check('cancel: pool did NOT receive the cargo (no teleport)',
    after.metal === before.metal && after.gold === before.gold,
    `pool metal ${before.metal}→${after.metal}`);
  check('cancel: cargo is aboard the SHIP',
    Number(hd.cargo_metal) === 120 && Number(hd.cargo_gold) === 80,
    JSON.stringify(hd));
  const r1 = await DB.prepare("SELECT cargo_metal, cancelled_at_tick FROM game_trade_routes WHERE id='r1'").first();
  check('cancel: route dead with zeroed cargo', r1.cancelled_at_tick != null && Number(r1.cargo_metal) === 0);
  // It lands (back home) before the manual unload below.
  await DB.prepare("DELETE FROM game_ship_nodes WHERE id = 'fly1'").run();

  // ---- 2. UNLOAD is the manual delivery ----------------------------
  const res2 = await readJson(await callRoute(env, routes, 'POST', `/api/games/${G}/ships/ship_A1/unload-hold`, 'uA', null));
  check('unload succeeds', res2.ok === true, JSON.stringify(res2));
  const after2 = await pool(A.id);
  const hd2 = await hold('ship_A1');
  check('unload: pool credited exactly the hold',
    after2.metal === before.metal + 120 && after2.gold === before.gold + 80,
    `metal ${before.metal}→${after2.metal}, gold ${before.gold}→${after2.gold}`);
  check('unload: hold now empty', Number(hd2.cargo_metal) === 0 && Number(hd2.cargo_gold) === 0);
  const res2b = await readJson(await callRoute(env, routes, 'POST', `/api/games/${G}/ships/ship_A1/unload-hold`, 'uA', null));
  check('second unload refuses (empty_hold)', res2b.error?.code === 'empty_hold', JSON.stringify(res2b));

  // ---- 3. RE-ROUTE folds the hold and DELIVERS it ------------------
  // Load the ship hold directly (as a cancel would), then lay a real
  // logistics route via the real handler and let the machine run.
  await DB.prepare("UPDATE game_ships SET cargo_metal = 60, cargo_gold = 40 WHERE id = 'ship_A1'").run();
  // Logistics dest must be a valid dest — B's capital won't do (not
  // ours); use the terraformed/loading-dock rule: A's OWN capital is the
  // origin... use dest = luna? Luna is B's capital. Query a valid dest
  // the way the client would is heavy; instead make the dest A's second
  // settlement: found one on a nearby body by inserting a settlement.
  await DB.prepare(
    `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
       hp, hp_max, population, surface_angle, created_at_tick)
     VALUES ('st_mars', ?, ?, ?, 'city', 'Marsport', 100, 100, 1, 0, 0)`,
  ).bind(G, `${G}:mars`, A.id).run();
  // Mark mars terraformed so it's a legal logistics dest (loading dock).
  await DB.prepare("UPDATE game_bodies SET terraformed_at_tick = 0, owner_faction_id = ? WHERE id = ? AND game_id = ?")
    .bind(A.id, `${G}:mars`, G).run();
  const res3 = await readJson(await callRoute(env, routes, 'POST', `/api/games/${G}/trade-routes`, 'uA',
    { ship_id: 'ship_A1', origin_body_id: A.capital_body_id, dest_body_id: `${G}:mars` }));
  check('create-route succeeds with a loaded hold', !!res3.route, JSON.stringify(res3).slice(0, 200));
  const r3 = await DB.prepare('SELECT status, cargo_metal, cargo_gold FROM game_trade_routes WHERE id = ?')
    .bind(res3.route.id).first();
  const hd3 = await hold('ship_A1');
  check('fold: new route opens OUTBOUND with the hold as cargo',
    r3.status === 'outbound' && Number(r3.cargo_metal) === 60 && Number(r3.cargo_gold) === 40,
    JSON.stringify(r3));
  check('fold: ship hold zeroed', Number(hd3.cargo_metal) === 0 && Number(hd3.cargo_gold) === 0);

  const poolBefore3 = await pool(A.id);
  await h.tick(40);   // plenty for the leg + delivery
  const poolAfter3 = await pool(A.id);
  const r3b = await DB.prepare('SELECT cargo_metal, cargo_gold FROM game_trade_routes WHERE id = ?')
    .bind(res3.route.id).first();
  check('automatic delivery: the folded cargo left the route',
    Number(r3b.cargo_metal) === 0 && Number(r3b.cargo_gold) === 0, JSON.stringify(r3b));
  check('automatic delivery: owner received value (pool or stockpile moved)',
    poolAfter3.metal + poolAfter3.gold >= poolBefore3.metal + poolBefore3.gold,
    `pool ${poolBefore3.metal + poolBefore3.gold} → ${poolAfter3.metal + poolAfter3.gold}`);

  // ---- 4. Contracted cargo is protected ----------------------------
  const h4 = await seed('4');
  await h4.DB.prepare(
    `INSERT INTO game_trade_routes
       (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
        status, kind, cargo_fuel, cargo_metal, cargo_gold, cargo_science,
        created_at_tick, counterparty_faction_id)
     VALUES ('r4', ?, ?, 'ship_A1', ?, 'luna', 'outbound', 'logistics', 0, 100, 0, 0, 0, ?)`,
  ).bind(h4.G, h4.A.id, h4.A.capital_body_id, h4.B.id).run();
  const res4 = await readJson(await callRoute(h4.env, h4.routes, 'POST', `/api/games/${h4.G}/ships/ship_A1/unload-hold`, 'uA', null));
  check('agreement cargo refuses unload (contracted)', res4.error?.code === 'contracted', JSON.stringify(res4));
  // ...but the ship's OWN cargo still unloads alongside a contracted leg.
  await h4.DB.prepare("UPDATE game_ships SET cargo_metal = 25 WHERE id = 'ship_A1'").run();
  const p4a = await h4.pool(h4.A.id);
  const res4b = await readJson(await callRoute(h4.env, h4.routes, 'POST', `/api/games/${h4.G}/ships/ship_A1/unload-hold`, 'uA', null));
  const p4b = await h4.pool(h4.A.id);
  const r4 = await h4.DB.prepare("SELECT cargo_metal FROM game_trade_routes WHERE id='r4'").first();
  check('own cargo unloads; contracted load untouched',
    res4b.ok === true && p4b.metal === p4a.metal + 25 && Number(r4.cargo_metal) === 100,
    JSON.stringify({ res4b, delta: p4b.metal - p4a.metal, route: r4 }));

  // ---- 5. Piracy loots the ship hold -------------------------------
  const h5 = await seed('5');
  // Combat needs a declared war since peace became the default.
  {
    const [fa, fb] = [h5.A.id, h5.B.id].sort();
    await h5.DB.prepare(`INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick)
                         VALUES ('w5', ?, ?, ?, ?, 0)`).bind(h5.G, fa, fb, h5.B.id).run();
  }
  // A's freighter with hold cargo parked at B's capital next to B's gun.
  await h5.DB.prepare("UPDATE game_ships SET parent_body_id = ?, cargo_metal = 77, hp = 5 WHERE id = 'ship_A1'")
    .bind(h5.B.capital_body_id).run();
  const pB = await h5.pool(h5.B.id);
  await h5.tick(6);   // corvette (7 dmg) kills the 5hp freighter promptly
  const shipRow = await h5.DB.prepare("SELECT status, cargo_metal FROM game_ships WHERE id='ship_A1'").first();
  const pB2 = await h5.pool(h5.B.id);
  check('freighter died to the corvette', shipRow.status === 'destroyed', shipRow.status);
  check('killer looted the ship hold', pB2.metal >= pB.metal + 77,
    `B metal ${pB.metal} → ${pB2.metal} (expected +77)`);
  check('dead hull holds nothing (no double-loot)', Number(shipRow.cargo_metal) === 0,
    String(shipRow.cargo_metal));

  // ---- 6. Cancel while PARKED at your own world ---------------------
  // Raw world: the load goes back into the station's stockpile it was
  // drawn from, not into a hold floating in orbit.
  const h6 = await seed('6');
  const MARS6 = `${h6.G}:mars`;
  await h6.DB.prepare('UPDATE game_bodies SET terraformed_at_tick = NULL WHERE id = ?').bind(MARS6).run();
  {
    const src = await h6.DB.prepare('SELECT id FROM game_settlements WHERE game_id = ? AND owner_faction_id = ? LIMIT 1')
      .bind(h6.G, h6.A.id).first();
    const cols = (await h6.DB.prepare('PRAGMA table_info(game_settlements)').all()).results.map(x => x.name);
    const over = { id: "'st_raw'", body_id: `'${MARS6}'`, type: "'station'", stockpile_metal: '0', stockpile_gold: '0',
                   stockpile_fuel: '0', stockpile_science: '0', destroyed_at_tick: 'NULL' };
    await h6.DB.prepare(`INSERT INTO game_settlements (${cols.join(', ')})
                         SELECT ${cols.map(c => over[c] ?? c).join(', ')} FROM game_settlements WHERE id = ?`).bind(src.id).run();
  }
  await h6.DB.prepare("UPDATE game_ships SET parent_body_id = ? WHERE id = 'ship_A1'").bind(MARS6).run();
  await h6.DB.prepare(
    `INSERT INTO game_trade_routes
       (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
        status, kind, cargo_fuel, cargo_metal, cargo_gold, cargo_science, created_at_tick)
     VALUES ('r6', ?, ?, 'ship_A1', ?, ?, 'outbound', 'logistics', 0, 30, 20, 0, 0)`,
  ).bind(h6.G, h6.A.id, MARS6, h6.A.capital_body_id).run();
  const p6 = await h6.pool(h6.A.id);
  const res6 = await readJson(await callRoute(h6.env, h6.routes, 'DELETE', `/api/games/${h6.G}/trade-routes/r6`, 'uA', null));
  const st6 = await h6.DB.prepare("SELECT stockpile_metal, stockpile_gold FROM game_settlements WHERE id = 'st_raw'").first();
  const hd6 = await h6.hold('ship_A1');
  const p6b = await h6.pool(h6.A.id);
  check('cancel parked at a raw world: the load goes back into its stockpile',
    res6.ok === true && Number(st6?.stockpile_metal) === 30 && Number(st6?.stockpile_gold) === 20,
    JSON.stringify({ res6, st6 }));
  check('...and not into the hold or the pool',
    Number(hd6.cargo_metal) === 0 && p6b.metal === p6.metal, JSON.stringify({ hd6, pool: [p6.metal, p6b.metal] }));

  // Terraformed home (the loading dock): a cancel there is a dropoff.
  const h7 = await seed('7');
  await h7.DB.prepare(
    `INSERT INTO game_trade_routes
       (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
        status, kind, cargo_fuel, cargo_metal, cargo_gold, cargo_science, created_at_tick)
     VALUES ('r7', ?, ?, 'ship_A1', ?, 'luna', 'outbound', 'logistics', 0, 40, 10, 0, 0)`,
  ).bind(h7.G, h7.A.id, h7.A.capital_body_id).run();
  const p7 = await h7.pool(h7.A.id);
  const res7 = await readJson(await callRoute(h7.env, h7.routes, 'DELETE', `/api/games/${h7.G}/trade-routes/r7`, 'uA', null));
  const p7b = await h7.pool(h7.A.id);
  const hd7 = await h7.hold('ship_A1');
  check('cancel parked at your terraformed world: the load drops into the pool',
    res7.ok === true && p7b.metal === p7.metal + 40 && p7b.gold === p7.gold + 10 && Number(hd7.cargo_metal) === 0,
    JSON.stringify({ res7, pool: [p7.metal, p7b.metal], hd7 }));

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
