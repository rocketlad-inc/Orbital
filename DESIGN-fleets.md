# DESIGN — Fleets: ships under a flag captain, common orders

*Status: approved design, not yet built. Decisions locked with Lorne 2026-07-24.*

## Why

Two half-systems exist and don't talk:

- **Client "fleets" are fake.** `formFleet`/`splitFromFleet` live only in browser
  memory (`gameState.fleets`, no server column). They stage simultaneous
  transfers, then evaporate on reload. Invisible to other players.
- **Captains are real but solitary.** Persistent officers with rank + traits
  (`worker/captains.js`, migration 0046), a bank, survival rolls — but a
  captain only ever affects their own hull.

A Fleet marries them: a **server-persistent group of ships led by a flag
captain**, with one control surface for orders. The captain is what makes it
a system instead of a checkbox — fleets get names, faces, chronicle lines,
and (P2) a command aura.

## Locked decisions

| Question | Decision |
|---|---|
| Mixed speeds on a fleet move | **Depart together, arrive per-ship.** One click issues every member its own transfer at its own acceleration; arrivals stagger. No speed-matching in v1 (formalizes today's behavior; "hold formation" is a possible v2 toggle). |
| Flag captain's trait | **Halved aura.** The flag's trait applies to OTHER members at half strength — `1 + (mul − 1)/2` — stacking with each member's own captain. The flagship itself keeps only its captain's full personal trait (no self-double-dip). |
| Flagship destroyed | **Leaderless until the player promotes.** Fleet holds together, loses its aura, and refuses NEW common orders until a member captain is promoted to flag. Surfaced as a decision-tier Situation Report row. |

## Data model (migration 0049)

```sql
CREATE TABLE game_fleets (
  id               TEXT PRIMARY KEY,          -- '<gameId>:fl<seq>'
  game_id          TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  faction_id       TEXT NOT NULL,
  name             TEXT NOT NULL,             -- default "«Captain»'s Squadron"
  flag_captain_id  TEXT,                      -- NULL = leaderless
  created_at_tick  INTEGER NOT NULL
);
ALTER TABLE game_ships ADD COLUMN fleet_id TEXT;   -- NULL = independent
CREATE INDEX idx_ships_fleet ON game_ships(fleet_id);
```

- A ship belongs to **at most one fleet**; members must be same-faction,
  `status='active'`.
- The flag captain must be the captain of a member ship. `ensureCaptains`
  already guarantees every active ship has one.
- No hard member cap in v1 (the formation fan-out already handles display
  stacking).
- The legacy client-local fleet system is **deleted**, not migrated — it was
  ephemeral by construction.

## Server endpoints (`worker/fleets.js`, feature-module pattern)

| Route | Behavior |
|---|---|
| `POST /api/games/:g/fleets` | `{ ship_ids[], flag_ship_id, name? }`. Validates ownership (all-or-nothing, same rule as bulk orders), strips members from any prior fleet, names from the flag captain if omitted. |
| `PATCH /api/games/:g/fleets/:id` | rename / `add_ship_ids` / `remove_ship_ids` / `flag_ship_id` (promote). Removing the flagship ⇒ `flag_captain_id = NULL` (leaderless). Fleet auto-disbands at <2 members. |
| `DELETE /api/games/:g/fleets/:id` | Disband; members revert to independent, keep their current standing orders. |
| `PATCH /api/games/:g/fleets/:id/orders` | `{ stance?, retreat_hp_pct?, detonate_hp_pct? }` — thin wrapper that resolves members and delegates to the existing bulk-orders core. **409 `fleet_leaderless` when `flag_captain_id IS NULL`.** |

**Fleet move is client-side fan-out** (no new endpoint): torch plans are
client-computed today (incl. Voidrunner accel), so the client computes one
plan per member and posts N existing `/ships/:id/transfer` calls. The fleet
merely selects the ships. Members mid-transit or on trade routes are skipped
with a per-ship rejection summary (same UX as bulk transfer today).

**Membership side-effects:** joining a fleet inherits the fleet's current
standing orders (one bulk write); leaving keeps whatever the ship had.

## Tick-loop integration (`worker/room.js`)

New early pass, try/catch-isolated like the rest:

1. **Flag integrity** — flagship destroyed or flag captain lost ⇒
   `flag_captain_id = NULL` + chronicle `fleet_flag_lost`. (Captain survival
   is orthogonal: a surviving flag captain goes to the bank as usual; they do
   NOT auto-retake the flag from the bank.)
2. **Auto-disband** — fleets with <2 active members dissolve silently
   (chronicle only if it had a name-worthy history, i.e. any kill credited).
3. **(P2) Aura resolution** — combat/maintenance/visibility passes read a
   per-fleet `flagTraitMul` map built once per tick.

## The aura (P2)

Halved, flag-excluded: members other than the flagship get
`1 + (traitMul − 1)/2` on the flag trait's axis, stacking multiplicatively
with their own captain's trait.

| Flag trait | Fleet effect (members, halved) | Where applied |
|---|---|---|
| Gunner | +5% damage | server combat pass |
| Bulwark | +5% effective max HP | server combat + repair cap |
| Wrench | +25% repair rate | server maintenance pass |
| Voidrunner | +5% acceleration | client torch planning (mirrors `src/game/captains.ts`) |
| Pathfinder | +7.5% sensor range | server visibility + client fog |
| Quartermaster | +12.5% cargo | server autopilot loads |
| Colonist | −10% settle cost | colony deploy pricing |

Client mirrors live in `src/game/captains.ts` beside the existing trait
table so SP-parity code paths stay compilable (SP itself stays frozen).

## Client surfaces

- **FleetPanel** becomes the fleet manager: multi-select → "Form fleet"
  (flag picker defaults to highest-rank captain); fleet header rows show
  name · flag captain (rank, trait, aura line) · member count; common-orders
  bar (stance/retreat/detonate) per fleet; **PROMOTE** flow on leaderless
  fleets (pick from member captains). Replaces the client-local fleet UI in
  ShipPanel/gameContext.
- **ShipPanel** fleet section: shows fleet name + flag, "leave fleet",
  "move fleet here" alongside the single-ship move.
- **Situation Report**: new `fleet_leaderless` category, decision tier —
  "3rd Squadron is leaderless · promote a captain" → focuses FleetPanel.
  Cleared live by the promote (condition-based, no stamp — per the audit
  rule that stamps must not outlive their condition).
- **Chronicle/digest**: `fleet_formed`, `fleet_flag_lost`,
  `fleet_flag_promoted` ("Vane assumed command of the 3rd"). Digest picks
  these up for free via the politics/battles clustering.
- **Map (deferred)**: fleet name label near the flagship at ship zoom —
  nice, not v1.

## Phases

- **P0 — the entity.** Migration, `worker/fleets.js` CRUD + leaderless
  gate, tick integrity pass, FleetPanel management UI, delete client-local
  fleets. *Fleets exist, persist, and share standing orders.*
- **P1 — command feel.** Fleet move fan-out + rejection summary, promote
  flow, `fleet_leaderless` report row, chronicle entries.
- **P2 — the aura.** Server passes + client mirrors per the table above.

## Regression notes

Table-test the leaderless state machine (flag dies → orders 409 → promote →
orders flow again), membership all-or-nothing validation, auto-disband at
<2, aura math halving (incl. flagship exclusion), and orders-inheritance on
join. Extend `qa/phase3.mjs` with a form-fleet → bulk-stance → flag-kill →
promote scenario if the harness gets attention before the playtest.

## Out of scope (recorded)

Speed-matched "arrive together" moves (v2 toggle candidate) · escort/follow
orders (deferred since identity-economy §3) · fleet-level trade routes ·
SP support (frozen) · map fleet labels.
