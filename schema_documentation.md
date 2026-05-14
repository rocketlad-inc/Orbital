# Orbital Game Schema Documentation

## Overview

This SQLite schema is designed to:
- Store persistent game state for multiplayer asynchronous strategy games
- Support tick-based simulation (daily ticks, 45-day games)
- Enable efficient queries for game logic execution
- Support real-time frontend updates via subscribable events
- Scale to ~50-100 bodies, ~50-200 ships, ~30-50 factions per game

The schema uses a normalized design with strategic denormalization for performance. Complex data (orbits, conditions, treaty terms) is stored as JSON for flexibility.

---

## Core Game Tables

### `games`

**Purpose**: Represents a single game instance. One row per active or completed game.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique game identifier |
| `name` | TEXT | Display name (must be unique) |
| `status` | TEXT | `'active'`, `'completed'`, `'cancelled'` |
| `max_ticks` | INTEGER | Total ticks planned (typically 45 for 6 weeks) |
| `current_tick` | INTEGER | 0-indexed, incremented by tick executor |
| `start_time` | TEXT | ISO 8601 timestamp when game started |
| `tick_interval_hours` | REAL | Hours between ticks (default 24) |
| `next_tick_time` | TEXT | ISO 8601 when next tick will execute |
| `created_at`, `updated_at` | TEXT | ISO 8601 timestamps |

**Indexes**:
- `status` — Filter active vs. completed games
- `current_tick` — For queries like "get all pending X for games at tick N"
- `next_tick_time` — Scheduler needs to find games ready for tick execution

**Common Queries**:
```sql
-- Find all active games ready for a tick
SELECT * FROM games WHERE status = 'active' AND next_tick_time <= datetime('now');

-- Get game state at a specific tick
SELECT * FROM games WHERE id = ? AND current_tick = ?;
```

---

### `factions`

**Purpose**: Represents a player or faction within a game.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique faction ID within game |
| `game_id` | INTEGER FK | Parent game |
| `user_id` | TEXT | External user ID (from auth system) |
| `name` | TEXT | Faction name (unique per game) |
| `color` | TEXT | Hex color (#RRGGBB) for UI display |
| `capital_body_id` | INTEGER FK | Home planet (null if not founded yet) |
| `faction_type` | TEXT | `'player'`, `'npc'`, `'neutral'` |
| `reputation` | INTEGER | Global reputation score (can be negative) |
| `treasury_metal`, `treasury_fuel`, `treasury_gold`, `treasury_science` | INTEGER | Total resources held |
| `is_eliminated` | INTEGER | Boolean (0/1), faction has been removed from game |
| `eliminated_at_tick` | INTEGER | Tick when faction was eliminated |
| `eliminated_by_faction_id` | INTEGER FK | Which faction caused elimination (optional) |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Constraints**:
- `UNIQUE(game_id, user_id)` — One faction per user per game
- `UNIQUE(game_id, name)` — Faction names unique per game

**Indexes**:
- `game_id`, `user_id` — Find faction for a user in a game
- `is_eliminated` — Filter active factions
- `game_id` — For list queries

**Common Queries**:
```sql
-- Get all active factions in a game
SELECT * FROM factions WHERE game_id = ? AND is_eliminated = 0;

-- Get resources for a faction
SELECT treasury_metal, treasury_fuel, treasury_gold, treasury_science
FROM factions WHERE id = ? AND game_id = ?;

-- Apply tax/resource decay at tick end
UPDATE factions SET treasury_gold = treasury_gold * 0.95
WHERE game_id = ? AND is_eliminated = 0;
```

---

### `bodies`

**Purpose**: Represents celestial bodies (planets, moons, stations) in the solar system.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique body ID |
| `game_id` | INTEGER FK | Parent game |
| `name` | TEXT | Display name (unique per game) |
| `body_type` | TEXT | `'star'`, `'terrestrial_planet'`, `'gas_giant'`, `'moon'`, `'asteroid'`, `'lagrange_station'`, `'space_station'` |
| **Orbital Mechanics** | | |
| `parent_body_id` | INTEGER FK | What it orbits (null for star, or for stations at lagrange points) |
| `semi_major_axis` | REAL | Orbital semi-major axis in km |
| `eccentricity` | REAL | Orbital eccentricity (0.0-1.0) |
| `inclination` | REAL | Orbital inclination in degrees |
| `longitude_ascending_node` | REAL | LAN in degrees |
| `argument_periapsis` | REAL | Argument of periapsis in degrees |
| `mean_anomaly_epoch` | REAL | Mean anomaly at epoch (degrees) |
| `orbital_epoch` | TEXT | ISO 8601 timestamp when mean_anomaly_epoch is valid |
| `orbital_period_hours` | REAL | Simplified orbital period in hours |
| **Physical** | | |
| `radius_km` | REAL | Body radius in km |
| `mass_kg` | REAL | Body mass in kg |
| `sphere_of_influence_km` | REAL | SOI radius for orbital transfers |
| `gravity_ms2` | REAL | Surface gravity in m/s² |
| **Ownership & Development** | | |
| `owned_by_faction_id` | INTEGER FK | Controlling faction (null for unclaimed) |
| `development_level` | INTEGER | 0-5 scale, affects resource production |
| `development_points` | INTEGER | Progress toward next level (0-100) |
| `infrastructure_json` | TEXT | See JSON schema below |
| **Production** | | |
| `produces_metal_per_tick`, `produces_fuel_per_tick`, `produces_gold_per_tick`, `produces_science_per_tick` | INTEGER | Base production per tick (reduced by development level) |
| `storage_capacity_*` | INTEGER | Per-resource storage limit |
| `stored_*` | INTEGER | Current stored amount |
| **Metadata** | | |
| `discovered_by_faction_id` | INTEGER FK | Faction that discovered it (for fog of war) |
| `last_production_tick` | INTEGER | Last tick production was applied |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id` — Find all bodies in game
- `parent_body_id` — Find moons/children of a body
- `game_id, owned_by_faction_id` — Get all territory controlled by faction
- `body_type` — Filter by type

**Infrastructure JSON Schema**:
```json
{
  "docks": 2,
  "labs": 1,
  "mines": 3,
  "refineries": 1,
  "defense_stations": 2,
  "farming_facilities": 0
}
```

**Common Queries**:
```sql
-- Get all owned planets for a faction
SELECT * FROM bodies WHERE game_id = ? AND owned_by_faction_id = ?;

-- Apply resource production for a tick
UPDATE bodies
SET stored_metal = MIN(stored_metal + produces_metal_per_tick, storage_capacity_metal)
WHERE game_id = ? AND last_production_tick < ?;

-- Get celestial bodies in stable orbits (for SOI calculations)
SELECT * FROM bodies WHERE game_id = ? AND parent_body_id IS NOT NULL;

-- Discover new bodies (fog of war update)
UPDATE bodies SET discovered_by_faction_id = ? 
WHERE game_id = ? AND discovered_by_faction_id IS NULL AND id = ?;
```

---

## Ships & Fleet Tables

### `ships`

**Purpose**: Represents capital ships and fleet units under faction control.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique ship ID |
| `game_id` | INTEGER FK | Parent game |
| `faction_id` | INTEGER FK | Owning faction |
| `name` | TEXT | Display name (unique per game) |
| `class` | TEXT | `'frigate'`, `'cruiser'`, `'capital'`, `'stealth'`, `'transport'` |
| `status` | TEXT | `'active'`, `'destroyed'`, `'decommissioned'` |
| **Fuel System** | | |
| `fuel_current` | INTEGER | Current fuel (same units as costs) |
| `fuel_max` | INTEGER | Tank capacity |
| `fuel_burn_rate_per_acceleration_mps` | REAL | Fuel cost per m/s delta-v |
| **Orbital State** | | |
| `current_orbit_json` | TEXT | See OrbitElements schema below |
| `orbit_set_at_tick` | INTEGER | Tick when this orbit was established |
| **Combat & Status** | | |
| `hull_integrity` | REAL | 0.0-1.0, affects damage resistance |
| `armor_level` | INTEGER | 0-5 scale |
| `max_delta_v_mps` | REAL | Maximum velocity capability in m/s |
| `cargo_capacity_tons` | INTEGER | Max cargo |
| `cargo_json` | TEXT | Current cargo (see schema below) |
| **Metadata** | | |
| `build_completed_at_tick` | INTEGER | Tick when construction finished |
| `last_maneuver_tick` | INTEGER | When last maneuver was executed |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id, faction_id` — Get all ships for a faction
- `status` — Find active vs. destroyed ships
- `class` — Filter by ship type

**OrbitElements JSON Schema**:
```json
{
  "semi_major_axis_km": 400000,
  "eccentricity": 0.05,
  "inclination_deg": 5.0,
  "longitude_ascending_node_deg": 0,
  "argument_periapsis_deg": 90,
  "mean_anomaly_epoch_deg": 180,
  "epoch_tick": 10,
  "parent_body_id": 2,
  "periapsis_distance_km": 380000,
  "apoapsis_distance_km": 420000,
  "orbital_period_seconds": 5400
}
```

**Cargo JSON Schema**:
```json
{
  "metal": 500,
  "fuel": 1000,
  "gold": 100,
  "science": 50
}
```

**Common Queries**:
```sql
-- Get all active ships for a faction
SELECT * FROM ships WHERE game_id = ? AND faction_id = ? AND status = 'active';

-- Find ships in a specific orbit (for combat detection)
SELECT * FROM ships WHERE game_id = ? AND current_orbit_json LIKE '%"parent_body_id": 5%';

-- Consume fuel during acceleration
UPDATE ships SET fuel_current = fuel_current - ? WHERE id = ?;

-- List ships with pending maneuvers
SELECT s.* FROM ships s
INNER JOIN maneuver_orders mo ON s.id = mo.ship_id
WHERE s.game_id = ? AND mo.status IN ('planned', 'committed');
```

---

## Orders & Automation Tables

### `maneuver_orders`

**Purpose**: Represents planned or executing fleet movements and combat actions.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique order ID |
| `game_id` | INTEGER FK | Parent game |
| `ship_id` | INTEGER FK | Ship executing the maneuver |
| `status` | TEXT | `'planned'`, `'committed'`, `'executing'`, `'executed'`, `'failed'`, `'cancelled'` |
| `order_type` | TEXT | `'orbital_transfer'`, `'hohmann_transfer'`, `'manual_burn'`, `'dock'`, `'undock'`, `'attack'` |
| **Timing** | | |
| `planned_burn_tick` | INTEGER | Absolute tick number for burn |
| `planned_burn_time` | TEXT | ISO 8601 timestamp |
| `duration_ticks` | INTEGER | How long execution takes |
| **Orbital Transfer Details** | | |
| `target_body_id` | INTEGER FK | Destination (for transfers) |
| `post_maneuver_orbit_json` | TEXT | Resulting orbit after burn |
| `delta_v_mps` | REAL | Total delta-v required in m/s |
| `fuel_required` | INTEGER | Fuel cost |
| **Attack Details** | | |
| `target_ship_id` | INTEGER FK | Enemy ship (for attack orders) |
| **Metadata** | | |
| `created_at_tick` | INTEGER | Tick order was created |
| `executed_at_tick` | INTEGER | Tick when executed |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id` — Filter by game
- `ship_id` — Get all orders for a ship
- `status` — Find pending/executing orders
- `planned_burn_tick` — Scheduler needs to find orders due this tick

**Common Queries**:
```sql
-- Get all pending maneuvers for a tick
SELECT * FROM maneuver_orders
WHERE game_id = ? AND status IN ('planned', 'committed')
  AND planned_burn_tick <= ?;

-- Execute a maneuver
UPDATE maneuver_orders
SET status = 'executed', executed_at_tick = ?
WHERE id = ? AND game_id = ?;

-- Update ship orbit after successful maneuver
UPDATE ships
SET current_orbit_json = ?, orbit_set_at_tick = ?
WHERE id = ?;

-- Get pending maneuvers for a ship to display in UI
SELECT * FROM maneuver_orders
WHERE ship_id = ? AND status IN ('planned', 'committed')
ORDER BY planned_burn_tick ASC;
```

---

### `standing_orders`

**Purpose**: Conditional automation rules that trigger based on game state.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique rule ID |
| `game_id` | INTEGER FK | Parent game |
| `faction_id` | INTEGER FK | Faction owning this rule |
| `name` | TEXT | Human-readable name |
| `order_type` | TEXT | `'auto_defend'`, `'auto_scout'`, `'auto_trade'`, `'auto_collect'` |
| `enabled` | INTEGER | Boolean (0/1) to enable/disable without deleting |
| `condition_json` | TEXT | Trigger condition (see schema) |
| `action_json` | TEXT | Action to execute (see schema) |
| `priority` | INTEGER | Execution order if multiple rules trigger |
| `last_executed_tick` | INTEGER | Tick when last executed |
| `execution_count` | INTEGER | Total times executed |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id, faction_id` — Get all rules for a faction
- `enabled` — Filter active rules

**Condition JSON Schema** (examples):
```json
{
  "type": "fleet_near_body",
  "body_id": 5,
  "distance_km": 50000,
  "faction_id": 2
}
```

```json
{
  "type": "low_resource",
  "resource_type": "fuel",
  "threshold": 1000
}
```

```json
{
  "type": "production_complete",
  "production_type": "ship",
  "ship_class": "frigate"
}
```

**Action JSON Schema** (examples):
```json
{
  "type": "launch_fleet",
  "source_body_id": 2,
  "target_body_id": 5,
  "count": 3,
  "ship_class": "frigate"
}
```

```json
{
  "type": "send_message",
  "to_faction_id": 3,
  "message": "Requesting cease-fire"
}
```

**Common Queries**:
```sql
-- Get all enabled standing orders for a faction
SELECT * FROM standing_orders
WHERE game_id = ? AND faction_id = ? AND enabled = 1
ORDER BY priority DESC;

-- Update execution tracking
UPDATE standing_orders
SET last_executed_tick = ?, execution_count = execution_count + 1
WHERE id = ?;
```

---

## Production Queue Tables

### `production_queue_items`

**Purpose**: Tracks what each faction is building, researching, or developing.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique queue item ID |
| `game_id` | INTEGER FK | Parent game |
| `faction_id` | INTEGER FK | Faction doing the production |
| `location_body_id` | INTEGER FK | Where it's being built (null for faction-level research) |
| `item_type` | TEXT | `'ship'`, `'facility'`, `'research'`, `'defense'`, `'infrastructure'` |
| **Ship Details** | | |
| `ship_class` | TEXT | Class if building a ship |
| `ship_name` | TEXT | Name for the new ship |
| **Facility Details** | | |
| `facility_type` | TEXT | Type of facility being built |
| **Research Details** | | |
| `tech_id` | TEXT | Technology identifier |
| `tech_name` | TEXT | Display name |
| **Progress** | | |
| `progress_ticks` | INTEGER | Ticks completed |
| `total_ticks` | INTEGER | Total ticks required |
| `status` | TEXT | `'queued'`, `'building'`, `'completed'`, `'cancelled'` |
| **Cost** | | |
| `cost_metal`, `cost_fuel`, `cost_gold`, `cost_science` | INTEGER | Resource requirements (snapshot) |
| **Completion** | | |
| `completed_at_tick` | INTEGER | When finished |
| `result_ship_id` | INTEGER FK | If a ship, reference to new ship record |
| **Metadata** | | |
| `priority` | INTEGER | Position in queue (lower = earlier) |
| `created_at_tick` | INTEGER | Tick item was queued |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id, faction_id` — Get all production for a faction
- `status` — Filter active vs. completed items
- `location_body_id` — Get production at a specific planet

**Common Queries**:
```sql
-- Get all in-progress production for a faction
SELECT * FROM production_queue_items
WHERE game_id = ? AND faction_id = ? AND status IN ('queued', 'building')
ORDER BY priority ASC;

-- Apply production tick progress
UPDATE production_queue_items
SET progress_ticks = progress_ticks + 1,
    status = CASE WHEN progress_ticks + 1 >= total_ticks THEN 'completed' ELSE 'building' END,
    completed_at_tick = CASE WHEN progress_ticks + 1 >= total_ticks THEN ? ELSE NULL END
WHERE game_id = ? AND status = 'building';

-- Create new ship after completion
INSERT INTO ships (game_id, faction_id, name, class, fuel_current, fuel_max, ...)
VALUES (?, ?, ?, ?, ...);

UPDATE production_queue_items
SET result_ship_id = last_insert_rowid()
WHERE id = ?;

-- Consume resources from faction treasury
UPDATE factions
SET treasury_metal = treasury_metal - ?,
    treasury_fuel = treasury_fuel - ?,
    treasury_gold = treasury_gold - ?,
    treasury_science = treasury_science - ?
WHERE id = ? AND game_id = ?;
```

---

## Diplomacy Tables

### `treaties`

**Purpose**: Formal agreements between factions.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique treaty ID |
| `game_id` | INTEGER FK | Parent game |
| `treaty_type` | TEXT | `'non_aggression_pact'`, `'defense_pact'`, `'trade_agreement'`, `'intel_sharing'`, `'demilitarization_zone'`, `'technology_sharing'`, `'mining_rights'` |
| `status` | TEXT | `'active'`, `'expired'`, `'broken'`, `'cancelled'`, `'proposed'` |
| `signatories_json` | TEXT | JSON array of faction IDs, e.g., `[1, 3, 5]` |
| **Timing** | | |
| `start_tick` | INTEGER | Tick treaty begins |
| `end_tick` | INTEGER | Tick it expires (null for indefinite) |
| `duration_ticks` | INTEGER | How many ticks it lasts |
| **Terms** | | |
| `terms_json` | TEXT | Treaty-specific terms (see schema) |
| **Breach** | | |
| `broken_at_tick` | INTEGER | If broken, which tick |
| `broken_by_faction_id` | INTEGER FK | Which faction broke it |
| `breach_reason` | TEXT | Why it was broken |
| **Metadata** | | |
| `created_at_tick` | INTEGER | Tick when treaty signed |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id` — Filter by game
- `status` — Find active vs. expired treaties
- `start_tick` — For "check treaty end times this tick" queries

**Terms JSON Schema** (examples):

Non-Aggression Pact:
```json
{
  "duration_ticks": 10,
  "canDeclareWar": false,
  "canAttackShips": false,
  "canSeizePlanets": false
}
```

Defense Pact:
```json
{
  "duration_ticks": 10,
  "mustDefendAlly": true,
  "provideMilitarySupport": true,
  "shareIntelligence": true
}
```

Trade Agreement:
```json
{
  "duration_ticks": 10,
  "tradeRoutes": [
    { "from_faction_id": 1, "from_body_id": 2, "to_body_id": 5, "resource": "metal", "quantity_per_tick": 50 }
  ],
  "tradeTax": 0.1
}
```

**Common Queries**:
```sql
-- Get all active treaties for a faction
SELECT * FROM treaties t
WHERE game_id = ? AND t.status = 'active'
  AND (t.signatories_json LIKE '%[1]%' OR t.signatories_json LIKE '%, 1,%' OR t.signatories_json LIKE '%1,%' OR t.signatories_json LIKE '%, 1]%');

-- Check for treaty expiration
SELECT * FROM treaties
WHERE game_id = ? AND status = 'active' AND end_tick <= ? AND end_tick IS NOT NULL;

-- Mark treaty as broken
UPDATE treaties
SET status = 'broken', broken_at_tick = ?, broken_by_faction_id = ?, breach_reason = ?
WHERE id = ? AND game_id = ?;

-- Track reputation loss from breaking treaty
INSERT INTO reputation_logs (game_id, faction_id, change_amount, reason, tick)
VALUES (?, ?, -50, 'Broke non-aggression pact', ?);
```

---

### `reputation_logs`

**Purpose**: Historical log of reputation changes for auditing and recovery.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique log entry |
| `game_id` | INTEGER FK | Parent game |
| `faction_id` | INTEGER FK | Faction whose reputation changed |
| `other_faction_id` | INTEGER FK | Other party (null for global reputation) |
| `change_amount` | INTEGER | Amount of change (positive or negative) |
| `reason` | TEXT | Why reputation changed |
| `tick` | INTEGER | Tick when it changed |
| `created_at` | TEXT | Timestamp |

**Indexes**:
- `game_id, faction_id` — Get reputation history for a faction
- `tick` — Find all reputation changes at a tick

**Common Queries**:
```sql
-- Get reputation history for a faction
SELECT * FROM reputation_logs
WHERE game_id = ? AND faction_id = ?
ORDER BY tick DESC;

-- Apply reputation decay
INSERT INTO reputation_logs (game_id, faction_id, change_amount, reason, tick)
SELECT id, id, -1, 'Natural decay', ?
FROM factions WHERE game_id = ? AND is_eliminated = 0;

-- Calculate current reputation (aggregate of log)
SELECT faction_id, SUM(change_amount) as current_reputation
FROM reputation_logs
WHERE game_id = ?
GROUP BY faction_id;
```

---

## Communication Tables

### `messages`

**Purpose**: Player communication (private, broadcast, treaty proposals, etc.).

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique message ID |
| `game_id` | INTEGER FK | Parent game |
| `from_faction_id` | INTEGER FK | Sender |
| `to_faction_id` | INTEGER FK | Recipient (null for broadcast) |
| `message_type` | TEXT | `'private'`, `'broadcast'`, `'formal_declaration'`, `'treaty_proposal'`, `'trade_offer'` |
| `subject` | TEXT | Message subject line |
| `body` | TEXT | Full message text |
| `read_by_json` | TEXT | JSON array of faction IDs who've read it |
| `is_archived` | INTEGER | Boolean (0/1) |
| `created_at_tick` | INTEGER | Tick when sent |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id` — Filter by game
- `from_faction_id, to_faction_id` — Get conversation between factions
- `created_at_tick` — For time-ordered message lists

**Common Queries**:
```sql
-- Get unread messages for a faction
SELECT * FROM messages
WHERE game_id = ? AND to_faction_id = ?
  AND (read_by_json IS NULL OR read_by_json NOT LIKE CONCAT('%[', ?, ']%'))
ORDER BY created_at_tick DESC;

-- Mark message as read
UPDATE messages
SET read_by_json = CASE
      WHEN read_by_json IS NULL THEN CONCAT('[', ?, ']')
      ELSE SUBSTR(read_by_json, 1, LENGTH(read_by_json)-1) || ', ' || ? || ']'
    END
WHERE id = ?;

-- Get broadcast history
SELECT * FROM messages
WHERE game_id = ? AND message_type = 'broadcast'
ORDER BY created_at_tick DESC;
```

---

## Senate & Voting Tables

### `senate_proposals`

**Purpose**: Community proposals voted on by all factions.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique proposal ID |
| `game_id` | INTEGER FK | Parent game |
| `submitted_by_faction_id` | INTEGER FK | Who submitted it (null for system) |
| `proposal_type` | TEXT | Category for voting mechanics |
| `title` | TEXT | Display title |
| `description` | TEXT | Full proposal text |
| **Voting** | | |
| `voting_start_tick` | INTEGER | When voting begins |
| `voting_end_tick` | INTEGER | When voting closes |
| `status` | TEXT | `'pending'`, `'voting'`, `'passed'`, `'failed'`, `'cancelled'` |
| `votes_for` | INTEGER | Count of 'for' votes |
| `votes_against` | INTEGER | Count of 'against' votes |
| **Terms & Result** | | |
| `terms_json` | TEXT | Proposal-specific details (see schema) |
| `result` | TEXT | `'passed'` or `'failed'` after voting ends |
| `result_details_json` | TEXT | Outcome details |
| **Metadata** | | |
| `created_at_tick` | INTEGER | Tick created |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Indexes**:
- `game_id` — Filter by game
- `status` — Find active vs. completed proposals
- `voting_start_tick, voting_end_tick` — Find proposals voting this tick

**Terms JSON Schema** (examples):

Trade Embargo:
```json
{
  "target_faction_id": 2,
  "duration_ticks": 10,
  "tradeHidden": true,
  "shipsNotAllowed": true
}
```

Military Alliance:
```json
{
  "allied_faction_ids": [1, 3, 4],
  "duration_ticks": 15,
  "shareIntelligence": true,
  "coordinateAttacks": true
}
```

**Common Queries**:
```sql
-- Get proposals in voting phase this tick
SELECT * FROM senate_proposals
WHERE game_id = ? AND status = 'voting' AND voting_end_tick <= ?;

-- Finalize voting results
UPDATE senate_proposals
SET status = CASE WHEN votes_for > votes_against THEN 'passed' ELSE 'failed' END,
    result = CASE WHEN votes_for > votes_against THEN 'passed' ELSE 'failed' END
WHERE game_id = ? AND voting_end_tick <= ? AND status = 'voting';

-- Get votes for a proposal
SELECT faction_id, vote FROM senate_votes WHERE proposal_id = ?;
```

---

### `senate_votes`

**Purpose**: Individual faction votes on proposals.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique vote record |
| `game_id` | INTEGER FK | Parent game |
| `proposal_id` | INTEGER FK | Proposal being voted on |
| `faction_id` | INTEGER FK | Faction voting |
| `vote` | TEXT | `'for'`, `'against'`, `'abstain'` |
| `voted_at_tick` | INTEGER | Tick when vote was cast |
| `created_at` | TEXT | Timestamp |

**Constraints**:
- `UNIQUE(proposal_id, faction_id)` — One vote per faction per proposal

**Indexes**:
- `proposal_id` — Get all votes for a proposal
- `game_id, faction_id` — Get votes cast by a faction

**Common Queries**:
```sql
-- Record a vote
INSERT INTO senate_votes (game_id, proposal_id, faction_id, vote, voted_at_tick, created_at)
VALUES (?, ?, ?, ?, ?, ?);

-- Count votes for a proposal
SELECT
  SUM(CASE WHEN vote = 'for' THEN 1 ELSE 0 END) as for_count,
  SUM(CASE WHEN vote = 'against' THEN 1 ELSE 0 END) as against_count,
  SUM(CASE WHEN vote = 'abstain' THEN 1 ELSE 0 END) as abstain_count
FROM senate_votes
WHERE proposal_id = ?;

-- Check if faction already voted
SELECT * FROM senate_votes WHERE proposal_id = ? AND faction_id = ?;
```

---

## Tech & Research Tables

### `tech_research`

**Purpose**: Tracks technology tree progression for each faction.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique research record |
| `game_id` | INTEGER FK | Parent game |
| `faction_id` | INTEGER FK | Faction researching |
| `tech_id` | TEXT | Technology identifier (e.g., "advanced_propulsion") |
| `status` | TEXT | `'locked'`, `'available'`, `'researching'`, `'completed'` |
| `progress_ticks` | INTEGER | Ticks spent researching |
| `total_ticks` | INTEGER | Total ticks needed |
| `completed_at_tick` | INTEGER | When research finished |
| `priority` | INTEGER | Position in research queue |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Constraints**:
- `UNIQUE(game_id, faction_id, tech_id)` — One row per tech per faction

**Indexes**:
- `game_id, faction_id` — Get all techs for a faction
- `status` — Find locked vs. completed techs

**Common Queries**:
```sql
-- Get all completed techs for a faction
SELECT * FROM tech_research
WHERE game_id = ? AND faction_id = ? AND status = 'completed';

-- Get current research target
SELECT * FROM tech_research
WHERE game_id = ? AND faction_id = ? AND status = 'researching'
ORDER BY priority ASC
LIMIT 1;

-- Complete research
UPDATE tech_research
SET status = 'completed', completed_at_tick = ?
WHERE game_id = ? AND faction_id = ? AND tech_id = ? AND status = 'researching';

-- Unlock dependent techs
UPDATE tech_research
SET status = 'available'
WHERE game_id = ? AND faction_id = ? AND tech_id IN (
  -- List of techs dependent on just-completed tech
);
```

---

## Event & Logging Tables

### `chronicle_entries`

**Purpose**: Human-readable game history that players see in a timeline.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique entry ID |
| `game_id` | INTEGER FK | Parent game |
| `tick` | INTEGER | When the event occurred |
| `entry_type` | TEXT | Category for filtering (battle, treaty, discovery, etc.) |
| `headline` | TEXT | Short summary (shown in timeline) |
| `description` | TEXT | Longer explanation |
| `primary_faction_id` | INTEGER FK | Main actor (null if system event) |
| `secondary_faction_id` | INTEGER FK | Secondary actor (opponent, ally, etc.) |
| `event_data_json` | TEXT | Structured data for UI rendering |
| `created_at` | TEXT | Timestamp |

**Indexes**:
- `game_id, tick` — Get all events at a tick
- `entry_type` — Filter by event type

**Event Data JSON Schema** (examples):

Battle:
```json
{
  "attacking_faction_id": 1,
  "defending_faction_id": 2,
  "location_body_id": 5,
  "ships_destroyed": 3,
  "casualties": 150,
  "victor": "faction_1"
}
```

Production Completed:
```json
{
  "production_type": "ship",
  "ship_name": "HMS Victory",
  "ship_class": "capital",
  "location_body_id": 2
}
```

**Common Queries**:
```sql
-- Get game timeline for display
SELECT * FROM chronicle_entries
WHERE game_id = ?
ORDER BY tick DESC
LIMIT 50;

-- Get events for a specific faction
SELECT * FROM chronicle_entries
WHERE game_id = ? AND (primary_faction_id = ? OR secondary_faction_id = ?)
ORDER BY tick DESC;

-- Get events at a specific tick
SELECT * FROM chronicle_entries
WHERE game_id = ? AND tick = ?;
```

---

### `game_logs`

**Purpose**: Detailed debugging and audit logs for backend execution.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique log entry |
| `game_id` | INTEGER FK | Parent game |
| `tick` | INTEGER | Tick during which this occurred |
| `log_type` | TEXT | Category (e.g., "maneuver_execution", "production", "treaty_check") |
| `severity` | TEXT | `'debug'`, `'info'`, `'warning'`, `'error'` |
| `message` | TEXT | Human-readable log message |
| `log_data_json` | TEXT | Structured data for debugging |
| `created_at` | TEXT | Timestamp |

**Indexes**:
- `game_id, tick` — Get all logs for a game at a tick
- `severity` — Find errors/warnings

**Common Queries**:
```sql
-- Get all errors during a tick
SELECT * FROM game_logs
WHERE game_id = ? AND tick = ? AND severity = 'error'
ORDER BY created_at DESC;

-- Debug a specific maneuver
SELECT * FROM game_logs
WHERE game_id = ? AND log_type = 'maneuver_execution' AND log_data_json LIKE '%"ship_id": 42%';
```

---

## Execution State Tables

### `tick_execution_state`

**Purpose**: Tracks progress and status of daily tick execution (one row per game).

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique state record |
| `game_id` | INTEGER FK | Parent game (UNIQUE) |
| `current_tick` | INTEGER | Most recently completed tick |
| `execution_status` | TEXT | `'idle'`, `'executing'`, `'completed'`, `'failed'` |
| `last_execution_start` | TEXT | ISO 8601 when last tick started |
| `last_execution_end` | TEXT | ISO 8601 when last tick ended |
| `last_error_message` | TEXT | Error details if failed |
| `production_updates_applied` | INTEGER | How many production items processed |
| `maneuver_updates_applied` | INTEGER | How many maneuvers executed |
| `resource_updates_applied` | INTEGER | How many resource transfers processed |
| `treaty_checks_applied` | INTEGER | How many treaties checked |
| `updated_at` | TEXT | Last update timestamp |

**Purpose**: Allow tick executor to resume if interrupted, and provide real-time progress updates.

**Common Queries**:
```sql
-- Start a tick
UPDATE tick_execution_state
SET execution_status = 'executing', last_execution_start = ?
WHERE game_id = ?;

-- Record progress
UPDATE tick_execution_state
SET production_updates_applied = production_updates_applied + ?
WHERE game_id = ?;

-- Complete a tick
UPDATE tick_execution_state
SET execution_status = 'completed', last_execution_end = ?, current_tick = current_tick + 1
WHERE game_id = ?;

-- Check if execution is safe to retry (in case of crash)
SELECT * FROM tick_execution_state
WHERE game_id = ? AND execution_status IN ('idle', 'failed');
```

---

## Settings & Configuration Tables

### `game_settings`

**Purpose**: Game-specific configuration (difficulty, house rules, etc.).

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Unique settings record |
| `game_id` | INTEGER FK | Parent game (UNIQUE) |
| `difficulty` | TEXT | `'easy'`, `'normal'`, `'hard'` |
| `victory_condition` | TEXT | Win condition type |
| `max_player_count` | INTEGER | Max factions allowed |
| `allow_treaties` | INTEGER | Boolean (0/1) |
| `allow_piracy` | INTEGER | Boolean (0/1) |
| `allow_trading` | INTEGER | Boolean (0/1) |
| `fog_of_war_enabled` | INTEGER | Boolean (0/1) |
| `custom_rules_json` | TEXT | House rules (see schema) |
| `created_at`, `updated_at` | TEXT | Timestamps |

**Custom Rules JSON Schema**:
```json
{
  "resourceDecayPerTick": 0.01,
  "maxTreatyDuration": 15,
  "reputationDecay": -1,
  "productionSpeedMultiplier": 1.0,
  "orbitalPrecision": "realistic"
}
```

---

## Views (Pre-computed Queries)

These views simplify common queries and provide real-time aggregation:

### `faction_resources`
Shows current resource counts for each faction.

```sql
SELECT faction_id, game_id, treasury_metal, treasury_fuel, treasury_gold, treasury_science
FROM faction_resources WHERE game_id = ?;
```

### `body_production_status`
Shows production rates and storage for each body.

```sql
SELECT * FROM body_production_status WHERE owned_by_faction_id = ?;
```

### `fleet_status`
Shows each ship's state and pending maneuvers.

```sql
SELECT * FROM fleet_status WHERE faction_id = ? AND game_id = ?;
```

### `active_treaties`
Shows all in-force treaties.

```sql
SELECT * FROM active_treaties WHERE game_id = ?;
```

### `pending_senate_proposals`
Shows proposals currently in voting or pending.

```sql
SELECT * FROM pending_senate_proposals WHERE game_id = ?;
```

---

## Performance Considerations

### Tick Execution Pipeline

For efficient daily tick execution:

1. **Begin transaction**: `BEGIN TRANSACTION`
2. **Lock game state**: `SELECT * FROM tick_execution_state WHERE game_id = ? FOR UPDATE`
3. **Production phase**: Update `production_queue_items`, modify `bodies` storage, modify `factions` treasury
4. **Maneuver phase**: Execute `maneuver_orders`, update `ships` orbits, consume fuel
5. **Resource phase**: Apply `treaties` trade effects, decay `reputation`
6. **Maintenance phase**: Expire `treaties`, spawn `maneuver_orders` for standing orders
7. **Chronicle phase**: Insert `chronicle_entries` for significant events
8. **Update state**: `UPDATE tick_execution_state`, `UPDATE games` set `current_tick`
9. **Commit**: `COMMIT TRANSACTION`

**Estimated duration**: ~100-200ms per tick (50-100 factions, ~1000 production items per game)

### Real-time Sync

Frontend subscribes to changes via:
- Polling: `SELECT updated_at FROM [table] WHERE game_id = ? AND updated_at > ?`
- Webhooks: Tick executor publishes events after commit
- WebSocket: Game server broadcasts changes to connected clients

Update `updated_at` on every modification to ensure changesets are correctly identified.

### Archival & Export

Completed games are archived by:
```sql
-- Export to backup
CREATE TABLE games_archived AS SELECT * FROM games WHERE status = 'completed';

-- Delete references
DELETE FROM [all tables] WHERE game_id IN (
  SELECT id FROM games_archived
);
```

---

## JSON Schema Summary

| Field | Schema | Used In |
|-------|--------|---------|
| `current_orbit_json` | OrbitElements | `ships` |
| `post_maneuver_orbit_json` | OrbitElements | `maneuver_orders` |
| `cargo_json` | Cargo | `ships` |
| `infrastructure_json` | Infrastructure | `bodies` |
| `condition_json` | Condition | `standing_orders` |
| `action_json` | Action | `standing_orders` |
| `terms_json` | Terms (treaty-specific) | `treaties` |
| `event_data_json` | EventData (varies by type) | `chronicle_entries` |
| `result_details_json` | ProposalResult | `senate_proposals` |
| `custom_rules_json` | CustomRules | `game_settings` |
| `signatories_json` | Array<FactionID> | `treaties` |
| `read_by_json` | Array<FactionID> | `messages` |

---

## Data Integrity Constraints

- **Orphaned records**: Foreign keys ensure no references to deleted games/factions/bodies
- **Tick consistency**: All updates in a tick happen in a single transaction
- **Resource conservation**: Total resources tracked at faction level; production/consumption must balance
- **Ship state**: Each ship has a valid orbit; orbits must reference a parent body
- **Treaty validity**: All signatories must be active factions at signing time

---

## Example: Complete Tick Execution SQL

```sql
BEGIN TRANSACTION;

-- Lock game for exclusive access
SELECT * FROM tick_execution_state WHERE game_id = 5 FOR UPDATE;

-- Phase 1: Production
UPDATE bodies SET stored_metal = MIN(stored_metal + produces_metal_per_tick, storage_capacity_metal)
WHERE game_id = 5 AND last_production_tick < (SELECT current_tick FROM games WHERE id = 5);

UPDATE production_queue_items
SET progress_ticks = progress_ticks + 1,
    status = CASE WHEN progress_ticks + 1 >= total_ticks THEN 'completed' ELSE 'building' END
WHERE game_id = 5 AND status = 'building';

-- Phase 2: Maneuvers
UPDATE maneuver_orders SET status = 'executing'
WHERE game_id = 5 AND status = 'committed' AND planned_burn_tick <= (SELECT current_tick FROM games WHERE id = 5);

-- Phase 3: Treaties
UPDATE treaties SET status = 'expired'
WHERE game_id = 5 AND status = 'active' AND end_tick <= (SELECT current_tick FROM games WHERE id = 5);

-- Phase 4: Update game state
UPDATE games SET current_tick = current_tick + 1, updated_at = datetime('now') WHERE id = 5;
UPDATE tick_execution_state SET execution_status = 'completed', current_tick = (SELECT current_tick FROM games WHERE id = 5), updated_at = datetime('now') WHERE game_id = 5;

COMMIT;
```

---

## Migration Path

To add new features:

1. Add columns to existing tables (nullable initially)
2. Create new tables with references to games
3. Update views to include new data
4. Backfill historical data if needed
5. Add indexes for new query patterns

All changes should maintain backward compatibility with running games.
