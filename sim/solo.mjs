// ============================================================
// SOLO (worker/solo.js + worker/aiEmpire.js) — one person and computer
// empires, on the REAL create route, seeder, tick and action handlers
// (Lorne, 2026-10-23: "it might be time to bring back single player").
//
//   1. POST /api/solo seats the person and N computer empires, starts the
//      game at the chosen speed, deals the doctrines, and keeps the room
//      out of every listing
//   2. the computer empires play through the real handlers: research,
//      ships, buildings; a ruthless one declares war on the person
//   3. one turn per tick: a second pass in the same tick does nothing
//   4. they vote in the Senate, so quorum can be met
//   5. pause / step / speed / resume drive the clock, host only
//
// Run: npm run sim:solo
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
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const doCalls = [];
const env = {
  DB,
  ROOM: {
    idFromName: () => 'x',
    get: () => ({ fetch: async (url) => { doCalls.push(String(url)); return new Response('{}'); } }),
  },
};
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uH','h@t','Hana','x',0), ('uX','x@t','Xavi','x',0)`).run();

const solo = await import('../worker/solo.js');
const lobby = await import('../worker/lobby.js');
const ai = await import('../worker/aiEmpire.js');
const senate = await import('../worker/senate.js');

async function call(mod, method, path, userId, body) {
  for (const r of mod.routes) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const req = new Request(`https://x${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const res = await r.handle(req, env, { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  }
  throw new Error(`no route matched ${method} ${path}`);
}

// ---- 1. create --------------------------------------------------------
const made = await call(solo, 'POST', '/api/solo', 'uH', { rivals: 3, difficulty: 'ruthless', speed_ms: 30000 });
check('POST /api/solo starts a game', made.status === 200 && made.data?.game_id, JSON.stringify(made));
const G = made.data.game_id;
const game = await DB.prepare('SELECT * FROM games WHERE id = ?').bind(G).first();
check('the game is solo, active, at 30 s a tick', game.solo === 1 && game.status === 'active' && game.tick_interval_ms === 30000,
  JSON.stringify({ solo: game.solo, status: game.status, ms: game.tick_interval_ms }));
check('difficulty recorded', game.solo_difficulty === 'ruthless');
const facs = (await DB.prepare('SELECT id, user_id, ai_doctrine, capital_body_id, status FROM game_factions WHERE game_id = ? ORDER BY slot').bind(G).all()).results;
const human = facs.find(f => f.user_id === 'uH');
const bots = facs.filter(f => f.ai_doctrine);
check('one person and three computer empires', facs.length === 4 && !!human && !human.ai_doctrine && bots.length === 3,
  JSON.stringify(facs.map(f => [f.user_id, f.ai_doctrine])));
check('every seat has a capital', facs.every(f => f.capital_body_id), JSON.stringify(facs.map(f => f.capital_body_id)));
check('ruthless deals the warmongers', bots.filter(b => b.ai_doctrine === 'rusher').length === 2,
  JSON.stringify(bots.map(b => b.ai_doctrine)));
const browse = await DB.prepare(`SELECT COUNT(*) AS c FROM games g WHERE g.status = 'active' AND COALESCE(g.solo, 0) = 0`).first();
check('solo games stay out of the browse list', browse.c === 0);
const room = await DB.prepare('SELECT password_hash, quick_join FROM rooms WHERE id = ?').bind(G).first();
check('nobody can join the room', room.password_hash === 'solo:no-entry' && room.quick_join === 0);
const rerun = await lobby.startGame(env, G);
check('starting it again is refused', !!rerun.error);

// ---- 2. they play ------------------------------------------------------
const { Room } = await import('../worker/room.js');
const r = new Room(makeState(), env);
r.broadcast = () => {};
await DB.prepare('UPDATE game_factions SET science = science + 0 WHERE game_id = ?').bind(G).run();
const tally = {};
let t = Number(game.current_tick ?? 0);
let doubled = 0;
const playTo = async (n) => {
  while (t < n) {
    t += 1;
    await r.resolveTick(G, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
    await ai.runSoloGame(env, G, tally);
    doubled += await ai.runSoloGame(env, G, tally);
  }
};
await playTo(80);
const sum = (re) => Object.entries(tally).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
console.log('        tally:', JSON.stringify(tally));
check('3. a second pass in the same tick plays nobody', doubled === 0, `${doubled} doubled turns`);
check('they research', sum(/:research_ok$/) > 0);
check('they lay down ships', sum(/:build_\w+_ok$/) > 0);
check('they raise city buildings', sum(/:bld_\w+_ok$/) > 0);
const ships = await DB.prepare(`SELECT COUNT(*) AS c FROM game_ships WHERE game_id = ? AND owner_faction_id IN (${bots.map(() => '?').join(',')}) AND hp > 0`)
  .bind(G, ...bots.map(b => b.id)).first();
check('their ships launch', ships.c > 0, `${ships.c} ships`);
const warsOnHuman = await DB.prepare(`SELECT COUNT(*) AS c FROM game_wars WHERE game_id = ? AND (faction_a = ? OR faction_b = ?)`)
  .bind(G, human.id, human.id).first();
check('ruthless: a computer empire declares on the person', warsOnHuman.c > 0, JSON.stringify(tally));
const routes = (await DB.prepare(`SELECT ship_id, origin_body_id, dest_body_id, status, kind, created_at_tick, cancelled_at_tick
                                     FROM game_trade_routes WHERE game_id = ? ORDER BY created_at_tick`).bind(G).all()).results;
check('one terraform route per world, not one per turn', routes.length <= 6, `${routes.length} routes`);
const refused = Object.entries(tally).filter(([k]) => !/_ok$|_no_target$/.test(k));
console.log('        refused:', JSON.stringify(Object.fromEntries(refused)));

// ---- 4. the senate -----------------------------------------------------
// The person takes the gavel and files a bill; each computer empire votes.
const term = await DB.prepare('SELECT * FROM senate_terms WHERE game_id = ? ORDER BY term_index DESC LIMIT 1').bind(G).first();
check('the senate is in session', !!term);
if (term) {
  await DB.prepare('UPDATE senate_terms SET faction_id = ? WHERE game_id = ? AND term_index = ?').bind(human.id, G, term.term_index).run();
  await DB.prepare('DELETE FROM senate_proposals WHERE game_id = ?').bind(G).run();
  const prop = await call(senate, 'POST', `/api/games/${G}/senate/proposals`, 'uH', {
    kind: 'slider_law', title: 'Cheaper Ships', summary: 'Ships cost less.',
    slider_id: 'ship_build_cost_multiplier', target_value: 0.8,
  });
  check('the person files a bill', prop.status < 300, JSON.stringify(prop.data));
  const filed = await DB.prepare('SELECT id FROM senate_proposals WHERE game_id = ? ORDER BY proposed_at_tick DESC LIMIT 1').bind(G).first();
  if (filed) {
    await playTo(t + 1);
    const votes = await DB.prepare(`SELECT COUNT(*) AS c FROM senate_votes v JOIN game_factions f ON f.id = v.faction_id
                                     WHERE v.proposal_id = ? AND f.ai_doctrine IS NOT NULL`).bind(filed.id).first();
    check('4. every computer empire votes on an open bill', votes.c === 3, `${votes.c} votes`);
  }
}
check('a computer chairman files a bill of its own', sum(/:propose_ok$/) > 0,
  JSON.stringify(Object.fromEntries(Object.entries(tally).filter(([k]) => /propose/.test(k)))));

// ---- 5. the clock ------------------------------------------------------
const x = await call(solo, 'POST', `/api/games/${G}/solo/pause`, 'uX');
check('someone else cannot pause it', x.status === 403, JSON.stringify(x));
const p = await call(solo, 'POST', `/api/games/${G}/solo/pause`, 'uH');
let g2 = await DB.prepare('SELECT paused, next_tick_at FROM games WHERE id = ?').bind(G).first();
check('pause stops the clock', p.status === 200 && g2.paused === 1 && g2.next_tick_at == null, JSON.stringify(g2));
const due = await DB.prepare(`SELECT COUNT(*) AS c FROM games WHERE status = 'active' AND COALESCE(paused, 0) = 0 AND (next_tick_at IS NULL OR next_tick_at <= ?)`).bind(Date.now()).first();
check('the cron does not tick a paused game', due.c === 0);
doCalls.length = 0;
const st = await call(solo, 'POST', `/api/games/${G}/solo/step`, 'uH');
check('step asks the room for one forced tick', st.status === 200 && doCalls.some(u => u.endsWith('/tick-now')), JSON.stringify({ st, doCalls }));
const sp = await call(solo, 'PATCH', `/api/games/${G}/solo/speed`, 'uH', { speed_ms: 600000 });
g2 = await DB.prepare('SELECT paused, next_tick_at, tick_interval_ms FROM games WHERE id = ?').bind(G).first();
check('speed while paused stays paused', sp.status === 200 && g2.tick_interval_ms === 600000 && g2.next_tick_at == null, JSON.stringify(g2));
const badSpeed = await call(solo, 'PATCH', `/api/games/${G}/solo/speed`, 'uH', { speed_ms: 1000 });
check('only his three speeds', badSpeed.status === 400);
const rs = await call(solo, 'POST', `/api/games/${G}/solo/resume`, 'uH');
g2 = await DB.prepare('SELECT paused, next_tick_at FROM games WHERE id = ?').bind(G).first();
check('resume restarts the clock', rs.status === 200 && g2.paused === 0 && g2.next_tick_at > Date.now(), JSON.stringify(g2));
const stepRunning = await call(solo, 'POST', `/api/games/${G}/solo/step`, 'uH');
check('step needs a paused game', stepRunning.status === 409);

// ---- difficulty: peaceful never declares ------------------------------
const calm = await call(solo, 'POST', '/api/solo', 'uX', { rivals: 2, difficulty: 'peaceful' });
const G2 = calm.data?.game_id;
check('defaults: 2 min a tick', calm.status === 200 && calm.data.speed_ms === 120000, JSON.stringify(calm));
const r2 = new Room(makeState(), env);
r2.broadcast = () => {};
for (let i = 1; i <= 60; i++) {
  await r2.resolveTick(G2, i);
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(i, G2).run();
  await ai.runSoloGame(env, G2);
}
const calmWars = await DB.prepare('SELECT COUNT(*) AS c FROM game_wars WHERE game_id = ?').bind(G2).first();
check('peaceful: nobody declares war', calmWars.c === 0);

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
