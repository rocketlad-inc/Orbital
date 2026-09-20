// ============================================================
// MEGA LAUNCH — a finished Mega Destroyer must become a hull.
//
// Reported by fartmaster: "my death star is completed but i don't see
// how to make it do anything." On the live board two Mega Destroyers
// are status='complete', fully paid (12,000 metal + 8,000 credits
// each), and there is no mega_destroyer ship anywhere in the database.
// The strike endpoint needs a HULL, so a completed Mega Destroyer was
// an inert marker that cost its builder the most expensive thing in
// the game.
//
// launchCompletedMobileSites exists, is idempotent, and runs every tick
// — inside a try/catch that only logs. So it was failing silently,
// every hour, for days. This drives the REAL function against a REAL
// schema so the failure is a readable line instead of a guess.
//
// Run: node sim/megaLaunch.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gmegalaunch1';
const now = Date.now();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u1','a@t','A','x',?)`).bind(now).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Launch','u1',?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','launch',560,3600000,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,?,'earth')`).bind(G, 'u1', now).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();

const me = await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first();
const jupiter = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='jupiter'`).bind(G).first()).id;

// A completed Mega Destroyer slipway, shaped exactly like the live rows.
const siteId = `${G}:mega_testsite`;
await DB.prepare(
  `INSERT INTO game_bodies (id, game_id, template_id, name, type, parent_body_id,
     orbit_radius, orbit_period, angle0, radius, soi, mu, color, owner_faction_id)
   VALUES (?, ?, 'mega_mega_destroyer', 'Mega Destroyer Site', 'megastructure', ?,
     40, 120, 0, 1.8, 2, 0, '#ff5e5e', ?)`,
).bind(siteId, G, jupiter, me.id).run();
await DB.prepare(
  `INSERT INTO game_megastructures (body_id, game_id, kind, status, acc_metal, acc_credits,
     cost_metal, cost_credits, founded_by_faction_id, founded_at_tick, completed_at_tick, hp, variant)
   VALUES (?, ?, 'mega_destroyer', 'complete', 12000, 8000, 12000, 8000, ?, 280, 562, 3000, 'A')`,
).bind(siteId, G, me.id).run();

// THE FIXTURE HAS TO BE A SLIPWAY SOMEBODY ACTUALLY BUILT.
//
// The first draft of this file staged a completed site that nobody had
// ever supplied — and the launch passed nine checks out of nine, while
// the same code failed every hour in production. That scenario cannot
// exist: 20,000 units do not arrive by themselves. On the live board
// SIX supply freighters were still parked at each slipway and 185
// flight plans targeted it, and those rows are what the launch's final
// DELETE ran into. A clean fixture tested an impossible world.
const hauler = `${G}:supply1`;
await DB.prepare(
  `INSERT INTO game_ships
     (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
      orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
      fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES (?,?,?,'Supply Run','freighter',?, 2,2,0,0,0,1, 99,99,'active',0, 40,40, 0)`,
).bind(hauler, G, me.id, siteId).run();
// History: a delivery that already landed at the slipway.
await DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
     scheduled_t, fuel_cost, status)
   VALUES (?, ?, ?, 0, 'absolute', ?, 500, 1, 'executed')`,
).bind(`${hauler}:n0`, G, hauler, siteId).run();
// And one still on its way there when the slipway launches.
const inbound = `${G}:supply2`;
await DB.prepare(
  `INSERT INTO game_ships
     (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
      orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
      fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES (?,?,?,'Late Load','freighter',?, 2,2,0,0,0,1, 99,99,'active',0, 40,40, 0)`,
).bind(inbound, G, me.id, jupiter).run();
await DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
     scheduled_t, fuel_cost, status, arrival_at_tick)
   VALUES (?, ?, ?, 0, 'absolute', ?, 560, 1, 'in_transit', 580)`,
).bind(`${inbound}:n0`, G, inbound, siteId).run();

const hullsBefore = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND ship_class='mega_destroyer'`).bind(G).first()).n;
check('the scenario starts like the live board: complete, no hull', hullsBefore === 0);

const store = new Map();
const { Room } = await import('../worker/room.js');
const { launchCompletedMobileSites } = await import('../worker/megaLaunch.js');
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  broadcast: () => {},
}, env);

// Called DIRECTLY, not through resolveTick, so an exception surfaces
// here instead of vanishing into the tick's "never fail the turn" catch
// — which is precisely where it has been hiding in production.
let launchErr = null;
let launched = 0;
try {
  launched = await room.launchCompletedMobileSites(G, 563);
} catch (e) { launchErr = e; }
check('the launch pass does not throw', launchErr === null,
  launchErr ? String(launchErr.message).slice(0, 300) : '');
check('...and reports one launch', launched === 1, String(launched));

const hull = await DB.prepare(
  `SELECT id, owner_faction_id, parent_body_id, status, hp, hp_max
     FROM game_ships WHERE game_id=? AND ship_class='mega_destroyer'`).bind(G).first();
check('a Mega Destroyer HULL now exists', !!hull, 'none');
check('...owned by whoever built it', hull?.owner_faction_id === me.id, String(hull?.owner_faction_id));
check('...parked at the world it was built over', hull?.parent_body_id === jupiter,
  String(hull?.parent_body_id));
check('...and active', hull?.status === 'active', String(hull?.status));

const siteLeft = await DB.prepare(`SELECT destroyed_at_tick FROM game_bodies WHERE id=?`).bind(siteId).first();
check('the spent slipway is gone from the map',
  !siteLeft || siteLeft.destroyed_at_tick != null, JSON.stringify(siteLeft));

// THE TRAP UNDERNEATH. game_ships.parent_body_id is ON DELETE CASCADE.
// A launch that hard-deleted the slipway — the obvious "fix" for the
// blocked delete is to clear the rows blocking it — would take every
// freighter parked there down with it, silently. They must survive,
// and land on the world the slipway was orbiting.
const parked = await DB.prepare(`SELECT status, parent_body_id FROM game_ships WHERE id=?`).bind(hauler).first();
check('the freighter parked at the slipway SURVIVES the launch', !!parked,
  'deleted by cascade along with the slipway');
check('...still active', parked?.status === 'active', String(parked?.status));
check('...and now orbits the world the slipway stood over', parked?.parent_body_id === jupiter,
  String(parked?.parent_body_id));

const flying = await DB.prepare(`SELECT target_body_id FROM game_ship_nodes WHERE id=?`)
  .bind(`${inbound}:n0`).first();
check('a load still in flight lands on the world instead of a spent slipway',
  flying?.target_body_id === jupiter, String(flying?.target_body_id));
const history = await DB.prepare(`SELECT target_body_id FROM game_ship_nodes WHERE id=?`)
  .bind(`${hauler}:n0`).first();
check('...while a delivery that already happened keeps its history',
  history?.target_body_id === siteId, String(history?.target_body_id));

// It was announced. The launch wrote to a table that has never
// existed (game_chronicle), inside a try/catch — so even a launch that
// worked would have happened in silence.
const told = await DB.prepare(
  `SELECT COUNT(*) AS n FROM chronicle_entries WHERE game_id=? AND kind='megastructure_launched'`)
  .bind(G).first();
check('the launch is announced in the chronicle', told.n === 1, String(told.n));

// Idempotent: a retried tick must not mint a second hull.
const again = await room.launchCompletedMobileSites(G, 564);
const hullsAfter = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND ship_class='mega_destroyer'`).bind(G).first()).n;
check('running it again launches nothing more', again === 0 && hullsAfter === 1, `${again}, ${hullsAfter}`);

// ============================================================
// 2. EVERY MOBILE STRUCTURE LAUNCHES THE MOMENT IT COMPLETES.
//
// Lorne: "make sure all megastructures launch upon completion." The
// launch used to be an hourly sweep only, which ran BEFORE supply routes
// unloaded, and a hand delivery happens between ticks — so a finished
// slipway sat inert for up to an hour, or two. Completion now launches
// where it happens; the sweep stays as a backstop.
// ============================================================

const { MOBILE_KINDS } = await import('../worker/megaLaunch.js');
const { MEGASTRUCTURES } = await import('../worker/megastructures.js');
const { SHIP_COMBAT_STATS } = await import('../worker/factions.js');

// "All" means all, including a kind somebody adds next month. The list
// comes from the catalogue's family, and every member must be launchable.
check('both mobile kinds are read from the catalogue',
  MOBILE_KINDS.includes('mega_destroyer') && MOBILE_KINDS.includes('mobile_foundry'),
  JSON.stringify(MOBILE_KINDS));
for (const kind of MOBILE_KINDS) {
  check(`${kind} has hull stats, so it can actually launch`,
    !!SHIP_COMBAT_STATS[kind] && !!MEGASTRUCTURES[kind]?.label);
}

async function stageSite(kind, status, accMetal, accCredits) {
  const id = `${G}:mega_${kind}_${Math.random().toString(36).slice(2, 8)}`;
  await DB.prepare(
    `INSERT INTO game_bodies (id, game_id, template_id, name, type, parent_body_id,
       orbit_radius, orbit_period, angle0, radius, soi, mu, color, owner_faction_id)
     VALUES (?, ?, ?, ?, 'megastructure', ?, 40, 120, 0, 1.8, 2, 0, '#ff5e5e', ?)`,
  ).bind(id, G, `mega_${kind}`, `${kind} site`, jupiter, me.id).run();
  await DB.prepare(
    `INSERT INTO game_megastructures (body_id, game_id, kind, status, acc_metal, acc_credits,
       cost_metal, cost_credits, founded_by_faction_id, founded_at_tick, completed_at_tick, hp, variant)
     VALUES (?, ?, ?, ?, ?, ?, 1000, 1000, ?, 300, ?, 3000, 'A')`,
  ).bind(id, G, kind, status, accMetal, accCredits, me.id, status === 'complete' ? 563 : null).run();
  return id;
}
const hullOf = (siteId) => DB.prepare(
  `SELECT id, ship_class FROM game_ships WHERE game_id=? AND id=?`).bind(G, `${siteId}_hull`).first();

// --- a hand delivery carries the last load ---
const foundry = await stageSite('mobile_foundry', 'building', 900, 900);
const porter = `${G}:porter`;
await DB.prepare(
  `INSERT INTO game_ships
     (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
      orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
      fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick,
      cargo_metal, cargo_gold)
   VALUES (?,?,?,'Last Load','freighter',?, 2,2,0,0,0,1, 99,99,'active',0, 40,40, 0, 500, 500)`,
).bind(porter, G, me.id, foundry).run();

async function callRoute(routes, method, path, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const res = await r.handle({ json: async () => body, headers: new Map() }, env, {
      url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: 'u1' },
    });
    return JSON.parse(await res.text());
  }
  throw new Error(`no route matched ${method} ${path}`);
}
const actionRoutes = (await import('../worker/actions.js')).routes;
const delivered = await callRoute(actionRoutes, 'POST',
  `/api/games/${G}/megastructures/${foundry}/deliver`, { ship_id: porter });
check('the last hand-delivered load completes the Mobile Foundry',
  delivered?.site?.status === 'complete', JSON.stringify(delivered).slice(0, 300));
check('...and the hull launches in the same request, not at the next tick',
  delivered?.launched === true && (await hullOf(foundry))?.ship_class === 'mobile_foundry',
  JSON.stringify(delivered).slice(0, 300));
const porterNow = await DB.prepare(`SELECT status, parent_body_id FROM game_ships WHERE id=?`).bind(porter).first();
check('...and the freighter that delivered it is still flying, now at the world',
  porterNow?.status === 'active' && porterNow?.parent_body_id === jupiter, JSON.stringify(porterNow));

// --- two launches racing: an action landing while a tick runs ---
const contested = await stageSite('mega_destroyer', 'complete', 1000, 1000);
await Promise.all([
  room.launchCompletedMobileSites(G, 565),
  launchCompletedMobileSites(env, G, 565),
]);
const twins = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships
    WHERE game_id=? AND ship_class='mega_destroyer' AND built_at_tick=565`)
  .bind(G).first()).n;
check('two launches racing for one slipway mint exactly ONE hull', twins === 1,
  `${twins} hulls from ${contested}`);
const toldTwice = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM chronicle_entries WHERE game_id=? AND kind='megastructure_launched' AND tick_number=565`)
  .bind(G).first()).n;
check('...and ONE announcement', toldTwice === 1, String(toldTwice));

// --- a FIXED structure finished between ticks is announced once ---
// A hand delivery stamps completed_at_tick with the tick BEFORE the one
// that sweeps it; the sweep asked for "this tick" and never matched.
// A live Weapons Station finished at 551 and was never announced.
const station = await stageSite('weapons_station', 'complete', 1000, 1000);
await DB.prepare(`UPDATE game_megastructures SET completed_at_tick = 569 WHERE body_id = ?`).bind(station).run();
await room.chronicleCompletions(G, 570);
await room.chronicleCompletions(G, 570);
const stationTold = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM chronicle_entries WHERE game_id=? AND kind='megastructure_complete' AND body_id=?`)
  .bind(G, station).first()).n;
check('a structure finished between ticks is announced by the next sweep — once',
  stationTold === 1, String(stationTold));

console.log(bad === 0 ? '\nALL MEGA LAUNCH CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
