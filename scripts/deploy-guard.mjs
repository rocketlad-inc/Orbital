// ============================================================
// deploy-guard — the branch decides the environment.
//
// WHY THIS EXISTS. A staging environment with its own Worker and its own
// database still shipped a half-built feature to production, because
// staging and production DEPLOYED FROM THE SAME BRANCH. The isolation
// was real for DATA and imaginary for CODE: `--env staging` is a flag on
// the same commit, so the moment a feature was pushed it sat in the
// production branch waiting for the next deploy — and with several
// agents deploying, that is minutes.
//
// So the rule is now mechanical rather than remembered:
//
//     dev                -> orbital-staging
//     feat/real-physics  -> orbital (production)
//
// A deploy from the wrong branch fails, loudly, before anything uploads.
//
// IT RUNS FROM wrangler's OWN BUILD STEP, not from an npm script. That
// matters: a guard wired into `npm run deploy:staging` is trivially
// bypassed by typing `npx wrangler deploy`, which is exactly what a
// hurried operator (or an agent) does. Hanging it off build.command
// means every path through wrangler is checked, including the bare one.
//
// EACH ENVIRONMENT'S BUILD COMMAND NAMES ITSELF, as an argument. The
// obvious route was CLOUDFLARE_ENV, but wrangler does not set it for the
// build step — so the guard silently believed every staging deploy was a
// production one and blocked them all. An explicit argv beats an
// environment variable you have to trust somebody else to set.
// ============================================================

import { execSync } from 'node:child_process';

const ENV = process.argv[2] === 'staging' ? 'staging' : 'production';

/** Which branch is allowed to deploy each environment. */
const REQUIRED = {
  staging: 'dev',
  production: 'feat/real-physics',
};

const branch = (() => {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

const want = REQUIRED[ENV] ?? REQUIRED.production;

// A detached HEAD or a missing git dir is not a reason to block a
// deploy — CI checkouts do that routinely — but it IS worth saying so,
// because the guard is not protecting anything in that state.
if (!branch || branch === 'HEAD') {
  console.warn(`[deploy-guard] no branch (detached HEAD?) — cannot verify, continuing`);
  process.exit(0);
}

if (branch !== want) {
  const target = ENV === 'staging' ? 'STAGING' : 'PRODUCTION';
  console.error('');
  console.error(`  ✖ DEPLOY BLOCKED — wrong branch for ${target}`);
  console.error('');
  console.error(`      you are on : ${branch}`);
  console.error(`      ${target.toLowerCase().padEnd(10)} needs : ${want}`);
  console.error('');
  if (ENV === 'staging') {
    console.error('    Staging deploys from `dev` so unfinished work cannot ride');
    console.error('    a production deploy. Move your commits to dev:');
    console.error('');
    console.error('        git checkout dev && git merge ' + branch);
    console.error('');
  } else {
    console.error('    Production deploys from `feat/real-physics`. If this work');
    console.error('    is ready for players, merge it forward first:');
    console.error('');
    console.error('        git checkout feat/real-physics && git merge ' + branch);
    console.error('');
    console.error('    If it is NOT ready, deploy it to staging instead:');
    console.error('');
    console.error('        npm run deploy:staging');
    console.error('');
  }
  process.exit(1);
}

console.log(`[deploy-guard] ${branch} -> ${ENV} ✓`);
