// ============================================================
// What a player may see -- drives the REAL /state and /factions.
//
// Sensor audit, 2026-10-08 (Lorne: "Why do I have sensors on planets I
// dont own?"). Each check here failed before its fix:
//   1. a hull in flight kept the world it LEFT lit (and every rival hull
//      parked there revealed) until it arrived;
//   2. a rival's orders (home/retreat world, arrival action, mining
//      target, fuel...) rode along on every visible rival ship;
//   3. an ELIMINATED intel-share partner kept sharing its hulls' sight;
//   4. an abandoned (unowned) Null Field kept blinding everybody;
//   5. /factions sent every rival capital, past Capital Ping.
//
// Run: npm run sim:sensors
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const ROOM = {
  idFromName: (n) => n,
  get: () => ({ async fetch(url) { const p = new URL(typeof url === 'string' ? url : url.url).pathname; return p === '/settings' ? Response.json({}) : Response.json({ ok: true }); } }),
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
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}
async function signup(name) {
  const r = await call('POST', '/api/auth/signup', { body: { email: `${name.toLowerCase()}@example.com`, password: 'password123', display_name: name } });
  if (r.status !== 201) throw new Error(`signup ${name} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { name, cookie: r.cookie, id: r.data.user.id };
}
async function cloneRow(table, srcId, over) {
  const cols = (await DB.prepare(`PRAGMA table_info(${table})`).all()).results.map(x => x.name);
  const vals = [];
  const sel = cols.map(c => {
    if (!(c in over)) return c;
    vals.push(over[c]);
    return `?${vals.length + 1}`;
  }).join(', ');
  await DB.prepare(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel} FROM ${table} WHERE id = ?1`)
    .bind(srcId, ...vals).run();
}

const A = await signup('Viewer');
const B = await signup('Rival');
const C = await signup('Partner');
const c = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Sensors', max_players: 3 } });
const G = c.data.room.id;
await call('POST', `/api/rooms/${G}/join`, { cookie: B.cookie });
await call('POST', `/api/rooms/${G}/join`, { cookie: C.cookie });
const s = await call('POST', `/api/lobby/rooms/${G}/start`, { cookie: A.cookie });
if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
const TICK = 60;
// Gated, so Sensors research matters; the viewer has none.
await DB.prepare(`UPDATE games SET status = 'active', gating_enabled = 1, current_tick = ? WHERE id = ?`).bind(TICK, G).run();
const fac = async (u) => DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, u.id).first();
const fa = await fac(A), fb = await fac(B), fc = await fac(C);
await DB.prepare(`DELETE FROM faction_techs WHERE faction_id = ?`).bind(fa.id).run();
const home = fa.capital_body_id;

// Body positions as the server places them (circular orbits).
const bodies = (await DB.prepare(`SELECT id, name, type, parent_body_id, orbit_radius, orbit_period, angle0, orbit_rp, owner_faction_id, mineral_kind, emerge_from_tick FROM game_bodies WHERE game_id = ?`).bind(G).all()).results;
const byId = new Map(bodies.map(b => [b.id, b]));
const { orbitAngle } = await import('../worker/orbitPos.js');
const pos = (id) => {
  const b = byId.get(id);
  if (!b || !b.parent_body_id) return { x: 0, y: 0 };
  const p = pos(b.parent_body_id);
  const a = orbitAngle(b.angle0, b.orbit_period, TICK);
  return { x: p.x + Math.cos(a) * b.orbit_radius, y: p.y + Math.sin(a) * b.orbit_radius };
};
const dist = (a, b) => { const p = pos(a), q = pos(b); return Math.hypot(p.x - q.x, p.y - q.y); };
const sysOf = (id) => { let cur = byId.get(id); while (cur?.parent_body_id && byId.get(cur.parent_body_id)?.type !== 'star') cur = byId.get(cur.parent_body_id); return cur?.id; };
// Far worlds round the Sun, nobody's, away from every capital.
const caps = [fa, fb, fc].map(f => f.capital_body_id);
const capSys = new Set(caps.map(sysOf));
const far = bodies
  .filter(b => b.parent_body_id && byId.get(b.parent_body_id)?.type === 'star' && b.orbit_rp == null
    && !b.owner_faction_id && !capSys.has(b.id) && b.type !== 'megastructure'
    // A real world everyone is sent, not a survey rock or an emerging one.
    && b.mineral_kind == null && b.emerge_from_tick == null)
  .sort((x, y) => dist(y.id, home) - dist(x.id, home));
const R = far[0].id, Y = far[1].id;
console.log(`viewer home ${byId.get(home).name}; left world ${byId.get(R).name} (${Math.round(dist(R, home))} away); partner's world ${byId.get(Y).name}`);

// Only the hulls each check places: clear the starting fleets.
await DB.prepare(`UPDATE game_captains SET ship_id = NULL WHERE game_id = ?`).bind(G).run();
const seedShip = (await DB.prepare(`SELECT id FROM game_ships WHERE game_id = ? LIMIT 1`).bind(G).first()).id;
await cloneRow('game_ships', seedShip, { id: `${G}:tpl`, status: 'destroyed', captain_id: null, fleet_id: null });
await DB.prepare(`DELETE FROM game_ships WHERE game_id = ? AND id != ?`).bind(G, `${G}:tpl`).run();
const put = (id, owner, at, extra = {}) => cloneRow('game_ships', `${G}:tpl`, {
  id: `${G}:${id}`, name: id, owner_faction_id: owner, parent_body_id: at, status: 'active',
  ship_class: 'destroyer', hp: 100, hp_max: 100, captain_id: null, fleet_id: null, ...extra,
});
const fly = (id, to, from = TICK - 49) => DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id, scheduled_t, fuel_cost, status, arrival_at_tick)
   VALUES (?, ?, ?, 0, 'absolute', ?, ?, 0, 'in_transit', ?)`,
).bind(`n_${id}`, G, `${G}:${id}`, to, from, TICK + 1).run();
const state = async (u) => (await call('GET', `/api/games/${G}/state`, { cookie: u.cookie })).data;
const visible = (st, id) => (st.visible_body_ids ?? []).includes(id);

// ---- 1. a hull in flight does not keep the world it left lit --------
await put('runner', fa.id, R);
await fly('runner', home);              // 98% of the way home
let st = await state(A);
check(`the world a hull LEFT (${byId.get(R).name}) is not lit while it flies home`, !visible(st, R));

// ---- 2. a rival's orders do not ride along -------------------------
await put('mine', fa.id, home, { home_body_id: home, retreat_body_id: home, arrival_action: 'arrive_hold' });
await put('raider', fb.id, home, {
  home_body_id: fb.capital_body_id, retreat_body_id: fb.capital_body_id, arrival_action: 'detonate',
  detonate_at_tick: TICK + 5, mining_body_id: R, cargo_metal: 50, target_priority: 'capital',
  strike_target_body_id: home, strike_ready_tick: TICK + 3,
});
// ...flying as the flagship of a named fleet with a captain.
const capSeed = await DB.prepare(`SELECT id FROM game_captains WHERE game_id = ? LIMIT 1`).bind(G).first();
await cloneRow('game_captains', capSeed.id, { id: `${G}:ace`, faction_id: fb.id, ship_id: `${G}:raider`, name: 'Ace Rimmer', traits_json: '["pathfinder"]', status: 'active' });
await DB.prepare(`INSERT INTO game_fleets (id, game_id, faction_id, name, flag_captain_id, created_at_tick) VALUES (?, ?, ?, 'Raiders', ?, 1)`)
  .bind(`${G}:fl1`, G, fb.id, `${G}:ace`).run();
await DB.prepare(`UPDATE game_ships SET fleet_id = ?, captain_id = ? WHERE id = ?`).bind(`${G}:fl1`, `${G}:ace`, `${G}:raider`).run();
st = await state(A);
const raider = (st.ships ?? []).find(x => x.id === `${G}:raider`);
const rfleet = (st.fleets ?? []).find(x => x.id === `${G}:fl1`);
check('the rival fleet is visible', !!rfleet);
check('its flag captain name and traits are withheld without Deep Scan',
  rfleet && rfleet.flag_captain_name == null && rfleet.flag_captain_traits == null, rfleet);
const mine = (st.ships ?? []).find(x => x.id === `${G}:mine`);
check('a rival ship at your world is visible', !!raider);
check('its orders are withheld (home, retreat, arrival, detonation, mining, cargo, priority)',
  raider && raider.home_body_id == null && raider.retreat_body_id == null && raider.arrival_action == null
  && raider.detonate_at_tick == null && raider.mining_body_id == null && raider.cargo_metal == null
  && raider.target_priority == null, raider);
check('its strike on you stays public (the countdown you need)',
  raider && raider.strike_target_body_id === home && raider.strike_ready_tick === TICK + 3, raider);
check('your own ship keeps its orders', mine && mine.home_body_id === home && mine.arrival_action === 'arrive_hold', mine);
await DB.prepare(`DELETE FROM game_ships WHERE id IN (?, ?)`).bind(`${G}:raider`, `${G}:mine`).run();

// ---- 3. an eliminated partner shares nothing -----------------------
await DB.prepare(`INSERT INTO treaties (id, game_id, kind, status, proposed_at_tick, signed_at_tick) VALUES ('t1', ?, 'intel_share', 'active', 1, 1)`).bind(G).run();
for (const f of [fa, fc]) {
  await DB.prepare(`INSERT INTO treaty_signatories (treaty_id, faction_id, signed_at_tick) VALUES ('t1', ?, 1)`).bind(f.id).run();
}
await put('scout', fc.id, Y);
st = await state(A);
check(`a partner's hull lights its world for you (${byId.get(Y).name})`, visible(st, Y));
await DB.prepare(`UPDATE game_factions SET status = 'eliminated' WHERE id = ?`).bind(fc.id).run();
st = await state(A);
check('an ELIMINATED partner shares nothing', !visible(st, Y));

// ---- 5. /factions keeps Capital Ping (partner alive again) ----------
await DB.prepare(`UPDATE game_factions SET status = 'active' WHERE id = ?`).bind(fc.id).run();
const fl = (await call('GET', `/api/games/${G}/factions`, { cookie: A.cookie })).data;
const rows = fl.factions ?? fl;
const row = (id) => rows.find(r => r.id === id);
check('/factions hides a rival capital without Sensors 1', row(fb.id) && row(fb.id).capital_body_id == null, row(fb.id));
check('/factions keeps your own capital and your partner\'s',
  row(fa.id)?.capital_body_id === home && row(fc.id)?.capital_body_id === fc.capital_body_id, [row(fa.id)?.capital_body_id, row(fc.id)?.capital_body_id]);
await DB.prepare(`DELETE FROM treaty_signatories WHERE treaty_id = 't1'`).run();

// ---- 4. an abandoned Null Field jams nobody ------------------------
// A rival hull in flight, nearly at your home: seen by your home's
// settlement sensors, through the fog, not by presence.
// From a third world, so no other check's leak can reveal it.
await put('sneak', fb.id, far[2].id);
await fly('sneak', home);
const field = `${G}:mega_nf`;
await DB.prepare(
  `INSERT INTO game_bodies (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu, orbit_radius, orbit_period, angle0, color, owner_faction_id)
   VALUES (?, ?, 'mega_null_field', 'Field', 'megastructure', ?, 1.4, 0, 1, 8, 50, 0, '#4a5f7a', ?)`,
).bind(field, G, home, fb.id).run();
await DB.prepare(
  `INSERT INTO game_megastructures (body_id, game_id, kind, status, acc_metal, acc_credits, cost_metal, cost_credits, founded_by_faction_id, founded_at_tick, completed_at_tick, hp)
   VALUES (?, ?, 'null_field', 'complete', 0, 0, 0, 0, ?, 1, 1, 3000)`,
).bind(field, G, fb.id).run();
const seesSneak = async () => (await state(A)).ships?.some(x => x.id === `${G}:sneak`);
check('a rival\'s working Null Field hides its hull from your home sensors', !(await seesSneak()));
await DB.prepare(`UPDATE game_bodies SET owner_faction_id = NULL WHERE id = ?`).bind(field).run();
await DB.prepare(`UPDATE game_megastructures SET abandoned_at_tick = ? WHERE body_id = ?`).bind(TICK - 1, field).run();
check('an ABANDONED (unowned) Null Field jams nobody', await seesSneak());

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
