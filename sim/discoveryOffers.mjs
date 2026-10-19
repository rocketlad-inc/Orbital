// ============================================================================
// DISCOVERY OFFERS — a found ship is a choice (worker/discoveryOffers.js).
//
// Lorne, 2026-10-18: "We need to add an option to refuse a structure/craft a
// player discovers. Sometimes they can't afford it." The real tick code
// (room.js resolveSecretReveal) and the real routes, on a seeded game:
//
//   1. a parked ship turns a derelict into an OFFER: nothing minted, the
//      world still hidden, a line only the finder sees
//   2. CLAIM mints it (the finder's own destroyer design) and makes it news
//   3. REFUSE mints nothing; the find waits, and the refuser never triggers
//      it again, but ANOTHER empire's ship does
//   4. an offer nobody answers is claimed for its finder at the deadline;
//      an eliminated finder's offer lapses back to the world
//   5. the capital ship (Mega Destroyer / Mobile Foundry) the same way
//   6. other finds (a cache) are untouched: revealed and paid at once
//   7. the routes: only the finder may answer, and only once
//
// Run: node sim/discoveryOffers.mjs
// ============================================================================

import { seedGameWorld } from '../worker/factions.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const { Room, ancientCapitalKind } = await import('../worker/room.js');
const { routes, OFFER_TICKS, settleExpiredOffers } = await import('../worker/discoveryOffers.js');

const G = 'gdisc_one';
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
for (const u of ['u0', 'u1', 'u2']) {
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',0)`)
    .bind(u, `${u}@t`, u.toUpperCase()).run();
}
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Finds','u0',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at) VALUES (?, 'setup','disc-seed',0,0)`).bind(G).run();
for (const u of ['u0', 'u1', 'u2']) {
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,0)`).bind(G, u).run();
}
await seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status = 'active', current_tick = 100 WHERE id = ?`).bind(G).run();

const factions = (await DB.prepare(`SELECT id, user_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
const [A, B, C] = factions;
check('three empires seeded', factions.length === 3, JSON.stringify(factions));

// Three quiet worlds nobody holds: a derelict, a capital ship and a cache.
const free = (await DB.prepare(
  `SELECT id, name FROM game_bodies WHERE game_id = ? AND owner_faction_id IS NULL
      AND type IN ('moon','dwarf','asteroid') ORDER BY id LIMIT 3`).bind(G).all()).results;
const [wreckW, capW, cacheW] = free;
await DB.prepare(`UPDATE game_bodies SET secret_kind = NULL, secret_revealed = 0 WHERE game_id = ?`).bind(G).run();
for (const [w, kind] of [[wreckW, 'derelict_warship'], [capW, 'ancient_capital'], [cacheW, 'resource_cache']]) {
  await DB.prepare(`UPDATE game_bodies SET secret_kind = ?, secret_revealed = 0 WHERE id = ?`).bind(kind, w.id).run();
}

let shipN = 0;
async function park(faction, body, builtAt = 0) {
  const id = `${G}:scout${shipN++}`;
  await DB.prepare(
    `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id, status,
       orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
       fuel, fuel_max, hp, hp_max, damage_per_tick, built_at_tick, home_body_id)
     VALUES (?, ?, ?, ?, 'corvette', ?, 'active', 30, 30, 0, 0, 0, 1, 300, 300, 40, 40, 3, ?, ?)`,
  ).bind(id, G, faction.id, `Scout ${shipN}`, body.id, builtAt, body.id).run();
  return id;
}
const store = new Map();
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  broadcast: () => {},
}, env);

const one = (sql, ...a) => DB.prepare(sql).bind(...a).first();
const destroyersAt = async (body) => Number((await one(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id = ? AND parent_body_id = ? AND ship_class = 'destroyer'`, G, body.id)).n);
const offerOf = (body, f) => one(`SELECT * FROM discovery_offers WHERE body_id = ? AND faction_id = ?`, body.id, f.id);
const answer = async (user, body, verb) => {
  const route = routes[0];
  const path = `/api/games/${G}/discoveries/${encodeURIComponent(body.id)}/${verb}`;
  const m = route.pattern.exec(path);
  const res = await route.handle(new Request(`https://x${path}`, { method: 'POST' }), env,
    { params: m.groups, session: { user_id: user } });
  return { status: res.status, body: await res.json() };
};

// ---- 1. a parked ship turns a derelict into an offer ----------------------
await park(A, wreckW, 1);
await park(B, wreckW, 5);   // built later: A found it first
await park(A, cacheW, 1);
await room.resolveSecretReveal(G, 100);
const o1 = await offerOf(wreckW, A);
check('the derelict becomes an offer to the empire whose ship found it first',
  o1?.status === 'pending' && o1.expires_tick === 100 + OFFER_TICKS && o1.kind === 'derelict_warship', JSON.stringify(o1));
check('...nothing is minted yet, and the world stays hidden',
  (await destroyersAt(wreckW)) === 0 && (await one('SELECT secret_revealed AS r FROM game_bodies WHERE id = ?', wreckW.id)).r === 0);
const line = await one(`SELECT visibility, payload FROM chronicle_entries WHERE game_id = ? AND kind = 'discovery_offer'`, G);
check('...and only the finder hears of it', line && JSON.parse(line.visibility).join() === A.id, JSON.stringify(line));
check('a second tick offers it to nobody else while it waits',
  (await room.resolveSecretReveal(G, 101), !(await offerOf(wreckW, B))));

// ---- 6. other finds are untouched ------------------------------------------
const cache = await one('SELECT secret_revealed AS r, secret_discovered_by_faction_id AS by FROM game_bodies WHERE id = ?', cacheW.id);
check('a cache is still revealed and paid at once', cache.r === 1 && cache.by === A.id, JSON.stringify(cache));

// ---- 7a. only the finder may answer ---------------------------------------
check('a rival cannot claim it', (await answer(B.user_id, wreckW, 'claim')).status === 409);

// ---- 3. refuse: nothing minted, the find waits for someone else -----------
const metalBefore = Number((await one('SELECT metal FROM game_factions WHERE id = ?', A.id)).metal);
const r1 = await answer(A.user_id, wreckW, 'refuse');
check('the finder refuses it', r1.status === 200 && r1.body.status === 'refused', JSON.stringify(r1));
check('...nothing minted, nothing charged, the world still hidden',
  (await destroyersAt(wreckW)) === 0
  && Number((await one('SELECT metal FROM game_factions WHERE id = ?', A.id)).metal) === metalBefore
  && (await one('SELECT secret_revealed AS r FROM game_bodies WHERE id = ?', wreckW.id)).r === 0);
check('...and it cannot be answered twice', (await answer(A.user_id, wreckW, 'claim')).status === 409);
await room.resolveSecretReveal(G, 102);
const o2 = await offerOf(wreckW, B);
check('next tick it is offered to ANOTHER empire parked there, not the refuser',
  o2?.status === 'pending' && (await offerOf(wreckW, A)).status === 'refused', JSON.stringify(o2));

// ---- 2. claim: minted as the finder's own destroyer, and news ------------
const c1 = await answer(B.user_id, wreckW, 'claim');
check('the second finder claims it', c1.status === 200, JSON.stringify(c1));
const wreck = await one(`SELECT * FROM game_ships WHERE game_id = ? AND parent_body_id = ? AND ship_class = 'destroyer'`, G, wreckW.id);
check('...a destroyer joins THEIR fleet, built as their yard would build it',
  wreck?.owner_faction_id === B.id && wreck.hp_max > 100 && wreck.fuel === 300 && JSON.parse(wreck.parts_json).length > 0,
  JSON.stringify(wreck && { owner: wreck.owner_faction_id, hp: wreck.hp_max, fuel: wreck.fuel, parts: wreck.parts_json }));
const body1 = await one('SELECT secret_revealed AS r, secret_discovered_by_faction_id AS by FROM game_bodies WHERE id = ?', wreckW.id);
const news = await one(`SELECT payload, visibility FROM chronicle_entries WHERE game_id = ? AND kind = 'secret_discovered' AND body_id = ?`, G, wreckW.id);
check('...the world is revealed as theirs and the find is public news',
  body1.r === 1 && body1.by === B.id && news?.visibility === 'public' && /derelict destroyer/.test(JSON.parse(news.payload).message),
  JSON.stringify({ body1, news }));
check('...and claiming again mints nothing more',
  (await answer(B.user_id, wreckW, 'claim')).status === 409 && (await destroyersAt(wreckW)) === 1);

// ---- 5 + 4. the capital ship, unanswered: claimed for its finder ----------
await park(C, capW, 1);
await room.resolveSecretReveal(G, 110);
const oc = await offerOf(capW, C);
const capKind = ancientCapitalKind(G, capW.id);
check('the capital ship waits as an offer, naming its class',
  oc?.status === 'pending' && oc.kind === 'ancient_capital' && oc.capital_kind === capKind, JSON.stringify(oc));
await settleExpiredOffers(env, G, 110 + OFFER_TICKS - 1);
check('...still waiting the tick before its deadline', (await offerOf(capW, C)).status === 'pending');
await settleExpiredOffers(env, G, 110 + OFFER_TICKS);
const relic = await one(`SELECT owner_faction_id, ship_class, name FROM game_ships WHERE id = ?`, `${capW.id}_relic`);
check(`...unanswered at the deadline it is claimed for its finder (${capKind})`,
  (await offerOf(capW, C)).status === 'claimed' && relic?.owner_faction_id === C.id && relic.ship_class === capKind,
  JSON.stringify(relic));

// ---- 4b. an eliminated finder's offer lapses back to the world ------------
const G2wreck = (await DB.prepare(
  `SELECT id, name FROM game_bodies WHERE game_id = ? AND owner_faction_id IS NULL AND secret_kind IS NULL
      AND type IN ('moon','dwarf') ORDER BY id DESC LIMIT 1`).bind(G).first());
await DB.prepare(`UPDATE game_bodies SET secret_kind = 'derelict_warship', secret_revealed = 0 WHERE id = ?`).bind(G2wreck.id).run();
const ghost = await park(A, G2wreck, 1);
await room.resolveSecretReveal(G, 120);
check('a third find is offered', (await offerOf(G2wreck, A))?.status === 'pending');
await DB.prepare(`UPDATE game_factions SET status = 'eliminated' WHERE id = ?`).bind(A.id).run();
await DB.prepare(`UPDATE game_ships SET status = 'destroyed' WHERE id = ?`).bind(ghost).run();
await settleExpiredOffers(env, G, 120 + OFFER_TICKS);
check('...its finder eliminated, it lapses: nothing minted, the world still hidden',
  (await offerOf(G2wreck, A)).status === 'lapsed' && (await destroyersAt(G2wreck)) === 0
  && (await one('SELECT secret_revealed AS r FROM game_bodies WHERE id = ?', G2wreck.id)).r === 0);
check('...and an eliminated empire cannot answer anything',
  (await answer(A.user_id, G2wreck, 'claim')).status === 409);

console.log(bad === 0 ? '\nALL DISCOVERY OFFER CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
