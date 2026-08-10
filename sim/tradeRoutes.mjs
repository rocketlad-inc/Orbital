// ============================================================
// Standing trade routes — the loop loops, the money moves, and every
// documented way of killing a deal actually kills it.
//
// Runs the REAL code end to end: the real trades.js endpoint handlers
// (through their route table, with a faked session), and the real
// room.js resolveTick driving pickup → flight → delivery → repeat.
//
// Why this exists before any player touches the feature: the self-haul
// route auto-pilot ALREADY shipped a bug in exactly this shape once — a
// freighter that picked up an empty stockpile arrived with nothing and
// got stuck, which a playtester reported as "trade routes aren't
// repeating". The repeating is the feature. It gets a test.
//
// Run: npm run sim:trade
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// ---- harness ---------------------------------------------------------

/** Minimal DO state for Room (mirrors sim/headless.mjs makeState). */
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

/** Call a trades.js endpoint handler the way the router would. */
async function callRoute(env, routes, method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const req = {
      json: async () => body,
      headers: new Map(),
    };
    const url = new URL(`https://x${path}`);
    return await r.handle(req, env, {
      url,
      params: m.groups ?? {},
      session: { user_id: userId },
    });
  }
  throw new Error(`no route matched ${method} ${path}`);
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

/**
 * A tiny two-faction game with collectors on both capitals and a
 * freighter apiece. Built by the REAL seeder so collector/capital
 * invariants hold, then trimmed to keep ticks fast.
 */
async function seedPair(tag) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: { // notify fan-out is best-effort; swallow it
      idFromName: () => 'x',
      get: () => ({ fetch: async () => new Response('{}') }),
    },
  };
  const G = `gtr${tag}`;
  const now = 0;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Trade Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','trade-seed',0,3600000,?,?)`).bind(G, now, now).run();
  // Adjacent starts so a round trip is a handful of ticks, not sixty.
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();

  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();

  const rows = (await DB.prepare(
    `SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`)
    .bind(G).all()).results;
  const [A, B] = rows;

  // The seeder's starter fleet composition is a balance knob that has
  // changed under the sim before — don't depend on it. Delete all ships
  // and give each side exactly one named freighter parked AT its capital
  // collector, so pickup can happen on the first tick.
  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  for (const [f, shipId] of [[A, 'shA'], [B, 'shB']]) {
    await DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
       VALUES (?, ?, ?, ?, 'freighter', ?,
               2, 2, 0, 0, 0, 1,
               999, 999, 'active', 0, 60, 60, 0)`,
    ).bind(shipId, G, f.id, `Freighter ${shipId}`, f.capital_body_id).run();
  }
  // Deterministic wallets.
  await DB.prepare(`UPDATE game_factions SET metal = 1000, fuel = 1000, gold = 1000, science = 0 WHERE game_id = ?`)
    .bind(G).run();

  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};

  const { routes } = await import('../worker/trades.js');

  let tickNow = 0;
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      tickNow += 1;
      await room.resolveTick(G, tickNow);
      await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run();
    }
  };

  return { env, DB, G, A, B, routes, tick, tickOf: () => tickNow };
}

/** Propose A→B recurring (100 metal a-side, 50 gold b-side), accept as B,
 *  commission both legs. Returns the agreement id. */
async function strikeDeal(h) {
  const { env, DB, G, A, B, routes } = h;
  const proposeRes = await callRoute(env, routes, 'POST', `/api/games/${G}/trades`, 'uA', {
    responder_faction_id: B.id,
    offer: { metal: 100 }, request: { gold: 50 },
    recurring: true,
  });
  const trade = (await readJson(proposeRes)).trade;
  if (!trade?.id) throw new Error('propose failed: ' + JSON.stringify(trade));
  const acceptRes = await callRoute(env, routes, 'POST', `/api/games/${G}/trades/${trade.id}/accept`, 'uB', {});
  const acc = await readJson(acceptRes);
  if (acc.error) throw new Error('accept failed: ' + JSON.stringify(acc));

  const ag = await DB.prepare('SELECT * FROM trade_agreements WHERE game_id = ?').bind(G).first();
  if (!ag) throw new Error('no agreement row after accept');

  for (const [uid, f, partner] of [['uA', A, B], ['uB', B, A]]) {
    const opts = await readJson(await callRoute(
      env, routes, 'GET', `/api/games/${G}/trade-agreements/${ag.id}/options`, uid, null));
    const ship = opts.freighters[0];
    const dest = opts.targets[0];
    if (!ship || !dest) throw new Error(`${uid} has no commission options: ${JSON.stringify(opts)}`);
    const res = await readJson(await callRoute(
      env, routes, 'POST', `/api/games/${G}/trade-agreements/${ag.id}/commission`, uid,
      { ship_id: ship.id, dest_body_id: dest.body_id }));
    if (res.error) throw new Error(`${uid} commission failed: ${JSON.stringify(res)}`);
  }
  return ag.id;
}

const pools = async (DB, G) => (await DB.prepare(
  `SELECT id, metal, gold FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;

// ============================================================
// 1. THE LOOP LOOPS. Two full round trips, hands off.
// ============================================================
{
  const h = await seedPair('loop');
  const agId = await strikeDeal(h);
  const before = await pools(h.DB, h.G);

  // Earth↔Luna is a short hop but pickup/flight/delivery still spend
  // ticks. 40 is generous headroom — the assertion is on loop COUNT, so
  // slack here costs milliseconds, not correctness.
  await h.tick(40);

  const legs = (await h.DB.prepare(
    `SELECT owner_faction_id, loops_completed, cancelled_at_tick FROM game_trade_routes
      WHERE game_id = ? AND agreement_id = ?`).bind(h.G, agId).all()).results;
  const byOwner = new Map(legs.map(l => [l.owner_faction_id, l]));
  const aLoops = Number(byOwner.get(h.A.id)?.loops_completed ?? 0);
  const bLoops = Number(byOwner.get(h.B.id)?.loops_completed ?? 0);
  check('A leg completed at least 2 runs', aLoops >= 2, `loops=${aLoops}`);
  check('B leg completed at least 2 runs', bLoops >= 2, `loops=${bLoops}`);
  check('neither leg was cancelled', legs.every(l => l.cancelled_at_tick == null),
    JSON.stringify(legs));

  // The LEDGER is the run log, not the wallets: capital cities harvest
  // into both pools every tick, so a raw before/after wallet delta mixes
  // trade with farming and asserts nothing (first draft of this test
  // did exactly that and failed on healthy behaviour). Every run writes
  // gross + net to the chronicle; the books must balance there.
  const runLog = (await h.DB.prepare(
    `SELECT payload, visibility FROM chronicle_entries WHERE game_id = ? AND kind = 'trade_route_run'`)
    .bind(h.G).all()).results;
  const runs = runLog.map(r => JSON.parse(r.payload));
  const aRuns = runs.filter(r => r.sender_faction_id === h.A.id);
  check('every A run shipped the contracted 100 metal, no tariff skim',
    aRuns.length === aLoops
      && aRuns.every(r => r.gross?.metal === 100 && r.delivered?.metal === 100 && r.tariff_pct === 0),
    JSON.stringify(aRuns[0] ?? null));
  const after = await pools(h.DB, h.G);
  // Wallet floor: B banked AT LEAST the delivered metal (harvest only
  // adds). Catches a delivery that logs but never credits.
  const bMetalGained = after[1].metal - before[1].metal;
  const deliveredToB = aRuns.reduce((s, r) => s + (r.delivered?.metal ?? 0), 0);
  check('B\'s wallet grew by at least everything the log says landed',
    bMetalGained >= deliveredToB,
    `gained=${bMetalGained}, logged=${deliveredToB}`);
  check('one log line per completed run', runLog.length === aLoops + bLoops,
    `log=${runLog.length}, runs=${aLoops + bLoops}`);
  check('run log is scoped to the two parties, not public',
    runLog.every(r => {
      try {
        const v = JSON.parse(r.visibility);
        return Array.isArray(v) && v.length === 2;
      } catch { return false; }
    }),
    runLog[0]?.visibility);
}

// ============================================================
// 2. STARVATION ends the WHOLE deal, both legs, with a notice.
// ============================================================
{
  const h = await seedPair('starve');
  const agId = await strikeDeal(h);
  await h.tick(2); // let the routes start moving

  // A can no longer cover its 100-metal runs.
  await h.DB.prepare(`UPDATE game_factions SET metal = 3 WHERE id = ?`).bind(h.A.id).run();
  await h.tick(25);

  const ag = await h.DB.prepare('SELECT * FROM trade_agreements WHERE id = ?').bind(agId).first();
  check('agreement ended', ag.status === 'ended', ag.status);
  check("reason is 'starved'", ag.ended_reason === 'starved', ag.ended_reason);

  const legs = (await h.DB.prepare(
    `SELECT owner_faction_id, cancelled_at_tick FROM game_trade_routes
      WHERE agreement_id = ?`).bind(agId).all()).results;
  check('BOTH legs stopped — including the solvent side\'s',
    legs.length === 2 && legs.every(l => l.cancelled_at_tick != null),
    JSON.stringify(legs));

  const endLog = await h.DB.prepare(
    `SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'trade_agreement_ended'`)
    .bind(h.G).first();
  check('ending was logged', !!endLog, 'no trade_agreement_ended entry');
}

// ============================================================
// 3. WAR. The pair exchange fire; the deal dies the same tick.
// ============================================================
{
  const h = await seedPair('war');
  const agId = await strikeDeal(h);
  await h.tick(2);

  // Stage a battle: one warship from each side at the same body. No
  // pact exists between the pair, so co-located hostiles open fire —
  // this exercises the REAL §3.41 wiring (damage maps → pairs →
  // endAgreementsForCombat), not a unit-called shortcut.
  for (const [id, f] of [['warA', h.A], ['warB', h.B]]) {
    await h.DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
       VALUES (?, ?, ?, ?, 'corvette', ?,
               2, 2, 0, 0, 0, 1,
               999, 999, 'active', 0, 200, 200, 8)`,
    ).bind(id, h.G, f.id, `Warship ${id}`, h.A.capital_body_id).run();
  }
  await h.tick(3);

  const ag = await h.DB.prepare('SELECT * FROM trade_agreements WHERE id = ?').bind(agId).first();
  check('shots exchanged ended the agreement', ag.status === 'ended', ag.status);
  check("reason is 'war'", ag.ended_reason === 'war', ag.ended_reason);
}

// ============================================================
// 4. A DEAD FREIGHTER ends the deal.
// ============================================================
{
  const h = await seedPair('shiploss');
  const agId = await strikeDeal(h);
  await h.tick(2);

  await h.DB.prepare(
    `UPDATE game_ships SET status = 'destroyed', hp = 0, destroyed_at_tick = ? WHERE id = 'shA'`)
    .bind(h.tickOf()).run();
  await h.tick(2);

  const ag = await h.DB.prepare('SELECT * FROM trade_agreements WHERE id = ?').bind(agId).first();
  check('losing a pinned freighter ended the agreement', ag.status === 'ended', ag.status);
  check("reason is 'ship_lost'", ag.ended_reason === 'ship_lost', ag.ended_reason);
}

// ============================================================
// 5. EMBARGO pauses, it does NOT end. The senate freezing your trade
//    for 14 ticks must not tear up a contract that can resume.
// ============================================================
{
  const h = await seedPair('embargo');
  const agId = await strikeDeal(h);
  await h.tick(2);

  // Shaped exactly as applyBillEffects writes a passed embargo bill —
  // slider_id/value are NOT NULL legacies of the table's slider origins.
  await h.DB.prepare(
    `INSERT INTO senate_effects
       (id, game_id, slider_id, value, effect_kind, target_faction_id,
        active_from_tick, active_until_tick, created_at_tick, created_at_ms)
     VALUES ('emb1', ?, 'trade_embargo', 0, 'trade_embargo', ?, ?, ?, ?, 0)`)
    .bind(h.G, h.A.id, h.tickOf(), h.tickOf() + 10, h.tickOf()).run();
  await h.tick(8);

  const ag = await h.DB.prepare('SELECT * FROM trade_agreements WHERE id = ?').bind(agId).first();
  check('embargo left the agreement standing', ag.status === 'active', `${ag.status}/${ag.ended_reason}`);

  // ...and it resumes: loops keep accruing once the embargo lapses.
  const loopsBefore = (await h.DB.prepare(
    `SELECT SUM(loops_completed) s FROM game_trade_routes WHERE agreement_id = ?`).bind(agId).first())?.s ?? 0;
  await h.tick(25);
  const loopsAfter = (await h.DB.prepare(
    `SELECT SUM(loops_completed) s FROM game_trade_routes WHERE agreement_id = ?`).bind(agId).first())?.s ?? 0;
  check('runs resumed after the embargo lapsed', Number(loopsAfter) > Number(loopsBefore),
    `before=${loopsBefore} after=${loopsAfter}`);
}

// ============================================================
// 6. CANCEL from either side stops both legs.
// ============================================================
{
  const h = await seedPair('cancel');
  const agId = await strikeDeal(h);
  await h.tick(2);

  // B cancels a deal A proposed — either party may.
  const res = await readJson(await callRoute(
    h.env, h.routes, 'POST', `/api/games/${h.G}/trade-agreements/${agId}/cancel`, 'uB', {}));
  check('cancel succeeded', res.ok === true, JSON.stringify(res));

  const ag = await h.DB.prepare('SELECT * FROM trade_agreements WHERE id = ?').bind(agId).first();
  check("reason is 'cancelled'", ag.ended_reason === 'cancelled', ag.ended_reason);
  const legs = (await h.DB.prepare(
    `SELECT cancelled_at_tick FROM game_trade_routes WHERE agreement_id = ?`).bind(agId).all()).results;
  check('both legs stopped on cancel', legs.every(l => l.cancelled_at_tick != null), JSON.stringify(legs));

  // No zombie freighter still hauling: the run LOG must go silent.
  // (Wallets keep moving after cancellation — harvest — so the log is
  // the only clean signal that trade specifically has stopped.)
  const runsBefore = (await h.DB.prepare(
    `SELECT COUNT(*) c FROM chronicle_entries WHERE game_id = ? AND kind = 'trade_route_run'`)
    .bind(h.G).first())?.c ?? 0;
  await h.tick(6);
  const runsAfter = (await h.DB.prepare(
    `SELECT COUNT(*) c FROM chronicle_entries WHERE game_id = ? AND kind = 'trade_route_run'`)
    .bind(h.G).first())?.c ?? 0;
  check('no further runs after cancellation', runsBefore === runsAfter,
    `${runsBefore} -> ${runsAfter}`);
}

console.log('');
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('standing routes loop, and everything that should stop them stops them');
