// ============================================================
// stripe-secrets — put the three Stripe values on a Worker, in one go.
//
//   node scripts/stripe-secrets.mjs staging
//   node scripts/stripe-secrets.mjs production
//
// The environment is REQUIRED and has no default. Three separate
// `wrangler secret put` calls each needed `--env staging` on the end,
// and forgetting it on any one of them silently writes to PRODUCTION —
// which for a TEST key means the live game starts offering a checkout
// that only accepts fake cards, and nobody finds out until a player
// tries to buy something.
//
// So this refuses the mismatch outright: a sk_test_/whsec_ pair cannot
// be written to production, and a sk_live_ pair cannot be written to
// staging. That is the whole reason this file exists; the convenience
// is secondary.
//
// Values are typed at the prompt with echo off, piped straight to
// wrangler, and never written to disk, a shell history or a log. The
// price id is NOT a secret (it is a plain identifier, safe in git) and
// is only here because it keeps the three together — if you would
// rather check it in, put it in the env's `vars` block in
// wrangler.jsonc and skip it here.
// ============================================================

import { spawnSync } from 'node:child_process';
import readline from 'node:readline';

const ENV = process.argv[2];
if (ENV !== 'staging' && ENV !== 'production') {
  console.error('usage: node scripts/stripe-secrets.mjs <staging|production>');
  console.error('  the environment is required — there is deliberately no default');
  process.exit(1);
}
const LIVE = ENV === 'production';

/** Read one line with the terminal echo off, so a secret never appears
 *  on screen or in scrollback. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (ch) => {
      const s = String(ch);
      if (s === '\n' || s === '\r' || s === '') process.stdin.removeListener('data', onData);
      else readline.clearLine(process.stdout, 0) || readline.cursorTo(process.stdout, 0)
        || process.stdout.write(`${prompt}${'*'.repeat(rl.line.length)}`);
    };
    process.stdout.write(prompt);
    process.stdin.on('data', onData);
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

const FIELDS = [
  {
    name: 'STRIPE_SECRET_KEY',
    prompt: `Secret key (${LIVE ? 'sk_live_…' : 'sk_test_…'}): `,
    check: (v) => {
      if (!/^sk_(test|live)_/.test(v)) return 'that is not a secret key — it should start sk_test_ or sk_live_';
      if (/^pk_/.test(v)) return 'that is a PUBLISHABLE key; this integration never uses one';
      const isLive = v.startsWith('sk_live_');
      if (isLive !== LIVE) {
        return isLive
          ? 'that is a LIVE key and you asked for staging — refusing'
          : 'that is a TEST key and you asked for production — refusing, this would offer real players a checkout that only takes fake cards';
      }
      return null;
    },
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    prompt: 'Webhook signing secret (whsec_…): ',
    check: (v) => (/^whsec_/.test(v) ? null : 'that is not a webhook signing secret — it should start whsec_'),
  },
  {
    name: 'STRIPE_PRICE_COSMETICS',
    prompt: 'Price id (price_…): ',
    check: (v) => (/^price_/.test(v) ? null : 'that is not a price id — it should start price_ (a prod_… is the PRODUCT, not its price)'),
  },
];

console.log(`\nWriting Stripe secrets to the ${ENV.toUpperCase()} worker.`);
console.log(LIVE
  ? '  LIVE — these take real money. Rehearse on staging first if you have not.\n'
  : '  Test mode. Staging has its own D1, so nothing here can touch the live game.\n');

const values = [];
for (const f of FIELDS) {
  // Up to three attempts each, so a typo does not mean starting over.
  let v = null;
  for (let attempt = 0; attempt < 3 && v === null; attempt++) {
    const got = await askHidden(f.prompt);
    const bad = f.check(got);
    if (bad) console.error(`  ✗ ${bad}`);
    else v = got;
  }
  if (v === null) { console.error('too many bad values — nothing written'); process.exit(1); }
  values.push({ name: f.name, value: v });
}

// Nothing is written until every value has passed, so a refusal on the
// third prompt cannot leave the worker half-configured.
for (const { name, value } of values) {
  const args = ['wrangler', 'secret', 'put', name];
  if (!LIVE) args.push('--env', 'staging');
  const res = spawnSync('npx', args, { input: value, encoding: 'utf8', shell: true });
  const ok = res.status === 0;
  console.log(`  ${ok ? 'set  ' : 'FAILED'} ${name}`);
  if (!ok) {
    console.error(res.stderr?.slice(0, 400) || res.stdout?.slice(0, 400));
    process.exit(1);
  }
}

console.log(`\nDone. ${LIVE ? 'Production' : 'Staging'} can now take payments.`);
console.log('Verify with:  npx wrangler secret list' + (LIVE ? '' : ' --env staging'));
