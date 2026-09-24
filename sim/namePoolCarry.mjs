// ============================================================
// namePoolCarry — a name bank follows the player into the next game.
//
//   npm run sim:namepoolcarry
//
// 2026-09-24: a player uploaded hundreds of names for one match and had
// to upload them all again for the next, because banks lived on the
// lobby row. Checked against the real schema, since the failure modes
// are all in who-gets-what:
//
//   the NEWEST bank with names in it, not an older one, not an empty one
//   never over a list already made in this lobby
//   never refilling a list the player deliberately cleared
//   a late joiner's FACTION gets it too (the running game reads that)
//   the history lists only the caller's own banks
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { carryNamePools, handleNamePoolHistory } from '../worker/namePoolHistory.js';
import { parseNamePools } from '../src/game/namePools.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const statementsOf = (sql) => sql.split(/;\s*(?:\r?\n|$)/)
  .map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
const db = new SimD1();
for (const m of MIGRATIONS) for (const s of statementsOf(m.sql)) { try { db.db.exec(s); } catch { /* re-runs */ } }
db.db.exec('PRAGMA foreign_keys = OFF');
const run = (sql, ...a) => db.db.prepare(sql).run(...a);
const env = { DB: db };

const bank = (n, tag) => JSON.stringify({
  ship: Array.from({ length: n }, (_, i) => `${tag} Ship ${i}`),
  captain: [`${tag} Captain`], station: [], city: [`${tag} City`],
});
const EMPTY = JSON.stringify({ ship: [], captain: [], station: [], city: [] });

const NOW = Date.now();
run(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'a@x', 'A', 'x', ?), ('u2', 'b@x', 'B', 'x', ?)`, NOW, NOW);
let ri = 0;
const room = (id, name) => run(
  `INSERT INTO rooms (id, name, host_id, status, created_at, updated_at) VALUES (?, ?, 'u1', 'lobby', ?, ?)`,
  id, name, NOW + ri, NOW + ri++);
const member = (roomId, user, joinedAt, pools) => run(
  `INSERT INTO room_members (room_id, user_id, joined_at, name_pools) VALUES (?, ?, ?, ?)`,
  roomId, user, joinedAt, pools);
const poolsOf = (roomId, user) =>
  db.db.prepare(`SELECT name_pools FROM room_members WHERE room_id = ? AND user_id = ?`).get(roomId, user)?.name_pools ?? null;

// u1's history: an old big bank, a newer smaller one, then a lobby they
// joined and cleared, and one where they never touched the editor.
room('old', 'The Long War');     member('old', 'u1', 1000, bank(300, 'Old'));
room('mid', 'Second Front');     member('mid', 'u1', 2000, bank(40, 'Mid'));
room('clr', 'Cleared Lobby');    member('clr', 'u1', 3000, EMPTY);
room('nul', 'Untouched');        member('nul', 'u1', 4000, null);
room('dup', 'Rematch');          member('dup', 'u1', 1500, bank(40, 'Mid'));
// Somebody else's bank, newer than all of u1's.
room('oth', 'Their Game');       member('oth', 'u2', 9000, bank(12, 'Theirs'));

// ---- joining a new lobby -------------------------------------------
room('new', 'New Game');
member('new', 'u1', 5000, null);
await carryNamePools(env, 'new', 'u1');
{
  const p = parseNamePools(poolsOf('new', 'u1'));
  check('a new lobby starts with the newest bank that has names (Second Front)',
    p.ship.length === 40 && p.ship[0] === 'Mid Ship 0', `${p.ship.length} ships, first ${p.ship[0]}`);
  check('...all four lists, not just ships', p.captain[0] === 'Mid Captain' && p.city[0] === 'Mid City');
}

// ---- never over a list made here -----------------------------------
room('own', 'Own Names');
member('own', 'u1', 5100, bank(3, 'Own'));
await carryNamePools(env, 'own', 'u1');
check('a lobby that already has names keeps them', parseNamePools(poolsOf('own', 'u1')).ship[0] === 'Own Ship 0');

// ---- never refill a deliberate clear -------------------------------
await carryNamePools(env, 'clr', 'u1');
check('a list the player emptied stays empty', poolsOf('clr', 'u1') === EMPTY, poolsOf('clr', 'u1'));

// ---- a player with no past banks -----------------------------------
run(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u3', 'c@x', 'C', 'x', ?)`, NOW);
member('new', 'u3', 5200, null);
await carryNamePools(env, 'new', 'u3');
check('a first-time player gets nothing (NULL, the game\'s own names)', poolsOf('new', 'u3') === null);

// ---- late join into a running game ---------------------------------
room('run', 'Running');
member('run', 'u1', 6000, null);
run(`INSERT INTO game_factions (id, game_id, user_id, slot, name, color, joined_at) VALUES ('run:f1', 'run', 'u1', 1, 'Late', '#888888', ?)`, NOW);
await carryNamePools(env, 'run', 'u1');
{
  const f = db.db.prepare(`SELECT name_pools FROM game_factions WHERE id = 'run:f1'`).get();
  // Newest bank with names by now is 'Own Names' (joined 5100).
  check('a late joiner\'s faction gets the bank the running game reads',
    parseNamePools(f.name_pools).ship[0] === 'Own Ship 0', f.name_pools);
}

// ---- the history the editor offers ---------------------------------
{
  const res = await handleNamePoolHistory(
    new Request('https://x/api/lobby/name-pools/history?exclude=new'), env, { session: { user_id: 'u1' } });
  const { banks } = await res.json();
  const names = banks.map(b => b.room_name);
  check('history is newest first', names[0] === 'Running' || names[0] === 'Own Names', names.join(' | '));
  check('the lobby asking is left out', !banks.some(b => b.room_id === 'new'));
  check('empty banks are left out', !names.includes('Cleared Lobby') && !names.includes('Untouched'));
  check('an identical bank is listed once (Rematch = Second Front)',
    names.filter(n => n === 'Second Front' || n === 'Rematch').length === 1, names.join(' | '));
  check('the big old bank is offered', banks.some(b => b.room_name === 'The Long War' && b.counts.ship === 300));
  check('nobody else\'s bank is offered', !names.includes('Their Game'));
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
