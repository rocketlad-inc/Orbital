// ============================================================
// THE FAR SYSTEMS — Centauri and Cygnus X-1, seeded for real.
//
// Written for single-player in May 2026 (dd5b3b8c) and never once
// seeded in a multiplayer game: they lived only in mockGameState, and
// single-player entry was retired. Ported 2026-10-05 for STAGING.
//
// HALF OF THIS FILE IS THE PRODUCTION GUARD. The bodies are in the
// shipped catalogue so every lookup-by-template keeps working, which
// means two live code paths would otherwise plant them in games nobody
// asked: seedGameWorld, and backfillMissingBodies — which runs against
// games ALREADY IN PROGRESS every time the lobby is touched. Both are
// asserted off here, because "DO NOT PUT THEM IN PROD" is a property of
// the code, not of my intentions.
//
// Run: node sim/farSystems.mjs
// ============================================================

import {
  BODY_CATALOG, FAR_SYSTEM_IDS, STARTING_BODY_OPTIONS,
  seedGameWorld, backfillMissingBodies, pickSecretPlacements,
  moonScaleCeiling, catalogFor,
} from '../worker/factions.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { defaults } from '../worker/configSchema.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const CENTAURI = ['binary_barycenter', 'centauri_a', 'centauri_b', 'verdant',
  'crimson', 'prismara', 'cinder', 'farspire'];
const CYGNUS = ['bh_barycenter', 'cygnus_x', 'hde_226868', 'requiem',
  'vellichor', 'echelon', 'reliquary'];
const ALL_FAR = [...CENTAURI, ...CYGNUS];

// ---- 1. The catalogue ------------------------------------------------
check('both systems are in the shipped catalogue',
  ALL_FAR.every(id => BODY_CATALOG.some(b => b.id === id)),
  ALL_FAR.filter(id => !BODY_CATALOG.some(b => b.id === id)).join(', '));
check('every one of them is flagged far_system',
  ALL_FAR.every(id => FAR_SYSTEM_IDS.has(id)));
check('the default config leaves them out of a game\'s catalogue',
  catalogFor(defaults()).every(b => !b.far_system));
check('...and the dial puts them back',
  catalogFor({ ...defaults(), far_systems: 1 }).filter(b => b.far_system).length === 15);

// SERVER DIALECT. The catalogue spells it 'gas-giant'; the client says
// 'gas_giant' and mapBodyType rewrites at the /state boundary. A far
// world written in the client's spelling would be a body whose type
// matches no server rule — silently, which is how this has bitten twice.
const types = new Set(BODY_CATALOG.filter(b => b.far_system).map(b => b.type));
check('they use the SERVER spelling for types',
  !types.has('gas_giant') && !types.has('ice_giant'), [...types].join(', '));

// ---- 2. Distance is the balance -------------------------------------
// Live games run system_scale 4 over the catalogue's own SYSTEM_SCALE 2.
const LIVE = 4;
const ACCEL = 0.05 * 4 * 132.6;            // DEFAULT_ENGINE_G x G_ANCHOR
const ticks = (r) => 2 * Math.sqrt((r * LIVE) / ACCEL);
const cenR = BODY_CATALOG.find(b => b.id === 'binary_barycenter').orbit_radius;
const cygR = BODY_CATALOG.find(b => b.id === 'bh_barycenter').orbit_radius;
check('Centauri is a ~200-tick crossing at default engines',
  Math.abs(ticks(cenR) - 200) < 3, `${ticks(cenR).toFixed(0)} ticks`);
check('Cygnus is a ~226-tick crossing',
  Math.abs(ticks(cygR) - 226) < 4, `${ticks(cygR).toFixed(0)} ticks`);
check('they sit on opposite sides of Sol',
  Math.abs(BODY_CATALOG.find(b => b.id === 'binary_barycenter').angle0
    - BODY_CATALOG.find(b => b.id === 'bh_barycenter').angle0) > 3,
  'both would crowd one edge of the map');

// ---- 3. Yields: "everything, but far" -------------------------------
const solMax = { metal: 0, gold: 0, science: 0 };
for (const b of BODY_CATALOG) {
  if (b.far_system || !b.yield) continue;
  for (const k of Object.keys(solMax)) solMax[k] = Math.max(solMax[k], b.yield[k] ?? 0);
}
const farWorlds = BODY_CATALOG.filter(b => b.far_system && (b.yield.metal + b.yield.gold + b.yield.science) > 0);
check('the far worlds out-yield the best of Sol...',
  farWorlds.some(b => b.yield.science > solMax.science)
  && farWorlds.some(b => b.yield.metal > solMax.metal)
  && farWorlds.some(b => b.yield.gold > solMax.gold),
  JSON.stringify(solMax));
const over = farWorlds.filter(b =>
  b.yield.metal > solMax.metal * 2 || b.yield.gold > solMax.gold * 2
  || b.yield.science > solMax.science * 2);
check('...without doubling it — the trip is the cost, not a jackpot',
  over.length === 0, over.map(b => b.id).join(', '));
check('stars and the black hole yield nothing, like Sol',
  BODY_CATALOG.filter(b => b.far_system
    && ['star', 'black_hole', 'lagrange'].includes(b.type))
    .every(b => b.yield.metal + b.yield.gold + b.yield.science === 0));

// ---- 4. No cross-effects on the Sol map ------------------------------
check('no far world is a capital option',
  !STARTING_BODY_OPTIONS.some(o => FAR_SYSTEM_IDS.has(o.id)));
check('the moon-scale clamp is unchanged by their arrival',
  moonScaleCeiling(4, BODY_CATALOG) === moonScaleCeiling(4, BODY_CATALOG.filter(b => !b.far_system)),
  `${moonScaleCeiling(4, BODY_CATALOG)} vs ${moonScaleCeiling(4, BODY_CATALOG.filter(b => !b.far_system))}`);
const places = pickSecretPlacements(() => 0.5, new Set());
check('no secret is ever placed out there',
  ![...places.keys()].some(id => FAR_SYSTEM_IDS.has(id)),
  [...places.keys()].filter(id => FAR_SYSTEM_IDS.has(id)).join(', '));

// ---- 5. Seeding, both ways -------------------------------------------
async function seedGame(id, farSystems) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('u0','a@t','A','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Far','u0',0,0)`).bind(id).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'setup','far-seed',0,0)`).bind(id).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,0)`)
    .bind(id, 'u0').run();
  if (farSystems != null) {
    await DB.prepare(
      `INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms)
       VALUES (?, 'far', 'published', ?, 0, 0)`,
    ).bind(`cfg_${id}`, JSON.stringify({ far_systems: farSystems })).run();
    await DB.prepare(`UPDATE games SET config_id = ? WHERE id = ?`).bind(`cfg_${id}`, id).run();
  }
  await seedGameWorld(env, id);
  const rows = (await DB.prepare(
    `SELECT template_id FROM game_bodies WHERE game_id=?`).bind(id).all()).results ?? [];
  return { env, DB, ids: new Set(rows.map(r => r.template_id)), count: rows.length };
}

const plain = await seedGame('gfar_off', null);
check('a game with no config has NO far-system body', ![...plain.ids].some(t => FAR_SYSTEM_IDS.has(t)),
  [...plain.ids].filter(t => FAR_SYSTEM_IDS.has(t)).join(', '));

const off = await seedGame('gfar_zero', 0);
check('far_systems: 0 seeds none either', ![...off.ids].some(t => FAR_SYSTEM_IDS.has(t)));

const on = await seedGame('gfar_on', 1);
check('far_systems: 1 seeds all fifteen',
  ALL_FAR.every(id => on.ids.has(id)), ALL_FAR.filter(id => !on.ids.has(id)).join(', '));
check('...and the rest of Sol is still there',
  on.count === plain.count + 15, `${on.count} vs ${plain.count} + 15`);

// THE BACKFILL IS THE ONE THAT TOUCHES LIVE GAMES.
const added = await backfillMissingBodies(plain.env, 'gfar_off');
const after = (await plain.DB.prepare(
  `SELECT template_id FROM game_bodies WHERE game_id='gfar_off'`).all()).results ?? [];
check('backfill does NOT inject them into a running game that never asked',
  !after.some(r => FAR_SYSTEM_IDS.has(r.template_id)),
  `added ${added}: ${after.filter(r => FAR_SYSTEM_IDS.has(r.template_id)).map(r => r.template_id).join(', ')}`);

// ---- 6. The seeded geometry is sane ----------------------------------
const geo = (await on.DB.prepare(
  `SELECT template_id, parent_body_id, orbit_radius, radius, type FROM game_bodies
    WHERE game_id='gfar_on' AND template_id IN ('binary_barycenter','verdant','cygnus_x','crimson')`)
  .all()).results ?? [];
const byId = new Map(geo.map(r => [r.template_id, r]));
check('the barycenter is heliocentric and far out',
  byId.get('binary_barycenter')?.parent_body_id?.endsWith(':sol')
  && byId.get('binary_barycenter').orbit_radius > 60000,
  JSON.stringify(byId.get('binary_barycenter')));
check('its worlds orbit IT, at their own local radii',
  byId.get('verdant')?.parent_body_id?.endsWith(':binary_barycenter')
  && byId.get('verdant').orbit_radius < 1000,
  JSON.stringify(byId.get('verdant')));
check('the black hole kept its type through the seed',
  byId.get('cygnus_x')?.type === 'black_hole', byId.get('cygnus_x')?.type);
check('the gas giant kept the server spelling',
  byId.get('crimson')?.type === 'gas-giant', byId.get('crimson')?.type);

console.log(bad === 0 ? '\nALL FAR SYSTEM CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
