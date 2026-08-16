// ============================================================
// Meteoroids — worldgen, discovery and restocking.
//
//   npm run sim:meteoroids
//
// Runs the real worker modules against an in-memory D1, so what passes
// here is what the tick does. The restock clearance test is the reason
// this file exists: "does not spawn in view" is a claim about geometry
// that is invisible in a live game until a player gets a free find and
// nobody can explain why.
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { generateMeteoroids } from '../worker/meteoroids.js';
import {
  sensorBubbles, discoverMeteoroids, replenishKuiper, seenByAnyone,
  KUIPER_FLOOR, RESTOCK_INTERVAL,
} from '../worker/meteoroidTick.js';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

function makeRand(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A minimal live game: real schema, real Room, real tick. Enough world
 * to fly a two-stop route and no more — the mining tests care about the
 * walker, not about worldgen.
 */
async function seedGame(G) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = {
    DB,
    ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
  };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u1','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'M','u1',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'active','s',0,1000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO game_factions
                      (id,game_id,user_id,name,color,slot,status,joined_at,metal,gold,science)
                    VALUES ('f1',?, 'u1','A','#fff',0,'active',0,1000,1000,0)`).bind(G).run();

  const body = (id, r) => DB.prepare(
    `INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,
       radius,soi,mu,orbit_radius,orbit_period,angle0,color,
       yield_metal,yield_fuel,yield_gold,yield_science,development_level,
       fortification_level,shipyard_level)
     VALUES (?,?,?,?,'terrestrial',NULL,2,0,0,?,100,0,'#fff',0,0,0,0,0,0,0)`,
  ).bind(id, G, id, id, r).run();
  await body('home', 100);
  await DB.prepare(
    `INSERT INTO game_settlements (id,game_id,body_id,owner_faction_id,type,name,
       hp,hp_max,population,surface_angle,created_at_tick,
       stockpile_metal,stockpile_gold,stockpile_science)
     VALUES ('st1',?, 'home','f1','city','Home',100,100,1,0,0,0,0,0)`).bind(G).run();

  const { Room } = await import('../worker/room.js');
  const room = new Room({
    storage: { get: async () => null, put: async () => {}, delete: async () => {},
               setAlarm: async () => {}, getAlarm: async () => null },
    id: { toString: () => 'r' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  }, env);
  room.broadcast = () => {};

  let now = 0;
  return {
    DB, env, G,
    tick: async () => {
      now += 1;
      await room.resolveTick(G, now);
      await DB.prepare('UPDATE games SET current_tick=? WHERE id=?').bind(now, G).run();
    },
    addRock: async (id, r, kind, tons) => {
      await body(id, r);
      await DB.prepare(
        `UPDATE game_bodies SET type='meteoroid', mineral_kind=?, mineral_initial=?,
            mineral_remaining=? WHERE id=?`).bind(kind, tons, tons, id).run();
      await DB.prepare(
        `INSERT INTO game_body_discoveries (game_id,body_id,faction_id,discovered_at_tick,method)
         VALUES (?,?, 'f1', 0, 'flyby')`).bind(G, id).run();
    },
    addFreighter: async (id, at) => {
      await DB.prepare(
        `INSERT INTO game_ships (id,game_id,owner_faction_id,name,ship_class,parent_body_id,
           orbit_rp,orbit_ra,orbit_omega,orbit_m0,orbit_epoch,orbit_direction,
           fuel,fuel_max,status,built_at_tick,hp,hp_max,damage_per_tick)
         VALUES (?,?, 'f1', ?, 'freighter', ?, 2,2,0,0,0,1, 0,0,'active',0,60,60,0)`,
      ).bind(id, G, id, at).run();
    },
    addRoute: async (stops, shipId) => {
      const rid = `rt_${shipId}`;
      await DB.prepare(
        `INSERT INTO game_trade_routes (id,game_id,owner_faction_id,ship_id,
           origin_body_id,dest_body_id,status,kind,created_at_tick,loops_completed)
         VALUES (?,?, 'f1', ?, ?, ?, 'outbound','logistics',0,0)`,
      ).bind(rid, G, shipId, stops[0].body, stops[stops.length - 1].body).run();
      for (let i = 0; i < stops.length; i++) {
        await DB.prepare(
          `INSERT INTO game_trade_route_stops
             (id,game_id,route_id,sequence,body_id,action,take_metal,take_gold,take_science)
           VALUES (?,?,?,?,?,?,1,1,1)`,
        ).bind(`${rid}:s${i}`, G, rid, i, stops[i].body, stops[i].action).run();
      }
      await DB.prepare(
        `INSERT INTO game_trade_route_ships
           (id,game_id,route_id,ship_id,role,next_stop_seq,
            cargo_fuel,cargo_metal,cargo_gold,cargo_science,added_at_tick)
         VALUES (?,?,?,?, 'carrier', 0, 0,0,0,0, 0)`,
      ).bind(`${rid}:c`, G, rid, shipId).run();
      return rid;
    },
  };
}

// ---------------------------------------------------------------
// 1. WORLDGEN
// ---------------------------------------------------------------
{
  const hosts = [
    ['mercury', 72, 49, 4.40], ['venus', 134, 126, 3.18],
    ['earth', 186, 205, 1.75], ['mars', 283, 386, 6.20],
    ['jupiter', 920, 2000, 1.0], ['saturn', 1686, 4000, 2.0],
    ['uranus', 2400, 7000, 3.0], ['neptune', 3000, 9000, 4.0],
    ['pluto', 3800, 12000, 5.0], ['eris', 4200, 14000, 0.5],
    ['sedna', 5200, 20000, 2.5], ['makemake', 4000, 13000, 1.2],
  ].map(([id, r, p, ang]) => ({ id, orbit_radius: r, orbit_period: p, angle0: ang }));

  const rocks = generateMeteoroids(makeRand('seed-a'), hosts);
  check('thirty rocks', rocks.length === 30, String(rocks.length));
  check('twelve at L3', rocks.filter(r => r.type === 'lagrange').length === 12);

  // The property that makes L3 worth using: same orbit, opposite phase,
  // so the rock stays across the system from its planet forever.
  const l3 = rocks.find(r => r.id === 'mtr_earth_l3');
  const earth = hosts.find(h => h.id === 'earth');
  check('an L3 rock shares its host orbit exactly',
    l3.orbit_radius === earth.orbit_radius && l3.orbit_period === earth.orbit_period);
  const gap = Math.abs(((l3.angle0 - earth.angle0) + 2 * Math.PI) % (2 * Math.PI));
  check('...half a turn out of phase', Math.abs(gap - Math.PI) < 1e-9, String(gap));

  check('no science rocks — the research drain would make it a one-tick spike',
    rocks.every(r => r.mineral_kind === 'metal' || r.mineral_kind === 'gold'));
  check('every rock carries a load', rocks.every(r => r.mineral_initial > 0));

  const again = generateMeteoroids(makeRand('seed-a'), hosts);
  check('same seed, same belt', JSON.stringify(rocks) === JSON.stringify(again));
  const other = generateMeteoroids(makeRand('seed-b'), hosts);
  check('different seed, different belt', JSON.stringify(rocks) !== JSON.stringify(other));
}

// ---------------------------------------------------------------
// 2. DISCOVERY + RESTOCK, against the real schema
// ---------------------------------------------------------------
{
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  const G = 'gmtr01';

  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u1','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'M','u1',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'active','s',0,1000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO game_factions (id,game_id,user_id,name,color,slot,status,joined_at)
                    VALUES ('f1',?, 'u1','A','#fff',0,'active',0)`).bind(G).run();

  // A home body with a station on it, and two rocks: one parked inside
  // the station's coverage, one far outside.
  const mkBody = (id, x) => DB.prepare(
    `INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,
       radius,soi,mu,orbit_radius,orbit_period,angle0,color,
       yield_metal,yield_fuel,yield_gold,yield_science,development_level,
       fortification_level,shipyard_level)
     VALUES (?,?,?,?,'meteoroid',NULL,1,0,0,?,100,0,'#fff',0,0,0,0,0,0,0)`,
  ).bind(id, G, id, id, x).run();

  await mkBody('home', 0);
  await mkBody('near', 100);
  await mkBody('far', 5000);
  await DB.prepare(
    `UPDATE game_bodies SET mineral_kind='metal', mineral_initial=500, mineral_remaining=500
      WHERE id IN ('near','far')`).run();
  await DB.prepare(
    `INSERT INTO game_settlements (id,game_id,body_id,owner_faction_id,type,name,
       hp,hp_max,population,surface_angle,created_at_tick)
     VALUES ('s1',?, 'home','f1','station','Home',100,100,1,0,0)`).bind(G).run();

  // Flat positions: x on a line, so coverage is trivial to reason about.
  const posOf = (id) => ({ home: { x: 0, y: 0 }, near: { x: 100, y: 0 },
                           far: { x: 5000, y: 0 } }[id] ?? null);

  const bubbles = await sensorBubbles(env, G, 1, posOf);
  check('the station projects coverage', (bubbles.get('f1') ?? []).length === 1);

  const d1 = await discoverMeteoroids(env, G, 1, posOf);
  check('the near rock is found', d1.found === 1, JSON.stringify(d1));
  const rows = (await DB.prepare(
    `SELECT b.name FROM game_body_discoveries d JOIN game_bodies b ON b.id=d.body_id
      WHERE d.game_id=?`).bind(G).all()).results ?? [];
  check('...and it is the NEAR one, not the far one',
    rows.length === 1 && rows[0].name === 'near', JSON.stringify(rows));

  const d2 = await discoverMeteoroids(env, G, 2, posOf);
  check('a second sweep does not re-find it', d2.found === 0, JSON.stringify(d2));

  // ---- restock clearance: the claim worth testing -----------------
  // The belt is below its floor (2 rocks, neither Kuiper), so a restock
  // is due. Give the faction ENORMOUS coverage centred on the origin so
  // every candidate orbit at 1550-5000 would be observed, and confirm
  // the pass declines rather than spawning in plain sight.
  // The clearance rule is GEOMETRY, so test it as geometry. Going
  // through the fixture would need a settlement out-ranging 1550 units,
  // which no building does — and an assertion that cannot fail is worse
  // than none. (The first version of this file had exactly that: an
  // `after > before || res.added === 0` that is true either way.)
  const cover = new Map([['f1', [{ x: 0, y: 0, r2: 800 * 800 }]]]);
  check('a point inside coverage is seen', seenByAnyone(cover, 500, 0));
  check('a point on the rim is seen', seenByAnyone(cover, 800, 0));
  check('a point outside is not', !seenByAnyone(cover, 900, 0));
  check('coverage is circular, not square',
    !seenByAnyone(cover, 700, 700), 'corner of the bounding box must be outside');
  check('no bubbles means nothing is observed', !seenByAnyone(new Map(), 0, 0));

  check('restock is gated on the tick cadence',
    (await replenishKuiper(env, G, RESTOCK_INTERVAL + 1, makeRand('r'), posOf)).added === 0);

  // With NO coverage at all, a restock must land.
  const empty = () => null;   // no positions -> no bubbles -> nothing observed
  const b2 = (await DB.prepare(
    'SELECT COUNT(*) n FROM game_bodies WHERE game_id=?').bind(G).first()).n;
  const res2 = await replenishKuiper(env, G, RESTOCK_INTERVAL * 2, makeRand('r2'), empty);
  const a2 = (await DB.prepare(
    'SELECT COUNT(*) n FROM game_bodies WHERE game_id=?').bind(G).first()).n;
  check('with nobody watching, a rock arrives', res2.added === 1 && a2 === b2 + 1,
    JSON.stringify(res2));

  const fresh = await DB.prepare(
    `SELECT name, mineral_remaining, orbit_ra FROM game_bodies
      WHERE game_id=? AND template_id LIKE 'mtr_restock_%'`).bind(G).first();
  check('...carrying a load, on an eccentric orbit',
    fresh && fresh.mineral_remaining > 0 && fresh.orbit_ra > 0, JSON.stringify(fresh));
  check('...continuing the catalogue', /^MTR-\d+$/.test(fresh?.name ?? ''), fresh?.name);

  const disc = (await DB.prepare(
    `SELECT COUNT(*) n FROM game_body_discoveries d JOIN game_bodies b ON b.id=d.body_id
      WHERE d.game_id=? AND b.template_id LIKE 'mtr_restock_%'`).bind(G).first()).n;
  check('a new rock arrives UNDISCOVERED — a restock is not a gift', disc === 0);
}

// ---------------------------------------------------------------
// 3. MINING — the first stop that takes TIME
// ---------------------------------------------------------------
{
  const h = await seedGame('gmine1');
  const { DB, env, G } = h;

  // A rock with a small load parked next to home, and a fitted hull.
  await h.addRock('rock', 120, 'metal', 160);
  await h.addFreighter('dig', 'home');
  const routeId = await h.addRoute([
    { body: 'rock', action: 'mine' },
    { body: 'home', action: 'dropoff' },
  ], 'dig');

  // Park the hull ON the rock so the walker starts at the stop rather
  // than spending ticks flying there — the dwell is what is under test.
  await DB.prepare("UPDATE game_ships SET parent_body_id='rock' WHERE id='dig'").run();

  const holdOf = async () => Number((await DB.prepare(
    'SELECT cargo_metal FROM game_trade_route_ships WHERE ship_id=?').bind('dig').first())?.cargo_metal ?? 0);
  const rockLeft = async () => Number((await DB.prepare(
    'SELECT mineral_remaining FROM game_bodies WHERE id=?').bind('rock').first())?.mineral_remaining ?? 0);
  const cursor = async () => Number((await DB.prepare(
    'SELECT next_stop_seq FROM game_trade_route_ships WHERE ship_id=?').bind('dig').first())?.next_stop_seq ?? 0);

  await h.tick();
  check('one tick of mining moves 50 into the hold', await holdOf() === 50, String(await holdOf()));
  check('...and takes it out of the rock', await rockLeft() === 110, String(await rockLeft()));
  check('...and the hull STAYS on the rock', await cursor() === 0, String(await cursor()));

  await h.tick();
  await h.tick();
  check('mining accumulates across ticks', await holdOf() === 150, String(await holdOf()));

  // Fourth tick: only 10 left in the rock, so the take is clamped.
  await h.tick();
  check('the last take is clamped to what is left', await holdOf() === 160, String(await holdOf()));
  check('the rock is empty', await rockLeft() === 0, String(await rockLeft()));
  const ex = await DB.prepare(
    'SELECT exhausted_at_tick FROM game_bodies WHERE id=?').bind('rock').first();
  check('...and stamped exhausted', ex?.exhausted_at_tick != null, JSON.stringify(ex));
  const chron = await DB.prepare(
    "SELECT COUNT(*) n FROM chronicle_entries WHERE game_id=? AND kind='meteoroid_exhausted'").bind(G).first();
  check('exhaustion is announced, not silent', Number(chron?.n ?? 0) === 1);

  // THE STRANDING TEST. The rock is dead; the hull must give up on it
  // and carry the load home rather than waiting on a rock forever.
  await h.tick();
  check('a worked-out rock does not strand the hull', await cursor() === 1, String(await cursor()));
  check('...and it keeps the cargo it dug', await holdOf() === 160, String(await holdOf()));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
