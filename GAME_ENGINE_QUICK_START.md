# Game Engine Quick Start Guide

A rapid reference for using the Orbital game engine.

## Installation

The game engine is pure Python with no external dependencies.

```bash
# Copy game_engine/ directory into your project
# Import and use
from game_engine import execute_tick
```

## Basic Usage

### 1. Implement Database Adapter

```python
from game_engine.tick import GameDatabase
from game_engine.models import GameState

class MyDatabase(GameDatabase):
    def load_game_state(self, game_id: str) -> GameState:
        # Query your database and construct GameState
        # See models.py for structure
        pass

    def save_game_state(self, state: GameState) -> bool:
        # Persist GameState changes
        # Use database transaction for atomicity
        pass

    def save_chronicle_entries(self, game_id: str, entries: list) -> bool:
        # Save immutable chronicle entries
        pass
```

### 2. Execute Tick

```python
from game_engine import execute_tick

db = MyDatabase()
result = execute_tick(db, game_id="game123", tick=42)

# Check for errors
if result.errors:
    print(f"Error: {result.errors}")
else:
    print(f"✓ Tick 42 complete")
    print(f"  - {len(result.chronicle_entries)} events")

# Broadcast to frontend
for entry in result.chronicle_entries:
    emit('chronicle_entry', entry.to_dict())

emit('game_state_delta', result.state_delta)
```

### 3. Create Game State

```python
from game_engine.models import (
    GameState, Faction, Body, Ship, OrbitElements,
    BodyType, ShipClass, ManeuverNode, ManeuverType, ManeuverStatus
)

# Create factions
player = Faction(
    id="player",
    name="Player Faction",
    color="#FF0000",
    is_player=True,
)

enemy = Faction(
    id="enemy",
    name="Enemy Faction",
    color="#00FF00",
    is_player=False,
)

# Create bodies
inara = Body(
    id="inara",
    name="Inara",
    type=BodyType.TERRESTRIAL,
    radius=100,
    soi=500,
    color="#4488FF",
    parent="sol",
    orbit_radius=150,
    orbit_period=88,
    owned_by="player",  # Owned by player
)

# Create ships
ship = Ship(
    id="vanguard",
    name="Vanguard",
    class_type=ShipClass.CRUISER,
    owned_by="player",
    fuel=500.0,
    orbit=OrbitElements(
        rp=100, ra=150, omega=0, M0=0, epoch=0,
        direction=1, period=100, parent_body_id="inara"
    ),
)

# Create game state
state = GameState(
    game_id="game123",
    current_tick=0,
    factions=[player, enemy],
    bodies=[inara],
    ships=[ship],
)
```

## Common Tasks

### Add a Maneuver Order

```python
from game_engine.models import ManeuverNode, OrbitElements

maneuver = ManeuverNode(
    id="burn001",
    ship_id="vanguard",
    type=ManeuverType.ORBITAL_CHANGE,
    burn_time=50,  # Will execute at tick 50
    deltav=75.0,   # 75 km/s of delta-v
    prograde=75.0,
    radial=0.0,
    normal=0.0,
    status=ManeuverStatus.PLANNED,
    post_orbit=OrbitElements(  # Target orbit after burn
        rp=120, ra=180, omega=0, M0=0, epoch=50,
        direction=1, period=120, parent_body_id="inara"
    ),
)

ship.orders.append(maneuver)
```

### Commit a Maneuver

```python
from game_engine.maneuvers import commit_maneuver

success = commit_maneuver(state, "burn001")
if success:
    print("✓ Maneuver committed")
```

### Check Faction Resources

```python
faction = state.factions[0]
print(f"Metal: {faction.resources['metal']}")
print(f"Fuel: {faction.resources['fuel']}")
print(f"Science: {faction.resources['science']}")
```

### Claim an Unclaimed Body

```python
from game_engine.ownership import claim_body, can_claim_body
from game_engine.chronicle import Chronicle

chronicle = Chronicle()

body = state.bodies[0]
faction = state.factions[0]

if can_claim_body(body):
    success = claim_body(body, faction, state, chronicle)
    print(f"Claimed: {success}")
```

### Check Reputation

```python
from game_engine.reputation import get_reputation_level

faction = state.factions[0]
level = get_reputation_level(faction.reputation)
print(f"Reputation: {faction.reputation:.1f} ({level})")
```

### View Tech Level

```python
faction = state.factions[0]
print(f"Tech Level: {faction.tech_level}")

# Get tech bonuses
from game_engine.tech import get_tech_bonuses
bonuses = get_tech_bonuses(faction.tech_level)
print(f"Production Bonus: {bonuses['production']}x")
```

## Module Reference

### `game_engine/__init__.py`
Public API: `execute_tick()`, `TickResult`

### `game_engine/models.py`
Data structures: `GameState`, `Body`, `Ship`, `Faction`, `ManeuverNode`, etc.

### `game_engine/tick.py`
Main entry: `execute_tick()`, `GameDatabase` interface

### `game_engine/resources.py`
Resource system: `calculate_body_production()`, `tick_resource_production()`

### `game_engine/maneuvers.py`
Maneuver system: `execute_maneuver()`, `commit_maneuver()`, `delete_maneuver()`

### `game_engine/ownership.py`
Body ownership: `can_claim_body()`, `claim_body()`, `check_soi_entry()`

### `game_engine/standing_orders.py`
Automation: `evaluate_condition()`, `execute_action()`

### `game_engine/treaties.py`
Diplomacy: `check_treaty_expiration()`, `check_nap_violation()`, `apply_violation_penalty()`

### `game_engine/tech.py`
Research: `start_research()`, `tick_tech_research()`, `get_tech_bonuses()`

### `game_engine/reputation.py`
Standing: `apply_reputation_penalty()`, `apply_reputation_boost()`, `get_reputation_level()`

### `game_engine/chronicle.py`
History: `Chronicle` class with logging methods

## Running Tests

```bash
# Run all tests
python -m pytest test_engine.py -v

# Run specific test class
python -m pytest test_engine.py::TestResourceProduction -v

# Run with coverage
python -m pytest test_engine.py --cov=game_engine
```

## Example: Full Game Loop

```python
from game_engine import execute_tick
from game_engine.models import GameState

db = MyDatabase()
game_id = "game123"

# Game loop
current_tick = 0
max_ticks = 1000

for tick_num in range(max_ticks):
    print(f"\nExecuting tick {tick_num}...")

    result = execute_tick(db, game_id, tick_num)

    if result.errors:
        print(f"ERROR: {result.errors}")
        break

    # Log events
    for entry in result.chronicle_entries:
        print(f"  [{entry.event_type}] {entry.title}")
        if entry.description:
            print(f"    {entry.description}")

    # Check win condition
    state = db.load_game_state(game_id)
    if check_win_condition(state):
        print("Game over!")
        break

    current_tick += 1
```

## Performance Tips

1. **Use database transactions**: Wrap load/save in a transaction for atomicity
2. **Cache faction lookups**: Create a dict at tick start for O(1) lookups
3. **Batch updates**: Collect state changes, save once per tick
4. **Monitor execution time**: Log tick duration to find bottlenecks
5. **Async database operations**: Use async database library for I/O parallelism

## Debugging

Enable detailed logging:

```python
import logging
logging.basicConfig(level=logging.DEBUG)

# Or per-module:
logging.getLogger('game_engine').setLevel(logging.DEBUG)
```

Add debug output to tick:

```python
from game_engine.models import GameState

def debug_state(state: GameState):
    print(f"=== TICK {state.current_tick} ===")
    for faction in state.factions:
        print(f"{faction.name}: metal={faction.resources['metal']}, rep={faction.reputation}")
    for ship in state.ships:
        print(f"  {ship.name}: fuel={ship.fuel}, orders={len(ship.orders)}")
```

## Integration with Frontend

The game engine returns `TickResult` which can be broadcast via websocket:

```python
# Server-side
result = execute_tick(db, game_id, tick_number)

if not result.errors:
    # Broadcast to all connected clients
    for client in game_clients[game_id]:
        client.send({
            'type': 'tick_complete',
            'tick': result.tick,
            'chronicle': [e.to_dict() for e in result.chronicle_entries],
            'state_delta': result.state_delta,
        })
```

Frontend updates game state with the delta and displays chronicle events to players.

## Common Pitfalls

### Pitfall 1: Forgetting to Implement Database
```python
# ✗ Wrong - uses abstract interface
result = execute_tick(GameDatabase(), game_id, tick)

# ✓ Right - implement concrete adapter
class PostgresDB(GameDatabase):
    def load_game_state(self, game_id): ...
result = execute_tick(PostgresDB(), game_id, tick)
```

### Pitfall 2: Not Checking Errors
```python
# ✗ Wrong - ignores errors
result = execute_tick(db, game_id, tick)
broadcast(result.state_delta)  # May be incomplete!

# ✓ Right - verify success
result = execute_tick(db, game_id, tick)
if result.errors:
    handle_error(result.errors)
else:
    broadcast(result.state_delta)
```

### Pitfall 3: Modifying GameState Outside Tick
```python
# ✗ Wrong - changes not persisted
state = db.load_game_state(game_id)
state.factions[0].resources['metal'] += 100
# Change lost!

# ✓ Right - changes made inside tick
# Modify in calculate_body_production(), which is called by tick_execute_maneuvers()
# Changes persist via save_game_state()
```

## Next Steps

1. Implement `GameDatabase` adapter for your backend
2. Create initial game state with factions, bodies, ships
3. Call `execute_tick()` in your game loop
4. Broadcast `TickResult` to connected clients
5. Implement UI to display chronicle and allow player input
6. Wire up maneuver planning and order commitment

See `ENGINE_DESIGN.md` for full architecture details.

## Support

- Check `ENGINE_DESIGN.md` for deep architecture details
- Review `test_engine.py` for usage examples
- Look at `game_engine/models.py` for all data structures
- Check specific module docstrings for detailed function documentation

Good luck, Commander! 🚀
