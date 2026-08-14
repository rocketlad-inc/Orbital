// ============================================================
// Freighter hold unload — POST /ships/:id/unload-hold end to end.
//
// Player request (2026-08-14): a HOLD box on every freighter with a
// manual deliver button, greyed when empty. The button's server half is
// handleUnloadHold; these assertions drive the REAL route handler (via
// the exported routes table, so the URL pattern is exercised too)
// against the real schema.
//
// The rules under test:
//   1. happy path — cargo lands in the faction pool, the route SURVIVES
//      with an empty hold (unload ≠ cancel; that distinction is the
//      entire reason the endpoint exists)
//   2. contracted — an agreement leg's cargo is owed to the counterparty
//      and cannot be pocketed
//   3. empty hold refused
//   4. mid-burn refused
//   5. a racing double-unload can't bank the hold twice (the guarded
//      zero pins the exact cargo values it read)
//
// Run: npm run sim:unload
// ============================================================

import { seedGameWorld } from '../worker/factions.js';
import { routes } from '../worker/actions.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}

const GID = 'gunload';
const route = routes.find(r =>
  r.pattern.source.includes('unload-hold') && r.method === 'POST');
if (!route) { console.log('FAIL  unload-hold route not registered'); process.exit(1); }

async function callUnload(env, shipId, userId) {
  const url = `/api/games/${GID}/ships/${shipId}/unload-hold`;
  const m = url.match(route.pattern);
  const res = await route.handle(
    new Request('https://x' + url, { method: 'POST' }),
    env,
    { params: m.groups, session: { user_id: userId }, url: new URL('https://x' + url) },
  );
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u0','a@t','A','x',0),('u1','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Unload','u0',0,0)`).bind(GID).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at,tick_interval_ms)
                    VALUES (?, 'setup','useed',0,0,30000)`).bind(GID).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,0),(?,?,1)`)
    .bind(GID, 'u0', GID, 'u1').run();
  await seedGameWorld(env, GID);
  const facs = ((await DB.prepare(`SELECT id, user_id FROM game_factions WHERE game_id = ? ORDER BY slot`)
    .bind(GID).all()).results ?? []);
  const [fA, fB] = facs;
  check('two factions seeded', facs.length === 2, facs.length);

  const mkShip = async (id, faction) => DB.prepare(
    `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, status,
                             parent_body_id, orbit_rp, orbit_ra, orbit_omega, orbit_m0,
                             orbit_epoch, orbit_direction, hp, hp_max, fuel, fuel_max, built_at_tick)
     VALUES (?, ?, ?, 'Hauler', 'freighter', 'active', ?, 4, 4, 0, 0, 0, 1, 30, 30, 100, 100, 0)`)
    .bind(id, GID, faction.id, `${GID}:titan`).run();
  const mkRoute = async (id, shipId, faction, cargo, counterparty = null) => DB.prepare(
    `INSERT INTO game_trade_routes (id, game_id, owner_faction_id, ship_id, origin_body_id,
                                    dest_body_id, status, cargo_fuel, cargo_metal, cargo_gold,
                                    cargo_science, created_at_tick, counterparty_faction_id)
     VALUES (?, ?, ?, ?, ?, ?, 'outbound', 0, ?, ?, ?, 0, ?)`)
    .bind(id, GID, faction.id, shipId, `${GID}:titan`, `${GID}:luna`,
          cargo.metal, cargo.gold, cargo.science, counterparty).run();

  // --- 1. happy path ---
  await mkShip('s_haul', fA);
  await mkRoute('r1', 's_haul', fA, { metal: 120, gold: 30, science: 5 });
  const before = await DB.prepare('SELECT metal, gold, science FROM game_factions WHERE id = ?').bind(fA.id).first();
  const r1 = await callUnload(env, 's_haul', fA.user_id);
  check('unload succeeds', r1.status === 200 && r1.body?.ok === true, JSON.stringify(r1));
  check('amounts reported', r1.body?.unloaded?.metal === 120 && r1.body?.unloaded?.gold === 30,
    JSON.stringify(r1.body?.unloaded));
  const after = await DB.prepare('SELECT metal, gold, science FROM game_factions WHERE id = ?').bind(fA.id).first();
  check('pool credited exactly',
    after.metal - before.metal === 120 && after.gold - before.gold === 30 && after.science - before.science === 5,
    `Δ metal ${after.metal - before.metal}, gold ${after.gold - before.gold}, sci ${after.science - before.science}`);
  const routeRow = await DB.prepare('SELECT cancelled_at_tick, cargo_metal, cargo_gold, status FROM game_trade_routes WHERE id = ?')
    .bind('r1').first();
  check('route SURVIVES the unload (unload ≠ cancel)',
    routeRow.cancelled_at_tick === null, JSON.stringify(routeRow));
  check('hold zeroed', routeRow.cargo_metal === 0 && routeRow.cargo_gold === 0, JSON.stringify(routeRow));

  // --- 2. second unload on the now-empty hold refused ---
  const r2 = await callUnload(env, 's_haul', fA.user_id);
  check('empty hold refused with empty_hold', r2.status === 409 && r2.body?.error?.code === 'empty_hold',
    JSON.stringify(r2.body));

  // --- 3. contracted cargo refused ---
  await mkShip('s_pact', fA);
  await mkRoute('r2', 's_pact', fA, { metal: 200, gold: 0, science: 0 }, fB.id);
  const r3 = await callUnload(env, 's_pact', fA.user_id);
  check('agreement-leg cargo refused with contracted',
    r3.status === 409 && r3.body?.error?.code === 'contracted', JSON.stringify(r3.body));
  const pact = await DB.prepare('SELECT cargo_metal FROM game_trade_routes WHERE id = ?').bind('r2').first();
  check('contracted cargo untouched', pact.cargo_metal === 200, pact.cargo_metal);

  // --- 4. mid-burn refused ---
  await mkShip('s_fly', fA);
  await mkRoute('r3', 's_fly', fA, { metal: 50, gold: 0, science: 0 });
  await DB.prepare(
    `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
                                  scheduled_t, status, fuel_cost, dv_prograde, dv_normal, dv_radial)
     VALUES ('n_fly', ?, 's_fly', 0, 'body', ?, 1, 'in_transit', 0, 0, 0, 0)`)
    .bind(GID, `${GID}:luna`).run();
  const r4 = await callUnload(env, 's_fly', fA.user_id);
  check('mid-burn refused with in_transit',
    r4.status === 409 && r4.body?.error?.code === 'in_transit', JSON.stringify(r4.body));

  // --- 5. not your ship ---
  const r5 = await callUnload(env, 's_haul', fB.user_id);
  check("rival can't unload your freighter", r5.status === 404, JSON.stringify(r5.body));

  // --- 6. the guarded zero pins the cargo it read ---
  // Simulate the race by mutating cargo between read and write: the
  // handler's UPDATE carries the read values in its WHERE, so a changed
  // hold makes it a no-op and the pool is not credited from stale data.
  await mkShip('s_race', fA);
  await mkRoute('r4', 's_race', fA, { metal: 80, gold: 0, science: 0 });
  const origPrepare = DB.prepare.bind(DB);
  let mutated = false;
  DB.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (!mutated && /UPDATE game_trade_routes\s+SET cargo_fuel = 0/.test(sql)) {
      mutated = true;
      // Another actor (the tick's pickup pass) changes the hold first.
      origPrepare('UPDATE game_trade_routes SET cargo_metal = 500 WHERE id = ?').bind('r4').run();
    }
    return stmt;
  };
  const r6 = await callUnload(env, 's_race', fA.user_id);
  DB.prepare = origPrepare;
  check('a hold that changed underneath refuses with conflict',
    r6.status === 409 && r6.body?.error?.code === 'conflict', JSON.stringify(r6.body));
  const racePool = await DB.prepare('SELECT metal FROM game_factions WHERE id = ?').bind(fA.id).first();
  check('no phantom credit from the stale read',
    racePool.metal === after.metal, `pool ${racePool.metal} vs ${after.metal}`);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
