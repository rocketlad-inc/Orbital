# Orbital balance simulator

Runs real Orbital games headless — no Cloudflare, no network, no D1 —
so a balance question can be answered with a few hundred games instead
of a few weeks of playtesting.

```bash
npm run sim                       # one game, 200 ticks, 4 players
node sim/headless.mjs 300 4 mySeed  # ticks, players, seed
npm run sim:sweep -- 16 300       # 16 seeds x 300 ticks, bots playing
npm run sim:passive               # the no-orders baseline
```

Roughly 2 ms per tick: a 300-tick game takes ~0.6 s, and 1000 games run
in about ten minutes on one core.

## How it works, and why this way

The rules live in `worker/room.js` `resolveTick` — ~3600 lines with a
couple of hundred D1 calls threaded through them. The obvious approach,
porting those rules into a standalone "sim engine", means maintaining
two implementations of Orbital forever, and the sim drifts from the game
it claims to measure. You end up balancing a model.

So this moves the **database** to the rules instead of the rules to the
harness.

| file | job |
|---|---|
| `d1.mjs` | D1's API on top of `node:sqlite` (core in Node 22+, nothing to compile) |
| `headless.mjs` | supplies `env.DB` and `state.storage`, then drives the real `resolveTick` |
| `bots.mjs` | scripted doctrines that issue orders through the real `actions.js` handlers |
| `sweep.mjs` | the Monte Carlo layer — many seeds, aggregated |

Nothing here reimplements a game rule. Seeding is the server's
`seedGameWorld`; ticks are the server's `resolveTick`; bot orders go
through the same route handlers a browser posts to, and get the same
rejections when they overreach.

## Determinism

The tick is deterministic. Every `Math.random` in `room.js` generates an
id or a cosmetic surface angle — combat is `damage_per_tick` through
`defenseMitigation()`, with no rolls.

World generation is **not**: `seedGameWorld` runs a mulberry32 PRNG
seeded from `map_seed` to decide who spawns where. That is the game's one
real dice roll, and the harness pins it. Same seed, byte-identical
outcome; different seeds are the population a sweep samples.

## What this cannot tell you

Read these before quoting a number at anyone.

- **Bots do not fight.** No archetype attacks another, so zero ships are
  ever destroyed. Military spend is pure cost in this model and any
  aggressive doctrine is structurally doomed regardless of whether
  aggression is actually good. Win rates mean nothing until this changes.
- **"Richest" is not "won".** The sweep ranks banked wealth, which
  flatters whoever spent least. A doctrine that converts income into
  territory or hulls looks poor by construction.
- **Transit times are approximate and biased slow.**
  `handleCommitTransfer` accepts `arrival_t` from the caller and checks
  only that it is finite and after departure — the real brachistochrone
  is planned client-side in `src/physics/torchTransfer.ts`. Rather than
  give the sim its own physics, `bots.mjs` uses a deliberately
  pessimistic estimate. Expansion is handicapped on purpose: a strong
  Expander result survives the bias, a weak one is suspect and this is
  the first thing to check.
- **Results are exactly as good as the bots.** One bugfix — colony ships
  retrying settlements on gas giants — moved Expander from 8% to 19%.
  Treat any surprising result as "look here", never as "this is
  imbalanced".

## Adding an archetype

Add an entry to `ARCHETYPES` in `bots.mjs`: a research order, a build
list, whether it colonises, and how often it builds. Doctrine is
declarative and the executor applies it uniformly, so a new one is a
dozen lines. Sweeps rotate doctrines across seats automatically, so no
archetype gets welded to a lucky spawn.

## Calibration

The analytics platform already logs real spend, tech pace and combat
telemetry from live games. Tuning the archetypes against how playtesters
actually behave is what turns this from "a game played by simple bots"
into something that predicts your game. That work has not been done yet.
