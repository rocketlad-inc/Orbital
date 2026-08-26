// ============================================================
// Herald replay — reprint a whole finished campaign, offline.
//
// The gauntlet needs an artefact, and for the Herald the artefact is a
// run of editions, not one. Discord keeps the published papers but not
// in a form anything can read back, so this rebuilds them from the
// record: load a real game's tables into an in-memory D1 and call
// composeHeraldForTickRange once per publishing day.
//
// It is a REPRINT, not a transcript. The editions it produces are what
// today's composer makes of that campaign, which is the thing a review
// round should be judging — the paper as it stands, over a whole
// campaign, rather than one screenshot of one day.
//
// Usage:
//   node sim/heraldReplay.mjs <dump.json> [ticksPerEdition] > editions.md
//
// The dump is whatever the exporter wrote: one key per table, rows as
// plain objects. See the scratchpad exporter used for Peace Zone.
// ============================================================

import fs from 'fs';
import { composeHeraldForTickRange } from '../worker/digest.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

const dumpPath = process.argv[2];
const perEdition = Number(process.argv[3] || 24);
if (!dumpPath) {
  console.error('usage: node sim/heraldReplay.mjs <dump.json> [ticksPerEdition]');
  process.exit(2);
}
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
// A replay is a partial copy by construction: a chronicle row can name a
// body that was later destroyed and pruned, or a faction row the export
// did not carry. Enforcing references here would reject the record for
// being historical rather than wrong.
try { DB.prepare('PRAGMA foreign_keys = OFF').run(); } catch { /* best effort */ }

/** Insert rows as they came out of the source database. Columns the
 *  local schema does not have are dropped rather than guessed at — a
 *  dump taken against a newer prod should still replay. */
async function load(table, rows) {
  if (!rows?.length) return 0;
  let cols = null;
  try {
    const info = DB.prepare(`PRAGMA table_info(${table})`).all();
    const list = (info?.results ?? info) || [];
    cols = new Set(list.map(r => r.name));
  } catch { /* no pragma, take the row as-is */ }
  let n = 0;
  for (const row of rows) {
    const keys = Object.keys(row).filter(k => !cols || cols.has(k));
    const sql = `INSERT OR IGNORE INTO ${table} (${keys.join(',')}) `
      + `VALUES (${keys.map(() => '?').join(',')})`;
    try {
      await DB.prepare(sql).bind(...keys.map(k => row[k])).run();
      n += 1;
    } catch (e) {
      if (n === 0) console.error(`  !! ${table}: ${e.message}`);
    }
  }
  return n;
}

// Order matters only for foreign keys; SimD1 is forgiving, but keep the
// natural one anyway so a stricter backend would work too.
for (const t of ['users', 'rooms', 'games', 'game_factions', 'game_bodies',
  'game_settlements', 'senate_terms', 'senate_proposals', 'chronicle_entries']) {
  const n = await load(t, dump[t]);
  console.error(`loaded ${t}: ${n}/${dump[t]?.length ?? 0}`);
}

const game = dump.games?.[0];
if (!game) { console.error('dump has no game row'); process.exit(2); }
const roomName = dump.rooms?.[0]?.name ?? game.id;
const lastTick = Number(game.current_tick) || 0;

const out = [];
out.push(`# The Orbital Herald — ${roomName}`);
out.push('');
out.push(`Reprinted from the record: ${dump.chronicle_entries.length} public chronicle `
  + `entries across ${lastTick} ticks, composed ${perEdition} ticks to an edition `
  + `(the game ran ${(Number(game.tick_interval_ms) || 0) / 3600000}h to the tick, so `
  + `one edition is roughly one real day).`);
out.push('');

let printed = 0;
for (let from = 0; from < lastTick; from += perEdition) {
  const to = Math.min(from + perEdition, lastTick);
  let embed = null;
  try {
    embed = await composeHeraldForTickRange({ DB }, { ...game, name: roomName }, from, to, from);
  } catch (e) {
    out.push(`## T+${from}–${to} — COMPOSER THREW`);
    out.push('```');
    out.push(String(e.stack || e));
    out.push('```');
    out.push('');
    continue;
  }
  if (!embed) {
    out.push(`## T+${from}–${to} — no edition`);
    out.push('');
    continue;
  }
  printed += 1;
  out.push(`## Edition ${printed} — T+${from}–${to}`);
  out.push('');
  out.push(`**${embed.title}**`);
  out.push('');
  out.push(embed.description ?? '');
  for (const f of embed.fields ?? []) {
    out.push('');
    out.push(`### ${f.name}`);
    out.push(f.value ?? '');
  }
  if (embed.footer?.text) {
    out.push('');
    out.push(`_${embed.footer.text}_`);
  }
  out.push('');
  out.push('---');
  out.push('');
}

console.error(`composed ${printed} editions`);
console.log(out.join('\n'));
