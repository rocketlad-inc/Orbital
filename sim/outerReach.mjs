// ============================================================================
// sim/outerReach.mjs — the outer-reach discoveries, end to end.
//
// Drives the REAL seeder, the REAL tick and the REAL SEIZE endpoint against
// real SQLite. Every fixture is a state the game can reach: the secrets are
// wherever seedGameWorld put them, and a ship "finds" one the only way a
// ship can, by being parked at that world when a tick runs.
//
// What this holds:
//   - the five new secrets land in their own bands, hidden (nothing spawned)
//   - the ancient WEAPONS STATION fires on a hull nobody is at war with
//   - an ancient structure is besieged by ANY armed hull parked on it —
//     the thing that used to make capture impossible ("nobody to be
//     hostile to") — breaches, and is taken with the ordinary SEIZE
//   - once taken it is an ordinary structure: flag cleared, guns quiet
//   - the RELAY is taken the same way
//   - the derelict CAPITAL is a real capital hull, not typed-in numbers
//   - the DEEP CACHE pays ten destroyers
//   - the FAR GATE is a linked, unowned pair between two outer worlds
//   - and the control: the neutral gates stay untakeable and unbesieged
//
//   node sim/outerReach.mjs
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
const G = 'gouterreach1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Outer','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','outer-seed',100,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'venus')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
const [A, B] = (await DB.prepare(
  `SELECT id, user_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
// Start from a clean board: the starter fleets would otherwise sit at the
// capitals and muddy every count below.
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();

const { SHIP_COMBAT_STATS } = factions;
const { HULL_COST } = await import('../worker/shipDesigns.js');
const { MEGA_MAX_HP, MEGA_BREACH_HP } = await import('../worker/megastructures.js');

// ---- where the seeder put things ------------------------------------------
const secrets = (await DB.prepare(
  `SELECT id, template_id, name, secret_kind FROM game_bodies
    WHERE game_id = ? AND secret_kind IS NOT NULL`).bind(G).all()).results;
const at = (kind) => secrets.find(s => s.secret_kind === kind);
const FAR = new Set(['makemake', 'varda', 'aya', 'eris', 'sedna']);
const PLUT = new Set(['pluto', 'orcus', 'ixion']);
const KUIPER = new Set(['haumea', 'quaoar', 'mani', 'salacia', 'varuna']);
const OUTER = new Set([...FAR, ...PLUT, ...KUIPER]);

for (const k of ['ancient_capital', 'ancient_relay', 'ancient_station']) {
  check(`${k} is seeded in the Far Reach`, !!at(k) && FAR.has(at(k).template_id), at(k)?.template_id);
}
check('far_gate is seeded in an outer band', !!at('far_gate') && OUTER.has(at('far_gate').template_id),
  at('far_gate')?.template_id);
check('deep_cache is seeded in the Kuiper Belt or the Plutinos',
  !!at('deep_cache') && (KUIPER.has(at('deep_cache').template_id) || PLUT.has(at('deep_cache').template_id)),
  at('deep_cache')?.template_id);
check('the older secrets no longer land past Neptune',
  secrets.filter(s => !['ancient_capital', 'ancient_relay', 'ancient_station', 'far_gate', 'deep_cache']
    .includes(s.secret_kind)).every(s => !OUTER.has(s.template_id)),
  secrets.filter(s => OUTER.has(s.template_id)).map(s => `${s.secret_kind}@${s.template_id}`).join(' '));

const structures = async () => (await DB.prepare(
  `SELECT m.body_id, m.kind, m.hp, m.ancient, m.partner_body_id, b.owner_faction_id, b.parent_body_id
     FROM game_megastructures m JOIN game_bodies b ON b.id = m.body_id
    WHERE m.game_id = ?`).bind(G).all()).results;
check('HIDDEN: nothing out there exists until it is found', (await structures()).length === 0,
  JSON.stringify(await structures()));

// ---- the room ---------------------------------------------------------------
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
const hpOf = async (id) => Number((await DB.prepare('SELECT hp FROM game_ships WHERE id = ?').bind(id).first())?.hp);

const { routes } = await import('../worker/actions.js');
async function seize(userId, siteId, mode = 'capture') {
  // Raw id: the route pattern accepts ':' and the handler reads the
  // param as-is, so encoding it here only tested the harness.
  const path = `/api/games/${G}/megastructures/${siteId}/seize`;
  for (const r of routes) {
    if (r.method !== 'POST') continue;
    const m = typeof r.pattern === 'string' ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const res = await r.handle({ json: async () => ({ mode }), headers: new Map() }, env,
      { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } });
    return JSON.parse(await res.text());
  }
  throw new Error('no seize route');
}

// Everyone at peace — the default. The station must not need a war.
const wars = await DB.prepare(`SELECT count(*) AS n FROM game_wars WHERE game_id = ?`).bind(G).first();
check('no war is declared anywhere (peace is the default)', Number(wars?.n ?? 0) === 0);

// ===== ANCIENT WEAPONS STATION ===============================================
// Two witnesses parked at the world it is found on: one of the attacker's,
// and one of a faction at peace with everybody. The SAME two ships, in the
// same range, are measured before and after capture — so every "it does /
// it does not fire" below can actually fail.
const stationWorld = at('ancient_station').id;
const scout = await park(A.id, stationWorld);
const bShip = await park(B.id, stationWorld);
await runTick();
let stn = (await structures()).find(s => s.kind === 'weapons_station');
check('the station appears once a ship finds it', !!stn);
// It wakes firing, in the tick it is found, so it has already drawn the
// finders' return fire: full health less at most a volley or two.
check('...ownerless, flagged ancient, born at full health',
  !!stn && !stn.owner_faction_id && Number(stn.ancient) === 1
    && Number(stn.hp) > MEGA_MAX_HP - 2 * SHIP_COMBAT_STATS.destroyer.damage_per_tick,
  JSON.stringify(stn));
check('...orbiting the world it was found at', stn?.parent_body_id === stationWorld);

// ONE roll per station per tick decides whether every shot it takes that
// tick lands, keyed to its (random) id — so a single tick is a coin flip.
// Watch a window instead: hostile means it lands within it; owned-and-at-
// peace (below) means it never lands across the same window.
const WINDOW = 10;
async function hitsOver(ticks, ids) {
  const start = await Promise.all(ids.map(hpOf));
  for (let i = 0; i < ticks; i++) await runTick();
  const end = await Promise.all(ids.map(hpOf));
  return ids.map((_, i) => start[i] - end[i]);
}
const [aLoss, bLoss] = await hitsOver(WINDOW, [scout, bShip]);
check('HOSTILE TO ALL: it fires on the finder', aLoss > 0, `lost ${aLoss} over ${WINDOW} ticks`);
check('...and on a faction nobody is at war with', bLoss > 0, `lost ${bLoss} over ${WINDOW} ticks`);

// Siege it: armed hulls parked ON the structure.
const squad = [];
for (let i = 0; i < 8; i++) squad.push(await park(A.id, stn.body_id));
const stnHpStart = Number((await structures()).find(s => s.body_id === stn.body_id).hp);
await runTick();
const stnHp1 = Number((await structures()).find(s => s.body_id === stn.body_id).hp);
check('BESIEGED by any armed hull parked on it — no war needed', stnHp1 < stnHpStart,
  `${stnHpStart} -> ${stnHp1}`);

const early = await seize(A.user_id, stn.body_id);
check('SEIZE refuses while it is still above the breach line', early?.error?.code === 'not_breached',
  JSON.stringify(early).slice(0, 160));

let guard = 0;
while (Number((await structures()).find(s => s.body_id === stn.body_id).hp) > MEGA_BREACH_HP && guard++ < 40) {
  await runTick();
}
const breachedHp = Number((await structures()).find(s => s.body_id === stn.body_id).hp);
check('...and breaches under sustained siege', breachedHp <= MEGA_BREACH_HP, `hp ${breachedHp} after ${guard} ticks`);

// One hull stays aboard to take it (SEIZE needs force present); the rest
// fly home. Flown, not deleted: combat has written history that names
// these hulls, and those rows pin them, as they do in production.
const home = squad.slice(1);
await DB.prepare(`UPDATE game_ships SET parent_body_id = ? WHERE id IN (${home.map(() => '?').join(',')})`)
  .bind(`${G}:earth`, ...home).run();

const taken = await seize(A.user_id, stn.body_id);
check('SEIZE takes an ancient station once breached', taken?.ok === true && taken?.mode === 'capture',
  JSON.stringify(taken).slice(0, 200));
stn = (await structures()).find(s => s.body_id === stn.body_id);
check('...it is theirs now', stn?.owner_faction_id === A.id, JSON.stringify(stn));
check('...and ordinary: the ancient flag is cleared', Number(stn?.ancient) === 0);

// Let it repair back over the breach line: a breached station is offline
// by design, and an offline one "sparing" anybody would prove nothing.
// A siege can drive it to 0, and it climbs back at MEGA_REGEN_PER_TICK:
// from 0 that is ~50 ticks, so the cap has to allow for it.
guard = 0;
while (Number((await structures()).find(s => s.body_id === stn.body_id).hp) <= MEGA_BREACH_HP && guard++ < 80) {
  await runTick();
}
const liveHp = Number((await structures()).find(s => s.body_id === stn.body_id).hp);
check('...it repairs back into service under its new owner', liveHp > MEGA_BREACH_HP,
  `hp ${liveHp} after ${guard} ticks`);

const [aAfter, bAfter] = await hitsOver(WINDOW, [scout, bShip]);
check('...operational again, its guns spare their owner', aAfter <= 0, `lost ${aAfter} over ${WINDOW} ticks`);
check('...and spare the faction it fired on before, now that its owner is at peace with them',
  bAfter <= 0, `lost ${bAfter} over ${WINDOW} ticks`);

// ===== ANCIENT RELAY ==========================================================
const relayWorld = at('ancient_relay').id;
await park(B.id, relayWorld, 'frigate');
await runTick();
let relay = (await structures()).find(s => s.kind === 'deep_array');
check('the relay appears once a ship finds it, ownerless and ancient',
  !!relay && !relay.owner_faction_id && Number(relay.ancient) === 1, JSON.stringify(relay));
for (let i = 0; i < 8; i++) await park(B.id, relay.body_id);
guard = 0;
while (Number((await structures()).find(s => s.body_id === relay.body_id).hp) > MEGA_BREACH_HP && guard++ < 40) {
  await runTick();
}
const relayTaken = await seize(B.user_id, relay.body_id);
relay = (await structures()).find(s => s.body_id === relay.body_id);
check('the relay is taken with the same breach-and-SEIZE rule',
  relayTaken?.ok === true && relay?.owner_faction_id === B.id && Number(relay?.ancient) === 0,
  JSON.stringify(relayTaken).slice(0, 160));

// ===== DERELICT CAPITAL ======================================================
const capWorld = at('ancient_capital').id;
await park(A.id, capWorld, 'corvette');
await runTick();
const relic = await DB.prepare(
  `SELECT ship_class, owner_faction_id, hp_max, damage_per_tick, parent_body_id FROM game_ships
    WHERE game_id = ? AND id = ?`).bind(G, `${capWorld}_relic`).first();
check('the derelict capital is claimed by its finder',
  !!relic && relic.owner_faction_id === A.id && relic.parent_body_id === capWorld, JSON.stringify(relic));
check('...and is a Mega Destroyer or a Mobile Foundry',
  relic && ['mega_destroyer', 'mobile_foundry'].includes(relic.ship_class), relic?.ship_class);
check('...with the REAL class stats, not typed-in numbers',
  relic && Number(relic.hp_max) === SHIP_COMBAT_STATS[relic.ship_class].hp
    && Number(relic.damage_per_tick) === SHIP_COMBAT_STATS[relic.ship_class].damage_per_tick,
  JSON.stringify(relic));
await runTick();
const relics = (await DB.prepare(`SELECT count(*) AS n FROM game_ships WHERE id = ?`)
  .bind(`${capWorld}_relic`).first()).n;
check('...and only ever one of it', Number(relics) === 1, String(relics));

// ===== DEEP CACHE ============================================================
const cacheWorld = at('deep_cache').id;
const purse0 = await DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(B.id).first();
await park(B.id, cacheWorld, 'corvette');
await runTick();
const purse1 = await DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(B.id).first();
// The amount is read off the chronicle (what the reveal granted), and the
// purse checked to have actually received it. Not an exact purse delta:
// that tick's upkeep and income land in the same pass.
const cacheEntry = (await DB.prepare(
  `SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'secret_discovered' AND body_id = ?`)
  .bind(G, cacheWorld).first());
const cacheP = cacheEntry ? JSON.parse(cacheEntry.payload) : {};
const wantMetal = 10 * HULL_COST.destroyer.metal;
const wantGold = 10 * HULL_COST.destroyer.gold;
check('the deep cache grants ten destroyers of metal and credits',
  cacheP.metal === wantMetal && cacheP.credits === wantGold, JSON.stringify(cacheP));
const gotMetal = Number(purse1.metal) - Number(purse0.metal);
const gotGold = Number(purse1.gold) - Number(purse0.gold);
check('...and the purse actually received it',
  gotMetal > wantMetal * 0.98 && gotGold > wantGold * 0.98, `metal +${gotMetal}, credits +${gotGold}`);

// ===== FAR GATE PAIR =========================================================
const gateWorld = at('far_gate').id;
await park(A.id, gateWorld, 'corvette');
await runTick();
const gates = (await structures()).filter(s => s.kind === 'warp_gate');
const hostGate = gates.find(g => g.parent_body_id === gateWorld);
const twinGate = hostGate && gates.find(g => g.body_id === hostGate.partner_body_id);
check('the far gate stands up a pair', !!hostGate && !!twinGate, JSON.stringify(gates));
const twinWorld = twinGate && await DB.prepare('SELECT template_id FROM game_bodies WHERE id = ?')
  .bind(twinGate.parent_body_id).first();
check('...its twin orbits ANOTHER outer world, not the Sun',
  !!twinWorld && OUTER.has(twinWorld.template_id) && twinGate.parent_body_id !== gateWorld,
  twinWorld?.template_id);
check('...the two ends are linked both ways',
  !!twinGate && twinGate.partner_body_id === hostGate.body_id);
check('...and nobody owns either end',
  !!hostGate && !hostGate.owner_faction_id && !twinGate.owner_faction_id);

// ===== CONTROL: neutral gates stay neutral ===================================
for (let i = 0; i < 8; i++) await park(A.id, hostGate.body_id);
const gHp0 = Number(hostGate.hp);
await runTick();
const gHp1 = Number((await structures()).find(s => s.body_id === hostGate.body_id).hp);
check('CONTROL: a neutral gate is NOT besieged by parked warships', gHp1 >= gHp0, `${gHp0} -> ${gHp1}`);
const gateSeize = await seize(A.user_id, hostGate.body_id);
check('CONTROL: a neutral gate still cannot be taken', gateSeize?.error?.code === 'ancient',
  JSON.stringify(gateSeize).slice(0, 160));

// ===== the chronicle says what happened ======================================
const chron = (await DB.prepare(
  `SELECT payload FROM chronicle_entries WHERE game_id = ? AND kind = 'secret_discovered'`).bind(G).all()).results
  .map(r => JSON.parse(r.payload));
for (const k of ['ancient_station', 'ancient_relay', 'ancient_capital', 'deep_cache', 'far_gate']) {
  const e = chron.find(c => c.kind === k);
  // The reveal's default is `${name}: DISCOVERY — ${kind with spaces}`;
  // a kind with no case of its own would leave exactly that.
  const generic = e ? `${e.body_name}: DISCOVERY — ${k.replace(/_/g, ' ')}` : null;
  check(`chronicle records the ${k} discovery with its own message`,
    !!e && typeof e.message === 'string' && e.message !== generic, e?.message);
}

console.log(bad === 0 ? '\nALL OUTER REACH CHECKS PASS' : `\n${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
