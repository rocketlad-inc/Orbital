// ============================================================
// SETTLEMENT SKINS (0154) — who may pick a style, and what is drawn.
//
// A colony or station skin is chosen in two places (the account default
// in the Hangar, a per-game override in the lobby) and resolved when the
// game state is read. The rules:
//
//   - the free look (towers / hub) and "no choice" are open to everyone
//   - any other style needs the Commission at the moment it is picked
//   - an unknown id is a client bug: refused, never coerced
//   - drawn = this game's override, else the account default
//   - ...and only while the Commission is held: a refund falls back to
//     the free look without anyone touching the saved choice
//   - a new account default invalidates the state cache of the player's
//     running games, so it shows at once
//
// Run: node sim/settlementSkins.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { routes as skinRoutes, DRAWN_SKIN_SQL, normalizeSkin } from '../worker/skins.js';
import { routes as lobbyRoutes } from '../worker/lobby.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
for (const id of ['holder', 'free', 'other']) {
  await DB.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,0)')
    .bind(id, `${id}@t`, id, 'x').run();
}
await DB.prepare(`INSERT INTO user_entitlements (user_id, sku, source, granted_at) VALUES ('holder','cosmetics_v1','stripe',0)`).run();

async function call(list, method, path, userId, body) {
  const url = new URL(`https://orbital.test${path}`);
  const route = list.find(r => r.method === method
    && (typeof r.pattern === 'string' ? r.pattern === url.pathname : r.pattern.test(url.pathname)));
  const params = typeof route.pattern === 'string' ? {} : (url.pathname.match(route.pattern).groups ?? {});
  const req = new Request(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await route.handle(req, env, { url, session: { user_id: userId, email: `${userId}@t` }, params });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const acct = (u, body) => call(skinRoutes, 'PATCH', '/api/users/me/skins', u, body);
const userRow = async (u) => DB.prepare('SELECT city_skin, station_skin FROM users WHERE id = ?').bind(u).first();

// ---- picking ----------------------------------------------------------
check('ids are read strictly', normalizeSkin('city', 'hive') === 'hive' && normalizeSkin('city', 'wheel') === undefined
  && normalizeSkin('station', 'default') === null && normalizeSkin('station', null) === null);
check('anyone may pick the free looks', (await acct('free', { city_skin: 'towers', station_skin: 'hub' })).status === 200);
check('anyone may clear a choice', (await acct('free', { city_skin: null })).status === 200 && (await userRow('free')).city_skin === null);
const refused = await acct('free', { city_skin: 'hive' });
check('a premium style is refused without the Commission', refused.status === 403 && refused.body.error.code === 'premium_required');
check('...and nothing was saved', (await userRow('free')).city_skin === null);
check('an unknown style is refused, not coerced', (await acct('holder', { station_skin: 'death-star' })).status === 400);
check('a station id is not a city id', (await acct('holder', { city_skin: 'wheel' })).status === 400);
const both = await acct('holder', { city_skin: 'spires', station_skin: 'wheel' });
check('a holder may pick premium styles, both at once', both.status === 200 && both.body.city_skin === 'spires' && both.body.station_skin === 'wheel');
check('a body with nothing to update is refused', (await acct('holder', {})).status === 400);

// ---- the per-game override (lobby, before the game starts) --------------
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES ('roomaaaaaaa1','R','holder',0,0)`).run();
for (const u of ['holder', 'free']) {
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES ('roomaaaaaaa1',?,0)`).bind(u).run();
}
const lobby = (u, body) => call(lobbyRoutes, 'PATCH', '/api/lobby/rooms/roomaaaaaaa1/me', u, body);
check('the lobby refuses a premium style without the Commission', (await lobby('free', { station_skin: 'citadel' })).status === 403);
check('the lobby takes a holder\'s override', (await lobby('holder', { city_skin: 'domes' })).status === 200);
check('...stored on this game only',
  (await DB.prepare(`SELECT city_skin FROM room_members WHERE user_id='holder'`).first()).city_skin === 'domes'
  && (await userRow('holder')).city_skin === 'spires');

// ---- what is drawn ------------------------------------------------------
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,state_version) VALUES ('roomaaaaaaa1','active','s',5,60000,0,1)`).run();
for (const [slot, u] of [[0, 'holder'], [1, 'free'], [2, 'other'], [3, null]]) {
  await DB.prepare(`INSERT INTO game_factions (id,game_id,user_id,name,color,slot,status,joined_at) VALUES (?,?,?,?,?,?,'active',0)`)
    .bind(`roomaaaaaaa1:f${slot}`, 'roomaaaaaaa1', u, `E${slot}`, '#4ecdc4', slot).run();
}
await DB.prepare(`UPDATE users SET station_skin = 'lattice' WHERE id = 'other'`).run(); // saved before a refund, say
const drawn = async () => Object.fromEntries((await DB.prepare(
  `SELECT gf.user_id AS u, ${DRAWN_SKIN_SQL('city_skin')} AS c, ${DRAWN_SKIN_SQL('station_skin')} AS s
     FROM game_factions gf
     LEFT JOIN room_members rm ON rm.room_id = gf.game_id AND rm.user_id = gf.user_id
     LEFT JOIN users u ON u.id = gf.user_id
    WHERE gf.game_id = 'roomaaaaaaa1'`).all()).results.map(r => [r.u ?? 'ai', [r.c, r.s]]));
let d = await drawn();
check('drawn: this game\'s override beats the account default', d.holder[0] === 'domes', JSON.stringify(d));
check('drawn: with no override, the account default', d.holder[1] === 'wheel');
check('drawn: a saved premium choice without the Commission draws the free look', d.other[1] === null, JSON.stringify(d.other));
check('drawn: an AI empire draws the free look', d.ai[0] === null && d.ai[1] === null);
await DB.prepare(`DELETE FROM user_entitlements WHERE user_id = 'holder'`).run();
d = await drawn();
check('drawn: a refunded Commission falls back to the free look at once', d.holder[0] === null && d.holder[1] === null, JSON.stringify(d.holder));
check('...without erasing the saved choice (re-buying restores it)',
  (await userRow('holder')).station_skin === 'wheel');
await DB.prepare(`INSERT INTO user_entitlements (user_id, sku, source, granted_at) VALUES ('holder','cosmetics_v1','stripe',0)`).run();

// ---- a new default shows in running games at once -----------------------
const v0 = (await DB.prepare(`SELECT state_version FROM games WHERE id = 'roomaaaaaaa1'`).first()).state_version;
await acct('holder', { station_skin: 'citadel' });
const v1 = (await DB.prepare(`SELECT state_version FROM games WHERE id = 'roomaaaaaaa1'`).first()).state_version;
check('a new account default invalidates the player\'s running games', v1 === v0 + 1, `${v0} -> ${v1}`);
check('...and draws there', (await drawn()).holder[1] === 'citadel');

console.log(bad === 0 ? '\nALL SETTLEMENT SKIN CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
