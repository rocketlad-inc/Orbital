#!/usr/bin/env node
// d1-cost-audit.mjs - what Orbital's Cloudflare account is spending, and which
// queries are about to make it spend more. Read-only.
//
// Born from invoice IN-90645135 (Nov 2026): $471 of D1 rows READ, 89% on
// orbital-staging, from one lookup with no index that matched its WHERE.
//
//   node scripts/d1-cost-audit.mjs            month-to-date spend + projection,
//                                             per-day reads, the worst queries
//   node scripts/d1-cost-audit.mjs --strict   exit 1 when a budget is broken
//
// Login: the lcfeeser Cloudflare OAuth lives in ~/.wrangler-lcfeeser (kept apart
// from the Big Tickets login in ~/.wrangler). Make it once with:
//   USERPROFILE=~/.wrangler-lcfeeser HOME=~/.wrangler-lcfeeser \
//   XDG_CONFIG_HOME=~/.wrangler-lcfeeser/xdg npx wrangler login
// Override with CF_LOGIN_HOME=<dir>.
//
// BUDGETS (the alarm, not the bill): a query that averages more than
// MAX_AVG_ROWS rows and runs more than MIN_RUNS times a day is a scan in a hot
// path; a database reading more than DAILY_READS_WARN rows a day is on course
// for real money (25B/month are included, then $0.001 per million).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ACCOUNT = '6eb3b8c98213e8980b94be54810fa57f';
const DBS = ['orbital', 'orbital-staging'];
const MAX_AVG_ROWS = 20_000;
const MIN_RUNS = 1_000;
const DAILY_READS_WARN = 0.6e9; // 25B included / ~31 days, with a little room
const strict = process.argv.includes('--strict');

const home = process.env.CF_LOGIN_HOME || path.join(os.homedir(), '.wrangler-lcfeeser');
const env = { ...process.env, USERPROFILE: home, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
const wrangler = (args) => execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', ...args],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });

// whoami refreshes the hourly OAuth token from its refresh token.
const who = wrangler(['whoami']);
if (!who.includes(ACCOUNT)) { console.error(`Not logged in to ${ACCOUNT} under ${home}. See the header.`); process.exit(2); }
const tokFile = path.join(home, 'xdg', '.wrangler', 'config', 'default.toml');
const token = fs.readFileSync(tokFile, 'utf8').match(/oauth_token = "([^"]+)"/)[1];
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const gql = async (query) => {
  const j = await (await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: H, body: JSON.stringify({ query }) })).json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data.viewer.accounts[0];
};
const day = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const since = day(new Date(now.getTime() - 30 * 86_400_000));

const dbList = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database?per_page=100`, { headers: H })).json()).result;
const nameOf = Object.fromEntries(dbList.map(d => [d.uuid, d.name]));

const a = await gql(`{viewer{accounts(filter:{accountTag:"${ACCOUNT}"}){
  d1AnalyticsAdaptiveGroups(limit:2000,filter:{date_geq:"${since}"},orderBy:[date_ASC]){sum{rowsRead rowsWritten} dimensions{date databaseId}}
  durableObjectsPeriodicGroups(limit:2000,filter:{date_geq:"${since}"}){sum{activeTime} dimensions{date}}
}}}`);

const problems = [];
console.log(`Orbital Cloudflare spend check, ${day(now)} (last 30 days)\n`);
console.log('Database sizes:');
for (const d of dbList) {
  const gb = d.file_size / 1e9;
  console.log(`  ${d.name.padEnd(18)} ${gb.toFixed(2)} GB`);
  if (gb > 7) problems.push(`${d.name} is ${gb.toFixed(1)} GB (D1 stops writing at 10 GB)`);
}

const perDay = {};
for (const r of a.d1AnalyticsAdaptiveGroups) {
  const n = nameOf[r.dimensions.databaseId] ?? r.dimensions.databaseId;
  (perDay[r.dimensions.date] ??= {})[n] = r.sum.rowsRead;
}
const days = Object.keys(perDay).sort();
const last7 = days.slice(-8, -1); // whole days only
console.log('\nD1 rows read per day (last 7 whole days):');
for (const d of last7) console.log(`  ${d}  ` + DBS.map(n => `${n} ${((perDay[d][n] ?? 0) / 1e9).toFixed(2)}B`).join('   '));
for (const n of DBS) {
  const avg = last7.reduce((s, d) => s + (perDay[d][n] ?? 0), 0) / Math.max(1, last7.length);
  if (avg > DAILY_READS_WARN) problems.push(`${n} reads ${(avg / 1e9).toFixed(2)}B rows/day (budget ${(DAILY_READS_WARN / 1e9).toFixed(1)}B)`);
}
const totRead = a.d1AnalyticsAdaptiveGroups.reduce((s, r) => s + r.sum.rowsRead, 0);
const totWrite = a.d1AnalyticsAdaptiveGroups.reduce((s, r) => s + r.sum.rowsWritten, 0);
const doGbS = a.durableObjectsPeriodicGroups.reduce((s, r) => s + r.sum.activeTime, 0) / 1e6 * 0.128;
const cost = Math.max(0, totRead - 25e9) / 1e6 * 0.001 + Math.max(0, totWrite - 50e6) / 1e6 * 1 + Math.max(0, doGbS - 400e3) / 1e6 * 12.5;
console.log(`\nLast 30 days: ${(totRead / 1e9).toFixed(1)}B rows read, ${(totWrite / 1e6).toFixed(1)}M written, ~${Math.round(doGbS / 1e3)}k DO GB-s`);
console.log(`Usage cost at list price: ~$${cost.toFixed(2)} (plus the $5 plan)`);
if (cost > 25) problems.push(`30-day usage is ~$${cost.toFixed(0)}`);

console.log(`\nHot queries averaging over ${MAX_AVG_ROWS} rows (1 day):`);
for (const db of DBS) {
  let rows = [];
  try { rows = JSON.parse(wrangler(['d1', 'insights', db, '--sort-by', 'reads', '--sort-direction', 'DESC', '--timePeriod', '1d', '--limit', '40', '--json'])); } catch { console.log(`  ${db}: insights unavailable`); continue; }
  for (const r of rows) {
    if (r.avgRowsRead > MAX_AVG_ROWS && r.numberOfTimesRun > MIN_RUNS) {
      const q = r.query.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').slice(0, 160);
      console.log(`  ${db}: avg ${Math.round(r.avgRowsRead)} rows x ${r.numberOfTimesRun}  ${q}`);
      problems.push(`${db}: a hot query averages ${Math.round(r.avgRowsRead)} rows (${q.slice(0, 60)}...)`);
    }
  }
}

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n  - ${problems.join('\n  - ')}` : '\nOK: within every budget.');
if (strict && problems.length) process.exit(1);
