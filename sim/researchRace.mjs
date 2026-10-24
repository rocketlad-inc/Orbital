// ============================================================
// Two UNLOCK NOWs at once (playtest, 2026-10-24): with 19 science and two
// 15-science levels clicked back to back, both were granted and science
// went to -11. The debit is guarded now: one is granted, the other told
// there is not enough science, and science never goes below zero.
//
// Run: node sim/researchRace.mjs
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
const G = 'gresrace1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Race','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?, 'setup','race-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'earth'), (?,?,1,'mars')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
const A = await DB.prepare(`SELECT id FROM game_factions WHERE game_id = ? AND user_id = 'uA'`).bind(G).first();
await DB.prepare('UPDATE game_factions SET science = 19, research_tech_id = NULL, research_progress = 0 WHERE id = ?').bind(A.id).run();

const { routes } = await import('../worker/actions.js');
const r = routes.find(x => x.method === 'POST' && String(x.pattern).includes('research$'));
const unlock = (tech) => r.handle(new Request('https://x', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tech_id: tech }),
}), env, { session: { user_id: 'uA' }, params: { gameId: G } });

const [a, b] = await Promise.all([unlock('sensors'), unlock('propulsion')]);
const sci = (await DB.prepare('SELECT science FROM game_factions WHERE id = ?').bind(A.id).first()).science;
const levels = (await DB.prepare(`SELECT tech_id, level FROM faction_techs WHERE faction_id = ? AND tech_id IN ('sensors','propulsion')`).bind(A.id).all()).results;
check('science never goes below zero', Number(sci) >= 0, `science ${sci}`);
check('only one of the two is granted', levels.length === 1, JSON.stringify(levels));
check('the other is refused, not silently charged', [a.status, b.status].sort().join() === '201,409', `${a.status} ${b.status}`);
console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
