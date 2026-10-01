// ============================================================
// "Hostile inbound" means AT WAR -- drives the REAL worker over SimD1.
//
// Lorne, 2026-09-29: "I'm getting a lot of threatening warnings about
// ships I'm not at war with." War is declared now and peace is the
// default, but every inbound readout still called anyone you had not
// signed a NAP or defence pact with "hostile". Two empires, one of them
// flying a hull at the other's capital, read four ways:
//
//   * the phone widget and the watch (widgetSnapshot.inbound)
//   * the battle widget (battleSnapshot.threats)
//   * the Discord daily situation report (its Inbound field)
//   * the tick's inbound interrupt (runTickAlerts -> the watch feed)
//
// At peace, none of them may say a word. Declared, every one must. Ended,
// quiet again.
//
// Run: npm run sim:inboundwar
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { widgetSnapshot, mintWidgetToken } from '../worker/widget.js';
import { battleSnapshot } from '../worker/battleWidget.js';
import { buildSituationReport } from '../worker/situationReport.js';
import { runTickAlerts } from '../worker/alerts.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const ROOM = {
  idFromName: (name) => name,
  get: () => ({
    async fetch(url) {
      const path = new URL(typeof url === 'string' ? url : url.url).pathname;
      if (path === '/settings') return Response.json({});
      return Response.json({ ok: true });
    },
  }),
};

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = { DB, ROOM, EMAIL_LINK_SECRET: 'sim-secret' };
const execCtx = { waitUntil() {}, passThroughOnException() {} };

async function call(method, path, { body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(`https://orbital-empire.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, execCtx);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}
async function signup(name) {
  const r = await call('POST', '/api/auth/signup', {
    body: { email: `${name.toLowerCase()}@example.com`, password: 'password123', display_name: name },
  });
  if (r.status !== 201) throw new Error(`signup ${name} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { name, cookie: r.cookie, id: r.data.user.id };
}

// ---- a real two-empire game ------------------------------------------------

const A = await signup('Ada');
const B = await signup('Bex');
const created = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Two empires', max_players: 2 } });
const gid = created.data.room.id;
await call('POST', `/api/rooms/${gid}/join`, { cookie: B.cookie });
const started = await call('POST', `/api/lobby/rooms/${gid}/start`, { cookie: A.cookie });
if (started.status !== 200) throw new Error(`start -> ${started.status} ${JSON.stringify(started.data)}`);
await DB.prepare(`UPDATE games SET status = 'active', current_tick = 50 WHERE id = ?`).bind(gid).run();
const tick = 50;

const fa = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(gid, A.id).first()).id;
const fb = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(gid, B.id).first()).id;
const capital = await DB.prepare(
  'SELECT body_id FROM game_settlements WHERE game_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL LIMIT 1',
).bind(gid, fa).first();
const raider = await DB.prepare(
  "SELECT id FROM game_ships WHERE game_id = ? AND owner_faction_id = ? AND status = 'active' LIMIT 1",
).bind(gid, fb).first();
if (!capital || !raider) throw new Error('seed produced no capital or no ship');

// Bex's hull is under way to Ada's capital, departed this tick.
await DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
                                scheduled_t, fuel_cost, status, committed_at_tick, arrival_at_tick)
   VALUES ('node_raid', ?, ?, 99, 'absolute', ?, 0, 0, 'in_transit', ?, ?)`,
).bind(gid, raider.id, capital.body_id, tick, tick + 12).run();
// Ada wears a watch, so the tick's inbound interrupt lands where we can read it.
await mintWidgetToken(env, A.id, 'watch', 'wear');

async function readouts() {
  const w = await widgetSnapshot(env, A.id);
  const b = await battleSnapshot(env, A.id);
  const rep = await buildSituationReport(env, gid, A.id);
  const repText = JSON.stringify(rep ?? {});
  await runTickAlerts(env, gid, tick);
  const watch = (await DB.prepare(
    "SELECT COUNT(*) AS n FROM wear_alerts WHERE user_id = ? AND category = 'inbound'",
  ).bind(A.id).first()).n;
  return {
    widget: w?.inbound ?? null,
    battle: (b?.threats ?? []).length,
    report: /Inbound/.test(repText),
    watch: Number(watch),
  };
}

// ---- at peace ----------------------------------------------------------------

const peace = await readouts();
check('at peace: the widget and watch count no inbound', peace.widget === 0, peace);
check('at peace: the battle widget lists no threat', peace.battle === 0, peace);
check('at peace: the daily report has no Inbound section', peace.report === false, peace);
check('at peace: no inbound alert fires', peace.watch === 0, peace);

// ---- Bex declares ---------------------------------------------------------------

const dec = await call('POST', `/api/games/${gid}/wars/declare`, { cookie: B.cookie, body: { target_faction_id: fa } });
check('Bex can declare war on Ada', dec.status === 200, dec);
const war = await readouts();
check('at war: the widget and watch count the inbound hull', war.widget === 1, war);
check('at war: the battle widget lists the threat', war.battle === 1, war);
check('at war: the daily report has its Inbound section', war.report === true, war);
check('at war: the inbound alert fires', war.watch === 1, war);

// ---- the war ends ----------------------------------------------------------------

await DB.prepare('UPDATE game_wars SET ended_at_tick = ? WHERE game_id = ?').bind(tick, gid).run();
await DB.prepare("UPDATE game_ship_nodes SET committed_at_tick = ? WHERE id = 'node_raid'").bind(tick - 1).run();
const after = await readouts();
check('war over: the widget is quiet again', after.widget === 0, after);
check('war over: the battle widget is quiet again', after.battle === 0, after);
check('war over: the report drops the section', after.report === false, after);
check('war over: no second alert', after.watch === 1, after);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
