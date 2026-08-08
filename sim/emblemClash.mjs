// ============================================================
// Faction emblem uniqueness — seeds REAL games through
// seedGameWorld and asserts no two factions fly the same shape.
//
// This exists because colour shipped exactly this bug and the test
// that would have caught it didn't exist until after (sim/colorClash.mjs).
// The failure was never "two players picked the same thing" — the lobby
// blocks that. It was a DEFAULT being handed to a no-picker out of the
// same catalog the picker offers, landing on a colour someone had
// already explicitly chosen. Emblems have the identical structure, so
// they get the identical test, written BEFORE anyone plays a game.
//
// Emblems are strictly easier than colour in one way and harder in
// another:
//   EASIER  24 ids vs a max_players cap of 8 — a free one always
//           exists, so this never degrades to "closest available".
//   HARDER  exact-match uniqueness, no tolerance band to hide behind.
//           Either the ids differ or the test fails.
//
// Run: npm run sim:emblems
// ============================================================

import { seedGameWorld, seedLateFaction, STARTING_BODY_OPTIONS } from '../worker/factions.js';
import { EMBLEM_IDS } from '../worker/emblems.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

/** picks: array of (emblemId | null), one per member, in join order. */
async function seedWith(picks, label) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  const G = 'gemblem';
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('host','h@t','Host','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Emblem Test','host',0,0)`).bind(G).run();
  // status MUST be 'setup' — seedGameWorld early-returns on anything
  // else, and colorClash's first draft seeded 'lobby', created zero
  // factions, and printed PASS over an empty set.
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'setup','emblem-seed',0,0)`).bind(G).run();
  for (let i = 0; i < picks.length; i++) {
    const uid = `u${i}`;
    if (i > 0) {
      await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                        VALUES (?,?,?,'x',0)`).bind(uid, `${uid}@t`, `P${i}`).run();
    }
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,emblem)
                      VALUES (?,?,?,?)`)
      .bind(G, i === 0 ? 'host' : uid, i, picks[i]).run();
  }
  await seedGameWorld(env, G);
  const rows = (await DB.prepare(
    `SELECT slot, emblem FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results ?? [];
  const got = rows.map(r => r.emblem);

  const problems = [];
  // 1) HARD: no duplicates. This is the whole feature.
  const seen = new Map();
  got.forEach((e, i) => {
    if (seen.has(e)) problems.push(`DUPLICATE slot${seen.get(e)} and slot${i} both fly ${e}`);
    else seen.set(e, i);
  });
  // 2) Every faction must actually HAVE one. A null emblem renders as a
  //    fallback shape that no uniqueness rule governs, so two nulls in
  //    the same game can collide invisibly at draw time — the exact
  //    "optional field with a sensible fallback" trap that has bitten
  //    this codebase before (missing `variant`, missing gate ids).
  got.forEach((e, i) => { if (!e) problems.push(`slot${i} has no emblem`); });
  // 3) Only catalog ids may be stored.
  got.forEach((e, i) => {
    if (e && !EMBLEM_IDS.includes(e)) problems.push(`slot${i} has unknown emblem ${e}`);
  });
  // 4) An explicit pick must be honoured exactly — a fix must not
  //    "resolve" a collision by overriding what a player chose.
  picks.forEach((p, i) => {
    if (p && got[i] !== p) problems.push(`slot${i} asked for ${p}, got ${got[i]}`);
  });
  // 5) Zero factions must never read as a pass.
  if (got.length !== picks.length) {
    problems.push(`expected ${picks.length} factions, seeded ${got.length}`);
  }

  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        picks:  ${picks.map(p => p ?? '—').join(' ')}`);
  console.log(`        result: ${got.join(' ')}`);
  for (const p of problems) console.log(`        ${p}`);
  return ok;
}

/** Seed a game, then walk a latecomer in through seedLateFaction. */
async function lateJoin(picks, latePick, label) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB };
  const G = 'glate';
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES ('host','h@t','Host','x',0)`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Late Test','host',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'setup','late-seed',0,0)`).bind(G).run();
  for (let i = 0; i < picks.length; i++) {
    const uid = i === 0 ? 'host' : `u${i}`;
    if (i > 0) {
      await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                        VALUES (?,?,?,'x',0)`).bind(uid, `${uid}@t`, `P${i}`).run();
    }
    await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,emblem)
                      VALUES (?,?,?,?)`).bind(G, uid, i, picks[i]).run();
  }
  await seedGameWorld(env, G);

  // The latecomer joins the ROOM (so the lobby's uniqueness check saw
  // only room_members) and then gets seated in the running game.
  const lateId = 'ulate';
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                    VALUES (?,?,?,'x',0)`).bind(lateId, 'late@t', 'Late').run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,emblem)
                    VALUES (?,?,?,?)`).bind(G, lateId, 99, latePick).run();
  // A latecomer must name an unclaimed capital-eligible world. The
  // seeded factions already own several, so find one that's still free
  // rather than hardcoding a template id that a 3-player seed might
  // happen to have taken.
  const owned = new Set(((await DB.prepare(
    `SELECT template_id FROM game_bodies WHERE game_id = ? AND owner_faction_id IS NOT NULL`)
    .bind(G).all()).results ?? []).map(r => r.template_id));
  const freeBody = STARTING_BODY_OPTIONS.map(o => o.id).find(id => !owned.has(id));
  if (!freeBody) throw new Error('no free capital-eligible world for the latecomer');
  await seedLateFaction(env, G, lateId, freeBody, {});

  const got = ((await DB.prepare(
    `SELECT slot, emblem FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results ?? [])
    .map(r => r.emblem);

  const problems = [];
  const seen = new Map();
  got.forEach((e, i) => {
    if (seen.has(e)) problems.push(`DUPLICATE slot${seen.get(e)} and slot${i} both fly ${e}`);
    else seen.set(e, i);
  });
  got.forEach((e, i) => { if (!e) problems.push(`slot${i} has no emblem`); });
  if (got.length !== picks.length + 1) {
    problems.push(`expected ${picks.length + 1} factions, got ${got.length}`);
  }

  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        seeded: ${picks.map(p => p ?? '—').join(' ')}  late pick: ${latePick ?? '—'}`);
  console.log(`        result: ${got.join(' ')}`);
  for (const p of problems) console.log(`        ${p}`);
  return ok;
}

let bad = 0;

// THE COLOUR BUG, ported: someone explicitly picks the emblem that a
// later slot's DEFAULT rotation would otherwise hand out. Slot 0's
// default is EMBLEM_IDS[0]; give it to slot 3 as a pick and make slot 0
// a no-picker.
if (!await seedWith([null, null, null, EMBLEM_IDS[0], null],
  'someone picks the emblem slot 0 gets by default')) bad++;

// The mirror: an early slot picks a LATE slot's default.
if (!await seedWith([EMBLEM_IDS[5], null, null, null, null, null],
  'someone picks the emblem slot 5 gets by default')) bad++;

// Several picks scattered through the catalog, interleaved with defaults.
if (!await seedWith([EMBLEM_IDS[7], null, EMBLEM_IDS[1], null, EMBLEM_IDS[12], null],
  'multiple picks interleaved with defaults')) bad++;

// Nobody picks — the plain rotation must still come out clean.
if (!await seedWith([null, null, null, null], 'nobody picks (rotation only)')) bad++;

// Full house of no-pickers. 8 seats, 24 ids.
if (!await seedWith(Array(8).fill(null), 'eight players, all defaults')) bad++;

// Everyone picks, all distinct — nothing may be reassigned.
if (!await seedWith(EMBLEM_IDS.slice(0, 6), 'everyone picks, all distinct')) bad++;

// A pick sitting at the very end of the catalog, where the modulo wrap
// in defaultEmblemFor has to come all the way around to reach it.
if (!await seedWith([null, null, EMBLEM_IDS[EMBLEM_IDS.length - 1]],
  'a pick at the end of the catalog (wrap-around)')) bad++;

// LATE JOIN: the latecomer's lobby pick is legal against room_members
// (nobody in the room picked it) but a seeded faction took it as a
// DEFAULT — so the game already flies it. The pick must lose.
if (!await lateJoin([null, null, null], EMBLEM_IDS[1],
  'latecomer picks an emblem a DEFAULT already took in-game')) bad++;

// LATE JOIN: a genuinely free pick must be honoured.
if (!await lateJoin([null, null], EMBLEM_IDS[20],
  'latecomer picks a free emblem')) bad++;

// LATE JOIN: no pick at all.
if (!await lateJoin([null, null, null], null, 'latecomer picks nothing')) bad++;

console.log('');
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('no two factions fly the same emblem');
