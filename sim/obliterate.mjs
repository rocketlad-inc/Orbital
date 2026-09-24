// ============================================================================
// sim/obliterate.mjs -- the Mega Destroyer's two strikes (0141).
//
// A LIVING world is sterilised; a RAW one is destroyed outright and left as
// a debris field that stays on the map but stops counting as a world. So a
// terraformed world takes two strikes and a raw one takes one (Lorne).
//
// Real seeding, real strike endpoint, real ticks. Checks:
//   - a raw world goes in one strike: debris field, claim gone, settlements
//     dead, still on the map, moons still orbit it, parked ships untouched
//   - a living world is sterilised first and obliterated on the second shot
//   - the strike fires what was ORDERED or stands down (incl. pre-0141 hulls)
//   - stars and debris fields are refused; nothing can be settled on rubble
//   - EVERY world count drops it: the domination check, the standings, the
//     senate -- and obliteration really does lower the domination goalpost
//
//   node sim/obliterate.mjs
// ============================================================================

import fs from 'fs';
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
const G = 'gobliterate1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Obl','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','obl-seed',100,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'venus')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
const [A, B] = (await DB.prepare(
  `SELECT id, user_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
const { SHIP_COMBAT_STATS, routes: factionRoutes } = factions;
const actions = await import('../worker/actions.js');
const { MEGA_STRIKE_CHARGE_TICKS, commitSettlement } = actions;
const { voteWeightDetail } = await import('../worker/senate.js');

const bid = (t) => `${G}:${t}`;
const body = async (t) => DB.prepare(
  `SELECT id, name, type, owner_faction_id, terraformed_at_tick, sterilised_at_tick,
          obliterated_at_tick, destroyed_at_tick, parent_body_id, radius
     FROM game_bodies WHERE id = ?`).bind(bid(t)).first();

// ---- room + helpers ---------------------------------------------------------
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
async function park(owner, bodyId, cls) {
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
async function call(table, method, path, userId, payload = {}) {
  for (const r of table) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const res = await r.handle({ json: async () => payload, headers: new Map() }, env,
      { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }
  throw new Error(`no route ${method} ${path}`);
}
const strike = (userId, shipId, payload = {}) =>
  call(actions.routes, 'POST', `/api/games/${G}/ships/${shipId}/strike`, userId, payload);
const standings = async () => {
  const r = await call(factionRoutes, 'GET', `/api/games/${G}/factions`, 'uA');
  const list = Array.isArray(r.body) ? r.body : (r.body.factions ?? []);
  const f = list.find(x => x.id === A.id);
  return { bodies: f?.bodies_total, systems: f?.systems_total };
};
async function chargeAndFire() {
  for (let i = 0; i < MEGA_STRIKE_CHARGE_TICKS; i++) await runTick();
}
const chronicle = async (kind) => (await DB.prepare(
  `SELECT body_id, payload FROM chronicle_entries WHERE game_id = ? AND kind = ?`).bind(G, kind).all()).results;
const aliveSettlements = async (t) => Number((await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_settlements WHERE body_id = ? AND destroyed_at_tick IS NULL`)
  .bind(bid(t)).first()).n);
const marsSystem = async (fid) => {
  const d = await voteWeightDetail(env, G, fid);
  const all = [...(d.controlled ?? []), ...(d.contesting ?? [])];
  return all.find(s => /mars/i.test(s.label));
};

// ===== 1. A RAW WORLD GOES IN ONE STRIKE ===================================
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = NULL WHERE id = ?').bind(bid('mars')).run();
const mars0 = await body('mars');
const marsRes = await commitSettlement(env, {
  gameId: G, bodyId: bid('mars'), factionId: B.id, type: 'station', name: 'Mars Stn',
  tick, bodyRadius: mars0.radius, bodyName: mars0.name,
});
await factions.recomputeBodyOwnership(DB, G, bid('mars'));
// A holds Phobos, so the Mars system appears in A's senate breakdown
// before AND after (a faction with no ground in a system is not listed).
const phobos0 = await body('phobos');
const phobosRes = await commitSettlement(env, {
  gameId: G, bodyId: bid('phobos'), factionId: A.id, type: 'station', name: 'Phobos Stn',
  tick, bodyRadius: phobos0.radius, bodyName: phobos0.name,
});
await factions.recomputeBodyOwnership(DB, G, bid('phobos'));
check('setup: A holds Phobos', phobosRes.ok && (await body('phobos')).owner_faction_id === A.id,
  JSON.stringify(phobosRes));
check('setup: B holds raw Mars with a station', marsRes.ok && (await body('mars')).owner_faction_id === B.id,
  JSON.stringify(marsRes));
const before = await standings();
const marsSysBefore = await marsSystem(A.id);

const megaA = await park(A.id, bid('mars'), 'mega_destroyer');
const bystander = await park(B.id, bid('mars'), 'destroyer');
const r1 = await strike('uA', megaA);
check('striking a raw world charges an OBLITERATION', r1.status === 200 && r1.body.mode === 'obliterate',
  JSON.stringify(r1));
const charging = (await chronicle('mega_strike_charging')).map(c => JSON.parse(c.payload));
check('...and the public warning says so', charging.some(p => p.mode === 'obliterate'), JSON.stringify(charging));
await chargeAndFire();

const mars1 = await body('mars');
check('Mars is a debris field', mars1.obliterated_at_tick != null, JSON.stringify(mars1));
check('...STILL ON THE MAP: not retired, same type', mars1.destroyed_at_tick == null && mars1.type === mars0.type,
  JSON.stringify(mars1));
check('...its claim is gone', mars1.owner_faction_id == null);
check('...every settlement on it is dead', (await aliveSettlements('mars')) === 0);
const phobos = await body('phobos');
check('...its moons still orbit it', !!phobos && phobos.parent_body_id === bid('mars') && phobos.destroyed_at_tick == null,
  JSON.stringify(phobos));
const shipsAt = (await DB.prepare(
  `SELECT id, status, parent_body_id FROM game_ships WHERE id IN (?, ?)`).bind(megaA, bystander).all()).results;
check('...and the ships parked on it are untouched, still orbiting it',
  shipsAt.length === 2 && shipsAt.every(s => s.status === 'active' && s.parent_body_id === bid('mars')),
  JSON.stringify(shipsAt));
const obl = await chronicle('world_obliterated');
check('the chronicle records a world_obliterated, naming the world',
  obl.length === 1 && JSON.parse(obl[0].payload).body_name === mars0.name, JSON.stringify(obl));

const after = await standings();
check('STANDINGS: the world total drops by exactly one', after.bodies === before.bodies - 1,
  `${before.bodies} -> ${after.bodies}`);
check('...but the system survives (its moons still hold it)', after.systems === before.systems,
  `${before.systems} -> ${after.systems}`);
const marsSysAfter = await marsSystem(A.id);
check('SENATE: the Mars system counts one world fewer, and is still one system',
  !!marsSysBefore && !!marsSysAfter && marsSysAfter.total === marsSysBefore.total - 1,
  `${JSON.stringify(marsSysBefore)} -> ${JSON.stringify(marsSysAfter)}`);

// ===== 2. NOTHING MORE HAPPENS TO RUBBLE ====================================
const again = await strike('uA', megaA);
check('a debris field cannot be struck again', again.status === 409 && again.body.error?.code === 'already_rubble',
  JSON.stringify(again));
const resettle = await commitSettlement(env, {
  gameId: G, bodyId: bid('mars'), factionId: A.id, type: 'station', name: 'Squatter',
  tick, bodyRadius: mars0.radius, bodyName: mars0.name,
});
check('nothing can be settled on it (commitSettlement refuses)', !resettle.ok && resettle.code === 'debris_field',
  JSON.stringify(resettle));
await runTick();
check('...and it stays unowned through a tick', (await body('mars')).owner_faction_id == null);

// ===== 3. A LIVING WORLD TAKES TWO ==========================================
const ven0 = await body('venus');
check('setup: Venus (B capital) is living and held', ven0.terraformed_at_tick != null && ven0.owner_faction_id === B.id,
  JSON.stringify(ven0));
const megaV = await park(A.id, bid('venus'), 'mega_destroyer');
const s1 = await strike('uA', megaV);
check('striking a living world charges a STERILISATION', s1.status === 200 && s1.body.mode === 'sterilise',
  JSON.stringify(s1));
await chargeAndFire();
const ven1 = await body('venus');
check('...first shot strips the biosphere but leaves the world',
  ven1.terraformed_at_tick == null && ven1.sterilised_at_tick != null && ven1.obliterated_at_tick == null,
  JSON.stringify(ven1));
check('...and kills its settlements', (await aliveSettlements('venus')) === 0);
const ster = (await chronicle('terraform_destroyed')).map(c => JSON.parse(c.payload));
check('...its chronicle names the world (body_name), so it no longer reads "a living world"',
  ster.some(p => p.cause === 'mega_destroyer' && p.body_name === ven0.name), JSON.stringify(ster));
const s2 = await strike('uA', megaV);
check('the second strike on the now-raw world charges an obliteration', s2.status === 200 && s2.body.mode === 'obliterate',
  JSON.stringify(s2));
await chargeAndFire();
check('...and the second shot destroys it', (await body('venus')).obliterated_at_tick != null);

// ===== 4. IT FIRES WHAT WAS ORDERED, OR NOTHING ==============================
const megaE = await park(A.id, bid('earth'), 'mega_destroyer');
const ownNo = await strike('uA', megaE);
check('your own world needs confirm_own', ownNo.status === 409 && ownNo.body.error?.code === 'own_world',
  JSON.stringify(ownNo));
const e1 = await strike('uA', megaE, { confirm_own: true });
check('a sterilise is ordered on living Earth', e1.body.mode === 'sterilise', JSON.stringify(e1));
// Somebody else strips it mid-charge: the world is raw when the gun fires.
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = NULL WHERE id = ?').bind(bid('earth')).run();
await chargeAndFire();
const earth1 = await body('earth');
const eShip = await DB.prepare('SELECT strike_ready_tick FROM game_ships WHERE id = ?').bind(megaE).first();
check('a hull ordered to STERILISE does not obliterate a world that went raw under it',
  earth1.obliterated_at_tick == null && eShip.strike_ready_tick == null, JSON.stringify({ earth1, eShip }));
check('...it stands down entirely: the settlements on Earth are still alive',
  (await aliveSettlements('earth')) > 0 && earth1.sterilised_at_tick == null, JSON.stringify(earth1));

// The dangerous direction: an OBLITERATION ordered on a raw world that is
// terraformed during the charge. Firing anyway would kill a living world
// in one shot, which is the one thing the two-strike rule exists to stop.
const megaJ = await park(A.id, bid('juno'), 'mega_destroyer');
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = NULL WHERE id = ?').bind(bid('juno')).run();
const j1 = await strike('uA', megaJ, { confirm_own: true });
check('an obliteration is ordered on raw Juno', j1.body.mode === 'obliterate', JSON.stringify(j1));
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = ? WHERE id = ?').bind(tick, bid('juno')).run();
await chargeAndFire();
const juno1 = await body('juno');
check('...Juno comes alive under the charge, and the gun does NOT destroy a living world in one shot',
  juno1.obliterated_at_tick == null && juno1.terraformed_at_tick != null, JSON.stringify(juno1));

// A hull armed before 0141 (no strike_mode) could only ever have meant sterilise.
const megaL = await park(A.id, bid('ceres'), 'mega_destroyer');
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = NULL WHERE id = ?').bind(bid('ceres')).run();
await DB.prepare('UPDATE game_ships SET strike_target_body_id = ?, strike_ready_tick = ?, strike_mode = NULL WHERE id = ?')
  .bind(bid('ceres'), tick + 1, megaL).run();
await runTick(); await runTick();
check('a pre-0141 armed hull over a raw world stands down instead of obliterating it',
  (await body('ceres')).obliterated_at_tick == null);

// Stand down: the all-clear is written now (it read a column it never selected).
const megaS = await park(A.id, bid('vesta'), 'mega_destroyer');
await strike('uA', megaS);
const down = await strike('uA', megaS, { cancel: true });
check('standing down works', down.status === 200 && down.body.charging === false, JSON.stringify(down));
check('...and the public all-clear is written', (await chronicle('mega_strike_aborted')).length >= 1);

// ===== 5. NOT A WORLD, NOT A TARGET =========================================
const megaSun = await park(A.id, bid('sol'), 'mega_destroyer');
const sun = await strike('uA', megaSun);
check('the Sun is refused (it is raw, but it is not a world)',
  sun.status === 409 && sun.body.error?.code === 'not_a_world', JSON.stringify(sun));
check('...and is not destroyed', (await DB.prepare('SELECT obliterated_at_tick AS o FROM game_bodies WHERE id = ?')
  .bind(bid('sol')).first()).o == null);

// ===== 6. OBLITERATION LOWERS THE DOMINATION GOALPOST ========================
// Hand A exactly the largest share that does NOT win (n > 0.6 x total is the
// rule), then destroy the fewest worlds A does not hold that make the same
// n a win. (One is not always enough: at 58 worlds, 34 loses at 58 and at
// 57 alike, since the goalpost moves 0.6 of a world per obliteration.)
const worlds = (await DB.prepare(
  `SELECT id, type FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL
      AND obliterated_at_tick IS NULL AND type NOT IN ('meteoroid','lagrange','megastructure')
    ORDER BY id`).bind(G).all()).results;
const N = worlds.length;
const k = Math.floor(0.6 * N);
let d = 1;
while (!(k > 0.6 * (N - d))) d++;
check(`setup: holding ${k} of ${N} does not win, and ${k} of ${N - d} would (${d} destroyed)`,
  !(k > 0.6 * N) && k > 0.6 * (N - d) && d <= 3);
await DB.prepare('UPDATE game_bodies SET owner_faction_id = NULL WHERE game_id = ?').bind(G).run();
const mine = worlds.filter(w => w.type !== 'star').slice(0, k);
for (const w of mine) {
  await DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(A.id, w.id).run();
}
const pre = await room.checkVictory(G);
check('before: no domination win', !pre || pre.victoryType !== 'domination', JSON.stringify(pre));
const victims = worlds.filter(w => w.type !== 'star' && !mine.includes(w)).slice(0, d);
for (const [i, v] of victims.entries()) {
  if (i === victims.length - 1) {
    const mid = await room.checkVictory(G);
    check(`...still no win with ${d - 1} destroyed`, !mid || mid.victoryType !== 'domination', JSON.stringify(mid));
  }
  await room.obliterateWorld(G, tick, { id: megaA, name: 'x', owner_faction_id: A.id },
    { id: v.id, name: v.id, owner_faction_id: null });
}
const post = await room.checkVictory(G);
check(`after ${d} worlds are destroyed, the same holding WINS by domination`,
  post?.victoryType === 'domination' && post?.winnerFactionId === A.id, JSON.stringify(post));

// ===== 7. NO WORLD COUNT FORGETS THE COLUMN ==================================
// Every query that counts worlds by excluding NON_WORLD_TYPES must also
// exclude debris fields. A count that forgot would keep counting rubble
// silently -- the exact shape of the far-gate twin bug.
const offenders = [];
const dir = new URL('../worker/', import.meta.url);
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith('.js') || file.startsWith('_')) continue;
  const src = fs.readFileSync(new URL(file, dir), 'utf8');
  for (const m of src.matchAll(/`[^`]*NOT IN \(\$\{[^`]*`/g)) {
    if (!/NON_WORLD_TYPES|marks/.test(m[0])) continue;
    if (!/obliterated_at_tick IS NULL/.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}
check('every NON_WORLD_TYPES count also excludes obliterated worlds', offenders.length === 0,
  offenders.join('\n        '));

console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nALL OBLITERATION CHECKS PASS');
process.exit(bad ? 1 : 0);
