// ============================================================
// EVERY MIGRATION MUST SURVIVE BEING RUN TWICE.
//
// worker/index.js applies migrations one statement at a time and stamps
// a migration as applied only when ALL of its statements succeed. So a
// migration that fails partway leaves its DDL in place, stays unstamped,
// and gets retried on the next request — where it now collides with the
// rows the first attempt already wrote. It can never succeed again, and
// because handleInit stops at the first failure, EVERY LATER MIGRATION
// IS BLOCKED BEHIND IT.
//
// That is not hypothetical. 0089 wedged exactly this way on production:
// its tables existed, its backfill had partly run, and every request
// since had been failing to apply it — so 0090 and 0091 never landed,
// and a player sending a trade offer got
// "table trade_offers has no column named offered_ship_id".
//
// This applies the whole bundle, seeds the shapes a backfill would
// touch, then applies the whole bundle AGAIN with the same
// statement-splitting and the same not-fatal rules the worker uses.
//
// Run: npm run sim:migrations
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

// Mirrors worker/index.js handleInit exactly — same split, same set of
// errors treated as already-applied artifacts.
const NOT_FATAL_RE = /duplicate column|already exists|no such column.*to drop/i;
const statementsOf = (sql) => sql
  .split(/;\s*(?:\r?\n|$)/)
  .map(s => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(s => s.length > 0);

function applyAll(db, { label }) {
  const failures = [];
  for (const m of MIGRATIONS) {
    for (const stmt of statementsOf(m.sql)) {
      try {
        db.db.exec(stmt);
      } catch (e) {
        const msg = String(e?.message || e);
        if (NOT_FATAL_RE.test(msg)) continue;
        failures.push({ migration: m.name, error: msg, stmt: stmt.slice(0, 120) });
        break;                      // handleInit stops this migration here
      }
    }
  }
  if (failures.length) {
    console.log(`  [${label}] ${failures.length} migration(s) failed:`);
    for (const f of failures.slice(0, 6)) {
      console.log(`    ${f.migration}\n      ${f.error}\n      ${f.stmt}`);
    }
  }
  return failures;
}

const DB = new SimD1(':memory:');

// ---- first application, on an empty database ----
const first = applyAll(DB, { label: 'first run' });
check('the bundle applies cleanly to a fresh database', first.length === 0,
  first.map(f => f.migration).join(', '));

// ---- seed the shapes a backfill touches ----
// A migration that only ever meets an EMPTY table looks idempotent even
// when it isn't; the collisions come from rows.
const G = 'gmigrerun1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'Rerun','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'active','seed',5,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO game_factions (id, game_id, slot, name, color, user_id, capital_body_id,
                    metal, fuel, gold, science, status, joined_at)
                  VALUES (?, ?, 0, 'A', '#fff', 'uA', ?, 100, 0, 100, 0, 'active', 0)`)
  .bind(`${G}:f0`, G, `${G}:earth`).run();
await DB.prepare(`INSERT INTO game_bodies (id, game_id, template_id, name, type, radius, mu, angle0, color)
                  VALUES (?, ?, 'earth', 'Earth', 'terrestrial', 1, 1, 0, '#888')`)
  .bind(`${G}:earth`, G).run();
await DB.prepare(`INSERT INTO game_bodies (id, game_id, template_id, name, type, radius, mu, angle0, color)
                  VALUES (?, ?, 'mars', 'Mars', 'terrestrial', 1, 1, 0, '#888')`)
  .bind(`${G}:mars`, G).run();
await DB.prepare(
  `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES ('ship_mig1', ?, ?, 'Hauler', 'freighter', ?, 2,2,0,0,0,1, 9,9,'active',0, 60,60, 0)`,
).bind(G, `${G}:f0`, `${G}:earth`).run();
await DB.prepare(
  `INSERT INTO game_trade_routes
     (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
      status, kind, cargo_fuel, cargo_metal, cargo_gold, cargo_science, created_at_tick)
   VALUES ('rt_mig1', ?, ?, 'ship_mig1', ?, ?, 'outbound', 'logistics', 0, 25, 0, 0, 1)`,
).bind(G, `${G}:f0`, `${G}:earth`, `${G}:mars`).run();

// ---- an ORPHANED route: the row production actually had ----
// A route whose game is gone. Foreign keys are ON in this harness (as
// they are in D1), so the only way to create one is the same way
// production got them: with enforcement off. Backfills that touch a
// NOT NULL ... REFERENCES column must skip these, because a FOREIGN KEY
// failure is NOT suppressed by INSERT OR IGNORE — that is exactly how
// 0089 wedged, and no sim could see it because no sim had an orphan.
DB.db.exec('PRAGMA foreign_keys = OFF');
await DB.prepare(
  `INSERT INTO game_trade_routes
     (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
      status, kind, cargo_fuel, cargo_metal, cargo_gold, cargo_science, created_at_tick)
   VALUES ('rt_orphan', 'gdeleted999', 'gdeleted999:f0', 'ship_gone',
           'gdeleted999:earth', 'gdeleted999:mars', 'returning', 'logistics', 0,0,0,0, 1)`,
).run();
DB.db.exec('PRAGMA foreign_keys = ON');

const stopsBefore = (await DB.prepare(
  'SELECT COUNT(*) n FROM game_trade_route_stops').first()).n;
const crewBefore = (await DB.prepare(
  'SELECT COUNT(*) n FROM game_trade_route_ships').first()).n;

// ---- second application, WITH data present ----
const second = applyAll(DB, { label: 'second run' });
check('THE WHOLE BUNDLE RE-APPLIES over a populated database',
  second.length === 0,
  second.map(f => `${f.migration}: ${f.error}`).join(' | '));

const stopsAfter = (await DB.prepare(
  'SELECT COUNT(*) n FROM game_trade_route_stops').first()).n;
const crewAfter = (await DB.prepare(
  'SELECT COUNT(*) n FROM game_trade_route_ships').first()).n;
check('a re-run does not duplicate backfilled stops',
  stopsAfter === stopsBefore + 2 || stopsAfter === stopsBefore,
  `${stopsBefore} -> ${stopsAfter}`);
check('a re-run does not duplicate backfilled crew',
  crewAfter === crewBefore + 1 || crewAfter === crewBefore,
  `${crewBefore} -> ${crewAfter}`);

check('an ORPHANED route is skipped, not migrated',
  (await DB.prepare(
    "SELECT COUNT(*) n FROM game_trade_route_stops WHERE route_id = 'rt_orphan'").first()).n === 0);

// ---- and a third, because a wedged migration retries forever ----
const third = applyAll(DB, { label: 'third run' });
check('...and again, because a retry loop runs on EVERY request',
  third.length === 0, third.map(f => f.migration).join(', '));

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
