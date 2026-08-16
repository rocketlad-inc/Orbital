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
  telescopeFirstLight, KUIPER_FLOOR, RESTOCK_INTERVAL,
  runManualMining, MANUAL_MINE_RATE,
} from '../worker/meteoroidTick.js';
import { settlementSensorRange, TELESCOPE_SENSOR_BONUS } from '../worker/state.js';

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
    /** `rig` defaults true: most tests here are about the walker, not
     *  the gate, and a fixture that silently cannot mine would make all
     *  of them fail for the wrong reason. Pass false to test the gate. */
    addFreighter: async (id, at, rig = true) => {
      await DB.prepare(
        `INSERT INTO game_ships (id,game_id,owner_faction_id,name,ship_class,parent_body_id,
           orbit_rp,orbit_ra,orbit_omega,orbit_m0,orbit_epoch,orbit_direction,
           fuel,fuel_max,status,built_at_tick,hp,hp_max,damage_per_tick,parts_json)
         VALUES (?,?, 'f1', ?, 'freighter', ?, 2,2,0,0,0,1, 0,0,'active',0,60,60,0, ?)`,
      ).bind(id, G, id, at, JSON.stringify(rig ? ['mining'] : [])).run();
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
  // THE SCALED RADII A REAL GAME ACTUALLY HAS. factions.js multiplies
  // every heliocentric orbit by SYSTEM_SCALE (=2) at module load and
  // meteoroids are generated from the result, so a fixture using the
  // pre-scale catalogue numbers would have hidden the very bug this
  // section now pins: belt rocks placed at 336-404 in a system whose
  // Earth is at 372.
  const hosts = [
    ['mercury', 144, 49, 4.40], ['venus', 268, 126, 3.18],
    ['earth', 372, 205, 1.75], ['mars', 566, 386, 6.20],
    ['jupiter', 920, 2000, 1.0], ['saturn', 1686, 4000, 2.0],
    ['uranus', 2400, 7000, 3.0], ['neptune', 3000, 9000, 4.0],
    ['pluto', 3800, 12000, 5.0], ['eris', 4200, 14000, 0.5],
    ['sedna', 5200, 20000, 2.5], ['makemake', 4000, 13000, 1.2],
  ].map(([id, r, p, ang]) => ({ id, orbit_radius: r, orbit_period: p, angle0: ang }));

  const rocks = generateMeteoroids(makeRand('seed-a'), hosts);
  check('thirty rocks', rocks.length === 30, String(rocks.length));
  check('twelve at L3', rocks.filter(r => r.type === 'lagrange').length === 12);

  // ---- THE BANDS SIT WHERE THE PLANETS ARE ------------------------
  // Every one of these was false when the bands were literals. The belt
  // came out at 336-404 — straddling EARTH — because the numbers were
  // written for the unscaled catalogue, and the "Kuiper" rocks orbited
  // between Uranus and Neptune with Pluto far outside them. Anchoring
  // to real bodies is what makes these hold at any scale.
  const rOf = (id) => hosts.find(h => h.id === id).orbit_radius;
  const belt = rocks.filter(r => r.id.startsWith('mtr_belt_'));
  const kuiper = rocks.filter(r => r.id.startsWith('mtr_kuiper_'));

  check('ten belt rocks', belt.length === 10, String(belt.length));
  check('the belt is BETWEEN Mars and Jupiter',
    belt.every(r => r.orbit_radius > rOf('mars') && r.orbit_radius < rOf('jupiter')),
    belt.map(r => Math.round(r.orbit_radius)).join(','));
  check('no belt rock is anywhere near Earth',
    belt.every(r => Math.abs(r.orbit_radius - rOf('earth')) > rOf('earth') * 0.25),
    `earth at ${rOf('earth')}, belt ${belt.map(r => Math.round(r.orbit_radius)).join(',')}`);

  check('eight Kuiper rocks', kuiper.length === 8, String(kuiper.length));
  check('every Kuiper apoapsis is beyond Neptune',
    kuiper.every(r => r.orbit_ra > rOf('neptune')),
    kuiper.map(r => Math.round(r.orbit_ra)).join(','));
  check('every Kuiper periapsis reaches back inside Neptune',
    kuiper.every(r => r.orbit_rp < rOf('neptune')),
    kuiper.map(r => Math.round(r.orbit_rp)).join(','));
  check('Kuiper orbits are genuinely eccentric',
    kuiper.every(r => r.orbit_ra > r.orbit_rp * 1.5));

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

  // SOL MUST EXIST. A restocked rock is parented to `${gameId}:sol`
  // like every other heliocentric body, so without a star row the
  // insert trips the foreign key — which is exactly how this fixture
  // caught the restock path inserting a NULL parent for three weeks.
  // Also gives the Kuiper band an outer planet to anchor against.
  await DB.prepare(
    `INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,
       radius,soi,mu,orbit_radius,orbit_period,angle0,color,
       yield_metal,yield_fuel,yield_gold,yield_science,development_level,
       fortification_level,shipyard_level)
     VALUES (?,?,'sol','Sol','star',NULL,10,0,0,0,0,0,'#fff',0,0,0,0,0,0,0)`,
  ).bind(`${G}:sol`, G).run();
  await DB.prepare(
    `INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,
       radius,soi,mu,orbit_radius,orbit_period,angle0,color,
       yield_metal,yield_fuel,yield_gold,yield_science,development_level,
       fortification_level,shipyard_level)
     VALUES (?,?,'neptune','Neptune','ice-giant',?,4,0,0,3000,900,0,'#48f',0,0,0,0,0,0,0)`,
  ).bind(`${G}:neptune`, G, `${G}:sol`).run();

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

// ---------------------------------------------------------------
// 4. THE RIG GATE
// ---------------------------------------------------------------
{
  const h = await seedGame('gmine2');
  await h.addRock('rock2', 120, 'metal', 500);
  await h.addFreighter('bare', 'home', false);   // no Mining Rig
  await h.addRoute([
    { body: 'rock2', action: 'mine' },
    { body: 'home', action: 'dropoff' },
  ], 'bare');
  await h.DB.prepare("UPDATE game_ships SET parent_body_id='rock2' WHERE id='bare'").run();

  await h.tick();
  await h.tick();
  const hold = Number((await h.DB.prepare(
    'SELECT cargo_metal FROM game_trade_route_ships WHERE ship_id=?').bind('bare').first())?.cargo_metal ?? 0);
  const left = Number((await h.DB.prepare(
    'SELECT mineral_remaining FROM game_bodies WHERE id=?').bind('rock2').first())?.mineral_remaining ?? 0);
  check('a hull with no Mining Rig extracts nothing', hold === 0, String(hold));
  check('...and the rock is untouched', left === 500, String(left));
  const seq = Number((await h.DB.prepare(
    'SELECT next_stop_seq FROM game_trade_route_ships WHERE ship_id=?').bind('bare').first())?.next_stop_seq ?? 0);
  check('...and it waits rather than skipping the stop', seq === 0, String(seq));
}

// ---------------------------------------------------------------
// 5. THE TELESCOPE
// ---------------------------------------------------------------
{
  // The range rule itself, tested directly — it is the thing the fog
  // pass and the discovery pass BOTH depend on, and a disagreement
  // between them would make a rock minable and invisible at once.
  const plainCity = settlementSensorRange('city', null);
  const withOne = settlementSensorRange('city', JSON.stringify({ telescope: 1 }));
  const withThree = settlementSensorRange('city', JSON.stringify({ telescope: 3 }));
  check('a telescope extends sensor range',
    withOne === plainCity + TELESCOPE_SENSOR_BONUS, `${plainCity} -> ${withOne}`);
  check('...and stacks per level',
    withThree === plainCity + 3 * TELESCOPE_SENSOR_BONUS, String(withThree));
  check('...while a city without one is unchanged',
    plainCity === settlementSensorRange('city', '{}'));
  check('malformed buildings json does not blow up the fog',
    settlementSensorRange('city', 'not json') === plainCity);

  // First light: a finished telescope finds the NEAREST unknown rock.
  const h = await seedGame('gtel1');
  await h.addRock('near_rock', 150, 'metal', 800);
  await h.addRock('far_rock', 4000, 'gold', 900);
  // addRock grants discovery; take both back so first light has a choice.
  await h.DB.prepare("DELETE FROM game_body_discoveries WHERE game_id='gtel1'").run();

  const posOf = (id) => ({ home: { x: 0, y: 0 },
                           near_rock: { x: 150, y: 0 },
                           far_rock: { x: 4000, y: 0 } }[id] ?? null);
  const res = await telescopeFirstLight(h.env, 'gtel1', 'f1', 'home', 5, posOf);
  check('first light finds a rock immediately', !!res.found, JSON.stringify(res));
  check('...the NEAREST one, not a random one', res.found === 'near_rock', String(res.found));

  const rows = (await h.DB.prepare(
    "SELECT body_id, method FROM game_body_discoveries WHERE game_id='gtel1'").all()).results ?? [];
  check('...recorded as a survey, not a flyby',
    rows.length === 1 && rows[0].method === 'survey', JSON.stringify(rows));
  const chron = await h.DB.prepare(
    "SELECT COUNT(*) n FROM chronicle_entries WHERE game_id='gtel1' AND kind='meteoroid_found'").first();
  check('...and announced', Number(chron?.n ?? 0) === 1);

  const again = await telescopeFirstLight(h.env, 'gtel1', 'f1', 'home', 6, posOf);
  check('a second telescope finds the NEXT rock, not the same one',
    again.found === 'far_rock', String(again.found));
}


// ---------------------------------------------------------------
// MANUAL MINING — the hand-operated flow beside the routed one.
//
// A freighter parked on a rock with a rig, told to dig. No route, no
// autopilot, no stop cursor: the only state is mining_body_id, and this
// pass is what turns that flag into ore. The cases worth pinning are the
// STOPS, because each is a way the operation can quietly become a no-op
// that a player only notices by staring at a cargo number three ticks
// later.
// ---------------------------------------------------------------
{
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const G = 'gmanual';
  const CAP = 400;
  const holdCap = () => CAP;

  // Users and rooms first: game_factions.user_id and games.id both carry
  // foreign keys, and the harness runs with them ON.
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u1','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'M','u1',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'active','s',0,1000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO game_factions
                      (id,game_id,user_id,name,color,slot,status,joined_at,metal,gold,science)
                    VALUES ('f1',?, 'u1','A','#fff',0,'active',0,0,0,0)`).bind(G).run();

  const mkBody = (id, kind, remaining) => DB.prepare(
    `INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,
       radius,soi,mu,orbit_radius,orbit_period,angle0,color,
       yield_metal,yield_fuel,yield_gold,yield_science,development_level,
       fortification_level,shipyard_level,mineral_kind,mineral_initial,mineral_remaining)
     VALUES (?,?,?,?,'meteoroid',NULL,1,0,0,700,1500,0,'#fff',0,0,0,0,0,0,0,?,?,?)`,
  ).bind(id, G, id, id, kind, remaining, remaining).run();
  await mkBody('rock', 'metal', 1000);
  await mkBody('other', 'gold', 1000);

  const mkShip = (id, bodyId, miningBodyId) => DB.prepare(
    `INSERT INTO game_ships (id,game_id,owner_faction_id,name,ship_class,parent_body_id,
       orbit_rp,orbit_ra,orbit_omega,orbit_m0,orbit_epoch,orbit_direction,
       fuel,fuel_max,status,built_at_tick,hp,hp_max,damage_per_tick,
       parts_json,mining_body_id)
     VALUES (?,?,'f1',?,'freighter',?,2,3,0,0,0,1,100,100,'active',0,60,60,0,'["mining"]',?)`,
  ).bind(id, G, id, bodyId, miningBodyId).run();

  await mkShip('digger', 'rock', 'rock');
  const res = await runManualMining({ DB }, G, 5, holdCap);
  const after = await DB.prepare(
    'SELECT cargo_metal, mining_body_id FROM game_ships WHERE id=?').bind('digger').first();
  const rockLeft = await DB.prepare(
    'SELECT mineral_remaining FROM game_bodies WHERE id=?').bind('rock').first();
  check('a parked rigged hull pulls ore',
    after.cargo_metal === MANUAL_MINE_RATE, JSON.stringify(after));
  check('...and the rock loses exactly that much',
    rockLeft.mineral_remaining === 1000 - MANUAL_MINE_RATE, JSON.stringify(rockLeft));
  check('...and keeps digging next tick', after.mining_body_id === 'rock');
  check('the pass reports what it did', res.worked === 1, JSON.stringify(res));

  // A hull that flew away must not keep mining a rock it is not at.
  await DB.prepare("UPDATE game_ships SET parent_body_id='other' WHERE id='digger'").run();
  await runManualMining({ DB }, G, 6, holdCap);
  const moved = await DB.prepare(
    'SELECT mining_body_id, cargo_metal FROM game_ships WHERE id=?').bind('digger').first();
  check('departing STOPS the dig', moved.mining_body_id === null, JSON.stringify(moved));
  check('...and it dug nothing that tick',
    moved.cargo_metal === MANUAL_MINE_RATE, JSON.stringify(moved));

  // A full hold stops, and the last scoop does not overfill it.
  await DB.prepare(
    "UPDATE game_ships SET parent_body_id='rock', mining_body_id='rock', cargo_metal=? WHERE id='digger'")
    .bind(CAP - 20).run();
  await runManualMining({ DB }, G, 7, holdCap);
  const full = await DB.prepare(
    'SELECT cargo_metal, mining_body_id FROM game_ships WHERE id=?').bind('digger').first();
  check('the last scoop is clipped to the free space',
    full.cargo_metal === CAP, JSON.stringify(full));
  check('...and a full hold stops the dig', full.mining_body_id === null);

  // An exhausted rock stops it too, rather than mining into the negative.
  await DB.prepare("UPDATE game_bodies SET mineral_remaining=30 WHERE id='rock'").run();
  await DB.prepare(
    "UPDATE game_ships SET mining_body_id='rock', cargo_metal=0 WHERE id='digger'").run();
  await runManualMining({ DB }, G, 8, holdCap);
  const drained = await DB.prepare(
    'SELECT cargo_metal, mining_body_id FROM game_ships WHERE id=?').bind('digger').first();
  const dead = await DB.prepare(
    'SELECT mineral_remaining, exhausted_at_tick FROM game_bodies WHERE id=?').bind('rock').first();
  check('takes only what is left', drained.cargo_metal === 30, JSON.stringify(drained));
  check('...never below zero', dead.mineral_remaining === 0, JSON.stringify(dead));
  check('...stamps the exhaustion tick', dead.exhausted_at_tick === 8, JSON.stringify(dead));
  check('...and stops', drained.mining_body_id === null);

  // A hull with no order is not touched by the pass.
  await mkShip('idle', 'other', null);
  const orders = await DB.prepare(
    "SELECT COUNT(*) n FROM game_ships WHERE game_id=? AND mining_body_id IS NOT NULL").bind(G).first();
  check('a hull with no order is left alone', orders.n === 0, JSON.stringify(orders));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
