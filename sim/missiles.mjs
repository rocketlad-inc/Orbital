// ============================================================================
// MISSILES (worker/missiles.js) — the silo, on the REAL seeder, routes and
// tick (Lorne, 2026-10-19).
//
//   1. ordering: paid on order (40+40 each), one builds at a time, the
//      magazine caps at 5 per level, cancelling refunds
//   2. building: a missile lands in the magazine 12 ticks after it starts
//   3. launching: a salvo flies to a world in the same star system; never
//      its own world; never more than are ready
//   4. impact: 10 damage per missile to EVERY ship in that orbit, friend or
//      foe, stacking; the salvo is spent, not "destroyed"
//   5. auto-defence MISSILES: incoming salvos shot down one for one, above
//      the reserve; what gets through still lands
//   6. auto-defence + FLEETS: hostile ships landing on the silo's world are
//      hit (the silo's salvo size), but never while its own ships are there
//   7. intercepts in flight: a salvo meets a group on the way and bursts;
//      every hull within 40 units takes 10 per missile, friend or foe;
//      + FLEETS launches one salvo per hostile group bound for its world
//
// Run: node sim/missiles.mjs
// ============================================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { missileTicks, MISSILE_REF_ACCEL } from '../worker/missiles.js';
import { legTicks } from '../worker/burn.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gmissiles1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Missiles','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','missile-seed',100,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'venus')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
const [A, B] = (await DB.prepare(`SELECT id, user_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
await DB.prepare('UPDATE game_factions SET metal = 5000, gold = 5000 WHERE game_id = ?').bind(G).run();
await DB.prepare(`INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick)
                  VALUES ('w1', ?, ?, ?, ?, 90)`).bind(G, A.id < B.id ? A.id : B.id, A.id < B.id ? B.id : A.id, A.id).run()
  .catch(e => console.log('war row:', e.message));

const EARTH = `${G}:earth`, VENUS = `${G}:venus`, MARS = `${G}:mars`;
const cityOf = async (bodyId) => DB.prepare(`SELECT * FROM game_settlements WHERE game_id = ? AND body_id = ? AND type = 'city'`).bind(G, bodyId).first();
let cityA = await cityOf(EARTH);
let cityB = await cityOf(VENUS);
check('both capitals have a surface city', !!cityA && !!cityB, JSON.stringify({ a: cityA?.id, b: cityB?.id }));
await DB.prepare(`UPDATE game_settlements SET buildings_json = '{"missile_silo":2}' WHERE id = ?`).bind(cityA.id).run();
await DB.prepare(`UPDATE game_settlements SET buildings_json = '{"missile_silo":1}' WHERE id = ?`).bind(cityB.id).run();

const M = await import('../worker/missiles.js');
async function call(user, method, path, body) {
  const pathname = path.split('?')[0];
  const r = M.routes.find(x => x.method === method && x.pattern.test(pathname));
  const m = r.pattern.exec(pathname);
  const req = new Request(`https://x${path}`, { method, body: body ? JSON.stringify(body) : undefined });
  const res = await r.handle(req, env, { params: m.groups, session: { user_id: user } });
  return { status: res.status, body: await res.json() };
}
const silo = (c) => `/api/games/${G}/settlements/${encodeURIComponent(c.id)}/missiles`;
const pool = async (f) => DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(f.id).first();

// ---- 1. ordering --------------------------------------------------------
const before = await pool(A);
const o1 = await call(A.user_id, 'POST', silo(cityA), { count: 3 });
const after = await pool(A);
check('ordering 3 missiles charges 120 metal + 120 credits at once', o1.status === 200
  && before.metal - after.metal === 120 && before.gold - after.gold === 120, JSON.stringify({ o1, before, after }));
check('...a level-2 silo builds two at once (12 ticks), the third waits', o1.body.orders?.length === 3
  && o1.body.orders[0].complete_tick === 112 && o1.body.orders[1].complete_tick === 112
  && o1.body.orders[2].start_tick === null, JSON.stringify(o1.body.orders));
{
  // A freed line takes the next order waiting, in the order placed.
  const q3 = [{ id: 'a', ticks: 12, start_tick: 100, complete_tick: 112 }, { id: 'b', ticks: 12, start_tick: null }, { id: 'c', ticks: 12, start_tick: null }];
  const after = M.fillLines(q3.slice(1), 2, 112);
  check('build lines: one per silo level; a freed line starts the next order waiting',
    M.siloLines(3) === 3 && M.siloLines(0) === 1
    && after[0].start_tick === 112 && after[0].complete_tick === 124 && after[1].start_tick === 112
    && M.fillLines(q3, 1, 105)[1].start_tick == null, JSON.stringify(after));
}
check('the magazine caps orders: a level-2 silo (10) refuses 8 more', (await call(A.user_id, 'POST', silo(cityA), { count: 8 })).status === 409);
check('a rival cannot order at your silo', (await call(B.user_id, 'POST', silo(cityA), { count: 1 })).status === 403);
const waitingId = o1.body.orders[2].id;
const p0 = await pool(A);
const c1 = await call(A.user_id, 'DELETE', `${silo(cityA)}?order_id=${waitingId}`);
const p1 = await pool(A);
check('cancelling a waiting missile refunds it in full', c1.status === 200 && p1.metal - p0.metal === 40 && p1.gold - p0.gold === 40
  && c1.body.orders.length === 2, JSON.stringify({ c1: c1.body, p0, p1 }));

// ---- 2. building ---------------------------------------------------------
const store = new Map();
const { Room } = await import('../worker/room.js');
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  broadcast: () => {},
}, env);
let tick = 100;
async function runTick() {
  tick += 1;
  await room.resolveTick(G, tick);
  await DB.prepare('UPDATE games SET current_tick=? WHERE id=?').bind(tick, G).run();
}
while (tick < 111) await runTick();
check('nothing is ready before its 12 ticks', Number((await cityOf(EARTH)).missile_stock) === 0);
await runTick(); // 112
cityA = await cityOf(EARTH);
const q = JSON.parse(cityA.missile_orders_json);
check('at tick 112 both missiles land in the magazine together',
  Number(cityA.missile_stock) === 2 && q.length === 0,
  JSON.stringify({ stock: cityA.missile_stock, q }));

// ---- 3. launching ---------------------------------------------------------
let shipN = 0;
async function park(owner, bodyId, cls, hp) {
  const id = `${G}:t${shipN++}`;
  await DB.prepare(
    `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id, status,
       orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
       fuel, fuel_max, hp, hp_max, damage_per_tick, built_at_tick, home_body_id, stance)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 6, 6, 0, 0, 0, 1, 300, 300, ?, ?, 0, 0, ?, 'hold')`,
  ).bind(id, G, owner, `${cls} ${shipN}`, cls, bodyId, hp, hp, bodyId).run();
  return id;
}
const hpOf = async (id) => DB.prepare('SELECT hp, status FROM game_ships WHERE id = ?').bind(id).first();
await DB.prepare('UPDATE game_settlements SET missile_stock = 8, missile_orders_json = NULL WHERE id = ?').bind(cityA.id).run();
const bc = [await park(B.id, MARS, 'corvette', 40), await park(B.id, MARS, 'corvette', 40), await park(B.id, MARS, 'corvette', 40)];
const bf = await park(B.id, MARS, 'frigate', 270);
const mine = await park(A.id, MARS, 'corvette', 40);
check('a silo cannot fire at its own world', (await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_body_id: EARTH, count: 1 })).status === 400);
check('nor more missiles than are ready', (await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_body_id: MARS, count: 9 })).status === 409);
const L1 = await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_body_id: MARS, count: 4 });
const salvo = await DB.prepare('SELECT * FROM game_ships WHERE id = ?').bind(L1.body.ship_id).first();
const node = await DB.prepare('SELECT * FROM game_ship_nodes WHERE ship_id = ?').bind(L1.body.ship_id).first();
check('a salvo of 4 is in the air: one missile row, its node planned at missile speed',
  L1.status === 200 && salvo?.ship_class === 'missile' && salvo.missile_count === 4 && node?.target_body_id === MARS
  && node.accel > 0 && L1.body.ticks >= 1 && L1.body.ticks <= 12,
  JSON.stringify({ L1: L1.body, cls: salvo?.ship_class, n: salvo?.missile_count, accel: node?.accel }));
check('...and the magazine is down to 4', Number((await cityOf(EARTH)).missile_stock) === 4);
{
  // It leaves from orbit on the side facing its target, on one steady push
  // (a salvo starting at the world's centre sat on the planet, reading as parked).
  const { loadSky } = await import('../worker/flightState.js');
  const { parkOrbitRadius } = await import('../worker/factions.js');
  const { legProgress } = await import('../worker/orbitPos.js');
  const sky = await loadSky(DB, G);
  const c = sky.bodyPos(EARTH, Number(node.scheduled_t));
  const rp = parkOrbitRadius(Number(sky.byId.get(EARTH).radius));
  const off = Math.hypot(Number(node.launch_x) - c.x, Number(node.launch_y) - c.y);
  check('a salvo leaves from the parking orbit (not the world\'s centre), on one steady push',
    Math.abs(off - rp) < 1e-6 && node.accel_tau == null && node.accel_max == null && Number(node.brake_accel) === Number(node.accel)
    && Math.abs(legProgress(0.5, { accel: node.accel, brake: node.brake_accel, startTick: node.scheduled_t, flipTick: node.flip_tick, arriveTick: node.arrival_at_tick }) - 0.25) < 1e-9,
    JSON.stringify({ off, rp, tau: node.accel_tau, max: node.accel_max }));
}
// Lorne, 2026-10-20: half a two-engine hull's trip, no brake.
check('a salvo pushes the whole way: it never flips, so it never brakes',
  Number(node.flip_tick) === Number(node.arrival_at_tick), JSON.stringify({ flip: node.flip_tick, arr: node.arrival_at_tick }));
const routeTicks = [625, 2709, 4835, 19235, 28530].map(d => Math.ceil(missileTicks(d)));
check('missile trip times (Io-Callisto, Earth-Mars, Earth-Jupiter, Neptune-Pluto, Pluto-Makemake): 4 / 7 / 9 / 15 / 17 T',
  JSON.stringify(routeTicks) === JSON.stringify([4, 7, 9, 15, 17]), JSON.stringify(routeTicks));
const twoEngine = [625, 2709, 4835, 19235, 28530].map(d => Math.ceil(legTicks(d, MISSILE_REF_ACCEL)));
check('...half of a two-engine ship\'s 8 / 14 / 18 / 30 / 34 T',
  JSON.stringify(twoEngine) === JSON.stringify([8, 14, 18, 30, 34]), JSON.stringify(twoEngine));

// ---- 4. impact ------------------------------------------------------------
while (tick < L1.body.arrive_tick - 1) await runTick();
check('nothing is hit while it flies', (await hpOf(bc[0])).hp === 40 && (await hpOf(bf)).hp === 270);
await runTick();
const strike = await DB.prepare(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'missile_strike' ORDER BY tick_number DESC`).bind(G).first();
const sp = strike ? JSON.parse(strike.payload) : null;
check('on landing: 40 damage to every ship at Mars, so all three enemy corvettes die',
  (await Promise.all(bc.map(hpOf))).every(s => s.status === 'destroyed'), JSON.stringify(await Promise.all(bc.map(hpOf))));
check('...the frigate takes 40 (270 -> 230)', (await hpOf(bf)).hp === 230, JSON.stringify(await hpOf(bf)));
check('...and so does the launcher\'s own corvette: friend or foe', (await hpOf(mine)).status === 'destroyed');
check('...the salvo is spent, not destroyed, and it is news', (await hpOf(L1.body.ship_id)).status === 'expended'
  && sp?.missiles === 4 && sp.damage === 40 && sp.destroyed_count === 4, JSON.stringify(sp));
check('...and no missile ever counts as a lost ship',
  !(await DB.prepare(`SELECT 1 AS x FROM chronicle_entries WHERE kind = 'ship_destroyed' AND ship_id = ?`).bind(L1.body.ship_id).first()));

// ---- 5. auto-defence: missiles --------------------------------------------
await DB.prepare(`UPDATE game_settlements SET missile_stock = 5, missile_auto = 'missiles', missile_reserve = 1 WHERE id = ?`).bind(cityB.id).run();
const vf = [await park(B.id, VENUS, 'frigate', 270), await park(B.id, VENUS, 'frigate', 270)];
await DB.prepare('UPDATE game_settlements SET missile_stock = 8 WHERE id = ?').bind(cityA.id).run();
const L2 = await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_body_id: VENUS, count: 6 });
check('a salvo of 6 is fired at Venus', L2.status === 200, JSON.stringify(L2.body));
while (tick < L2.body.arrive_tick) await runTick();
const intc = await DB.prepare(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'missile_intercepted'`).bind(G).first();
check('Venus\'s silo shoots down 4 (5 ready, 1 kept in reserve)', intc && JSON.parse(intc.payload).count === 4
  && Number((await cityOf(VENUS)).missile_stock) === 1, JSON.stringify({ intc: intc?.payload, stock: (await cityOf(VENUS)).missile_stock }));
check('...the 2 that got through still land: 20 damage to each frigate', (await hpOf(vf[0])).hp === 250 && (await hpOf(vf[1])).hp === 250,
  JSON.stringify(await Promise.all(vf.map(hpOf))));

// ---- 6. auto-defence: + fleets ---------------------------------------------
await DB.prepare(`UPDATE game_settlements SET missile_stock = 5, missile_auto = 'fleets', missile_reserve = 0, missile_salvo = 5 WHERE id = ?`).bind(cityA.id).run();
async function sendTo(shipId, toBodyId, arrive) {
  await DB.prepare(
    `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id, scheduled_t, arrival_at_tick,
       dv_prograde, dv_normal, dv_radial, fuel_cost, status, committed_at_tick)
     VALUES (?, ?, ?, 0, 'absolute', ?, ?, ?, 0, 0, 0, 0, 'in_transit', ?)`,
  ).bind(`${shipId}:n`, G, shipId, toBodyId, tick, arrive, tick).run();
}
const raider = await park(B.id, VENUS, 'corvette', 40);
await sendTo(raider, EARTH, tick + 1);
await runTick();
check('+ FLEETS: a hostile corvette landing on an empty Earth meets a salvo of 5 (50) and dies',
  (await hpOf(raider)).status === 'destroyed' && Number((await cityOf(EARTH)).missile_stock) === 0,
  JSON.stringify({ raider: await hpOf(raider), stock: (await cityOf(EARTH)).missile_stock }));
await DB.prepare(`UPDATE game_settlements SET missile_stock = 5 WHERE id = ?`).bind(cityA.id).run();
const guard = await park(A.id, EARTH, 'frigate', 270);
const raider2 = await park(B.id, VENUS, 'corvette', 40);
await sendTo(raider2, EARTH, tick + 1);
await runTick();
check('...but never while the silo\'s own ships are in that orbit', (await hpOf(raider2)).status === 'active'
  && (await hpOf(guard)).hp === 270 && Number((await cityOf(EARTH)).missile_stock) === 5,
  JSON.stringify({ raider2: await hpOf(raider2), guard: await hpOf(guard), stock: (await cityOf(EARTH)).missile_stock }));
const ok = await call(A.user_id, 'PATCH', silo(cityA), { auto: 'off', reserve: 3 });
check('auto-defence and its reserve are the owner\'s to set', ok.status === 200 && ok.body.auto === 'off' && ok.body.reserve === 3);
check('...and an unknown mode is refused', (await call(A.user_id, 'PATCH', silo(cityA), { auto: 'everything' })).status === 400);

// ---- 7. intercepts in flight ----------------------------------------------
// Real flights: each hull's leg planned by the tick's own planner.
await DB.prepare(`UPDATE game_settlements SET missile_stock = 8, missile_auto = 'off', missile_reserve = 0 WHERE id = ?`).bind(cityA.id).run();
await DB.prepare(`DELETE FROM game_ships WHERE game_id = ? AND parent_body_id = ? AND id GLOB ?`).bind(G, EARTH, `${G}:t*`).run();
async function fly(ids, owner, from, to, arrive = null) {
  let at = arrive;
  for (const id of ids) at = Math.max(at ?? 0, await room.planLegForShip(G, tick, id, owner, from, to, arrive));
  if (arrive == null && ids.length > 1) {
    await DB.prepare(`DELETE FROM game_ship_nodes WHERE status = 'committed' AND ship_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
    for (const id of ids) await room.planLegForShip(G, tick, id, owner, from, to, at);
  }
  return at;
}
const grp = [await park(B.id, MARS, 'corvette', 40), await park(B.id, MARS, 'corvette', 40), await park(B.id, MARS, 'frigate', 270)];
const tag = await park(A.id, MARS, 'corvette', 40);       // our own hull, flying the same course
const far = await park(B.id, VENUS, 'corvette', 40);      // nowhere near
const land = await fly([...grp, tag], B.id, MARS, EARTH);
await runTick();                                          // they leave Mars
const flying = await DB.prepare(`SELECT COUNT(*) AS n FROM game_ship_nodes WHERE status = 'in_transit' AND ship_id IN (?, ?, ?, ?)`).bind(...grp, tag).first();
check('four hulls are flying Mars -> Earth on real plans', flying.n === 4 && land > tick + 3, JSON.stringify({ n: flying.n, land, tick }));
const meet = await call(A.user_id, 'GET', `/api/games/${G}/missiles/intercepts?from=${encodeURIComponent(EARTH)}&ships=${encodeURIComponent(grp[2])}`);
const m = meet.body.meet?.[grp[2]];
check('the picker gets a meeting before they land', meet.status === 200 && m && m.ticks >= 1 && m.meet_tick < land,
  JSON.stringify({ meet: meet.body, land, tick }));
check('you cannot aim at your own hull', (await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_ship_id: tag, count: 1 })).status === 400);
check('nor at a hull that is not flying', (await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_ship_id: far, count: 1 })).status === 404);
const L3 = await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_ship_id: grp[2], count: 4 });
const n3 = await DB.prepare('SELECT * FROM game_ship_nodes WHERE ship_id = ?').bind(L3.body.ship_id).first();
check('a salvo of 4 is launched at the group: a rendezvous arc on the frigate, arriving when they do',
  L3.status === 200 && n3?.rv_follow_ship_id === grp[2] && n3.rv_meet_tick > tick && n3.arrival_at_tick === land
  && Number((await cityOf(EARTH)).missile_stock) === 4, JSON.stringify({ L3: L3.body, node: n3 && { rv: n3.rv_follow_ship_id, meet: n3.rv_meet_tick, arr: n3.arrival_at_tick } }));
check('...ONE straight push to a whole-tick meeting: no second burn to match speed',
  Number(n3.rv_bx) === 0 && Number(n3.rv_by) === 0 && Number.isInteger(Number(n3.rv_meet_tick))
  && Number(n3.flip_tick) === Number(n3.rv_meet_tick),
  JSON.stringify({ B: [n3.rv_bx, n3.rv_by], meet: n3.rv_meet_tick, flip: n3.flip_tick }));
while (tick < L3.body.meet_tick - 1) await runTick();
check('nothing is hit before the meeting', (await hpOf(grp[0])).hp === 40 && (await hpOf(grp[2])).hp === 270);
await runTick();
check('at the meeting: 40 to every hull of the group (both corvettes die, the frigate 270 -> 230)',
  (await hpOf(grp[0])).status === 'destroyed' && (await hpOf(grp[1])).status === 'destroyed' && (await hpOf(grp[2])).hp === 230,
  JSON.stringify(await Promise.all(grp.map(hpOf))));
check('...our own corvette flying alongside is caught too: friend or foe', (await hpOf(tag)).status === 'destroyed', JSON.stringify(await hpOf(tag)));
check('...a hull far away is not', (await hpOf(far)).hp === 40);
const s3 = await DB.prepare(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'missile_strike' ORDER BY tick_number DESC`).bind(G).first();
const p3 = s3 ? JSON.parse(s3.payload) : null;
check('...the salvo is spent and the strike is news, marked in flight',
  (await hpOf(L3.body.ship_id)).status === 'expended' && p3?.in_flight === true && p3.missiles === 4 && p3.destroyed_count === 3,
  JSON.stringify(p3));

// Auto-intercept: + FLEETS sends its salvo size at each hostile group bound for Earth.
// (The frigate that survived the strike above is still flying at Earth: out of this test.)
await DB.prepare(`UPDATE game_ships SET status = 'destroyed', destroyed_at_tick = ? WHERE id = ?`).bind(tick, grp[2]).run();
await DB.prepare(`UPDATE game_settlements SET missile_stock = 6, missile_auto = 'fleets', missile_reserve = 1, missile_salvo = 4 WHERE id = ?`).bind(cityA.id).run();
const raid = [await park(B.id, MARS, 'corvette', 40), await park(B.id, MARS, 'corvette', 40)];
const elsewhere = [await park(B.id, EARTH, 'corvette', 40)];
const raidLand = await fly(raid, B.id, MARS, EARTH);
await fly(elsewhere, B.id, EARTH, MARS);
const salvosAt = async (ids) => (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
    WHERE s.ship_class = 'missile' AND n.rv_follow_ship_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first()).n;
let fired = 0;
for (let i = 0; i < 4 && fired === 0; i++) { await runTick(); fired = await salvosAt(raid); }
check('+ FLEETS: once the raid is catchable, one salvo of 4 goes after it (6 ready, 1 in reserve -> 2 left)',
  fired === 1 && Number((await cityOf(EARTH)).missile_stock) === 2,
  JSON.stringify({ fired, stock: (await cityOf(EARTH)).missile_stock, tick, raidLand }));
await runTick();
check('...and only one: a group already chased is not fired at again', await salvosAt(raid) === 1);
check('...ships flying AWAY from Earth are left alone', await salvosAt(elsewhere) === 0);
while (tick < raidLand - 1 && (await hpOf(raid[0])).status === 'active') await runTick();
check('...the raid is destroyed in flight, before it lands', (await hpOf(raid[0])).status === 'destroyed' && (await hpOf(raid[1])).status === 'destroyed',
  JSON.stringify({ raid: await Promise.all(raid.map(hpOf)), tick, raidLand }));
const okSalvo = await call(A.user_id, 'PATCH', silo(cityA), { salvo: 7 });
check('the auto salvo size is the owner\'s to set', okSalvo.status === 200 && okSalvo.body.salvo === 7);

// ---- 8. the list of 2026-10-20 ----------------------------------------------
// The in-flight strike above names the hull it was aimed at and where it burst,
// so the map plays the blast on that hull's drawn course, not at the world.
const s3row = await DB.prepare(`SELECT ship_id, payload FROM chronicle_entries WHERE game_id = ? AND kind = 'missile_strike' AND json_extract(payload, '$.in_flight') = 1 ORDER BY tick_number LIMIT 1`).bind(G).first();
const s3p = s3row ? JSON.parse(s3row.payload) : {};
check('an in-flight strike names its target hull and carries the meeting point',
  s3row?.ship_id === grp[2] && Number.isFinite(s3p.x) && Number.isFinite(s3p.y), JSON.stringify({ ship: s3row?.ship_id, x: s3p.x, y: s3p.y }));
// The raider is told.
const warnRow = await DB.prepare(`SELECT ship_id, visibility, payload FROM chronicle_entries WHERE game_id = ? AND kind = 'missile_inbound' AND ship_id = ?`).bind(G, grp[2]).first();
check('the raid\'s owner is told missiles will meet its ships, and nobody else is',
  !!warnRow && JSON.parse(warnRow.visibility)[0] === B.id && JSON.parse(warnRow.visibility).length === 1
  && Number(JSON.parse(warnRow.payload).meet_tick) === L3.body.meet_tick, JSON.stringify(warnRow));
// Earth -> Venus is a short hop: too quick for an interceptor that starts
// from rest to meet, so Venus shot it down as it landed. Over a long trip
// auto-defence meets the salvo in flight: Venus's silo city, moved to
// Neptune for this, against a salvo of 3 from Earth.
const intc2 = intc ? JSON.parse(intc.payload) : {};
check('a short hop is still shot down as it lands', intc2.in_flight !== true && intc2.count === 4, JSON.stringify(intc2));
{
  const FAR = `${G}:neptune`;
  await DB.prepare(`UPDATE game_settlements SET body_id = ?, missile_stock = 5, missile_auto = 'missiles', missile_reserve = 0 WHERE id = ?`).bind(FAR, cityB.id).run();
  await DB.prepare(`UPDATE game_settlements SET missile_stock = 3 WHERE id = ?`).bind(cityA.id).run();
  const L5 = await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_body_id: FAR, count: 3 });
  let caught = null;
  while (tick < L5.body.arrive_tick && !caught) {
    await runTick();
    caught = await DB.prepare(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'missile_intercepted' AND json_extract(payload, '$.in_flight') = 1`).bind(G).first();
  }
  const cp = caught ? JSON.parse(caught.payload) : {};
  check('over a long trip, auto-defence (MISSILES) meets the incoming salvo IN FLIGHT, one for one',
    cp.count === 3 && cp.got_through === 0 && Number((await cityOf(FAR)).missile_stock) === 2
    && (await hpOf(L5.body.ship_id)).status === 'expended' && tick < L5.body.arrive_tick,
    JSON.stringify({
      cp, stock: (await cityOf(FAR))?.missile_stock, salvo: await hpOf(L5.body.ship_id), tick, arrive: L5.body.arrive_tick,
      log: (await DB.prepare(`SELECT tick_number, kind, payload FROM chronicle_entries WHERE game_id = ? AND kind LIKE 'missile%' AND tick_number >= ? ORDER BY tick_number`).bind(G, L5.body.arrive_tick - 12).all()).results,
      interceptors: (await DB.prepare(`SELECT s.id, s.status, s.missile_count, n.status AS ns, n.scheduled_t, n.rv_meet_tick, n.arrival_at_tick FROM game_ships s JOIN game_ship_nodes n ON n.ship_id = s.id WHERE n.rv_follow_ship_id = ?`).bind(L5.body.ship_id).all()).results,
    }));
  await DB.prepare(`UPDATE game_settlements SET body_id = ?, missile_auto = 'off' WHERE id = ?`).bind(VENUS, cityB.id).run();
}
// The blast check that keeps auto-defence off your own fleet.
{
  const { loadFlights } = await import('../worker/flightState.js');
  const F = await loadFlights(DB, G);
  const parkedNow = await M.loadParked(DB, G);
  const homeShip = await park(A.id, EARTH, 'frigate', 270);
  const parked2 = [...parkedNow, { id: homeShip, owner_faction_id: A.id, hp: 270, parent_body_id: EARTH, name: 'x', ship_class: 'frigate' }];
  const e = F.sky.bodyPos(EARTH, tick);
  const atEarth = M.blastVictims(F, parked2, e, tick).some(v => v.id === homeShip);
  const offEarth = M.blastVictims(F, parked2, { x: e.x + 60, y: e.y }, tick).some(v => v.id === homeShip);
  check('a burst within 40 of a world catches the fleet parked there; 60 out it does not', atEarth && !offEarth,
    JSON.stringify({ atEarth, offEarth }));
  await DB.prepare(`UPDATE game_ships SET status = 'destroyed' WHERE id = ?`).bind(homeShip).run();
}
// A Gravity Sink re-times a raid after a salvo is aimed at it: the salvo is
// re-aimed and still meets it.
await DB.prepare(`UPDATE game_settlements SET missile_stock = 6, missile_auto = 'off', missile_reserve = 0 WHERE id = ?`).bind(cityA.id).run();
const held = [await park(B.id, MARS, 'corvette', 40)];
const heldLand = await fly(held, B.id, MARS, EARTH);
await runTick();
const L4 = await call(A.user_id, 'POST', `${silo(cityA)}/launch`, { target_ship_id: held[0], count: 4 });
const n4a = await DB.prepare('SELECT rv_meet_tick, launch_x FROM game_ship_nodes WHERE ship_id = ?').bind(L4.body.ship_id).first();
await DB.prepare(`UPDATE game_ship_nodes SET arrival_at_tick = arrival_at_tick + 25, sink_held_until_tick = ? WHERE ship_id = ? AND status = 'in_transit'`)
  .bind(tick + 25, held[0]).run();
await runTick();
const n4b = await DB.prepare('SELECT rv_meet_tick, launch_x FROM game_ship_nodes WHERE ship_id = ?').bind(L4.body.ship_id).first();
{
  // Re-aimed exactly when the hold moved the raid off the salvo's aim.
  const { loadFlights } = await import('../worker/flightState.js');
  const F = await loadFlights(DB, G);
  const n = await DB.prepare('SELECT * FROM game_ship_nodes WHERE ship_id = ?').bind(L4.body.ship_id).first();
  const { rendezvousStateAt } = await import('../src/physics/rendezvous.js');
  const aim = rendezvousStateAt({
    p0: { x: n.launch_x, y: n.launch_y }, v0: { x: n.launch_vx, y: n.launch_vy }, accel: n.accel,
    A: { x: n.rv_ax, y: n.rv_ay }, B: { x: n.rv_bx, y: n.rv_by }, startTick: n.scheduled_t, meetTick: n.rv_meet_tick,
  }, n.rv_meet_tick, null).pos;
  const there = F.stateAt(held[0], n.rv_meet_tick)?.pos;
  const off = there ? Math.hypot(there.x - aim.x, there.y - aim.y) : Infinity;
  check('after a Gravity Sink re-times the raid, the salvo\'s aim is still on it (re-aimed if it had to be)',
    L4.status === 200 && off <= M.MISSILE_BLAST_RADIUS / 2,
    JSON.stringify({ off, reaimed: Number(n4b.launch_x) !== Number(n4a.launch_x), n4a, n4b }));
}
while (tick < Number(n4b.rv_meet_tick) && (await hpOf(held[0])).status === 'active') await runTick();
check('...and still meets it', (await hpOf(held[0])).status === 'destroyed', JSON.stringify({ held: await hpOf(held[0]), tick, heldLand }));
// (LAUNCH on the inbound alert, notifyActions 'intercept', calls the launch route
// tested above as the signed-in player; that module needs the worker bundle.)

console.log(bad === 0 ? '\nALL MISSILE CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
