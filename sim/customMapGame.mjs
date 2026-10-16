// ============================================================
// CUSTOM MAPS, PLAYED LONG (2026-10-15). The four-agent staging playtest
// found that Map Maker games never got capital cities, a bug no earlier
// check reached because nothing PLAYED a custom map. This runs several
// very different maps for hundreds of ticks on the real server code
// (sim/headless.mjs runGame: the real seeder, the real resolveTick, the
// scripted bots acting through the real handlers), with a Sol game as
// the control, and checks the rules hold the whole way.
//
// Run: node sim/customMapGame.mjs [ticks]
// ============================================================

import { runGame } from './headless.mjs';
import { normalizeMap, generateMap, checkMap } from '../src/game/customMap.js';
import { voteWeights } from '../worker/systems.js';

const TICKS = Number(process.argv[2] ?? 400);
let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

// Every server-side console.error during a run is a finding: the tick
// swallows and logs most failures rather than throwing, so a game can
// "run" while half its passes are failing.
const errs = [];
const origError = console.error;
console.error = (...a) => { errs.push(a.map(x => (x instanceof Error ? x.stack || x.message : String(x))).join(' ').slice(0, 400)); };

// ---- the maps -----------------------------------------------------------------
const D = Math.PI / 180;
function crown() {
  const B = []; let n = 0;
  const add = (b) => { const x = { id: `q${(n++).toString(36)}`, rings: false, start: false, secret: null, ...b }; B.push(x); return x; };
  add({ name: 'Aurel', type: 'terrestrial', parent: 'sun', orbit: 230, angle: 0, radius: 3.2, yields: { metal: 9, credits: 9, science: 6 }, surface: 'desert',
    secret: 'ancient_capital', secretName: 'The Throne Hulk', secretText: 'A capital ship older than any empire.', lore: 'The jewel.' });
  add({ name: 'Ferrum', type: 'terrestrial', parent: 'sun', orbit: 230, angle: Math.PI, radius: 3, yields: { metal: 12, credits: 4, science: 4 },
    secret: 'resource_cache', secretName: 'The Vault', secretText: 'Crates of ore.' });
  for (let k = 0; k < 4; k++) {
    const h = add({ name: `Home${k}`, type: 'terrestrial', parent: 'sun', orbit: 540, angle: (45 + 90 * k) * D, radius: 3.4, yields: { metal: 5, credits: 5, science: 5 }, surface: 'verdant', start: true });
    for (let m = 0; m < 2; m++) add({ name: `Home${k}-${m}`, type: 'moon', parent: h.id, orbit: 22 + m * 14, angle: m * 2.5, radius: 1.2, yields: { metal: 3, credits: 1, science: 2 }, secret: m ? 'random' : null });
  }
  for (let k = 0; k < 10; k++) add({ name: `Shard${k}`, type: 'asteroid', parent: 'sun', orbit: 900, angle: (k / 10) * 2 * Math.PI, radius: 0.7, yields: { metal: 4, credits: 0, science: 0 } });
  for (let k = 0; k < 4; k++) add({ name: `Dwarf${k}`, type: 'dwarf', parent: 'sun', orbit: 1350, angle: (90 * k) * D, radius: 1.8, yields: { metal: 4, credits: 3, science: 4 }, secret: 'random' });
  for (let k = 0; k < 3; k++) add({ name: `Rock${k}`, type: 'rock', parent: 'sun', orbit: 700 + k * 40, angle: k, mineral: { kind: k ? 'metal' : 'gold', tons: 1500 } });
  add({ name: 'Colossus', type: 'gas-giant', parent: 'sun', orbit: 2400, angle: 1, radius: 9, yields: { metal: 2, credits: 10, science: 3 }, rings: true });
  return normalizeMap({
    name: 'Crown', sun: { name: 'Ardent', color: '#ffd180', size: 52, mass: 1.1 }, bodies: B,
    sectors: [
      { id: 'scrown', name: 'The Crown', color: '#ffb84d', inner: 120, outer: 380 },
      { id: 'shomes', name: 'Houses', color: '#4ecdc4', inner: 380, outer: 760 },
      { id: 'souter', name: 'Outer', color: '#b98cff', inner: 760, outer: 4000 },
    ],
  });
}
/** Two start worlds and almost nothing else: the smallest legal map. */
function tiny() {
  return normalizeMap({
    name: 'Duel', sun: { name: 'Pip', size: 30, mass: 0.4 },
    bodies: [
      { id: 'a', name: 'West', type: 'terrestrial', parent: 'sun', orbit: 60, angle: 0, start: true, yields: { metal: 3, credits: 3, science: 3 } },
      { id: 'b', name: 'East', type: 'moon', parent: 'sun', orbit: 61, angle: Math.PI, start: true, yields: { metal: 3, credits: 3, science: 3 } },
    ],
  });
}
/** As big and far-flung as the format allows: a heavy sun, 200 bodies out to 14000. */
function huge() {
  const m = generateMap({ seed: 'huge-1', planets: 14, moonsMin: 3, moonsMax: 6, belts: 3, starts: 10, spread: 1.6, richness: 2.5 });
  const far = { id: 'zfar', name: 'Farthest', type: 'dwarf', parent: 'sun', orbit: 14000, angle: 2, radius: 2, yields: { metal: 1, credits: 1, science: 1 } };
  return normalizeMap({ ...m, sun: { ...m.sun, mass: 2.5, size: 90 }, bodies: [...m.bodies, far] });
}
/** Generated with every default: what a casual maker hosts. */
function rolled() { return generateMap({ seed: 'casual-7' }); }

// ---- run each -------------------------------------------------------------------
async function play(label, map, players, doctrines) {
  errs.length = 0;
  const blockers = map ? checkMap(map).filter(i => i.level === 'block') : [];
  check(`${label}: the map is hostable`, blockers.length === 0, blockers.map(b => b.title).join('; '));
  let r;
  try {
    r = await runGame({ ticks: TICKS, players, seed: `cmg-${label}`, quiet: true, doctrines, customMap: map });
  } catch (e) {
    check(`${label}: the game runs ${TICKS} ticks`, false, e.stack?.split('\n').slice(0, 4).join(' | '));
    return null;
  }
  const { env, gameId } = r;
  const DB = env.DB;
  check(`${label}: the game runs ${TICKS} ticks`, r.ticksPlayed > 0);
  const thrown = Object.entries(r.tally).filter(([k]) => k.startsWith('bot_threw'));
  check(`${label}: no bot action threw`, thrown.length === 0, JSON.stringify(thrown).slice(0, 300));
  const errSet = [...new Set(errs.map(e => e.split('\n')[0]))];
  check(`${label}: no server errors logged`, errSet.length === 0, errSet.slice(0, 6).join('\n        '));

  const bodies = (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(gameId).all()).results;
  const ships = (await DB.prepare('SELECT * FROM game_ships WHERE game_id = ?').bind(gameId).all()).results;
  const facs = (await DB.prepare('SELECT * FROM game_factions WHERE game_id = ?').bind(gameId).all()).results;
  const cities = (await DB.prepare("SELECT * FROM game_settlements WHERE game_id = ? AND type = 'city' AND (destroyed_at_tick IS NULL)").bind(gameId).all()).results;
  const num = (v) => v == null || Number.isFinite(Number(v));
  check(`${label}: every faction's purse is a finite number`, facs.every(f => num(f.metal) && num(f.gold) && num(f.science)),
    JSON.stringify(facs.map(f => [f.metal, f.gold, f.science])));
  const badShips = ships.filter(s => ![s.orbit_rp, s.orbit_ra, s.orbit_m0, s.hp, s.fuel].every(num));
  check(`${label}: no ship has a broken orbit or NaN stats`, badShips.length === 0, `${badShips.length} ships, e.g. ${JSON.stringify(badShips[0] ?? {}).slice(0, 200)}`);
  const badBodies = bodies.filter(b => ![b.orbit_radius, b.orbit_period, b.radius].every(num));
  check(`${label}: no body has broken geometry`, badBodies.length === 0, badBodies.map(b => b.name).join(', '));
  check(`${label}: the bodies are the map's (no Sol leaked in)`, !map || bodies.every(b => b.template_id === 'sol' || String(b.template_id).startsWith('cm_')),
    bodies.filter(b => b.template_id !== 'sol' && !String(b.template_id).startsWith('cm_')).map(b => b.template_id).slice(0, 8).join(', '));
  const alive = facs.filter(f => f.status === 'active');
  check(`${label}: every living empire still has a city or a ship`, alive.every(f => cities.some(c => c.owner_faction_id === f.id) || ships.some(s => s.owner_faction_id === f.id && s.hp > 0)));
  const weights = voteWeights(bodies, facs.map(f => f.id));
  check(`${label}: senate weights are computed for everyone`, facs.every(f => Number.isInteger(weights.get?.(f.id) ?? weights[f.id])),
    JSON.stringify(weights instanceof Map ? [...weights] : weights));
  const owned = bodies.filter(b => b.owner_faction_id).length;
  const revealed = bodies.filter(b => b.secret_revealed);
  const chron = (await DB.prepare('SELECT kind, payload AS message FROM chronicle_entries WHERE game_id = ?').bind(gameId).all()).results;
  const kinds = {};
  for (const c of chron) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  const customFound = revealed.filter(b => b.secret_name);
  if (customFound.length) {
    check(`${label}: a found discovery's own name reaches the chronicle`,
      customFound.every(b => chron.some(c => String(c.message ?? '').includes(b.secret_name))),
      customFound.map(b => b.secret_name).join(', '));
  }
  console.log(`      ${label}: ${r.ticksPlayed} ticks · ${owned} worlds held · ${revealed.length} discoveries found (${customFound.length} hand-named) · ` +
    `${ships.filter(s => s.hp > 0).length} hulls alive · ${cities.length} cities · avg ${r.avgTick.toFixed(1)} ms/tick`);
  console.log(`      chronicle: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join(' ')}`);
  console.log(`      empires: ${r.factions.map(f => `${f.doctrine ?? '-'} ${f.bodies}w ${f.ships}s M${Math.round(f.metal)} S${Math.round(f.science)}`).join(' | ')}`);
  return r;
}

const DOCS = ['expander', 'rusher', 'technocrat', 'economist'];
if (!process.env.WAR_ONLY) {
await play('Sol (control)', null, 4, DOCS);
await play('Crown', crown(), 4, DOCS);
await play('Duel', tiny(), 2, ['rusher', 'expander']);
await play('Huge', huge(), 8, [...DOCS, ...DOCS]);
await play('Rolled', rolled(), 6, DOCS);
}

// ---- war on a custom map ---------------------------------------------------------
// The bots' own attacks are refused by the leg guard (their flight-time
// estimate predates it), so no run above ever fought. Force one: two
// empires on the Duel map, war declared, the attacker's hulls flown at
// the defender's capital with a legal arrival, and the ticks played on.
{
  errs.length = 0;
  const r = await runGame({ ticks: 30, players: 2, seed: 'cmg-war', quiet: true, doctrines: ['rusher', 'rusher'], customMap: tiny() });
  const { env, gameId } = r;
  const DB = env.DB;
  const actions = await import('../worker/actions.js');
  const wars = await import('../worker/wars.js');
  const { legTicks, SHIP_ENGINE_ACCEL } = await import('../worker/burn.js');
  const call = async (routes, method, marker, userId, params, body) => {
    const route = routes.find(x => x.method === method && String(x.pattern).includes(marker));
    const res = await route.handle(new Request('https://sim/x', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      env, { session: { user_id: userId }, params: { gameId, ...params } });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
  const facs = (await DB.prepare('SELECT * FROM game_factions WHERE game_id = ? ORDER BY slot').bind(gameId).all()).results;
  const [att, def] = facs;
  const declared = await call(wars.routes, 'POST', 'declare', att.user_id, {}, { target_faction_id: def.id });
  check('war: the attacker can declare war on a custom map', declared.status < 300, JSON.stringify(declared.data).slice(0, 200));
  const armed = (await DB.prepare(`SELECT * FROM game_ships WHERE owner_faction_id = ? AND hp > 0 AND damage_per_tick > 0`).bind(att.id).all()).results;
  const before = (await DB.prepare(`SELECT COUNT(*) n, SUM(hp) hp FROM game_ships WHERE owner_faction_id = ? AND hp > 0`).bind(def.id).first());
  const tick0 = 30;
  // Worst-case distance on this map is tiny (orbits 60 and 61): pad hard.
  const T = Math.ceil(legTicks(400, SHIP_ENGINE_ACCEL) * 1.3) + 3;
  let sent = 0;
  for (const s of armed) {
    const res = await call(actions.routes, 'POST', 'transfer$', att.user_id, { shipId: s.id },
      { target_body_id: def.capital_body_id, scheduled_t: tick0, arrival_t: tick0 + T, replace: true });
    if (res.status < 300) sent++;
    else console.log('      transfer refused:', JSON.stringify(res.data).slice(0, 160));
  }
  check(`war: the attacker's ${armed.length} warships launch at the enemy capital`, armed.length > 0 && sent === armed.length, `${sent}/${armed.length}`);
  const { Room } = await import('../worker/room.js');
  const storage = new Map();
  const state = {
    id: { toString: () => 'sim-room' },
    storage: { get: async (k) => storage.get(k), put: async (k, v) => { storage.set(k, v); }, delete: async (k) => storage.delete(k), list: async () => new Map(storage), deleteAll: async () => storage.clear(), setAlarm() {}, getAlarm: () => null },
    getWebSockets: () => [], acceptWebSocket: () => {}, blockConcurrencyWhile: async (fn) => fn(),
  };
  const room = new Room(state, env);
  room.broadcast = () => {};
  for (let t = tick0 + 1; t <= tick0 + T + 25; t++) {
    await room.resolveTick(gameId, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, gameId).run();
  }
  const after = (await DB.prepare(`SELECT COUNT(*) n, SUM(hp) hp FROM game_ships WHERE owner_faction_id = ? AND hp > 0`).bind(def.id).first());
  const attAfter = (await DB.prepare(`SELECT COUNT(*) n, SUM(hp) hp FROM game_ships WHERE owner_faction_id = ? AND hp > 0`).bind(att.id).first());
  const kinds = (await DB.prepare(`SELECT kind, COUNT(*) n FROM chronicle_entries WHERE game_id = ? AND tick_number > ? GROUP BY kind`).bind(gameId, tick0).all()).results;
  const cap = await DB.prepare('SELECT owner_faction_id FROM game_bodies WHERE id = ?').bind(def.capital_body_id).first();
  const city = await DB.prepare(`SELECT hp, hp_max, owner_faction_id FROM game_settlements WHERE body_id = ? AND type = 'city'`).bind(def.capital_body_id).first();
  console.log(`      war: defender hulls ${before.n} (${Math.round(before.hp)} hp) -> ${after.n} (${Math.round(after.hp ?? 0)} hp); attacker ${armed.length} -> ${attAfter.n} hulls; capital city ${city ? `${Math.round(city.hp)}/${city.hp_max}` : 'gone'}; capital owner ${cap?.owner_faction_id === def.id ? 'defender' : cap?.owner_faction_id ?? 'nobody'}`);
  console.log(`      war chronicle: ${kinds.map(k => `${k.kind}×${k.n}`).join(' ')}`);
  check('war: fighting happens at the defender\'s capital', (after.hp ?? 0) < before.hp || (city && city.hp < city.hp_max) || kinds.some(k => /destroyed|battle|damage/.test(k.kind)));
  const errSet = [...new Set(errs.map(e => e.split('\n')[0]))];
  check('war: no server errors logged', errSet.length === 0, errSet.slice(0, 6).join('\n        '));
}

console.error = origError;
console.log(bad === 0 ? '\nALL CUSTOM-MAP GAME CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
