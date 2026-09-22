// ============================================================
// ORPHANED FOLLOWERS — an escort whose leader is destroyed must keep
// flying the leader's course, on screen as well as in the tick.
//
// Live, 2026-09-21: 94 hulls were matched to Wu Tang's Mega Destroyer
// (meet 641.5, both legs ending at Mars at 658). It was destroyed at
// 646. The tick kept flying them — room.js reads the leader's leg from
// the table, dead ship or not — but the client drew the joined leg off
// the leader's entry in the /state ships list, destroyed ships are not
// in that list, and 94 hulls sat frozen at the meeting point.
//
// This drives the REAL /state handler against the REAL schema: the
// follower's node must carry the leader's plan when the leader is dead.
//
// Run: node sim/orphanFollowers.mjs
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
const G = 'gorphanfol1';
const now = Date.now();
for (const u of ['uA', 'uB']) {
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
    .bind(u, `${u}@t`, u, now).run();
}
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Orphans','uA',?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','orph',651,3600000,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'uA',?,'mars')`).bind(G, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'uB',?,'jupiter')`).bind(G, now).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();

const fA = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='uA'`).bind(G).first()).id;
const fB = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='uB'`).bind(G).first()).id;
const mars = `${G}:mars`;

const ship = async (id, owner, status, destroyedAt) => DB.prepare(
  `INSERT INTO game_ships
     (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
      orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
      fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, destroyed_at_tick)
   VALUES (?,?,?,?,'frigate',?, 20,20,0,0,0,1, 99,99,?,0, 100,100, 1, ?)`,
).bind(id, G, owner, id.split(':')[1], mars, status, destroyedAt).run();

// The leader, exactly as on the live board: DESTROYED at 646, its leg
// to Mars still 'in_transit' with a full launch plan.
const leader = `${G}:leader`;
await ship(leader, fB, 'destroyed', 646);
await DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
     scheduled_t, arrival_at_tick, fuel_cost, status,
     launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick)
   VALUES (?, ?, ?, 0, 'absolute', ?, 626, 658, 1, 'in_transit', 3000, 400, -1.5, 2.0, 0.9, 642)`,
).bind(`${leader}:n0`, G, leader, mars).run();

// A follower of mine, matched to it, meeting at 641.5, same end.
const follower = `${G}:escort`;
await ship(follower, fA, 'active', null);
await DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
     scheduled_t, arrival_at_tick, fuel_cost, status,
     launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick,
     rv_ax, rv_ay, rv_bx, rv_by, rv_meet_tick, rv_follow_ship_id)
   VALUES (?, ?, ?, 0, 'absolute', ?, 635, 658, 1, 'in_transit', 2600, 900, 0.4, 1.1, 0.9, 640,
           0.01, 0.02, -0.01, -0.02, 641.5, ?)`,
).bind(`${follower}:n0`, G, follower, mars, leader).run();

// An ordinary leg with no rendezvous, to prove the join adds nothing there.
const plain = `${G}:plain`;
await ship(plain, fA, 'active', null);
await DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
     scheduled_t, arrival_at_tick, fuel_cost, status, launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick)
   VALUES (?, ?, ?, 0, 'absolute', ?, 640, 660, 1, 'in_transit', 1000, 1000, 0, 0, 0.9, 650)`,
).bind(`${plain}:n0`, G, plain, mars).run();

const { routes } = await import('../worker/state.js');
const route = routes.find(r => r.method === 'GET' && String(r.pattern).includes('state'));
const path = `/api/games/${G}/state`;
const m = path.match(route.pattern);
const res = await route.handle({ json: async () => ({}), headers: new Map() }, env, {
  url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: 'uA' },
});
const body = JSON.parse(await res.text());
check('/state answers', res.status === 200, `${res.status} ${JSON.stringify(body).slice(0, 200)}`);

const nodes = body.nodes ?? body.ship_nodes ?? [];
const fn = nodes.find(n => n.ship_id === follower);
check('the follower leg is sent', !!fn, JSON.stringify(nodes.map(n => n.ship_id)));
check('the destroyed leader is NOT in the ships list (the premise)',
  !(body.ships ?? []).some(s => s.id === leader));
check('...but its plan rides on the follower leg',
  fn?.fl_launch_x === 3000 && fn?.fl_launch_y === 400
  && fn?.fl_launch_vx === -1.5 && fn?.fl_launch_vy === 2.0
  && fn?.fl_accel === 0.9 && fn?.fl_flip_tick === 642,
  JSON.stringify(fn));
check('...with where and when it ends',
  fn?.fl_target_body_id === mars && fn?.fl_scheduled_t === 626 && fn?.fl_arrival_at_tick === 658,
  JSON.stringify(fn));
const pn = nodes.find(n => n.ship_id === plain);
check('an ordinary leg carries no leader plan', !!pn && pn.fl_launch_x == null, JSON.stringify(pn));
check('...and the join duplicates no rows',
  nodes.filter(n => n.ship_id === follower).length === 1
  && nodes.filter(n => n.ship_id === plain).length === 1);

console.log(bad === 0 ? '\nALL ORPHAN FOLLOWER CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
