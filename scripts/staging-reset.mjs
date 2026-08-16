// ============================================================
// staging-reset — empty the staging world, keep the logins.
//
//   npm run staging:reset            (asks first)
//   npm run staging:reset -- --yes   (for scripts and agents)
//
// WHY THIS EXISTS. Testing a tick-based game means accumulating junk:
// half-finished games, ships mid-burn, trade deals from three
// experiments ago. Wiping it by hand is a dozen SQL statements in
// dependency order, and getting that order wrong leaves orphaned rows
// that behave like ghosts — a route with no game, a ship with no
// faction. Migration 0089 wedged production for weeks over exactly that
// kind of orphan.
//
// WHAT IT KEEPS. `users` and `sessions` survive, so you do not
// re-register a test account every time. Everything world-shaped goes.
//
// WHAT PROTECTS PRODUCTION. The database name is hard-coded, there is
// no flag to point this at another database, and it refuses to run if
// the name it is about to hit is not the staging one. A reset script
// with a --database argument is one tab-completion away from being the
// worst afternoon of your year.
// ============================================================

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const DB = 'orbital-staging';

// Deepest dependants first. FKs are ON in D1, so a wrong order fails
// loudly rather than leaving orphans — but ordering it correctly means
// the whole thing runs as one clean pass.
const TABLES = [
  'game_trade_route_ships',
  'game_trade_route_stops',
  'game_trade_routes',
  'trade_deliveries',
  'trade_agreements',
  'trade_offers',
  'game_ship_nodes',
  'game_ships',
  'game_settlements',
  'game_bodies',
  'game_captains',
  'game_fleets',
  'faction_techs',
  'game_factions',
  'chronicle_entries',
  'senate_bills',
  'senate_votes',
  'game_events',
  'room_members',
  'games',
  'rooms',
];

const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');

// execSync, not execFileSync: on Windows, Node refuses to spawn a .cmd
// shim directly (EINVAL) since the 20.x argument-injection fix, and
// `npx` IS a .cmd there. Running it through a shell is the portable
// route. Safe from injection because `sql` is only ever built from the
// hard-coded TABLES list below — never from input.
const run = (sql) => execSync(
  `npx wrangler d1 execute ${DB} --remote --command "${sql}"`,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

if (DB !== 'orbital-staging') {
  console.error('refusing to run against anything but orbital-staging');
  process.exit(1);
}

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(
    `Wipe every game, room, ship and trade on ${DB}? Logins are kept. [y/N] `);
  rl.close();
  if (a.trim().toLowerCase() !== 'y') {
    console.log('cancelled');
    process.exit(0);
  }
}

let wiped = 0;
for (const t of TABLES) {
  try {
    run(`DELETE FROM ${t}`);
    wiped += 1;
  } catch (e) {
    // A table that does not exist yet is fine: staging may be younger
    // than the migration that creates it. Anything else is worth seeing.
    const msg = String(e.stderr ?? e.message ?? e);
    if (/no such table/i.test(msg)) continue;
    console.error(`\n${t}: ${msg.split('\n').slice(0, 3).join(' ')}`);
  }
}

console.log(`\n${wiped} tables cleared on ${DB}. Logins kept.`);
console.log('The next request rebuilds schema as needed (ensureMigrated).');
