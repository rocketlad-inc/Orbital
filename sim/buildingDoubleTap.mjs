// ============================================================
// One tap, one upgrade (2026-10-18).
//
// Sam: a lab built as L1 "then automatically starts the level 2 upgrade".
// TheSaltedPork: a telescope "didn't build the first time ... I tried
// again and it started building but it charged me twice". ciurk: shields
// overcharged by 300 metal. One cause: the build button reads the state
// poll, so for a moment after a tap it still offers the same level, and a
// second tap was priced and charged as the NEXT level.
//
// The client now says which level it is buying (target_level). Drives the
// REAL queue endpoint:
//   1. the first tap queues L1 and charges once
//   2. a second tap for L1 is refused, already_queued, and charges nothing
//   3. asking for L2 on purpose still works
//   4. an older client (no target_level) behaves as before
//
// Run: npm run sim:buildtap
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}
async function callRoute(env, routes, method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const req = { json: async () => body, headers: new Map(), url: `https://x${path}` };
    const res = await r.handle(req, env, { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  throw new Error(`no route matched ${method} ${path}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gbuildtap';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Tap','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','tap-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active', gating_enabled = 0 WHERE id = ?").bind(G).run();
const A = await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = 'uA'`).bind(G).first();
await DB.prepare(`UPDATE game_factions SET metal = 100000, gold = 100000 WHERE id = ?`).bind(A.id).run();
const city = await DB.prepare(`SELECT id FROM game_settlements WHERE game_id = ? AND owner_faction_id = ? AND body_id = ? AND destroyed_at_tick IS NULL LIMIT 1`)
  .bind(G, A.id, A.capital_body_id).first();
await DB.prepare(`UPDATE game_settlements SET stockpile_metal = 0, stockpile_gold = 0, building_order_json = NULL, building_backlog_json = NULL WHERE id = ?`).bind(city.id).run();

const { routes } = await import('../worker/actions.js');
const path = `/api/games/${G}/settlements/${city.id}/buildings`;
const gold = async () => (await DB.prepare('SELECT gold FROM game_factions WHERE id = ?').bind(A.id).first()).gold;
const queued = async () => {
  const r = await DB.prepare('SELECT building_order_json o, building_backlog_json b FROM game_settlements WHERE id = ?').bind(city.id).first();
  const all = [r.o ? JSON.parse(r.o) : null, ...(r.b ? JSON.parse(r.b) : [])].filter(Boolean);
  return all.filter(x => x.kind === 'lab').map(x => x.target_level);
};

const g0 = await gold();
let r = await callRoute(env, routes, 'POST', path, 'uA', { kind: 'lab', target_level: 1 });
const g1 = await gold();
check('the first tap queues Lab L1', r.status < 300 && JSON.stringify(await queued()) === '[1]', JSON.stringify(r));
check('...and charges once', g1 < g0, `${g0} -> ${g1}`);

r = await callRoute(env, routes, 'POST', path, 'uA', { kind: 'lab', target_level: 1 });
const g2 = await gold();
check('a second tap for L1 is refused as already queued', r.status === 409 && r.body?.error?.code === 'already_queued', JSON.stringify(r));
check('...and charges nothing', g2 === g1, `${g1} -> ${g2}`);
check('...and queues nothing', JSON.stringify(await queued()) === '[1]', JSON.stringify(await queued()));

r = await callRoute(env, routes, 'POST', path, 'uA', { kind: 'lab', target_level: 2 });
check('asking for L2 on purpose still queues it', r.status < 300 && JSON.stringify(await queued()) === '[1,2]', JSON.stringify({ r, q: await queued() }));

r = await callRoute(env, routes, 'POST', path, 'uA', { kind: 'lab' });
check('an older client without target_level gets the old projection (L3)', r.status < 300 && JSON.stringify(await queued()) === '[1,2,3]', JSON.stringify({ r, q: await queued() }));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
