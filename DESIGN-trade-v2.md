# DESIGN-trade-v2: Routes as objects

Consolidated from #general (Orbit Man, StealthyMoose, Noah (The UTEF)),
revised with Lorne. Status: **proposal**, not scheduled.

A trade route stops being *a freighter with a destination* and becomes *a
standing object with a stop list and a crew*.

---

## 0. Corrections carried from rev A

**Fuel is dead.** Rev A said escorts "burn their own fuel." Fuel was removed
from the economy (`DESIGN-identity-economy.md` §1; routes ignore
`fuel_cost`). A guard costs **upkeep** — metal and credits every tick — plus
the opportunity cost of warships parked on a lane instead of a border.

**There is no combat in transit.** `DESIGN-transit-combat.md` is marked
*"design only, nothing built."* A ship in flight can't shoot and can't be
shot (`room.js` `inTransitIds` filter). The Trades panel's current copy —
*"Freighters can be raided — escort what you can't afford to lose"* — is
false in transit and stays only half-true until that project lands.

Freighters are vulnerable only while parked at a body. The engine already
screens for this: settlements are pinned last in targeting (`room.js` ~3364),
so a raider must clear the defending fleet first. A guard in `defensive`
stance at a body is real protection with **no new combat code**.

## 1. Settled calls

**No haulage fee.** If one side supplies every hull, they aren't paid for it
— the other side can add a hull after the agreement is struck. The remedy for
an unfair split is *contribution, not compensation*, which keeps the fix in
the same currency as the problem and spares us a fee system.

**Guards defend the hull running the route, yours or your partner's.** You
protect the lane, not the flag. Consequence worth stating: your warships will
fight for a ship you don't own, and that can pull you into someone else's war.

**Guards follow the route.** On assignment they burn toward the freighter's
current position, or its destination if it's already in flight. Thereafter
they travel the loop alongside it.

## 2. Why following is free

Travel time is `distance / SHIP_SPEED` — **one constant, not a per-hull
figure**. Per-design speed exists (`shipSpeed()`, engines, `SPEED_CAP`) but
only inside combat resolution; it has no bearing on crossing time.

So a guard never chases. It departs on the same tick and arrives on the same
tick, permanently in lockstep — no pursuit logic, no desync, no "escort fell
behind" bug class. Following is *cheaper to build* than holding a stop.

What it buys: the guard covers **every** stop instead of one, and visibly
moves with the convoy. It still only matters on arrival, but on a milk run
through thin outposts, being present at all four stops is the difference.

## 3. The scale problem

Clicking to pick stops works between moons and breaks across the system: at a
zoom showing Ceres and Luna together, Luna sits on top of Earth — and the
bodies orbit while you select.

**The fix is an inversion: the route is a list; the map is a view of it.**
Selection drives the camera instead of depending on it.

Two editors on one object, neither a fallback for the other:

- **New route** — a composer. Add stops from a searchable list, set what
  happens at each, set when to loop, assign ships. Scale-free by
  construction: a list has no zoom level.
- **Click on map** — the fast path when the run is local and the bodies are
  already on screen. Appends to the same list.

### The composer

Four questions in the order a player asks them:

1. **Stops** — rows in visiting order, drag to reorder, `+ Add stop`.
2. **What happens there** — Pick up / Drop off, with per-resource detail
   ("metal only") behind a click so the simple case stays simple.
3. **When to loop** — Repeat forever (default) · Repeat N times · Run once,
   then park.
4. **Ships** — Runs it (freighters) and Guards (ships or fleets).

Live readouts: `loop ≈N ticks` · `peak hold X / cap` · `delivers Y / loop`.
Loop time carries a tilde — bodies orbit, so the figure drifts.

### The stop picker solves scale two ways

- **Grouped by parent body**, using the hierarchy the game already stores
  (`game_bodies.parent_body_id`). Type-ahead search. "Which Jupiter moon" is
  one keystroke rather than a zoom hunt, and each row shows ownership and
  distance from the previous stop.
- **Cluster popover on the map.** Clicking a parent whose moons have
  collapsed into it at the current zoom opens a list of those moons, instead
  of demanding you zoom in first. This is the specific fix for the case that
  breaks.

### Rules that make both editors behave

- **The map auto-frames the route** on every add and reorder, so the whole
  loop is always visible and you never hunt at the wrong zoom.
- **Click order is stop order**; drag reorders, and loop time updates so the
  payoff for a smarter sequence is legible.
- **Ineligible bodies dim** in both editors — only your own settlements can
  be stops on a domestic run, taught silently rather than by an error.
- **The loop-back arc is drawn.** The most confusing thing about a repeating
  route is that it repeats.

## 4. The hold gauge

One bar per stop showing projected cargo against a "full" line, simulating
the run as you edit. Fill up at stop two and the third bar hits the ceiling —
you learn the stop is wasted before launching, not after a loop.

It must be computed by **the same code the tick runs**, or it becomes a
second source of truth that quietly lies. That's a sim case, not a UI detail.

## 5. Trade tab on settlements

Beside Overview and Buildings. Every route that stops here, with status,
carriers, guards, and next arrival — staffable without leaving. Two roles
named the way a player says them: a ship either **runs** the route or
**guards** it. A stalled lane can't hide; it sits in the panel of the
settlement it was supposed to serve, counting down.

## 6. Stalling: 30 ticks, then auto-cancel

Losing the last freighter marks the route `stalled` rather than cancelling
it. Assigning a freighter clears it instantly.

- `stalled_since_tick` on the route; countdown on the card from tick 1.
- Warning at 5 remaining; Discord DM at both ends.
- At 30, auto-cancel; cargo aboard follows existing cancelled-route rules.

*Sanity check:* at the default hour-long tick that's 30 real hours. Forgiving
enough that a daily player never loses a lane by accident.

## 7. Scope: multi-stop is domestic

Interplayer lanes keep the simple shape — your body, their body, nothing
between. A route through three factions' bodies raises a tariff question at
every stop.

This does **not** cost us the consolidated freighter: a player lane is two
stops where each stop both drops and picks up.

## 8. Still true: the return leg is sold, not deleted

`trade_agreements` (0079) already stores what A ships to B *and* what B ships
to A, but commissions **two** routes, each flying home empty. One freighter
serves the whole deal:

```
load a_* at A → unload a_* at B → load b_* at B → unload b_* at A → repeat
```

The empty leg becomes the other side's shipment — one hull at half the
upkeep, same throughput. Mechanically it's a two-stop route where each stop
loads and drops: the milk run's mechanic, which is why these ship as one
system.

**The objection on record.** 0079 made the two legs independent deliberately:

> Neither waits on the other, because a freighter stuck behind the other
> side's dead freighter is a deadlock nobody can diagnose from the UI.

Three answers, the Trade tab now the biggest: a lane with more than one
freighter degrades instead of stopping; the stalled state is visible on the
settlement it serves with the fix attached; two-freighter mode isn't removed.

## 9. Open questions

1. **Does defending a partner's freighter count as an act of war?** Guards
   now fight for a hull they don't own. If a third faction raids your
   partner's freighter and your guards return fire, you've joined a war you
   never declared. May be exactly right — but it should be a deliberate yes,
   and the assignment UI should probably say so.
2. **With two carriers on one route, which does a guard follow?** Simplest
   diagnosable answer: a guard follows one named freighter and re-attaches to
   another on the same route if that one dies. Auto-splitting a fleet across
   carriers is neater and much harder to explain when it misbehaves.
3. **When a route auto-cancels, what happens to its guards?** Warships left
   at whatever body the loop abandoned them at. Sending them home is
   presumptuous; leaving them adrift loses track of a fleet. Leaning: hold
   position, and name the location in the cancellation notice.

## 10. Sequence

| Phase | Ships | Why here |
| --- | --- | --- |
| P0 | Stop list; migrate live routes to a two-stop equivalent | Groundwork, no behaviour change. The equivalence is the test. |
| P1 | Trade tab on settlements — routes, crew, status, assignment | Nothing else is diagnosable without it; useful the day it lands. |
| P2 | New-route composer: stop picker, loop rule, hold gauge | The scale-free editor. Before the map path — if the composer works the map is a shortcut; if only the map works, big runs are unbuildable. |
| P3 | Map picking: eligible rings, cluster popover, auto-framing | Fast path for local runs, appending to P2's list. |
| P4 | Consolidated player lanes — one freighter, both directions | Rides on the load-and-drop stop. Where the dead leg dies. |
| P5 | Carrier roster, 30-tick stall + auto-cancel, research unlock | Mitigates P4's single point of failure. |
| P6 | Guards: follow the carrier, defensive stance on arrival | Cheapest of the set now that following is lockstep. Last because it's worth least until transit combat lands. |

Carrier capacity research: no `logistics` track exists (tracks are armor,
construction, industry, propulsion, sensors, weapons). Society (`industry`)
level 7 is the natural slot, above `senate.chancellor`. Cap 4.

## 11. Sim coverage this will need

- a two-stop migrated route delivers byte-identically to today's ping-pong
- a consolidated lane moves both manifests in one loop, leaving no empty leg
- **hold projection matches what the tick actually loads** (the gauge must
  not become a second source of truth)
- a route stalls on losing its last carrier, survives 29 ticks, cancels on 30
- assigning a carrier at tick 29 clears the stall
- a guard assigned mid-flight arrives at the carrier's destination, then
  departs and arrives in lockstep with it thereafter
- a guard lands in `defensive` stance on every arrival
- a guard re-attaches when the carrier it followed dies
- a route with two carriers keeps running when one dies
