# DESIGN-trade-v2: Routes as objects

Consolidated from #general (Orbit Man, StealthyMoose, Noah (The UTEF)),
revised with Lorne. Status: **proposal**, not scheduled.

A trade route stops being *a freighter with a destination* and becomes *a
standing object with a stop list and a crew*.

---

## 0. Corrections to rev A

Both change the design, not just the wording.

**Fuel is dead.** Rev A said escorts "burn their own fuel." Fuel was removed
from the economy (`DESIGN-identity-economy.md` §1; routes ignore
`fuel_cost`). The cost of a guard is **upkeep** — those hulls draw metal and
credits every tick — plus the opportunity cost of warships parked on a lane
instead of a border. Sharper than fuel, because it never stops.

**There is no combat in transit.** `DESIGN-transit-combat.md` is marked
*"design only, nothing built."* A ship in flight can't shoot and can't be
shot (`room.js` `inTransitIds` filter). Rev A's talk of intercepting convoys
between bodies described a game we don't have.

## 1. Consequence: guards defend stops

A freighter is untouchable in flight and vulnerable only while parked at a
body, loading or unloading. An escort's whole job is to be standing there
when it happens.

The engine already supports this with **no new combat code**:

- ships carry a stance — `attack` | `defensive` | `hold` (migration adding
  `game_ships.stance`);
- there is already a screening rule at bodies (`room.js` ~3364): settlements
  are pinned last in targeting, so *a raider must clear the defending fleet
  before it can touch what that fleet defends*.

A guard in defensive stance at a stop is therefore real protection today.

**Honest caveat.** The Trades panel currently tells players *"Freighters can
be raided — escort what you can't afford to lose."* In transit that is
false. This design makes the promise true *at stops* for the first time, but
until transit combat exists escorting is worth less than the thread assumes.
It matters most on the thinly-defended outposts of a domestic milk run, not
on a well-garrisoned capital run.

## 2. The multi-stop builder

The piece rev A skipped. Goal: a player who has never seen it builds a
working run without reading anything.

Two surfaces, always in sync — you **pick stops on the map** in visiting
order, and **tune them in a strip** beside it. The map answers *where*, the
strip answers *what happens there*.

### Two kinds of stop, and that's the whole vocabulary

Every stop is either **pick up** or **drop off**. A milk run collects from
your outposts and drops at your capital. Nobody needs "manifest" explained.
Per-resource control ("metal only") lives behind a click on the stop, so the
simple case stays simple.

Default for a fresh route: last stop DROP OFF, everything before it PICK UP.

### The hold gauge — the part that makes it click

Under the strip, a bar per stop showing the freighter's projected hold
across the loop, with a dashed "full" line at capacity. It simulates the run
as you edit:

- fill up too early and a bar crosses the line and turns red — the third
  stop is wasted and you learn it before launching, not after;
- reordering stops moves the **loop time** readout, so distance is something
  you feel rather than read about.

Three live readouts: `loop N ticks` · `peak hold X / cap` · `delivers Y per
loop`.

### Map interaction

- **Click order is stop order.** No separate ordering step — you drew the
  trip. Drag a strip row to reorder; loop time updates so the payoff shows.
- **Ineligible bodies dim.** Only your own settlements can be stops; the map
  teaches the domestic-only rule silently instead of erroring after the fact.
- **The loop-back arc is drawn** as a dashed return to stop 1, plus a
  *"then back to stop 1"* line. The most confusing thing about a repeating
  route is that it repeats — so show it.

## 3. Trade tab on settlements

Every route that stops here is listed here, with its crew and state, and can
be staffed without leaving. A stalled lane can't hide: it sits in the panel
of the settlement it was supposed to serve, counting down.

Per route card:

| Element | Content |
| --- | --- |
| Name + status | `Running` / `Stalled` pill, next arrival |
| Runs it | carrier freighters assigned |
| Guards | ships/fleets assigned, and which stop they hold |
| Actions | Assign ship · Assign fleet, with role **Runs it** or **Guards** |

Two roles named the way a player says them: a ship either **runs** the route
or **guards** it.

## 4. Guards

Assign an **individual ship or a whole fleet** — both are things players
already have. On assignment the ship burns for the stop you picked and
enters **defensive stance** on arrival. It holds there; it does not chase.

Guards attach **to a stop**, not to the route in the abstract. Forced by the
no-transit-combat reality: a guard can only ever help at a body, so "guard
Ceres" is the honest unit. On a two-stop player lane that becomes a real
decision — protect your side or theirs.

## 5. Stalling: 30 ticks, then auto-cancel

Losing the last freighter marks the route `stalled` rather than cancelling
it, preserving a lane people spent diplomacy on.

- `stalled_since_tick` set on the route; assigning a freighter clears it.
- Countdown shows on the route card from tick 1; warning at 5 remaining;
  Discord DM at both ends.
- At 30, auto-cancel. Cargo still aboard follows the existing cancelled-route
  rules (and the freighter's own hold persists — that already shipped).

*Sanity check for Lorne:* at the default hour-long tick, 30 ticks is 30 real
hours. Long enough that a daily player never loses a lane by accident, which
is the point — but say so if it feels slack.

## 6. Scope: multi-stop is domestic

Interplayer trade keeps the simple shape — your body, their body, nothing
between. A route through three factions' bodies raises a tariff question at
every stop and isn't worth the complexity.

This does **not** cost us the consolidated freighter: that lane is two stops
where each stop both drops and picks up, which is still the simple shape.

## 7. Still true: the return leg is sold, not deleted

`trade_agreements` (0079) already stores what A ships to B *and* what B ships
to A, but commissions **two** routes, one per giving side, each flying home
empty. One freighter serves the whole deal:

```
load a_* at A → unload a_* at B → load b_* at B → unload b_* at A → repeat
```

No leg is removed — the empty one becomes the other side's shipment. One
hull at half the upkeep, same throughput. Mechanically it is a two-stop route
where each stop loads and drops: the same mechanic as the milk run, which is
why these ship as one system.

## 8. The objection on record

Standing agreements made the two legs independent on purpose. From 0079:

> Neither waits on the other, because a freighter stuck behind the other
> side's dead freighter is a deadlock nobody can diagnose from the UI.

One hull brings that coupling back. Three answers, the Trade tab now the
biggest:

- a lane with more than one freighter degrades instead of stopping;
- the stalled state is **visible on the settlement it serves**, with a
  countdown and the fix attached — 0079 feared an *undiagnosable* deadlock,
  and this one announces itself for thirty ticks;
- two-freighter mode isn't removed, so distrust stays playable.

## 9. Open questions

1. **If one side supplies every hull, do they get paid?** A per-run haulage
   fee is easy to add and easy to regret. Instinct: ship without it and watch
   whether players negotiate it in terms they already control.
2. **Do guards fight for a partner's freighter?** Guarding the far stop
   commits your warships to a hull you don't own — alliance moment, or
   unwanted war.
3. **Does a guard follow the route or hold its stop?** Holding is what the
   engine can honor. Following reads better but doubles movement bookkeeping
   for protection that only applies on arrival.

## 10. Sequence

| Phase | Ships | Why here |
| --- | --- | --- |
| P0 | Stop list; migrate live routes to a two-stop equivalent | Groundwork, no behaviour change. The equivalence is the test. |
| P1 | Trade tab on settlements — routes, crew, status, assignment | Moved up from rev A: nothing else is diagnosable without it, and it's useful the day it lands. |
| P2 | Domestic multi-stop: map picker, route strip, hold gauge | The factorio ask. Needs P1's panel to live in. |
| P3 | Consolidated player lanes — one freighter, both directions | Rides on P2's load-and-drop stop. Where the dead leg dies. |
| P4 | Carrier roster, 30-tick stall + auto-cancel, research unlock | Mitigates P3's single point of failure. |
| P5 | Guards: assign ship/fleet to a stop, burn out, defensive stance | Smallest mechanical change — stance and screening exist. Last because it's worth least until transit combat lands. |

Carrier capacity research: no `logistics` track exists (tracks are armor,
construction, industry, propulsion, sensors, weapons). Society (`industry`)
level 7 is the natural slot, above `senate.chancellor`. Cap 4.

## 11. Sim coverage this will need

- a two-stop migrated route delivers byte-identically to today's ping-pong
- a consolidated lane moves both manifests in one loop, leaving no empty leg
- hold projection matches what the tick actually loads (the gauge must not lie)
- a route stalls on losing its last carrier, survives 29 ticks, cancels on 30
- assigning a carrier at tick 29 clears the stall
- a guard assigned to a stop arrives and lands in `defensive` stance
- a route with two carriers keeps running when one dies
