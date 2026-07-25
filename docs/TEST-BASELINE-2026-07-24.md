# Test baseline — 2026-07-24 (pre-captains build)

Recorded before implementing DESIGN-captains.md, per Lorne's instruction to log
every feature's current test state first.

## Unit suite (CI=true react-scripts test)

`4 suites / 32 tests / ALL PASSING` at origin tip `81efdd7`.

| suite | covers |
|---|---|
| src/game/worldMenu/__tests__/worldMenu.test.ts | world-menu camera math, combat display (hpColor, flameCount, FIRE_THRESH) |
| src/physicsSandbox/__tests__/nodePlacement.test.ts | maneuver-node placement math |
| src/physicsSandbox/__tests__/transferMatrix.test.ts | transfer dv/time matrix across body pairs |
| src/torchSandbox/__tests__/torchPhysics.test.ts | torch transfer physics (flip-and-burn) |

## Feature inventory — current automated-test coverage

Features verified only by build/typecheck + manual playtest unless listed above:

- **Economy / yields / trade routes** — no unit tests (server tick pass, worker/room.js)
- **Combat resolver** (cadence, counter-matrix, PDC, settlements-as-combatants,
  stances, peace suppression) — no unit tests; verified via prod D1 queries
- **Veterancy** (rank/kill award, rankDamageMul/rankHpMul, effectiveShipMaxHp) — no unit tests
- **Ship designer / parts / templates / build list (migration 0045)** — no unit tests
- **Research queue + promotion (same-tick, migration 0043)** — no unit tests
- **Settlement auto-repair + damage flames** — flameCount covered in worldMenu.test.ts
- **Fog of war / sensors / intel gating** — no unit tests
- **Planet render (clouds, rotation, tilt), LOD, territory borders** — no unit tests
  (pixel-verified via offscreen harness at build time)
- **Mobile shell breakpoint (JS/CSS lockstep, pointer:coarse)** — no unit tests
  (matchMedia-verified in browser at build time)
- **Auth / Google sign-in** — no unit tests
- **Physics (orbits, torch transfers)** — covered by the 3 sandbox suites above

Gate for the captains build: the 32 baseline tests must still pass, plus new
captains tests added with the feature.
