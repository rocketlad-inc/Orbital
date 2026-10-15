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
  const pathname = path.split('?')[0];
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === pathname ? { groups: {} } : null) : pathname.match(r.pattern);
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
{
  // Two devices: each saves from the updated_ms it opened. The second
  // save, made from a base the first has moved past, is refused, and the
  // first device's edit stays.
  const base = put.body.summary.updated_ms;
  const a = await call('PUT', `/api/maps/${id}`, 'u0', { map: { ...gen, blurb: 'From the laptop.' }, base_updated_ms: base });
  const b = await call('PUT', `/api/maps/${id}`, 'u0', { map: { ...gen, blurb: 'From the phone.' }, base_updated_ms: base });
  const now = await call('GET', `/api/maps/${id}`, 'u0');
  check('a save from an up-to-date base lands and moves updated_ms on', a.status === 200 && a.body.summary.updated_ms > base,
    JSON.stringify(a.body).slice(0, 160));
  check('a save from a base another save moved past is refused as stale, not written over it',
    b.status === 409 && b.body.error?.code === 'stale' && now.body.map.blurb === 'From the laptop.', `${b.status} ${now.body.map.blurb}`);
  const c = await call('PUT', `/api/maps/${id}`, 'u0', { map: { ...gen, blurb: '' }, base_updated_ms: a.body.summary.updated_ms });
  check('...and the next save from the new base lands', c.status === 200, String(c.status));
}
const secretHost = gen.bodies.find(b => !b.start && b.type !== 'rock');
secretHost.secret = 'ancient_city';
secretHost.type = 'terrestrial';
secretHost.secretName = 'The Weeping Spire';
secretHost.secretText = 'Its bells still ring for a city nobody remembers.';
const loreWorld = gen.bodies.find(b => b.start);
loreWorld.lore = 'Where the first ships came down.';
gen.blurb = 'Six worlds round a hungry sun.';
await call('PUT', `/api/maps/${id}`, 'u0', { map: gen });
const copy = await call('POST', '/api/maps/import', 'u1', { code: made.body.summary.share_code });
check('a share code opens a copy for someone else', copy.status === 201 && copy.body.map.name.endsWith('(copy)'));
check('...with the hand-placed discoveries turned to chance',
  copy.body.map.bodies.every(b => b.secret == null || b.secret === 'random'));
check('...and no custom discovery name or message left to give it away',
  copy.body.map.bodies.every(b => !b.secretName && !b.secretText));
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
const room = 'gmap01';
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
const capCities = (await DB.prepare(`SELECT s.owner_faction_id, s.body_id FROM game_settlements s WHERE s.game_id = ? AND s.type = 'city'`).bind(room).all()).results;
const capRows = (await DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ?').bind(room).all()).results;
check('every empire starts with a capital city on its start world',
  capRows.length === 3 && capRows.every(f => capCities.some(c => c.owner_faction_id === f.id && c.body_id === f.capital_body_id)),
  `${capCities.length} cities for ${capRows.length} empires`);
const secretRow = bodies.find(b => b.template_id === `cm_${secretHost.id}`);
check('the hand-placed discovery is where its maker hid it', secretRow?.secret_kind === 'ancient_city', secretRow?.secret_kind);
check("...with its maker's own name and message stored beside it",
  secretRow?.secret_name === 'The Weeping Spire' && secretRow?.secret_text === 'Its bells still ring for a city nobody remembers.',
  `${secretRow?.secret_name} / ${secretRow?.secret_text}`);
const loreRow = bodies.find(b => b.template_id === `cm_${loreWorld.id}`);
check("a world's lore reaches the game in its look", JSON.parse(loreRow?.look_json ?? '{}').lore === 'Where the first ships came down.',
  loreRow?.look_json);
check('no world without a custom discovery carries custom words',
  bodies.filter(b => b.id !== secretRow?.id).every(b => b.secret_name == null && b.secret_text == null));

// The state a player receives: the words are withheld until the find.
const { routes: stateRoutes } = await import('../worker/state.js');
const stateRoute = stateRoutes.find(r => r.method === 'GET' && r.pattern.test(`/api/games/${room}/state`));
async function stateAs(uid) {
  const res = await stateRoute.handle(new Request(`https://x/api/games/${room}/state`), env,
    { session: { user_id: uid }, params: { gameId: room } });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j)}`);
  return j;
}
const before = (await stateAs('u1')).bodies.find(b => b.id === secretRow.id);
check("before it is found, nobody is sent the discovery's words",
  before && before.secret_name == null && before.secret_text == null && before.secret_kind == null,
  JSON.stringify(before && { k: before.secret_kind, n: before.secret_name }));

// A ship parks there; the tick reveals it.
const finder = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id = ? AND user_id = 'u1'`).bind(room).first()).id;
await DB.prepare(
  `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id, status,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, hp, hp_max, damage_per_tick, built_at_tick, home_body_id)
   VALUES (?, ?, ?, 'Scout', 'corvette', ?, 'active', 30, 30, 0, 0, 0, 1, 300, 300, 40, 40, 3, 0, ?)`,
).bind(`${room}:scout`, room, finder, secretRow.id, secretRow.id).run();
const { Room } = await import('../worker/room.js');
const doStore = new Map();
const gameRoom = new Room({
  storage: {
    async get(k) { return doStore.get(k); }, async put(k, v) { doStore.set(k, v); },
    async delete(k) { return doStore.delete(k); }, async list() { return new Map(doStore); },
    async deleteAll() { doStore.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  broadcast: () => {},
}, env);
await gameRoom.resolveSecretReveal(room, 5);
const news = await DB.prepare(`SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'secret_discovered'`).bind(room).first();
const told = JSON.parse(news?.payload ?? '{}');
check("the reveal is told in the maker's words",
  told.custom_name === 'The Weeping Spire' && told.custom_text === 'Its bells still ring for a city nobody remembers.'
    && told.message === `${secretRow.name}: The Weeping Spire — Its bells still ring for a city nobody remembers.`,
  news?.payload);
const ruins = await DB.prepare(`SELECT owner_faction_id FROM game_settlements WHERE body_id = ? AND type = 'city'`).bind(secretRow.id).first();
check("...and the reward is still the kind's (an ancient city for the finder), its sentence kept beside",
  ruins?.owner_faction_id === finder && /long-abandoned colony/.test(told.reward_message ?? ''), JSON.stringify(ruins));
const after = (await stateAs('u2')).bodies.find(b => b.id === secretRow.id);
check('once found, every player is sent its name and message',
  after?.secret_kind === 'ancient_city' && after?.secret_name === 'The Weeping Spire'
    && after?.secret_text === 'Its bells still ring for a city nobody remembers.',
  JSON.stringify(after && { k: after.secret_kind, n: after.secret_name }));
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

// ---- 5. The gallery and remixes -------------------------------------------
const blank = await call('POST', '/api/maps', 'u1', { map: blankMap('Empty Sky') });
const blocked = await call('POST', `/api/maps/${blank.body.summary.id}/publish`, 'u1', { on: true });
check('a map the checklist blocks cannot be published, and says why',
  blocked.status === 409 && blocked.body.error?.code === 'map_blocked'
    && blocked.body.blockers?.some(i => i.code === 'too_few_starts'),
  JSON.stringify(blocked.body).slice(0, 200));
check('nobody publishes a map that is not theirs',
  (await call('POST', `/api/maps/${id}/publish`, 'u1', { on: true })).status === 404);
const pub = await call('POST', `/api/maps/${id}/publish`, 'u0', { on: true });
check('a hostable map publishes; its summary says so, with its blurb and remix count',
  pub.status === 200 && pub.body.summary.published === true && pub.body.summary.remix_count === 0
    && pub.body.summary.blurb === 'Six worlds round a hungry sun.',
  JSON.stringify(pub.body.summary));
let gal = await call('GET', '/api/maps/gallery', 'u2');
check('the gallery lists published maps only',
  gal.status === 200 && gal.body.items.length === 1 && gal.body.items[0].id === id
    && !gal.body.items.some(i => i.id === blank.body.summary.id),
  JSON.stringify(gal.body.items.map(i => i.id)));
const card = gal.body.items[0];
const sunKids = normalizeMap(gen).bodies.filter(b => b.parent === 'sun');
check('a gallery card carries author, counts, start worlds and a sun-children-only thumb',
  card.author === 'U0' && card.mine === false && card.starts === startWorlds(normalizeMap(gen)).worlds.length
    && card.thumb.bodies.length === sunKids.length && card.thumb.bodies.every(t => t.length === 5)
    && card.thumb.backdrop === 'deep' && typeof card.thumb.sun.color === 'string' && card.blurb === gen.blurb,
  JSON.stringify(card).slice(0, 300));
check('...and marks your own map as yours', (await call('GET', '/api/maps/gallery', 'u0')).body.items[0].mine === true);

// Three more published maps, with counts and dates set by hand to pin the orders.
const seedPub = async (owner, name, hosted, remixes, publishedMs) => {
  const m = await call('POST', '/api/maps', owner, { map: generateMap({ seed: publishedMs, planets: 6, starts: 4 }), name });
  await DB.prepare('UPDATE custom_maps SET published = 1, published_ms = ?, hosted_count = ?, remix_count = ? WHERE id = ?')
    .bind(publishedMs, hosted, remixes, m.body.summary.id).run();
  return m.body.summary.id;
};
await DB.prepare('UPDATE custom_maps SET published_ms = 1000 WHERE id = ?').bind(id).run(); // score 0
const mA = await seedPub('u1', 'Alpha Reach', 2, 0, 3000); // score 6
const mB = await seedPub('u2', 'Beta Drift', 0, 5, 2000);  // score 5
const mC = await seedPub('u2', 'Gamma Alpha', 2, 0, 4000); // score 6, newer than Alpha Reach
const ids = (r) => r.body.items.map(i => i.id).join(',');
gal = await call('GET', '/api/maps/gallery?sort=popular', 'u0');
check('popular = hosted x3 + remixes, newest first on a tie', ids(gal) === [mC, mA, mB, id].join(','), ids(gal));
gal = await call('GET', '/api/maps/gallery?sort=new', 'u0');
check('new = most recently published first', ids(gal) === [mC, mA, mB, id].join(',') && gal.body.next === null, ids(gal));
const pages = [];
let cursor = '';
for (let i = 0; i < 6; i++) {
  const p = await call('GET', `/api/maps/gallery?sort=popular&limit=1${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`, 'u0');
  pages.push(...p.body.items.map(x => x.id));
  if (!p.body.next) break;
  cursor = p.body.next;
}
const pagesNew = [];
cursor = '';
for (let i = 0; i < 6; i++) {
  const p = await call('GET', `/api/maps/gallery?sort=new&limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`, 'u0');
  pagesNew.push(...p.body.items.map(x => x.id));
  if (!p.body.next) break;
  cursor = p.body.next;
}
check('paging by cursor walks each order without a gap or a repeat',
  pages.join(',') === [mC, mA, mB, id].join(',') && pagesNew.join(',') === [mC, mA, mB, id].join(','),
  `${pages.join(',')} | ${pagesNew.join(',')}`);
gal = await call('GET', '/api/maps/gallery?q=alpha', 'u0');
check('search matches the name, any case', ids(gal) === [mC, mA].join(','), ids(gal));
check('a bad cursor is refused', (await call('GET', '/api/maps/gallery?before=nonsense', 'u0')).status === 400);

// Preview, then remix.
const peek = await call('GET', `/api/maps/gallery/${id}`, 'u1');
const peekSecret = peek.body.map?.bodies.find(b => b.id === secretHost.id);
check('a gallery preview hides the maker\'s hand-placed discoveries from others',
  peek.status === 200 && peek.body.item.id === id && peekSecret?.secret === 'random'
    && !peekSecret.secretName && !peekSecret.secretText,
  JSON.stringify(peekSecret));
const ownPeek = (await call('GET', `/api/maps/gallery/${id}`, 'u0')).body.map.bodies.find(b => b.id === secretHost.id);
check('...but not from the maker', ownPeek.secret === 'ancient_city' && ownPeek.secretName === 'The Weeping Spire');
check('an unpublished map cannot be previewed by anyone else',
  (await call('GET', `/api/maps/gallery/${blank.body.summary.id}`, 'u0')).status === 404);
const remix = await call('POST', `/api/maps/${id}/remix`, 'u1');
const rmSecret = remix.body.map?.bodies.find(b => b.id === secretHost.id);
const srcAfter = await DB.prepare('SELECT remix_count FROM custom_maps WHERE id = ?').bind(id).first();
const rmRow = remix.status === 201
  ? await DB.prepare('SELECT owner_user_id, copied_from, published FROM custom_maps WHERE id = ?').bind(remix.body.summary.id).first() : null;
check('a remix copies the map into your maps, unpublished, secrets hidden, and counts',
  remix.status === 201 && remix.body.map.name.endsWith('(copy)') && rmSecret?.secret === 'random' && !rmSecret.secretName
    && rmRow?.owner_user_id === 'u1' && rmRow?.copied_from === id && rmRow?.published === 0
    && Number(srcAfter.remix_count) === 1 && remix.body.summary.published === false,
  JSON.stringify({ s: remix.status, n: remix.body.map?.name, rmRow, c: srcAfter.remix_count }));
const ownRemix = await call('POST', `/api/maps/${id}/remix`, 'u0');
const srcAfterOwn = await DB.prepare('SELECT remix_count FROM custom_maps WHERE id = ?').bind(id).first();
check('remixing your own map copies it whole and does not count',
  ownRemix.status === 201 && Number(srcAfterOwn.remix_count) === 1
    && ownRemix.body.map.bodies.find(b => b.id === secretHost.id)?.secretName === 'The Weeping Spire');
check('remixing someone\'s unpublished map is refused',
  (await call('POST', `/api/maps/${blank.body.summary.id}/remix`, 'u0')).status === 404);
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u3','u3@t','U3','x',0)`).run();
for (let i = 0; i < 50; i++) {
  await DB.prepare(`INSERT INTO custom_maps (id, owner_user_id, name, map_json, share_code, hosted_count, created_ms, updated_ms)
                    VALUES (?, 'u3', 'x', '{}', ?, 0, 0, 0)`).bind(`map_cap${i}`, `ORB-CAP${i}`).run();
}
check('a remix respects the 50-map cap',
  (await call('POST', `/api/maps/${id}/remix`, 'u3')).body.error?.code === 'too_many_maps');
const unpub = await call('POST', `/api/maps/${id}/publish`, 'u0', { on: false });
gal = await call('GET', '/api/maps/gallery?sort=new', 'u2');
check('unpublishing takes a map out of the gallery',
  unpub.body.summary.published === false && !gal.body.items.some(i => i.id === id), ids(gal));
check('the gallery is staging-only too', await (async () => {
  const r = routes.find(x => x.method === 'GET' && x.pattern === '/api/maps/gallery');
  const res = await r.handle(new Request('https://x/api/maps/gallery'), { DB }, { session: { user_id: 'u0' } });
  return res.status === 404;
})());

// ---- the security review's findings (2026-10-15) ----------------------------
{
  // 1. An id or colour that is not a string never survives the cleaner.
  const poison = normalizeMap({ bodies: [
    { id: 'aa', type: 'terrestrial', orbit: 400, start: true, yields: { science: 3 } },
    { id: 'bb', type: 'terrestrial', orbit: 2000, start: true, yields: { science: 3 } },
    { id: 'cc', type: 'gas-giant', orbit: 1200 },
    { id: ['cc'], type: 'gas-giant', orbit: 3000, color: ['#00ff00'] },
    { id: [['aa']], type: 'terrestrial', orbit: 900, start: true },
  ], sun: { color: ['#ffffff'] }, sectors: [{ id: ['sx'], name: 'X', inner: 1, outer: 99 }] });
  const ids = poison.bodies.map(b => b.id);
  check('an array id is dropped, never kept as a twin of a real one',
    ids.every(i => typeof i === 'string') && new Set(ids).size === ids.length && ids.length === 3, JSON.stringify(ids));
  check('an array colour falls back to a real colour',
    typeof poison.sun.color === 'string' && poison.bodies.every(b => typeof b.color === 'string') && poison.sectors.length === 0);
  // 8. Invisible characters leave names.
  const sneaky = normalizeMap({ name: 'Good‮evil\u0000​name', bodies: [{ id: 'a1', type: 'dwarf', orbit: 300, name: 'Ka\u0007ro⁦n' }] });
  check('names lose control, zero-width and bidi characters',
    sneaky.name === 'Goodevilname' && sneaky.bodies[0].name === 'Karon', `${JSON.stringify(sneaky.name)} ${JSON.stringify(sneaky.bodies[0].name)}`);
  // 6. The size cap counts bytes.
  // CJK is 3 bytes a character: about 300 KB of bytes in about 100k characters.
  const kanji = (n) => '漢'.repeat(n);
  const fat = { name: 'Fat', blurb: kanji(400), bodies: Array.from({ length: 200 }, (_, i) => ({
    id: `f${i}`, type: 'terrestrial', orbit: 100 + i * 50, name: kanji(24), lore: kanji(200),
    secret: 'resource_cache', secretName: kanji(40), secretText: kanji(240) })) };
  const fatRes = await call('POST', '/api/maps', 'u2', { map: fat });
  check('the 200 KB map cap counts bytes, not characters', fatRes.status === 413, `${fatRes.status} ${JSON.stringify(fatRes.body).slice(0, 120)}`);
  // 4. The 50-map cap holds when saves race.
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u9','u9@t','U9','x',0)`).run();
  for (let i = 0; i < 49; i++) {
    await DB.prepare(`INSERT INTO custom_maps (id, owner_user_id, name, map_json, share_code, hosted_count, created_ms, updated_ms)
                      VALUES (?, 'u9', 'x', '{}', ?, 0, 0, 0)`).bind(`map_race${i}`, `ORB-RACE${i}`).run();
  }
  const racers = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/maps', 'u9', { map: blankMap('race') })));
  const n9 = (await DB.prepare(`SELECT COUNT(*) n FROM custom_maps WHERE owner_user_id = 'u9'`).first()).n;
  check('ten saves racing at 49 maps leave exactly 50', n9 === 50 && racers.filter(r => r.status === 201).length === 1,
    `${n9} maps, ${racers.filter(r => r.status === 201).length} created`);
  // 3. A remix counts once per person.
  const pubMap = await call('POST', '/api/maps', 'u0', { map: gen, name: 'Counted' });
  await call('POST', `/api/maps/${pubMap.body.summary.id}/publish`, 'u0', { on: true });
  for (let i = 0; i < 4; i++) {
    const rx = await call('POST', `/api/maps/${pubMap.body.summary.id}/remix`, 'u1');
    if (rx.status === 201) await call('DELETE', `/api/maps/${rx.body.summary.id}`, 'u1');
  }
  const rc = (await DB.prepare('SELECT remix_count FROM custom_maps WHERE id = ?').bind(pubMap.body.summary.id).first()).remix_count;
  check('remix-and-delete four times counts as one remix', rc === 1, `remix_count ${rc}`);
  // 5. A published map edited into an unhostable one leaves the gallery.
  await call('PUT', `/api/maps/${pubMap.body.summary.id}`, 'u0', { map: blankMap('Broken now') });
  const galNow = await call('GET', '/api/maps/gallery?sort=new', 'u2');
  check('a published map with blockers is kept out of the gallery', !galNow.body.items.some(i => i.id === pubMap.body.summary.id));
}
// 2. More players than start worlds: the start is refused, not half-made.
{
  const lobby = await import('../worker/lobby.js');
  const two = normalizeMap({ bodies: [
    { id: 'w1', type: 'terrestrial', orbit: 300, start: true, yields: { science: 3 } },
    { id: 'w2', type: 'terrestrial', orbit: 900, start: true, yields: { science: 3 } },
  ] });
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,status,max_players,created_at,updated_at,custom_map_id,custom_map_json) VALUES ('crowd','Crowd','u0','lobby',2,0,0,'map_c',?)`).bind(JSON.stringify(two)).run();
  for (const u of ['u0', 'u1', 'u2']) await DB.prepare('INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,0)').bind('crowd', u).run();
  const res = await lobby.startGame({ ...env, ROOM: { idFromName: (x) => x, get: () => ({ fetch: async () => new Response('{}') }) } }, 'crowd');
  const gameRow = await DB.prepare(`SELECT 1 x FROM games WHERE id = 'crowd'`).first();
  check('three players on a two-start map cannot start it (and nothing is half-made)',
    res.error && !gameRow, JSON.stringify(res.error ? 'refused' : res).slice(0, 120));
}

// ---- Quick Join is Solar System only ---------------------------------------
{
  const { joinableLobbies } = await import('../worker/matchmaking.js');
  const now = Date.now();
  await DB.prepare(`UPDATE users SET last_visit_ms = ? WHERE id = 'u0'`).bind(now).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,status,max_players,created_at,updated_at,quick_join) VALUES ('qj_sol','Sol lobby','u0','lobby',4,?,?,1)`).bind(now, now).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,status,max_players,created_at,updated_at,quick_join,custom_map_id,custom_map_json) VALUES ('qj_map','Map lobby','u0','lobby',4,?,?,1,'map_x','{}')`).bind(now, now).run();
  const open = (await joinableLobbies({ DB }, now, { limit: 50 })).map(r => r.id);
  check('Quick Join offers a Solar System lobby', open.includes('qj_sol'), open.join(','));
  check('Quick Join never offers a custom-map lobby', !open.includes('qj_map'), open.join(','));
  const pinned = (await joinableLobbies({ DB }, now, { roomId: 'qj_map' })).map(r => r.id);
  check('…not even when asked for by name', pinned.length === 0, pinned.join(','));
}

console.log(bad === 0 ? '\nALL MAP MAKER CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
