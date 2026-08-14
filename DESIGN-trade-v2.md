# DESIGN-trade-v2: Routes as objects

Consolidated from #general (Orbit Man, StealthyMoose, Noah (The UTEF)).
Status: **proposal**, not scheduled.

Three people asked for three features. They are one feature: a trade route
stops being *a freighter with a destination* and becomes *a standing object
with a stop list and a crew*. Everything requested falls out of those two
nouns.

---

## 1. The asks

- **Orbit Man** — multiple stops per route, domestically at least. And for
  recurring player-to-player trade, consolidate to one freighter: the dead
  return leg both freighters fly today is wasted motion.
- **StealthyMoose** — promote the route to its own "object status": either
  player can assign a freighter+escort fleet to it. Possibly tech to raise
  how many freighters a route can hold.
- **Noah (The UTEF)** — seconds Moose; wants to assign escort ships to a
  freighter.

## 2. Ground truth

Worth stating plainly, because two of these are much cheaper than they look
and one is more expensive.

| System | Today | Bearing on the ask |
| --- | --- | --- |
| `game_trade_routes` (0016) | One `ship_id`, one `origin_body_id`, one `dest_body_id`; status flips `outbound` ⇄ `returning` (`worker/room.js` ~1300–1355). | The return leg is empty **by construction**. Multi-stop needs a real stop list. |
| `trade_agreements` (0079) | Already stores **both** directions' per-run terms (`a_metal…`, `b_metal…`) but commissions **two** routes, one per giving side. | This is the source of the two dead legs. The terms for a round trip are already in the table. |
| `game_fleets` (0049) | Exist. Ships carry `fleet_id`; fleets have a flag captain and fan out common orders. | Escorts need no new grouping primitive — they need to follow a route. |
| Piracy (`worker/room.js` ~4813) | Killing a loaded hull hands its manifest to the killer; the sender's debit stays spent. The code comment already says this "is what makes trade convoys worth escorting." | Escorts already have teeth. Only the assignment is missing. |

## 3. The move: the return leg is sold, not deleted

This is the whole idea, and the reason Orbit Man's request is cheap.

A standing agreement already records what A ships to B *and* what B ships to
A. Today it hires two freighters, each flying home empty. One freighter can
serve the entire deal:

```
load a_* at A → fly → unload a_* at B → load b_* at B → fly → unload b_* at A → repeat
```

No leg is removed. The empty leg **becomes the other side's shipment**. One
hull does the work of two at half the upkeep, and lane throughput is
unchanged.

Note what this is mechanically: a two-stop route where every stop both
unloads and loads. That is the *same mechanic* as multi-stop. Two requests,
one implementation.

## 4. The design — two new nouns, four changes

### Change 1 — routes carry an ordered stop list  *(stops; Orbit Man)*

New `game_trade_route_stops (route_id, sequence, body_id, + per-stop
manifest)` replaces the fixed origin/dest pair. Existing routes migrate
cleanly: origin → stop 0, dest → stop 1, and a two-stop route must behave
exactly as it does today (that equivalence is the P0 test).

Cap at **6 stops** — an unbounded list makes both the leg planner and the UI
miserable. **Domestic only** in v1; per-stop tariffs and ownership across
factions are a separate problem.

### Change 2 — a stop can unload and load in one visit  *(manifests; Orbit Man)*

What turns the dead leg into freight. Needs no new terms, only the
willingness to let one hull serve both directions.

Consolidated becomes the **default for new agreements**. The current
two-freighter arrangement stays available for anyone who doesn't want to
depend on a partner's hull.

### Change 3 — the route holds a roster, not a ship  *(carriers; Moose)*

`game_trade_route_carriers` replaces the single `ship_id`. The proposer
nominates the first freighter so a deal starts in one click (Orbit Man's
flow); either side may add hulls afterwards (Moose's object status).

Each carrier keeps its owner and **each owner pays their own hull's upkeep**
— which is also the answer to who bears the cost of a shared lane.

Carriers per route: 1 by default, raised by research. The **Society**
(`industry`) track is the natural home — next slot up at level 7, alongside
`pacts` and the senate unlocks. Cap 4.

### Change 4 — assign a fleet, not loose ships  *(escorts; Noah, Moose)*

Fleets already exist and already fan out orders, so an escort assignment is
a fleet pointed at a route. Escorts fly the carrier's legs and **burn their
own fuel** — that cost is the point and shouldn't be waived.

The real work is transit: a convoy must be interceptable *between* bodies,
not just at them. That is DESIGN-transit-combat territory, not new ground.

## 5. The objection this owes you

When standing agreements were built, the two legs were made independent
**on purpose**. From migration 0079:

> Neither waits on the other, because a freighter stuck behind the other
> side's dead freighter is a deadlock nobody can diagnose from the UI.

Consolidating to one hull brings that coupling straight back: a single loss
now stops trade in both directions, and it may be a partner's asset that you
can neither protect nor replace.

What makes it acceptable:

- The **carrier roster is the mitigation** — a lane with more than one hull
  degrades instead of stopping. This is why Change 3 should follow Change 2
  closely rather than being deferred.
- Losing the last carrier moves the route to an explicit **`stalled`** state
  that names the cause and asks for a freighter. The 0079 fear was an
  *undiagnosable* deadlock; a stalled lane that says why is a different
  animal.
- Two-freighter mode isn't removed, so distrust remains a playable position.

## 6. Open questions

Genuine forks — each changes what gets built.

1. **If one side supplies every hull, do they get paid?** A per-run haulage
   fee is easy to add and easy to regret. Instinct: ship without it and see
   whether players negotiate it in the terms they already control.
2. **When the last carrier dies, does the agreement stall or end?** Stalling
   preserves a deal people spent diplomacy on; ending is honest about a lane
   nobody flies. Lean stall, with a visible countdown before it lapses.
3. **Should multi-stop ever cross factions?** A route touching three
   factions' bodies raises a tariff question at every stop. Domestic-only is
   a real answer, not just a phase-one dodge.
4. **Do escorts fight for a partner's freighter?** If B escorts a lane and
   A's carrier is jumped, B's warships are committed to defending a hull
   they don't own — a meaningful alliance moment, or an unwanted war.

## 7. Sequence

Ordered so each phase is playable alone and nothing is stranded if the next
one slips.

| Phase | Ships | Why here |
| --- | --- | --- |
| P0 | Stop list + migrate every live route to a two-stop equivalent | Pure groundwork, no behaviour change. Proves the migration is safe before anything depends on it. |
| P1 | Domestic multi-stop with per-stop load/unload | The factorio ask; lands without touching cross-faction rules. |
| P2 | Consolidated agreements — one freighter, both directions | Rides on P1's mechanic. Where the dead leg dies. |
| P3 | Carrier roster, `stalled` state, research unlock | Directly mitigates P2's single point of failure, so it should follow closely. |
| P4 | Escort fleets assigned to routes | Largest unknown; depends on transit interception, and the one piece that could reasonably slip. |

## 8. Sim coverage this will need

Consistent with `sim/tradeRoutes.mjs`, which caught a real ordering bug on
its first run:

- a two-stop migrated route delivers byte-identically to today's ping-pong
- a consolidated agreement moves both manifests in one loop and leaves no
  leg empty
- losing the only carrier stalls the route rather than cancelling it, and
  the cargo aboard follows the existing piracy/loss rules
- a route with two carriers keeps running when one dies
- escorts burn fuel on every leg and stop escorting when they run dry
