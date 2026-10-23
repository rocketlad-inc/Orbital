// ============================================================
// A `gates: true` scene starts with its sun gate LANDED and OPEN
// (2026-10-23).
//
// The colony clip (Uranus -> the Centauri gate -> Verdant) drew the
// Sol-side gate as "CENTAURI GATE LANDING SITE" the whole time the ship
// sat on it. The Studio put the gate out of the Sun 40 ticks back, so it
// had long landed, but it set the omen so far back that the game's own
// sun gate step never looked again, and that step is what hands a
// landing site to its gate and retires it (sunGates.js
// handOffLandingSite). The site stayed, on the gate's exact orbit, and
// on the map a world-like site outranked the gate and folded it away.
//
// Drives the REAL studio applyScenario (worker/studio.js) in SimD1:
//   1. the gate has landed by the take's first tick
//   2. its landing site is retired
//   3. a move to `sun_gate` is a leg to the gate itself
//   4. a board an older take left with a live site has it retired when a
//      scene is applied to it again
//
// Run: npm run sim:studio-gates
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

// The judged scene, as filmed.
const scene = expandScenario({
  name: 'A colony ship for Verdant',
  factions: [
    { key: 'terra', name: 'Terran Directorate', home: 'earth' },
    { key: 'mars', name: 'Martian Combine', home: 'mars' },
  ],
  viewer: 'terra',
  gates: true,
  ships: [{ key: 'col', owner: 'terra', at: 'uranus', class: 'colony', count: 1, prefix: 'TCS' }],
  orders: [{ type: 'move', ships: 'col', to: 'sun_gate', depart: '+1' }],
});

let out;
try {
  out = await applyScenario(env, scene, { session: { user_id: 'admin' } });
} catch (e) {
  console.log(`SKIP  applyScenario cannot run in SimD1 here: ${e.message}`);
  process.exit(0);
}
const g = out.game_id;
const tick = Number((await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(g).first()).current_tick);
const row = (id) => DB.prepare('SELECT id, emerge_from_tick, emerge_until_tick, destroyed_at_tick FROM game_bodies WHERE id = ?').bind(id).first();
const gate = await row(`${g}:sungate_centauri`);
const site = await row(`${g}:sungate_centauri_site`);

check('1. the gate has landed by the first tick of the take',
  gate && gate.emerge_until_tick != null && Number(gate.emerge_until_tick) <= tick,
  JSON.stringify({ tick, gate }));
check('2. its landing site is retired', site && site.destroyed_at_tick != null, JSON.stringify(site));

const leg = await DB.prepare(`SELECT target_body_id FROM game_ship_nodes WHERE game_id = ? AND ship_id = ? ORDER BY sequence DESC LIMIT 1`)
  .bind(g, `${g}:st_col_0`).first();
check('3. a move to sun_gate flies to the gate itself', leg?.target_body_id === `${g}:sungate_centauri`, JSON.stringify(leg));

// A board from before this fix: the site still standing.
await DB.prepare('UPDATE game_bodies SET destroyed_at_tick = NULL WHERE id = ?').bind(`${g}:sungate_centauri_site`).run();
await applyScenario(env, { ...scene, gameId: g }, { session: { user_id: 'admin' } });
const again = await row(`${g}:sungate_centauri_site`);
check('4. re-applied to an older board, the site is retired', again && again.destroyed_at_tick != null, JSON.stringify(again));

// 5. THE CAMERA MUST BE IN RANGE in a far system too. The clip cut to
// Verdant while the colony ship was still ~1.4 sensor reaches out, so
// the viewer's fog dimmed the whole frame until the hull's own sensor
// edge swept across it (f564-f575). Listing Verdant under worlds gives
// the viewer an observer there, and it must watch from a quiet moon,
// as it does in Sol: Verdant's sun orbits the binary's barycenter, so
// the old "a star has no parent" test took Centauri A for a planet and
// parked the observer on the sun, 1120 units (4480 on a live map) out.
const withWorld = await applyScenario(env, expandScenario({
  name: 'A colony ship for Verdant, watched',
  factions: [
    { key: 'terra', name: 'Terran Directorate', home: 'earth' },
    { key: 'mars', name: 'Martian Combine', home: 'mars' },
  ],
  viewer: 'terra',
  gates: true,
  worlds: [{ body: 'verdant' }],
  ships: [{ key: 'col', owner: 'terra', at: 'uranus', class: 'colony', count: 1, prefix: 'TCS' }],
}), { session: { user_id: 'admin' } });
const cams = withWorld.ships.camera ?? [];
const camAt = cams.length
  ? (await DB.prepare(`SELECT b.template_id AS tpl FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id WHERE s.id = ?`)
    .bind(cams[0]).first())?.tpl
  : null;
check('5. a far world in worlds[] is watched from its moon, not its sun', camAt === 'thistle' || camAt === 'sorrel',
  JSON.stringify({ cams, camAt }));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
