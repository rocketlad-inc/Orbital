// ============================================================================
// sim/wrecks.mjs -- wrecked settlements (0142).
//
// A city or station beaten down by warships leaves RUINS. The only faction
// with warships at the world can SEIZE them (the founding price, every
// building one level lower, 25% hull, no colony ship) or RAZE them. The
// gun and the rock wipe a world clean: an asteroid, a Mega Destroyer strike
// or an obliteration erases the ruins too. Wrecks never decay.
//
// Real seeding, real combat ticks, the real endpoint.
//
//   node sim/wrecks.mjs
// ============================================================================

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
const G = 'gwrecks1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Wr','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','wreck-seed',100,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'venus')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
const [A, B] = (await DB.prepare(
  `SELECT id, user_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
await DB.prepare('UPDATE game_factions SET metal = 50000, gold = 50000 WHERE game_id = ?').bind(G).run();
const { SHIP_COMBAT_STATS } = factions;
const actions = await import('../worker/actions.js');
const { WRECK_SEIZE_COST, commitSettlement, MEGA_STRIKE_CHARGE_TICKS } = actions;

const bid = (t) => `${G}:${t}`;
const [fa, fb] = [A.id, B.id].sort();
await DB.prepare(
  `INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick, origin)
   VALUES (?, ?, ?, ?, ?, 50, 'declared')`).bind(`${G}:war`, G, fa, fb, A.id).run();

const store = new Map();
const { Room } = await import('../worker/room.js');
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  broadcast: () => {},
}, env);
let tick = 100;
async function runTick() {
  tick += 1;
  await room.resolveTick(G, tick);
  await DB.prepare('UPDATE games SET current_tick=? WHERE id=?').bind(tick, G).run();
}
let shipN = 0;
async function park(owner, bodyId, cls = 'destroyer') {
  const st = SHIP_COMBAT_STATS[cls];
  const id = `${G}:t${shipN++}`;
  await DB.prepare(
    `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id, status,
       orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
       fuel, fuel_max, hp, hp_max, damage_per_tick, built_at_tick, home_body_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 6, 6, 0, 0, 0, 1, 300, 300, ?, ?, ?, 0, ?)`,
  ).bind(id, G, owner, `T${shipN}`, cls, bodyId, st.hp, st.hp, st.damage_per_tick, bodyId).run();
  return id;
}
async function call(method, path, userId, payload = {}) {
  for (const r of actions.routes) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const res = await r.handle({ json: async () => payload, headers: new Map() }, env,
      { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  throw new Error(`no route ${method} ${path}`);
}
const wreckAction = (userId, sid, mode) => call('POST', `/api/games/${G}/wrecks/${sid}`, userId, { mode });
const settle = (id) => DB.prepare(
  `SELECT id, owner_faction_id, type, hp, hp_max, population, buildings_json, destroyed_at_tick,
          wrecked_at_tick, building_order_json, last_harvest_tick FROM game_settlements WHERE id = ?`).bind(id).first();
const purse = (fid) => DB.prepare('SELECT metal, gold, status FROM game_factions WHERE id = ?').bind(fid).first();
const owner = async (t) => (await DB.prepare('SELECT owner_faction_id AS o FROM game_bodies WHERE id = ?').bind(bid(t)).first()).o;
const chronicle = async (kind) => (await DB.prepare(
  `SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = ?`).bind(G, kind).all()).results
  .map(r => JSON.parse(r.payload));

// ===== 1. WARSHIPS LEAVE RUINS ================================================
const venusCity = await DB.prepare(
  `SELECT id FROM game_settlements WHERE body_id = ? AND type = 'city' AND destroyed_at_tick IS NULL`)
  .bind(bid('venus')).first();
check('setup: B has a city on Venus', !!venusCity);
await DB.prepare('UPDATE game_settlements SET buildings_json = ?, hp = 60, shield_hp = 0 WHERE id = ?')
  .bind(JSON.stringify({ forge: 3, mint: 1, shipyard: 2 }), venusCity.id).run();
// Level the rest of Venus so the city is the only target and falls quickly.
await DB.prepare(`UPDATE game_settlements SET destroyed_at_tick = 1 WHERE body_id = ? AND id != ? AND destroyed_at_tick IS NULL`)
  .bind(bid('venus'), venusCity.id).run();
const raider = await park(A.id, bid('venus'));
for (let i = 0; i < 12 && (await settle(venusCity.id)).destroyed_at_tick == null; i++) await runTick();
const w0 = await settle(venusCity.id);
check('the city falls to warships', w0.destroyed_at_tick != null, JSON.stringify(w0));
check('...and is left as RUINS, not erased', w0.wrecked_at_tick != null, JSON.stringify(w0));
check('...with its buildings still on record', JSON.parse(w0.buildings_json).forge === 3, w0.buildings_json);
check('...holding no claim on the world', (await owner('venus')) !== B.id);
const destroyedLog = await chronicle('settlement_destroyed');
check('the loss is chronicled as left in ruins', destroyedLog.some(p => p.settlement_id === venusCity.id && p.wrecked === true),
  JSON.stringify(destroyedLog.slice(-1)));

// ===== 2. THE FORCE RULE ======================================================
const noForce = await wreckAction('uB', venusCity.id, 'seize');
check('seizing with no warship there is refused', noForce.status === 409 && noForce.body.error?.code === 'no_force',
  JSON.stringify(noForce));
const defender = await park(B.id, bid('venus'));
const contested = await wreckAction('uA', venusCity.id, 'seize');
check('seizing while a rival still has warships there is refused',
  contested.status === 409 && contested.body.error?.code === 'contested', JSON.stringify(contested));
await DB.prepare('DELETE FROM game_ships WHERE id = ?').bind(defender).run();

// ===== 3. SEIZE ===============================================================
const before = await purse(A.id);
const seized = await wreckAction('uA', venusCity.id, 'seize');
check('A seizes the ruins', seized.status === 200 && seized.body.mode === 'seize', JSON.stringify(seized));
const newId = seized.body.settlement?.id;
const w1 = await settle(newId);
const after = await purse(A.id);
check('...a live city of A’s rises on them', !!w1 && w1.destroyed_at_tick == null && w1.type === 'city'
  && w1.owner_faction_id === A.id, JSON.stringify(w1));
const old = await settle(venusCity.id);
check('...the ruins are consumed, and the dead city stays B’s (B lost it)',
  old.destroyed_at_tick != null && old.wrecked_at_tick == null && old.owner_faction_id === B.id, JSON.stringify(old));
check('...EVERY BUILDING ONE LEVEL LOWER (a level-1 building is gone)',
  JSON.stringify(JSON.parse(w1.buildings_json)) === JSON.stringify({ forge: 2, shipyard: 1 }), w1.buildings_json);
check('...at 25% hull', w1.hp === Math.ceil(w1.hp_max * 0.25), `${w1.hp}/${w1.hp_max}`);
check('...population 1, and none of the old owner’s queue',
  w1.population === 1 && w1.building_order_json == null, JSON.stringify(w1));
check('...announced once, as a seizure, not also as a founding',
  !(await chronicle('settlement_built')).some(p => p.settlement_id === newId));
check(`...for the founding price, ${WRECK_SEIZE_COST.metal}M ${WRECK_SEIZE_COST.gold}C`,
  before.metal - after.metal === WRECK_SEIZE_COST.metal && before.gold - after.gold === WRECK_SEIZE_COST.gold,
  `${before.metal}->${after.metal} / ${before.gold}->${after.gold}`);
check('...and no colony ship was needed', (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id = ? AND ship_class = 'colony'`).bind(G).first()).n === 0);
check('...the world is A’s now', (await owner('venus')) === A.id);
check('...and the seizure is chronicled', (await chronicle('settlement_seized')).some(p => p.settlement_id === venusCity.id));
const again = await wreckAction('uA', venusCity.id, 'seize');
check('the same ruins cannot be seized twice', again.status === 404, JSON.stringify(again));
const hp0 = w1.hp;
await runTick(); await runTick();
const w2 = await settle(newId);
check('it survives the next ticks as A’s, and mends', w2.destroyed_at_tick == null && w2.owner_faction_id === A.id
  && w2.hp > hp0, JSON.stringify(w2));

// ===== 4. ELIMINATION STILL HAPPENS, AND RUINS ARE A WAY BACK ================
// Venus was B's only city. It fell, and A seized the ruins BEFORE the next
// tick's elimination sweep. Seizing must not erase the record that B lost
// its last settlement, or B stays 'active' with nothing, forever.
check('B, whose only city fell and was seized, is still ELIMINATED', (await purse(B.id)).status === 'eliminated',
  JSON.stringify(await purse(B.id)));
// Now A's city is wrecked in turn, and B comes back with a warship.
await DB.prepare('DELETE FROM game_ships WHERE id = ?').bind(raider).run();
await DB.prepare('UPDATE game_settlements SET hp = 0, destroyed_at_tick = ?, wrecked_at_tick = ? WHERE id = ?')
  .bind(tick, tick, newId).run();
await park(B.id, bid('venus'));
const retake = await wreckAction('uB', newId, 'seize');
check('an eliminated empire can seize ruins', retake.status === 200, JSON.stringify(retake));
await runTick();
check('...and is REVIVED by it', (await purse(B.id)).status === 'active', JSON.stringify(await purse(B.id)));
const seizures = await chronicle('settlement_seized');
check('...and the chronicle records both seizures, the second not a retaking (those ruins were A’s)',
  seizures.length === 2 && seizures[1].retaken === false, JSON.stringify(seizures.map(p => p.retaken)));

// ===== 5. RAZE ================================================================
const marsCity = await commitSettlement(env, {
  gameId: G, bodyId: bid('mars'), factionId: B.id, type: 'station', name: 'Mars Stn',
  tick, bodyRadius: 3, bodyName: 'Mars',
});
const marsId = marsCity.settlement?.id ?? (await DB.prepare(
  `SELECT id FROM game_settlements WHERE body_id = ? AND type = 'station' AND destroyed_at_tick IS NULL`)
  .bind(bid('mars')).first()).id;
await DB.prepare('UPDATE game_settlements SET hp = 0, destroyed_at_tick = ?, wrecked_at_tick = ? WHERE id = ?')
  .bind(tick, tick, marsId).run();
await park(A.id, bid('mars'));
const razed = await wreckAction('uA', marsId, 'raze');
check('A razes the ruins on Mars', razed.status === 200 && razed.body.mode === 'raze', JSON.stringify(razed));
check('...they are gone for good', (await settle(marsId)).wrecked_at_tick == null
  && (await wreckAction('uA', marsId, 'seize')).status === 404);

// ===== 6. THE GUN AND THE ROCK WIPE A WORLD CLEAN ============================
// Ruins on a living world, then a Mega Destroyer strike: the ruins go too.
const ceresId = (await commitSettlement(env, {
  gameId: G, bodyId: bid('luna'), factionId: B.id, type: 'station', name: 'Luna Stn',
  tick, bodyRadius: 1.5, bodyName: 'Luna',
})).settlement?.id ?? (await DB.prepare(
  `SELECT id FROM game_settlements WHERE body_id = ? AND type = 'station' AND destroyed_at_tick IS NULL`)
  .bind(bid('luna')).first()).id;
await DB.prepare('UPDATE game_settlements SET hp = 0, destroyed_at_tick = ?, wrecked_at_tick = ? WHERE id = ?')
  .bind(tick, tick, ceresId).run();
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = 1 WHERE id = ?').bind(bid('luna')).run();
const mega = await park(A.id, bid('luna'), 'mega_destroyer');
const st = await call('POST', `/api/games/${G}/ships/${mega}/strike`, 'uA');
check('setup: a strike charges over Luna, where ruins lie', st.status === 200, JSON.stringify(st));
for (let i = 0; i < MEGA_STRIKE_CHARGE_TICKS; i++) await runTick();
check('the strike erases the ruins with the biosphere', (await settle(ceresId)).wrecked_at_tick == null,
  JSON.stringify(await settle(ceresId)));

// ===== 7. BUILT OVER THE RUINS ===============================================
const ioSt = (await commitSettlement(env, {
  gameId: G, bodyId: bid('io'), factionId: B.id, type: 'station', name: 'Io Stn',
  tick, bodyRadius: 1.5, bodyName: 'Io',
})).settlement?.id ?? (await DB.prepare(
  `SELECT id FROM game_settlements WHERE body_id = ? AND type = 'station' AND destroyed_at_tick IS NULL`)
  .bind(bid('io')).first()).id;
await DB.prepare('UPDATE game_settlements SET hp = 0, destroyed_at_tick = ?, wrecked_at_tick = ? WHERE id = ?')
  .bind(tick, tick, ioSt).run();
// Settlement ids are body + millisecond; two foundings on one world in
// the same millisecond only happen in a harness.
await new Promise(r => setTimeout(r, 5));
const rebuilt = await commitSettlement(env, {
  gameId: G, bodyId: bid('io'), factionId: A.id, type: 'station', name: 'New Io',
  tick, bodyRadius: 1.5, bodyName: 'Io',
});
check('founding a new station over station ruins clears them', rebuilt.ok && (await settle(ioSt)).wrecked_at_tick == null,
  JSON.stringify(rebuilt));

// ===== 8. NO DECAY ============================================================
const titanSt = (await commitSettlement(env, {
  gameId: G, bodyId: bid('titan'), factionId: B.id, type: 'station', name: 'Titan Stn',
  tick, bodyRadius: 1.5, bodyName: 'Titan',
})).settlement?.id ?? (await DB.prepare(
  `SELECT id FROM game_settlements WHERE body_id = ? AND type = 'station' AND destroyed_at_tick IS NULL`)
  .bind(bid('titan')).first()).id;
await DB.prepare('UPDATE game_settlements SET hp = 0, destroyed_at_tick = ?, wrecked_at_tick = ? WHERE id = ?')
  .bind(tick, tick, titanSt).run();
for (let i = 0; i < 10; i++) await runTick();
check('ruins do not decay (still there ten ticks on)', (await settle(titanSt)).wrecked_at_tick != null);

// ===== 9. NOBODY ELSE SEES A WRECK AS A SETTLEMENT ===========================
const live = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_settlements WHERE id = ? AND destroyed_at_tick IS NULL`).bind(titanSt).first()).n;
check('a wreck is still a dead settlement to every other query', live === 0);
await DB.prepare('UPDATE game_factions SET metal = 0 WHERE id = ?').bind(A.id).run();
await park(A.id, bid('titan'));
const broke = await wreckAction('uA', titanSt, 'seize');
check('seizing needs the rebuild bill', broke.status === 409 && broke.body.error?.code === 'insufficient_resources',
  JSON.stringify(broke));
check('...and a refused seize leaves the ruins alone', (await settle(titanSt)).wrecked_at_tick != null);

console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nALL WRECK CHECKS PASS');
process.exit(bad ? 1 : 0);
