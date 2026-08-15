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

## 10. Integrating with live games

There are routes in flight, agreements people negotiated, and freighters with
cargo aboard. The rule this codebase already set for exactly this case, in
the terraforming migration, is the one to keep:

> A live game's economy must not shrink mid-match.
> — migration 0080, on grandfathering existing worlds

Nobody logs in to find a lane gone, a freighter idle, or cargo vanished. That
rules out a single cutover and gives three deploys.

### Deploy 1 — shadow

- `CREATE TABLE game_trade_route_stops (route_id, sequence, body_id, action,
  + per-resource manifest)`.
- Backfill **every** route, live and historical: stop 0 = `origin_body_id`
  (pick up), stop 1 = `dest_body_id` (drop off).
- Nothing reads it. `origin_body_id` / `dest_body_id` remain the truth.
- Drift-guard sim: for every route, stop 0 == origin and stop 1 == dest.

The risky data step lands while it's still reversible, because no code
depends on it yet.

### Deploy 2 — cutover

- Route gains `current_stop_seq INTEGER NOT NULL DEFAULT 0`; the tick
  advances by sequence instead of flipping `outbound` / `returning`.
- `origin_body_id`, `dest_body_id` and `status` keep being **written as
  mirrors** so nothing downstream breaks.
- **Acceptance test: a two-stop route delivers byte-identically to the
  ping-pong it replaced.**

**The one delicate mapping.** Converting status to a cursor while freighters
are mid-leg. `returning` → heading to stop 0, `outbound` → heading to stop 1
— but a ship already in transit has a live `game_ship_nodes` row with a real
`target_body_id`, and the migration must adopt *that* rather than re-planning
a leg underneath a hull in flight. Getting this wrong teleports a freighter.

### Deploy 3 — features

Routes may exceed two stops. Composer, map picking, carrier roster, stall,
guards. Old routes keep running as two-stop routes and can be edited into
more.

### Constraint: only `logistics` routes can be multi-stop

Routes already carry a taxonomy (migration 0080, `game_trade_routes.kind`)
set by their destination:

| kind | destination | delivery semantics |
| --- | --- | --- |
| `dyson` | Sol | feeds `dyson_acc_*`, clamped to target; controller-only, origin must be terraformed |
| `terraform` | a raw world you own | feeds `terraform_acc_metal/gold`, clamped to `TF_COST_*`; origin must be terraformed |
| `logistics` | a terraformed world you live on | classic stockpile hauling |

The first two are **metered sinks**, not warehouses, and carry their own
legality rules. So terraform and dyson routes stay two stops permanently —
enforced in the composer and re-checked server-side. A milk run that pours
into a terraform meter at stop 2 and the Dyson sphere at stop 4 is not
something anyone asked for, and it multiplies the legality matrix by the
number of stops.

### Consolidating an existing agreement is an OFFER, never a migration

The rule to defend hardest. A running agreement has **two routes owned by two
different players**. Merging them automatically would take one player's
freighter off the board and make the other's hull carry both directions — a
unilateral change to somebody's assets, decided by a database migration.

- Existing agreements keep running as two legs indefinitely.
- The Trade tab offers the upgrade — *"Both sides are flying empty half the
  time. Consolidate to one freighter?"* — through the same accept flow the
  agreement itself used.
- On accept, one carrier is nominated and the other leg's freighter is
  **released back to its owner, not consumed**.
- Only *new* agreements default to consolidated.

### What stalling preserves

Today, losing the carrier cancels the route and zeroes its cargo. Stalling
changes what survives, and the distinction matters so nobody expects too
much: **it preserves the route and the agreement, not the goods.** The cargo
went down with the freighter or was looted by its killer, under piracy rules
that already exist. What you're spared is renegotiating the deal.

Nothing to backfill: because routes cancel on carrier loss today, no
carrier-less route exists, so `stalled_since_tick` starts NULL everywhere.

### Client/server skew

The web client is a SPA people leave open for days. For two deploys the state
payload only **gains** fields, never loses them — a stale bundle keeps
reading `origin_body_id` and `status` and behaves as before. The old
create-route call (`{ship_id, origin_body_id, dest_body_id}`) keeps working as
a thin wrapper that builds a two-stop route.

### Verify before P0 runs

I could not read prod counts — the OAuth token deploys but lacks D1 scope
(`code 7403`). Run this first; it sizes the whole migration:

```sql
SELECT
  (SELECT COUNT(*) FROM game_trade_routes WHERE cancelled_at_tick IS NULL) AS active_routes,
  (SELECT COUNT(*) FROM game_trade_routes WHERE cancelled_at_tick IS NULL AND kind <> 'logistics') AS metered_routes,
  (SELECT COUNT(*) FROM game_trade_routes WHERE cancelled_at_tick IS NULL AND agreement_id IS NOT NULL) AS agreement_legs,
  (SELECT COUNT(*) FROM trade_agreements WHERE status = 'active') AS active_agreements,
  (SELECT COUNT(*) FROM game_trade_routes r WHERE r.cancelled_at_tick IS NULL
     AND EXISTS (SELECT 1 FROM game_ship_nodes n
                  WHERE n.ship_id = r.ship_id AND n.status = 'in_transit')) AS routes_in_flight;
```

`routes_in_flight` is the number that decides how carefully Deploy 2's cursor
mapping has to be tested.

## 11. Sequence

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

## 12. Sim coverage this will need

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
