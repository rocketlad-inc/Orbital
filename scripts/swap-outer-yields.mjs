// ============================================================
// swap-outer-yields -- swap metal and credits on every UNCLAIMED Kuiper
// Belt and Far Reach world in every running game.
//
//   node scripts/swap-outer-yields.mjs <env>            (dry run)
//   node scripts/swap-outer-yields.mjs <env> --apply
//
// The rules (which bodies, what counts as claimed, why it is safe to run
// twice) live in worker/outerYieldSwap.js with the sim that tests them
// (npm run sim:outerswap). This file only reads D1 and writes it.
//
// DRY RUN BY DEFAULT.
// ============================================================

import { execSync } from 'node:child_process';
import { planOuterYieldSwap, outerYieldSwapSql } from '../worker/outerYieldSwap.js';

const [envName, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
if (!envName) {
  console.error('usage: node scripts/swap-outer-yields.mjs <env> [--apply]');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';

function d1(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')))[0];
  return { rows: parsed?.results ?? [], changes: parsed?.meta?.changes ?? 0 };
}

const games = d1(
  `SELECT g.id, r.name, g.current_tick FROM games g JOIN rooms r ON r.id = g.id
    WHERE g.status IN ('setup', 'active') ORDER BY g.id`,
).rows;
console.log(`${games.length} running game(s) on ${DB_NAME}${APPLY ? '' : ' -- DRY RUN'}\n`);

const fmt = (r) => `${r.template}(M${r.metal} C${r.gold})`;
let total = 0;
for (const g of games) {
  const bodies = d1(`SELECT * FROM game_bodies WHERE game_id = '${g.id}'`).rows;
  const claimed = new Set(d1(
    `SELECT DISTINCT body_id FROM game_settlements
      WHERE game_id = '${g.id}' AND destroyed_at_tick IS NULL`,
  ).rows.map(r => r.body_id));
  const plan = planOuterYieldSwap(bodies, claimed);
  console.log(`${g.id}  "${g.name}"  tick ${g.current_tick}`);
  console.log(`  swap     ${plan.swap.length}: ${plan.swap.map(fmt).join(' ')}`);
  if (plan.claimed.length) console.log(`  claimed  ${plan.claimed.length}: ${plan.claimed.map(fmt).join(' ')}  (left as is)`);
  if (plan.already.length) console.log(`  already  ${plan.already.length}: ${plan.already.map(fmt).join(' ')}`);
  if (plan.even.length) console.log(`  even     ${plan.even.length}: ${plan.even.map(fmt).join(' ')}`);
  if (plan.odd.length) console.log(`  ODD      ${plan.odd.length}: ${plan.odd.map(fmt).join(' ')}  (matches neither catalogue -- left alone)`);
  const sql = outerYieldSwapSql(g.id, plan);
  if (APPLY && sql) {
    const { changes } = d1(sql);
    console.log(`  wrote ${changes} row(s)${changes !== plan.swap.length ? `  <-- planned ${plan.swap.length}` : ''}`);
    total += changes;
  } else {
    total += plan.swap.length;
  }
  console.log('');
}
console.log(`${APPLY ? 'swapped' : 'would swap'} ${total} world(s) in total`);
