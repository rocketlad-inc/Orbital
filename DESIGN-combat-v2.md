# DESIGN — Combat v2: speed decides whether you hit

*Status: approved model, not yet built. Numbers locked with Lorne 2026-08-05
after ~990,000 simulated battles. This document is the implementation map.*

## The model, in full

| | Corvette | Frigate | Destroyer |
|---|---|---|---|
| HP | 40 | 100 | **400** (was 200) |
| Damage | **3.75** (was 5) | **20.25** (was 10) | **45** (was 18) |
| Combat speed | **0.85** | **0.50** | **0.30** |
| Cost | 36 | 81 | 205 |
| Slots | 2 | 4 | 6 |

- **Every ship fires every tick.** `AUTO_COMBAT_INTERVAL` (3) is retired.
- **Hit chance** = `atkSpeed² / (atkSpeed² + defSpeed²)`. Symmetric, mirrors are
  always 50%, never reaches 0% or 100%.
- **Peer targeting**: engage the enemy closest to your own speed.
- **Engines** raise combat speed ×1/0.85 each, clamped at **1.176**.
- Mitigation is unchanged: typed only (shields cut kinetic, armor cuts energy,
  0.78/part, floor 0.15). PDC is already gone (`406f503`).

Resulting hit matrix:

| attacker ↓ / defender → | Corvette | Frigate | Destroyer |
|---|---|---|---|
| Corvette | 50.0% | 74.3% | 88.9% |
| Frigate | 25.7% | 50.0% | 73.5% |
| Destroyer | 11.1% | 26.5% | 50.0% |

Measured outcome vs today, same 100 fleets, 495k battles each: **101 → 48 ticks**,
fights over 100 ticks **43.4% → 3.0%**, survivorship **13.3% → 19.2%**, class
value spread **1.38× → 1.30×**.

---

## Open questions — MUST be answered before coding

These three are genuinely undecided. The simulation only ever modelled armed
ships fighting armed ships, so it never had to answer any of them.

### Q1. What is a settlement's speed?

Hit chance is speed-based, and a city cannot dodge. Three sites are affected:
ship→settlement bombardment (`room.js` ~2477), station return fire (~2530), and
the settlement's own survivability.

- **Option A — bombardment always hits** (no roll). A planet is a stationary
  target; the roll only exists to model evasion. Simplest, one branch, and it
  keeps sieges decisive. Station return fire would also always hit.
- **Option B — give settlements a speed** (~0.10). Ships hit them 88–99%, and
  station guns hit a corvette 1.4% — which effectively disarms stations.
- **Recommendation: A.** Option B silently guts station defence.

### Q2. What speed do freighters and colony ships have?

Both have `damagePerTick: 0` — they are targets, never attackers. They need a
speed so they can be *shot at*. Their travel `speedModifier` is 1.3 / 1.6
(slower than a frigate's 1.0), so on the combat scale roughly **0.40 / 0.30**.
Note this makes a colony ship exactly as hard to hit as a destroyer, which is
probably wrong — a fat colony hull should be the easiest target on the field.
Suggest **freighter 0.40, colony 0.25**.

### Q3. Do existing ships get restatted?

Live right now: **207 destroyers**, 63 frigates, 19 corvettes, 32 freighters,
4 colony ships. Destroyers are 64% of all combat hulls — a legacy of the PDC era
that ended yesterday.

Their stats are **stamped at build time** (`game_ships.hp_max`,
`damage_per_tick`), so nothing changes for them unless we migrate. Live
`hp_max` ranges 340–592 for destroyers (base 200 + fitted armor).

- **Restat** (recommended): one migration recomputing every active hull through
  `computeShipStats` with the new bases. A destroyer at 340 becomes 540. Keeps
  one consistent rule across the fleet.
- **Don't restat**: two generations of ships coexist under one rule set, and a
  destroyer built yesterday is permanently worse than one built tomorrow. This
  is the option that generates bug reports.

### Q4 (process). Flag or cutover?

Seven live games. A per-game `combat_model` column mirroring `gating_enabled`
would let new games opt in — but it doubles the combat code path and we'd carry
both forever. A clean cutover plus an announcement is simpler, and the players
have already seen and liked the pitch. **Recommend cutover.**

---

## What has to change

### Server — the authoritative path

| File | Change |
|---|---|
| `worker/factions.js:528` | `SHIP_COMBAT_STATS` — new hp/damage per class. |
| `worker/shipDesigns.js:203` | `computeShipStats` — add a `speed` return derived from class base × engine count, clamped 1.176. Engine count already available via `countPart(parts,'engine')`. |
| `worker/room.js:2138` | Delete `AUTO_COMBAT_INTERVAL` and both cadence gates (~2408, ~2514). |
| `worker/room.js:~2440` | Replace round-robin target pick with **peer** selection (nearest speed). |
| `worker/room.js:~2455` | Add the hit roll before damage. Needs a **deterministic** PRNG seeded per (tick, attacker) — the tick must replay identically across clients and re-runs. |
| `worker/room.js:2477, 2530` | Settlement bombardment + station return fire per **Q1**. |
| `worker/room.js:~2892` | Repair grace was justified as "≥ the combat cadence (3)". With cadence 1 the comment is wrong and the value should be re-derived. |

**No schema change is needed for speed** — it is computed from class + `parts_json`,
both already present. Only the Q3 restat needs a migration.

### Client — mirrors that must not drift

| File | Change |
|---|---|
| `src/game/shipClasses.ts:48,71,94` | `hp` / `damagePerTick` per class. |
| `src/game/shipParts.ts:450` | `SERVER_HULL_BASE` — marked *KEEP IN SYNC*, and it is the thing the designer quotes. |
| `src/game/shipParts.ts:computeDesignStats` | Return `speed` alongside hp/damage. |
| `src/game/combat.ts:76` | `AUTO_COMBAT_INTERVAL` — retire. Note it is re-exported into `systemGrouping.ts:310` and `useSituationItems.ts:278` as `COMBAT_RECENT_TICKS = interval × 2`; those windows need a real value, not `1 × 2`. |
| `src/game/combat.ts:autoCombatAtBodies` | The dead SP loop. It still compiles and is called from `gameContext:1092`. Per house rule SP is frozen — **leave it**, but it will visibly diverge from MP. Worth a comment saying so. |
| `src/render/combatFx.ts:131,146` | Tracer budget assumes a 3-tick cadence. **3× more shots** now, and misses may want their own visual. |

### Copy that becomes wrong the moment this ships

- `ShipPanel.tsx:1385` — hardcoded **"every 3 ticks"** in the CADENCE row.
- `TunablesPage.tsx:177,614` — exposes `autoCombatInterval` as a live tunable.
- `shipClasses.ts:17` — comment "damage dealt per COMBAT_DAMAGE_INTERVAL ticks".
- `shipParts.ts` engine blurb — "−15% travel time per engine" is now only half
  of what an engine does.
- `techs.ts` weapons/defense descriptions, `tutorialSteps.ts` designer step.

---

## UX — how a player learns this

The mechanic is only good if it is legible. Today **speed is not shown anywhere
as a combat stat**, and the only combat numbers a player sees are `FP:` in the
build menu and `DAMAGE /volley` in the ship panel.

Ranked by value:

### 1. The hit matrix, live, in the Ship Designer *(highest value)*

The designer already shows HP / damage / cost deltas as you fit parts. Add a
row that answers *what does this ship actually hit*:

```
CHANCE TO HIT      vs ⚡ 50%   vs ▰ 74%   vs ▮ 89%
```

Recomputed as engines are fitted, so the player *discovers* that an engine is a
weapon by watching the numbers move. This is the single affordance that teaches
the whole system at the moment of decision.

### 2. Speed as a first-class stat

Add SPEED to the ship card, the build menu row, and the designer — with the
0–1 value and a one-word gloss (`0.85 — nimble`). It cannot be a hidden stat;
that is precisely the mistake PDC made, and we deleted PDC for it.

### 3. Live exchange odds in the Ship Panel

When a ship sits at a contested body, show the real numbers against what is
actually there:

```
ENGAGEMENT   you hit 74%  ·  they hit 26%
```

Abstract rule → concrete readout, at the moment it matters.

### 4. Misses on the map

`combatFx` already draws tracers for shots. Render a **miss** differently — a
dim tracer that falls short, or no tracer plus a small deflection tick. Right
now a 26% hit rate would just look like a quiet battle. Players should *see*
the misses; it is the difference between "this is random" and "this is broken".

### 5. Re-label the engine

"−15% travel time per engine" must become travel **and** combat. An engine is
now the only part that improves offence and defence simultaneously, and if that
stays undocumented it becomes the next invisible-PDC problem.

### 6. Ship the explainer

The doctrine essay already written for players covers the rules, the before/after
and the honest caveats. Worth an in-game link the first time a player opens the
designer after the change.

---

## Suggested order

1. **Answer Q1–Q4.** Nothing below is safe until settlements and the restat are decided.
2. **Server stats + speed** (`factions.js`, `shipDesigns.js`) — inert until the loop changes.
3. **Server loop**: cadence → every tick, peer targeting, hit roll with a deterministic seed.
4. **Restat migration** (Q3).
5. **Client mirrors** — `shipClasses`, `SERVER_HULL_BASE`, `computeDesignStats`.
6. **UX 1–3** (designer matrix, speed stat, engagement odds).
7. **Copy sweep** + **UX 4–5** (miss visuals, engine blurb).
8. Announce.

## Risks

- **Determinism.** The hit roll is the first randomness in the tick. It must be
  seeded from (tick, attacker id) so a replay, a re-run, and every client agree.
  A naive `Math.random()` here desyncs the game.
- **FX volume.** 3× the shots and most of them missing. The tracer cap in
  `combatFx.ts` was tuned for the old cadence.
- **SP divergence.** `src/game/combat.ts` keeps the old rules. Acceptable (SP is
  frozen) but should be stated in the file, not discovered later.
- **The 207 destroyers.** Whatever Q3 decides, this is the change players will
  feel most, and it lands on the class they own most of.
