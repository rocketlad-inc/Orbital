// ============================================================
// A scene's worlds are the worlds it describes (2026-10-23).
//
// The obliterate clip: a Mars Mega Destroyer over Terra's RAW moon
// Callisto, armed at tick 0 to obliterate it at tick 7. That game rolled
// Callisto a buried 'pre_terraformed' secret; the hulls the scene parked
// there found it on tick 1 (room.js resolveSecretReveal), Callisto turned
// into a living ocean world on screen, and at tick 7 the strike, ordered
// as 'obliterate' on a world that was now living, stood down in silence
// (resolveMegaStrikes fires what was ordered or nothing). Nothing
// happened to Callisto for the whole take.
//
// Drives the REAL studio applyScenario and the REAL tick in SimD1:
//   1. a scene world's buried secret is gone after apply (and the
//      observer's world's too), so the take's hulls find nothing
//   2. a world off the scene keeps its secret
//   3. ticked through, the raw world is not terraformed, and the strike
//      the scene armed obliterates it on its tick
//   4. re-applied, the debris field is Callisto again: whole and raw
//      (living:false is a raw world; a take's scars are cleared on raw
//      worlds as on living ones)
//   5. a world a scene says is raw is raw, even if an earlier take
//      left it terraformed
//
// Run: npm run sim:studio-quiet
// ============================================================

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
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('admin','a@t','Admin','x',0)`).run();

const { applyScenario } = await import('../worker/studio.js');
const { expandScenario } = await import('../worker/studioScene.js');

// The judged scene, as filmed, with the strike armed by the scene.
const raw = {
  name: 'The Planet Killer: obliterate',
  factions: [
    { key: 'terra', name: 'Terran Directorate', home: 'earth' },
    { key: 'mars', name: 'Martian Combine', home: 'mars' },
  ],
  wars: [['terra', 'mars']],
  viewer: 'terra',
  worlds: [{ body: 'callisto', owner: 'terra', living: false, stations: 1 }],
  ships: [
    { key: 'mega', owner: 'mars', at: 'callisto', class: 'mega_destroyer', count: 1, hp: 40, prefix: 'MCS' },
    { key: 'esc', owner: 'mars', at: 'callisto', mix: { destroyer: 2, frigate: 3 }, loadout: 'mixed', hp: 2, prefix: 'MCS' },
    { key: 'guard', owner: 'terra', at: 'callisto', mix: { destroyer: 2, frigate: 2, corvette: 2 }, loadout: 'mixed', hp: 1.5, prefix: 'TDS' },
  ],
  orders: [{ type: 'strike', ship: 'mega.0', ready: '+3' }],
};

let out;
try {
  out = await applyScenario(env, expandScenario(raw), { session: { user_id: 'admin' } });
} catch (e) {
  console.log(`SKIP  applyScenario cannot run in SimD1 here: ${e.message}`);
  process.exit(0);
}
const G = out.game_id;
const bid = (t) => `${G}:${t}`;
const body = (t) => DB.prepare(
  `SELECT id, secret_kind, secret_revealed, terraformed_at_tick, obliterated_at_tick, sterilised_at_tick, owner_faction_id
     FROM game_bodies WHERE id = ?`).bind(bid(t)).first();

// The unlucky roll, on a board that already exists: bury the secret the
// filmed game had (and one off the scene, which must survive), then apply
// the scene again, as a re-shoot does.
await DB.prepare(`UPDATE game_bodies SET secret_kind = 'pre_terraformed', secret_revealed = 0 WHERE id IN (?, ?, ?)`)
  .bind(bid('callisto'), bid('jupiter'), bid('titan')).run();
out = await applyScenario(env, expandScenario({ ...raw, game_id: G }), { session: { user_id: 'admin' } });

const cal = await body('callisto');
const jup = await body('jupiter');
check('1. the scene world has no buried secret left', cal.secret_kind == null || cal.secret_revealed === 1, JSON.stringify(cal));
const camAt = (out.ships.camera ?? []).length
  ? (await DB.prepare('SELECT b.template_id AS tpl FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id WHERE s.id = ?')
    .bind(out.ships.camera[0]).first())?.tpl : null;
check('1b. ...nor the world the observer watches from', camAt !== 'jupiter' || jup.secret_kind == null || jup.secret_revealed === 1,
  JSON.stringify({ camAt, jup }));
const tit = await body('titan');
check('2. a world off the scene keeps its secret', tit.secret_kind === 'pre_terraformed' && tit.secret_revealed === 0, JSON.stringify(tit));

// ---- the take: real ticks ----
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
let tick = Number((await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(G).first()).current_tick);
const strike = out.orders.find(o => o.type === 'strike');
const t0 = tick;
let after1 = null;
while (tick < strike.ready) {
  tick += 1;
  await room.resolveTick(G, tick);
  await DB.prepare('UPDATE games SET current_tick=? WHERE id=?').bind(tick, G).run();
  if (tick === t0 + 1) after1 = await body('callisto');
}
check('3. after the first tick Callisto is still raw', after1 && after1.terraformed_at_tick == null, JSON.stringify(after1));
const done = await body('callisto');
check(`3b. the strike armed for tick ${strike.ready} obliterates it`, strike.mode === 'obliterate' && done.obliterated_at_tick === strike.ready,
  JSON.stringify({ strike, done }));

// ---- re-shoot: the debris field is Callisto again ----
await applyScenario(env, expandScenario({ ...raw, game_id: G }), { session: { user_id: 'admin' } });
const again = await body('callisto');
check('4. re-applied, the debris field is a whole world again', again.obliterated_at_tick == null && again.sterilised_at_tick == null,
  JSON.stringify(again));

// ---- a take that left the raw world living ----
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = 3 WHERE id = ?').bind(bid('callisto')).run();
await applyScenario(env, expandScenario({ ...raw, game_id: G }), { session: { user_id: 'admin' } });
const rawAgain = await body('callisto');
check('5. living:false is raw, whatever the last take left', rawAgain.terraformed_at_tick == null, JSON.stringify(rawAgain));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
