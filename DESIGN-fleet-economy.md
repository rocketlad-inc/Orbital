# DESIGN — Fleet Economy & the Ship Designer

Status: **design agreed, unimplemented** (the cost-curve rebalance in
`93b5552` is the prerequisite and is already in).

## The problem this solves

Mature economies had nothing to buy. The 2026-07 rebalance fixed the two
broken curves (buildings dead-ended at ~L4; hulls and parts were flat and
trivially cheap — a fully-armed destroyer cost less than one L5 forge).
That work makes *acquisition* expensive.

It does not stop **hoarding**. A stockpile is a number that only ever goes
up, and one-off purchases can't drain it — the player buys the thing, and
the surplus resumes climbing. What converts a stockpile problem into a
*rate* problem is a recurring cost. That's §1.

§2 and §3 add the other two sinks: changing your mind costs something,
and — the sharpest of the three — resources can be converted into TIME,
the one thing an hour-per-tick game cannot manufacture.

§4 exists because none of it works if spending is illegible. A refit fee
nobody understands is a tax; a designer that's painful to use means
players fit the default loadout forever and never engage with the part
economy at all.

---

## §1 — Fleet upkeep

Every active hull bills its owner **every tick**.

| Class | Credits | Metal |
|---|---|---|
| Corvette | 1 | 0 |
| Frigate | 1 | 1 |
| Destroyer | 2 | 2 |
| Freighter | 1 | 0 |
| Colony | 0 | 0 |

Colony ships are exempt: they're consumable one-shots, and charging rent
on an expansion hull punishes the slowest strategy in the game.

### The knob

Upkeep is **a senate slider**, `fleet_upkeep_multiplier`, added to
`SLIDER_CATALOG` in `worker/senate.js` alongside the existing
`ship_build_cost_multiplier` (same shape — `default: 1.0`, `min: 0`,
`max: 2.0`, `step: 0.05`).

`min: 0` is deliberate and load-bearing: **setting it to zero disables
upkeep entirely.** If the mechanic turns out to be miserable, it can be
switched off by vote — in a live game, without a deploy — instead of
becoming a balance emergency. It also gives the senate a genuinely
interesting motion: a wartime coalition can vote upkeep *down* to sustain
big fleets, or a defensive bloc can vote it *up* to strangle an
aggressor's navy. The knob is a political object, not just a tuning value.

### Where it runs

In `resolveTick`, as its own pass **after** yield distribution (so income
lands first and a solvent empire is never spuriously in arrears) and
**before** the research drain (so upkeep has first claim on credits —
you pay the fleet before you pay the labs).

```
for each faction:
  owed = Σ upkeep(ship.class) over active, non-destroyed hulls
       × fleet_upkeep_multiplier
  pay from the faction pool
```

### Arrears — what happens when you can't pay

This is the design's sharpest edge and needs to be **loud, slow, and
reversible**. Destroying ships for missed rent would be catastrophic in an
async game where a player is asleep for eight ticks.

1. **Partial payment is fine.** Pay what you can; the remainder becomes
   `arrears` on the faction row.
2. **In arrears, the fleet degrades — it does not die.** All hulls of that
   faction take a **−25% damage** and **−25% max-HP** penalty while
   arrears is non-zero ("unpaid crews, deferred maintenance"). This is
   visible, painful, and instantly undone by paying.
3. **Arrears clears the moment income covers it.** The next tick with
   surplus pays it down automatically.
4. **No ship is ever destroyed by upkeep.** Full stop. The failure mode is
   a weakened navy, not a deleted one.

A `fleet_arrears` chronicle entry fires on entering and leaving arrears,
and the Situation Report gets a `now`-tier row while it persists — this
must be impossible to miss, because a player who doesn't notice their
whole fleet is at 75% will read it as a combat bug.

### Consequences worth stating plainly

- **Idle fleets now cost.** Parking 20 corvettes "just in case" has a
  price, so mothballing becomes a real decision.
- **This nerfs turtling and rewards tempo.** That's intended, but it is a
  genuine strategy shift, not a tuning tweak.
- **Freighters must stay profitable.** A freighter at 1c/tick has to earn
  more than that on its route or trade becomes a losing proposition. This
  is the single most likely thing to need tuning after playtest — check it
  first.
- **Small empires are more fragile than large ones.** Upkeep is flat per
  hull while income scales with settlements, so an early-game player with
  4 ships and 2 cities feels this hardest. Consider exempting the first
  N hulls if new players stall.

---

## §2 — Refit

Editing a saved design is currently free, so the designer is a
spreadsheet, not a sink. A **refit fee** makes changing your mind cost
something.

### Cost

```
refit = |new parts − old parts| priced at the CURRENT stacking-escalated rate
      × REFIT_MULTIPLIER (0.5)
```

Only the **delta** is charged, at half price. Removing a part refunds
nothing (you scrapped it). Swapping kinetic→energy on a 3-mount destroyer
costs the escalated price of that one mount, halved — not the whole
loadout. Cheap enough to experiment, expensive enough to plan.

### Propagation — the part the user specified

A refit applies to **every ship already flying that template**, not just
future builds. But only where it physically can:

- **At a friendly shipyard →** refits **immediately**, fee charged per
  hull at commit time.
- **Anywhere else →** the ship is flagged `refit_pending`. It keeps its
  old loadout and fights with it. The refit applies **automatically on
  arrival** at a friendly shipyard, charging the fee then.
- **Can't afford all of them?** Refit as many as the pool covers, nearest
  shipyard first, and leave the rest pending. Never partially-charge.

This makes shipyard placement matter — a forward yard is now logistics
infrastructure, not just a build site — and it gives "bring the fleet
home" a concrete reason to exist beyond repair.

The commit dialog must state the total up front: *"Refit 6 ships — 3 at
yards now (84c), 3 pending arrival."*

### Schema

- `game_ships.refit_pending_design_id TEXT` — set on propagation, cleared
  on apply.
- Applied in the arrival pass in `worker/room.js`, right beside the
  existing station-repair logic (same trigger: ship reaches a friendly
  station with a shipyard).

---

## §3 — Rush construction

At any shipyard with a build in progress: **pay the ship's cost a second
time to halve the remaining build time.**

This is the best sink of the three, and it's worth saying why. Upkeep and
refit drain resources; rush converts them into the one thing the game
can't manufacture. At an hour per tick, **time is the scarcest resource in
Orbital** — a destroyer that lands eight hours early is the difference
between relieving a siege and reading about it. A rich player will always
want this, which is exactly the property a sink needs.

### Rules

- **Cost = the full current build cost, paid again** — hull *plus* fitted
  parts at the escalated rate (§ cost curve). You pay for the ship twice,
  total.
- **Halves the REMAINING time, not the total.** `remaining = ceil(remaining
  / 2)`, minimum 1 tick. Halving the total would make rushing useless late
  in a build, which is precisely when the player wants it.
- **Once per build order.** A `rushed` flag on the queue row. Repeated
  halving would let a wealthy empire buy an effectively instant fleet for
  a geometric-but-finite sum; one rush caps the tempo advantage at 2× and
  keeps the UI a single button rather than a spend-o-meter.
- **Cancelling refunds both** the base cost and the rush fee, matching the
  existing cancel-refund behaviour.
- **Not separately chronicled.** `ship_built` already fires publicly; a
  rush only changes *when*. Whether you paid double is your business.

### Second-order effect worth noting

Shipyard slots are limited (`shipyardSlotsAtBody`). Rushing doesn't just
deliver one hull sooner — it **frees the slot**, so the whole queue behind
it moves up. That makes rush most valuable to players who've invested in
shipyard levels, which is a nice reinforcement of the building ladder.

### The risk: snowballing

This lets a rich player out-tempo a poor one, which in a game with
hoarding problems is *mostly* the point — but it does widen a lead. Two
things keep it honest:

1. **It's deliberately inefficient.** 2× cost for 2× speed means you are
   always trading resource-efficiency for time. A player who rushes
   everything fields half the fleet of one who doesn't.
2. **It's knob-able.** `rush_cost_multiplier` in the senate catalog
   (default `1.0` = pay cost again, `max: 3.0`). A senate watching a
   runaway leader can vote rushing prohibitively expensive — the same
   political-object property the upkeep knob has.

### Where it runs

New action `POST /api/games/:id/builds/:orderId/rush` in `worker/actions.js`,
beside `handleCancelBuild` (it needs the same cost table and the same
parts-cost recomputation). The build queue row gains `rushed INTEGER`.

---

## §4 — The Ship Designer, rebuilt

The current designer (`src/components/ShipDesigner.tsx`, 713 lines) is a
form: dropdowns and a text list of parts. It communicates nothing about
what a part *does*, gives no sense of the ship as an object, and makes
comparing two loadouts impossible. Nobody will engage with a part economy
through that.

### Inspiration

The reference points that actually fit this problem:

- **Kerbal Space Program's VAB** — the part *is* the picture; you see the
  vehicle change as you build it.
- **FTL's ship loadout** — small fixed slot count, every system legible at
  a glance, hover explains everything.
- **Into the Breach's mech loadout** — tiny grid, enormous clarity;
  weapons are cards with a plain-language effect line.
- **Battletech's 'Mech lab** — the tonnage/slot budget is the whole game,
  and it's always on screen.

The common thread: **the constraint is always visible, and the object
being built is always visible.** That's the brief.

### Layout

Three columns on desktop; stacked on mobile (the world-menu breakpoints
already exist — reuse them, don't invent new ones).

```
┌───────────────┬─────────────────────┬────────────────┐
│  PART PALETTE │    SHIP CANVAS      │  STAT READOUT  │
│               │                     │                │
│  draggable    │   live avatar +     │  before→after  │
│  cards        │   slot ring         │  deltas        │
│               │                     │                │
│  [Kinetic]    │      ◄ship art►     │  DMG  21→28 ▲  │
│  [Energy]     │    ○ ○ ○ ○ ○ ○      │  HP  135→135   │
│  [Shield]     │    (drop targets)   │  SPD  1.0→0.87▼│
│  [Armor]      │                     │                │
│  [Engine]     │   Slots 4/6         │  COST 158m 124c│
│  [Detonator]  │                     │  UPKEEP 2c 2m/t│
└───────────────┴─────────────────────┴────────────────┘
```

### Interaction

- **Drag a part card onto a slot** to fit it. Drag off to remove.
- **Click-to-fit** is a required fallback — drag alone fails on touch, and
  a meaningful share of players are on the Fold. Tap part → tap slot.
- **Slots are a ring around the avatar**, positioned to read as hardpoints
  rather than a list. Filled slots show the part glyph in faction livery.
- **The avatar updates live** as parts are fitted: weapon mounts appear on
  the hull, engines light the exhaust, shields add a rim. This is the
  payoff — you are building a *ship*, not filling a form.
- **Invalid drops are refused visibly** (slot pulses red + a one-line
  reason: *"Freighter hardpoints take engines or shields only"*), never
  silently ignored.

### Part cards

Every part is a card, not a row:

```
┌──────────────────────────┐
│ ⚔  KINETIC MOUNT         │
│ +7 damage · kinetic       │
│ Blunted by shields        │
│ 6m 2c   (2nd: 11m 4c)     │
└──────────────────────────┘
```

Four things, always: **what it is, what it does, what counters it, what
it costs** — including the *escalated* price of the next copy, so stacking
cost is discovered in the UI rather than as a surprise at checkout.

### The stat readout

Live **before → after** deltas for damage, HP, speed, mitigation, plus
**total build cost** and **per-tick upkeep** (§1). Green ▲ / red ▼ arrows.
This is what makes the part economy legible: the player sees the third
kinetic mount cost 18 metal for +7 damage and can decide it isn't worth it
— which is exactly the decision the escalation curve exists to create.

### Templates

Save/name/duplicate a design, and show **how many live hulls use it** —
because per §2 that number is the refit bill. Deleting a template in use
must warn.

---

## Build order

1. **Upkeep** (§1) — server-only, smallest surface, biggest economic
   effect. Ships with the knob at `1.0`; can be voted to `0` if it's wrong.
2. **Rush** (§3) — also server-only and the smallest build of the four
   (one action, one column, one button). Highest sink-per-line-of-code,
   so it is worth doing early even though it is numbered third.
3. **Refit fee + propagation** (§2) — needs the schema column and the
   arrival hook.
4. **Designer rebuild** (§4) — largest, and the one that makes the other
   three legible. Wants its own session.

§4 depends on nothing in §1–§3 except displaying their numbers, so it can
be built in parallel if desired.

## Open questions for playtest

- Are freighters still profitable at 1c/tick? (Most likely thing to break.)
- Does upkeep punish early-game too hard? Consider an N-hull exemption.
- Is `REFIT_MULTIPLIER = 0.5` cheap enough to encourage experimentation?
- Is a **single** rush per order the right cap? If players routinely rush
  everything and still hoard, allowing a second rush (at the same doubled
  cost, compounding to 4× for 4× speed) is the obvious next notch — but
  start capped, because uncapping is easy and re-capping is a nerf.
- Does rush let a leading player snowball out of reach? Watch whether the
  senate ever actually votes `rush_cost_multiplier` up; if it never does,
  the knob is decoration and the real fix is a higher base multiplier.
- Should upkeep scale with fitted parts, or stay per-class flat? Flat is
  simpler to read; part-scaled is more consistent with the build-cost
  curve. **Recommend flat to start** — one new number for players to
  learn, not two.
