# DESIGN — Transit combat: range, closest approach, and matching velocity

*Status: design only, nothing built. Model chosen with Lorne 2026-08-12;
the four open decisions closed with Lorne 2026-08-14 (see Decisions, below —
they are folded into the body of this document, so what you are reading is
the agreed design, not the menu).
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

**Range is HALVED inside a planet's sphere of influence** (knob:
`transit_range_in_system_mul`, default 0.5). The table below is sized for
open space, and moon systems are packed an order of magnitude tighter —
Uranus runs 6 / 8 / 9 / 15 units between neighbours against hundreds
between planets. At full reach a destroyer parked at one Uranian moon
covers three orbits at once, which is what it looked like on the map.
Halved, no class can shoot across an adjacent moon gap at Jupiter, Saturn
or Neptune; Uranus stays the tight one, where a destroyer still spans
three of its four gaps. Tighten the knob further if that reads wrong in
play.

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

### R3 — Aim and opportunity are two different things

**Revised 2026-08-14.** The original R3 penalised the defender by total
relative speed, `k = 1 + |w| / V_REF`. That is wrong, and the way it is wrong
matters: `|w|` is a **magnitude**, so the model cannot tell a head-on pass
from a beam pass from a stern chase at the same speed. With one input that
only ever grows, transit could only ever be a penalty — which is exactly the
complaint that surfaced in review.

Being hard to hit is really two unrelated things, and they need separate
terms:

```
w    = relative velocity over the tick        (as in R2)
û    = unit(r0)                                line of sight AT TICK START
w_r  = w · û                                   closing (−) / opening (+)
w_t  = | w − w_r·û |                           CROSSING component

k      = 1 + w_t / V_REF                       AIM: crossing only
f      = |{ t ∈ [0,1] : |r0 + t·w| ≤ R }|      EXPOSURE: fraction of the
                                               tick inside the shooter's range
defEff = defender.speed × k
p(hit) = f × atk² / (atk² + defEff²)
```

**Aim** is the crossing rate. Only the tangential component sweeps a target
across your sights; closing or opening does not change its bearing at all. A
ship coming straight at you is boresighted — it sits still in the reticle and
grows.

**Exposure** is how much of the tick you were in range to shoot at all. A
target crossing at 380 units/tick clears a 12-unit envelope in 6% of a tick.
That is a real and separate reason not to land a shot, and folding it into the
aim term (as `|w|` did) conflates two effects that behave differently.

> **Solve the overlap; do not use chord ÷ speed.** `2·√(R² − dMin²)/|w|`
> looks equivalent and is the obvious way to write this, but it assumes the
> target ENTERS and EXITS the envelope. The commonest transit engagement in
> the game breaks that assumption: a ship fleeing the body you are parked at
> starts at the centre and only ever flies the outbound half. Implementation
> caught this — the shortcut returned `f = 1.00` ("never left") where the
> truth is 0.905, which quietly upgraded the parting shot from the intended
> **63.8%** to a full point-blank **70.5%** and handed fleeing hulls' hunters
> a bonus the design never granted. Solving `|r0 + t·w| ≤ R` for `t` and
> clamping to the tick is one quadratic and is right in every case.

> **Evaluate the decomposition at TICK START, off `r0` — never at closest
> approach.** At `t*`, relative position is perpendicular to relative velocity
> *by definition* (`d/dt |r|² = 0 ⟹ r·w = 0`), so at that instant everything
> reads as crossing, `w_t = |w|`, and the split silently degenerates back into
> the model it replaces. This will look like "the fix did nothing" and it will
> cost somebody a day.

**Hit floor: 5% on the aim term, before exposure scales it.** A mechanic that
fires at 0.4% is a mechanic that does nothing. Floor the aim probability at
0.05, then multiply by `f` — so you never get a 5% shot at something you were
in range of for 6% of a tick. Footprint check: at the parked, departure and
moon-hop regimes the floor changes exactly **one** cell of the 15-cell matrix
(destroyer→corvette). It only really engages in deep cruise, where the values
it flattens (0.4% / 1.1% / 3.0%) were noise anyway.

At `w_t = 0` and `|w| = 0`, `k = 1` and `f = 1` — so two ships parked at the
same body, and two ships flying in matched formation, both fight with exactly
the hit matrix in DESIGN-combat-v2.md. **Nothing about today's balance moves.**

> **`SPEED_CAP` must not clamp `defEff`.** The 1.176 cap exists to bound
> *design-time* agility from engine parts. If it also clamped the velocity
> term, a fleeing freighter would gain almost nothing and the whole mechanic
> would quietly do nothing. Cap the stat; never cap the product.

> **`V_REF = 45` must be RECALIBRATED.** It was tuned against total relative
> speed; against the crossing component alone it means something different.
> Re-derive it before stage-1 telemetry, not after — otherwise stage 2 tunes a
> model nobody validated.

### R4 — You cannot shoot what you cannot see

Engagement additionally requires **line of sight from the shooter to the
target**, using the occlusion test the sensor system already runs
(`segmentIntersectsDisk`, `src/game/visibility.ts`). A target behind a planet
cannot be fired on, however close it is.

Numerically this never binds as a *range* limit — sensor ranges outrun weapon
ranges by 15–30× (corvette 300 vs 12, destroyer 350 vs 20, station 800). Its
teeth are entirely geometric, and it earns its place by closing three holes
with one test:

- **The rule players expect.** You should not be able to shoot through a moon.
- **The fog-of-war leak.** Rendering fire at an in-transit enemy would reveal
  its position. If there is no line of sight there is no engagement, so there
  is no tracer, so there is nothing to leak.
- **Tracer occlusion.** The FX layer needs this exact test anyway (today it
  fakes it from the shared parent body, which two ships in open space do not
  have).

**Detection may be faction-wide; line of sight is per-shooter.** Sensors are
networked, guns are not — a spotter with a clear view lets the fleet *know*
about a target, but a hull with a planet in the way still cannot shoot it.

## What the numbers do

Corvette (speed 0.85) firing on a freighter (0.55), at the live game's own
numbers (`engine_g` 0.05 → **26.52 units/tick²**). "Old" is the superseded
`|w|` model, kept so the change is legible:

| Freighter's situation | \|w\| | w_t | Old | **R3 as revised** |
|---|---|---|---|---|
| Parked at the same body | 0 | 0 | 70.5% | **70.5%** *(today's number)* |
| Matched formation at cruise | 0 | 0 | 70.5% | **70.5%** |
| Just departed — one tick of burn | 26.5 | 0 | 48.6% | **63.8%** |
| Beam pass, mid moon-hop | 42.2 | 42.2 | 38.9% | **19.1%** |
| Oblique 45°, mid moon-hop | 42.2 | 29.8 | 38.9% | **22.8%** |
| Head-on, interplanetary | 378 | 0 | 2.6% | **4.5%** |
| Crossing, interplanetary | 211.5 | 211.5 | 6.8% | **0.7%** |

Read the shape rather than the cells. Geometry now *varies* — a beam pass and
a radial departure at the same speed differ by 45 points, where the old model
scored them identically. The parting shot gets **stronger**, which serves the
document's own stated problem ("fleeing is free") better than the model
written to fix it. And a head-on at cruise is still hard, but now for an
honest reason: perfect aim, 6% of a tick to use it.

**Damage stays flat. Δv scales the hit roll and nothing else.** This was
tested and rejected, and the arithmetic is worth keeping because it is
counter-intuitive. In the high-Δv tail `p ≈ atk²/(def²k²)`, so hit chance
falls as `1/k²`. Scale damage by `m(k)` and expected damage goes as `m/k²`:

| Damage scaling | Expected damage vs. Δv | Verdict |
|---|---|---|
| `m = 1` (flat) | falls as `1/k²` | **chosen** |
| `m = k` (linear) | falls as `1/k` | weakens the mechanic ~10× |
| `m = k²` (**true kinetic energy**) | **constant** — cancels R3 exactly | breaks it |

And at real numbers `m = k²` does not merely cancel: at a head-on cruise pass
`k = 9.4`, so expected damage is `0.0263 × 88 = 2.33` against `0.705` for a
point-blank matched fight. **Physically honest kinetic scaling would make the
head-on ramming pass 3.3× better than a knife fight at zero range**, and the
dominant attack in the game. Anyone who re-proposes it — and someone will,
because it is obviously correct physics — should be shown this row.

If the head-on pass should hurt, the home for that is **RAM** (which already
exists for asteroids), not the gun. It is a distinct action with its own risk,
and it does not touch a hit formula tuned over ~990,000 battles.

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

### Running fights are to the death — DECIDED, accepted

Matched velocity means neither side can disengage. Two hostile ships that
launch together on the same lane are locked in a **running fight at full odds
for the entire flight** — three, five, sixteen ticks of volleys — and neither
can break off, because a committed torch burn cannot be re-aimed and
`retreat_hp_pct` has nowhere to send them. Convoy battles become fights to the
death.

**Accepted as designed (Lorne, 2026-08-14).** No abort burn. Launching onto a
lane alongside a hostile is a commitment, and the drama is the point.

One obligation follows, and it is not optional: **`retreat_hp_pct` silently
stops working in transit**, and a setting that quietly does nothing is the
worst kind of UI. The retreat control in ShipPanel must say so — a line on
the control itself ("no effect in transit — a committed burn can't be
re-aimed"), not a tooltip nobody opens. A player who set a ship to run at 25%
and watched it die at 0% mid-flight is owed the reason *before* it happens.

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

**Agreed shape (Lorne, 2026-08-14), in build order:**

1. **Meet at their destination.** Read the target's destination and arrival
   tick, plan an ordinary transfer timed to arrive with them. **No new solver
   at all.** The chase analysis above says this captures nearly all the real
   value — you catch things at the door, never in the open — so it ships first
   and alone if the rest slips.
2. **Matched-velocity rendezvous.** The full solver: arrive at the target's
   predicted position carrying its velocity, deliberately Δv ≈ 0. This is a
   position-*and*-velocity boundary problem, materially harder than today's
   "arrive at a moving point," and it is what makes true mid-flight
   interception possible rather than theoretical.
3. **Follow on meet.** On rendezvous, copy the target's remaining burn plan.
   Without this the match lasts one tick and the two drift apart; with it,
   identical burns hold `Δv = 0` and gap ≈ 0 for the rest of the flight. This
   is what makes escorting work when you *weren't* at the same body at the
   same moment — which is every case that actually comes up.

Two properties this inherits for free, both from decisions already made:

- **The target cannot dodge.** No abort burn (see above) means a committed
  trajectory is immutable in flight, so the solver is aiming at something that
  cannot move under it. Rendezvous is reliable *because* running fights are to
  the death.
- **Interception is an intel problem.** Solve against the target's *last
  known* trajectory, gated on sensor coverage (R4), never against server
  ground truth. Good sensors make interception surgical; poor sensors make you
  miss. That puts the difficulty somewhere the game already has a system for,
  instead of inventing a new lever.

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
call it without a DB:

```
closestApproach(a0, a1, b0, b1)   -> { dMin, dv, tStar, w, r0 }
crossingComponent(r0, w)          -> w_t        (evaluated at r0, see R3)
aimFactor(wT, vRef)               -> k
exposure(w, dMin, range)          -> f in [0,1]
hitChance(atk, def, k, f, floor)  -> p
```

Split this finely on purpose: every one of these is arithmetic with a known
answer, and they are where the bugs will be.

**Client** — `/state` ships the launch plan per in-transit ship; `MapCanvas`
renders the arc from **that** instead of its own plan.

**Combat animations: in scope for stage 1, and NOT free.** An earlier draft of
this document said tracers "need no new drawing code." That is true of the
drawing and false of everything else, which is the kind of sentence that gets
read as *already handled* during planning. The real picture, verified against
the code 2026-08-14:

*Genuinely already done:*

- `shipCanvasPos()` (`combatFx.ts:94`) already resolves in-transit hulls from
  the renderer's cached polyline-lerped position, so a tracer between two
  moving ships would draw correctly today if anything asked for one.
- The **true attacker→target pair is already on the wire.** The server stamps
  `last_target_id` when a hull fires (`room.js:4418`) and `/state` ships it;
  `drawEngagementFire` reads that stamp. No new data plumbing.
- Damage flashes already fire for transit ships (set before the transit guard).
- Combat renders as *continuous state* keyed on `last_combat_tick`, not
  per-shot events — so a sixteen-tick running fight reads as a sustained
  firefight between two moving hulls for its whole duration. That is a better
  visual than parked combat gets, for free.

*Actually blocking, all the same assumption — a combatant lives at a body:*

| Where | What blocks |
|---|---|
| `combatFx.ts:581` | `if (s.transit) continue;` — a flying hull never joins the engaged set |
| `combatFx.ts:587` | A shooter's location *is* `parentBodyId` — for a transit ship, the body it left |
| `combatFx.ts:590` | Hostility presence bucketed per body |
| `combatFx.ts:643` | Even the correct stamped target is rejected unless it shares the shooter's body |
| `combatFx.ts:664` | The fallback target picker filters the same way |
| `MapCanvas.tsx:785` | One-shot damage tracer guarded on `!ship.transit` |

So the work is "replace *at a body* with *at a position*" through one file —
and stage 0 hands you that position. Three calls that come with it:

- **Occlusion** currently derives the blocking body from the shooter's parent,
  which two ships in open space do not share. Use R4's line-of-sight test —
  it is the same test, and it is required for correctness anyway.
- **Fog of war**: draw an engagement only where the viewer can see the
  shooter. R4 makes this structural rather than a filter — no line of sight,
  no engagement, no tracer, nothing to leak.
- **Drop the fallback target picker in transit.** It exists for a missing
  stamp and guesses a nearby hostile; in open space there is no sane guess.
  Transit fire draws from the stamp or not at all.

Side benefit worth having: making the engaged set position-based rather than
body-based removes a standing class of bug where a ship's drawn position and
its `parent_body_id` disagree.

Two more client pieces, both stage 1 and both consequences of the decisions:

- **Situation Report: "hostile on an intercepting course."** Predicted closest
  approach for next tick, per the decision on offline interception. The hook
  already exists — `useSituationItems.ts` is where every other attention
  category lives.
- **ShipPanel: `retreat_hp_pct` says it has no effect in transit.** On the
  control itself, not in a tooltip. A retreat setting that silently stops
  applying mid-flight is the one way "fights to the death" turns into a bug
  report instead of a design choice.

## Where it slots in the tick

Unchanged up to combat. Inside the combat pass, replacing the `inTransitIds`
skip:

1. **Build combatants.** Parked hulls (segment = parent body) and in-transit
   hulls (segment from the stored plan). Nobody is filtered out.
2. **Broad phase.** Bucket every segment into a uniform grid of cell size 20
   (the longest range) and only test pairs in neighbouring cells. Keeps this
   linear in practice; a naive all-pairs pass at ~100 ships is only ~5k pairs
   and would also be fine, but the grid stops that being a cliff later.
3. **Narrow phase.** `dMin` / `w` / `w_t` per candidate pair (R2, R3).
4. **Line of sight.** Drop any pair whose segment is occluded (R4). Do this
   *before* target selection, so an unshootable contact never becomes the
   round-robin's chosen target and wastes the attacker's volley.
5. **Target selection.** Candidate set per attacker = same-body parked enemies
   ∪ in-range, in-sight transit contacts, then the **existing** priority tiers
   (warships → freighters, never a settlement while a warship lives) and the
   existing round-robin single-target rule. One targeting path, not two.
6. **Roll.** `p = f × atk²/(atk² + (def·k)²)` with the 5% aim floor.
   `rollFor(attackerId, tick)` unchanged — still one roll per attacker per
   tick, still seeded on `(attacker, tick)` only, so replays and every client
   still agree.

## Telemetry

Combat v2's numbers came from ~990,000 simulated battles, and that only
worked because shot-level data was recorded. Extend the existing
`combatTally` / `shipStats` rows with:

- `in_transit_attacker`, `in_transit_defender` (bool)
- `d_min`, `|w|` and **`w_t` separately** — the whole point of the R3 revision
  is that these are different, so recording only the total relative speed
  would leave stage 2 unable to tune the model it is tuning
- realised `k` and realised `f`
- **fleet composition**, alongside the shot data — see the first watch item
  below; you cannot diagnose it from hit rates alone

Without this, `V_REF` and the four range values get tuned by vibes.

### Two things to watch for specifically

**Corvette monoculture.** Speed's value is *superlinear* in relative motion.
At `k = 1` the exchange ratio between two hulls is `(a/b)²`; in the tail it is
`(a/b)⁴`. Corvette against destroyer therefore runs **8:1 parked → 52:1 at
cruise**. That may be exactly the job the class has been missing — telemetry
had the corvette at 0.70 combat power per credit against the destroyer's 9.44,
needing ~79 hulls to trade evenly (`worker/factions.js:585`), and transit
combat hands it a regime where it dominates *without touching a single
parked-combat number*. But it could equally collapse fleet composition to
corvette spam. The counterweight is that corvettes are 40 HP and die instantly
to anything that catches them at low Δv — a hypothesis, not a measurement.

**The dead diagonal.** An even matchup is `1/(1 + k²)`: 50% parked, 28% at
departure, 21% mid-hop, **3% at cruise**. Combined with fights-to-the-death,
two evenly-matched escorts locked on one lane can trade at 3% each for sixteen
ticks and resolve nothing. That is tedious rather than dangerous, but it is a
real failure mode and the cheap fix is a floor on the aim term rather than a
change to the model.

## The role split, said out loud

Range and hit rate pull in opposite directions, and the resolution is good
design that is currently only *emergent* — nothing states it, so it reads like
a contradiction:

| | Destroyer | Corvette |
|---|---|---|
| Range | **20** (longest) | 12 |
| Hit rate at cruise vs. a corvette | 0.4% | — |
| Exposure window | 1.67× a corvette's | baseline |
| Job | **Holds doors** | **Runs things down** |

A destroyer cannot convert its reach at speed — but its reach matters exactly
where `k` is low, which is the ends of trips, which is where this document
already establishes that all fights happen. Its 20-unit envelope covers the
arrival/departure window where its 0.30 speed can still land shots (10.5% on a
departing freighter, 28.4% on a station). Corvettes own the fast middle.
**Destroyers hold doors; corvettes chase.**

## Rollout

| Stage | Ships | Why separately |
|---|---|---|
| **0** | Server-owned trajectory + client renders the server's arc | Pure refactor, no combat change. De-risks the fidelity problem on its own, where a mistake is visible and harmless. |
| **1** | Transit combat behind a per-game `transit_combat_enabled` flag, default **off**; telemetry on | Turn it on in a sim room, not in Peace Zone. |
| **2** | Tune `V_REF` + ranges from stage-1 data; default on for **new** games | Never retune a live game's physics under its players. |

Stage 3 (armed stations get range — a defensive umbrella over their orbit)
was **cut** (Lorne, 2026-08-14). Stations keep range 0: they never initiate
and never cover an orbit. The tuning problem stays `V_REF` plus four range
values, with no second new lever fighting it for credit when stage-1 data
comes back.

MP only. Single-player stays frozen.

## Test plan

Pure tests (the `[pure]` convention already in the suite) for the parts that
are just arithmetic — these are where the bugs will be:

- `closestApproach`: head-on crossing inside one tick (the case naive
  sampling misses), parallel travel (`w·w = 0`), `t*` clamped at both ends,
  co-located parked pair → `dMin = 0`.
- `crossingComponent`: **purely radial motion returns ~0**, purely tangential
  returns `|w|`, 45° returns `|w|/√2`. And the regression that the whole
  revision hangs on — *evaluating at `t*` instead of `r0` returns `|w|` for
  every input.* Assert the tick-start behaviour explicitly, or a refactor will
  quietly restore the old model and every number will still look plausible.
- `exposure`: `|w| = 0` → `f = 1` (parked, no divide-by-zero); `dMin = R` →
  `f = 0`; halving `|w|` doubles `f` until it clamps at 1; `f` scales with
  range, so a destroyer's window is 20/12 of a corvette's.
- `hitChance`: `w_t = 0, f = 1` reproduces the DESIGN-combat-v2.md hit matrix
  exactly; `defEff` is not clamped by `SPEED_CAP`; the 5% floor applies to the
  aim term *before* exposure, never after.
- **Stern-chase symmetry** (verified numerically 2026-08-14, worth locking in
  a test so nobody "fixes" it): in a matched stern chase, rear→front and
  front→rear are identical, and both equal the parked case. Who is in front is
  not a physical fact — it is a statement about the star. Only the relative
  velocity vector matters.
- **The regression that started all this:** a ship that departed body A and is
  now far away must take **zero** damage from hulls still at A. The old bug
  was `parent_body_id` lying; assert it with real positions.

Balance sim over the existing harness before stage 2.

## Decisions

Closed with Lorne, 2026-08-14. All four are folded into the body above; this
section is the record of what was chosen and what each one obliges.

1. **Offline interception — armed hulls only, plus a warning.** Only armed
   hulls initiate (unarmed range stays 0), and the Situation Report gains a
   **"hostile on an intercepting course"** item driven by predicted closest
   approach *next* tick. That warning is part of stage 1, not a follow-up:
   without it, a player who logs in to a dead freighter has no way to learn
   what happened, and losing ships while asleep with no explanation is the
   single most likely reason this feature gets hated.

   Note the warning must be derived from **in-game state** — a predicted
   intercept — and never from login recency or any other telemetry about the
   player. Same rule as everywhere else in this game.

2. **Freighters are raidable mid-run — yes.** The Trades panel copy becomes
   true, escorts start mattering, and the space between bodies gets
   consequence. Accepted knowing it taxes whoever logs in least; decision 1 is
   the mitigation.

3. **Running fights are to the death — accepted.** No abort burn. See the
   section above for the one obligation this creates (`retreat_hp_pct` must
   say it has no effect in transit).

4. **Station umbrella — cut.** Not deferred; removed from the roadmap.
   Stations keep range 0.

**Not asked, kept as drafted:** range stays **per-class**, not scaled by
weapon parts, so parts stay about damage and agility. The `+2/mount` lever is
still there if reach should later be buildable — that is a tuning change, not
a redesign.

### Second round — closed 2026-08-14, same session

5. **R3 rewritten as aim + exposure.** The single relative-speed penalty was
   one-sided by construction. Split into crossing rate (aim) and time-in-range
   (opportunity). See R3; the `t*` degeneracy warning there is the part that
   will bite an implementer.
6. **5% floor on the aim term**, applied before exposure scales it. Changes
   exactly one matrix cell in every regime where fights actually happen.
7. **Damage stays flat.** With the `m = k²` arithmetic recorded, because it is
   obviously-correct physics that breaks the game and it *will* come back.
8. **Line of sight required (R4).** "Ships shouldn't be able to have range past
   their sensor coverage." As a range clamp it never binds — sensors outrun
   guns 15–30×. As a line-of-sight rule it closes the shoot-through-a-planet
   hole, the fog-of-war leak, and tracer occlusion with one existing test.
9. **Combat animations are stage-1 scope, explicitly.** The previous "needs no
   new drawing code" line was true of drawing and false of everything else.
10. **Rendezvous order lands in three steps**, destination-match first.
11. **Kinetic/energy geometry split — REJECTED.** Giving each weapon its own
    sensitivity to relative motion was designed and costed (per-weapon `V_REF`
    of 35/60 produced a clean ~10-point spread that peaked at the
    departure/arrival regime and tapered in cruise). Lorne cut it: not now,
    keep the weapons identical. Recorded because the design was sound and the
    numbers are reusable if it comes back — the trap to avoid is a **flat
    ±10 percentage points**, which is worth 27× on a 0.4% shot and 1.1× on an
    88.9% one, and would resurrect exactly the deep-cruise shots stage 1 wants
    dead. Also dropped with it: the "opening faster than shell speed is
    unreachable" rule, which needs per-weapon muzzle velocities to mean
    anything and duplicates what exposure already does.
