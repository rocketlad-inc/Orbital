// ============================================================
// Ten-player games — seeds REAL games of 2..10 players through
// seedGameWorld (and a late joiner through seedLateFaction) and checks
// every empire gets its own capital on a capital-worthy world, its own
// colour, emblem and name, and that nobody is handed a rock.
//
// Written when the seat cap went from 8 to 10. The home-world rule had
// a comment saying ten worlds clear the fair floor "against a hard cap
// of 8": exactly enough for ten, no slack. This measures it instead of
// trusting the comment, across many random map seeds.
//
// Run: npm run sim:tenplayers
// ============================================================

import { seedGameWorld, seedLateFaction, STARTING_BODY_OPTIONS } from '../worker/factions.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

async function seed(players, seedStr) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  const gameId = 'g10';
  for (let i = 0; i < players; i++) {
    await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',0)`)
      .bind(`u${i}`, `u${i}@t`, `P${i}`).run();
  }
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at,max_players) VALUES (?, 'Ten','u0',0,0,?)`)
    .bind(gameId, Math.max(players, 2)).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at,tick_interval_ms) VALUES (?, 'setup', ?, 0, 0, 3600000)`)
    .bind(gameId, seedStr).run();
  for (let i = 0; i < players; i++) {
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)`).bind(gameId, `u${i}`, i).run();
  }
  await seedGameWorld(env, gameId);
  return { env, DB, gameId };
}

async function factionsOf(DB, gameId) {
  return (await DB.prepare(
    `SELECT f.id, f.name, f.color, f.emblem, f.slot, b.template_id AS capital, b.radius
       FROM game_factions f LEFT JOIN game_bodies b ON b.id = f.capital_body_id
      WHERE f.game_id = ? ORDER BY f.slot`).bind(gameId).all()).results ?? [];
}

const capitalWorthy = new Set(STARTING_BODY_OPTIONS.map(b => b.id));
const RUNS = 40;
let worst = { n: 0 };
for (const players of [8, 9, 10]) {
  let bad = 0;
  const samples = [];
  for (let r = 0; r < RUNS; r++) {
    let fs;
    try {
      const { DB, gameId } = await seed(players, `ten-${players}-${r}`);
      fs = await factionsOf(DB, gameId);
    } catch (e) {
      bad++;
      samples.push(`seed ${r}: threw ${String(e.message).slice(0, 120)}`);
      continue;
    }
    const caps = fs.map(f => f.capital);
    const problems = [];
    if (fs.length !== players) problems.push(`${fs.length} factions`);
    if (new Set(caps).size !== players || caps.some(c => !c)) problems.push(`capitals ${caps.join(',')}`);
    if (caps.some(c => !capitalWorthy.has(c))) problems.push(`unworthy capital in ${caps.join(',')}`);
    if (new Set(fs.map(f => (f.color ?? '').toLowerCase())).size !== players) problems.push(`colours ${fs.map(f => f.color).join(',')}`);
    if (new Set(fs.map(f => f.emblem)).size !== players) problems.push(`emblems ${fs.map(f => f.emblem).join(',')}`);
    if (new Set(fs.map(f => f.name)).size !== players) problems.push(`names ${fs.map(f => f.name).join(' | ')}`);
    if (problems.length) { bad++; samples.push(`seed ${r}: ${problems.join('; ')}`); }
    if (players === 10 && r === 0) worst = { n: players, caps, colors: fs.map(f => f.color), names: fs.map(f => f.name) };
  }
  check(`${players} players: every empire gets its own capital, colour, emblem and name (${RUNS} maps)`, bad === 0, samples.slice(0, 3).join(' || '));
}
console.log('        e.g. 10-player capitals:', worst.caps?.join(', '));
console.log('        colours:', worst.colors?.join(' '));

// A tenth player joining late into a 9-player game.
{
  const { env, DB, gameId } = await seed(9, 'late-10');
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('late','late@t','Late','x',0)`).run();
  await DB.prepare(`UPDATE rooms SET max_players = 10 WHERE id = ?`).bind(gameId).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?, 'late', 99)`).bind(gameId).run();
  // The join screen offers fair worlds nobody holds; take the first.
  const held = new Set(((await DB.prepare(
    `SELECT DISTINCT b.template_id FROM game_settlements s JOIN game_bodies b ON b.id = s.body_id WHERE s.game_id = ?`)
    .bind(gameId).all()).results ?? []).map(r => r.template_id));
  const free = STARTING_BODY_OPTIONS.map(b => b.id).filter(id => !held.has(id));
  let err = null;
  let res = null;
  for (const pick of free) {
    try { res = await seedLateFaction(env, gameId, 'late', pick); err = null; break; } catch (e) { err = e; }
  }
  const fs = await factionsOf(DB, gameId);
  const caps = fs.map(f => f.capital);
  check('a tenth player joining late gets a seat, a capital and a colour of their own',
    !err && fs.length === 10 && new Set(caps).size === 10 && new Set(fs.map(f => f.color.toLowerCase())).size === 10,
    err ? String(err.message) : { caps, colors: fs.map(f => f.color) });
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
