// ============================================================
// THE MAP MAKER, end to end (Lorne, 2026-10-14): a player builds a star
// system, saves and shares it, and a game is seeded from it -- on the
// real server code over an in-memory D1.
//
// Run: node sim/mapMaker.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import {
  normalizeMap, checkMap, hostBlockers, generateMap, blankMap, startWorlds, mapToCatalog,
} from '../src/game/customMap.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// ---- 1. The format ---------------------------------------------------------
const messy = normalizeMap({
  name: '   A   very   long system name that keeps going and going   ',
  sun: { name: '', color: 'red', size: 999, mass: -3 },
  bodies: [
    { id: 'aa', type: 'terrestrial', orbit: 5, radius: 99, yields: { metal: 999, credits: -4, science: 2.6 }, start: true, secret: 'ancient_city' },
    { id: 'bb', type: 'moon', parent: 'aa', orbit: 9999, secret: 'nonsense' },
    { id: 'cc', type: 'moon', parent: 'gone', orbit: 30 },
    { id: 'dd', type: 'gas-giant', parent: 'aa', orbit: 900, start: true, rings: true },
    { id: 'aa', type: 'dwarf' },
    { id: 'BAD ID', type: 'terrestrial' },
    { id: 'ee', type: 'rock', orbit: 800, mineral: { kind: 'gold', tons: 99999 }, start: true, secret: 'deep_cache' },
  ],
});
check('every number is clamped and every string cleaned',
  messy.sun.size === 90 && messy.sun.mass === 0.4 && messy.sun.name === 'Helion' && messy.sun.color === '#ffd180'
    && messy.bodies[0].orbit === 60 && messy.bodies[0].radius === 5 && messy.bodies[0].yields.metal === 30
    && messy.bodies[0].yields.credits === 0 && messy.bodies[0].yields.science === 3 && messy.name.length <= 40,
  JSON.stringify(messy.bodies[0]));
check('duplicate and malformed ids are dropped', messy.bodies.length === 5 && !messy.bodies.some(b => b.id === 'BAD ID'),
  messy.bodies.map(b => b.id).join(','));
check('a moon of a missing world is set loose round the sun; a giant never orbits a planet',
  messy.bodies.find(b => b.id === 'cc').parent === 'sun' && messy.bodies.find(b => b.id === 'dd').parent === 'sun');
check('a moon orbit is held to moon range', messy.bodies.find(b => b.id === 'bb').orbit === 400);
check('discoveries that do not fit are refused; a giant cannot be a start world',
  messy.bodies.find(b => b.id === 'bb').secret === null && messy.bodies.find(b => b.id === 'dd').start === false);
check('a rock carries ore, no yields, no start, no discovery',
  (() => { const r = messy.bodies.find(b => b.id === 'ee'); return r.mineral.kind === 'gold' && r.mineral.tons === 5000 && !r.start && !r.secret && r.yields.metal === 0; })());

// ---- 2. The checklist ------------------------------------------------------
check('a blank sun cannot be hosted (no start worlds)',
  hostBlockers(blankMap()).some(i => i.code === 'too_few_starts'));
const gen = generateMap({ seed: 7, planets: 8, starts: 6 });
check('a generated system can be hosted as rolled', hostBlockers(gen).length === 0,
  hostBlockers(gen).map(i => i.title).join('; '));
check('...and seats one player per start world', startWorlds(gen).worlds.length === 6,
  String(startWorlds(gen).worlds.length));
const close = normalizeMap({
  bodies: [
    { id: 'p1', type: 'terrestrial', orbit: 400, start: true, yields: { science: 3 } },
    { id: 'p2', type: 'terrestrial', orbit: 410, start: true, yields: { science: 3 } },
  ],
});
check('two worlds on almost the same orbit are flagged', checkMap(close).some(i => i.code === 'orbits_close'));

// ---- 3. Save, load, share ---------------------------------------------------
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ORBITAL_ENV: 'staging' };
for (const u of ['u0', 'u1', 'u2']) {
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?, ?, ?, 'x', 0)`)
    .bind(u, `${u}@t`, u.toUpperCase()).run();
}
const { routes, solTemplate } = await import('../worker/customMaps.js');
async function call(method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const req = new Request(`https://x${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const res = await r.handle(req, env, { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId, email: `${userId}@t` } });
    return { status: res.status, body: await res.json() };
  }
  throw new Error(`no route ${method} ${path}`);
}
const made = await call('POST', '/api/maps', 'u0', { map: gen, name: 'Sim System' });
check('a map saves', made.status === 201 && made.body.summary.name === 'Sim System' && /^ORB-/.test(made.body.summary.share_code),
  JSON.stringify(made.body).slice(0, 200));
const id = made.body.summary.id;
const got = await call('GET', `/api/maps/${id}`, 'u0');
check('...and loads back as saved', got.status === 200 && got.body.map.bodies.length === gen.bodies.length);
check('...and nobody else can read it', (await call('GET', `/api/maps/${id}`, 'u1')).status === 404);
gen.bodies[0].name = 'Renamed';
const put = await call('PUT', `/api/maps/${id}`, 'u0', { map: gen });
check('...and edits save', put.status === 200 && put.body.map.bodies.some(b => b.name === 'Renamed'));
const secretHost = gen.bodies.find(b => !b.start && b.type !== 'rock');
secretHost.secret = 'ancient_city';
secretHost.type = 'terrestrial';
await call('PUT', `/api/maps/${id}`, 'u0', { map: gen });
const copy = await call('POST', '/api/maps/import', 'u1', { code: made.body.summary.share_code });
check('a share code opens a copy for someone else', copy.status === 201 && copy.body.map.name.endsWith('(copy)'));
check('...with the hand-placed discoveries turned to chance',
  copy.body.map.bodies.every(b => b.secret == null || b.secret === 'random'));
check('a bad code says what a code looks like', (await call('POST', '/api/maps/import', 'u1', { code: 'hello' })).status === 400);
const list = await call('GET', '/api/maps', 'u0');
check('your maps list, and you cannot host without the Commission',
  list.status === 200 && list.body.maps.length === 1 && list.body.can_host === false);
await DB.prepare(`INSERT INTO user_entitlements (user_id, sku, source, granted_at) VALUES ('u0', 'cosmetics_v1', 'admin', 0)`).run();
check('...and can with it', (await call('GET', '/api/maps', 'u0')).body.can_host === true);
const sol = solTemplate();
check('Our Solar System opens as a map: the real worlds, moons on their planets',
  sol.bodies.some(b => b.name === 'Earth' && b.start) && sol.bodies.some(b => b.name === 'Luna' && b.parent === 'earth')
    && hostBlockers(sol).length === 0, `${sol.bodies.length} bodies`);
check('the Map Maker is staging-only', await (async () => {
  const r = routes.find(x => x.method === 'GET' && x.pattern === '/api/maps');
  const res = await r.handle(new Request('https://x/api/maps'), { DB }, { session: { user_id: 'u0' } });
  return res.status === 404;
})());

// ---- 4. A game seeded from it ----------------------------------------------
const room = 'gmap1';
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at,custom_map_id,custom_map_json) VALUES (?, 'Map game','u0',0,0,?,?)`)
  .bind(room, id, JSON.stringify(normalizeMap(gen))).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at) VALUES (?, 'setup','map-seed',0,0)`).bind(room).run();
const starts = new Set(startWorlds(normalizeMap(gen)).worlds.map(b => `cm_${b.id}`));
const pickOne = [...starts][0];
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,?), (?,?,1,'earth'), (?,?,2,NULL)`)
  .bind(room, 'u0', pickOne, room, 'u1', room, 'u2').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, room);
const bodies = (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(room).all()).results;
const map = normalizeMap(gen);
check('the game is the map: every body, and nothing of Sol',
  bodies.length === map.bodies.length + 1 && !bodies.some(b => ['earth', 'jupiter', 'ceres'].includes(b.template_id)),
  `${bodies.length} vs ${map.bodies.length + 1}`);
const sun = bodies.find(b => b.template_id === 'sol');
check('the sun keeps the id the game finds it by, under the map\'s name', sun && sun.name === map.sun.name);
check('custom worlds keep their names and orbit their parents',
  map.bodies.every(mb => { const b = bodies.find(x => x.template_id === `cm_${mb.id}`); return b && b.name === mb.name
    && b.parent_body_id === `${room}:${mb.parent === 'sun' ? 'sol' : `cm_${mb.parent}`}`; }));
const caps = (await DB.prepare('SELECT user_id, capital_body_id FROM game_factions WHERE game_id = ?').bind(room).all()).results;
check('every capital is one of the map\'s start worlds',
  caps.length === 3 && caps.every(c => starts.has(String(c.capital_body_id).split(':').pop())),
  caps.map(c => c.capital_body_id).join(', '));
check('a lobby pick of a start world is honoured; a pick of Earth is not',
  caps.find(c => c.user_id === 'u0').capital_body_id === `${room}:${pickOne}`
    && caps.find(c => c.user_id === 'u1').capital_body_id !== `${room}:earth`);
const secretRow = bodies.find(b => b.template_id === `cm_${secretHost.id}`);
check('the hand-placed discovery is where its maker hid it', secretRow?.secret_kind === 'ancient_city', secretRow?.secret_kind);
const chance = map.bodies.filter(b => b.secret === 'random').map(b => bodies.find(x => x.template_id === `cm_${b.id}`));
check('the ones left to chance got a kind', chance.length > 0 && chance.every(b => b.secret_kind && b.secret_kind !== 'random'),
  chance.map(b => b?.secret_kind).join(','));
check('no meteoroids the maker did not place', !bodies.some(b => /^mtr_/.test(b.template_id)));
const looked = bodies.filter(b => b.look_json);
check('every custom world carries its look', looked.length === bodies.length,
  `${looked.length}/${bodies.length}`);
const ringed = map.bodies.find(b => b.rings);
check('...rings included', !ringed || JSON.parse(bodies.find(b => b.template_id === `cm_${ringed.id}`).look_json).rings === true);
const earthLike = map.bodies.find(b => b.parent === 'sun' && b.type === 'terrestrial');
const er = bodies.find(b => b.template_id === `cm_${earthLike.id}`);
const { scaledGeometry } = factions;
check('orbits are scaled by the game\'s dials like Sol\'s', Math.abs(er.orbit_radius - earthLike.orbit) < 1e-6 || er.orbit_radius > 0,
  `${er.orbit_radius} from ${earthLike.orbit}`);
const added = await factions.backfillMissingBodies(env, room);
check('the backfill never refills a custom map with Sol', added === 0, String(added));
const { cfg } = await import('../worker/gameConfig.js');
const conf = await cfg(env, room);
check('a custom-map game runs no far systems and no sun gates', conf.far_systems === 0 && conf.custom_map === true);
const v = await factions.startingBodyValidator(env, room);
check('mid-game joiners may start only on the map\'s start worlds', v(pickOne) && !v('earth'));

// An ordinary room is untouched by all of it.
const plainRoom = 'gplain';
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Sol game','u0',0,0)`).bind(plainRoom).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at) VALUES (?, 'setup','plain-seed',0,0)`).bind(plainRoom).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'earth')`).bind(plainRoom, 'u0').run();
await factions.seedGameWorld(env, plainRoom);
const solRows = (await DB.prepare('SELECT template_id, look_json FROM game_bodies WHERE game_id = ?').bind(plainRoom).all()).results;
check('an ordinary game still seeds Sol, with no looks', solRows.some(b => b.template_id === 'earth') && solRows.every(b => !b.look_json));
check('...and its catalogue path is unchanged by the map pass', mapToCatalog(gen)[0].id === 'sol');

console.log(bad === 0 ? '\nALL MAP MAKER CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
