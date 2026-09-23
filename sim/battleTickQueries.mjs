// ============================================================
// BATTLE TICK QUERY PROFILE — where a big battle's tick time goes.
//
// QA battle test, 2026-09-22: the tick with a 68-hull fleet fighting 9
// defenders at Mars took 11.2s server-side against ~2.5s for a quiet
// one. A D1 query from the Durable Object is a network round trip, so a
// tick's cost is dominated by how many SEQUENTIAL queries it awaits, not
// by SQLite work. This counts them, per statement shape, for a quiet
// tick and for the QA battle, through the REAL resolveTick.
//
// Run: node sim/battleTickQueries.mjs            (prints the top shapes)
//      node sim/battleTickQueries.mjs --arriving --budget 60
//        (the fleet also LANDS this tick, as in QA; fails if the battle
//        tick issues more than 60 queries over quiet — it was 480)
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const budgetArg = process.argv.indexOf('--budget');
const BUDGET = budgetArg > 0 ? Number(process.argv[budgetArg + 1]) : null;

// ---- instrumentation: count every awaited D1 call by statement shape ----
let counting = false;
const counts = new Map();
const shape = (sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 110);
function bump(sql) { if (counting) counts.set(shape(sql), (counts.get(shape(sql)) ?? 0) + 1); }
const probe = new SimD1(':memory:');
const StmtProto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
for (const m of ['first', 'all', 'run', 'raw']) {
  const orig = StmtProto[m];
  StmtProto[m] = function (...a) { bump(this._sql); return orig.apply(this, a); };
}
const origBatch = SimD1.prototype.batch;
SimD1.prototype.batch = function (stmts) {
  if (counting) counts.set(`BATCH(${stmts.length})`, (counts.get(`BATCH(${stmts.length})`) ?? 0) + 1);
  const was = counting; counting = false;
  return origBatch.call(this, stmts).finally(() => { counting = was; });
};

async function scenario({ atWar, attackers, defenders, arriving = false }) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = `gprof${atWar ? 'w' : 'q'}${arriving ? 'a' : ''}`;
  const now = Date.now();
  for (const u of ['u1', 'u2']) {
    await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
      .bind(u, `${u}@t`, u, now).run();
  }
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Prof','u1',?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','prof',50,3600000,?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
  const fA = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first()).id;
  const fB = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first()).id;
  const mars = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='mars'`).bind(G).first()).id;
  const earth = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='earth'`).bind(G).first()).id;
  if (atWar) {
    await DB.prepare(`INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick, origin)
                      VALUES (?, ?, ?, ?, ?, 40, 'declared')`).bind(`${G}:war`, G, fA, fB, fA).run();
  }
  const ship = (id, owner, name, hp, dmg, fleetId, captainId) => DB.prepare(
    `INSERT INTO game_ships
       (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
        orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
        fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, fleet_id, captain_id)
     VALUES (?,?,?,?,'frigate',?, 2,2,0,0,0,1, 99,99,'active',0, ?,?,?, ?, ?)`,
  ).bind(id, G, owner, name, mars, hp, hp, dmg, fleetId, captainId).run();
  const FLEET = `${G}:fleet`;
  for (let i = 0; i < attackers; i++) {
    const sid = `${G}:atk${i}`, cid = `${G}:cap${i}`;
    await ship(sid, fA, `Havoc ${i}`, 400, 140, FLEET, cid);
    await DB.prepare(`INSERT INTO game_captains (id, game_id, faction_id, name, rank, traits_json, ship_id, status, created_at_tick)
                      VALUES (?,?,?,?,0,'[]',?,'active',0)`).bind(cid, G, fA, `Captain ${i}`, sid).run();
    if (arriving) {
      // In flight from Earth, landing at Mars this tick: the QA battle
      // tick was ALSO the tick the whole fleet arrived.
      await DB.prepare(`UPDATE game_ships SET parent_body_id = ? WHERE id = ?`).bind(earth, sid).run();
      await DB.prepare(`INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id, scheduled_t, fuel_cost, status, arrival_at_tick)
                        VALUES (?,?,?,0,'absolute',?,40,0,'in_transit',51)`).bind(`${sid}:n`, G, sid, mars).run();
    }
  }
  if (attackers) {
    await DB.prepare(`INSERT INTO game_fleets (id, game_id, faction_id, name, flag_captain_id, created_at_tick) VALUES (?,?,?,?,?,0)`)
      .bind(FLEET, G, fA, 'Earth Group', `${G}:cap0`).run();
  }
  // Defenders carry captains, so the captain-fate path runs for every kill.
  for (let i = 0; i < defenders; i++) {
    const sid = `${G}:def${i}`, cid = `${G}:dcap${i}`;
    await ship(sid, fB, `Picket ${i}`, 360, 8, null, cid);
    await DB.prepare(`INSERT INTO game_captains (id, game_id, faction_id, name, rank, traits_json, ship_id, status, created_at_tick)
                      VALUES (?,?,?,?,0,'[]',?,'active',0)`).bind(cid, G, fB, `Defender ${i}`, sid).run();
  }

  const { Room } = await import('../worker/room.js');
  const store = new Map();
  const room = new Room({
    storage: {
      async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
      async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
      async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
    },
    blockConcurrencyWhile: async (f) => f(),
    getWebSockets: () => [],
    broadcast: () => {},
  }, env);
  counts.clear();
  counting = true;
  const t0 = performance.now();
  await room.resolveTick(G, 51);
  const ms = performance.now() - t0;
  counting = false;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const snapshot = new Map(counts);
  const destroyed = (await DB.prepare(`SELECT COUNT(*) n FROM game_ships WHERE game_id=? AND status='destroyed'`).bind(G).first()).n;
  const one = async (sql) => (await DB.prepare(sql).bind(G).first()).n;
  const facts = {
    destroyed,
    shipChron: await one(`SELECT COUNT(*) n FROM chronicle_entries WHERE game_id=? AND kind='ship_destroyed'`),
    capChron: await one(`SELECT COUNT(*) n FROM chronicle_entries WHERE game_id=? AND kind IN ('captain_lost','captain_rescued')`),
    capsStillAboardDead: await one(`SELECT COUNT(*) n FROM game_captains c JOIN game_ships s ON s.id = c.ship_id
                                     WHERE c.game_id=? AND s.status='destroyed'`),
    parkedAtMars: await one(`SELECT COUNT(*) n FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
                              WHERE s.game_id=? AND b.template_id='mars' AND s.id LIKE '%atk%'`),
    nodesExecuted: await one(`SELECT COUNT(*) n FROM game_ship_nodes WHERE game_id=? AND status='executed'`),
    veterans: await one(`SELECT COUNT(*) n FROM game_captains WHERE game_id=? AND rank > 0`),
  };
  return { total, ms, snapshot, destroyed, facts };
}

const quiet = await scenario({ atWar: false, attackers: 68, defenders: 9 });
const battle = await scenario({ atWar: process.argv.includes('--peace') ? false : true, attackers: 68, defenders: 9,
  arriving: process.argv.includes('--arriving') });
console.log(`quiet tick : ${quiet.total} queries (${quiet.ms.toFixed(0)} ms local)`);
console.log(`battle tick: ${battle.total} queries (${battle.ms.toFixed(0)} ms local), ${battle.destroyed} hulls destroyed`);
const delta = [];
for (const [k, n] of battle.snapshot) {
  const d = n - (quiet.snapshot.get(k) ?? 0);
  if (d > 0) delta.push([d, k]);
}
delta.sort((a, b) => b[0] - a[0]);
console.log('\nextra queries in the battle tick, by shape:');
for (const [d, k] of delta.slice(0, 25)) console.log(`  +${String(d).padStart(4)}  ${k}`);
const extra = battle.total - quiet.total;
console.log(`\nbattle - quiet = ${extra} queries`);

// The batching must not change WHAT the tick writes.
let bad = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (${detail})`}`); if (!ok) bad++; };
const f = battle.facts;
console.log('');
check('hulls died in the battle', f.destroyed > 0, f.destroyed);
check('every dead hull is chronicled', f.shipChron === f.destroyed, `${f.shipChron} rows / ${f.destroyed} dead`);
check('every dead captained hull has a captain fate chronicled', f.capChron === f.destroyed, `${f.capChron} / ${f.destroyed}`);
check('no captain is still aboard a destroyed hull', f.capsStillAboardDead === 0, f.capsStillAboardDead);
check('killers earned rank', f.veterans > 0, f.veterans);
if (process.argv.includes('--arriving')) {
  check('all 68 arrivals parked at Mars', f.parkedAtMars === 68, f.parkedAtMars);
  check('all 68 arrival nodes executed', f.nodesExecuted === 68, f.nodesExecuted);
}
if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
if (BUDGET != null) {
  const ok = extra <= BUDGET;
  console.log(ok ? `PASS  within budget (${BUDGET})` : `FAIL  over budget (${BUDGET})`);
  process.exit(ok ? 0 : 1);
}
