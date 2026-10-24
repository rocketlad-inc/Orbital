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
//   6. personalities: the Ally courts you and joins your wars, the
//      Warlord refuses and attacks, the Snake courts you then betrays
//   7. the crucible: six computer empires alone fight each other, logged
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
const room = await DB.prepare('SELECT password_hash, quick_join, invite_code FROM rooms WHERE id = ?').bind(G).first();
check('nobody can join the room: no password, no Quick Join, no invite code',
  room.password_hash === 'solo:no-entry' && room.quick_join === 0 && room.invite_code == null, JSON.stringify(room));
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
    // Only a standing empire votes (an eliminated one never does).
    const standing = await DB.prepare(`SELECT COUNT(*) AS c FROM game_factions WHERE game_id = ? AND ai_doctrine IS NOT NULL AND status = 'active'`).bind(G).first();
    check('4. every computer empire votes on an open bill', votes.c === standing.c && standing.c > 0,
      `${votes.c} votes from ${standing.c} standing; ${JSON.stringify(Object.fromEntries(Object.entries(tally).filter(([k]) => /vote/.test(k))))}`);
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
// Cloudflare calls alarm() with an alarmInfo OBJECT, not a boolean: a
// natural alarm must not read as a forced tick (staging, 2026-10-23).
await r.state.storage.put('gameStarted', { gameId: G });
const tBefore = (await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(G).first()).current_tick;
await r.alarm({ retryCount: 0, isRetry: false });
const tAfter = (await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(G).first()).current_tick;
check('a natural alarm does not tick a paused game', tAfter === tBefore, `${tBefore} -> ${tAfter}`);
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

// ---- 6. personalities (aiPersona.js, 2026-10-24) -------------------------
const tradesMod = await import('../worker/trades.js');
const factionsMod = await import('../worker/factions.js');
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uY','y@t','Yara','x',0), ('uZ','z@t','Zeno','x',0)`).run();

/** Play a game from its current tick to `to`, every bot every tick. */
async function play(gameId, room, to, sink) {
  let t = Number((await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first()).current_tick ?? 0);
  while (t < to) {
    t += 1;
    await room.resolveTick(gameId, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, gameId).run();
    await ai.runSoloGame(env, gameId, sink);
  }
}
const roster = async (gameId, userId) => (await call(factionsMod, 'GET', `/api/games/${gameId}/factions`, userId)).data?.factions ?? [];
const facOf = async (gameId, personality) => DB.prepare(
  'SELECT id, user_id FROM game_factions WHERE game_id = ? AND ai_personality = ?').bind(gameId, personality).first();
const humanOf = async (gameId) => DB.prepare(
  'SELECT id FROM game_factions WHERE game_id = ? AND ai_doctrine IS NULL').bind(gameId).first();
/** The person accepts every open offer addressed to them. */
async function acceptAll(gameId, userId, humanId) {
  const open = (await DB.prepare(`SELECT id, proposer_faction_id, offer_pacts FROM trade_offers
                                  WHERE game_id = ? AND responder_faction_id = ? AND status = 'open'`).bind(gameId, humanId).all()).results;
  for (const o of open) await call(tradesMod, 'POST', `/api/games/${gameId}/trades/${o.id}/accept`, userId, {});
  return open;
}
const napWith = async (gameId, a, b) => (await DB.prepare(
  `SELECT t.status FROM treaties t
     JOIN treaty_signatories x ON x.treaty_id = t.id AND x.faction_id = ?
     JOIN treaty_signatories y ON y.treaty_id = t.id AND y.faction_id = ?
    WHERE t.game_id = ? AND t.kind = 'nap' ORDER BY t.rowid DESC LIMIT 1`).bind(a, b, gameId).first())?.status ?? null;
const warRow = async (gameId, a, b) => DB.prepare(
  `SELECT declared_by, declared_at_tick, origin FROM game_wars
    WHERE game_id = ? AND ((faction_a = ? AND faction_b = ?) OR (faction_a = ? AND faction_b = ?))
    ORDER BY declared_at_tick DESC LIMIT 1`).bind(gameId, a, b, b, a).first();

// Surprise me: hidden on the roster while the game runs.
const hidden = (await roster(G, 'uH')).filter(f => f.computer);
check('Surprise personalities stay hidden on the roster', hidden.length > 0 && hidden.every(f => f.personality == null),
  JSON.stringify(hidden.map(f => [f.name, f.personality])));

// --- an Ally and a Warlord ---------------------------------------------------
const aw = await call(solo, 'POST', '/api/solo', 'uY', { rivals: 2, difficulty: 'normal', speed_ms: 30000, personalities: ['ally', 'warlord'] });
const GA = aw.data?.game_id;
check('setup takes a personality per rival', aw.status === 200 && !!GA, JSON.stringify(aw));
const picked = await roster(GA, 'uY');
check('picked personalities show on the roster', picked.filter(f => f.computer).map(f => f.personality).sort().join() === 'ally,warlord',
  JSON.stringify(picked.map(f => [f.name, f.personality])));
const allyF = await facOf(GA, 'ally');
const warF = await facOf(GA, 'warlord');
const humA = await humanOf(GA);
const rA = new Room(makeState(), env);
rA.broadcast = () => {};
const tA = {};
await play(GA, rA, 20, tA);
const napOffers = await acceptAll(GA, 'uY', humA.id);
check('the Ally offers you a non-aggression pact', napOffers.some(o => o.proposer_faction_id === allyF.id && /nap/.test(o.offer_pacts)),
  JSON.stringify(napOffers));
check('the Warlord offers nothing', !napOffers.some(o => o.proposer_faction_id === warF.id));
check('accepting signs the pact with the Ally', (await napWith(GA, allyF.id, humA.id)) === 'active');
await play(GA, rA, 90, tA);
const wl = await warRow(GA, warF.id, humA.id);
check('the Warlord declares on you once it has a fleet', wl?.declared_by === warF.id && wl.declared_at_tick >= 36,
  JSON.stringify({ wl, tally: Object.fromEntries(Object.entries(tA).filter(([k]) => /rusher:(declare|attack|scout|hold|build)/.test(k))) }));
const aj = await warRow(GA, allyF.id, warF.id);
check('the Ally joins your war against the Warlord', aj?.declared_by === allyF.id,
  JSON.stringify({ aj, tally: Object.fromEntries(Object.entries(tA).filter(([k]) => /^(expander|economist):(declare|offer)/.test(k))) }));
check('the Ally never declares on you', !(await warRow(GA, allyF.id, humA.id)));
console.log('        ally/warlord tally:', JSON.stringify(Object.fromEntries(Object.entries(tA).filter(([k]) => !/research|bld_|build_|vote_|personality/.test(k)))));

// --- a Snake ----------------------------------------------------------------
const sn = await call(solo, 'POST', '/api/solo', 'uZ', { rivals: 1, difficulty: 'normal', speed_ms: 30000, personalities: ['snake'] });
const GS = sn.data?.game_id;
const snakeF = await facOf(GS, 'snake');
const humS = await humanOf(GS);
const rS = new Room(makeState(), env);
rS.broadcast = () => {};
const tS = {};
await play(GS, rS, 20, tS);
const snOffers = await acceptAll(GS, 'uZ', humS.id);
check('the Snake courts you with a non-aggression pact', snOffers.some(o => o.proposer_faction_id === snakeF.id), JSON.stringify(snOffers));
check('the pact is signed', (await napWith(GS, snakeF.id, humS.id)) === 'active');
let betrayal = null;
for (let to = 40; to <= 200 && !betrayal; to += 20) {
  await play(GS, rS, to, tS);
  await acceptAll(GS, 'uZ', humS.id);
  betrayal = await warRow(GS, snakeF.id, humS.id);
}
check('the Snake betrays you: declares while the pact stands', betrayal?.declared_by === snakeF.id && betrayal.origin === 'pact_broken',
  JSON.stringify({ betrayal, tally: Object.fromEntries(Object.entries(tS).filter(([k]) => /betray|snake|visit|offer|declare/.test(k))) }));
check('not before its window opens (tick 60 on Normal)', !betrayal || betrayal.declared_at_tick >= 60, JSON.stringify(betrayal));
check('the betrayal breaks the pact for everyone to see', (await napWith(GS, snakeF.id, humS.id)) === 'broken');
const strikeOrders = Object.entries(tS).filter(([k]) => /schemer:(attack|attack_blind)_ok/.test(k)).reduce((a, [, v]) => a + v, 0);
check('and its fleet sails the same turn or soon after', strikeOrders > 0, JSON.stringify(tS));
console.log(`        snake betrayed at tick ${betrayal?.declared_at_tick ?? '-'}; tally:`,
  JSON.stringify(Object.fromEntries(Object.entries(tS).filter(([k]) => !/research|bld_|build_|vote_|personality/.test(k)))));

// ---- 7. the crucible: computer empires alone, the turn log on ----------------
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uC','c@t','Crucible','x',0)`).run();
const cr = await call(solo, 'POST', '/api/solo', 'uC', { rivals: 5, difficulty: 'normal', speed_ms: 30000, personalities: ['ally', 'warlord', 'snake', 'warlord', 'ally'] });
const GC = cr.data?.game_id;
// The host's own seat plays too: a sixth computer empire, a Snake.
await DB.prepare(`UPDATE game_factions SET ai_doctrine = 'schemer', ai_personality = 'snake', ai_personality_shown = 1
                   WHERE game_id = ? AND user_id = 'uC'`).bind(GC).run();
await DB.prepare('UPDATE games SET ai_log = 1 WHERE id = ?').bind(GC).run();
const rC = new Room(makeState(), env);
rC.broadcast = () => {};
const tC = {};
await play(GC, rC, 150, tC);
const logRows = await DB.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errs FROM ai_turn_log WHERE game_id = ?').bind(GC).first();
check('crucible: every empire plays every tick, logged', logRows.n >= 6 * 140, `${logRows.n} rows`);
const errs = (await DB.prepare('SELECT faction_id, tick, error FROM ai_turn_log WHERE game_id = ? AND error IS NOT NULL LIMIT 3').bind(GC).all()).results;
check('crucible: no turn throws', Number(logRows.errs) === 0, JSON.stringify(errs));
const cWars = (await DB.prepare(`SELECT w.declared_by, w.declared_at_tick, w.origin, a.ai_personality AS by_p, b.ai_personality AS a_p, c.ai_personality AS b_p
                                   FROM game_wars w JOIN game_factions a ON a.id = w.declared_by
                                   JOIN game_factions b ON b.id = w.faction_a JOIN game_factions c ON c.id = w.faction_b
                                  WHERE w.game_id = ? ORDER BY w.declared_at_tick`).bind(GC).all()).results;
check('crucible: with no person, they go to war with each other', cWars.length > 0, JSON.stringify(tC));
console.log('        crucible wars:', JSON.stringify(cWars.map(w => `${w.declared_at_tick}:${w.by_p}->${w.a_p === w.by_p ? w.b_p : w.a_p}${w.origin === 'pact_broken' ? '(betrayal)' : ''}`)));
const pactsC = await DB.prepare(`SELECT kind, status, COUNT(*) AS n FROM treaties WHERE game_id = ? GROUP BY kind, status`).bind(GC).all();
console.log('        crucible pacts:', JSON.stringify(pactsC.results));
const standing = (await DB.prepare(`SELECT f.ai_personality AS p, f.status,
    (SELECT COUNT(*) FROM game_bodies b WHERE b.owner_faction_id = f.id AND b.destroyed_at_tick IS NULL) AS worlds,
    (SELECT COUNT(*) FROM game_ships s WHERE s.owner_faction_id = f.id AND s.hp > 0) AS ships
  FROM game_factions f WHERE f.game_id = ? ORDER BY f.slot`).bind(GC).all()).results;
console.log('        crucible standings:', JSON.stringify(standing));
const ms = await DB.prepare('SELECT AVG(ms) AS avg, MAX(ms) AS max FROM ai_turn_log WHERE game_id = ?').bind(GC).first();
console.log(`        crucible turn time: avg ${Math.round(ms.avg)} ms, max ${ms.max} ms (in-memory DB)`);

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
