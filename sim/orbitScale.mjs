// ============================================================
// ORBIT SCALE — a scaled system keeps its ellipses.
//
// The eight-player game was seeded at system_scale 4. Its rogue
// asteroids got a 4x axis and kept a 1x ellipse (apoapsis around
// Saturn, axis at Neptune), because scaledGeometry scaled orbit_radius
// and not orbit_rp/orbit_ra — and the renderer and the tick position an
// eccentric body from the ellipse. Its "Kuiper" rocks fared worse for a
// related reason and sat in the belt. Both are placement rules that
// worldgen must hold at ANY scale, so this drives the real seeder at
// scale 1 and scale 4 and reads back what it wrote.
//
// Run: node sim/orbitScale.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

async function seedAt(tag, overrides) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const G = `gscale_${tag}`;
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uA','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Scale','uA',0,0)`).bind(G).run();
  if (overrides) {
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms, published_ms)
       VALUES ('cfg_probe','probe','published', ?, 0, 0, 0)`).bind(JSON.stringify(overrides)).run();
  }
  await DB.prepare(
    `INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at,config_id)
     VALUES (?, 'setup','scale-seed',0,3600000,0,0,?)`).bind(G, overrides ? 'cfg_probe' : null).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'earth')`).bind(G, 'uA').run();
  const factions = await import('../worker/factions.js');
  await factions.seedGameWorld(env, G);
  const rows = (await DB.prepare(
    `SELECT id, template_id, name, type, orbit_radius a, orbit_period T, orbit_rp rp, orbit_ra ra
       FROM game_bodies WHERE game_id = ? AND parent_body_id = ?`).bind(G, `${G}:sol`).all()).results;
  const byName = new Map(rows.map(r => [r.name, r]));
  return { rows, byName, pluto: byName.get('Pluto').a, neptune: byName.get('Neptune').a, saturn: byName.get('Saturn').a };
}

for (const [tag, overrides] of [
  ['1x', null],
  ['4x', { system_scale: 4, moon_scale: 8, body_scale: 2, outer_orbit_speedup: 4, randomize_orbits: 1 }],
]) {
  const { rows, pluto, neptune, saturn } = await seedAt(tag, overrides);
  console.log(`\n-- system_scale ${tag}: Saturn ${Math.round(saturn)}, Neptune ${Math.round(neptune)}, Pluto ${Math.round(pluto)}`);

  const rogues = rows.filter(r => r.type === 'asteroid' && r.ra != null);
  check(`[${tag}] the three rogue asteroids are seeded with ellipses`, rogues.length === 3, String(rogues.length));
  check(`[${tag}] each rogue's axis IS its ellipse — the two never disagree`,
    rogues.every(r => Math.abs(r.a - (r.rp + r.ra) / 2) <= Math.max(1, r.a * 0.01)),
    rogues.map(r => `${r.name}: a ${Math.round(r.a)} vs (${Math.round(r.rp)}+${Math.round(r.ra)})/2`).join(' | '));
  check(`[${tag}] every rogue reaches out past Pluto, as the catalogue promises`,
    rogues.every(r => r.ra > pluto),
    rogues.map(r => `${r.name} ra ${Math.round(r.ra)}`).join(', '));
  // The catalogue's periapses sit between Venus and the belt (200-300
  // pre-scale), so "inner system" here means inside Jupiter.
  check(`[${tag}] and dives back into the inner system at periapsis`,
    rogues.every(r => r.rp < rows.find(x => x.name === 'Jupiter').a));

  const kuiper = rows.filter(r => r.type === 'meteoroid' && r.ra != null);
  check(`[${tag}] eight Kuiper rocks`, kuiper.length === 8, String(kuiper.length));
  check(`[${tag}] every Kuiper rock stays at or beyond Pluto at periapsis`,
    kuiper.every(r => r.rp >= pluto - 1),
    kuiper.map(r => Math.round(r.rp)).join(','));
  check(`[${tag}] and swings well past it`,
    kuiper.every(r => r.ra > pluto * 1.5),
    kuiper.map(r => Math.round(r.ra)).join(','));
  check(`[${tag}] Kuiper axis matches its ellipse`,
    kuiper.every(r => Math.abs(r.a - (r.rp + r.ra) / 2) <= 1));

  const belt = rows.filter(r => r.type === 'meteoroid' && r.ra == null && /mtr_belt/.test(r.id));
  const mars = rows.find(x => x.name === 'Mars').a;
  const jupiter = rows.find(x => x.name === 'Jupiter').a;
  check(`[${tag}] the belt still sits between Mars and Jupiter`,
    belt.length === 10 && belt.every(r => r.a > mars && r.a < jupiter),
    belt.map(r => Math.round(r.a)).join(','));
}

console.log(bad === 0 ? '\nALL ORBIT-SCALE CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
