// ============================================================
// SOLO ON A CUSTOM MAP (Lorne, 2026-10-25): a solo game may be played on a
// Map Maker map, your own or one from the gallery, with the Commission
// (the same rule as hosting one). Real create route, seeder, tick and
// computer empires:
//
//   1. without the Commission: 402, and no game
//   2. someone else's UNPUBLISHED map: not found
//   3. a gallery map: the room snapshots it, the worlds are its worlds,
//      and rivals are capped at its start worlds less the player's own
//   4. the computer empires play it: research, ships, and expansion
//   5. a map that cannot be hosted (fewer than two start worlds): refused
//
// Run: node sim/soloCustomMap.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { generateMap, normalizeMap, startWorlds } from '../src/game/customMap.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}
function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = {
  DB,
  ORBITAL_ENV: 'staging',   // the Map Maker is open
  ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
};
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uC','c@t','Cora','x',0), ('uF','f@t','Finn','x',0), ('uM','m@t','Maker','x',0)`).run();
// Cora holds the Commission; Finn does not.
await DB.prepare("INSERT INTO user_entitlements (user_id, sku, granted_at) VALUES ('uC', 'cosmetics_v1', 0)").run()
  .catch(async () => DB.prepare("INSERT INTO user_entitlements (user_id, sku) VALUES ('uC', 'cosmetics_v1')").run());

// A maker's map: four start worlds, published to the gallery; and a private one.
const map = normalizeMap(generateMap({ seed: 'solo-gallery-1', starts: 4 }));
const starts = startWorlds(map).worlds.length;
const put = (id, m, published) => DB.prepare(
  `INSERT INTO custom_maps (id, owner_user_id, name, map_json, share_code, hosted_count, created_ms, updated_ms, published, published_ms)
   VALUES (?, 'uM', ?, ?, ?, 0, 0, 0, ?, ?)`,
).bind(id, m.name, JSON.stringify(m), `ORB-${id.slice(-4).toUpperCase()}-0000`, published ? 1 : 0, published ? 1 : null).run();
await put('map_gallery1', map, true);
await put('map_private1', map, false);
const single = normalizeMap({ ...map, bodies: map.bodies.map((b, i) => ({ ...b, start: i === map.bodies.findIndex(x => x.start) })) });
await put('map_single1', single, true);

const solo = await import('../worker/solo.js');
async function create(userId, body) {
  const r = solo.routes.find(x => x.method === 'POST' && String(x.pattern).includes('solo'));
  const res = await r.handle(new Request('https://x/api/solo', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, { url: new URL('https://x/api/solo'), params: {}, session: { user_id: userId, email: `${userId}@t` } });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

// ---- 1-2. the gates ---------------------------------------------------------
const noCommission = await create('uF', { rivals: 2, map_id: 'map_gallery1' });
check('1. without the Commission: 402, no game', noCommission.status === 402 && noCommission.data?.error?.code === 'commission_required',
  JSON.stringify(noCommission));
const notPublished = await create('uC', { rivals: 2, map_id: 'map_private1' });
check("2. someone else's unpublished map: not found", notPublished.status === 404, JSON.stringify(notPublished));
const unhostable = await create('uC', { rivals: 2, map_id: 'map_single1' });
check('5. a map with one start world is refused', unhostable.status === 409 && unhostable.data?.error?.code === 'map_blocked',
  JSON.stringify(unhostable).slice(0, 200));

// ---- 3. a gallery map -------------------------------------------------------
const made = await create('uC', { rivals: 5, difficulty: 'ruthless', speed_ms: 30000, map_id: 'map_gallery1' });
check('3. a gallery map starts a solo game', made.status === 200 && !!made.data?.game_id, JSON.stringify(made));
const G = made.data?.game_id;
check(`   rivals capped at its start worlds less yours (${starts} starts)`, made.data?.rivals === starts - 1, JSON.stringify(made.data));
const room = await DB.prepare('SELECT custom_map_id, custom_map_json FROM rooms WHERE id = ?').bind(G).first();
check('   the room snapshots the map', room?.custom_map_id === 'map_gallery1' && !!room?.custom_map_json);
const bodies = (await DB.prepare('SELECT name FROM game_bodies WHERE game_id = ?').bind(G).all()).results.map(b => b.name);
check('   the worlds are the map\'s, not Sol\'s', bodies.includes(map.bodies[0].name) && !bodies.includes('Earth'),
  bodies.slice(0, 8).join(', '));
const factions = (await DB.prepare('SELECT id, user_id, ai_doctrine, capital_body_id FROM game_factions WHERE game_id = ?').bind(G).all()).results;
check('   every seat holds a start world', factions.length === starts && factions.every(f => !!f.capital_body_id), JSON.stringify(factions));

// ---- 4. they play it -------------------------------------------------------
const ai = await import('../worker/aiEmpire.js');
const { Room } = await import('../worker/room.js');
const r = new Room(makeState(), env);
r.broadcast = () => {};
const tally = {};
const errs = [];
const origError = console.error;
console.error = (...a) => { errs.push(a.map(String).join(' ').slice(0, 200)); };
let t = Number((await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(G).first()).current_tick ?? 0);
try {
  while (t < 80) {
    t += 1;
    await r.resolveTick(G, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
    await ai.runSoloGame(env, G, tally);
  }
} finally { console.error = origError; }
const sum = (re) => Object.entries(tally).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
console.log('        tally:', JSON.stringify(tally));
check('4. 80 ticks run without an error', errs.length === 0, errs.slice(0, 3).join(' | '));
check('   they research', sum(/:research_ok$/) > 0);
check('   they lay down ships', sum(/:build_\w+_ok$/) > 0);
const bots = factions.filter(f => f.ai_doctrine);
const held = await DB.prepare(`SELECT COUNT(DISTINCT body_id) AS c FROM game_settlements WHERE game_id = ? AND destroyed_at_tick IS NULL
                                 AND owner_faction_id IN (${bots.map(() => '?').join(',')})`).bind(G, ...bots.map(b => b.id)).first();
check('   they expand past their capitals', held.c > bots.length, `${held.c} worlds for ${bots.length} empires`);

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
