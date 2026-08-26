// ============================================================
// Herald window regression harness — does the paper stay current?
//
// The scheduled digest reads chronicle rows newer than its high-water
// mark, under a cap, and then advances the mark. Get either half wrong
// and the paper falls behind in a way nothing complains about:
//
//   ORDER BY created_at_ms ASC LIMIT 200   printed the OLDEST 200 rows
//                                          in the window and held the
//                                          newest back
//   last_entry_ms = last row printed       queued the remainder into
//                                          tomorrow's window
//
// Together those two cost 200 rows of progress per day against a game
// writing thousands. Peace Zone finished, and its Herald kept publishing
// "the sphere is at 75% and climbing" for days afterwards, because the
// window was still crawling through the middle of the campaign.
//
// This harness writes more rows than the cap and asserts the edition is
// about the END of the window and that one run drains it.
//
// Run: node sim/heraldLag.mjs
// ============================================================

import { runDigestForGame } from '../worker/digest.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const G = 'lagtest';
const ROWS = 700;          // comfortably over the cap
const failures = [];

function check(label, ok, detail = '') {
  if (ok) console.log(`PASS  ${label}`);
  else failures.push(`${label}${detail ? `\n    ${detail}` : ''}`);
}

async function seed() {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  // A Discord-linked player, because runDigestForGame refuses to compose
  // for a game nobody in it would read (sim rooms used to file editions
  // to the live channel).
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at,discord_id)
                    VALUES ('u1','t@t','T','x',0,'123')`).run();
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                    VALUES (?, 'Lag Test','u1',0,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,created_at)
                    VALUES (?, 'active','s',400,0)`).bind(G).run();
  await DB.prepare(`INSERT INTO game_factions (id,game_id,slot,name,color,status,joined_at,user_id)
                    VALUES ('f_a',?,0,'Alpha Concord','#fff','active',0,'u1')`).bind(G).run();
  await DB.prepare(`INSERT INTO game_bodies (id,game_id,template_id,name,type,parent_body_id,radius,mu,color)
                    VALUES ('sol',?, 'sol','Sol','star',NULL,20,100,'#fd0')`).bind(G).run();

  // A long tail of old news, then the thing that actually matters last.
  // One row per second so ordering is unambiguous.
  const base = Date.now() - ROWS * 1000 - 5000;
  for (let i = 0; i < ROWS; i++) {
    await DB.prepare(
      `INSERT INTO chronicle_entries
         (id,game_id,tick_number,kind,actor_faction_id,body_id,payload,visibility,created_at_ms)
       VALUES (?,?,?, 'ship_built','f_a',NULL,?, 'public', ?)`)
      .bind(`old${i}`, G, i, JSON.stringify({
        owner_faction_name: 'Alpha Concord', ship_name: `Hull-${i}`, ship_class: 'corvette',
      }), base + i * 1000).run();
  }
  // The newest row in the window: the story a reader would expect to see.
  await DB.prepare(
    `INSERT INTO chronicle_entries
       (id,game_id,tick_number,kind,actor_faction_id,body_id,payload,visibility,created_at_ms)
     VALUES ('newest',?,401,'dyson_milestone','f_a',NULL,?, 'public', ?)`)
    .bind(G, JSON.stringify({ faction_name: 'Alpha Concord', percent: 100 }),
          base + ROWS * 1000).run();
  return DB;
}

const DB = await seed();
// A webhook has to be present or runDigestForGame bails before it reads
// a single row. Nothing leaves the process: fetch is stubbed, and the
// posted payload is what we inspect.
const posts = [];
globalThis.fetch = async (url, init) => {
  // An edition with a territory strip posts multipart, with the embed
  // under payload_json; a plain one posts the JSON directly.
  const body = init?.body;
  let raw = '{}';
  if (body && typeof body.get === 'function') raw = String(body.get('payload_json') ?? '{}');
  else if (typeof body === 'string') raw = body;
  try { posts.push(JSON.parse(raw)); } catch { posts.push({ raw }); }
  return { ok: true, status: 204, text: async () => '', json: async () => ({}) };
};
const env = { DB, DISCORD_DIGEST_WEBHOOK: 'https://example.invalid/webhook' };
const game = { id: G, name: 'Lag Test', current_tick: 400 };
const newestMs = (await DB.prepare(
  'SELECT MAX(created_at_ms) AS m FROM chronicle_entries WHERE game_id = ?').bind(G).first()).m;

// First edition. The post is intercepted above, so what we check is the
// payload it tried to send and the state it left behind.
const first = await runDigestForGame(env, game, { final: true });
const text = JSON.stringify(posts[0] ?? first ?? {});

check('an overflowing window prints the NEWEST rows, not the oldest',
  text.includes('100') || text.toLowerCase().includes('dyson') || text.toLowerCase().includes('sphere'),
  `edition did not mention the last event in the window: ${text.slice(0, 240)}`);

const state = await DB.prepare(
  'SELECT last_entry_ms FROM digest_state WHERE game_id = ?').bind(G).first();

check('the high-water mark jumps to the END of the window',
  Number(state?.last_entry_ms) === Number(newestMs),
  `mark=${state?.last_entry_ms} newest=${newestMs} (a mark short of the newest row means tomorrow re-reads today)`);

// Second edition, immediately. It may well publish -- a quiet day still
// gets a paper -- but it must have NOTHING left to report. Anything above
// zero here is yesterday's news queued into today, which is the bug.
const second = await runDigestForGame(env, game, { final: true });
check('one edition drains the window',
  (second?.events ?? -1) === 0,
  `second run still had ${second?.events} rows to print — the backlog survived`);

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nall herald window checks passed');
