// ============================================================
// A scene puts its megastructure where the shot needs it (2026-10-23).
//
// The weapons-station clip: Mars's finished Weapons Station was to shred a
// Terran raid flying in from Deimos. The studio hangs every site on the
// ancient-gate ring (35% of the host's sphere of influence), which for Mars
// is 61 units out, twelve Mars radii, a quarter-turn round from Deimos: a
// camera on Mars never had it in frame, and a frame holding Mars, the
// station and Deimos made Mars a dot. A player places a site anywhere
// inside the world's sphere of influence (actions.js, deriveSiteOrbit), so
// a scene may too: `orbit` (units from the world's centre) and `angle`
// (degrees, where it stands on the tick the scene lands).
//
// Drives the REAL studio applyScenario in SimD1:
//   1. orbit and angle put the site there, on the tick it lands
//   2. its period is the one a player's site at that radius gets
//   3. without them it keeps the gate ring
//   4. an orbit outside the sphere of influence, or inside the world, is refused
//
// Run: npm run sim:studio-site-orbit
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
const { bodyPositionAt, periodForRadius } = await import('../worker/megastructures.js');

const scene = (mega) => ({
  name: 'A Weapons Station shreds a raid',
  factions: [
    { key: 'terra', name: 'Terran Directorate', home: 'earth' },
    { key: 'mars', name: 'Martian Combine', home: 'mars' },
  ],
  viewer: 'mars',
  worlds: [{ body: 'mars', owner: 'mars', cities: ['Olympus'] }],
  megastructures: [{ key: 'ws', kind: 'weapons_station', at: 'mars', owner: 'mars', complete: true, ...mega }],
});

let out;
try {
  out = await applyScenario(env, expandScenario(scene({ orbit: 20, angle: 220 })), { session: { user_id: 'admin' } });
} catch (e) {
  console.log(`FAIL  applyScenario refused orbit/angle: ${e.message}`);
  process.exit(1);
}
const G = out.game_id;
const all = async () => (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(G).all()).results;
let bodies = await all();
let byId = new Map(bodies.map(b => [b.id, b]));
const tick = Number((await DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(G).first()).current_tick);
const site = byId.get(`${G}:st_mega_ws`);
const mars = byId.get(`${G}:mars`);
const sp = bodyPositionAt(site, byId, tick);
const mp = bodyPositionAt(mars, byId, tick);
const r = Math.hypot(sp.x - mp.x, sp.y - mp.y);
const deg = ((Math.atan2(sp.y - mp.y, sp.x - mp.x) * 180 / Math.PI) + 360) % 360;
check('1. the site stands 20 units out at 220 degrees on the tick it lands', Math.abs(r - 20) < 1e-6 && Math.abs(deg - 220) < 1e-6,
  JSON.stringify({ r, deg }));
const want = periodForRadius(mars, 20, bodies);
check('2. its period is a player site\'s at that radius', Math.abs(Number(site.orbit_period) - want) < 1e-6,
  JSON.stringify({ got: site.orbit_period, want }));

await applyScenario(env, expandScenario({ ...scene({}), game_id: G }), { session: { user_id: 'admin' } });
bodies = await all();
byId = new Map(bodies.map(b => [b.id, b]));
const ring = byId.get(`${G}:st_mega_ws`);
const soi = Number(byId.get(`${G}:mars`).soi);
check('3. without them it keeps the gate ring', Math.abs(Number(ring.orbit_radius) - Math.min(Math.max(5 * 2.5, soi * 0.35), soi * 0.8)) < 1e-6,
  JSON.stringify({ orbit: ring.orbit_radius, soi }));

const refused = async (mega) => {
  try { await applyScenario(env, expandScenario({ ...scene(mega), game_id: G }), { session: { user_id: 'admin' } }); return null; }
  catch (e) { return e.message; }
};
const far = await refused({ orbit: soi + 10 });
const inside = await refused({ orbit: 2 });
check('4. an orbit outside the sphere of influence is refused', /sphere of influence/.test(String(far)), String(far));
check('4b. ...and one inside the world', /inside|surface/.test(String(inside)), String(inside));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
