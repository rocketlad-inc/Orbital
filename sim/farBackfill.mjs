// ============================================================
// sim:farbackfill — turning the far systems on in a game ALREADY RUNNING
// must give it the same Centauri and Cygnus a game seeded with them gets.
//
// Lorne, 2026-10-06: "test inserting the new systems ... test what you'd
// do in prod". In prod every game is already running, under whichever
// config was published when it began (or none), so the far systems
// arrive by backfillMissingBodies, not by the seeder. For each map setup
// staging (and so prod) actually runs, this seeds one game WITHOUT the
// far systems, turns them on and backfills it, seeds a twin WITH them,
// and compares every far body field by field.
//
//   node sim/farBackfill.mjs
// ============================================================

import { seedGameWorld, backfillMissingBodies, BODY_CATALOG } from '../worker/factions.js';
import { invalidate } from '../worker/gameConfig.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
};

// The map setups the live games run (staging's active configs, which
// copy prod's), plus none at all.
const SETUPS = {
  'no config (defaults)': null,
  slowpace: { system_scale: 4, moon_scale: 8 },
  slowpace2: { system_scale: 4, moon_scale: 8, body_scale: 2, bodies: { jupiter: { orbit_radius: 1150 } } },
  slowpace5: {
    system_scale: 4, moon_scale: 8, body_scale: 2, outer_orbit_speedup: 4, randomize_orbits: 1,
  },
};

async function seed(id, overrides, mapSeed) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u0','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'B','u0',0,0)`).bind(id).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at) VALUES (?, 'setup', ?, 0, 0)`)
    .bind(id, mapSeed).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,0)`).bind(id, 'u0').run();
  if (overrides) {
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (?, 'c', 'published', ?, 0, 0)`,
    ).bind(`cfg_${id}`, JSON.stringify(overrides)).run();
    await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${id}`, id).run();
  }
  invalidate(id);
  await seedGameWorld(env, id);
  return { env, DB };
}

/** Turn far_systems on for a running game the way a rollout would. */
async function turnOn(DB, id, overrides) {
  const next = { ...(overrides ?? {}), far_systems: 1 };
  if (overrides) {
    await DB.prepare(`UPDATE game_configs SET overrides = ? WHERE id = ?`).bind(JSON.stringify(next), `cfg_${id}`).run();
  } else {
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (?, 'c', 'archived', ?, 0, 0)`,
    ).bind(`cfg_${id}`, JSON.stringify(next)).run();
    await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${id}`, id).run();
  }
  invalidate(id);
}

const FIELDS = ['type', 'parent', 'radius', 'soi', 'mu', 'orbit_radius', 'orbit_period',
  'orbit_rp', 'orbit_ra', 'orbit_omega', 'orbit_m0', 'yield_metal', 'yield_gold', 'yield_science',
  'mineral_kind', 'mineral_initial'];
const farRows = async (DB, id) => {
  const rows = (await DB.prepare(`SELECT * FROM game_bodies WHERE game_id = ?`).bind(id).all()).results;
  const strip = (v) => (typeof v === 'string' ? v.replace(`${id}:`, '') : v);
  const byTpl = new Map();
  for (const r of rows) byTpl.set(r.template_id, { ...r, parent: strip(r.parent_body_id) });
  return { byTpl, rows };
};
const close = (a, b) => (a == null || b == null) ? a == b
  : typeof a === 'number' ? Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6) : a === b;

const FAR = new Set(BODY_CATALOG.filter(b => b.far_system).map(b => b.id));

for (const [name, overrides] of Object.entries(SETUPS)) {
  console.log(`\n---- ${name} ----`);
  const seedTag = `seed-${name}`;
  // The game already running: seeded without the far systems...
  const live = await seed('glive', overrides, seedTag);
  const before = (await live.DB.prepare(`SELECT COUNT(*) n FROM game_bodies WHERE game_id='glive'`).first()).n;
  const solBefore = await farRows(live.DB, 'glive');
  check('a running game has no far systems before the switch',
    ![...solBefore.byTpl.keys()].some(t => FAR.has(t)));
  // ...then switched on and backfilled.
  await turnOn(live.DB, 'glive', overrides);
  const added = await backfillMissingBodies(live.env, 'glive', { farOnly: true });
  // And the twin, seeded with them from the start.
  const fresh = await seed('gfresh', { ...(overrides ?? {}), far_systems: 1 }, seedTag);

  const a = await farRows(live.DB, 'glive');
  const b = await farRows(fresh.DB, 'gfresh');
  const farTpls = [...b.byTpl.keys()].filter(t => FAR.has(t) || /^mtr_c(en|yg)_/.test(t));
  check(`the backfill adds every far body a fresh game has (${farTpls.length})`,
    farTpls.every(t => a.byTpl.has(t)), farTpls.filter(t => !a.byTpl.has(t)).join(', '));
  // Counted as ROWS: the return value also counts the far discoveries
  // the backfill places on those bodies (factions.js backfillFarSecrets).
  const rowsNow = (await live.DB.prepare(`SELECT COUNT(*) n FROM game_bodies WHERE game_id='glive'`).first()).n;
  check('...and no other body', rowsNow - before === farTpls.length,
    `${rowsNow - before} rows added, ${farTpls.length} expected (backfill reported ${added})`);

  const diffs = [];
  for (const t of farTpls) {
    const x = a.byTpl.get(t), y = b.byTpl.get(t);
    if (!x) continue;
    for (const f of FIELDS) {
      if (!close(x[f], y[f])) diffs.push(`${t}.${f}: backfilled ${x[f]} vs fresh ${y[f]}`);
    }
  }
  check('every far body matches the fresh game field for field', diffs.length === 0,
    diffs.slice(0, 12).join('\n        ') + (diffs.length > 12 ? `\n        ...and ${diffs.length - 12} more` : ''));

  // Nothing the game already had moved.
  const moved = solBefore.rows.filter(r => {
    const now = a.byTpl.get(r.template_id);
    return !now || now.orbit_radius !== r.orbit_radius || now.angle0 !== r.angle0 || now.owner_faction_id !== r.owner_faction_id;
  });
  check('nothing already in the game moves', moved.length === 0, moved.map(r => r.template_id).join(', '));

  // Run twice: a second pass is a no-op.
  const again = await backfillMissingBodies(live.env, 'glive', { farOnly: true });
  check('a second backfill adds nothing', again === 0, `${again} added`);
  const after = (await live.DB.prepare(`SELECT COUNT(*) n FROM game_bodies WHERE game_id='glive'`).first()).n;
  console.log(`      bodies ${before} -> ${after}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nALL FAR-BACKFILL CHECKS PASS');
process.exit(failed ? 1 : 0);
