// ============================================================
// THE THANK-YOU CARD IS ASKED ONCE (0174).
//
// It used to come back on every visit until answered (one player saw
// it 60 times). This checks, against a real SQLite:
//   - the first request that may show it claims it; every later one,
//     including a second tab racing the first, gets nothing
//   - an answer after the showing is still recorded, once
//   - the migration marks everyone who already SAW it as asked, and
//     leaves alone those who never saw it or already answered
//   - the migration reruns safely
//
// Run: node sim/thanksCardOnce.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { claimCommissionAsk, answerCommissionAsk } from '../worker/commissionAsk.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };
const run = (sql, ...a) => DB.prepare(sql).bind(...a).run();
const row = (id) => DB.prepare('SELECT commission_ask_ms AS ms, commission_ask_action AS a FROM users WHERE id = ?').bind(id).first();

for (const id of ['fresh', 'racer', 'saw', 'saw2', 'answered', 'never']) {
  await run('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,0)', id, `${id}@t`, id, 'x');
}

// ---- claiming the one showing ------------------------------------------
check('the first request claims the card', await claimCommissionAsk(env, 'fresh', 1000) === true);
check('...and it is recorded as shown', (await row('fresh')).a === 'shown');
check('a later visit never gets it again', await claimCommissionAsk(env, 'fresh', 2000) === false);
const [a, b] = await Promise.all([claimCommissionAsk(env, 'racer', 1000), claimCommissionAsk(env, 'racer', 1000)]);
check('two tabs at once: exactly one shows it', (a ? 1 : 0) + (b ? 1 : 0) === 1, `${a} ${b}`);

// ---- answering after it was shown --------------------------------------
await answerCommissionAsk(env, 'fresh', 'clicked', 3000);
check('a click after the showing is recorded', (await row('fresh')).a === 'clicked');
check('...keeping the time it was shown', (await row('fresh')).ms === 1000);
await answerCommissionAsk(env, 'fresh', 'dismissed', 4000);
check('a second answer changes nothing', (await row('fresh')).a === 'clicked');

// ---- the migration: everyone who already saw it -------------------------
await run(`UPDATE users SET commission_ask_ms = 5, commission_ask_action = 'clicked' WHERE id = 'answered'`);
const view = (u, from) => run(`INSERT INTO analytics_events (user_id, kind, created_at_ms, payload) VALUES (?,?,?,?)`,
  u, 'ui/commission-view', 1, JSON.stringify({ from }));
for (let i = 0; i < 60; i++) await view('saw', 'thanks-card');
await view('saw2', 'thanks-card');
await view('answered', 'thanks-card');
await view('never', 'lobby-flag');   // saw a different surface, never the card

const m = MIGRATIONS.find(x => x.name === '0174_thanks_card_once.sql');
const migrate = async () => {
  for (const stmt of m.sql.split(/;\s*(?:\r?\n|$)/).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
    await DB.prepare(stmt).run();
  }
};
await migrate();
check('players who saw the card unanswered are now marked asked',
  (await row('saw')).a === 'shown' && (await row('saw2')).a === 'shown');
check('...so the card can never be claimed for them again', await claimCommissionAsk(env, 'saw') === false);
check('an earlier answer is left as it was', (await row('answered')).a === 'clicked' && (await row('answered')).ms === 5);
check('a player who never saw the card is untouched', (await row('never')).ms === null);
const before = JSON.stringify(await row('saw'));
await migrate();
check('the migration reruns without changing anything', JSON.stringify(await row('saw')) === before);

console.log(bad === 0 ? '\nALL THANK-YOU CARD CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
