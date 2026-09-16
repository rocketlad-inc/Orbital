// ============================================================
// RETREAT DESTINATION — where a hull runs when RETREAT AT fires.
//
// Migration 0126. The rule: the yard the player chose for the hull,
// else the yard that built it (home), else the nearest — each only
// while a living station of theirs still stands there. Driven through
// the REAL auto-retreat pass in room.js resolveTick and the real orders
// endpoint in actions.js.
//
// Geometry: the hull sits at Mars. Its home yard is the capital (Earth
// system, far); a second yard sits on a Mars moon (near). Nearest-first
// would always pick the moon, so every case here is decidable.
//
// Run: node sim/retreatHome.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

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

async function callRoute(env, routes, method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const req = { json: async () => body, headers: new Map() };
    const res = await r.handle(req, env, {
      url: new URL(`https://x${path}`),
      params: m.groups ?? {},
      session: { user_id: userId },
    });
    return JSON.parse(await res.text());
  }
  throw new Error(`no route matched ${method} ${path}`);
}

async function seed(tag) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = `gretr${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Retreat Test','uA',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                    VALUES (?, 'setup','retreat-seed',0,3600000,0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                    VALUES (?,?,0,'earth'), (?,?,1,'venus')`).bind(G, 'uA', G, 'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
  const [A, B] = (await DB.prepare(
    `SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;

  // The seeded starter fleet is the spawn-stamp check; clear it after.
  const starters = (await DB.prepare(
    `SELECT id, home_body_id, parent_body_id FROM game_ships WHERE game_id = ? AND owner_faction_id = ?`)
    .bind(G, A.id).all()).results ?? [];

  await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
  await DB.prepare('UPDATE game_bodies SET yield_metal = 0, yield_gold = 0, yield_science = 0 WHERE game_id = ?').bind(G).run();

  // A Mars moon for the near yard.
  const moon = await DB.prepare(
    `SELECT id FROM game_bodies WHERE game_id = ? AND parent_body_id = ? ORDER BY orbit_radius LIMIT 1`)
    .bind(G, `${G}:mars`).first();
  if (!moon) throw new Error('seed has no Mars moon');

  const { Room } = await import('../worker/room.js');
  const room = new Room(makeState(), env);
  room.broadcast = () => {};
  const legacy = (await import('../worker/actions.js')).routes;

  let tickNow = 0;
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      tickNow += 1;
      await room.resolveTick(G, tickNow);
      await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run();
    }
  };
  const station = async (id, faction, bodyId, yard = true) => {
    await DB.prepare(
      `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
         hp, hp_max, population, surface_angle, created_at_tick, buildings_json)
       VALUES (?, ?, ?, ?, 'station', ?, 100, 100, 1, 0, 0, ?)`,
    ).bind(id, G, bodyId, faction.id, id, yard ? '{"shipyard":1}' : '{}').run();
  };
  const ship = async (id, faction, at, opts = {}) => {
    await DB.prepare(
      `INSERT INTO game_ships
        (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
         orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
         fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick,
         retreat_hp_pct, home_body_id, retreat_body_id)
       VALUES (?, ?, ?, ?, 'destroyer', ?, 2, 2, 0, 0, 0, 1,
               999, 999, 'active', 1, ?, 100, 8, ?, ?, ?)`,
    ).bind(id, G, faction.id, `Ship ${id}`, at, opts.hp ?? 20, opts.retreatPct ?? 50,
           opts.home ?? null, opts.chosen ?? null).run();
  };
  const legOf = (shipId) => DB.prepare(
    `SELECT target_body_id FROM game_ship_nodes WHERE ship_id = ? AND status IN ('committed','in_transit') ORDER BY sequence DESC LIMIT 1`)
    .bind(shipId).first();
  const retreatLog = (shipId) => DB.prepare(
    `SELECT payload FROM chronicle_entries WHERE kind = 'ship_retreated' AND ship_id = ? ORDER BY tick_number DESC LIMIT 1`)
    .bind(shipId).first().then(r => (r ? JSON.parse(r.payload) : null));
  const orders = (user, body) => callRoute(env, legacy, 'PATCH', `/api/games/${G}/ships/orders`, user, body);

  return { DB, G, A, B, starters, moon: moon.id, mars: `${G}:mars`, tick, station, ship, legOf, retreatLog, orders };
}

// 1. SPAWN STAMPS HOME: the seeded starter fleet already carries it.
{
  const h = await seed('sp');
  check('seeding stamps home_body_id on every starter hull',
    h.starters.length > 0 && h.starters.every(s => s.home_body_id === s.parent_body_id),
    JSON.stringify(h.starters.map(s => [s.id.slice(-12), s.home_body_id?.slice(-8), s.parent_body_id?.slice(-8)])));
}

// 2. HOME BEATS NEAREST: hull at Mars, home yard at the capital (far),
//    a yard on a Mars moon (near). It runs home.
{
  const h = await seed('hm');
  await h.station('st_home', h.A, h.A.capital_body_id);
  await h.station('st_moon', h.A, h.moon);
  await h.ship('s_home', h.A, h.mars, { home: h.A.capital_body_id });
  await h.tick(1);
  const leg = await h.legOf('s_home');
  check('home: the retreat leg targets the home yard, not the nearer moon yard',
    leg?.target_body_id === h.A.capital_body_id, JSON.stringify(leg));
  const log = await h.retreatLog('s_home');
  check('home: the chronicle says why', log?.destination === 'home' && log?.repairs === true, JSON.stringify(log));
}

// 3. CHOSEN BEATS HOME.
{
  const h = await seed('ch');
  await h.station('st_home', h.A, h.A.capital_body_id);
  await h.station('st_moon', h.A, h.moon);
  await h.ship('s_ch', h.A, h.mars, { home: h.A.capital_body_id, chosen: h.moon });
  await h.tick(1);
  const leg = await h.legOf('s_ch');
  check('chosen: the leg targets the chosen port', leg?.target_body_id === h.moon, JSON.stringify(leg));
  check('chosen: the chronicle says why', (await h.retreatLog('s_ch'))?.destination === 'chosen');
}

// 4. A DEAD HOME DEGRADES TO NEAREST, never to nowhere.
{
  const h = await seed('dd');
  await h.station('st_moon', h.A, h.moon);            // no station at home any more
  await h.ship('s_dd', h.A, h.mars, { home: h.A.capital_body_id });
  await h.tick(1);
  const leg = await h.legOf('s_dd');
  check('dead home: falls back to the nearest yard', leg?.target_body_id === h.moon, JSON.stringify(leg));
  check('dead home: the chronicle says nearest', (await h.retreatLog('s_dd'))?.destination === 'nearest');
}

// 5. A CHOSEN PLAIN STATION (no yard) is honoured, and the log says no repairs.
{
  const h = await seed('pl');
  await h.station('st_home', h.A, h.A.capital_body_id);
  await h.station('st_moon', h.A, h.moon, false);
  await h.ship('s_pl', h.A, h.mars, { home: h.A.capital_body_id, chosen: h.moon });
  await h.tick(1);
  const leg = await h.legOf('s_pl');
  const log = await h.retreatLog('s_pl');
  check('plain chosen port: honoured', leg?.target_body_id === h.moon, JSON.stringify(leg));
  check('plain chosen port: log says no repairs', log?.repairs === false && log?.destination === 'chosen', JSON.stringify(log));
}

// 6. ALREADY AT THE CHOSEN PORT: no leg is written.
{
  const h = await seed('at');
  await h.station('st_home', h.A, h.A.capital_body_id);
  await h.station('st_mars', h.A, h.mars);
  await h.ship('s_at', h.A, h.mars, { home: h.A.capital_body_id, chosen: h.mars });
  await h.tick(1);
  check('already at chosen port: no retreat leg', !(await h.legOf('s_at')));
}

// 7. THE ENDPOINT: only a body with a living station of yours.
{
  const h = await seed('ep');
  await h.station('st_home', h.A, h.A.capital_body_id);
  await h.station('st_rival', h.B, h.moon);
  await h.ship('ship_ep1', h.A, h.mars, { home: h.A.capital_body_id, hp: 100 });
  const bad1 = await h.orders('uA', { ship_ids: ['ship_ep1'], retreat_body_id: h.moon });
  check('endpoint: refuses a port that is only a rival station', bad1.error?.code === 'no_port', JSON.stringify(bad1));
  const bad2 = await h.orders('uA', { ship_ids: ['ship_ep1'], retreat_body_id: h.mars });
  check('endpoint: refuses a body with no station', bad2.error?.code === 'no_port', JSON.stringify(bad2));
  const ok = await h.orders('uA', { ship_ids: ['ship_ep1'], retreat_body_id: h.A.capital_body_id });
  check('endpoint: accepts our own port', !!ok.ok && ok.orders?.retreat_body_id === h.A.capital_body_id, JSON.stringify(ok));
  const row = await h.DB.prepare('SELECT retreat_body_id FROM game_ships WHERE id = ?').bind('ship_ep1').first();
  check('endpoint: stored', row?.retreat_body_id === h.A.capital_body_id, JSON.stringify(row));
  const cleared = await h.orders('uA', { ship_ids: ['ship_ep1'], retreat_body_id: null });
  const row2 = await h.DB.prepare('SELECT retreat_body_id FROM game_ships WHERE id = ?').bind('ship_ep1').first();
  check('endpoint: null clears back to home', !!cleared.ok && row2?.retreat_body_id == null, JSON.stringify(row2));
  const other = await h.orders('uB', { ship_ids: ['ship_ep1'], retreat_body_id: h.moon });
  check('endpoint: a rival cannot set orders on our hull', !other.ok, JSON.stringify(other).slice(0, 120));
}

console.log(bad === 0 ? '\nALL RETREAT-DESTINATION CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
