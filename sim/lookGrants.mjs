// ============================================================
// LOOK GRANTS (0166) — narrowing the free ship looks, fairly.
//
// On 2026-10-15 the free looks went from A-I to A and B on every hull.
// Anyone who had already built with a look that became paid keeps it,
// for that hull class. This checks the cutover against a real SQLite:
//
//   - the snapshot finds looks in ships (live, destroyed, finished
//     games), in-game designs, the build queue and account templates
//   - it grants only C-I (J-Z were always paid), never A/B, never a
//     ship with no player (AI)
//   - a grant is per hull class: G kept on corvettes is not G on frigates
//   - the snapshot reruns safely (OR IGNORE): a second pass adds only
//     what is new, which is how a straggler built mid-deploy is caught
//   - the save validator honours a grant; the pickers' list matches
//
// Run: node sim/lookGrants.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { validateIconVariant, lookGrants } from '../worker/store.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
const run = (sql, ...a) => DB.prepare(sql).bind(...a).run();
// Rooms, bodies and the rest of a real game are beside the point here.
await DB.prepare('PRAGMA foreign_keys = OFF').run();

for (const id of ['ann', 'bo', 'cy', 'dee', 'paid']) {
  await run('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,0)', id, `${id}@t`, id, 'x');
}
await run(`INSERT INTO user_entitlements (user_id, sku, source, granted_at) VALUES ('paid','cosmetics_v1','stripe',0)`);
for (const [g, status] of [['g1', 'active'], ['g2', 'completed']]) {
  await run(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at) VALUES (?,?,'s',5,60000,0)`, g, status);
}
let slot = 0;
const faction = async (g, user) => {
  const id = `${g}:f${slot}`;
  await run(`INSERT INTO game_factions (id,game_id,user_id,name,color,slot,status,joined_at) VALUES (?,?,?,?,?,?,'active',0)`,
    id, g, user, `E${slot}`, '#4ecdc4', slot++);
  return id;
};
const fAnn = await faction('g1', 'ann');
const fBo = await faction('g1', 'bo');
const fAi = await faction('g1', null);
const fCyOld = await faction('g2', 'cy');
const fDee = await faction('g1', 'dee');

let n = 0;
const ship = (f, cls, v, extra = {}) => run(
  `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, icon_variant, destroyed_at_tick)
   VALUES (?,?,?,?,?,'earth', 2,2,0,0,0,1, 99,99,?,0, 300,300,10,?,?)`,
  `s${n++}`, f.split(':')[0], f, `S${n}`, cls, extra.status ?? 'active', v, extra.destroyed ?? null);

await ship(fAnn, 'corvette', 'G');                 // granted
await ship(fAnn, 'corvette', 'G');                 // duplicate, one grant
await ship(fAnn, 'frigate', 'B');                  // free, no grant
await ship(fAnn, 'frigate', null);                 // default, no grant
await ship(fAnn, 'destroyer', 'J');                // always paid, no grant
await ship(fBo, 'freighter', 'D', { destroyed: 4, status: 'destroyed' }); // lost hulls count too
await ship(fAi, 'corvette', 'E');                  // AI: nobody to grant
await ship(fCyOld, 'colony', 'H');                 // a finished game counts
await run(`INSERT INTO game_ship_designs (id, game_id, faction_id, ship_class, name, parts_json, icon_variant, is_active, created_at_ms)
           VALUES ('d1','g1',?,'frigate','Lancer','[]','I',1,0)`, fBo);
await run(`INSERT INTO game_body_build_queue (id, game_id, body_id, faction_id, ship_class, queued_at_tick, completes_at_tick, icon_variant, status)
           VALUES ('q1','g1','earth',?,'destroyer',1,9,'F','waiting')`, fDee);
await run(`INSERT INTO user_ship_templates (id, user_id, name, ship_class, parts_json, icon_variant, created_at_ms)
           VALUES ('t1','cy','Old faithful','corvette','[]','C',0)`);

// The cutover: rerun 0166 exactly as the worker's migration runner does.
const m = MIGRATIONS.find(x => x.name === '0166_look_grants.sql');
const snapshot = async () => {
  for (const stmt of m.sql.split(/;\s*(?:\r?\n|$)/).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
    await DB.prepare(stmt).run();
  }
};
await snapshot();

const all = async () => (await DB.prepare('SELECT user_id, ship_class, variant FROM user_look_grants ORDER BY 1,2,3').all())
  .results.map(r => `${r.user_id}:${r.ship_class}:${r.variant}`);
const want = ['ann:corvette:G', 'bo:freighter:D', 'bo:frigate:I', 'cy:colony:H', 'cy:corvette:C', 'dee:destroyer:F'];
let got = await all();
check('the snapshot grants exactly the C-I looks players built with, one row each', JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}`);
check('...from ships, destroyed ships, a finished game, a design, the build queue and a template',
  ['bo:freighter:D', 'cy:colony:H', 'bo:frigate:I', 'dee:destroyer:F', 'cy:corvette:C'].every(g => got.includes(g)));
check('...never a free look, an always-paid look, or an AI hull',
  !got.some(g => /:(A|B|J)$/.test(g)) && !got.some(g => g.startsWith('null')));

// A straggler built with the old rules mid-deploy is caught by a rerun.
await ship(fAnn, 'frigate', 'E');
await snapshot();
got = await all();
check('a rerun adds only the new look and duplicates nothing', got.length === want.length + 1 && got.includes('ann:frigate:E'),
  JSON.stringify(got));

// The rule at save time, against the real table.
check('ann keeps corvette G', (await validateIconVariant(env, 'ann', 'G', 'corvette')) === null);
check('...but G on a frigate needs the Commission', (await validateIconVariant(env, 'ann', 'G', 'frigate'))?.code === 'premium_required');
check('a player with no history: C-I need the Commission now', (await validateIconVariant(env, 'paid-not', 'D', 'corvette'))?.code === 'premium_required');
check('A and B stay free for everyone', (await validateIconVariant(env, 'bo', 'A', 'colony')) === null
  && (await validateIconVariant(env, 'bo', 'B', 'destroyer')) === null);
check('a Commission holder may pick anything', (await validateIconVariant(env, 'paid', 'H', 'freighter')) === null);
check("the pickers' list is the player's grants", JSON.stringify(await lookGrants(env, 'bo')) === JSON.stringify(['freighter:D', 'frigate:I']),
  JSON.stringify(await lookGrants(env, 'bo')));
check('no grants is an empty list, not an error', (await lookGrants(env, 'paid')).length === 0);

console.log(bad === 0 ? '\nALL LOOK GRANT CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
