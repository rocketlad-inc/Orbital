# Game Engine Documentation

## Overview

The game engine is the heartbeat of Orbital, executing one complete game tick atomically and persistently. It orchestrates orbital mechanics, resource production, technology research, and standing order evaluation within a single database transaction.

**Key principle:** All mutations happen in ONE transaction per tick. If any step fails, the entire tick rolls back.

## Architecture

### Core Components

```
GameEngine
├── Database (interface for atomic transactions)
├── OrbitalPhysics (orbital mechanics calculations)
└── GameState (in-memory representation of game world)
```

### Tick Execution Pipeline

Each tick follows this order of operations:

1. **Load State** — Query all relevant tables into `GameState`
2. **Execute Maneuvers** — Ships with orders due this tick
3. **Check SOI Transitions** — Detect ships entering/exiting spheres of influence
4. **Evaluate Standing Orders** — Conditional automation rules
5. **Resolve Combat** (delegated to combat system when ready)
6. **Accumulate Production** — Generate resources for owned bodies
7. **Advance Tech Research** — Tick research progress
8. **Advance Production Queue** — Tick ship/facility construction
9. **Check Treaty Violations** (delegated to combat system)
10. **Decay Reputation** — Slow recovery of faction standing
11. **Generate Chronicle** — Log all events
12. **Persist State** — One atomic transaction

## Data Model

### In-Memory Structures

#### `GameState`
The in-memory representation of the entire game world for a single tick.

```python
@dataclass
class GameState:
    gameId: str
    currentTick: int
    ships: Dict[str, Ship]
    bodies: Dict[str, Body]
    factions: Dict[str, Dict[str, Any]]
    resources: Dict[str, ResourceInventory]
    maneuverOrders: List[ManeuverOrder]
    standingOrders: List[StandingOrder]
    techResearch: List[TechResearch]
    productionQueue: List[ProductionQueueItem]
    chronicle: List[ChronicleEntry]
```

#### `OrbitElement`
Flexible JSON-based orbital element representation. Stored as JSON in `ships.currentOrbit_json`.

```python
@dataclass
class OrbitElement:
    rp: float               # Periapsis distance (km)
    ra: float               # Apoapsis distance (km)
    omega: float            # Argument of periapsis (radians)
    M0: float               # Mean anomaly at epoch (radians)
    epoch: float            # Reference time for orbital state (ticks)
    direction: str          # "prograde" or "retrograde"
    period: float           # Orbital period (ticks)
    parentBodyId: str       # ID of the body being orbited
```

This structure allows rich orbital mechanics without schema migration.

#### `Ship`
Fleet units with position (orbit), fuel, and ownership.

```python
@dataclass
class Ship:
    id: str
    gameId: str
    ownedBy: str            # Faction ID
    name: str
    shipClass: str          # "explorer", "transport", "warship", etc.
    fuel: float
    maxFuel: float
    currentOrbit: OrbitElement
    currentTick: int
```

#### `Body`
Celestial bodies (planets, moons, stations) with production and ownership.

```python
@dataclass
class Body:
    id: str
    gameId: str
    name: str
    bodyType: str           # "planet", "moon", "station"
    orbitRadius: float
    orbitPeriod: float
    soi: float              # Sphere of influence (km)
    ownedBy: Optional[str]
    developmentLevel: int
    resources_per_tick: Dict[str, float]
    storedResources: Dict[str, float]
    parent: Optional[str]
```

#### `ManeuverOrder`
Queued fleet movements with planned execution time.

```python
@dataclass
class ManeuverOrder:
    id: str
    gameId: str
    shipId: str
    orderType: str          # "transfer", "intercept", "dock", etc.
    status: ManeuverStatus
    plannedBurnTime: int    # Tick at which burn executes
    deltaV: float
    postOrbit: Optional[OrbitElement]
```

#### `StandingOrder`
Conditional automation rules with JSON-based conditions and actions.

```python
@dataclass
class StandingOrder:
    id: str
    gameId: str
    factionId: str
    condition: Dict[str, Any]       # JSON condition
    action: Dict[str, Any]          # JSON action
    enabled: bool
    lastExecutedTick: Optional[int]
```

Example condition:
```json
{
  "type": "ship_location",
  "bodyId": "mars",
  "threshold": "entering"
}
```

Example action:
```json
{
  "type": "launch_fleet",
  "fromBody": "earth",
  "shipCount": 5
}
```

#### `ResourceInventory`
Faction resource holdings (metal, fuel, gold, science).

```python
@dataclass
class ResourceInventory:
    id: str
    gameId: str
    factionId: str
    metal: float
    fuel: float
    gold: float
    science: float
```

#### `TechResearch`
Technology progression tracked per faction.

```python
@dataclass
class TechResearch:
    id: str
    gameId: str
    factionId: str
    techId: str
    status: TechStatus              # "queued", "in_progress", "completed"
    progress_ticks: int
    totalTicks: int
    completedAtTick: Optional[int]
```

#### `ChronicleEntry`
Historical log of game events for replay and visualization.

```python
@dataclass
class ChronicleEntry:
    gameId: str
    tick: int
    eventType: ChronicleEventType
    data: Dict[str, Any]           # Event-specific data (JSON)
    displayText: str                # Human-readable message
```

## Major Operations

### 1. Execute Maneuvers

Processes all `ManeuverOrder` rows where `plannedBurnTime == currentTick` and `status == 'committed'`.

For each maneuver:
1. Look up the associated ship
2. Use physics engine to compute post-burn orbit
3. Check fuel availability
4. Update ship.currentOrbit and ship.fuel
5. Mark order as executed
6. Log to chronicle

**Fuel Consumption:** Estimated via Tsiolkovsky rocket equation or custom physics model.

**Error Handling:** If fuel is insufficient, mark order as FAILED and skip.

### 2. Check SOI Transitions

Detects when ships enter/exit sphere of influence of bodies.

For each ship:
1. Compute current world position from `currentOrbit` + elapsed time
2. Calculate distance to each body center
3. If distance < body.soi and currently outside: SOI entry
4. If distance > body.soi and currently inside: SOI exit

**Actions on entry:**
- If body is unclaimed → create claim record
- If body is owned by rival → log combat situation
- Update `currentOrbit.parentBodyId` to new body

**Chronicle events:** `SOI_ENTERED`, `SOI_EXITED`, `BODY_CLAIMED`, `COMBAT_ENGAGED`

### 3. Evaluate Standing Orders

Checks all `StandingOrder` rows with `enabled = TRUE`.

For each order:
1. Parse `condition_json` (JSON object with `type`, parameters)
2. Evaluate against current game state
3. If condition matches:
   - Execute `action_json` (launch fleet, set research target, etc.)
   - Update `lastExecutedTick`
   - Log to chronicle

**Condition Types:**
- `ship_location`: Check if ship is at/entering/leaving a body
- `resource`: Check if faction has X units of resource Y
- `reputation`: Check if faction's reputation is above/below threshold
- `tech_complete`: Check if faction completed a specific tech

**Action Types:**
- `launch_fleet`: Create new ships from a body
- `set_research`: Change technology research target
- `build_facility`: Start construction at a body
- `adjust_production`: Reallocate resources

### 4. Accumulate Production

Generates resources for all `bodies` where `ownedBy` is not NULL.

For each body:
1. Get base production rate from `body.resources_per_tick_{metal,fuel,gold,science}`
2. Apply development modifier: `1.0 + (developmentLevel * 0.1)`
3. Apply tech bonuses from completed tech research
4. Add to faction's `resources` row
5. Add to body's `storedResources`

**Example:**
- Base: 10 metal/tick
- Dev level 2: 10 * 1.2 = 12 metal/tick
- With tech bonus +20%: 12 * 1.2 = 14.4 metal/tick

### 5. Advance Tech Research

Increments `progress_ticks` for all `TechResearch` rows where `status IN ('queued', 'in_progress')`.

When `progress_ticks >= totalTicks`:
1. Set `status = 'completed'`
2. Set `completedAtTick = currentTick`
3. Apply tech bonuses (stored elsewhere, e.g., as a lookup table)
4. Log to chronicle

### 6. Advance Production Queue

Increments `progress_ticks` for all `ProductionQueueItem` rows.

When `progress_ticks >= totalTicks`:
1. Create ship or facility in game state
2. Deduct resources from faction inventory
3. Remove item from queue
4. Log to chronicle

### 7. Decay Reputation

Slowly recovers faction reputation over time.

Simple model: +1 reputation per 10 ticks for honest behavior.

**Future expansion:**
- Broken treaties: -X reputation
- Military victory: +X reputation
- Dishonored agreement: slow recovery

### 8. Persist State

Atomic database transaction that commits all mutations:

```sql
BEGIN TRANSACTION;

-- Update ships
UPDATE ships SET fuel=?, currentOrbit_json=? WHERE id=?;

-- Update bodies
UPDATE bodies SET ownedBy=?, stored_metal=? WHERE id=?;

-- Update resources
UPDATE resources SET metal=?, fuel=? WHERE factionId=?;

-- Update maneuver orders
UPDATE maneuver_orders SET status=?, postOrbit_json=? WHERE id=?;

-- Update tech research
UPDATE tech_research SET status=?, progress_ticks=? WHERE id=?;

-- Update tick execution state
UPDATE tick_execution_state SET lastCompletedTick=? WHERE gameId=?;

-- Insert chronicle entries
INSERT INTO chronicle_entries (...) VALUES (...);

COMMIT;
```

**Atomicity:** If any INSERT/UPDATE fails, the entire transaction rolls back. No partial state.

**Resumability:** The `tick_execution_state` table tracks progress, allowing recovery from crash mid-tick.

## Database Interface

The `Database` abstract class provides methods:

```python
class Database:
    def begin_transaction(self) -> None:
        """Start atomic transaction."""
    
    def commit(self) -> None:
        """Commit transaction."""
    
    def rollback(self) -> None:
        """Rollback transaction."""
    
    def query(self, sql: str, params: List[Any]) -> List[Dict[str, Any]]:
        """Execute SELECT."""
    
    def execute(self, sql: str, params: List[Any]) -> None:
        """Execute INSERT/UPDATE/DELETE."""
    
    def execute_many(self, sql: str, param_list: List[List[Any]]) -> None:
        """Execute multiple statements."""
```

**Implementations:**
- `PostgreSQL`: Use psycopg3 with transaction support
- `SQLite`: Use sqlite3 with WAL mode for concurrency
- `MockDatabase`: In-memory for testing

## Orbital Physics

The `OrbitalPhysics` class encapsulates orbital mechanics:

```python
class OrbitalPhysics:
    @staticmethod
    def computePostBurnOrbit(
        preOrbit: OrbitElement,
        deltaV: float,
        burnTime: int
    ) -> OrbitElement:
        """Compute orbit after delta-v impulse."""
    
    @staticmethod
    def fuelRequired(
        preOrbit: OrbitElement,
        postOrbit: OrbitElement
    ) -> float:
        """Estimate fuel consumption."""
```

**Current Implementation:** Stub (simplified calculation).

**Future Implementation:** Full vis-viva equation and Kepler's equations.

## Error Handling

The engine is defensive:

- **Maneuver Execution:** If fuel check fails, mark as FAILED, continue tick
- **Standing Orders:** If condition evaluation fails, log error, skip action, continue tick
- **Production Accumulation:** If resources table is missing, log warning, continue tick
- **Tick Execution:** If any step throws uncaught exception, rollback entire tick

**Chronicle Logging:** Errors are logged to chronicle for debugging and player feedback.

## Testing

The test suite (`test_game_engine.py`) includes:

### Unit Tests
- Data class serialization/deserialization
- Maneuver execution with fuel tracking
- Standing order evaluation
- Production accumulation with modifiers
- Tech research progression
- Production queue completion

### Integration Tests
- Full tick execution on empty game
- Full tick execution with maneuvers and production
- Transaction commit on success
- Transaction rollback on error

### Edge Cases
- Insufficient fuel for maneuver
- Missing ship in maneuver order
- Unowned body (no production)
- Invalid standing order condition

## Usage

### Basic Tick Execution

```python
from game_engine import GameEngine, Database

db = Database()  # Concrete implementation
engine = GameEngine(db)

result = engine.execute_tick(game_id="game_1", tick=100)

if result.success:
    print(f"Tick {result.tick} completed in {result.executionTime:.3f}s")
    print(f"Logged {result.eventsLogged} events")
else:
    print(f"Tick failed: {result.errors}")
```

### Main Game Loop

```python
game = load_game("game_1")

for tick in range(game.currentTick, game.maxTicks):
    result = engine.execute_tick(game.id, tick)
    
    if not result.success:
        log_error(f"Tick {tick} failed, stopping game")
        break
    
    # Broadcast chronicle events to connected players
    broadcast_chronicle(result.chronicle)
    
    game.currentTick = tick + 1
```

### Custom Physics Engine

```python
class CustomPhysics(OrbitalPhysics):
    @staticmethod
    def computePostBurnOrbit(preOrbit, deltaV, burnTime):
        # Custom implementation using full astrodynamics
        ...

engine = GameEngine(db, physics_engine=CustomPhysics())
```

## Performance Considerations

### Database Queries
- Ships, bodies, resources are indexed by `gameId`
- Maneuver orders are indexed by `(gameId, plannedBurnTime, status)`
- Expect O(log n) lookup per query

### In-Memory State
- Entire game state loaded at tick start (could be large)
- For 1000 bodies + 10000 ships: ~10MB in memory
- Consider streaming for very large games

### Transaction Size
- Each tick inserts N chronicle entries
- For a large game: ~100-1000 rows per tick
- Batch inserts for performance

### Tick Duration
- Current stub implementation: <100ms
- With full physics: <500ms expected
- With combat resolution: <1s possible

## Future Enhancements

1. **Resumability:** Use `tick_execution_state` to resume partial ticks
2. **Batching:** Execute multiple ticks in one transaction for setup phase
3. **Streaming:** Load/save game state in chunks for large games
4. **Parallelism:** Execute independent maneuvers in parallel (careful with ordering!)
5. **Combat:** Integrate with combat resolution system
6. **Diplomacy:** Implement treaty violation checks
7. **History:** Query chronicle for trend analysis and replay

## Debugging

### Enable Logging

```python
import logging

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("game_engine")
```

### Inspect Game State

```python
state = engine._load_game_state("game_1", 100)
print(f"Ships: {len(state.ships)}")
print(f"Maneuvers due: {len(state.maneuverOrders)}")
for ship in state.ships.values():
    print(f"  {ship.name}: fuel={ship.fuel:.1f}, orbit_parent={ship.currentOrbit.parentBodyId}")
```

### Replay Tick

```python
# Load chronicle from previous tick
entries = db.query("SELECT * FROM chronicle_entries WHERE gameId=? AND tick=?", [game_id, tick])
for entry in entries:
    print(f"[{entry['type']}] {entry['displayText']}")
```

## Schema Requirements

The engine assumes the following database tables exist:

```sql
CREATE TABLE games (
    id TEXT PRIMARY KEY,
    name TEXT,
    startTime DATETIME,
    currentTick INT,
    status TEXT,
    maxTicks INT
);

CREATE TABLE ships (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    ownedBy TEXT,
    name TEXT,
    class TEXT,
    fuel REAL,
    maxFuel REAL,
    currentOrbit_json TEXT,
    currentTick INT
);

CREATE TABLE bodies (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    name TEXT,
    type TEXT,
    orbitRadius REAL,
    orbitPeriod REAL,
    soi REAL,
    ownedBy TEXT,
    developmentLevel INT,
    resources_per_tick_metal REAL,
    resources_per_tick_fuel REAL,
    resources_per_tick_gold REAL,
    resources_per_tick_science REAL,
    stored_metal REAL,
    stored_fuel REAL,
    stored_gold REAL,
    stored_science REAL,
    parent TEXT
);

CREATE TABLE maneuver_orders (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    shipId TEXT,
    type TEXT,
    status TEXT,
    plannedBurnTime INT,
    deltav REAL,
    postOrbit_json TEXT
);

CREATE TABLE standing_orders (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    factionId TEXT,
    condition_json TEXT,
    action_json TEXT,
    enabled BOOLEAN,
    lastExecutedTick INT
);

CREATE TABLE tech_research (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    factionId TEXT,
    techId TEXT,
    status TEXT,
    progress_ticks INT,
    totalTicks INT,
    completedAtTick INT
);

CREATE TABLE production_queue (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    factionId TEXT,
    type TEXT,
    targetId TEXT,
    progress_ticks INT,
    totalTicks INT
);

CREATE TABLE resources (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    factionId TEXT,
    metal REAL,
    fuel REAL,
    gold REAL,
    science REAL
);

CREATE TABLE chronicle_entries (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    tick INT,
    type TEXT,
    data_json TEXT,
    displayText TEXT
);

CREATE TABLE tick_execution_state (
    id TEXT PRIMARY KEY,
    gameId TEXT,
    currentTick INT,
    lastCompletedTick INT,
    executionStatus TEXT
);
```

## Conclusion

The game engine is designed as a clean, testable, atomic tick executor with clear separation of concerns. Each operation is idempotent and logged to chronicle for replay and debugging. The JSON-based fields (orbits, conditions, actions) provide flexibility without constant schema migrations.
