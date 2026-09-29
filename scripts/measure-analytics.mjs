// ============================================================
// measure-analytics — what does the admin analytics page actually
// cost against a real database?
//
//   node scripts/measure-analytics.mjs production overview
//   node scripts/measure-analytics.mjs production games|players
//   node scripts/measure-analytics.mjs production game <gameId>
//
// Calls the REAL handler (adminDashboard.js / handleGameAnalytics) through
// a D1-shaped adapter over the wrangler CLI, and records D1's own
// `rows_read` and duration for every statement it runs. Rows read is
// the number that matters: it is what D1 bills, what its per-request
// limits count, and what grows with the player base. Wall-clock time
// from here includes CLI overhead and is only good for ranking.
//
// Read-only. The handlers never write, and the adapter refuses to.
// ============================================================

import { execSync } from 'node:child_process';

const [envName, view, gameId] = process.argv.slice(2);
if (!envName || !['overview', 'games', 'players', 'game'].includes(view) || (view === 'game' && !gameId)) {
  console.error('usage: node scripts/measure-analytics.mjs <env> overview|games|players');
  console.error('       node scripts/measure-analytics.mjs <env> game <gameId>');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';

const ledger = [];

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function run(sql) {
  if (/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(sql)) {
    throw new Error('measure-analytics is read-only; refused a write');
  }
  // Strip `--` line comments BEFORE collapsing whitespace. Joining lines
  // first turns every comment into one that swallows the rest of the
  // statement — "incomplete input" from D1, and it looks like the
  // handler's SQL is broken when it is only this adapter's.
  const oneLine = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')))[0] ?? {};
  const meta = parsed.meta ?? {};
  ledger.push({
    sql: oneLine,
    rows_read: meta.rows_read ?? 0,
    rows_out: (parsed.results ?? []).length,
    ms: meta.duration ?? 0,
  });
  return parsed.results ?? [];
}

const DB = {
  prepare(sql) {
    const stmt = {
      sql,
      bind(...args) { let i = 0; stmt.sql = sql.replace(/\?(\d+)?/g, (m, n) => lit(n ? args[Number(n) - 1] : args[i++])); return stmt; },
      async all() { return { results: run(stmt.sql) }; },
      async first() { return run(stmt.sql)[0] ?? null; },
      async run() { throw new Error('read-only'); },
    };
    return stmt;
  },
  // Batches are the rollup's writes; this adapter only ever reads.
  async batch() { throw new Error('read-only'); },
};

const routes = [
  ...(await import('../worker/adminDashboard.js')).routes,
  ...(await import('../worker/analytics.js')).routes,
];
const route = routes.find(r =>
  r.method === 'GET' && (view === 'game'
    ? String(r.pattern).includes('analytics$')
    : r.pattern === `/api/admin/${view}`));
const url = new URL(view === 'game'
  ? `https://x/api/admin/games/${gameId}/analytics`
  : `https://x/api/admin/${view}`);
const session = { user_id: 'measure', email: 'lcfeeser@gmail.com' };

const t0 = Date.now();
const res = await route.handle(new Request(url), { DB }, {
  url, session, params: view === 'game' ? { gameId } : {},
});
const wall = Date.now() - t0;
const body = await res.json();

// --dump <file>: keep the real payload, so the UI can be rendered and
// judged against production data instead of a hand-made fixture.
const dumpAt = process.argv.indexOf('--dump');
if (dumpAt > 0 && process.argv[dumpAt + 1]) {
  (await import('node:fs')).writeFileSync(process.argv[dumpAt + 1], JSON.stringify(body));
  console.log(`payload written to ${process.argv[dumpAt + 1]}`);
}

// ---- report -----------------------------------------------------------
const label = (s) => {
  const m = s.match(/FROM\s+(\w+)/i);
  const tag = s.slice(0, 70).replace(/SELECT\s+/i, '');
  return `${(m?.[1] ?? '?').padEnd(18)} ${tag}`;
};
const byCost = ledger.slice().sort((a, b) => b.rows_read - a.rows_read);
const total = ledger.reduce((a, x) => a + x.rows_read, 0);

console.log(`\n${view} on ${DB_NAME}${gameId ? ` (${gameId})` : ''}: status ${res.status}`);
console.log(`${ledger.length} statements, ${total.toLocaleString()} rows read, ${wall}ms wall (incl. CLI)\n`);
console.log('  rows read   out   d1 ms   statement');
for (const x of byCost) {
  console.log(`  ${String(x.rows_read.toLocaleString()).padStart(9)} ${String(x.rows_out).padStart(5)} ${String(Math.round(x.ms)).padStart(7)}   ${label(x.sql)}`);
}
if (view === 'overview') {
  const behind = body.rollup?.behind_ms;
  console.log(`\npayload: ${body.daily?.length ?? 0} days, ${body.cohorts?.length ?? 0} cohorts, `
    + `${body.usage?.length ?? 0} action kinds, rollup ${behind != null ? `${Math.round(behind / 60000)} min behind` : 'not started'}, `
    + `${JSON.stringify(body).length.toLocaleString()} bytes`);
}
