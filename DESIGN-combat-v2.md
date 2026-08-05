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

## Decisions — locked 2026-08-05

- **One speed stat, and it drives travel too.** Engines are engines: they raise
  speed, speed makes you both harder to hit and faster to arrive. Speed is not a
  combat stat that happens to live on a hull — it is *the* mobility stat.
- **Settlements: speed 0.10.** They are slow, and they are hit accordingly.
- **Civilians slightly faster than a frigate**: freighter and colony **0.55**.
- **All existing ships migrate** to the new system.

| | Corvette | Frigate | Destroyer | Freighter | Colony | Settlement |
|---|---|---|---|---|---|---|
| Speed | 0.85 | 0.50 | 0.30 | 0.55 | 0.55 | 0.10 |

Resulting hit chances against a settlement: corvette **98.6%**, frigate 96.2%,
destroyer 90.0%. A base cannot dodge, which is the intent — but see R1 below,
because station return fire now inherits the mirror of that.

---

## What unifying speed actually costs

**Today, hull class does not affect travel at all.** Travel acceleration is
`faction engine_g x propulsion tech x engine parts` (`gameContext:142`). The
per-class `speedModifier` (0.7 / 1.0 / 1.4 / 1.3 / 1.6) is read by exactly one
function, `fleetSpeedModifier`, **which nothing calls**. A corvette and a
destroyer arrive at the same time.

So "speed affects travel" is not a tweak — it is a new behaviour, and it changes
strategic pacing as much as the combat rules do.

Normalising so the **frigate is unchanged** (`travelMult = 0.50 / speed`):

| class | speed | travel | a 40-tick trip becomes |
|---|---|---|---|
| Corvette | 0.85 | **41% faster** | 24 ticks |
| Frigate | 0.50 | unchanged | 40 ticks |
| Destroyer | 0.30 | **67% slower** | 67 ticks |
| Freighter / Colony | 0.55 | 9% faster | 36 ticks |

Two consequences worth being deliberate about:

1. **Destroyers get slow.** 67% longer to reposition, on top of being the class
   everything else out-runs in a fight. That is a coherent identity (a slow
   heavy that dominates where it stands) but it is a second nerf landing on the
   class that is 64% of the live fleet.
2. **The maths needs care.** Trip time is brachistochrone, `T = 2*sqrt(d/a)`, so
   travel time scales with `1/sqrt(accel)`. To get a *linear* speed ratio the
   acceleration must scale as **speed squared** (corvette accel x2.89,
   destroyer x0.36). Scale accel linearly by mistake and a corvette is only 23%
   faster instead of 41% — it will feel sluggish and nobody will know why.

**Engines still work exactly as they do today.** One engine is `x1/0.85` speed,
which under `travelMult = 0.50/speed` is precisely the `x0.85` travel multiplier
already shipped. The unification preserves the existing engine behaviour and
finally explains *why* it works.

---

## Still open

### R1. Does the speed cap apply to travel, or only to combat?

The 1.176 cap exists to stop an engine/propulsion arms race in the hit formula.
If it also caps travel, **Propulsion tech stops improving travel** past a point —
a regression from today, where it keeps helping forever.

Note the hit formula `a^2/(a^2+d^2)` already saturates on its own; it can never
reach 100%. So the cap may be unnecessary. Options: cap both (simple, nerfs late
travel), cap neither (re-opens the arms race I measured earlier), or **derive two
values from one base — capped for the hit roll, uncapped for travel**. The last
is my recommendation and costs one line.

### R2. Station return fire is now nearly useless

Settlements sit at 0.10, so a station shooting a **corvette** (0.85) hits
`0.01/(0.01+0.7225)` = **1.4%**. Stations become decorative. Either station guns
ignore the speed roll (they are emplacements, not dogfighters), or they get their
own much higher "gunnery" speed for the attack roll while keeping 0.10 for being
hit. This needs a decision before ships start ignoring defended worlds.

### R3. Faster civilians is an economy change, not a combat one

Freighters go from `speedModifier` 1.3 to effectively 0.91 — and 124 ships are in
flight right now with 1 299 legs already executed. Faster trade means more income
per hour across every live game. Colony ships likewise expand faster. Neither was
in the combat simulation.

### R4. In-flight ships have a stale arrival time

124 nodes are `in_transit` and 4 are `committed`. `arrival_at_tick` was computed
under the old accel. The migration must either leave live legs alone (simplest;
they land on the old schedule) or recompute every one. Leaving them is fine and
self-healing within one trip.

### R5. Multipliers the simulation never included

Damage now stacks rank (+1%/kill), Gunner captain (+10%), fleet aura, arrears
(-25%), and senate war authorization (**x2**) on top of a destroyer that went
18 -> 45. A ranked Gunner destroyer under war authorization is a very different
number than anything I modelled. Worth one sanity pass before ship.

### R6. Detonators scale with hull HP

`detonatorDamage = hp_max x 0.50 x count`. Destroyer `hp_max` doubles 200 -> 400,
so a detonator destroyer doubles in blast. Detonators were **excluded from every
simulation** as a distorting mechanic. This is now a live balance question.

### R7. Cadence-derived constants

Firing every tick instead of every third invalidates several tuned numbers:
`COMBAT_RECENT_TICKS` (= interval x 2) in `systemGrouping.ts:310` and
`useSituationItems.ts:278`; the settlement repair grace, justified in
`room.js:2892` as ">= the combat cadence (3)"; and the tracer budget in
`combatFx.ts:131`, which now sees 3x the shots with most of them missing.

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

### Travel — newly in scope now that speed drives it

| File | Change |
|---|---|
| `src/state/gameContext.tsx:142` | `engineAccel` gains a per-class factor. Must be **speed²** relative to the frigate, not speed (brachistochrone). |
| `src/state/gameContext.tsx:965,1963` | The other two `planTorchTransfer` call sites take the same factor, or a corvette's queued legs disagree with its first one. |
| `worker/room.js:1740,1951` | Server-side autopilot legs (trade + AI) build their own nodes; they must use the same factor or freighters desync from the client's quoted ETA. |
| `src/game/shipClasses.ts:21` | `speedModifier` becomes derived from the new speed rather than a second, contradictory source of truth. Delete it or define it as `0.50/speed`. |
| `src/game/fleet.ts:34` | `fleetSpeedModifier` currently has **no callers**. Either wire it up (a fleet moves at its slowest hull) or delete it — leaving it is how the next person gets misled. |

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
