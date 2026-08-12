# DESIGN — Transit combat: range, closest approach, and matching velocity

*Status: design only, nothing built. Model chosen with Lorne 2026-08-12.
Extends DESIGN-combat-v2.md rather than replacing it — every number in that
document still holds for two ships parked at the same body.*

## The problem

A ship in flight cannot be shot and cannot shoot (`room.js`, the
`inTransitIds` filter). Three consequences:

- **Fleeing is free.** Retreat, and you are immune the instant you depart.
  There is no cost to disengaging and no parting shot.
- **The space between bodies has no consequence.** Every fight happens at a
  body; the map between them is decoration.
- **The game contradicts itself.** The Trades panel tells players
  "Freighters can be raided — escort what you can't afford to lose." They
  cannot be. A loaded freighter crossing hostile space is untouchable.

That filter is not a bug, though — it was a **fix**. `parent_body_id` keeps
pointing at the departure body during flight, so hulls were being shot from
a body they had already left ("Osprey at 1% HP, damaged in transit"). Any
design here must make that impossible *structurally*, not by another filter.

## The model

Three rules. Everything else follows from them.

### R1 — Every combatant has a position and a velocity, for the whole tick

Each ship contributes a **segment**: where it is at the start of the tick and
where it is at the end.

| Ship state | Segment |
|---|---|
| Parked at a body | parent body's position at `t` → at `t+1` (station-keeping) |
| In transit | its torch trajectory at `t` → at `t+1` |

A parked ship therefore **inherits its parent body's velocity**. Two ships
parked at the same body have *identical* segments, so their relative velocity
is exactly zero — which is what makes R3 collapse to today's numbers for
every fight that happens now.

Straight segments are honest here: the torch simulator already substeps at
`MAX_SUBSTEP = 1` tick, so one line per tick is exactly the fidelity the
simulation itself runs at.

### R2 — Engagement is closest approach within range

For attacker A and defender B over one tick:

```
r0 = A.p0 − B.p0                        relative position at tick start
w  = (A.p1 − A.p0) − (B.p1 − B.p0)      relative motion over the tick
t* = clamp( −(r0·w) / (w·w), 0, 1 )     time of closest approach (0 if w·w = 0)
dMin = | r0 + t*·w |                    closest separation, world units
Δv   = | w |                            relative speed, units per tick
```

**A may fire on B if `dMin ≤ A.range`.**

Closest approach, not distance-at-an-instant, and this is not a nicety. At
0.05 g a Titan→Enceladus hop peaks at **42 units/tick** against a 67-unit
separation — two ships closing head-on converge faster than the entire gap in
a single tick. Sampling once per tick would miss most crossings entirely
(bullet-through-paper). `t*` costs eight multiplies and fixes it exactly.

**Range per hull** (new stat on `SHIP_COMBAT_STATS`, world units):

| | Corvette | Frigate | Destroyer | Freighter | Colony |
|---|---|---|---|---|---|
| Range | 12 | 16 | **20** | 0 | 0 |

Bigger gun, longer reach; the corvette's edge is that it can *close*, not
that it can reach. Unarmed hulls have no range — they never initiate. They
are still perfectly targetable.

**Guardrail: parked-vs-parked still requires the same parent body.** Range
gates engagements where *at least one* party is in transit. Without this
guardrail a destroyer parked at Saturn (range 20) would start covering
Enceladus 20 units away, silently rebalancing every game in flight. Same
body, or someone is moving — those are the only ways to fight.

### R3 — Relative velocity is evasion

The defender's combat speed is scaled by how badly the two are velocity-
matched, and the existing hit formula is untouched:

```
k      = 1 + Δv / V_REF                 evasion factor, ≥ 1
defEff = defender.speed × k
p(hit) = atk² / (atk² + defEff²)        DESIGN-combat-v2.md, unchanged
```

`V_REF = 45` units/tick (host-tunable), calibrated so a typical intra-system
hop **at peak burn roughly doubles** the defender's evasion.

At `Δv = 0`, `k = 1` and every ship uses its original speed value — so two
ships parked at the same body fight with exactly the hit matrix in
DESIGN-combat-v2.md. Nothing about today's balance moves.

Applied to the **defender in each roll**, so a mutual engagement gets harder
for *both* sides as Δv rises — which is the physical truth (you are both
trying to track something moving fast across your sights) without inventing a
second probability multiplier.

> **`SPEED_CAP` must not clamp `defEff`.** The 1.176 cap exists to bound
> *design-time* agility from engine parts. If it also clamped the velocity
> term, a fleeing freighter would gain almost nothing and the whole mechanic
> would quietly do nothing. Cap the stat; never cap the product.

## What the numbers do

Corvette (speed 0.85) firing on a freighter (0.55):

Computed at the live game's own numbers (`engine_g` 0.05 → **26.52 units/tick²**):

| Freighter's situation | Δv | k | Chance to hit |
|---|---|---|---|
| Parked at the same body | 0 | 1.00 | **70.5%** *(today's number)* |
| Just departed — one tick of burn | 26.5 | 1.59 | **48.6%** |
| Mid-hop between moons, peak burn | 42.2 | 1.93 | **39.0%** |
| Mid-cruise, interplanetary | 211.5 | 5.69 | **6.9%** |

Peak speeds behind those, same acceleration: Titan→Rhea (30 u) peaks at
**28 u/t** over 2.1 ticks; Titan→Enceladus (67 u) at **42 u/t** over 3.2
ticks; a Saturn-radius heliocentric leg (1686 u) at **212 u/t** over 16 ticks.

**Checked invariant:** at `Δv = 0` this reproduces the DESIGN-combat-v2.md hit
matrix to the decimal — 50.0 / 74.3 / 88.9, 25.7 / 50.0 / 73.5,
11.1 / 26.5 / 50.0. Every fight that happens in the game today is numerically
untouched.

Three things fall out of this that we did not have to design separately:

- **The parting shot is free.** Departure is processed ~750 lines before
  combat in the same tick, so a ship that ran this tick is already in transit
  when guns fire — and its segment *starts at the body it fled*. `dMin ≈ 0`,
  Δv only one tick of acceleration. It gets shot at, at reduced odds. No
  special case, no attack-of-opportunity subsystem.
- **Interception happens at the ends, never the middle.** A brachistochrone
  is slow at both ends and fastest in the middle, and evasion tracks speed.
  You cannot ambush an interplanetary cruise at its midpoint; you catch it
  leaving or arriving. That is both realistic and tactically legible.
- **It is self-limiting.** Transits last 3–15 ticks and only ships genuinely
  within range fire, so this adds a volley or two, not a slugfest.

## Server owns the trajectory

Today `game_ship_nodes` stores `anchor_body_id`, `target_body_id`,
`scheduled_t`, `executed_at_tick`, `arrival_at_tick` — **no position and no
velocity**. Only the client knows where a ship is mid-flight, because only
the client builds the torch plan.

If the server re-derived arcs independently we would have two derivations of
one truth, and shots would come from where the client does not draw the ship.
That is exactly the bug class that just cost three attempts in the aiming
code (the map was drawn with one camera and hit-tested with another). Do not
repeat it.

**Migration:** store the launch plan on the node, immutable, at departure:

```
launch_x, launch_y, launch_vx, launch_vy   REAL   state at burn start
accel                                      REAL   units/tick², from engine_g × parts × tech
flip_tick                                  REAL   when it stops accelerating and starts braking
```

Position becomes a **pure function of tick** — no per-tick writes, replay-safe,
and `/state` ships the same plan so the client renders the *server's* arc
instead of its own. One derivation, permanently.

## Edge cases the two rules have to answer

| Case | Δv | Result | Why that's right |
|---|---|---|---|
| Two ships parked at the **same** body | 0 | Full engagement, today's odds | Both segments are the body's; velocity matched by definition |
| Two ships parked at **different** bodies | body-relative | **No engagement**, whatever the distance | The same-body guardrail; prevents silent rebalancing |
| Chaser and target on the **same heading, matched burn** | ~0 | Full engagement, today's odds | A stern chase at matched velocity *is* a knife fight — the good outcome, and it makes escorting work |
| Head-on pass | up to 2× peak | Almost no hits | You get one blurred crossing; correct |
| Departing this tick | one tick of burn | Parting shot at ~49% | Falls out of the ordering (see below) |
| Arriving this tick | braking, near 0 | Full engagement on arrival | Arriving into a defended orbit should hurt |
| Both in transit, same lane, opposite ways | ~2× peak | Grazing at best | "Interception is possible but not easy" |
| Unarmed hull (range 0) | any | Never initiates; always targetable | Freighters run, they don't fight |

The stern-chase row is the one that makes the whole model feel right: **match
velocity and you get a real fight; refuse to match and neither of you can
shoot.** That is the tactical decision the mechanic creates, and it is why
`Δv` and not raw speed is the input.

## Chases: you cannot catch anything by leaving after it

Two ships on the *same* lane, identical burns, pursuer launching `d` ticks
late. During the shared boost phase the algebra is clean:

```
Δv         = accel × d                       constant, however long they've burned
separation = ½ × accel × d × (2τ − d)        τ = leader's burn time so far
```

Δv depends only on the **launch gap**, not on elapsed time. But separation
grows with τ — the leader had a head start under the same acceleration, so it
pulls away. Simulated, Titan→Enceladus (67 u, flip at 1.59, arrival at 3.18),
pursuer one tick late:

| t | leader (x, v) | pursuer (x, v) | gap | Δv | in range (10)? |
|---|---|---|---|---|---|
| 1.00 | 13.3, 26.5 | 0.0, 0.0 | 13.3 | 26.5 | no |
| 1.50 | 29.8, 39.8 | 3.3, 13.3 | 26.5 | 26.5 | no |
| 2.00 | 48.6, 31.3 | 13.3, 26.5 | **35.3** | **4.7** | no |
| 2.50 | 60.9, 18.0 | 29.8, 39.8 | 31.1 | 21.8 | no |
| 3.18 | **67.0, 0.0** *(arrived)* | 53.8, 26.5 | 13.2 | 26.5 | no |
| 3.50 | 67.0, 0.0 | 60.9, 18.0 | 6.1 | 18.0 | **YES** |
| 4.18 | 67.0, 0.0 | 67.0, 0.0 | 0.0 | 0.0 | **YES** |

Four things follow, and none of them had to be designed:

- **A stern chase never gets a shot in flight.** The gap peaks at 35 units —
  3.5× a destroyer's transit range — and only falls inside range *after the
  target has already parked*. You don't catch them in the open; you catch them
  at the door.
- **The gap is widest at mid-flight and narrowest at both ends**, which is the
  same shape as the evasion curve. Every part of this model says the same
  thing: fights happen at the ends of trips.
- **There is a speed-crossing window in every chase.** At t = 2.00 the leader
  is braking while the pursuer is still boosting and their speeds nearly match
  — Δv drops to **4.7**, a 66% shot, for a moment. Here they're 35 units apart
  so nothing happens. Arrange to be *close* at that moment and it's a kill.
  That is the skill ceiling of this mechanic.
- **Escorting works, and the rule is simple: launch on the same tick to the
  same destination.** Identical burns means Δv = 0 and gap = 0 for the whole
  flight, so an escort holds formation, stays in range, and shoots any
  interceptor at exactly the odds it shoots the freighter. No new code.

### Long burns: the ends don't change, only the middle

Titan→Mars, real positions at T+38: **1347 units, 14.25 ticks (~14 hours at an
hour a tick), peak 189 u/t.** Same one-tick-late pursuer:

| t | leader v | pursuer v | gap | Δv | in range? | corv→frt |
|---|---|---|---|---|---|---|
| 2.00 | 53.0 | 26.5 | 39.8 | 26.5 | no | 48.6% |
| 7.13 *(flip)* | 188.9 | 162.6 | 175.8 | 26.4 | no | 48.7% |
| 8.00 | 165.8 | 185.6 | **178.7** | **19.8** | no | 53.5% |
| 13.00 | 33.2 | 59.8 | 46.5 | 26.5 | no | 48.6% |
| 14.25 | 0.1 *(arrived)* | 26.6 | 13.4 | 26.5 | no | 48.6% |
| 14.50 | 0.0 | 20.0 | 7.5 | 20.0 | **YES** | 53.4% |
| 15.25 | 0.0 | 0.1 | 0.0 | 0.1 | **YES** | 70.4% |

The chase gets *worse* with distance, not better — the gap peaks at **179
units**, 18× a destroyer's range, against 35 on the moon hop. And the cruel
irony: Δv sits at 26.5 for the entire chase, so the pursuer always has a
48.6% shot and never once has a target.

Mid-cruise interception is effectively dead at this speed: **8.1%** crossing,
**2.6%** head-on.

**The important property — the ends are scale-invariant.** The first and last
tick of *any* brachistochrone are identical, because a tick of constant
acceleration is a tick of constant acceleration:

> 13.3 units covered, 26.5 u/t, Δv = 26.5, **48.6%** to hit —
> the same for a 30-unit moon hop and this 1347-unit haul.

Only the untouchable cruise in the middle lengthens. So `V_REF` and the range
table get tuned **once** and behave identically across a map spanning Charon
at 6 units to Sedna at 7000. That is a much stronger guarantee than I expected
this model to give, and it is the reason the numbers can be locked before the
feature ships.

It also softens the fairness problem I flagged earlier: the vulnerable window
is **roughly two ticks — one at each end — regardless of trip length.** A
14-hour haul is not 14 hours of exposure; it is two, with twelve hours of
untouchable cruise between them. Long hauls are proportionally *safer*.

One consequence for tooling: at 189 u/t a 10-unit range means the engagement
window is 0.1 of a tick, and an intercept has to be accurate to ~10 units out
of 1347 — **0.7%**. Trivial for a solver, impossible by hand. This is the
second independent argument for the rendezvous order below.

### The consequence worth deciding on

Matched velocity means neither side can disengage. Two hostile ships that
launch together on the same lane are locked in a **running fight at full odds
for the entire flight** — three, five, sixteen ticks of volleys — and neither
can break off, because a committed torch burn cannot be re-aimed and
`retreat_hp_pct` has nowhere to send them. Convoy battles become fights to the
death.

That is good drama and probably good design, but it is a real escalation and
it should be a choice, not a surprise. Either accept it, or allow a
mid-flight course change (an abort burn back to the origin) as the transit
equivalent of retreating.

### The missing order

This mechanic rewards velocity matching, and the order system has no way to
ask for it. Today a player can only pick a **destination body**. So:

| Intent | Expressible today? |
|---|---|
| Escort — fly with my freighter | **Yes.** Same destination, same tick. |
| Pursue — chase that ship down | **No, and it wouldn't work anyway** (above). |
| Intercept — meet that ship in space | **No.** You must guess a destination whose trajectory happens to pass near theirs at low Δv, with no tooling. |

Interception is the whole point and it is currently a lottery. The fix is a
**rendezvous order that targets a ship rather than a body**, solving for a
burn that arrives at the target's predicted position *with its velocity
matched* — i.e. deliberately Δv ≈ 0, deliberately a real fight.

`planTorchTransfer` already iterates against a moving target
(`interceptPos = bodyPosition(target, currentTick + T)` inside a convergence
loop). Generalising that from "a body's future position" to "a ship's future
trajectory" is a natural extension of code that already exists, and it shares
the closest-approach primitive this design needs anyway. **I'd treat it as
part of stage 1, not a follow-up** — without it, interception is theory.

## Surface area

**Migration** (one, additive, no backfill needed — nodes without a plan are
pre-flag and simply don't participate):

```sql
ALTER TABLE game_ship_nodes ADD COLUMN launch_x   REAL;
ALTER TABLE game_ship_nodes ADD COLUMN launch_y   REAL;
ALTER TABLE game_ship_nodes ADD COLUMN launch_vx  REAL;
ALTER TABLE game_ship_nodes ADD COLUMN launch_vy  REAL;
ALTER TABLE game_ship_nodes ADD COLUMN accel      REAL;
ALTER TABLE game_ship_nodes ADD COLUMN flip_tick  REAL;
```

**Constants** — `worker/factions.js`, beside `SHIP_COMBAT_STATS`:
`range` per class (12 / 16 / 20 / 0 / 0).

**Config knobs** — `worker/configSchema.js`, group `combat`:

| id | default | range | note |
|---|---|---|---|
| `transit_combat_enabled` | `false` | bool | Per-game kill switch for stages 1–2 |
| `transit_evasion_v_ref` | `45` | 10–500 | The `V_REF` in R3 |

**Pure module** — `worker/transitCombat.js`, so both tests and the sim can
call it without a DB: `closestApproach(a0, a1, b0, b1)` → `{ dMin, dv, t }`,
and `evasionFactor(dv, vRef)`.

**Client** — `/state` ships the launch plan per in-transit ship; `MapCanvas`
renders the arc from **that** instead of its own plan. `combatFx`'s existing
`spawnTracer(fromId, toId)` already resolves ships, and
`transitShipCanvasPosRef` already tracks in-flight screen positions, so
tracers between two moving hulls need no new drawing code.

## Where it slots in the tick

Unchanged up to combat. Inside the combat pass, replacing the `inTransitIds`
skip:

1. **Build combatants.** Parked hulls (segment = parent body) and in-transit
   hulls (segment from the stored plan). Nobody is filtered out.
2. **Broad phase.** Bucket every segment into a uniform grid of cell size 20
   (the longest range) and only test pairs in neighbouring cells. Keeps this
   linear in practice; a naive all-pairs pass at ~100 ships is only ~5k pairs
   and would also be fine, but the grid stops that being a cliff later.
3. **Narrow phase.** `dMin`/`Δv` per candidate pair (R2).
4. **Target selection.** Candidate set per attacker = same-body parked enemies
   ∪ in-range transit contacts, then the **existing** priority tiers
   (warships → freighters, never a settlement while a warship lives) and the
   existing round-robin single-target rule. One targeting path, not two.
5. **Roll.** `rollFor(attackerId, tick)` unchanged — still one roll per
   attacker per tick, still seeded on `(attacker, tick)` only, so replays and
   every client still agree.

## Telemetry

Combat v2's numbers came from ~990,000 simulated battles, and that only
worked because shot-level data was recorded. Extend the existing
`combatTally` / `shipStats` rows with:

- `in_transit_attacker`, `in_transit_defender` (bool)
- `d_min`, `delta_v` bucketed
- realised `k`

Without this, `V_REF` and the four range values get tuned by vibes.

## Rollout

| Stage | Ships | Why separately |
|---|---|---|
| **0** | Server-owned trajectory + client renders the server's arc | Pure refactor, no combat change. De-risks the fidelity problem on its own, where a mistake is visible and harmless. |
| **1** | Transit combat behind a per-game `transit_combat_enabled` flag, default **off**; telemetry on | Turn it on in a sim room, not in Peace Zone. |
| **2** | Tune `V_REF` + ranges from stage-1 data; default on for **new** games | Never retune a live game's physics under its players. |
| **3** | *Optional:* armed stations get range (~18) — a defensive umbrella over their orbit | Makes blockade-running dangerous and gives stations a job. Scope it only once 1–2 are stable. |

MP only. Single-player stays frozen.

## Test plan

Pure tests (the `[pure]` convention already in the suite) for the parts that
are just arithmetic — these are where the bugs will be:

- `closestApproach`: head-on crossing inside one tick (the case naive
  sampling misses), parallel travel (`w·w = 0`), `t*` clamped at both ends,
  co-located parked pair → `dMin = 0`.
- `evasion`: `Δv = 0` reproduces the DESIGN-combat-v2.md hit matrix exactly;
  `defEff` is not clamped by `SPEED_CAP`.
- **The regression that started all this:** a ship that departed body A and is
  now far away must take **zero** damage from hulls still at A. The old bug
  was `parent_body_id` lying; assert it with real positions.

Balance sim over the existing harness before stage 2.

## Open decisions for Lorne

1. **Offline interception.** At an hour a tick, being intercepted means losing
   ships while asleep on a course committed hours earlier. Suggested
   mitigation: only armed hulls initiate, plus a Situation Report warning
   ("hostile on an intercepting course") driven by predicted closest approach
   next tick, so returning players see why. Accept, or restrict interception
   further?
2. **Freighters raidable mid-run.** The trade copy already promises it and it
   makes escorts matter — but it taxes whoever logs in least. Yes?
3. **Station umbrella** (stage 3) — in or out?
4. **Does range scale with weapon parts?** Kept per-class in v1 so parts stay
   about damage and agility. A `+2/mount` lever exists if reach should be
   buildable.
