// ============================================================
// Turn every far sun-gate end already placed to face Sol (Lorne,
// 2026-10-08). New ones are placed that way (sunGates.js
// farGateBearing); the ones that opened before that sit anywhere on
// their ring. Each moves to a seeded bearing in the quadrant of its
// system facing the Sun, AS OF NOW: its year is tens of thousands of
// ticks, so it stays there. Ends already inside the quadrant are left
// alone. Only angle0 changes; it refuses a gate anything is parked on
// or flying to, so no hull is ever moved under its own feet.
//
//   node scripts/face-far-gates.mjs <staging|production> [--apply]
//
// Dry run by default. --apply writes, and saves a rollback.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { farGateBearing, angle0For, seededRand } from '../worker/sunGates.js';
import { orbitAngle } from '../worker/orbitPos.js';

const [envName, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
if (!['production', 'staging'].includes(envName)) {
  console.error('usage: node scripts/face-far-gates.mjs <staging|production> [--apply]');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';
const ENV_FLAG = envName === 'production' ? '' : ` --env ${envName}`;
const q = (sql) => {
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --json --command "${sql.replace(/\s+/g, ' ').replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
};

const rows = q(`
  SELECT f.id, f.game_id, f.orbit_radius AS r, f.orbit_period AS p, f.angle0 AS a0,
         g.current_tick AS t,
         bary.orbit_radius AS br, bary.orbit_period AS bp, bary.angle0 AS ba0,
         (SELECT COUNT(*) FROM game_ships s WHERE s.parent_body_id = f.id AND s.status = 'active') AS parked,
         (SELECT COUNT(*) FROM game_ship_nodes n WHERE n.target_body_id = f.id
            AND n.status IN ('planned', 'committed', 'in_transit')) AS legs
    FROM game_bodies f
    JOIN games g ON g.id = f.game_id
    JOIN game_bodies bary ON bary.id = f.parent_body_id
   WHERE f.template_id = 'sun_gate_far' AND f.destroyed_at_tick IS NULL AND g.status = 'active'
   ORDER BY f.id`);

const off = (a, b) => Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
const updates = [], rollback = [];
for (const g of rows) {
  const t = Number(g.t);
  // The barycenter orbits the Sun (at the origin); Sol is behind it.
  const ba = orbitAngle(g.ba0, g.bp, t);
  const baryAt = { x: Math.cos(ba) * g.br, y: Math.sin(ba) * g.br };
  const home = Math.atan2(-baryAt.y, -baryAt.x);
  const now = orbitAngle(g.a0, g.p, t);
  const was = off(now, home);
  let verdict;
  if (Number(g.parked) > 0 || Number(g.legs) > 0) verdict = `SKIP: ${g.parked} parked, ${g.legs} legs`;
  else if (was <= Math.PI / 4) verdict = 'already faces Sol';
  else {
    const key = String(g.id).replace(/^.*:sungate_/, '').replace(/_far$/, '');
    const bearing = farGateBearing(seededRand(`${g.game_id}|sungate|${key}|far`), g.r, { x: 0, y: 0 }, baryAt);
    const a0 = angle0For(bearing, g.p, t);
    updates.push(`UPDATE game_bodies SET angle0 = ${a0} WHERE id = '${g.id}' AND angle0 = ${g.a0}`);
    rollback.push(`UPDATE game_bodies SET angle0 = ${g.a0} WHERE id = '${g.id}'`);
    verdict = `move: ${(was * 180 / Math.PI).toFixed(0)}° off -> ${(off(orbitAngle(a0, g.p, t), home) * 180 / Math.PI).toFixed(0)}°`;
  }
  console.log(`${g.id.padEnd(40)} T${t}  ${verdict}`);
}
console.log(`\n${updates.length} to move${APPLY ? '' : ' (dry run; --apply to write)'}`);
if (APPLY && updates.length) {
  const rb = path.join(os.tmpdir(), `far-gates-rollback-${envName}-${Date.now()}.sql`);
  fs.writeFileSync(rb, rollback.map(s => `${s};`).join('\n') + '\n');
  const file = path.join(os.tmpdir(), `far-gates-${Date.now()}.sql`);
  fs.writeFileSync(file, updates.map(s => `${s};`).join('\n') + '\n');
  execSync(`npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --file "${file}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`applied; rollback: ${rb}`);
}
