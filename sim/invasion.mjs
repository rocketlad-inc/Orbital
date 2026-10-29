// ============================================================
// THE THREE BODY EVENT, driven end to end through the REAL resolveTick
// (worker/invasion.js).
//
// Lorne, 2026-10-28:
//   1. Everyone's science drops 25% for 40 ticks, 1 more point each tick,
//      and nothing in the log says why.
//   2. A fleet leaves Verdant (Alpha Centauri) on a trip 75% as long as a
//      player's ship needs.
//   3. At a random point on the right of the solar system it lays a gate
//      wired to a twin at Verdant.
//   4. It takes the nearest settled world, digs in for 40 ticks, takes
//      Earth, then raises destroyers and takes the home worlds one by one.
//
// Run: node sim/invasion.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import {
  invasionDials, blightMult, rollStartTick, invaderTicks,
  invasionFactionId, invasionGateId, invasionTwinId, invasionSiteId,
} from '../worker/invasion.js';
import { legTicks, SHIP_ENGINE_ACCEL } from '../worker/burn.js';
import { makeRouteMath } from '../worker/routeMath.js';
import { invalidate } from '../worker/gameConfig.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

// ---- 1. The pure rules ------------------------------------------------
{
  const d = invasionDials({ invasion: 1, far_systems: 1 });
  check('on needs the far systems', d.on && !invasionDials({ invasion: 1 }).on && !invasionDials({ far_systems: 1 }).on);
  check('defaults: 25% down, +1 a tick, 40 ticks, 75% trip time',
    d.debuff === 0.25 && d.growth === 0.01 && d.blightTicks === 40 && d.speed === 0.75, JSON.stringify(d));

  const table = [0, 1, 10, 20, 39].map(k => Math.round(blightMult(100, 100 + k, d) * 100));
  check('the blight is 75% at its first tick and deepens a point a tick: 75, 74, 65, 55, 36',
    table.join() === '75,74,65,55,36', table.join());
  check('it is exactly 36% at its last tick, then gone', blightMult(100, 140, d) === 1 && blightMult(100, 139, d) < 0.37);
  check('and absent before it starts', blightMult(100, 99, d) === 1 && blightMult(null, 5, d) === 1);

  const starts = Array.from({ length: 40 }, (_, i) => rollStartTick(`g${i}`, d));
  check('the start tick is seeded inside the window and varies by game',
    starts.every(t => t >= d.start && t <= d.end) && new Set(starts).size > 10
      && rollStartTick('same', d) === rollStartTick('same', d));

  const ratio = [3000, 9000, 30000].map(dist => invaderTicks(dist, 0.75) / legTicks(dist, SHIP_ENGINE_ACCEL));
  check('their trip is about 75% of a player hull on a long haul (short hops round up to whole ticks)',
    ratio.every(r => r >= 0.74 && r <= 0.8), ratio.map(r => r.toFixed(3)).join());
}

// ---- 2. A real game ---------------------------------------------------
const LIVE = { far_systems: 1, system_scale: 4, moon_scale: 8, body_scale: 2, outer_orbit_speedup: 4 };

async function seed(G, extra = {}, third = false) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const now = Date.now();
  for (const u of third ? ['u1', 'u2', 'u3'] : ['u1', 'u2']) {
    await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
      .bind(u, `${u}@t`, u, now).run();
  }
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Deep','u1',?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?,'setup','invasion',0,3600000,?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
  if (third) await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u3',?,'venus')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (?, 'k', 'archived', ?, 0, 0)`)
    .bind(`cfg_${G}`, JSON.stringify({ ...LIVE, invasion: 1, invasion_start: 5, invasion_end: 5, ...extra })).run();
  await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${G}`, G).run();
  invalidate(G);
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
  const fA = (await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first());
  const fB = (await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first());
  const settle = async (tpl, owner, type = 'station') => {
    const id = `${G}:${tpl}`;
    await DB.prepare(
      `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
         hp, hp_max, population, surface_angle, created_at_tick)
       VALUES (?, ?, ?, ?, ?, ?, 400, 400, 1, 0, 0)`,
    ).bind(`st_${G}_${tpl}`, G, id, owner, type, `${tpl} base`).run();
    await DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(owner, id).run();
  };
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
  const run = async (t) => {
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
    await room.resolveTick(G, t);
  };
  return { env, DB, fA, fB, settle, run, room };
}

const inv = (DB, G) => DB.prepare('SELECT * FROM game_invasion WHERE game_id = ?').bind(G).first();
const kinds = async (DB, G) => (await DB.prepare(
  `SELECT kind, tick_number, body_id, payload FROM chronicle_entries
    WHERE game_id = ? AND kind LIKE 'invasion_%' ORDER BY tick_number, created_at_ms`).bind(G).all()).results ?? [];

// ---- A. Blight, launch, trip, gate ---------------------------------------
{
  const G = 'invA';
  const { env, DB, fA, run } = await seed(G);
  const fac = fA.id;
  const science = async () => Number((await DB.prepare('SELECT science FROM game_factions WHERE id = ?').bind(fac).first()).science);
  const gains = [];
  let prev = await science();
  for (let t = 1; t <= 4; t++) { await run(t); const s = await science(); gains.push(s - prev); prev = s; }
  const row0 = await inv(DB, G);
  check('the event row exists, with the start tick the config asked for', row0?.start_tick === 5 && row0.phase === 'pending', JSON.stringify(row0));
  void gains;

  // Ticks 5..44: the blight. Compare science gain per tick against a
  // game with no event, tick by tick.
  const base = await seed('invB', { invasion: 0 });
  const baseFac = base.fA.id;
  const baseSci = async () => Number((await base.DB.prepare('SELECT science FROM game_factions WHERE id = ?').bind(baseFac).first()).science);
  let bp = await baseSci();
  for (let t = 1; t <= 4; t++) { await base.run(t); bp = await baseSci(); }
  // A tick of science is a couple of points, too coarse to compare one
  // tick at a time: compare the whole blight against the same game with
  // no event. The mean multiplier from 75% down to 36% is 55.5%.
  let withEvent = 0, without = 0;
  for (let t = 5; t <= 44; t++) {
    const a0 = await science(), b0 = bp;
    await run(t); await base.run(t);
    withEvent += (await science()) - a0; without += (await baseSci()) - b0;
    bp = await baseSci();
  }
  const share = withEvent / without;
  check('science really is cut over the blight: about 55% of an ordinary game',
    without > 20 && share > 0.49 && share < 0.62, `${withEvent} of ${without} = ${share.toFixed(3)}`);
  check('and the log says nothing about it', (await kinds(DB, G)).length === 0
    && ((await DB.prepare(`SELECT COUNT(*) AS n FROM chronicle_entries WHERE game_id = ?`).bind(G).first()).n >= 0));

  check('still silent through the last tick of the blight', (await kinds(DB, G)).length === 0
    && (await inv(DB, G)).phase === 'blight', (await inv(DB, G)).phase);
  await run(45);
  let row = await inv(DB, G);
  check('the blight ends at tick 45 and the fleet launches', row.phase === 'transit' && row.arrive_tick > 45, JSON.stringify(row));
  const fleet = (await DB.prepare(`SELECT ship_class, parent_body_id FROM game_ships WHERE owner_faction_id = ? AND status = 'active'`)
    .bind(invasionFactionId(G)).all()).results;
  check('14 hulls at Verdant: 8 frigates, 4 destroyers, 2 colony ships',
    fleet.length === 14 && fleet.every(s => s.parent_body_id === `${G}:verdant`)
      && fleet.filter(s => s.ship_class === 'frigate').length === 8
      && fleet.filter(s => s.ship_class === 'destroyer').length === 4
      && fleet.filter(s => s.ship_class === 'colony').length === 2, JSON.stringify(fleet.slice(0, 3)));
  const legs = (await DB.prepare(`SELECT COUNT(DISTINCT ship_id) AS n FROM game_ship_nodes
                                   WHERE status IN ('planned','committed','in_transit') AND ship_id LIKE ?`).bind(`${G}:inv_%`).first()).n;
  check('every hull is in flight', legs === 14, `${legs}`);
  const faction = await DB.prepare('SELECT status, user_id FROM game_factions WHERE id = ?').bind(invasionFactionId(G)).first();
  check('they are a monster-status faction with no seat', faction?.status === 'monster' && faction.user_id == null);
  let ks = await kinds(DB, G);
  check('everyone is told, once', ks.length === 1 && ks[0].kind === 'invasion_launched', JSON.stringify(ks.map(k => k.kind)));

  // The trip: 75% of what a player's hull would take over the same lane.
  const rm = makeRouteMath(DB, G);
  const a = await rm.bodyPosAt(`${G}:verdant`, 45);
  const b = await rm.bodyPosAt(invasionSiteId(G), row.arrive_tick);
  const playerT = legTicks(Math.hypot(b.x - a.x, b.y - a.y), SHIP_ENGINE_ACCEL);
  const theirT = row.arrive_tick - 45;
  check('their trip is about 75% of a player hull\'s over the same lane',
    theirT / playerT >= 0.74 && theirT / playerT <= 0.8, `${theirT} vs ${playerT} = ${(theirT / playerT).toFixed(3)}`);
  check('the landing point is on the right of the solar system (+x)', b.x > 0, JSON.stringify(b));

  // Fly it in.
  let t = 46;
  for (; t <= row.arrive_tick + 3; t++) {
    await run(t);
    if ((await inv(DB, G)).phase !== 'transit') break;
  }
  row = await inv(DB, G);
  check('on arrival the gate goes down and the siege begins', row.phase === 'siege', row.phase);
  const gate = await DB.prepare(`SELECT m.status, m.partner_body_id, m.founded_by_faction_id, m.hp FROM game_megastructures m WHERE m.body_id = ?`)
    .bind(invasionGateId(G)).first();
  const twin = await DB.prepare(`SELECT m.status, m.partner_body_id, b.parent_body_id FROM game_megastructures m JOIN game_bodies b ON b.id = m.body_id WHERE m.body_id = ?`)
    .bind(invasionTwinId(G)).first();
  check('the gate is theirs, complete, with a destructible hull and a twin',
    gate?.status === 'complete' && gate.founded_by_faction_id === invasionFactionId(G) && gate.hp > 0
      && gate.partner_body_id === invasionTwinId(G) && twin?.partner_body_id === invasionGateId(G), JSON.stringify({ gate, twin }));
  check('the twin is in the Centauri system, orbiting its barycenter', twin?.parent_body_id === `${G}:binary_barycenter`, twin?.parent_body_id);
  // On the rim facing Sol, like the squid gate's far end: within 45 degrees
  // of the line to the Sun, and just past the outermost Centauri world.
  {
    const rm2 = makeRouteMath(DB, G);
    const tq = await rm2.bodyPosAt(invasionTwinId(G), row.phase_tick);
    const bq = await rm2.bodyPosAt(`${G}:binary_barycenter`, row.phase_tick);
    const toSol = Math.atan2(0 - bq.y, 0 - bq.x), toTwin = Math.atan2(tq.y - bq.y, tq.x - bq.x);
    const off = Math.abs(Math.atan2(Math.sin(toTwin - toSol), Math.cos(toTwin - toSol))) * 180 / Math.PI;
    check('the twin sits on the rim facing Sol (within 45 degrees of the line to the Sun)', off <= 45.5, `${off.toFixed(1)} degrees off`);
    const worlds = (await DB.prepare(`SELECT orbit_radius, orbit_ra FROM game_bodies WHERE parent_body_id = ? AND type IN ('terrestrial','dwarf','moon','gas-giant','ice-giant')`).bind(`${G}:binary_barycenter`).all()).results;
    const outer = Math.max(...worlds.map(w => Number(w.orbit_ra ?? w.orbit_radius) || 0));
    const rTwin = Math.hypot(tq.x - bq.x, tq.y - bq.y);
    check('...just past the outermost world of that system', rTwin > outer && rTwin < outer * 1.4, `${Math.round(rTwin)} vs ${Math.round(outer)}`);
  }
  ks = await kinds(DB, G);
  check('the gate is announced', ks.map(k => k.kind).join() === 'invasion_launched,invasion_gate', ks.map(k => k.kind).join());
  void env;
}

// ---- B. The conquest ----------------------------------------------------
{
  const G = 'invC';
  // A short blight so the sim spends its ticks on the war.
  const { DB, fA, fB, settle, run } = await seed(G, { invasion_start: 3, invasion_end: 3, invasion_blight_ticks: 2, invasion_hunker_ticks: 12 }, true);
  await settle('ganymede', fB.id);
  const rm = makeRouteMath(DB, G);
  const phases = [];
  let last = null;
  const step = async (t) => {
    await run(t);
    const r = await inv(DB, G);
    if (r && r.phase !== last) { phases.push(`${r.phase}@${t}`); last = r.phase; }
    return r;
  };
  const until = async (from, max, pred) => {
    let t = from;
    for (; t < from + max; t++) { const r = await step(t); if (r && pred(r)) return { t, r }; }
    return { t, r: await inv(DB, G) };
  };
  const landed = await until(1, 80, r => r.phase === 'siege');
  const site = await rm.bodyPosAt(invasionSiteId(G), landed.t);
  // The settled worlds, nearest the gate first.
  const settled = (await DB.prepare(
    `SELECT s.body_id FROM game_settlements s JOIN game_factions f ON f.id = s.owner_faction_id
      WHERE s.game_id = ? AND s.destroyed_at_tick IS NULL AND f.status <> 'monster'`).bind(G).all()).results;
  const ranked = [];
  for (const w of settled) { const q = await rm.bodyPosAt(w.body_id, landed.t); ranked.push({ id: w.body_id, d: Math.hypot(q.x - site.x, q.y - site.y) }); }
  ranked.sort((a, b) => a.d - b.d);

  const sieged = await until(landed.t, 400, r => r.phase === 'build');
  check('the fleet takes a world and digs in', sieged.r.phase === 'build', phases.join(' '));
  const held = sieged.r.held_body_id;
  check('the world it takes is the settled one nearest the gate', held === ranked[0]?.id,
    `${held} vs ${ranked.map(r => `${r.id.split(':')[1]} ${Math.round(r.d)}`).join(', ')}`);
  const mine = await DB.prepare(`SELECT owner_faction_id FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NULL`).bind(held).first();
  check('a settlement of theirs stands on it', mine?.owner_faction_id === invasionFactionId(G), JSON.stringify(mine));
  const lost = await DB.prepare(`SELECT COUNT(*) AS n FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NOT NULL AND owner_faction_id <> ?`).bind(held, invasionFactionId(G)).first();
  check('the empire that held it lost its settlement in ordinary combat', lost.n >= 1);
  let ks = (await kinds(DB, G)).map(k => k.kind);
  check('the log tells it as it happens', ks.includes('invasion_assault') && ks.includes('invasion_world_taken'), ks.join());

  // Digging in: a frigate every 4 ticks while the gate stands.
  const b0 = (await inv(DB, G)).built;
  await until(sieged.t + 1, 8, () => false);
  const b1 = (await inv(DB, G)).built;
  check('they raise a frigate every 4 ticks while their gate stands', b1 - b0 === 2, `${b0} -> ${b1}`);
  const base = await DB.prepare(`SELECT COUNT(*) AS n FROM game_ships WHERE owner_faction_id = ? AND parent_body_id = ? AND ship_class = 'frigate' AND status = 'active' AND built_at_tick > ?`)
    .bind(invasionFactionId(G), held, sieged.t).first();
  check('...at the world they hold', base.n === 2, `${base.n}`);

  // The counterplay: take their gate and the reinforcements stop.
  await DB.prepare('UPDATE game_megastructures SET founded_by_faction_id = ? WHERE body_id = ?').bind(fA.id, invasionGateId(G)).run();
  const t2 = (await DB.prepare('SELECT current_tick AS t FROM games WHERE id = ?').bind(G).first()).t;
  await until(t2 + 1, 6, () => false);
  const b2 = (await inv(DB, G)).built;
  check('capture their gate and no more ships come', b2 === b1, `${b1} -> ${b2}`);
  await DB.prepare('UPDATE game_megastructures SET founded_by_faction_id = ? WHERE body_id = ?').bind(invasionFactionId(G), invasionGateId(G)).run();

  // Then Earth.
  const toEarth = await until(t2 + 7, 200, r => r.phase === 'earth' || r.phase === 'conquest');
  check('after the dig-in they turn on Earth', ['earth', 'conquest'].includes(toEarth.r.phase), phases.join(' '));
  const earth = await until(toEarth.t, 400, r => r.phase === 'conquest' || r.phase === 'done');
  check('Earth falls and they move on to the home worlds', ['conquest', 'done'].includes(earth.r.phase), phases.join(' '));
  const eSet = await DB.prepare(`SELECT owner_faction_id FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NULL`).bind(`${G}:earth`).first();
  check('Earth is theirs', eSet?.owner_faction_id === invasionFactionId(G), JSON.stringify(eSet));
  ks = (await kinds(DB, G)).map(k => k.kind);
  check('...and the log says Earth fell', ks.includes('invasion_earth_taken'), ks.join());

  const tail = await until(earth.t, 500, r => r.phase === 'done' || r.phase === 'repelled');
  const fl = (await DB.prepare(`SELECT ship_class, parent_body_id, COUNT(*) AS n FROM game_ships WHERE owner_faction_id = ? AND status = 'active' GROUP BY 1,2`).bind(invasionFactionId(G)).all()).results;
  const legsLeft = (await DB.prepare(`SELECT COUNT(*) AS n FROM game_ship_nodes WHERE status IN ('planned','committed','in_transit') AND ship_id LIKE ?`).bind(`${G}:inv_%`).first()).n;
  check('they take the home worlds one by one and it ends', tail.r.phase === 'done', `${JSON.stringify(tail.r)} fleet=${JSON.stringify(fl)} legs=${legsLeft} tick=${tail.t}`);
  const marsLost = await DB.prepare(`SELECT owner_faction_id FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NULL`).bind(fB.capital_body_id).first();
  check('the other home world fell to them', marsLost?.owner_faction_id === invasionFactionId(G), JSON.stringify(marsLost));
  const stat = await DB.prepare('SELECT status FROM games WHERE id = ?').bind(G).first();
  check('it is an event, not an ending: the game goes on', stat.status === 'active', stat.status);
  const destroyers = await DB.prepare(`SELECT COUNT(*) AS n FROM game_ships WHERE owner_faction_id = ? AND ship_class = 'destroyer' AND built_at_tick >= ?`).bind(invasionFactionId(G), earth.t).first();
  check('holding Earth, they raised destroyers', destroyers.n >= 1, `${destroyers.n}`);
  console.log(`        phases: ${phases.join(' → ')}`);
  void fA;
}

// ---- C. Repelled --------------------------------------------------------
{
  const G = 'invD';
  const { DB, run } = await seed(G, { invasion_start: 3, invasion_end: 3, invasion_blight_ticks: 2 });
  let t = 1;
  for (; t < 250; t++) { await run(t); if ((await inv(DB, G))?.phase === 'siege') break; }
  await DB.prepare(`UPDATE game_ships SET status = 'destroyed', hp = 0 WHERE owner_faction_id = ? AND ship_class <> 'colony'`).bind(invasionFactionId(G)).run();
  await run(t + 1);
  const r = await inv(DB, G);
  check('wipe out the fleet and the invasion is repelled', r.phase === 'repelled', r.phase);
  const k = (await kinds(DB, G)).map(x => x.kind);
  check('...and everyone is told', k.includes('invasion_repelled'), k.join());
  await run(t + 2); await run(t + 3);
  check('and it stays over', (await inv(DB, G)).phase === 'repelled');
  // Destroying a gate (seize 'destroy' deletes the structure) ends it as theirs.
  const { gateStands } = await import('../worker/invasion.js');
  check('(their gate, once laid, stands)', await gateStands(DB, G));
  await DB.batch([
    DB.prepare('DELETE FROM game_megastructures WHERE body_id = ?').bind(invasionGateId(G)),
    DB.prepare('UPDATE game_bodies SET destroyed_at_tick = ? WHERE id = ?').bind(t, invasionGateId(G)),
  ]);
  check('a destroyed gate no longer stands', !(await gateStands(DB, G)));
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
