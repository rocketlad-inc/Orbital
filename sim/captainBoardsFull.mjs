// ============================================================
// A CAPTAIN BOARDING A FRESH HULL DOES NOT OPEN A REPAIR JOB.
//
// Play for Free playtest (Dale, Priya, 2026-10-24): ships showed
// REPAIRING for ~10 ticks with no damage and no combat. A new hull
// spawns at base x armor; ensureCaptains then boards an officer whose
// rank (+1% each) and Bulwark trait (+10%) raise the hull's effective
// ceiling (worker/state.js hp_max_effective), while HP stayed absolute.
// The hull read below its own max until a station topped it up.
//
// Drives the real ensureCaptains against the real schema and checks:
//   1. a full hull is still full after a Bulwark rank-1 captain boards
//   2. a half-wrecked hull keeps its damage FRACTION, not its HP
//   3. a plain rank-0 captain changes nothing
//
// Run: node sim/captainBoardsFull.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { ensureCaptains } from '../worker/captains.js';

let bad = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
// Seed rows only: the sim checks one pass, not the lobby that makes them.
DB.db.exec('PRAGMA foreign_keys = OFF');

const G = 'g1';
const cols = (table) => DB.db.prepare(`PRAGMA table_info(${table})`).all();
/** Insert a row, filling every NOT NULL column without a default. */
function insert(table, row) {
  const full = { ...row };
  for (const c of cols(table)) {
    if (full[c.name] !== undefined || !c.notnull || c.dflt_value != null || c.pk) continue;
    full[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : '';
  }
  const keys = Object.keys(full);
  DB.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => full[k]));
}

// Three uncaptained hulls of one faction, three captains in its bank.
// The bank hands out longest-waiting first, and the orphan scan puts
// warships first in random order, so each case gets its own faction.
const cases = [
  { f: 'fA', ship: 'sA', hp: 100, hpMax: 100, cap: { rank: 1, traits: ['bulwark'] } },
  { f: 'fB', ship: 'sB', hp: 50, hpMax: 100, cap: { rank: 1, traits: ['bulwark'] } },
  { f: 'fC', ship: 'sC', hp: 100, hpMax: 100, cap: { rank: 0, traits: ['gunner'] } },
];
for (const c of cases) {
  insert('game_ships', {
    id: c.ship, game_id: G, owner_faction_id: c.f, name: c.ship, ship_class: 'corvette',
    status: 'active', hp: c.hp, hp_max: c.hpMax,
  });
  insert('game_captains', {
    id: `cap_${c.ship}`, game_id: G, faction_id: c.f, name: `Captain ${c.ship}`,
    status: 'active', rank: c.cap.rank, traits_json: JSON.stringify(c.cap.traits),
    created_at_tick: 0,
  });
}

await ensureCaptains(DB, G, 5);

const ship = (id) => DB.db.prepare('SELECT hp, captain_id FROM game_ships WHERE id = ?').get(id);
const ceiling = (c) => c.hpMax * (1 + 0.01 * c.cap.rank) * (c.cap.traits.includes('bulwark') ? 1.10 : 1);

const a = ship('sA');
check('the captain boarded', a.captain_id === 'cap_sA', `captain_id=${a.captain_id}`);
check('a full hull is still full after a Bulwark rank-1 captain boards',
  Math.abs(a.hp - ceiling(cases[0])) < 1e-6, `hp=${a.hp} ceiling=${ceiling(cases[0])}`);

const b = ship('sB');
check('a half-wrecked hull keeps its damage fraction',
  Math.abs(b.hp / ceiling(cases[1]) - 0.5) < 1e-6, `hp=${b.hp} ceiling=${ceiling(cases[1])}`);

const c = ship('sC');
check('a rank-0 captain without Bulwark changes nothing', c.hp === 100, `hp=${c.hp}`);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
