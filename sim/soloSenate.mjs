// ============================================================
// SOLO SENATE (playtest round 2, R2-B2): in a solo game the person
// votes on every bill before it resolves, and the tally counts ballots.
//
//   1. a computer chairman's bill closes its window with the person not
//      yet voted: it stays open, past its close
//   2. the person may still vote on it, late
//   3. the next tick resolves it; the chronicle carries one ballot per
//      senator (yea_count / nay_count / abstain_count), not only weights
//   4. the Senate list shows it under resolved bills
//   5. a game of computer empires alone (no person) resolves on time
//
// Run: node sim/soloSenate.mjs
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
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uH','h@t','Hana','x',0), ('uC','c@t','Crucible','x',0)`).run();

const solo = await import('../worker/solo.js');
const senate = await import('../worker/senate.js');
const ai = await import('../worker/aiEmpire.js');
const { Room } = await import('../worker/room.js');

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

/** A solo game; its first computer empire holds the gavel and files a bill. */
async function setup(userId) {
  const made = await call(solo, 'POST', '/api/solo', userId, { rivals: 2, difficulty: 'peaceful', speed_ms: 30000, personalities: ['ally', 'ally'] });
  const G = made.data.game_id;
  const room = new Room(makeState(), env);
  room.broadcast = () => {};
  let t = 0;
  const tickTo = async (n, { bots = true } = {}) => {
    while (t < n) {
      t += 1;
      await room.resolveTick(G, t);
      await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
      if (bots) await ai.runSoloGame(env, G);
    }
  };
  await tickTo(2);
  const bots = (await DB.prepare('SELECT id, user_id FROM game_factions WHERE game_id = ? AND ai_doctrine IS NOT NULL ORDER BY slot').bind(G).all()).results;
  const term = await DB.prepare('SELECT * FROM senate_terms WHERE game_id = ? ORDER BY term_index DESC LIMIT 1').bind(G).first();
  await DB.prepare('UPDATE senate_terms SET faction_id = ? WHERE game_id = ? AND term_index = ?').bind(bots[0].id, G, term.term_index).run();
  await DB.prepare('DELETE FROM senate_proposals WHERE game_id = ?').bind(G).run();
  const prop = await call(senate, 'POST', `/api/games/${G}/senate/proposals`, bots[0].user_id, {
    kind: 'slider_law', title: 'More Metal', summary: 'Mines yield more.',
    slider_id: 'metal_yield_multiplier', target_value: 1.25,
  });
  return { G, room, tickTo, bots, prop, tick: () => t };
}

// ---- solo: the bill waits for the person -------------------------------
const S = await setup('uH');
check('a computer chairman files a bill', S.prop.status === 201, JSON.stringify(S.prop.data));
const bill = S.prop.data.proposal;
await S.tickTo(bill.vote_closes_at_tick + 3);
let row = await DB.prepare('SELECT status FROM senate_proposals WHERE id = ?').bind(bill.id).first();
const aiVotes = await DB.prepare('SELECT COUNT(*) AS n FROM senate_votes WHERE proposal_id = ?').bind(bill.id).first();
check('1. past its close, with the person unvoted, the bill is still open', row.status === 'voting',
  JSON.stringify({ row, aiVotes, closes: bill.vote_closes_at_tick, tick: S.tick() }));
check('   (both computer empires have voted)', aiVotes.n === 2, JSON.stringify(aiVotes));
const late = await call(senate, 'POST', `/api/games/${S.G}/senate/proposals/${bill.id}/vote`, 'uH', { vote: 'nay' });
check('2. the person can still vote on it', late.status === 200, JSON.stringify(late));
await S.tickTo(S.tick() + 1);
row = await DB.prepare('SELECT status, resolved_at_tick FROM senate_proposals WHERE id = ?').bind(bill.id).first();
check('3. the next tick resolves it', row.status === 'passed' || row.status === 'failed', JSON.stringify(row));
const chr = await DB.prepare(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'senate_vote' ORDER BY tick_number DESC LIMIT 1`).bind(S.G).first();
const p = JSON.parse(chr?.payload ?? '{}');
check('   the chronicle counts one ballot per senator (3 in a 3-empire game)',
  (p.yea_count ?? 0) + (p.nay_count ?? 0) + (p.abstain_count ?? 0) === 3 && p.nay_count === 1,
  JSON.stringify(p));
const list = await call(senate, 'GET', `/api/games/${S.G}/senate/proposals`, 'uH');
const resolved = (list.data?.proposals ?? []).filter(x => ['passed', 'failed', 'withdrawn'].includes(x.status));
check('4. the Senate list shows it as a resolved bill', resolved.some(x => x.id === bill.id),
  JSON.stringify((list.data?.proposals ?? []).map(x => [x.title, x.status])));

// ---- no person: on time ------------------------------------------------
const C = await setup('uC');
await DB.prepare(`UPDATE game_factions SET ai_doctrine = 'expander', ai_personality = 'ally' WHERE game_id = ? AND user_id = 'uC'`).bind(C.G).run();
const cbill = C.prop.data.proposal;
await C.tickTo(cbill.vote_closes_at_tick + 1);
const crow = await DB.prepare('SELECT status FROM senate_proposals WHERE id = ?').bind(cbill.id).first();
check('5. with no person in the game, a bill resolves at its close', crow.status !== 'voting', JSON.stringify(crow));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
