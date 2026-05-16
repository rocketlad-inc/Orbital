# Orbital — Design Doc

A real-time, asynchronous, server-authoritative orbital-strategy game. Players
control a faction in a 23-body solar system. Time advances on a fixed
wall-clock interval the host chooses (30 seconds to 24 hours per tick).
Players issue orders — transfers, builds, settlement deploys, research,
diplomacy — and the server's tick scheduler resolves them.

Single-player mode runs entirely client-side against `mockGameState`.
Multiplayer mode runs server-authoritative; the client is a renderer
that polls `/state` and posts intent.

---

## 1. Architecture

```
┌─────────────────────────┐         ┌───────────────────────────────┐
│      React client       │         │   Cloudflare Worker (worker/) │
│  (Create React App)     │◀───────▶│                               │
│                         │  HTTPS  │   ┌─────────────────────┐     │
│  - Map canvas            │         │   │ D1 (SQLite, durable)│     │
│  - Lobby / room picker   │         │   │  - users / sessions │     │
│  - Ship/Build/Tech/...   │   WS    │   │  - rooms / members  │     │
│    panels                │◀───────▶│   │  - games (per match)│     │
│                         │  ticks  │   │  - game_bodies,     │     │
│                         │         │   │    game_ships,      │     │
│                         │         │   │    game_settlements,│     │
│                         │         │   │    game_factions,   │     │
│                         │         │   │    game_ship_nodes, │     │
│                         │         │   │    treaties, etc.   │     │
│                         │         │   └─────────────────────┘     │
│                         │         │   ┌─────────────────────┐     │
│                         │         │   │ Room Durable Object │     │
│                         │         │   │ (one per room)      │     │
│                         │         │   │  - WS hibernation   │     │
│                         │         │   │  - alarm() = tick   │     │
│                         │         │   │  - resolveTick(...) │     │
│                         │         │   └─────────────────────┘     │
└─────────────────────────┘         └───────────────────────────────┘
```

**Frontend** — `src/` — Create React App. The `GameContextProvider` in
`src/state/gameContext.tsx` owns all client-visible game state. In
single-player it ticks state locally from `mockGameState`. In multiplayer
the `MultiplayerGameProvider` polls `/api/games/:gid/state` and feeds
the result into `GameContextProvider` via the `externalState` prop, and
sets `externallyControlled` to disable the local sim loop.

**Backend** — `worker/` — Cloudflare Worker with D1 (SQLite) for
persistent state and Durable Objects (one per room) for live tick
scheduling and WebSocket fan-out. Migrations live in `migrations/*.sql`
and are applied via the one-shot `POST /api/__init` endpoint, which is
idempotent and tracked in a `_migrations` table.

**Wire format** — JSON over HTTPS for actions and snapshots, WebSocket
for push events (`{type:'tick'}`, `{type:'ships_destroyed'}`,
`{type:'game_completed'}`, `{type:'room_deleted'}`). Worker uses Web
Crypto only (PBKDF2 capped at 100k iters per CF limit).

---

## 2. Game world

**Solar system** — `worker/factions.js BODY_CATALOG` mirrors
`src/state/mockGameState.ts SHARED_BODIES`: Sol, Mercury, Venus, Earth,
Luna, Mars, Ceres, Jupiter + Io/Europa/Ganymede/Callisto,
Saturn + Enceladus/Rhea/Titan, Uranus + Titania/Oberon, Neptune + Triton,
Pluto, Eris. **23 bodies**. Orbit elements (radius, period, angle0) and
yields (metal/fuel/gold/science) are copied verbatim between client and
server.

Sol's gravitational parameter is `4π² × 460³ / 800² ≈ 6003`, derived
from Jupiter's orbit. All Hohmann math (client `bezierTransfer.ts`,
server `resolveTick`) uses this constant.

**Factions** — Up to 8 per match. Each player who joins a room before
Start becomes one faction. AI factions are not yet implemented.
`seedGameWorld` (in `factions.js`) runs at Start and:

  1. Honors each player's `chosen_starting_body` from the lobby picker.
     Unchosen players get a deterministic-shuffled assignment from the
     remaining terrestrial+moon options.
  2. Assigns `WORLDS_PER_PLAYER = 2` worlds per faction (capital + 1
     extra) by setting `game_bodies.owner_faction_id`.
  3. Spawns a starter fleet at each owned world: 2 frigates + 1 freighter
     (see `STARTER_FLEET`).
  4. Sets faction starting resources (see Tunables).
  5. Flips the game's status to `'active'` and writes `next_tick_at`.

**Ships** — Four classes (corvette, frigate, destroyer, freighter). Hull
+ damage stats are in `factions.js SHIP_COMBAT_STATS` and mirrored in
the Room DO build-completion fallback. Orbits are stored as Keplerian
elements (rp, ra, omega, M0, epoch, direction). Build costs and times
are in `actions.js SHIP_BUILD_COST`.

**Settlements** — Two types (city, station). Cities favor metal yield
(×1.2), stations favor science (×1.4). HP, harvest, growth, and combat
behavior all run server-side in `resolveTick`.

---

## 3. The tick cycle

The Room DO's `alarm()` is the single source of truth for time advance.
Each fire does:

```
alarm()
  ├── if status in {completed, abandoned}: stop
  ├── nextTick = current_tick + 1
  ├── if nextTick >= total_tick_target:
  │     compute winner (most worlds → most wealth → slot)
  │     write winner_faction_id, victory_type
  │     chronicle 'victory' entry
  │     broadcast {type: 'game_completed', winner_faction_id, victory_type}
  │     stop — do NOT reschedule
  ├── resolveTick(gameId, nextTick):
  │     1. Build completions: game_body_build_queue rows where
  │        completes_at_tick <= nextTick → INSERT new game_ships row
  │        in circular orbit; delete queue row.
  │     2a. Transfer departures: committed nodes with scheduled_t <= tick
  │         → compute Hohmann arrival_at_tick from departure.orbit_radius,
  │         target.orbit_radius, SOL_MU=6003; flip node status to
  │         'in_transit'. Ship stays at departure body.
  │     2b. Transfer arrivals: in_transit nodes whose arrival_at_tick
  │         <= tick → warp ship.parent_body_id to target, mark node
  │         'executed'.
  │     3. Ship combat: group ships by parent_body_id. For each body
  │        with ≥2 factions, each attacker's damage_per_tick is split
  │        evenly across hostile-faction ships at that body. Peace pacts
  │        (active NAP or defense_pact, both signed, not expired/broken)
  │        suppress damage. Ships at hp<=0 → status='destroyed',
  │        chronicle entry 'ship_destroyed'.
  │     3.4. Settlement combat: for each active settlement, hostile ships
  │          at the same body deal SETTLEMENT_INCOMING_DAMAGE_PER_HOSTILE
  │          _SHIP=4 hp/tick each (treaty-aware). On hp<=0, destroy +
  │          chronicle. Recompute body ownership for every body that
  │          lost a settlement.
  │     3.5. Population growth: every POP_GROWTH_INTERVAL=20 ticks, each
  │          settlement's pop += 1 (capped at POP_MAX=10).
  │     3.6. Yield harvest: every HARVEST_INTERVAL=10 ticks, each
  │          settlement adds body_yield × (1 + 0.1×(pop−1)) × type_mult
  │          to its stockpile. City: M×1.2, F×1.0, G×1.0, S×0.8.
  │          Station: M×0.8, F×1.1, G×1.0, S×1.4.
  │     3.7. Stockpile offload: if owner faction has a freighter at the
  │          settlement's body, sweep stockpile into faction resources
  │          and zero the stockpile.
  ├── write games.current_tick + next_tick_at
  ├── insert game_ticks log row
  ├── setAlarm(now + tick_interval_ms)
  └── broadcast {type: 'tick', tick, next_tick_at}
```

If the worker hibernates between ticks, Cloudflare wakes the DO at the
wall-clock alarm time. Persistence is `gameStarted` blob in DO storage
plus the games row in D1.

---

## 4. Systems

### Combat
- Each ship has `damage_per_tick` from class (`SHIP_COMBAT_STATS`).
- Damage split evenly across all hostile ships at the same body.
- Peace = active NAP or defense_pact between attacker and defender's
  factions (both signed `treaty_signatories`, treaty not expired or
  broken). Trade and intel_share pacts do NOT block fire.
- Settlements take a flat 4 hp per hostile ship at the body per tick;
  they don't fight back (yet).

### Resources
- Four resources, server stores them as **metal / fuel / gold /
  science**; client renames `metal→ore`, `gold→credits`. (Fuel is
  retained in schema but the server stopped enforcing/deducting it
  when the client's fuel UX was removed.)
- Settlements harvest body yields into a local stockpile every 10
  ticks, scaled by population and type bias.
- A freighter at a body sweeps owner's stockpile into faction resources
  on the next tick (immediate, not 10-tick-cadenced).

### Body ownership
- Initial: `seedGameWorld` assigns each faction `WORLDS_PER_PLAYER`
  worlds, sets `owner_faction_id` on those bodies.
- Dynamic: `recomputeBodyOwnership(db, gameId, bodyId)` runs after every
  settlement deploy and after every settlement destruction. The faction
  with the most active settlements at a body owns it. Ties or zero
  settlements leave the current owner untouched (so an undefended
  homeworld isn't auto-neutralized).
- Build permissions follow ownership: `handleQueueBuild` rejects unless
  caller owns the body.
- Victory ("hegemony") counts owned bodies.

### Fog of war
Visibility set per-caller, applied to `/state.bodies`,
`/state.ships`, `/state.settlements`:

  `presence` = bodies you own ∪ bodies your ships orbit
  `visible_bodies` = presence
                   ∪ children of presence (moons of bodies you're at)
                   ∪ parent of presence (planet of a moon you're at,
                     excluded if parent is Sol)

Ships and settlements outside `visible_bodies` are filtered from the
snapshot. Bodies are always returned (geometry is shared reality) but
their `owner_faction_id` and development levels are masked to null/0
on unscouted worlds.

### Maneuver / Bezier transfers
- Client computes a Hohmann transfer locally via `planBezierTransfer`
  in `src/physics/bezierTransfer.ts` — returns a `TransferArc` with
  precomputed cubic Bezier control points.
- Client posts the maneuver as a committed node:
  `POST /api/games/:gid/ships/:sid/transfer`.
- Server stores it in `game_ship_nodes` with status='committed' and
  `scheduled_t`.
- At `scheduled_t`, resolveTick flips status to 'in_transit' and
  computes `arrival_at_tick` from the same Hohmann formula
  (`SOL_MU=6003`, `a=(r1+r2)/2`, `t=π√(a³/μ)`).
- Between scheduled_t and arrival_at_tick the ship's `parent_body_id`
  is still the departure body. The client receives the node in /state
  and reconstructs the Bezier arc, attaches it as `ship.transfer`, and
  the renderer animates the ship along the curve.
- At `arrival_at_tick`, the resolver warps the ship to a circular orbit
  around the target and marks the node 'executed'.

### Tech tree
- Seven repeatable tracks (Stellaris-style):
  - **weapons** (+10% firepower / level)
  - **armor** (+8% HP / level)
  - **propulsion** (−6% transfer Δv cost / level)
  - **flight** (−6% travel time / level, floor 0.25×)
  - **construction** (−5% build cost / level)
  - **industry** (+10% settlement yield / level)
  - **sensors** (+12% sensor range / level)
- Costs scale super-linearly: `ceil(baseCost × (level+1)^scaling)`.
- Instant research (Civ/Stellaris repeatable pattern, not a progress
  bar): `POST /api/games/:gid/research { tech_id }` deducts science and
  bumps `faction_techs.level`.
- Server-authoritative on cost; client UI shows the live cost.
- All seven modifier helpers in `src/game/techs.ts` (`combatModifier`,
  `hpModifier`, etc.) read from `gameState.factionTech[player].levels`
  which is populated from `/state.me.tech_levels`.

### Diplomacy
- **Treaties** — schema in `treaties` + `treaty_signatories`. Kinds
  used today: `nap` and `defense_pact` (suppress combat). `trade`,
  `intel_share`, `demilitarization` exist but only `nap`/`defense_pact`
  affect combat resolution.
- **Senate** — `senate_proposals` + `senate_votes` + `senate_effects`.
  Schema lives, panel exists, but full integration with combat /
  resource modifiers is on the "not yet smoke-tested" list.
- **Trades** — schema in `trade_offers` (migration 0006), panel exists.
  Send/accept flow works in isolation. Not yet wired into a play loop.
- **Messaging** — `messages` + `message_recipients`, with DM / group /
  broadcast scopes. Faction-id-keyed.

### Game over
- At `current_tick >= total_tick_target`, the DO computes the winner:
  most owned bodies → most wealth (metal+fuel+gold+science) → lowest
  slot index. Writes `winner_faction_id` and `victory_type` on the
  games row. Chronicle entry kind='victory'.
- Client `MultiplayerGameProvider` watches `game.status === 'completed'`
  and renders a full-screen "VICTORY" or "GAME OVER" overlay with the
  winner's name and a Return to lobby button.

---

## 5. Client UI layout

- **Landing** (unauth): marketing page → AuthOverlay (sign in / sign up /
  continue as guest).
- **Mode picker**: Single Player / Multiplayer, with "Resume active
  game" shortcut.
- **Multiplayer lobby**: tabs for My Games / Browse / Create Room /
  Join by Code. Host-only delete button on owned rooms.
- **Room (pre-game)**: dock with Lobby tab. Body picker, host
  controls (match length, tick interval), ready / start.
- **Room (in-game)**: dock with Faction / Comms / Senate / Trades tabs.
  Map canvas behind. Lobby tab is hidden post-start.
- **In-game canvas**: solar map, ship/body/settlement panels. ORBITAL
  logo (top-left) opens a side drawer with Back to Menu / Sign Out.

---

## 6. Tunable variables — *the playtest knobs*

This is the section you'll come back to most. Every gameplay constant
has a single source of truth; tweak it there and (most of) the loop
follows.

### Match shape

| Knob | File | Default | Range / notes |
|---|---|---|---|
| Min match length | `worker/lobby.js MATCH_LENGTH_MIN` | 10 ticks | |
| Max match length | `worker/lobby.js MATCH_LENGTH_MAX` | 10,000 ticks | Earth→Neptune Hohmann ≈ 410 ticks |
| Allowed tick intervals | `worker/lobby.js ALLOWED_TICK_INTERVALS` | 30s / 60s / 5m / 30m / 1h / 6h / 12h / 24h | Frontend must mirror in `src/multiplayer/LobbyView.tsx TICK_INTERVAL_OPTIONS` |
| Default tick interval | `worker/lobby.js handleStart` (`tick_interval_ms = 86_400_000`) | 24h | Falls back to this if host didn't pick one |
| Default match length | `worker/lobby.js handleStart` (`total_tick_target = 42`) | 42 ticks | |

### Faction & seeding

| Knob | File | Default | Notes |
|---|---|---|---|
| Worlds per faction | `worker/factions.js WORLDS_PER_PLAYER` | 2 | Capital + 1 secondary |
| Starter fleet | `worker/factions.js STARTER_FLEET` | 2 frigates + 1 freighter | Per owned world |
| Starting resources | `worker/factions.js STARTING_RESOURCES` | (see file) | Metal / fuel / gold / science |
| Faction names | `worker/factions.js FACTION_NAMES` | 8 defaults | Overridden by lobby `empire_name` |
| Faction colors | `worker/factions.js FACTION_COLORS` | 8 hex codes | |
| Starting capital options | `worker/factions.js STARTING_BODY_OPTIONS` | terrestrial + moon types | Filtered from BODY_CATALOG |

### Ship combat stats

`worker/factions.js SHIP_COMBAT_STATS` — server source of truth for
**starter fleet** ships. `worker/room.js resolveTick` build-completion
path has matching `HP`, `DMG`, `FUEL_MAX` maps for newly-built ships.
**Edit both** when tuning or extract into a shared table.

| Class | HP | dmg/tick | Notes |
|---|---|---|---|
| corvette | 40 | 5 | Light scout |
| frigate | 80 | 10 | Workhorse |
| destroyer | 200 | 18 | Slow + heavy |
| freighter | 30 | 0 | Cargo, no firepower |

### Build economy

`worker/actions.js SHIP_BUILD_COST` — server source of truth.
`src/game/shipClasses.ts SHIP_CLASSES` is the **client** mirror; keep
them in sync.

| Class | metal | gold | build_ticks |
|---|---|---|---|
| corvette | 15 | 10 | 30 |
| frigate | 30 | 25 | 60 |
| destroyer | 60 | 50 | 120 |
| freighter | 20 | 15 | 45 |

(Fuel cost columns exist but are no longer enforced.)

### Settlement economy

| Knob | File | Default |
|---|---|---|
| Settlement cost | `worker/actions.js SETTLEMENT_COST` | 30 metal, 20 gold |
| Settlement HP | `handleDeploySettlement` (`hp` local) | city=100, station=60 |
| City yield bias | `worker/room.js resolveTick` step 3.6 | M×1.2 F×1.0 G×1.0 S×0.8 |
| Station yield bias | (same) | M×0.8 F×1.1 G×1.0 S×1.4 |
| Population multiplier | (same) | `1 + 0.1 × (pop−1)` |
| Harvest interval | `worker/room.js HARVEST_INTERVAL` | 10 ticks |
| Pop growth interval | `worker/room.js POP_GROWTH_INTERVAL` | 20 ticks |
| Pop cap | `worker/room.js POP_MAX` | 10 |
| Settlement combat damage | `worker/room.js SETTLEMENT_INCOMING_DAMAGE_PER_HOSTILE_SHIP` | 4 hp / hostile ship / tick |

### Tech costs

`worker/actions.js TECH_DEFS` (server) mirrored in
`src/game/techs.ts TECH_DEFS` (client). Cost formula is
`ceil(baseCost × (level+1)^costScaling)`. Bumping `costScaling` slows
runaway snowballs; bumping `baseCost` makes early levels feel
expensive.

| Tech | baseCost | costScaling | perLevel |
|---|---|---|---|
| weapons | 40 | 1.7 | +10% firepower |
| armor | 40 | 1.7 | +8% HP |
| propulsion | 35 | 1.6 | −6% transfer Δv |
| flight | 50 | 1.7 | −6% travel time |
| construction | 50 | 1.8 | −5% build cost |
| industry | 45 | 1.7 | +10% settlement yield |
| sensors | 30 | 1.5 | +12% sensor range |

### Physics

| Knob | File | Default |
|---|---|---|
| Sol gravitational parameter | `worker/room.js SOL_MU` (also `src/physics/orbitalMechanics.ts GRAVITATIONAL_PARAMS.SOL`) | ≈6003 |
| Hohmann travel time formula | `t = π × √(a³/μ)` where `a=(r1+r2)/2` | Hard-coded in both `bezierTransfer.ts` and `room.js resolveTick` |
| Flight tech travel multiplier floor | `src/game/techs.ts travelTimeModifier` | 0.25× (75% reduction cap) |

### Fog of war

Implicit in the `visible_bodies` CTE in `worker/state.js`. Currently:
presence ∪ moons-of-presence ∪ planet-of-moon-presence. To widen,
either add a sensor_coverage join, or expand the CTE to include
siblings within an orbit-radius distance.

### Room economy

| Knob | File | Default |
|---|---|---|
| Min players to start | `worker/lobby.js handleStart` | 2 |
| Max players per room (allowed range) | `worker/index.js handleCreateRoom` | 2–8 |
| Default max players | (same) | 4 |
| Min room password length | `worker/index.js handleCreateRoom` | 4 |
| Invite code length | `worker/index.js newInviteCode` | 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` |

### Client polling

| Knob | File | Default |
|---|---|---|
| /state poll interval | `src/multiplayer/MultiplayerGameProvider.tsx POLL_INTERVAL_MS` | 1500 ms |
| Lobby room poll | `src/App.tsx` AppShell room poll | 3000 ms |
| WS ping interval | `src/multiplayer/LobbyView.tsx` RoomDetail | 25,000 ms |

---

## 7. Action endpoints (intent surface)

All these require an authenticated session and a faction in the game.

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/games/:gid/ships/:sid/transfer` | `{target_body_id, scheduled_t, dv_prograde, dv_normal?, dv_radial?, fuel_cost}` | Commit a maneuver node |
| POST | `/api/games/:gid/bodies/:bid/build` | `{ship_class, ship_name?}` | Queue a ship build (deducts metal+gold) |
| POST | `/api/games/:gid/bodies/:bid/settlement` | `{type:'city'\|'station', name?}` | Deploy a settlement, recomputes body owner |
| POST | `/api/games/:gid/research` | `{tech_id}` | Spend science to bump a tech level |

Read endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/api/games/:gid/state` | Full renderer snapshot (game / me / factions / bodies / ships / settlements / nodes / events) |
| GET | `/api/games/:gid/factions` | Public faction list |
| GET | `/api/games/:gid/me` | Caller's faction |
| GET | `/api/games/:gid/messages` | DM/group/broadcast feed |

Lobby endpoints:

| Method | Path | Effect |
|---|---|---|
| GET | `/api/rooms` | Browse open rooms |
| POST | `/api/rooms` | Create room (returns invite code) |
| POST | `/api/rooms/join-by-code` | Join by 8-char code |
| POST | `/api/rooms/:id/join` | Join by id |
| DELETE | `/api/rooms/:id` | Host-only; cascades through FKs |
| GET | `/api/lobby/rooms/:id` | Room snapshot (members, settings, identity, game_id once started) |
| PATCH | `/api/lobby/rooms/:id/settings` | Host edits match length / interval / max players / name |
| PATCH | `/api/lobby/rooms/:id/me` | Caller updates empire_name / bio / chosen_starting_body |
| POST | `/api/lobby/rooms/:id/start` | Host starts the match → seedGameWorld + DO alarm |
| POST | `/api/lobby/rooms/:id/kick` | Host removes a member |

---

## 8. Schema migrations

Tracked in `_migrations` table, applied via `POST /api/__init`
(idempotent). The bundler in `scripts/bundle-migrations.js` inlines all
`migrations/*.sql` into `worker/_migrations_bundle.js` at build time.

| # | File | What |
|---|---|---|
| 0001 | init.sql | users + sessions |
| 0002 | rooms.sql | rooms + room_members |
| 0003 | game_state.sql | games + factions + bodies + ships + nodes + sensor_coverage + treaties + senate + messages + chronicle + snapshots |
| 0004 | senate_effects.sql | active senate-slider effect rows |
| 0005 | empire_identity_and_starter_fleet.sql | empire_name + bio columns |
| 0006 | trade_offers.sql | trade negotiation tables |
| 0007 | rooms_invite_password.sql | room invite_code + password_hash |
| 0008 | starting_body.sql | room_members.chosen_starting_body |
| 0009 | ship_combat.sql | game_ships.hp + hp_max + damage_per_tick |
| 0010 | game_settlements.sql | settlements table |
| 0011 | node_arrival_at_tick.sql | maneuver arrival tick for transit animation |
| 0012 | faction_tech_level.sql | faction_techs.level for Stellaris repeatables |

---

## 9. Known gaps for a "good" (not just "working") playtest

These don't crash anything but limit the loop:

- **Late join** — joining a room after `Start` doesn't create a faction.
  Workaround: get everyone in before the host clicks Start.
- **WS auto-reconnect** — if the socket drops the 1.5s poll keeps the
  canvas alive but instant tick pushes stop firing until reload.
- **Senate panel + trades** aren't smoke-tested post-fuel-removal.
  Endpoints exist; the loop hasn't been exercised end-to-end since the
  big economy changes.
- **Sim balance is first-draft.** All the values in §6 are placeholder
  guesses. The whole reason §6 exists is to make iterating on them
  trivial during playtest.
- **Settlements don't fight back.** Cities and stations take damage from
  hostile ships but have no defensive firepower.
- **Body capture mid-flight** — `recomputeBodyOwnership` runs on
  settlement deploy + destruction. If a faction's settlements were
  empty-ownership at seed but the seed gave them a body anyway, the
  recompute won't run until something changes.

---

## 10. Single-player vs multiplayer parity

Single-player runs on `mockGameState` and the local `GameContextProvider`
sim loop. It has features multiplayer doesn't (and vice versa):

| Feature | Single-player | Multiplayer |
|---|---|---|
| Game canvas | mockGameState | server `/state` |
| Time advance | Local 60Hz loop, simSpeed | Room DO alarm at host-chosen interval |
| Combat resolution | `src/game/combat.ts autoCombatAtBodies` | Server `resolveTick` step 3 |
| Settlement harvest | `src/game/settlements.ts tickSettlements` | Server `resolveTick` step 3.6 |
| Tech tree | `gameContext startResearch/cancelResearch` (progress bar) | `POST /research` (instant repeatable) |
| Treaties | n/a | NAP/defense_pact suppress combat |
| Fog of war | `src/game/visibility.ts` (sensor range, occlusion, ghost intel) | Server CTE (SOI cluster) |
| Fuel | Removed via `FUEL_ENABLED` flag | Server stopped enforcing |

The mappers in `MultiplayerGameProvider.serverToGameState` translate
between the two universes: server `metal/gold` → client `ore/credits`,
server body types (`gas-giant`) → client (`gas_giant`), and so on.
