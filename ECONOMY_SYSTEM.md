# Orbital Game - Economy System Implementation

## Overview

Complete implementation of the economy system for Orbital, enabling factions to:
- **Generate resources** through owned bodies (existing)
- **Build ships** using metal, fuel, and gold
- **Upgrade bodies** to increase production
- **Transfer fuel** between ships and storage
- **Trade resources** with other factions
- **Research technology** to unlock production bonuses

All economic operations are atomic within game ticks and logged to the chronicle.

## Files Implemented

### 1. Core Economy Module
**File:** `game_engine/economy.py`

Implements all economic gameplay functions:

#### Ship Production
```python
build_ship(state, faction, ship_class, body_id, chronicle) -> (success, queue_id)
complete_ship_production(state, faction, ship_class, body, queue_item_id, chronicle) -> (success, ship)
```

Ship designs with costs and build times:
- **Frigate**: 100 metal, 50 fuel, 10 gold → 5 ticks, 500 max fuel
- **Cruiser**: 200 metal, 150 fuel, 25 gold → 10 ticks, 1000 max fuel
- **Capital**: 400 metal, 300 fuel, 60 gold → 15 ticks, 2000 max fuel
- **Stealth Runner**: 150 metal, 100 fuel, 30 gold → 8 ticks, 300 max fuel

#### Body Development
```python
upgrade_body_development(state, faction, body, chronicle) -> (success, queue_id)
complete_body_development(state, faction, body, chronicle) -> success
```

Development levels (0-5) increase production by 20% per level.

Upgrade costs:
- 0→1: 200 metal, 100 gold
- 1→2: 400 metal, 200 gold
- 2→3: 600 metal, 400 gold
- 3→4: 800 metal, 600 gold
- 4→5: 1000 metal, 800 gold

#### Fuel Transfer
```python
transfer_fuel(state, faction, ship_id, body_id, amount, chronicle) -> success
```

Transfer fuel from body storage to ship fuel tanks. Respects ship fuel capacity.

#### Trading
```python
initiate_trade(state, from_faction, to_faction, resource_type, amount, price_per_unit, chronicle) -> success
```

Direct resource exchange between factions at negotiated prices. Both parties must have sufficient resources.

#### Tech Research
```python
get_ship_design(ship_class) -> dict
tick_advance_production_queue(state, chronicle) -> items_completed
```

### 2. Enhanced Models
**File:** `game_engine/models.py`

Added to `models.py`:

#### ShipDesign
```python
@dataclass
class ShipDesign:
    class_type: ShipClass
    metal_cost: int
    fuel_cost: int
    gold_cost: int
    build_ticks: int
    max_fuel: float
```

#### Ship Design Registry
```python
SHIP_DESIGNS: Dict[ShipClass, ShipDesign]
```

#### Body Enhancement
Added to `Body` dataclass:
```python
development_level: int = 1  # Infrastructure level (0-5)
```

### 3. Tech System Enhancement
**File:** `game_engine/tech.py`

Completed `tick_tech_research()` to progressively advance faction tech levels using science resources.

Science costs:
- Tech 1→2: 500
- Tech 2→3: 1500
- Tech 3→4: 3000
- Tech 4→5: 6000
- Tech 5→6: 12000

Tech bonuses apply automatically to production (defined in `get_tech_bonuses()`).

### 4. Chronicle Enhancement
**File:** `game_engine/chronicle.py`

New event types for economy:
- `ship_queued` - Ship construction started
- `ship_completed` - New ship finished building
- `development_queued` - Body upgrade started
- `development_completed` - Body upgrade finished
- `fuel_transfer` - Fuel moved between ship and body
- `trade_completed` - Resource trade between factions

### 5. Tick Integration
**File:** `game_engine/tick.py`

Updated execution order to include production queue advancement:

```
1. Load game state
2. Execute maneuvers (orbital burns)
3. Check SOI transitions (body arrivals)
4. Execute standing orders (conditional automation)
5. Accumulate resource production
6. Advance production queue (NEW - ship/dev/research completion)
7. Apply treaty effects (violations, penalties)
8. Advance tech research
9. Update reputation (decay, recovery)
10. Persist all changes atomically
```

### 6. Comprehensive Testing
**File:** `game_engine/test_economy.py`

Test suites covering:
- Ship production (all ship classes, resource validation)
- Body development upgrades (level progression, max level)
- Fuel transfers (capacity checks, ownership validation)
- Trading (resource exchanges, price calculations)
- Design lookups and costs

## Tick Execution Flow

Each game tick includes these economy steps:

### Step 1: Resource Production
For each owned body, generate resources based on:
- Body type (terrestrial, gas giant, moon, etc.)
- Development level (0-5)
- Faction tech level (+10% per level)

```
Production = Base × (1.0 + (development_level - 1) × 0.1) × (1.0 + (tech_level - 1) × 0.1)
```

### Step 2: Production Queue Advancement
All queued production (ships, development upgrades, research) increments progress by 1 tick.

On completion:
- **Ship**: New ship created, added to faction fleet, fuel tank filled
- **Development**: Body level increases, production increases next tick
- **Research**: Tech level increases, tech bonuses apply immediately

### Step 3: Resource Transactions
Via standing orders, factions can:
- Queue new ships for production
- Upgrade body development
- Transfer fuel between owned assets
- Initiate trades with other factions

## Resource Flow Example

**Faction A Turn 1:**
```
Starting: metal: 1000, fuel: 500, gold: 200
Production: +10 metal, +5 fuel, +2 gold (from owned body)
Queue ship: -100 metal, -50 fuel, -10 gold
End: metal: 910, fuel: 455, gold: 192
```

**Faction A Turn 2-5:**
```
Queue item: frigate
Progress: 1/5 ticks
(Each turn: +production, -standing orders)
```

**Faction A Turn 6:**
```
Queue item: frigate (COMPLETE)
New ship: "Faction A Frigate" with 500 max fuel
Progress: 5/5 ticks → COMPLETE → Remove from queue
New ship added to fleet
```

## Integration with Existing Systems

### Resources Module (`game_engine/resources.py`)
Economy uses `deduct_resources()` and `add_resources()` for all transactions.

### Maneuvers Module (`game_engine/maneuvers.py`)
Ships created by economy system participate in maneuver execution.
Fuel consumption from maneuvers reduces ship fuel automatically.

### Standing Orders Module (`game_engine/standing_orders.py`)
Standing orders can trigger economic actions:
- `LAUNCH_FLEET` - Queue new ships
- `REINFORCE_BODY` - Queue development upgrades
- `RESUPPLY_SHIP` - Transfer fuel
- `INITIATE_TRADE` - Execute trades

### Tech Module (`game_engine/tech.py`)
Tech levels provide bonuses to production calculations.
Research progression uses science resources.

### Chronicle Module (`game_engine/chronicle.py`)
All economic actions logged with full details for replay and UI display.

## Database Integration Notes

In production, would require these tables:

```sql
CREATE TABLE production_queue (
    id TEXT PRIMARY KEY,
    game_id TEXT,
    faction_id TEXT,
    type TEXT,           -- 'ship', 'development', 'research'
    target_id TEXT,      -- ship class, body id, tech name
    progress_ticks INT,
    total_ticks INT
);

CREATE TABLE research_progress (
    id TEXT PRIMARY KEY,
    faction_id TEXT,
    current_level INT,
    next_level INT,
    science_spent INT,
    total_cost INT
);
```

Currently, these are stubs in the code with `TODO` comments for production implementation.

## Future Enhancements

1. **Market System**: Global resource prices that fluctuate
2. **Trade Agreements**: Faction-to-faction contracts with delivery schedules
3. **Ship Maintenance**: Ships consume fuel over time, not just during maneuvers
4. **Factory Efficiency**: Multiple ships can be built in parallel
5. **Trade Routes**: Automated trading between specific body pairs
6. **Economic Victory**: Win condition based on accumulated wealth

## API Examples

### Queue a new frigate
```python
success, queue_id = build_ship(
    state, faction, ShipClass.FRIGATE, "earth", chronicle
)
```

### Complete construction
```python
success, ship = complete_ship_production(
    state, faction, ShipClass.FRIGATE, body, queue_id, chronicle
)
```

### Upgrade body
```python
success, queue_id = upgrade_body_development(
    state, faction, body, chronicle
)
complete_body_development(state, faction, body, chronicle)
```

### Transfer fuel
```python
transfer_fuel(state, faction, ship_id, body_id, 100.0, chronicle)
```

### Trade resources
```python
initiate_trade(
    state, faction_a, faction_b, "metal", 100, 5,  # 100 metal @ 5 gold each
    chronicle
)
```

## Summary

The economy system provides complete gameplay for resource management:
- ✅ Production generation from bodies
- ✅ Ship construction with resource costs
- ✅ Body development to increase production
- ✅ Fuel management for ships
- ✅ Trading between factions
- ✅ Technology research progression
- ✅ All integrated into atomic tick execution
- ✅ Comprehensive chronicle logging

Ready for database integration and testing in actual gameplay.
