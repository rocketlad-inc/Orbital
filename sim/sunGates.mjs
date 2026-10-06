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
  emergeFlightTicks, farReachBand, pickBearing, seededRand,
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
  const a = pickBearing(seededRand('b'), 1000, [], 0);
  const diff = Math.abs(((a - Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  check('the second gate lands across the sky from the first', diff <= Math.PI / 6 + 1e-9,
    `${(diff * 180 / Math.PI).toFixed(1)} degrees off opposite`);
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
check('its flight is a 2g burn from the Sun\'s surface',
  g0.emerge_until_tick - g0.emerge_from_tick === emergeFlightTicks(g0.orbit_radius - 50),
  `${g0.emerge_until_tick - g0.emerge_from_tick} ticks`);
const arrive0 = g0.emerge_until_tick;
{
  const bary = bodies.find(b => b.template_id === order[0].barycenter);
  const outer = Math.max(...bodies.filter(b => b.parent_body_id === bary.id
    && !['star', 'black_hole', 'megastructure'].includes(b.type)).map(b => b.orbit_radius));
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

for (let t = 12; t <= arrive0; t++) await advanceSunGates(env, G, t, dials);
rows = await chron();
check('it is announced open the tick it lands',
  rows.some(r => r.kind === 'sun_gate_opened' && r.tick_number === arrive0), JSON.stringify(rows.map(r => [r.kind, r.tick_number])));

for (let t = arrive0 + 1; t <= 21; t++) await advanceSunGates(env, G, t, dials);
const g1 = await DB.prepare(`SELECT * FROM game_bodies WHERE id = ?`).bind(solGateId(G, order[1])).first();
check(`tick 21: the second gate (to ${order[1].label}) leaves, ten ticks later`,
  !!g1 && g1.emerge_from_tick === 21, JSON.stringify(g1));
{
  const at = g1.emerge_until_tick;
  const a0 = orbitAngle(g0.angle0, g0.orbit_period, at);
  const a1 = orbitAngle(g1.angle0, g1.orbit_period, at);
  const sep = Math.abs(((a1 - a0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  check('it stops on the far side of the system from the first',
    sep >= (2 * Math.PI) / 3, `${(sep * 180 / Math.PI).toFixed(0)} degrees apart`);
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
check('the whole event: one omen, two departures, two openings',
  rows.filter(r => r.kind === 'sun_gate_omen').length === 1
  && rows.filter(r => r.kind === 'sun_gate_emerged').length === 2
  && rows.filter(r => r.kind === 'sun_gate_opened').length === 2,
  rows.map(r => r.kind).join(', '));
check('...and never a third gate', (await DB.prepare(
  `SELECT COUNT(*) n FROM game_bodies WHERE game_id = ? AND template_id LIKE 'sun_gate%'`).bind(G).first()).n === 4);

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
