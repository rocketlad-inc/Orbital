# Staging

**https://orbital-staging.lcfeeser.workers.dev**

A separate Worker on a separate database, deployed from a separate
branch. Break it freely — nothing here can reach a live game.

## The branch IS the environment

```
dev                ->  orbital-staging
feat/real-physics  ->  orbital (production)
```

**This is enforced, not remembered.** `scripts/deploy-guard.mjs` runs
inside wrangler's own build step, so it fires on `npm run deploy:staging`
AND on a bare `npx wrangler deploy` — a guard living in an npm script
would be bypassed by the one command people actually type when they are
in a hurry. A deploy from the wrong branch fails before anything
uploads, and says which branch it wanted.

**Why this exists.** The first version of this environment had its own
Worker and its own database and still shipped an unfinished feature to
production, because both environments deployed from the SAME BRANCH. The
isolation was real for data and imaginary for code: `--env staging` is a
flag on a commit, so the moment work was pushed it sat in the production
branch waiting for the next deploy — and with several agents deploying,
that is minutes, not days.

**Day to day:**

```bash
git checkout dev            # build features here
npm run deploy:staging      # try them

git checkout feat/real-physics
git merge dev               # when they are ready for players
npm run deploy:prod
```

---

## For Claude agents: the short version

```bash
# 1. Deploy whatever is in your working tree
npm run deploy:staging

# 2. Mint a session (separate key from production)
KEY=$(cat ~/.orbital-staging-agent-key)
curl -s -X POST https://orbital-staging.lcfeeser.workers.dev/api/agent/session \
  -H "X-Agent-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"handle":"my-test-bot"}'
# -> { "user": {...}, "token": "..." }

# 3. Drive the game with that token
curl -s https://orbital-staging.lcfeeser.workers.dev/api/rooms \
  -H "Authorization: Bearer $TOKEN"
```

Everything the production agent harness does works here; only the host
and the key change. `handle` must be a slug: `[a-z0-9][a-z0-9_-]{0,30}`.

---

## Why it is safe

| | production | staging |
|---|---|---|
| worker | `orbital` | `orbital-staging` |
| D1 database | `orbital` | `orbital-staging` (own id) |
| Durable Objects | per worker name | separate namespace, automatically |
| agent key | `~/.orbital-agent-key` | `~/.orbital-staging-agent-key` |
| Discord / email / Stripe | live | **inert** |

**The database is the whole safety story.** Both environments bind the
same name — `env.DB` — to different database ids, so no code branches on
which environment it is in, and a destructive migration on staging
cannot reach production rows because the handle points elsewhere.

**Verified, not assumed.** A room created on staging does not appear in
production's room list, and the staging agent key is rejected by
production with a 404.

**External services fail closed.** Every integration checks for its
secret and short-circuits when absent — Discord returns `no_bot_token`,
Stripe skips, email never sends. Staging has none of those secrets, so
it cannot DM a player, charge a card, or post to the server. Setting one
is opting *into* real-world side effects; do it deliberately, one secret
at a time, and know what you are turning on.

**The cron still runs.** Games tick every minute, as in production. A
staging environment where time does not pass cannot test a tick-based
game.

**Migrations apply themselves.** `ensureMigrated` runs the bundle on the
first request to a cold isolate, so a fresh database bootstraps on first
hit. There is no manual migration step.

---

## Commands

```bash
npm run deploy:staging     # build + deploy the working tree
npm run staging:tail       # live logs
npm run staging:reset      # wipe games/rooms/ships, KEEP logins (asks first)
npm run staging:reset -- --yes   # same, unattended
npm run staging:sql "SELECT count(*) FROM games"
```

`staging:reset` deletes in FK-dependency order. It has no flag to point
at another database and refuses to run against any name but
`orbital-staging` — a reset script with a `--database` argument is one
tab-completion away from a very bad afternoon.

---

## What staging is for

Anything you would not want to discover in front of players:

- a migration that might be wrong (this is the big one — migration 0089
  wedged production for weeks, and staging is where that gets caught)
- balance changes you want to watch tick for a few hours
- a feature that needs two accounts and a real game to exercise
- destructive flows: cancelling deals, killing fleets, ending games

## What it is not

- **Not a copy of production.** It starts empty. Seed what you need.
- **Not private.** The URL is public and unauthenticated pages are
  readable by anyone who finds it. Do not put anything there you would
  not put on the internet.
- **Not a substitute for the sims.** `npm run sim:*` is faster and
  deterministic. Use staging for what sims cannot reach: real HTTP, real
  D1, real Durable Objects, real elapsed time.

---

## Deploying to production instead

Production deploys are still `npx wrangler deploy` with no `--env`, from
the `feat/real-physics` branch, and still require the usual discipline:
fetch and rebase first, push BEFORE deploying, then confirm
`/api/_version` matches local `HEAD`. Staging does not change any of
that — it is where you find out whether it is worth doing.
