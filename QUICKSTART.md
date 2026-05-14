# Game Engine Quick Start

## Installation

```bash
# Install required dependencies
pip install pytest  # For testing
```

## Basic Usage

### 1. Initialize Database

```python
from database_adapters import DatabaseFactory, init_schema

# Create database
config = {
    "type": "sqlite",
    "path": "orbital.db"
}
db = DatabaseFactory.create(config)

# Initialize schema
init_schema(db)
```

### 2. Create a Game

```python
import uuid

game_id = str(uuid.uuid4())

db.execute(
    "INSERT INTO games (id, name, currentTick, maxTicks, status) VALUES (?, ?, ?, ?, ?)",
    [game_id, "My Game", 0, 10000, "active"]
)

# Create tick execution state
db.execute(
    "INSERT INTO tick_execution_state (id, gameId, currentTick, lastCompletedTick, executionStatus) "
    "VALUES (?, ?, ?, ?, ?)",
    [str(uuid.uuid4()), game_id, 0, -1, "idle"]
)
```

### 3. Run Ticks

```python
from game_engine import GameEngine

engine = GameEngine(db)

# Execute one tick
result = engine.execute_tick(game_id, tick=0)

if result.success:
    print(f"Tick 0 complete: {result.eventsLogged} events logged")
    for event in result.chronicle:
        print(f"  [{event.eventType.value}] {event.displayText}")
else:
    print(f"Tick failed: {result.errors}")

# Execute multiple ticks
for tick in range(1, 100):
    result = engine.execute_tick(game_id, tick)
    if not result.success:
        print(f"Tick {tick} failed, stopping")
        break
    print(f"Tick {tick}: {result.eventsLogged} events")
```

## Key Classes

### GameEngine

Main engine class that executes ticks.

```python
engine = GameEngine(db)
result = engine.execute_tick(game_id, tick)
```

### GameState

In-memory representation of game world.

```python
state = engine._load_game_state(game_id, tick)
print(f"Ships: {len(state.ships)}")
print(f"Bodies: {len(state.bodies)}")
```

### Database

Abstract interface for database operations. Implement for your database.

```python
db.begin_transaction()
try:
    db.execute("UPDATE ships SET fuel = ? WHERE id = ?", [100, "ship_1"])
    db.commit()
except Exception as e:
    db.rollback()
```

## Schema Overview

```sql
-- Core tables
games                  -- Game instances
factions              -- Players
bodies                -- Celestial bodies
ships                 -- Fleet units

-- Orders and actions
maneuver_orders       -- Queued fleet movements
standing_orders       -- Conditional automation

-- Economy and research
resources             -- Faction inventories
tech_research         -- Technology progression
production_queue      -- Ship/facility construction

-- History and state
chronicle_entries     -- Historical log
tick_execution_state  -- Tick progress tracking
```

## Data Formats

### Orbits (stored as JSON)

```json
{
  "rp": 6378.0,
  "ra": 6378.0,
  "omega": 0.0,
  "M0": 0.0,
  "epoch": 0,
  "direction": "prograde",
  "period": 90.0,
  "parentBodyId": "earth"
}
```

### Standing Order Conditions

```json
{
  "type": "ship_location",
  "bodyId": "mars",
  "threshold": "entering"
}
```

### Standing Order Actions

```json
{
  "type": "launch_fleet",
  "fromBody": "earth",
  "shipCount": 5
}
```

## Common Tasks

### Add a Ship

```python
from game_engine import Ship, OrbitElement

orbit = OrbitElement(
    rp=6378.0, ra=6378.0, omega=0, M0=0, epoch=0,
    direction="prograde", period=90, parentBodyId="earth"
)

db.execute(
    "INSERT INTO ships (id, gameId, ownedBy, name, class, fuel, maxFuel, currentOrbit_json, currentTick) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["ship_1", game_id, "faction_1", "Explorer", "explorer", 1000, 1000, json.dumps(orbit.to_dict()), 0]
)
```

### Queue a Maneuver

```python
import uuid

order_id = str(uuid.uuid4())
db.execute(
    "INSERT INTO maneuver_orders (id, gameId, shipId, type, status, plannedBurnTime, deltav) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [order_id, game_id, "ship_1", "transfer", "committed", 100, 500.0]
)
```

### Start Research

```python
tech_id = str(uuid.uuid4())
db.execute(
    "INSERT INTO tech_research (id, gameId, factionId, techId, status, progress_ticks, totalTicks) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [tech_id, game_id, "faction_1", "propulsion_v2", "in_progress", 0, 50]
)
```

### Queue Production

```python
item_id = str(uuid.uuid4())
db.execute(
    "INSERT INTO production_queue (id, gameId, factionId, type, targetId, progress_ticks, totalTicks) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    [item_id, game_id, "faction_1", "ship", "explorer_design", 0, 100]
)
```

### Query Chronicle

```python
entries = db.query(
    "SELECT * FROM chronicle_entries WHERE gameId = ? AND tick = ? ORDER BY type",
    [game_id, 0]
)

for entry in entries:
    print(f"[{entry['type']}] {entry['displayText']}")
```

## Testing

### Run Tests

```bash
pytest test_game_engine.py -v
```

### Run Specific Test

```bash
pytest test_game_engine.py::TestExecuteManeuvers::test_maneuver_execution_success -v
```

### Enable Debug Logging

```python
import logging

logging.basicConfig(level=logging.DEBUG)
```

## Troubleshooting

### Transaction Errors

If you see "No transaction in progress", make sure you call `begin_transaction()` before `commit()` or `rollback()`.

```python
db.begin_transaction()
try:
    db.execute(...)
    db.commit()
except:
    db.rollback()
```

### Missing Tables

Run `init_schema(db)` to create tables:

```python
from database_adapters import init_schema
init_schema(db)
```

### Debugging Game State

```python
state = engine._load_game_state(game_id, tick)

print("Ships:")
for ship in state.ships.values():
    print(f"  {ship.name}: fuel={ship.fuel}, orbit_parent={ship.currentOrbit.parentBodyId}")

print("Bodies:")
for body in state.bodies.values():
    print(f"  {body.name}: owner={body.ownedBy}, dev_level={body.developmentLevel}")

print("Maneuvers due:")
for order in state.maneuverOrders:
    print(f"  {order.id}: ship={order.shipId}, deltaV={order.deltaV}")
```

## Performance Tips

1. **Index queries by gameId** — Always filter by game when loading state
2. **Batch inserts** — Use `execute_many()` for multiple chronicle entries
3. **WAL mode (SQLite)** — Enabled by default in SQLiteDatabase
4. **Connection pooling (PostgreSQL)** — Use psycopg3 with connection pooling

## Next Steps

1. Read `GAME_ENGINE.md` for comprehensive documentation
2. Explore `game_engine.py` source for implementation details
3. Run `test_game_engine.py` to understand behavior
4. Implement custom `Database` adapter for your backend
5. Integrate with web server (FastAPI, Flask, etc.)

## Example: Full Game Loop

```python
from database_adapters import DatabaseFactory, init_schema, seed_sample_game
from game_engine import GameEngine

# Setup
db = DatabaseFactory.create({"type": "sqlite", "path": ":memory:"})
init_schema(db)
game_id = seed_sample_game(db)

# Create engine
engine = GameEngine(db)

# Run game
max_ticks = 100
for tick in range(max_ticks):
    result = engine.execute_tick(game_id, tick)
    
    if not result.success:
        print(f"Game failed at tick {tick}: {result.errors}")
        break
    
    print(f"Tick {tick}: {result.eventsLogged} events, {result.executionTime:.3f}s")

print("Game complete!")
```

Run this and you'll see the game engine in action!
