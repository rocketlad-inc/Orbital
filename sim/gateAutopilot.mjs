// ============================================================
// THE GATE AUTOPILOT — a leg through a gate flies at the gate's price,
// however it was ordered (room.js gateAutopilot).
//
// The NEXT Zone, 2026-10-09: a colony ship chained "Centauri Gate, then
// Sol Gate" reached the gate and flew the rest at the ordinary burn,
// 156 T instead of 16, because only the LAUNCH TO button crossed. Lorne:
// make the transition through the gate dummy proof.
//
// A real game through the REAL resolveTick, gates squeezed to tick 5:
//   A. parked on the gate, ordered to its far end: the crossing.
//   B. a chain gate -> far gate -> a far world: crossing, and the last
//      leg slides up behind it.
//   C. ordered straight from Earth to a far world: re-routed through.
//   D. coming home: a far world to Earth goes back through it too.
//   E. what it must leave alone: a Mega Destroyer, a short hop, a trade
//      leg, and anything before the gate has landed.
//
// Run: node sim/gateAutopilot.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { gateOrder, solGateId, farGateId } from '../worker/sunGates.js';
import { gateTransitTicks } from '../worker/megastructures.js';
import { makeRouteMath } from '../worker/routeMath.js';
import { invalidate } from '../worker/gameConfig.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const LIVE = { far_systems: 1, system_scale: 4, moon_scale: 8, body_scale: 2, outer_orbit_speedup: 4 };
const G = 'gauto';
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const now = Date.now();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u1','u1@t','u1','x',?)`).bind(now).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Auto','u1',?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?,'setup','auto',0,3600000,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
await DB.prepare(`INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (?, 'a', 'archived', ?, 0, 0)`)
  .bind(`cfg_${G}`, JSON.stringify({ ...LIVE, sun_gate_start: 5, sun_gate_end: 5, sun_gate_interval: 10 })).run();
await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${G}`, G).run();
invalidate(G);
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
const fA = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first()).id;

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
let T = 0;
const run = async (t) => {
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
  await room.resolveTick(G, t);
  T = t;
};

const sys = gateOrder(G)[0];
const near = solGateId(G, sys);
const far = farGateId(G, sys);
const earth = `${G}:earth`;
const bary = (await DB.prepare('SELECT id FROM game_bodies WHERE game_id = ? AND template_id = ?')
  .bind(G, sys.barycenter).first()).id;
const farWorld = (await DB.prepare(
  `SELECT id, name FROM game_bodies WHERE parent_body_id = ? AND type IN ('terrestrial','dwarf','gas_giant','ice_giant')
    ORDER BY orbit_radius DESC LIMIT 1`).bind(bary).first());

let n = 0;
const ship = async (name, at, cls = 'colony') => {
  const id = `${G}:sh${n++}`;
  await DB.prepare(
    `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
       orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
       fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
     VALUES (?,?,?,?,?,?, 2,2,0,0,0,1, 99,99,'active',0, 300,300,10)`,
  ).bind(id, G, fA, name, cls, at).run();
  return id;
};
// A leg as the client posts it: the ordinary burn, booked at the
// ordinary price.
const rm = makeRouteMath(DB, G);
const leg = async (shipId, seq, from, to, sched, idTag = 'n') => {
  const ticks = await rm.computeLegTicks(fA, from, to, sched);
  const id = `${shipId}:${idTag}${seq}`;
  await DB.prepare(
    `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
       scheduled_t, arrival_at_tick, fuel_cost, launch_x, launch_y, accel, flip_tick, status, committed_at_tick)
     VALUES (?,?,?,?,'absolute',?,?,?,0, 1, 1, 10.6, ?, 'committed', ?)`,
  ).bind(id, G, shipId, seq, to, sched, sched + ticks, sched + ticks / 2, sched).run();
  return { id, arrive: sched + ticks, ticks };
};
const nodes = async (shipId) => (await DB.prepare(
  `SELECT id, sequence, target_body_id, scheduled_t, arrival_at_tick, status, launch_x, accel, flip_tick
     FROM game_ship_nodes WHERE ship_id = ? ORDER BY sequence`).bind(shipId).all()).results ?? [];

// ---- E (before): nothing is rewritten before a gate exists ----------
let early = null;
{
  const s = await ship('Early', earth);
  const l = await leg(s, 0, earth, `${G}:neptune`, 1);
  early = { s, l };
}
for (let t = 1; t <= 4; t++) await run(t);
{
  const [x] = await nodes(early.s);
  check('before any gate: a long leg flies exactly as ordered',
    x.target_body_id === `${G}:neptune` && x.arrival_at_tick === early.l.arrive, JSON.stringify(x));
}

// Run until the first gate lands.
const g0 = await (async () => {
  for (let t = 5; t < 80; t++) {
    await run(t);
    const r = await DB.prepare('SELECT emerge_until_tick FROM game_bodies WHERE id = ?').bind(near).first();
    if (r && r.emerge_until_tick != null && r.emerge_until_tick <= t) return t;
  }
  return null;
})();
check(`the ${sys.label} gate lands`, g0 != null, String(g0));

// ---- A: parked on the gate, ordered to its far end -------------------
const A = await ship('Speedwell', near);
const aLeg = await leg(A, 0, near, far, T + 1);
check('(the ordinary burn across is long)', aLeg.ticks > 60, `${aLeg.ticks} T`);

// ---- B: a chain through, ending on a far world ----------------------
const B = await ship('Chain', near);
const b0 = await leg(B, 0, near, far, T + 1);
const b1 = await leg(B, 1, far, farWorld.id, b0.arrive);

// ---- C: straight from Earth to a far world --------------------------
const C = await ship('Direct', earth);
const c0 = await leg(C, 0, earth, farWorld.id, T + 1);
const cAfter = await leg(C, 1, farWorld.id, far, c0.arrive);   // a stop after it

// ---- D: coming home ------------------------------------------------
const D = await ship('Home', farWorld.id);
const d0 = await leg(D, 0, farWorld.id, earth, T + 1);

// ---- E: what it leaves alone -----------------------------------------
const E1 = await ship('Death Star', near, 'mega_destroyer');
const e1 = await leg(E1, 0, near, far, T + 1);
const E2 = await ship('Hopper', earth);
const e2 = await leg(E2, 0, earth, `${G}:mars`, T + 1);
const E3 = await ship('Freighter', near, 'freighter');
const e3 = await leg(E3, 0, near, far, T + 1, 'tr');

const before = await DB.prepare(`SELECT COUNT(*) AS c FROM chronicle_entries WHERE game_id = ? AND kind = 'gate_transit'`).bind(G).first();
await run(T + 1);
const fly = T;

{
  const [x] = await nodes(A);
  const expect = fly + gateTransitTicks(await rm.computeLegTicks(fA, near, far, fly), 0.1);
  check('A. parked on the gate and sent to its far end, it CROSSES: a tenth of the burn',
    x.status === 'in_transit' && x.arrival_at_tick === expect && x.target_body_id === far,
    `${JSON.stringify(x)} expected ${expect}`);
  check(`...${aLeg.ticks} T becomes ${expect - fly} T`, expect - fly <= Math.ceil(aLeg.ticks / 10) + 1);
  check('...with a launch plan that lands on that arrival',
    x.launch_x != null && x.accel > 0 && x.flip_tick > fly && x.flip_tick < x.arrival_at_tick, JSON.stringify(x));
  const after = await DB.prepare(`SELECT COUNT(*) AS c FROM chronicle_entries WHERE game_id = ? AND kind = 'gate_transit'`).bind(G).first();
  const row = await DB.prepare(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'gate_transit' ORDER BY tick_number LIMIT 1`).bind(G).first();
  check('...and the crossing is on the record, like the button\'s',
    after.c - before.c >= 2 && JSON.parse(row.payload).sun_gate === true && JSON.parse(row.payload).to_system === sys.label,
    `${after.c - before.c} rows, ${row?.payload}`);
}
{
  const [x0, x1] = await nodes(B);
  check('B. a chain through the gate: the crossing first',
    x0.status === 'in_transit' && x0.arrival_at_tick < b0.arrive - 30, JSON.stringify(x0));
  check('...and the onward leg slides up to leave when it lands',
    x1.status === 'committed' && x1.scheduled_t === x0.arrival_at_tick
      && x1.arrival_at_tick - x1.scheduled_t === b1.ticks,
    `${JSON.stringify(x1)} (was ${b0.arrive} -> ${b1.arrive})`);
  check('...re-aimed from where it will really leave', x1.launch_x !== 1, String(x1.launch_x));
}
{
  const xs = await nodes(C);
  const live = xs.filter(x => x.status !== 'cancelled');
  check('C. Earth straight to a far world goes through the gate: to the gate first',
    live[0].target_body_id === near && live[0].status === 'in_transit', JSON.stringify(live[0]));
  check('...then across, then on, then the stop after it, in order',
    live.length === 4 && live[1].target_body_id === far && live[2].target_body_id === farWorld.id
      && live[3].target_body_id === far && live.every((x, i) => x.sequence === i),
    JSON.stringify(live.map(x => [x.sequence, x.target_body_id.split(':')[1], x.scheduled_t, x.arrival_at_tick])));
  check('...each leg leaving when the last one lands',
    live[1].scheduled_t === live[0].arrival_at_tick && live[2].scheduled_t === live[1].arrival_at_tick
      && live[3].scheduled_t === live[2].arrival_at_tick);
  check(`...far sooner: ${live[2].arrival_at_tick - fly} T instead of ${c0.ticks} T`,
    live[2].arrival_at_tick - fly < c0.ticks - 20);
  check('...and the stop after it keeps its own length', live[3].arrival_at_tick - live[3].scheduled_t === cAfter.ticks,
    `${live[3].arrival_at_tick - live[3].scheduled_t} vs ${cAfter.ticks}`);
  // Fly it all the way, and the gate legs are planned as they go.
  for (let t = T + 1; t <= live[2].arrival_at_tick + 1; t++) await run(t);
  const done = (await nodes(C)).filter(x => x.status !== 'cancelled');
  check('...flown out, every leg landed on time',
    done.slice(0, 3).every(x => x.status === 'executed'), JSON.stringify(done.map(x => [x.status, x.arrival_at_tick])));
  check('...the crossing really took a tenth',
    done[1].arrival_at_tick - done[1].scheduled_t <= Math.ceil(aLeg.ticks / 10) + 2,
    `${done[1].arrival_at_tick - done[1].scheduled_t} T`);
  const sh = await DB.prepare('SELECT parent_body_id FROM game_ships WHERE id = ?').bind(C).first();
  check('...and the colony ship is at the far world', sh.parent_body_id === farWorld.id || done[3].status !== 'committed',
    sh.parent_body_id);
}
{
  const live = (await nodes(D)).filter(x => x.status !== 'cancelled');
  check('D. coming home goes back through it: to the far gate, across, on to Earth',
    live.map(x => x.target_body_id).join() === [far, near, earth].join(),
    live.map(x => x.target_body_id).join());
}
{
  const [x1] = await nodes(E1);
  const [x2] = await nodes(E2);
  const [x3] = await nodes(E3);
  check('E. a Mega Destroyer does not fit: flies the whole way', x1.arrival_at_tick === e1.arrive, JSON.stringify(x1));
  check('...a short hop inside Sol is never touched', x2.target_body_id === `${G}:mars` && x2.arrival_at_tick === e2.arrive);
  check('...nor a trade leg, which plans its own gates', x3.arrival_at_tick === e3.arrive);
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
