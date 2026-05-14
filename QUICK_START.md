# Orbital Game Engine - Quick Start Guide

## Installation

### 1. Verify Python Environment

```bash
python --version  # Python 3.8+
```

### 2. Install Dependencies

```bash
pip install -r requirements.txt  # If applicable
```

No external dependencies required. Standard library only:
- `sqlite3` (built-in)
- `dataclasses` (built-in)
- `enum` (built-in)
- `json` (built-in)
- `logging` (built-in)
- `unittest` (built-in)

## Quick Start

### Step 1: Initialize Database

```python
from database import SQLiteDatabase

# Create database
db = SQLiteDatabase("orbital.db")
db.connect()
db.initialize_schema()

print("Database initialized!")
```

### Step 2: Create a Game

```python
import json

# Create a new game
db.cursor.execute("""
    INSERT INTO games (id, name, status, max_tick)
    VALUES (?, ?, ?, ?)
""", ("game_001", "Test Game", "active", 1000))

# Create tick execution state
db.cursor.execute("""
    INSERT INTO tick_execution_state (game_id, last_completed_tick, execution_status)
    VALUES (?, ?, ?)
""", ("game_001", -1, "ready"))

db.connection.commit()
print("Game created: game_001")
```

### Step 3: Create Factions

```python
# Create player faction
db.cursor.execute("""
    INSERT INTO factions (id, game_id, name, color, is_player, tech_level)
    VALUES (?, ?, ?, ?, ?, ?)
""", ("player", "game_001", "Player", "#FF0000", True, 1))

# Create resources for player
db.cursor.execute("""
    INSERT INTO faction_resources (id, game_id, faction_id, metal, fuel, gold, science)
    VALUES (?, ?, ?, ?, ?, ?, ?)
""", ("player_res", "game_001", "player", 1000, 1000, 100, 500))

# Create rival faction
db.cursor.execute("""
    INSERT INTO factions (id, game_id, name, color, is_player, tech_level)
    VALUES (?, ?, ?, ?, ?, ?)
""", ("rival", "game_001", "Rival", "#00FF00", False, 1))

db.cursor.execute("""
    INSERT INTO faction_resources (id, game_id, faction_id, metal, fuel, gold, science)
    VALUES (?, ?, ?, ?, ?, ?, ?)
""", ("rival_res", "game_001", "rival", 500, 500, 50, 250))

db.connection.commit()
print("Factions created: player, rival")
```

### Step 4: Create Bodies

```python
from game_engine.models import BodyType

# Create a terrestrial body owned by player
db.cursor.execute("""
    INSERT INTO bodies 
    (id, game_id, name, body_type, radius, soi, color, owned_by, development_level,
     resources_per_tick_metal, resources_per_tick_fuel, resources_per_tick_gold, resources_per_tick_science)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""", (
    "inara", "game_001", "Inara", BodyType.TERRESTRIAL.value,
    100, 500, "#4488FF", "player", 2,
    10, 4, 1, 2
))

# Create an unclaimed body
db.cursor.execute("""
    INSERT INTO bodies
    (id, game_id, name, body_type, radius, soi, color, owned_by, development_level,
     resources_per_tick_metal, resources_per_tick_fuel, resources_per_tick_gold, resources_per_tick_science)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""", (
    "verda", "game_001", "Verda", BodyType.TERRESTRIAL.value,
    80, 400, "#00FF00", None, 0,
    5, 2, 0, 1
))

db.connection.commit()
print("Bodies created: inara (owned), verda (unclaimed)")
```

### Step 5: Create a Ship

```python
from game_engine.models import ShipClass, OrbitElements

orbit_json = json.dumps({
    "rp": 100,
    "ra": 150,
    "omega": 0,
    "M0": 0,
    "epoch": 0,
    "direction": 1,
    "period": 100,
    "parentBodyId": "inara"
})

db.cursor.execute("""
    INSERT INTO ships
    (id, game_id, name, ship_class, owned_by, fuel, max_fuel, current_orbit_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
""", (
    "vanguard", "game_001", "Vanguard", ShipClass.CRUISER.value,
    "player", 500.0, 500.0, orbit_json
))

db.connection.commit()
print("Ship created: Vanguard")
```

### Step 6: Create a Maneuver

```python
# Create a planned maneuver
post_orbit_json = json.dumps({
    "rp": 120,
    "ra": 180,
    "omega": 0,
    "M0": 0,
    "epoch": 10,
    "direction": 1,
    "period": 120,
    "parentBodyId": "inara"
})

db.cursor.execute("""
    INSERT INTO maneuver_orders
    (id, game_id, ship_id, order_type, status, planned_burn_time, deltav, post_orbit_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
""", (
    "burn_001", "game_001", "vanguard", "orbital_change",
    "planned", 10, 50.0, post_orbit_json
))

db.connection.commit()
print("Maneuver created: burn_001 (planned)")
```

### Step 7: Commit and Execute Maneuver

```python
from game_engine.maneuvers import commit_maneuver

# Load state
state = db.load_game_state("game_001")

# Commit the maneuver
success = commit_maneuver(state, "burn_001")
print(f"Maneuver committed: {success}")
```

### Step 8: Execute First Tick

```python
from game_engine.tick import execute_tick

# Execute tick 0
result = execute_tick(db, "game_001", 0)

if result.errors:
    print(f"Tick failed: {result.errors}")
else:
    print(f"Tick 0 executed successfully!")
    print(f"Chronicle entries: {len(result.chronicle_entries)}")
    
    for entry in result.chronicle_entries:
        print(f"  [{entry.event_type}] {entry.title}")
        print(f"    {entry.description}")
```

## Running Tests

### Run Comprehensive Test Suite

```bash
python -m pytest test_engine_comprehensive.py -v
```

### Run Specific Test Class

```bash
python -m pytest test_engine_comprehensive.py::TestResourceProductionUnit -v
```

### Run Single Test

```bash
python -m pytest test_engine_comprehensive.py::TestManeuversUnit::test_maneuver_execution_updates_orbit -v
```

### Run with Coverage

```bash
python -m pytest test_engine_comprehensive.py --cov=game_engine --cov-report=html
```

## Common Operations

### Query Game State

```python
# Load state
state = db.load_game_state("game_001")

# Get faction
player_faction = next((f for f in state.factions if f['id'] == "player"), None)
print(f"Player metal: {player_faction['resources']['metal']}")

# Get owned bodies
owned_bodies = [b for b in state.bodies if b['owned_by'] == "player"]
print(f"Owned bodies: {[b['name'] for b in owned_bodies]}")

# Get ships
player_ships = [s for s in state.ships if s['owned_by'] == "player"]
print(f"Player ships: {[s['name'] for s in player_ships]}")
```

### Add Resources to Faction

```python
from game_engine.resources import add_resources

# Load state
state = db.load_game_state("game_001")

# Get faction
faction = next((f for f in state.factions if f['id'] == "player"), None)

# Add resources
add_resources(faction, {"metal": 100, "fuel": 50})

# Save back
db.save_game_state(state)
```

### Claim a Body

```python
from game_engine.ownership import claim_body
from game_engine.chronicle import Chronicle

# Load state
state = db.load_game_state("game_001")

# Get factions and body
player = next((f for f in state.factions if f['id'] == "player"), None)
verda = next((b for b in state.bodies if b['id'] == "verda"), None)

# Claim it
chronicle = Chronicle()
claim_body(verda, player, state, chronicle)

# Save
db.save_game_state(state)
db.save_chronicle_entries("game_001", chronicle.all_entries())

# Check result
print(f"Verda now owned by: {verda.owned_by}")
```

### Check Reputation

```python
from game_engine.reputation import get_reputation_level

# Get faction
state = db.load_game_state("game_001")
player = next((f for f in state.factions if f['id'] == "player"), None)

reputation = player['reputation']
level = get_reputation_level(reputation)

print(f"Reputation: {reputation} ({level})")
```

## Multi-Tick Simulation

### Run 10 Ticks

```python
from game_engine.tick import execute_tick

for tick in range(10):
    result = execute_tick(db, "game_001", tick)
    
    if result.errors:
        print(f"Tick {tick} FAILED: {result.errors}")
        break
    else:
        state = db.load_game_state("game_001")
        player = next((f for f in state.factions if f['id'] == "player"), None)
        print(f"Tick {tick}: Metal={player['resources']['metal']:.0f}")
```

## Debugging

### Print Detailed Tick Output

```python
import logging

# Enable debug logging
logging.basicConfig(level=logging.DEBUG)

# Execute tick with full logging
result = execute_tick(db, "game_001", 100)
```

### Inspect Database State

```python
# List all games
games = db.query("SELECT * FROM games", [])
print(f"Games: {games}")

# List all factions in game
factions = db.query("SELECT * FROM factions WHERE game_id = ?", ["game_001"])
for f in factions:
    print(f"{f['name']}: metal={f['resources']}")
```

### Replay Chronicle

```python
# Get all chronicle entries for a game
entries = db.query(
    "SELECT * FROM chronicle_entries WHERE game_id = ? ORDER BY tick, id",
    ["game_001"]
)

for entry in entries:
    print(f"Tick {entry['tick']}: [{entry['event_type']}] {entry['title']}")
```

## Troubleshooting

### Issue: "Database is locked"
**Solution**: Close any other connections to the database and try again.

```python
# Close and reopen
db.disconnect()
db.connect()
```

### Issue: "Game not found"
**Solution**: Ensure game exists and game_id is correct.

```python
games = db.query("SELECT id FROM games", [])
print(f"Available games: {[g['id'] for g in games]}")
```

### Issue: "Maneuver execution failed"
**Solution**: Check ship has sufficient fuel and maneuver is committed.

```python
state = db.load_game_state("game_001")
ship = state.ships[0]
print(f"Ship fuel: {ship['fuel']}")

order = state.maneuver_orders[0]
print(f"Maneuver status: {order['status']}")
print(f"Deltav: {order['deltav']}, Required fuel: ~{order['deltav'] * 0.5}")
```

## Next Steps

1. **Run the test suite**: `python -m pytest test_engine_comprehensive.py -v`
2. **Explore the code**: Start with `game_engine/tick.py` to see execution flow
3. **Read the documentation**: Check `ENGINE_IMPLEMENTATION_SUMMARY.md` for detailed architecture
4. **Build a game**: Use the examples above to create your own scenario
5. **Integrate with frontend**: Implement API endpoints to query state and create orders

## Production Deployment

### Single-Server SQLite

```python
db = SQLiteDatabase("orbital.db")
db.connect()
db.initialize_schema()

# Run tick loop
while True:
    for game_id in active_games:
        result = execute_tick(db, game_id, current_tick)
        if not result.errors:
            broadcast_to_clients(game_id, result.state_delta, result.chronicle_entries)
```

### Multi-Server PostgreSQL

```python
# Install PostgreSQL driver
pip install psycopg2-binary

# Create PostgreSQL backend (future implementation)
db = PostgreSQLDatabase(
    host="localhost",
    user="orbital",
    password="...",
    database="orbital"
)
```

## Performance Tips

1. **Batch Updates**: Collect multiple orders before executing
2. **Use Indexes**: Database has indexes on frequently-queried columns
3. **Monitor Tick Time**: Log execution time per tick (target: <200ms)
4. **Cache State**: Keep loaded game state in memory when possible
5. **Async I/O**: Consider async database library for high throughput

## Support and Contribution

For issues or improvements:
1. Check `test_engine_comprehensive.py` for examples
2. Read subsystem documentation in code comments
3. Submit detailed bug reports with reproduction steps
4. Contribute tests for new features

---

**Ready to build your space game?** 🚀

Start with the database initialization, then follow the steps above. The engine is production-ready and extensively tested.

Good luck, Commander!
