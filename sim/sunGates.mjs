// ============================================================
// THE SUN GATES — the way in to the far systems, driven end to end.
//
// Lorne, 2026-10-06: between tick 250 and 300 everyone hears that
// "something strange is emerging from the sun"; six ticks later a gate
// leaves it at 2g and stops at a random place in the Far Reach; forty
// ticks later, the second. Random order, spread landing points, a twin
// just past each far system's outermost world, a tenth of the burn to
// cross, neutral and unbreakable, and only the main system counting for
// conquest and the senate.
//
// Seeds a real game through seedGameWorld with the window squeezed to
// tick 5, runs advanceSunGates tick by tick, and checks every row it
// leaves behind. Then the pure rules, and the production guard.
//
// Run: node sim/sunGates.mjs
// ============================================================

import { seedGameWorld, FAR_SYSTEM_IDS } from '../worker/factions.js';
import {
  advanceSunGates, settleOmenTick, rollOmenTick, gateOrder, sunGatePlan,
  emergeFlightTicks, farReachBand, pickBearing, seededRand, siteId,
  FAR_SYSTEM_TEMPLATE_IDS, SUN_GATE_TRANSIT_FRACTION, solGateId, farGateId,
  SUN_GATE_SYSTEMS, isFarSystemBody, mainSystemSql,
} from '../worker/sunGates.js';
import { summarizeSystems, voteWeights } from '../worker/systems.js';
import { gateTransitTicks } from '../worker/megastructures.js';
import { planGateAwareHop } from '../worker/routeMath.js';
import { orbitAngle } from '../worker/orbitPos.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// ---- 1. The pure rules ------------------------------------------------
check('the far-system id list matches the catalogue flags',
  FAR_SYSTEM_TEMPLATE_IDS.size === FAR_SYSTEM_IDS.size
  && [...FAR_SYSTEM_IDS].every(id => FAR_SYSTEM_TEMPLATE_IDS.has(id)),
  `${[...FAR_SYSTEM_IDS].filter(id => !FAR_SYSTEM_TEMPLATE_IDS.has(id))}`);

const conf = {};
const rolls = Array.from({ length: 400 }, (_, i) => rollOmenTick(`g${i}`, conf));
check('the omen lands between tick 250 and 300',
  rolls.every(t => t >= 250 && t <= 300), `${Math.min(...rolls)}..${Math.max(...rolls)}`);
check('...and uses the whole window, both ends included',
  rolls.includes(250) && rolls.includes(300) && new Set(rolls).size > 40);
check('a game the gates reach early keeps its roll',
  settleOmenTick('gx', conf, 10) === rollOmenTick('gx', conf));
check('a game already past tick 300 starts twelve ticks after the deploy',
  settleOmenTick('gx', conf, 900) === 912, String(settleOmenTick('gx', conf, 900)));
{
  const r = rollOmenTick('gy', conf);
  check('a game inside the window but past its own roll also waits twelve',
    settleOmenTick('gy', conf, r + 1) === r + 13);
}
const firsts = new Set(Array.from({ length: 60 }, (_, i) => gateOrder(`o${i}`)[0].key));
check('which system opens first is random per game', firsts.size === 2, [...firsts].join(','));
{
  const plan = sunGatePlan('gp', 270, conf);
  check('two gates: six ticks after the omen, then forty after that',
    plan.length === 2 && plan[0].emergeTick === 276 && plan[1].emergeTick === 316,
    plan.map(p => p.emergeTick).join(','));
}
const ft = emergeFlightTicks(26000);
check('a 2g burn out to the Far Reach takes about ten ticks', ft >= 8 && ft <= 12, `${ft} ticks`);
check('a sun gate crossing is a tenth of the burn', gateTransitTicks(200, SUN_GATE_TRANSIT_FRACTION) === 20);
check('a warp gate is still a quarter', gateTransitTicks(200) === 50 && gateTransitTicks(200, null) === 50);
{
  // The quadrant facing its system: within 45 degrees of the bearing,
  // and spread across all of it, not bunched on the line.
  const offs = Array.from({ length: 200 }, (_, i) => {
    const a = pickBearing(seededRand(`b${i}`), 1000, [], 2.0);
    return ((a - 2.0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  });
  check('a gate stops in the quadrant facing its system',
    offs.every(d => Math.abs(d) <= Math.PI / 4 + 1e-9),
    `${(Math.max(...offs.map(Math.abs)) * 180 / Math.PI).toFixed(1)} degrees off at most`);
  check('...anywhere in that quadrant, at random',
    Math.min(...offs) < -Math.PI / 6 && Math.max(...offs) > Math.PI / 6,
    `${(Math.min(...offs) * 180 / Math.PI).toFixed(0)}..${(Math.max(...offs) * 180 / Math.PI).toFixed(0)} degrees`);
  const crowd = Array.from({ length: 12 }, (_, i) => ({
    x: Math.cos(i * 0.5) * 1000, y: Math.sin(i * 0.5) * 1000 }));
  const b = pickBearing(seededRand('c'), 1000, crowd, null, 100);
  const clear = Math.min(...crowd.map(p => Math.hypot(p.x - Math.cos(b) * 1000, p.y - Math.sin(b) * 1000)));
  check('a gate never stops on top of a world when there is room', clear >= 100, clear.toFixed(0));
}

// The route planner takes the gate's own speed.
{
  const legs = { 'A|B': 200, 'S|A': 1, 'B|T': 1, 'S|T': 210 };
  const computeLegTicks = async (_f, a, b) => legs[`${a}|${b}`] ?? legs[`${b}|${a}`] ?? 999;
  const hop = await planGateAwareHop({
    computeLegTicks, gateTransitTicks, gates: [{ a: 'A', b: 'B', fraction: 0.1 }],
    factionId: 'f', fromId: 'A', toId: 'T', tick: 0,
  });
  check('a hull on a sun gate is routed through at a tenth', hop.viaGate && hop.ticks === 20,
    JSON.stringify(hop));
}

// ---- 2. A real game ---------------------------------------------------
async function seedGame(id, overrides) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u0','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Gates','u0',0,0)`).bind(id).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'setup','gate-seed',0,0)`).bind(id).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,0)`)
    .bind(id, 'u0').run();
  await DB.prepare(
    `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms)
     VALUES (?, 'gates', 'published', ?, 0, 0)`,
  ).bind(`cfg_${id}`, JSON.stringify(overrides)).run();
  await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${id}`, id).run();
  await seedGameWorld(env, id);
  return { env, DB };
}

const G = 'gsun';
const dials = { far_systems: 1, sun_gate_start: 5, sun_gate_end: 5, sun_gate_interval: 10 };
const { env, DB } = await seedGame(G, dials);
const order = gateOrder(G);
const chron = async () => (await DB.prepare(
  `SELECT kind, tick_number, payload FROM chronicle_entries
    WHERE game_id = ? AND kind LIKE 'sun_gate_%' ORDER BY tick_number, kind`).bind(G).all()).results ?? [];

for (let t = 0; t <= 4; t++) await advanceSunGates(env, G, t, dials);
check('nothing happens before the omen', (await chron()).length === 0);
const stored = await DB.prepare('SELECT sun_gate_tick FROM games WHERE id = ?').bind(G).first();
check('the omen tick is stored the first time a tick looks', stored.sun_gate_tick === 5,
  String(stored.sun_gate_tick));

await advanceSunGates(env, G, 5, dials);
let rows = await chron();
check('tick 5: everyone is told something is coming out of the Sun',
  rows.length === 1 && rows[0].kind === 'sun_gate_omen', JSON.stringify(rows));

for (let t = 6; t <= 10; t++) await advanceSunGates(env, G, t, dials);
check('...and nothing has come out yet', !(await DB.prepare(
  `SELECT 1 FROM game_bodies WHERE id = ?`).bind(solGateId(G, order[0])).first()));

await advanceSunGates(env, G, 11, dials);
const g0 = await DB.prepare(`SELECT * FROM game_bodies WHERE id = ?`).bind(solGateId(G, order[0])).first();
const f0 = await DB.prepare(`SELECT * FROM game_bodies WHERE id = ?`).bind(farGateId(G, order[0])).first();
check(`tick 11: the first gate (to ${order[0].label}) leaves the Sun`,
  !!g0 && g0.emerge_from_tick === 11 && g0.parent_body_id === `${G}:sol`, JSON.stringify(g0));
const bodies = (await DB.prepare(`SELECT * FROM game_bodies WHERE game_id = ?`).bind(G).all()).results;
const band = farReachBand(bodies);
check('it will stop inside the Far Reach',
  g0.orbit_radius >= band.inner && g0.orbit_radius <= band.outer,
  `${g0.orbit_radius.toFixed(0)} in ${band.inner.toFixed(0)}..${band.outer.toFixed(0)}`);
{
  // Its year is a Far Reach year, not the barycenters' placeholder.
  const peer = bodies.find(b => b.template_id === 'eris');
  const expect = peer.orbit_period * Math.pow(g0.orbit_radius / peer.orbit_radius, 1.5);
  check('it orbits like a Far Reach world, not a fixed point',
    g0.orbit_period > expect * 0.5 && g0.orbit_period < expect * 2,
    `${g0.orbit_period.toFixed(0)} vs ~${expect.toFixed(0)}`);
}
check('its flight is a 2g burn from the Sun\'s surface',
  g0.emerge_until_tick - g0.emerge_from_tick === emergeFlightTicks(g0.orbit_radius - 50),
  `${g0.emerge_until_tick - g0.emerge_from_tick} ticks`);
const arrive0 = g0.emerge_until_tick;
{
  const bary = bodies.find(b => b.template_id === order[0].barycenter);
  const outer = Math.max(...bodies.filter(b => b.parent_body_id === bary.id
    && !['star', 'black_hole', 'megastructure', 'meteoroid', 'lagrange'].includes(b.type)).map(b => b.orbit_radius));
  check('its twin sits just past the far system\'s outermost world',
    f0 && f0.parent_body_id === bary.id && f0.orbit_radius > outer && f0.orbit_radius < outer * 1.5,
    `${f0?.orbit_radius} vs outermost ${outer}`);
  check('...and does not exist for anyone until the gate lands',
    f0.emerge_from_tick === arrive0);
}
const megas = (await DB.prepare(`SELECT * FROM game_megastructures WHERE game_id = ?`).bind(G).all()).results;
const m0 = megas.find(m => m.body_id === g0.id);
check('the pair is wired both ways', m0?.partner_body_id === f0.id
  && megas.find(m => m.body_id === f0.id)?.partner_body_id === g0.id);
check('neutral: no owner, no founder, not ancient, full hull',
  g0.owner_faction_id == null && m0.founded_by_faction_id == null
  && !m0.ancient && m0.hp === 3000, JSON.stringify(m0));
check('a tenth of the burn, not a warp gate\'s quarter', m0.transit_fraction === SUN_GATE_TRANSIT_FRACTION);

// The route planner's own query (room.js gatePairsForTick).
const openPairs = async (tick) => (await DB.prepare(
  `SELECT m.body_id FROM game_megastructures m
     JOIN game_bodies ba ON ba.id = m.body_id
     JOIN game_bodies bb ON bb.id = m.partner_body_id
    WHERE m.game_id = ? AND m.kind = 'warp_gate' AND m.status = 'complete'
      AND (ba.emerge_until_tick IS NULL OR ba.emerge_until_tick <= ?)
      AND (bb.emerge_until_tick IS NULL OR bb.emerge_until_tick <= ?)`,
).bind(G, tick, tick).all()).results.length;
check('nobody can route through it while it is still flying', await openPairs(arrive0 - 1) === 0);
check('...and everyone can once it lands', await openPairs(arrive0) === 2);

const facs = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id = ?`).bind(G).all()).results;
const seen = await DB.prepare(
  `SELECT COUNT(*) n FROM game_body_discoveries WHERE game_id = ? AND body_id IN (?, ?)`,
).bind(G, g0.id, f0.id).first();
check('every faction can see both ends', seen.n === facs.length * 2, `${seen.n} for ${facs.length}`);

// THE TICK'S "STRUCTURES THAT FINISHED" SWEEP must not announce a sun
// gate. Its completed_at_tick is its ARRIVAL, stamped when it leaves the
// Sun, and the sweep had no upper bound: on prod both ends were printed
// "operational under An unflagged force" the tick the gate came out.
{
  const { Room } = await import('../worker/room.js');
  const store = new Map();
  const room = new Room({
    storage: {
      async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
      async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
      async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
    },
    blockConcurrencyWhile: async (f) => f(),
    broadcast: () => {},
  }, env);
  await room.chronicleCompletions(G, 11);
  await room.chronicleCompletions(G, g0.emerge_until_tick);
  const told = (await DB.prepare(
    `SELECT COUNT(*) n FROM chronicle_entries WHERE game_id = ? AND kind = 'megastructure_complete'`).bind(G).first()).n;
  check('the tick never announces a sun gate as a finished megastructure', told === 0, `${told} rows`);
}

// THE LANDING SITE: a body on the gate's final orbit, there to be flown
// to while the gate is still in the air.
const s0 = await DB.prepare(`SELECT * FROM game_bodies WHERE id = ?`).bind(siteId(G, order[0])).first();
check('a landing site appears with the gate',
  !!s0 && s0.type === 'lagrange' && s0.emerge_from_tick === g0.emerge_from_tick
  && s0.emerge_until_tick == null && s0.destroyed_at_tick == null, JSON.stringify(s0));
check('...on exactly the orbit the gate will stop on',
  s0.parent_body_id === g0.parent_body_id && s0.orbit_radius === g0.orbit_radius
  && s0.orbit_period === g0.orbit_period && s0.angle0 === g0.angle0);
check("...with the gate's own size and mass, so a ship parks in the same place",
  s0.radius === g0.radius && s0.mu === g0.mu);
{
  const n = (await DB.prepare(
    `SELECT COUNT(*) n FROM game_body_discoveries WHERE game_id = ? AND body_id = ?`).bind(G, s0.id).first()).n;
  check('every faction can see the site', n === facs.length, `${n} for ${facs.length}`);
}
// A fleet sent ahead: one hull already waiting at the site, one still on
// its way there.
const hulls = (await DB.prepare(`SELECT id FROM game_ships WHERE game_id = ? LIMIT 2`).bind(G).all()).results;
await DB.prepare(`UPDATE game_ships SET parent_body_id = ? WHERE id = ?`).bind(s0.id, hulls[0].id).run();
await DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, scheduled_t, fuel_cost, status, target_body_id)
   VALUES (?, ?, ?, 0, 'absolute', ?, 0, 'in_transit', ?)`,
).bind(`${hulls[1].id}:n_site`, G, hulls[1].id, arrive0 - 2, s0.id).run();

for (let t = 12; t < arrive0; t++) await advanceSunGates(env, G, t, dials);
check('the site stands until the gate lands',
  (await DB.prepare(`SELECT destroyed_at_tick d FROM game_bodies WHERE id = ?`).bind(s0.id).first()).d == null);
await advanceSunGates(env, G, arrive0, dials);
check('on landing the waiting hull is handed to the gate',
  (await DB.prepare(`SELECT parent_body_id p FROM game_ships WHERE id = ?`).bind(hulls[0].id).first()).p === g0.id);
check('...and the leg still flying there now flies to the gate',
  (await DB.prepare(`SELECT target_body_id t FROM game_ship_nodes WHERE id = ?`).bind(`${hulls[1].id}:n_site`).first()).t === g0.id);
check('...and the site retires (never deleted: CASCADE eats ships)',
  (await DB.prepare(`SELECT destroyed_at_tick d FROM game_bodies WHERE id = ?`).bind(s0.id).first()).d === arrive0);
rows = await chron();
check('it is announced open the tick it lands',
  rows.some(r => r.kind === 'sun_gate_opened' && r.tick_number === arrive0), JSON.stringify(rows.map(r => [r.kind, r.tick_number])));

for (let t = arrive0 + 1; t <= 21; t++) await advanceSunGates(env, G, t, dials);
const g1 = await DB.prepare(`SELECT * FROM game_bodies WHERE id = ?`).bind(solGateId(G, order[1])).first();
check(`tick 21: the second gate (to ${order[1].label}) leaves, ten ticks later`,
  !!g1 && g1.emerge_from_tick === 21, JSON.stringify(g1));
{
  // The second gate is WARNED, like the first: six ticks ahead, once.
  const warns = (await chron()).filter(r => r.kind === 'sun_gate_omen');
  const second = warns.find(r => JSON.parse(r.payload).index === 1);
  check('the second gate is warned six ticks ahead, like the first',
    !!second && second.tick_number === 15 && JSON.parse(second.payload).gate_in === 6,
    JSON.stringify(warns));
  check('...once, and without saying where it leads',
    warns.length === 2 && !/Centauri|Cygnus/.test(second.payload), JSON.stringify(warns));
}
{
  const at = g1.emerge_until_tick;
  const a0 = orbitAngle(g0.angle0, g0.orbit_period, at);
  const a1 = orbitAngle(g1.angle0, g1.orbit_period, at);
  // Each stopped in the quadrant facing the system it leads to, as
  // seen from the Sun the moment it landed.
  const off = (gate, sys, tick) => {
    const bary = bodies.find(b => b.template_id === sys.barycenter);
    const toward = orbitAngle(bary.angle0, bary.orbit_period, tick);
    const a = orbitAngle(gate.angle0, gate.orbit_period, tick);
    return Math.abs(((a - toward) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  };
  const o0 = off(g0, order[0], arrive0), o1 = off(g1, order[1], at);
  check(`the ${order[0].label} gate stopped facing ${order[0].label}`, o0 <= Math.PI / 4 + 1e-6,
    `${(o0 * 180 / Math.PI).toFixed(1)} degrees off`);
  check(`the ${order[1].label} gate stopped facing ${order[1].label}`, o1 <= Math.PI / 4 + 1e-6,
    `${(o1 * 180 / Math.PI).toFixed(1)} degrees off`);
  // Not "opposite sides": where the two systems sit is the map's call,
  // and a live board has had them under sixty degrees apart. Only that
  // the second never stops on top of the first.
  const gap = Math.hypot(
    Math.cos(a1) * g1.orbit_radius - Math.cos(a0) * g0.orbit_radius,
    Math.sin(a1) * g1.orbit_radius - Math.sin(a0) * g0.orbit_radius);
  check('the second gate never stops on top of the first', gap >= g1.orbit_radius * 0.05,
    `${gap.toFixed(0)} apart`);
}
check('the two gates lead to different systems', order[0].key !== order[1].key);

// Idempotent: a retried tick changes nothing.
const before = (await DB.prepare(`SELECT COUNT(*) n FROM game_bodies WHERE game_id = ?`).bind(G).first()).n;
const beforeC = (await chron()).length;
await advanceSunGates(env, G, 21, dials);
await advanceSunGates(env, G, 21, dials);
check('a retried tick writes nothing twice',
  (await DB.prepare(`SELECT COUNT(*) n FROM game_bodies WHERE game_id = ?`).bind(G).first()).n === before
  && (await chron()).length === beforeC);

for (let t = 22; t <= 60; t++) await advanceSunGates(env, G, t, dials);
rows = await chron();
check('the whole event: two warnings, two departures, two openings',
  rows.filter(r => r.kind === 'sun_gate_omen').length === 2
  && rows.filter(r => r.kind === 'sun_gate_emerged').length === 2
  && rows.filter(r => r.kind === 'sun_gate_opened').length === 2,
  rows.map(r => r.kind).join(', '));
check('...and never a third gate', (await DB.prepare(
  `SELECT COUNT(*) n FROM game_bodies WHERE game_id = ? AND template_id IN ('sun_gate', 'sun_gate_far')`).bind(G).first()).n === 4);
check('...and both landing sites retired once their gates were down', (await DB.prepare(
  `SELECT COUNT(*) n FROM game_bodies WHERE game_id = ? AND template_id = 'sun_gate_site' AND destroyed_at_tick IS NOT NULL`).bind(G).first()).n === 2);

// ---- 2b. The paper ------------------------------------------------------
{
  // The first hull through, as handleGateTransit writes it.
  await DB.prepare(
    `INSERT INTO chronicle_entries
       (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
     VALUES ('gtx_sim', ?, 40, 'gate_transit', ?, ?, ?, 'public', 0)`,
  ).bind(G, facs[0].id, g0.id, JSON.stringify({
    from: g0.name, to: 'Sol Gate', ship: 'Pathfinder', sun_gate: true, first: true,
    to_system: order[0].label,
  })).run();
  const { composeHeraldForTickRange } = await import('../worker/digest.js');
  const paper = await composeHeraldForTickRange(env, { id: G, name: 'Gates' }, 0, 60);
  const text = JSON.stringify(paper);
  check('the Herald prints the omen, the departures and the openings',
    /out of the Sun|the Sun/i.test(text) && text.includes(order[0].label) && text.includes(order[1].label),
    text.slice(0, 400));
  // A section carries four stories, and six gate moments in one window
  // is more than any real edition sees: the first crossing lands in a
  // later one, after both gates are open.
  // The second warning gets the paper's "again" story, not a repeat of
  // the first omen's "first time in living memory".
  const { SUN_GATE_OMEN_AGAIN_HEADLINE } = await import('../worker/heraldBanks.js');
  const again = JSON.stringify(await composeHeraldForTickRange(env, { id: G, name: 'Gates' }, 12, 16));
  check('the Herald runs the second warning as a second warning',
    SUN_GATE_OMEN_AGAIN_HEADLINE.some(h => again.includes(h({ wait: 6 }))), again.slice(0, 400));
  const later = JSON.stringify(await composeHeraldForTickRange(env, { id: G, name: 'Gates' }, 35, 60));
  check('...and the edition the first crossing lands in names the hull', later.includes('Pathfinder'),
    later.slice(0, 400));
}

// ---- 3. Only the main system counts ------------------------------------
{
  const all = (await DB.prepare(`SELECT * FROM game_bodies WHERE game_id = ?`).bind(G).all()).results;
  // Hand one faction every far world and nothing else.
  const fid = facs[0].id;
  for (const b of all.filter(b => isFarSystemBody(b))) {
    await DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(fid, b.id).run();
  }
  const owned = (await DB.prepare(`SELECT * FROM game_bodies WHERE game_id = ?`).bind(G).all()).results;
  const labels = summarizeSystems(owned).map(s => s.label);
  check('the senate sees no far system', !labels.some(l => /Centauri|Cygnus/.test(l)), labels.join(', '));
  const MAIN = mainSystemSql();
  const dom = await DB.prepare(
    `SELECT COUNT(*) n FROM game_bodies WHERE game_id = ? AND owner_faction_id = ?
        AND type NOT IN ('meteoroid','lagrange','megastructure') AND ${MAIN.sql}`,
  ).bind(G, fid, ...MAIN.binds).first();
  const capital = (await DB.prepare(
    `SELECT COUNT(*) n FROM game_bodies WHERE game_id = ? AND owner_faction_id = ?
        AND type NOT IN ('meteoroid','lagrange','megastructure')
        AND template_id NOT IN (${[...FAR_SYSTEM_TEMPLATE_IDS].map(() => '?').join(',')})`,
  ).bind(G, fid, ...FAR_SYSTEM_TEMPLATE_IDS).first());
  const farHeld = owned.filter(b => b.owner_faction_id === fid && isFarSystemBody(b)
    && !['meteoroid', 'lagrange', 'megastructure'].includes(b.type)).length;
  check('holding every far world adds nothing toward domination',
    farHeld >= 9 && dom.n === capital.n, `${dom.n} counted, ${capital.n} in Sol, ${farHeld} far held`);
  const w = voteWeights(owned, [fid]).get(fid);
  const w0 = voteWeights(owned.filter(b => !isFarSystemBody(b)), [fid]).get(fid);
  check('...or to the vote', w === w0, `${w} vs ${w0}`);
}

// ---- 4. The production guard -------------------------------------------
{
  const off = await seedGame('gsun_off', { sun_gate_start: 5, sun_gate_end: 5 });
  for (let t = 0; t <= 80; t++) await advanceSunGates(off.env, 'gsun_off', t, { sun_gate_start: 5, sun_gate_end: 5 });
  const n = (await off.DB.prepare(
    `SELECT COUNT(*) n FROM chronicle_entries WHERE game_id = 'gsun_off' AND kind LIKE 'sun_gate_%'`).first()).n;
  const g = await off.DB.prepare('SELECT sun_gate_tick FROM games WHERE id = ?').bind('gsun_off').first();
  check('a game without the far systems never hears of the gates', n === 0 && g.sun_gate_tick == null);
}

check('every system the gates name exists in the catalogue',
  SUN_GATE_SYSTEMS.every(s => FAR_SYSTEM_IDS.has(s.barycenter)));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
