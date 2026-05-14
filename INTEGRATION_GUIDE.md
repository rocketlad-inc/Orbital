# Combat and Treaty System Integration Guide

## Quick Start

This guide shows how to integrate the new combat and treaty systems into the main game tick engine.

## Step 1: Update Tick Execution Order

Edit `game_engine/tick.py` to include combat and treaty enforcement:

```python
def execute_tick(db: GameDatabase, game_id: str, tick: int) -> TickResult:
    """Execute one complete game tick atomically."""
    
    result = TickResult(game_id=game_id, tick=tick)
    
    # Load game state
    try:
        state = db.load_game_state(game_id)
        if not state:
            raise GameEngineError(f"Game {game_id} not found")
    except Exception as e:
        result.errors.append(f"Failed to load game state: {str(e)}")
        return result
    
    # Initialize chronicle
    chronicle = Chronicle()
    
    try:
        # 1. Execute maneuvers
        maneuver_count = tick_execute_maneuvers(state, chronicle)
        
        # 2. Check SOI transitions
        # TODO: Implement SOI checking
        
        # 3. Execute standing orders
        standing_orders_count = tick_standing_orders(state, chronicle)
        
        # 4. Accumulate resource production
        tick_resource_production(state, chronicle)
        
        # === NEW: 5. Execute combat ===
        from .combat import tick_combat_resolution
        combats_resolved = tick_combat_resolution(state, chronicle)
        
        # === ENHANCED: 6. Apply treaty effects ===
        # Load treaties from database (you'll implement this)
        treaties = db.load_treaties(game_id)  # NEW
        violations_count = tick_treaty_enforcement(state, chronicle, treaties)
        
        # 7. Advance tech research
        tech_completed = tick_tech_research(state, chronicle)
        
        # === ENHANCED: 8. Update reputation (now with decay) ===
        tick_reputation_update(state, chronicle)
        
        # 9. Increment tick
        state.current_tick = tick + 1
        
    except Exception as e:
        result.errors.append(f"Tick execution failed: {str(e)}")
        chronicle.log_error(tick, None, "execution", str(e))
        return result
    
    # Persist state
    try:
        if not db.save_game_state(state):
            raise GameEngineError("Failed to save game state")
        
        if not db.save_chronicle_entries(game_id, chronicle.all_entries()):
            raise GameEngineError("Failed to save chronicle entries")
    
    except Exception as e:
        result.errors.append(f"Failed to persist game state: {str(e)}")
        return result
    
    # Build result
    result.chronicle_entries = chronicle.all_entries()
    result.state_delta = {
        "game_id": game_id,
        "tick": state.current_tick,
        "factions": [f.to_dict() for f in state.factions],
        "ships": [s.to_dict() for s in state.ships],
        "bodies": [b.to_dict() for b in state.bodies],
    }
    
    return result
```

## Step 2: Implement Database Methods

Add these methods to your GameDatabase interface in `game_engine/tick.py`:

```python
class GameDatabase:
    """Abstract database interface."""
    
    def load_treaties(self, game_id: str) -> List[Treaty]:
        """
        Load all treaties for a game.
        
        Returns:
            List of Treaty objects
        """
        raise NotImplementedError
    
    def save_treaty(self, treaty: Treaty) -> bool:
        """
        Save a treaty (create or update).
        
        Args:
            treaty: Treaty object to save
            
        Returns:
            True if successful
        """
        raise NotImplementedError
    
    def log_reputation_change(
        self,
        game_id: str,
        faction_id: str,
        change_amount: float,
        reason: str,
        tick: int,
    ) -> bool:
        """
        Log a reputation change.
        
        Args:
            game_id: Game ID
            faction_id: Faction that changed
            change_amount: Amount changed (negative or positive)
            reason: Reason code
            tick: Current tick
            
        Returns:
            True if successful
        """
        raise NotImplementedError
```

## Step 3: Implement Database Persistence Layer

Create `game_engine/database.py` with SQLite implementation:

```python
"""Database implementation for game engine."""

import sqlite3
import json
from typing import List, Optional
from .models import GameState, Faction, Ship, Body, Maneuver
from .treaties import Treaty, TreatyType, TreatyStatus
from .tick import GameDatabase


class SQLiteGameDatabase(GameDatabase):
    """SQLite implementation of game database."""
    
    def __init__(self, db_path: str):
        """Initialize database connection."""
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
    
    def load_game_state(self, game_id: str) -> Optional[GameState]:
        """Load complete game state from database."""
        cursor = self.conn.cursor()
        
        # Load basic game info
        cursor.execute(
            "SELECT current_tick FROM games WHERE id = ?",
            (game_id,)
        )
        game_row = cursor.fetchone()
        if not game_row:
            return None
        
        current_tick = game_row[0]
        
        # Load factions
        cursor.execute(
            "SELECT id, name, color, reputation FROM factions WHERE game_id = ?",
            (game_id,)
        )
        factions = [
            Faction(
                id=row['id'],
                name=row['name'],
                color=row['color'],
                reputation=row['reputation'],
            )
            for row in cursor.fetchall()
        ]
        
        # Load ships
        cursor.execute(
            "SELECT id, name, faction_id FROM ships WHERE game_id = ? AND status = 'active'",
            (game_id,)
        )
        ships = [
            Ship(
                id=row['id'],
                name=row['name'],
                owned_by=row['faction_id'],
                # ... load other fields from JSON columns
            )
            for row in cursor.fetchall()
        ]
        
        # Load bodies
        cursor.execute(
            "SELECT id, name, type, owned_by_faction_id FROM bodies WHERE game_id = ?",
            (game_id,)
        )
        bodies = [
            Body(
                id=row['id'],
                name=row['name'],
                type=row['type'],
                owned_by=row['owned_by_faction_id'],
                # ... load other fields
            )
            for row in cursor.fetchall()
        ]
        
        return GameState(
            game_id=game_id,
            current_tick=current_tick,
            factions=factions,
            ships=ships,
            bodies=bodies,
        )
    
    def save_game_state(self, state: GameState) -> bool:
        """Save game state atomically."""
        try:
            cursor = self.conn.cursor()
            
            # Update tick count
            cursor.execute(
                "UPDATE games SET current_tick = ? WHERE id = ?",
                (state.current_tick, state.game_id)
            )
            
            # Update factions
            for faction in state.factions:
                cursor.execute(
                    """UPDATE factions 
                       SET reputation = ?, updated_at = datetime('now')
                       WHERE id = ?""",
                    (faction.reputation, faction.id)
                )
            
            # Update ships
            for ship in state.ships:
                cursor.execute(
                    """UPDATE ships 
                       SET hull_integrity = ?, fuel_current = ?
                       WHERE id = ?""",
                    (ship.hull_integrity, ship.fuel, ship.id)
                )
            
            self.conn.commit()
            return True
        
        except Exception as e:
            self.conn.rollback()
            print(f"Error saving game state: {e}")
            return False
    
    def load_treaties(self, game_id: str) -> List[Treaty]:
        """Load all treaties for a game."""
        cursor = self.conn.cursor()
        
        cursor.execute(
            """SELECT id, treaty_type, status, signatories_json, 
                      start_tick, end_tick, terms_json
               FROM treaties WHERE game_id = ?""",
            (game_id,)
        )
        
        treaties = []
        for row in cursor.fetchall():
            treaty = Treaty(
                id=row['id'],
                type=TreatyType(row['treaty_type']),
                status=TreatyStatus(row['status']),
                signatories=json.loads(row['signatories_json']),
                start_tick=row['start_tick'],
                expires_at_tick=row['end_tick'],
                terms=json.loads(row['terms_json']) if row['terms_json'] else {},
            )
            treaties.append(treaty)
        
        return treaties
    
    def save_treaty(self, treaty: Treaty) -> bool:
        """Save a treaty to database."""
        try:
            cursor = self.conn.cursor()
            
            cursor.execute(
                """INSERT OR REPLACE INTO treaties 
                   (id, treaty_type, status, signatories_json, 
                    start_tick, end_tick, terms_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    treaty.id,
                    treaty.type.value,
                    treaty.status.value,
                    json.dumps(treaty.signatories),
                    treaty.start_tick,
                    treaty.expires_at_tick,
                    json.dumps(treaty.terms) if treaty.terms else None,
                )
            )
            
            self.conn.commit()
            return True
        
        except Exception as e:
            self.conn.rollback()
            print(f"Error saving treaty: {e}")
            return False
    
    def save_chronicle_entries(self, game_id: str, entries: list) -> bool:
        """Save chronicle entries to database."""
        try:
            cursor = self.conn.cursor()
            
            for entry in entries:
                cursor.execute(
                    """INSERT INTO chronicle_entries 
                       (game_id, tick, entry_type, headline, description, 
                        primary_faction_id, event_data_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        game_id,
                        entry.tick,
                        entry.event_type,
                        entry.title,
                        entry.description,
                        entry.faction_id,
                        json.dumps(entry.event_data) if hasattr(entry, 'event_data') else None,
                    )
                )
            
            self.conn.commit()
            return True
        
        except Exception as e:
            self.conn.rollback()
            print(f"Error saving chronicle: {e}")
            return False
    
    def log_reputation_change(
        self,
        game_id: str,
        faction_id: str,
        change_amount: float,
        reason: str,
        tick: int,
    ) -> bool:
        """Log a reputation change to database."""
        try:
            cursor = self.conn.cursor()
            
            cursor.execute(
                """INSERT INTO reputation_logs 
                   (game_id, faction_id, change_amount, reason, tick)
                   VALUES (?, ?, ?, ?, ?)""",
                (game_id, faction_id, change_amount, reason, tick)
            )
            
            self.conn.commit()
            return True
        
        except Exception as e:
            self.conn.rollback()
            print(f"Error logging reputation: {e}")
            return False
```

## Step 4: Update Model Classes

Ensure Ship and Faction models have required fields:

```python
# In game_engine/models.py

@dataclass
class Ship:
    """A starship under player or faction control."""
    id: str
    name: str
    class_type: ShipClass
    owned_by: str               # faction id
    fuel: float                 # remaining fuel
    orbit: OrbitElements        # current orbit
    
    # === NEW FIELDS FOR COMBAT ===
    hull_integrity: float = 1.0     # 0.0-1.0, starts at 100%
    armor_level: int = 0            # 0-5, each level reduces damage by 10%
    max_delta_v_mps: float = 10000  # Maximum velocity change capability
    
    orders: List[ManeuverNode] = field(default_factory=list)
    color: Optional[str] = None


@dataclass
class Faction:
    """A faction (player, enemy, ally)."""
    id: str
    name: str
    color: str                  # hex color
    is_player: bool = False
    
    # Resources
    resources: Dict[str, int] = field(default_factory=lambda: {
        "metal": 1000,
        "fuel": 1000,
        "gold": 100,
        "science": 500,
    })
    
    # === REPUTATION (already exists, enhanced) ===
    reputation: float = 0.0     # -100 to +100
    tech_level: int = 1         # 1-5
```

## Step 5: Example Tick Execution

Here's how to use the integrated system:

```python
from game_engine import execute_tick
from game_engine.database import SQLiteGameDatabase

# Initialize database
db = SQLiteGameDatabase("orbital.db")

# Execute a tick
result = execute_tick(
    db=db,
    game_id="game_001",
    tick=42,
)

# Check for errors
if result.errors:
    print("Errors occurred:")
    for error in result.errors:
        print(f"  - {error}")

# View chronicle entries
print("\nChronicle entries:")
for entry in result.chronicle_entries:
    print(f"  Tick {entry.tick}: {entry.title}")
    print(f"    {entry.description}")

# Apply state delta to frontend
print("\nState updated:")
print(f"  Current tick: {result.state_delta['tick']}")
print(f"  Factions: {len(result.state_delta['factions'])}")
print(f"  Ships: {len(result.state_delta['ships'])}")
```

## Step 6: Testing the Integration

```python
# test_integration.py

import unittest
from game_engine.database import SQLiteGameDatabase
from game_engine import execute_tick
from game_engine.models import GameState, Faction, Ship, ShipClass, OrbitElements


class TestIntegration(unittest.TestCase):
    """Test integrated tick execution."""
    
    def setUp(self):
        """Set up test database."""
        self.db = SQLiteGameDatabase(":memory:")
        # Initialize schema in memory database
        self.db.init_schema()
    
    def test_tick_execution_with_combat(self):
        """Test full tick execution including combat."""
        # Create game
        game_id = self.db.create_game("Test Game")
        
        # Create factions
        f_a = self.db.create_faction(game_id, "Faction A", "#FF0000")
        f_b = self.db.create_faction(game_id, "Faction B", "#0000FF")
        
        # Create ships at same location
        ship_a = self.db.create_ship(
            game_id, f_a, "Warship A", ShipClass.CRUISER
        )
        ship_b = self.db.create_ship(
            game_id, f_b, "Warship B", ShipClass.FRIGATE
        )
        
        # Create attack maneuver
        maneuver = self.db.create_attack_maneuver(
            game_id, ship_a, target_ship_id=ship_b, burn_tick=0
        )
        
        # Execute tick
        result = execute_tick(db=self.db, game_id=game_id, tick=0)
        
        # Verify combat occurred
        combat_events = [e for e in result.chronicle_entries if e.event_type == "combat"]
        self.assertGreater(len(combat_events), 0)
        
        # Verify ship damage
        updated_ship_b = self.db.get_ship(ship_b)
        self.assertLess(updated_ship_b.hull_integrity, 1.0)


if __name__ == "__main__":
    unittest.main()
```

## Deployment Checklist

- [ ] Update `tick.py` with new execution order
- [ ] Implement `GameDatabase` methods in your database layer
- [ ] Add `hull_integrity` and `armor_level` to Ship schema
- [ ] Add `reputation` tracking to Faction schema
- [ ] Create `treaties` table in database
- [ ] Create `reputation_logs` table in database
- [ ] Create `combat_logs` table in database
- [ ] Update chronicle schema for new event types
- [ ] Test combat resolution in isolation
- [ ] Test treaty violation detection
- [ ] Test reputation decay/recovery
- [ ] Test full tick execution with all systems
- [ ] Test atomic transaction rollback on error
- [ ] Deploy to production

## Performance Tuning

If tick execution is slow:

1. **Profile the tick**:
   ```python
   import cProfile
   
   profiler = cProfile.Profile()
   profiler.enable()
   
   result = execute_tick(db, game_id, tick)
   
   profiler.disable()
   profiler.print_stats(sort='cumulative')
   ```

2. **Common bottlenecks**:
   - Database queries: Add indexes on foreign keys
   - Treaty checking: Cache treaty lookups by signatory
   - Reputation decay: Compute only for changed factions
   - Chronicle logging: Batch writes to database

3. **Optimization examples**:
   ```python
   # Cache treaties by faction for faster lookup
   treaty_cache = {}
   for treaty in treaties:
       for faction_id in treaty.signatories:
           if faction_id not in treaty_cache:
               treaty_cache[faction_id] = []
           treaty_cache[faction_id].append(treaty)
   
   # Check violations only for involved factions
   for faction in state.factions:
       if faction.id in treaty_cache:
           for treaty in treaty_cache[faction.id]:
               # Check violations...
   ```

## Troubleshooting

**Combat not resolving**: Ensure maneuver has `type="attack"` and `status="committed"`

**Reputation not changing**: Check that Chronicle events are being logged and persisted

**Treaties not breaking**: Verify treaties are loaded from database before tick execution

**Atomic transaction fails**: Check that database connection is in autocommit=False mode

## Support

For issues or questions, refer to:
- `COMBAT_TREATY_SYSTEM.md` - System documentation
- `test_combat_treaties.py` - Example tests
- `game_engine/combat.py` - Combat implementation
- `game_engine/treaties.py` - Treaty implementation
- `game_engine/reputation.py` - Reputation system
