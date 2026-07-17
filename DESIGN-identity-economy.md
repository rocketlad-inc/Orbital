# DESIGN — Identity & Economy Release

Status: **approved direction** (Lorne, 2026-07-17). This doc is the working spec
for the combined release: economy rework, ship designer, orders, build queue,
colony/freighter split, two-tone factions, SP-AI freeze.

Playtest drivers (Sean's feedback, 2026-07-09..16):
- "Deciding what units I should be producing should feel like a meaningful choice."
- "Never something I needed to trade with another player to get."
- Metal 500/t vs science 200/t by endgame — flywheel + map both skewed.
- "I keep mistaking ships as my own" — blue vs teal.

---

## 1. Economy rework (FOUNDATION — lands first, everything prices against it)

### 1.1 Fuel is dead
- Remove fuel from: top bar, faction resources, body yields, settlement
  harvest/stockpiles, building costs, transfer payloads (server already
  ignores `fuel_cost`), starting resources.
- DB columns stay (unread) — no destructive migration on live games.
- The game is now 3 resources: **METAL / CREDITS / SCIENCE**.

### 1.2 Break the Forge↔Mint flywheel
Current bug: Forge costs credits→makes metal; Mint costs metal→makes credits.
Closed positive-feedback loop; Lab taxes both and returns less, later.

| Building | New cost basis | Effect | Notes |
|---|---|---|---|
| Forge | **metal** (self-limiting) | +25%/lvl metal | was credits |
| Mint | **credits** (self-limiting) | +25%/lvl credits | was metal |
| Lab | **credits** | **+25%/lvl science** (was +20) | build time 20t (was 25) |

### 1.3 Labs on stations
`BUILDING_DEFS.lab.hostType: 'city' | 'station'`. Stations already carry the
×1.4 science type-multiplier — they're the research platforms; let them host
the research building. Cities keep forge/mint. This is the station's identity:
**cities mine, stations think.**

### 1.4 System specialization — the yield table

Rules:
- Every region is STRONG in one resource and NEAR-ZERO in another.
  The deficit is what makes trade real.
- Gas giants + Sol are settleable via colony-ship stations (see §4) —
  each giant is its region's jackpot.
- Map totals targeted roughly equal across the three resources (±15%);
  tune after one playtest cycle, not before.

| Region | Identity | Deficit |
|---|---|---|
| Inner worlds | credits (markets, population) | metal |
| Belt + belt rogues | metal + some credits | **science: zero** |
| Jupiter system | credits jackpot | metal |
| Saturn system | metal jackpot (ring mining) | **credits: near-zero** |
| Uranus system | science + workable metal | credits |
| Neptune system | science jackpot | **metal: near-zero** |
| Kuiper (dwarfs + rogues) | credits + science exotics | metal |

Per-body (METAL / CREDITS / SCIENCE — fuel column deleted):

| Body | M | C | S | | Body | M | C | S |
|---|---|---|---|---|---|---|---|---|
| **INNER** | | | | | **URANUS** | | | |
| Mercury | 2 | 4 | 1 | | Uranus ⚓ | 2 | 1 | 6 |
| Venus | 1 | 3 | 4 | | Miranda | 4 | 0 | 3 |
| Earth | 2 | 6 | 3 | | Ariel | 3 | 0 | 5 |
| Luna | 2 | 2 | 2 | | Umbriel | 3 | 1 | 4 |
| Mars | 4 | 2 | 2 | | Titania | 4 | 0 | 4 |
| **BELT** | | | | | Oberon | 4 | 1 | 4 |
| Ceres | 6 | 3 | 0 | | **NEPTUNE** | | | |
| Vesta | 7 | 1 | 0 | | Neptune ⚓ | 0 | 2 | 9 |
| Pallas | 6 | 2 | 0 | | Proteus | 1 | 1 | 5 |
| Hygiea | 6 | 1 | 0 | | Triton | 1 | 2 | 6 |
| Juno | 5 | 3 | 0 | | Nereid | 0 | 1 | 5 |
| Midas | 7 | 5 | 0 | | **KUIPER** | | | |
| Styx | 8 | 3 | 0 | | Pluto | 2 | 4 | 3 |
| Iron Anna | 9 | 2 | 0 | | Charon | 1 | 5 | 2 |
| **JUPITER** | | | | | Haumea | 2 | 3 | 3 |
| Jupiter ⚓ | 1 | 9 | 2 | | Makemake | 1 | 4 | 3 |
| Io | 2 | 5 | 1 | | Eris | 0 | 5 | 4 |
| Europa | 1 | 4 | 3 | | Quaoar | 2 | 3 | 3 |
| Ganymede | 2 | 5 | 2 | | Sedna | 1 | 4 | 4 |
| Callisto | 3 | 4 | 1 | | Black Sky | 3 | 6 | 1 |
| **SATURN** | | | | | Vagrant | 2 | 7 | 1 |
| Saturn ⚓ | 9 | 1 | 2 | | Augustín | 2 | 6 | 2 |
| Enceladus | 5 | 0 | 3 | | Sol ⚓ | 0 | 0 | 0 |
| Rhea | 6 | 1 | 1 | | | | | |
| Titan | 7 | 1 | 2 | | | | | |

⚓ = station-only (colony ship required; no city surface).
Totals: metal ≈138, credits ≈123, science ≈112 (vs today's 174/102/100 with
metal on literally every body).

### 1.5 Spawn fairness (prereq, promoted from bug list)
Once yields specialize, spawn region ≈ your whole early game. Seeder rules:
- Capitals come from STARTING_BODY_OPTIONS only (already true for chosen;
  make the FALLBACK pool respect it too — the Vagrant-capital bug).
- No two capitals in the same region; prefer maximally-separated regions.
- Every capital body must have science ≥ 2 (no science-dead starts).

---

## 2. Ship designer

### 2.1 Slots & parts
| Hull | Slots | Notes |
|---|---|---|
| Corvette | 2 | |
| Frigate | 4 | |
| Destroyer | 6 | |
| Freighter | 1 | engine or shield only |
| Colony ship | 0 | no designer |

| Part | Effect per part (base) | Per-ship cost | Tech track |
|---|---|---|---|
| Weapon | +40% of hull base dmg | metal-heavy | **Weapons** (+10%/lvl to part effect) |
| Shield | +35% of hull base HP | metal+credits | **Armor** (+8%/lvl) |
| Engine | −15% travel time (mult.) | credits-heavy | **Propulsion** (repurposed: +engine part effect/lvl; its −Δv effect dies with fuel) |
| Detonator | see §2.2 | expensive: metal+credits | **Weapons** at half rate (PENDING sign-off) |

- Flight Dynamics stays as it is: base −6%/lvl travel time for EVERY hull.
  Propulsion rewards engine-heavy designs; Flight Dynamics rewards everyone.
- Part costs are added to the hull cost at queue time. Empty slots are free —
  a bare hull is the budget option. This is the "meaningful build choice."
- Base stats: hull provides HP/dmg/speed/cost as today (null-design ship
  == today's ship exactly; this is also the live-game migration story).

### 2.2 Detonator spec (DECIDED 2026-07-17)
- Manual trigger (button on ship panel) or automated via order (§3).
- Deals **50% of the ship's MAX HP** as damage to EVERY ship in the same
  orbit — **including friendlies**. Ship is consumed. Chronicle event.
- Multiple detonators stack additively (2 parts = 100% of max HP, etc.).
- UX REQUIREMENT: everywhere a detonator appears (designer part card,
  ship panel button, order toggle) the copy must state ALL of:
  damage amount, friendly fire, ship consumed. No surprises — e.g.
  "Detonate: deal N damage (50% max HP per detonator) to every ship in
  this orbit, friend or foe. This ship is destroyed."
- Priced so a fireship swarm is a strategy, not the default.

### 2.3 Templates
- Named design library per player per game (`game_ship_designs` table:
  id, game_id, faction_id, ship_class, name, parts_json, icon_variant).
- One ACTIVE design pointer per class; BUILD uses the active design.
- Design is SNAPSHOT onto the build order at queue time (parts_json copied);
  editing a design never mutates queued/completed ships.
- Designer lives in the Fleet menu; BuildPanel rows get a quick-link.
- Icon variant is chosen in the designer (reuses existing variant system).
- No retrofit of existing ships in v1.

---

## 3. Ship orders (standing, ship-level, bulk-applyable)

| Order | Values | Behavior |
|---|---|---|
| Stance | attack-on-sight / defensive / hold-fire | attack: engage hostiles in range. defensive: return fire only. hold: never fire (scout/runner). |
| Retreat at HP | off / 25% / 50% / 75% | Auto-transfer to nearest friendly shipyard body (station repair heals — closes the loop). Fires once per damage episode. |
| Dead-man detonate | off / 25% / 50% | Detonator hulls only: auto-trigger below threshold. |

- Columns on `game_ships`: `stance`, `retreat_hp_pct`, `detonate_hp_pct`.
- Bulk apply: Fleet menu multi-select → set orders. Server: one endpoint,
  `PATCH /api/games/:gid/ships/orders` with ship_ids[] + fields.
- Escort/follow: **deferred to v1.5** (transfer-inheritance is hairy).
- Defaults: attack-on-sight, retreat off — identical to today's behavior.

---

## 4. Expansion: colony ship + station rules

- **Colony ship**: new hull class. Consumable. No slots, no weapons, slow.
  Cost target: ~3× freighter (pricing in NEW economy; it is the expansion
  pacing knob). Deploy action consumes the ship.
- **Cities**: ALWAYS cost a colony ship.
- **Stations**: two paths —
  1. From a body where you already own a settlement: build from orbit for
     metal (no ship needed).
  2. Anywhere else (gas giants, Sol): consume a colony ship.
- Freighters lose the settle verb entirely. Haul + trade only.
- Gas giants + Sol become settleable (station-only, ⚓ in yield table).
  Sol station is the Dyson foundation site (already true).

---

## 5. Two-tone factions

- Lobby: pick primary + secondary. Primary choices enforced for perceptual
  distance against already-picked primaries (no more blue-vs-teal).
- Rule: **primary = ownership, secondary = decoration.** Meaning is never
  encoded ONLY in the secondary (colorblind safety).
- Render surfaces: ship icon trim, trajectory dash alternation, city pad
  edge, station beacon, event-log name tints, situation-report chips,
  outliner rows.
- Schema: `game_factions.color2` + lobby member pref; default secondary
  auto-derived (darkened primary) for legacy rows.

## 6. Single-player AI: FROZEN
- factionAI.ts gets NO new-system support. SP remains playable on legacy
  mechanics; new systems are MP-only until further notice.
- Cuts ~35% of implementation surface (the SP sim in gameContext.tsx
  mirrors nearly every server mechanic — none of §1–§4 gets mirrored).
- DECIDED: SP stays **visible but frozen** on legacy mechanics.

---

## 7. Sequencing & scope

| Phase | Work | Size | Parallel? |
|---|---|---|---|
| P0 | Economy (§1 fuel-kill, flywheel, station labs, yield table, spawn rules) | L | solo first — pricing substrate |
| P1a | Designer (§2) schema+server+UI | XL | yes |
| P1b | Orders (§3) | M | yes |
| P1c | Build queue: unlimited depth, concurrency = shipyard level, charge at queue, drag-reorder | S | yes |
| P1d | Colony ship + station rules (§4) | M | yes |
| P1e | Two-tone (§5) | M | yes |
| P2 | Integration pass + sim-harness E2E + balance | M | solo last |

- Regression net: extend scratchpad sim harness (3-player E2E driver) to
  cover: design→queue→build, orders, retreat loop, detonator, colony
  deploy on gas giant, specialization income deltas.
- Migration: old ships null-design (== current stats); old games keep fuel
  columns unread; color2 defaults derived.
- Branch naming: `feat/real-physics` is now a misnomer — new integration
  branch for this release: `feat/identity-economy`.

## 8. Decisions log
1. Detonator: 50% max HP per part, half-Weapons tech scaling, full-disclosure
   UX copy — DECIDED 2026-07-17.
2. Colony ship ~3× freighter cost — APPROVED.
3. SP: visible but frozen — DECIDED.
4. Yield table: approved as drafted; tune after first playtest cycle.
