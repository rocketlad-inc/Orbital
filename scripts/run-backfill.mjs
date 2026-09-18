// ============================================================
// run-backfill — give a running game the catalogue bodies it is
// missing, by running the REAL backfillMissingBodies against it.
//
//   node scripts/run-backfill.mjs <env> <gameId> [--apply]
//
//   node scripts/run-backfill.mjs production ghhqbPbWz64Y
//   node scripts/run-backfill.mjs production ghhqbPbWz64Y --apply
//
// WHY THIS EXISTS. Backfill normally runs when the HOST pokes their
// game, and there is no other trigger. A host who is asleep is not a
// reason for fifteen approved worlds to stay out of a live map.
//
// WHY IT IMPORTS RATHER THAN REIMPLEMENTS. Every other repair script
// here reuses the worker's own helpers, because the recurring bug in
// this codebase is two copies of one rule drifting apart. Backfill
// decides scaling, spheres of influence, moon spread, orbital periods
// and phase locks; a second copy of that judgement living in a script
// would be wrong within a week. So instead of rewriting it, this puts a
// D1-shaped adapter over the wrangler CLI and calls the real function —
// the same code that is deployed and that sim/kuiperShell.mjs tests.
//
// DRY RUN BY DEFAULT. Reads execute; writes are collected and printed.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfillMissingBodies } from '../worker/factions.js';

const [envName, gameId, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
if (!envName || !gameId) {
  console.error('usage: node scripts/run-backfill.mjs <env> <gameId> [--apply]');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';

function d1(sql) {
  // execSync with one explicitly quoted command, NOT execFileSync with
  // an argv array: wrangler is a .cmd on Windows, so execFileSync needs
  // shell:true, and shell:true then re-splits the SQL on its own spaces.
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const start = out.indexOf('[');
  return JSON.parse(out.slice(start))[0]?.results ?? [];
}

/** SQL literal for a bound parameter. */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

const writes = [];

/** The smallest surface of D1 that backfillMissingBodies actually uses:
 *  prepare().bind().all() / .first() / .run(), and batch(). Parameters
 *  are inlined because the CLI takes SQL text, not bindings. */
const DB = {
  prepare(sql) {
    const stmt = {
      sql,
      bind(...args) {
        let i = 0;
        stmt.sql = sql.replace(/\?/g, () => lit(args[i++]));
        return stmt;
      },
      async all() { return { results: d1(stmt.sql) }; },
      async first() { return d1(stmt.sql)[0] ?? null; },
      async run() {
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(stmt.sql)) { writes.push(stmt.sql); return { meta: { changes: 0 } }; }
        d1(stmt.sql);
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  },
  async batch(stmts) {
    for (const s of stmts) writes.push(s.sql);
    return stmts.map(() => ({ meta: { changes: 0 } }));
  },
};

console.log(`game ${gameId} on ${DB_NAME}`);
const before = d1(
  `SELECT COUNT(*) AS all_bodies,
          SUM(CASE WHEN type NOT IN ('meteoroid','lagrange','megastructure') THEN 1 ELSE 0 END) AS claimable
     FROM game_bodies WHERE game_id = '${gameId}' AND destroyed_at_tick IS NULL`,
)[0];
console.log(`  before: ${before.all_bodies} body rows, ${before.claimable} claimable worlds\n`);

const inserted = await backfillMissingBodies({ DB }, gameId);
console.log(`backfill wants to add ${inserted} bodies:\n`);
for (const sql of writes) {
  const m = sql.match(/VALUES \(\s*'[^']*',\s*'[^']*',\s*'([^']*)',\s*'([^']*)'/);
  const nums = sql.match(/'#?[0-9a-f]{0,6}',?/) ? '' : '';
  console.log(`  ${(m ? m[2] : '?').padEnd(12)} (${m ? m[1] : '?'})${nums}`);
}
console.log(`\n  ${before.claimable} claimable worlds -> ${Number(before.claimable) + inserted}`);
console.log(`  60% domination: ${Math.ceil(Number(before.claimable) * 0.6)} -> ${Math.ceil((Number(before.claimable) + inserted) * 0.6)}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}
if (!writes.length) { console.log('\nnothing to apply.'); process.exit(0); }

const file = path.join(os.tmpdir(), `backfill-${gameId}.sql`);
fs.writeFileSync(file, writes.map(s => (s.trim().endsWith(';') ? s : `${s};`)).join('\n'), 'utf8');
execSync(`npx wrangler d1 execute ${DB_NAME} --remote --yes --file "${file}"`, { encoding: 'utf8', stdio: 'inherit' });
fs.unlinkSync(file);
console.log('\napplied.');
