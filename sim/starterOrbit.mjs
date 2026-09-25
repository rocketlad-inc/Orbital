// ============================================================
// starterOrbit — a starting fleet is parked OUTSIDE its world.
//
//   npm run sim:starterorbit
//
// 2026-09-25: "The hell is up with this orbit? They're crashing into
// Mars!" A new game at body_scale 2 put every starting hull on an orbit
// of 3.75-5 around a Mars of radius 5 -- inside the planet. The seed
// sized the orbit from the RAW catalogue radius (2.5) while the world
// itself was built from the scaled one. Seeds real games through
// seedGameWorld and reads the rows back, so the check is on what the
// game actually stores, at the scale that broke and at the default.
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

async function seed(tag, overrides) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = `gstart_${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'S','uA',0,0)`).bind(G).run();
  if (overrides) {
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms, published_ms)
       VALUES ('cfg_s','s','published', ?, 0, 0, 0)`).bind(JSON.stringify(overrides)).run();
  }
  await DB.prepare(
    `INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at,config_id)
     VALUES (?, 'setup',?,0,3600000,0,0,?)`).bind(G, `start-${tag}`, overrides ? 'cfg_s' : null).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'mars'), (?,?,0,'earth')`)
    .bind(G, 'uA', G, 'uB').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  return (await DB.prepare(
    `SELECT s.name, s.orbit_rp AS rp, s.orbit_ra AS ra, b.radius, b.template_id AS world
       FROM game_ships s JOIN game_bodies b ON b.id = s.parent_body_id
      WHERE s.game_id = ?`).bind(G).all()).results;
}

for (const [tag, overrides] of [['default', null], ['body_scale_2', { body_scale: 2, system_scale: 4, moon_scale: 8 }]]) {
  const ships = await seed(tag, overrides);
  console.log(`-- ${tag}: ${ships.length} starting ships`);
  check('there is a starting fleet to check', ships.length > 0);
  const inside = ships.filter(s => !(s.rp > s.radius));
  check('every starting hull\'s closest approach clears its world',
    inside.length === 0,
    inside.slice(0, 3).map(s => `${s.name}: orbit ${s.rp}-${s.ra} around radius ${s.radius}`).join('; '));
  const mars = ships.find(s => s.world === 'mars');
  if (mars) {
    check('Mars: orbit is 1.5x-2x the radius the world was BUILT with',
      Math.abs(mars.rp - mars.radius * 1.5) < 1e-6 && Math.abs(mars.ra - mars.radius * 2) < 1e-6,
      `rp ${mars.rp}, ra ${mars.ra}, radius ${mars.radius}`);
  }
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
