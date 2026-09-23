// ============================================================
// STARTING RESOURCES — what every empire opens with, founder or not.
//
// Lorne, 2026-09-22: "Double starting credits and metal." 300 -> 600
// each, as configured defaults.
//
// The second half of this file is the bug that doubling exposed.
// seedLateFaction's own comment promises "the same starting resources
// as the founders" and then bound STARTING_RESOURCES — the fallback
// constant for an unreadable config, not the configured value. A player
// joining a live game opened with 100 metal / 100 credits against the
// founders' 300, a third of the stake, in a game already under way.
// Nothing tested the amount, so the comment and the code disagreed in
// silence.
//
// Run: node sim/startingResources.mjs
// ============================================================

import { seedGameWorld, seedLateFaction, STARTING_BODY_OPTIONS } from '../worker/factions.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { defaults } from '../worker/configSchema.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const CFG = defaults();
const WANT_METAL = Number(CFG.starting_metal);
const WANT_GOLD = Number(CFG.starting_credits);

check('the configured start is doubled (600 each)',
  WANT_METAL === 600 && WANT_GOLD === 600, `${WANT_METAL}M / ${WANT_GOLD}C`);

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
const G = 'gstart01';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('u0','a@t','Founder','x',0)`).run();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('u1','b@t','Founder2','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'Start Test','u0',0,0)`).bind(G).run();
// 'setup' or seedGameWorld early-returns and seeds nothing at all.
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                  VALUES (?, 'setup','start-seed',0,0)`).bind(G).run();
for (const [i, uid] of ['u0', 'u1'].entries()) {
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)`)
    .bind(G, uid, i).run();
}
await seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();

const founders = (await DB.prepare(
  `SELECT id, metal, gold FROM game_factions WHERE game_id=? ORDER BY slot`).bind(G).all()).results ?? [];
check('the game actually seeded founders', founders.length === 2, String(founders.length));
for (const f of founders) {
  check(`founder ${f.id.slice(-2)} opens with the configured purse`,
    Number(f.metal) === WANT_METAL && Number(f.gold) === WANT_GOLD,
    `${f.metal}M / ${f.gold}C, wanted ${WANT_METAL}M / ${WANT_GOLD}C`);
}

// ---- the latecomer ---------------------------------------------------
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('late','l@t','Late','x',0)`).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at) VALUES (?,?,?)`)
  .bind(G, 'late', 99).run();
const owned = new Set(((await DB.prepare(
  `SELECT template_id FROM game_bodies WHERE game_id=? AND owner_faction_id IS NOT NULL`)
  .bind(G).all()).results ?? []).map(r => r.template_id));
const freeBody = STARTING_BODY_OPTIONS.map(o => o.id).find(id => !owned.has(id));
if (!freeBody) throw new Error('no free capital-eligible world for the latecomer');
await seedLateFaction(env, G, 'late', freeBody, {});

const late = await DB.prepare(
  `SELECT metal, gold FROM game_factions WHERE game_id=? AND user_id='late'`).bind(G).first();
check('a late joiner is seated at all', !!late);
check('...and opens with the SAME purse as the founders, not the fallback',
  Number(late?.metal) === WANT_METAL && Number(late?.gold) === WANT_GOLD,
  `${late?.metal}M / ${late?.gold}C, wanted ${WANT_METAL}M / ${WANT_GOLD}C`);

console.log(bad === 0 ? '\nALL STARTING RESOURCE CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
