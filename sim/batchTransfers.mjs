// ============================================================
// BATCH TRANSFERS — one request commits a whole fleet's orders.
//
// QA battle test, 2026-09-22: "ISSUE 70 ORDERS" was 70 parallel POSTs
// to /ships/:id/transfer (p50 2.8s each, ~12s wall). POST /transfers
// takes them all at once. This drives the REAL route table against a
// D1 that enforces the 100-bound-parameter ceiling, and checks the
// batch writes exactly what 70 single commits would, refuses exactly
// what they would refuse, and counts how many D1 calls it takes.
//
// Run: node sim/batchTransfers.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { routes } from '../worker/actions.js';
import { D1_MAX_BOUND_PARAMS } from '../worker/sqlChunk.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// D1's limits, not SQLite's: 100 bound params, and count every call.
let calls = 0;
function d1Strict(db) {
  const wrapStmt = (stmt) => ({
    bind(...args) {
      if (args.length > D1_MAX_BOUND_PARAMS) throw new Error(`D1_ERROR: too many SQL variables (${args.length})`);
      return wrapStmt(stmt.bind(...args));
    },
    all: (...a) => { calls++; return stmt.all(...a); },
    first: (...a) => { calls++; return stmt.first(...a); },
    run: (...a) => { calls++; return stmt.run(...a); },
    raw: (...a) => { calls++; return stmt.raw?.(...a); },
    _inner: stmt,
  });
  return {
    prepare: (sql) => wrapStmt(db.prepare(sql)),
    batch: (stmts) => { calls++; return db.batch(stmts.map(s => s._inner ?? s)); },
    exec: (...a) => db.exec?.(...a),
  };
}

const RAW = new SimD1(':memory:');
RAW.applyMigrations(MIGRATIONS);
const DB = d1Strict(RAW);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gbatchxfer1';
const now = Date.now();
for (const u of ['u1', 'u2']) {
  await RAW.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
    .bind(u, `${u}@t`, u, now).run();
}
await RAW.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Batch','u1',?,?)`).bind(G, now, now).run();
await RAW.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','batch',50,3600000,?,?)`).bind(G, now, now).run();
await RAW.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
await RAW.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld({ ...env, DB: RAW }, G);
await RAW.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
const fA = (await RAW.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first()).id;
const fB = (await RAW.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first()).id;
const earth = (await RAW.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='earth'`).bind(G).first()).id;
const mars = (await RAW.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='mars'`).bind(G).first()).id;

const N = 150;   // past the 100-parameter ceiling, so every IN-list must chunk
await RAW.prepare(
  `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES (?,?,?,'Chain','frigate',?, 2,2,0,0,0,1, 99,99,'active',0, 300,300,10)`,
).bind(`${G}:x1`, G, fA, earth).run();
for (let i = 0; i < N; i++) {
  await RAW.prepare(
    `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
       orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
       fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
     VALUES (?,?,?,?,'frigate',?, 2,2,0,0,0,1, 99,99,'active',0, 300,300,10)`,
  ).bind(`${G}:s${i}`, G, fA, `Havoc ${i}`, earth).run();
}
// One hull that belongs to someone else, and a leg already committed on
// hull 0 that a replace must cancel.
await RAW.prepare(
  `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES (?,?,?,'Theirs','frigate',?, 2,2,0,0,0,1, 99,99,'active',0, 300,300,10)`,
).bind(`${G}:theirs`, G, fB, mars).run();
await RAW.prepare(`INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id, scheduled_t, fuel_cost, status)
                   VALUES (?,?,?,0,'absolute',?,49,0,'committed')`).bind(`${G}:old`, G, `${G}:s0`, mars).run();

const call = async (method, path, body) => {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const url = new URL(`https://x${path}`);
    try {
      const res = await r.handle(new Request(url, { method, body: JSON.stringify(body) }), env,
        { url, params: m.groups ?? {}, session: { user_id: 'u1' } });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      return { status: 500, body: { error: { message: String(e.message) } } };
    }
  }
  return { status: 404, body: null };
};

const leg = (shipId, extra = {}) => ({
  ship_id: shipId, target_body_id: mars, scheduled_t: 51, arrival_t: 60,
  dv_prograde: 1, fuel_cost: 0, replace: true, ...extra,
});
const orders = Array.from({ length: N }, (_, i) => leg(`${G}:s${i}`));
orders.push(leg(`${G}:theirs`));                              // not mine
orders.push(leg(`${G}:s1`, { scheduled_t: -5 }));             // bad body
orders.push(leg(`${G}:s2`, { replace: false, scheduled_t: 61, arrival_t: 70 }));  // chained 2nd leg
// A route whose first leg is refused: its second leg must NOT commit.
orders.push(leg(`${G}:x1`, { target_body_id: `${G}:nowhere` }));
orders.push(leg(`${G}:x1`, { replace: false, scheduled_t: 61, arrival_t: 70 }));

calls = 0;
const res = await call('POST', `/api/games/${G}/transfers`, { orders });
check('the batch is accepted', res.status === 201, JSON.stringify(res.body).slice(0, 300));
const results = res.body?.results ?? [];
check('one result per order, in order', results.length === orders.length
  && results.every((r, i) => r.ship_id === orders[i].ship_id), `${results.length}`);
check(`all ${N} fleet hulls committed`, results.slice(0, N).every(r => r.ok && r.node?.id), '');
check('a rival hull is refused, not_owner', results[N]?.ok === false && results[N]?.error?.code === 'not_owner', JSON.stringify(results[N]));
check('a bad body is refused, bad_request', results[N + 1]?.ok === false && results[N + 1]?.error?.code === 'bad_request', JSON.stringify(results[N + 1]));
check('a chained leg in the same batch is accepted', results[N + 2]?.ok === true, JSON.stringify(results[N + 2]));
check('a refused first leg refuses the rest of that route', results[N + 3]?.ok === false
  && results[N + 4]?.ok === false && results[N + 4]?.error?.code === 'chain_broken', JSON.stringify(results.slice(N + 3)));

const live = await RAW.prepare(`SELECT COUNT(*) n FROM game_ship_nodes WHERE game_id=? AND status='committed'`).bind(G).first();
check(`${N + 1} committed legs in D1 (fleet + one chained)`, live.n === N + 1, `${live.n}`);
const old = await RAW.prepare(`SELECT status FROM game_ship_nodes WHERE id=?`).bind(`${G}:old`).first();
check('replace cancelled the hull\'s earlier leg', old.status === 'cancelled', old.status);
const seqs = (await RAW.prepare(`SELECT sequence, scheduled_t FROM game_ship_nodes WHERE ship_id=? AND status='committed' ORDER BY scheduled_t`).bind(`${G}:s2`).all()).results;
check('the chained leg sequences after the first', seqs.length === 2 && seqs[1].sequence > seqs[0].sequence, JSON.stringify(seqs));
const theirs = await RAW.prepare(`SELECT COUNT(*) n FROM game_ship_nodes WHERE ship_id=?`).bind(`${G}:theirs`).first();
check('nothing was written for the rival hull', theirs.n === 0, `${theirs.n}`);
const idReturned = results[5]?.node?.id;
const idRow = await RAW.prepare(`SELECT ship_id FROM game_ship_nodes WHERE id=?`).bind(idReturned ?? '').first();
check('the returned node id is the row written (cancel can find it)', idRow?.ship_id === `${G}:s5`, idReturned);
console.log(`        ${orders.length} orders in ${calls} D1 calls (the single endpoint needs ~7 per order: ~${orders.length * 7})`);
check('the batch costs a handful of D1 calls, not several per order', calls <= 20, `${calls}`);

console.log(bad === 0 ? '\nALL BATCH TRANSFER CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
