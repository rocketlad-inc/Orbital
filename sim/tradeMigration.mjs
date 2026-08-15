// ============================================================
// THE CUTOVER REHEARSAL.
//
// Trade v2 collapsed the design's three deploys (shadow -> cutover ->
// features) into one release, which forfeits the soak time the plan
// bought. This is what replaces it: build a world on the PRE-0089
// schema, fill it with the exact route shapes prod is carrying — routes
// mid-flight, loaded holds, agreement legs, terraform and dyson runs —
// then apply 0089 and run the new tick against it.
//
// Every other sim seeds a fresh world with the migration already
// applied, so none of them can catch a backfill that mis-maps live
// state. This one only tests the seam.
//
// Run: npm run sim:trademig
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' },
    acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

// Split the bundle at 0089 so we can build a world on the OLD schema.
const idxOf = (name) => MIGRATIONS.findIndex(m => (m.name ?? m.id ?? '').includes(name));
const cut = idxOf('0089_trade_route_stops');
check('the bundle contains 0089', cut > 0, `index ${cut}`);
const BEFORE = MIGRATIONS.slice(0, cut);
const AFTER = MIGRATIONS.slice(cut);

const DB = new SimD1(':memory:');
DB.applyMigrations(BEFORE);
const env = {
  DB,
  ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
};
const G = 'gtrmig01';

await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'Migration Test','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','mig-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();

const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active', current_tick = 40 WHERE id = ?").bind(G).run();
const [A, B] = (await DB.prepare(
  `SELECT id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
await DB.prepare(`UPDATE game_factions SET metal = 5000, fuel = 0, gold = 5000, science = 0 WHERE game_id = ?`)
  .bind(G).run();

const addShip = async (id, f, cls, body) => DB.prepare(
  `INSERT INTO game_ships
    (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES (?, ?, ?, ?, ?, ?, 2,2,0,0,0,1, 999,999,'active',0, 60,60, 0)`,
).bind(id, G, f.id, `Freighter ${id}`, cls, body).run();

const addSettlement = async (id, f, body, metal, terraform) => {
  await DB.prepare(
    `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
       hp, hp_max, population, surface_angle, created_at_tick, stockpile_metal)
     VALUES (?, ?, ?, ?, 'station', ?, 100,100,1,0,0, ?)`,
  ).bind(id, G, body, f.id, id, metal).run();
  if (terraform) {
    await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = 0, owner_faction_id = ? WHERE id = ? AND game_id = ?')
      .bind(f.id, body, G).run();
  }
};

await addSettlement('st_home', A, A.capital_body_id, 400, true);
await addSettlement('st_mars', A, `${G}:mars`, 300, true);
await addSettlement('st_bhome', B, B.capital_body_id, 200, true);

// --- the four live shapes, written the OLD way (no stops, no crew) ---
const mkRoute = async (id, owner, ship, origin, dest, status, kind, cargo, extra = {}) => {
  await DB.prepare(
    `INSERT INTO game_trade_routes
       (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
        status, kind, cargo_fuel, cargo_metal, cargo_gold, cargo_science, created_at_tick,
        counterparty_faction_id, agreement_id, tariff_pct,
        per_run_metal, per_run_fuel, per_run_gold, per_run_science, loops_completed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 5, ?, ?, ?, ?, 0, ?, 0, ?)`,
  ).bind(id, G, owner.id, ship, origin, dest, status, kind,
         cargo.metal ?? 0, cargo.gold ?? 0,
         extra.counterparty ?? null, extra.agreement ?? null, extra.tariff ?? 0,
         extra.perRunMetal ?? 0, extra.perRunGold ?? 0, extra.loops ?? 3).run();
};

await addShip('ship_out', A, 'freighter', `${G}:mars`);
await mkRoute('rt_outbound', A, 'ship_out', A.capital_body_id, `${G}:mars`,
  'outbound', 'logistics', { metal: 137, gold: 42 });

await addShip('ship_ret', A, 'freighter', A.capital_body_id);
await mkRoute('rt_returning', A, 'ship_ret', A.capital_body_id, `${G}:mars`,
  'returning', 'logistics', {});

// A freighter MID-FLIGHT with a live node — the case the design called
// the delicate one: the cursor must adopt the node already flying.
await addShip('ship_fly', A, 'freighter', A.capital_body_id);
await mkRoute('rt_inflight', A, 'ship_fly', A.capital_body_id, `${G}:mars`,
  'outbound', 'logistics', { metal: 88 });
await DB.prepare(
  `INSERT INTO game_ship_nodes
     (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
      scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
      status, committed_at_tick)
   VALUES ('node_fly', ?, 'ship_fly', 0, 'absolute', ?, 38, 46, 0,0,0,0, 'in_transit', 38)`,
).bind(G, `${G}:mars`).run();

// A cancelled route — must NOT get stops or crew (its hull is free).
await addShip('ship_dead', A, 'freighter', A.capital_body_id);
await mkRoute('rt_cancelled', A, 'ship_dead', A.capital_body_id, `${G}:mars`,
  'returning', 'logistics', {});
await DB.prepare('UPDATE game_trade_routes SET cancelled_at_tick = 10 WHERE id = ?')
  .bind('rt_cancelled').run();

// An agreement leg (cargo authority stays on the ROUTE for these).
await DB.prepare(
  `INSERT INTO trade_agreements
     (id, game_id, faction_a_id, faction_b_id, a_metal, a_fuel, a_gold, a_science,
      b_metal, b_fuel, b_gold, b_science, a_tariff_pct, b_tariff_pct,
      status, created_at_tick, created_at_ms)
   VALUES ('ag_mig', ?, ?, ?, 50,0,0,0, 0,0,25,0, 0,0, 'active', 5, 0)`,
).bind(G, A.id, B.id).run();
await addShip('ship_leg', A, 'freighter', A.capital_body_id);
await mkRoute('rt_leg', A, 'ship_leg', A.capital_body_id, B.capital_body_id,
  'outbound', 'logistics', { metal: 50 },
  { counterparty: B.id, agreement: 'ag_mig', perRunMetal: 50 });

const before = {
  outbound: await DB.prepare('SELECT * FROM game_trade_routes WHERE id = ?').bind('rt_outbound').first(),
  leg: await DB.prepare('SELECT * FROM game_trade_routes WHERE id = ?').bind('rt_leg').first(),
};

// ============ THE MIGRATION ============
DB.applyMigrations(AFTER);

const stopsOf = async (id) => (await DB.prepare(
  'SELECT sequence, body_id, action FROM game_trade_route_stops WHERE route_id = ? ORDER BY sequence')
  .bind(id).all()).results ?? [];
const crewOf = async (id) => (await DB.prepare(
  'SELECT * FROM game_trade_route_ships WHERE route_id = ?').bind(id).all()).results ?? [];

for (const id of ['rt_outbound', 'rt_returning', 'rt_inflight', 'rt_leg']) {
  const st = await stopsOf(id);
  check(`${id}: backfilled to two stops, pickup then dropoff`,
    st.length === 2 && st[0].action === 'pickup' && st[1].action === 'dropoff',
    JSON.stringify(st));
}
check('a CANCELLED route gets no stops', (await stopsOf('rt_cancelled')).length === 0);
check('a CANCELLED route gets no crew — its hull stays free',
  (await crewOf('rt_cancelled')).length === 0);

const outCrew = (await crewOf('rt_outbound'))[0];
check("'outbound' maps to a cursor pointing at the DESTINATION",
  outCrew?.next_stop_seq === 1, JSON.stringify(outCrew));
check('a loaded self-haul route moved its cargo onto the crew row',
  Number(outCrew?.cargo_metal) === 137 && Number(outCrew?.cargo_gold) === 42,
  JSON.stringify(outCrew));

const retCrew = (await crewOf('rt_returning'))[0];
check("'returning' maps to a cursor pointing at the ORIGIN",
  retCrew?.next_stop_seq === 0, JSON.stringify(retCrew));

const legCrew = (await crewOf('rt_leg'))[0];
check('an AGREEMENT leg keeps cargo authority on the route row (crew row zeroed)',
  Number(legCrew?.cargo_metal) === 0 && Number(before.leg.cargo_metal) === 50,
  JSON.stringify(legCrew));

check('every live route has exactly one carrier',
  (await DB.prepare(
    `SELECT COUNT(*) n FROM game_trade_routes r
      WHERE r.cancelled_at_tick IS NULL
        AND (SELECT COUNT(*) FROM game_trade_route_ships c
              WHERE c.route_id = r.id AND c.role = 'carrier') != 1`).first()).n === 0);

// ============ THE NEW TICK, ON MIGRATED DATA ============
const { Room } = await import('../worker/room.js');
const room = new Room(makeState(), env);
room.broadcast = () => {};

const flyNodeBefore = await DB.prepare(
  "SELECT target_body_id, arrival_at_tick, status FROM game_ship_nodes WHERE id = 'node_fly'").first();

let t = 40;
for (let i = 0; i < 12; i++) {
  t += 1;
  await room.resolveTick(G, t);
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
}

const flyNodeAfter = await DB.prepare(
  "SELECT target_body_id, arrival_at_tick FROM game_ship_nodes WHERE id = 'node_fly'").first();
check('the in-flight freighter was NOT re-planned underneath — same target, same arrival',
  flyNodeAfter.target_body_id === flyNodeBefore.target_body_id
  && flyNodeAfter.arrival_at_tick === flyNodeBefore.arrival_at_tick,
  JSON.stringify({ before: flyNodeBefore, after: flyNodeAfter }));

const survivors = (await DB.prepare(
  `SELECT id, cancelled_at_tick, stalled_since_tick FROM game_trade_routes
    WHERE game_id = ? AND id != 'rt_cancelled'`).bind(G).all()).results;
check('no migrated route stalled or cancelled itself on the new tick',
  survivors.every(r => r.cancelled_at_tick == null && r.stalled_since_tick == null),
  JSON.stringify(survivors));

const delivered = Number((await DB.prepare(
  "SELECT trades_completed n FROM game_ships WHERE id = 'ship_out'").first())?.n ?? 0);
check('a migrated loaded route delivered its pre-existing cargo', delivered >= 1,
  `trades_completed=${delivered}`);

const homeStock = Number((await DB.prepare(
  "SELECT stockpile_metal m FROM game_settlements WHERE id = 'st_home'").first())?.m ?? 0);
check('a migrated route resumed collecting after the cutover', homeStock < 400,
  `stockpile ${homeStock} (was 400)`);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
