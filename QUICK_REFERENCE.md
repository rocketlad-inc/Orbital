# Combat and Treaty System - Quick Reference

## File Locations

```
game_engine/combat.py                 # Combat resolution (NEW)
game_engine/treaties.py               # Treaty enforcement (ENHANCED)
game_engine/reputation.py             # Reputation tracking (ENHANCED)
game_engine/chronicle.py              # Event logging (ENHANCED)
game_engine/tick.py                   # Main tick processor (UPDATE)

test_combat_treaties.py               # Test suite (NEW)

COMBAT_TREATY_SYSTEM.md              # Full documentation (NEW)
INTEGRATION_GUIDE.md                  # Integration steps (NEW)
IMPLEMENTATION_SUMMARY.md             # Implementation report (NEW)
QUICK_REFERENCE.md                    # This file (NEW)
```

## Key Classes

### Combat System

```python
from game_engine.combat import (
    resolve_combat,
    CombatOutcome,
    CombatResolution,
)

# Resolve one combat
resolution = resolve_combat(
    state=game_state,
    attacker=ship_a,
    target=ship_b,
    attacker_velocity_ms=5000.0,
    target_velocity_ms=3000.0,
    engagement_range_km=5000.0,
    current_tick=100,
)

# Resolution has:
# - attacker_id, target_id
# - pre_damage, armor_reduction, actual_damage
# - target_hull_before, target_hull_after
# - outcome (DESTROYED|HEAVILY_DAMAGED|DAMAGED|LIGHTLY_DAMAGED|INTACT)
```

### Treaties

```python
from game_engine.treaties import (
    Treaty,
    TreatyType,
    TreatyStatus,
    check_nap_violation_extended,
    apply_violation_penalty,
)

# Create treaty
treaty = Treaty(
    id="nap_001",
    type=TreatyType.NON_AGGRESSION_PACT,
    signatories=["faction_a", "faction_b"],
    start_tick=0,
    expires_at_tick=100,
    status=TreatyStatus.ACTIVE,
)

# Check violation
violated, code = check_nap_violation_extended(
    treaty, "faction_a", "faction_b", current_tick=50
)

# Apply penalty
apply_violation_penalty(faction, "direct_attack", severity=1)
```

### Reputation

```python
from game_engine.reputation import (
    apply_reputation_change,
    tick_reputation_decay,
    get_reputation_level,
    can_form_treaty,
    treaty_discount_modifier,
    ReputationChange,
)

# Change reputation
apply_reputation_change(
    faction,
    change=10.0,
    reason=ReputationChange.FAIR_VICTORY,
    description="Won combat",
)

# Check eligibility
if can_form_treaty(faction_a, faction_b):
    # Can form treaty

# Get modifier
cost = base_cost * treaty_discount_modifier(faction.reputation)

# Apply decay
tick_reputation_decay(state, chronicle)

# Get level
level = get_reputation_level(faction.reputation)
# Returns: "Pariah", "Enemy", "Distrusted", "Neutral", etc.
```

### Chronicle

```python
from game_engine.chronicle import Chronicle

chronicle = Chronicle()

# Log combat
chronicle.log_combat(
    tick=5,
    attacker_id="ship_a",
    attacker_faction_id="faction_a",
    target_id="ship_b",
    target_faction_id="faction_b",
    outcome="destroyed",
    damage=50.0,
    target_hull_after=0.0,
)

# Log treaty
chronicle.log_treaty_event(
    tick=10,
    event_subtype="signed",  # signed|broken|expired
    treaty_type="non_aggression_pact",
    factions=["faction_a", "faction_b"],
    description="NAP signed",
)

# Log generic event
chronicle.log_event(
    tick=15,
    event_type="custom_event",
    headline="Event Title",
    description="Event description",
    primary_faction_id="faction_a",
    event_data={"key": "value"},
)

# Get all entries
entries = chronicle.all_entries()
extended = chronicle.all_extended_entries()
```

## Ship Fields

```python
@dataclass
class Ship:
    id: str
    name: str
    class_type: ShipClass              # frigate|cruiser|capital|stealth
    owned_by: str                       # faction_id
    fuel: float                         # current fuel
    orbit: OrbitElements                # orbital position
    
    # NEW FOR COMBAT
    hull_integrity: float = 1.0         # 0.0-1.0 scale
    armor_level: int = 0                # 0-5 scale
    max_delta_v_mps: float = 10000      # max velocity change
```

## Faction Fields

```python
@dataclass
class Faction:
    id: str
    name: str
    color: str                          # hex color
    is_player: bool
    resources: Dict[str, int]
    
    # REPUTATION (TRACKED)
    reputation: float = 0.0             # -100 to +100
    tech_level: int = 1                 # 1-5
```

## Tick Execution

```python
from game_engine import execute_tick
from game_engine.database import GameDatabase

# Execute one tick
result = execute_tick(
    db=database_instance,
    game_id="game_001",
    tick=42,
)

# Result has:
result.chronicle_entries    # List of ChronicleEntry
result.state_delta         # Updated game state
result.errors              # List of error messages
```

## Common Patterns

### Apply Combat Damage

```python
from game_engine.combat import resolve_combat, apply_combat_reputation_impact

resolution = resolve_combat(state, attacker, target, v_a, v_t, range_km, tick)
apply_combat_reputation_impact(state, resolution, chronicle)
```

### Check Treaty Violations

```python
from game_engine.treaties import (
    check_nap_violation_extended,
    check_alliance_betrayal,
    apply_violation_penalty,
)

# Check NAP
violated, code = check_nap_violation_extended(treaty, f_a, f_b, tick)
if violated:
    apply_violation_penalty(faction, "direct_attack")

# Check Alliance
betrayed, code = check_alliance_betrayal(treaty, ally_id, attacker_id, tick)
if betrayed:
    apply_violation_penalty(faction, "alliance_betrayal")
```

### Update Reputation

```python
from game_engine.reputation import apply_reputation_change, ReputationChange

apply_reputation_change(
    faction=faction_a,
    change=-20.0,
    reason=ReputationChange.TREATY_VIOLATION,
    description="Broke non-aggression pact",
)
```

### Log Events

```python
# Combat
chronicle.log_combat(
    tick=state.current_tick,
    attacker_id=resolution.attacker_id,
    attacker_faction_id=resolution.attacker_faction_id,
    target_id=resolution.target_id,
    target_faction_id=resolution.target_faction_id,
    outcome=resolution.outcome.value,
    damage=resolution.actual_damage,
    target_hull_after=resolution.target_hull_after,
)

# Treaty
chronicle.log_treaty_event(
    tick=state.current_tick,
    event_subtype="broken",
    treaty_type=treaty.type.value,
    factions=treaty.signatories,
    description=f"Broken by {violator_faction}",
)

# Reputation
chronicle.log_event(
    tick=state.current_tick,
    event_type="reputation_change",
    headline=f"{faction.name} reputation changed",
    description=f"From {old_rep:.0f} to {new_rep:.0f}",
    primary_faction_id=faction.id,
    event_data={
        "old_reputation": old_rep,
        "new_reputation": new_rep,
        "reason": reason.value,
    },
)
```

## Constants

### Combat
```python
# Engagement ranges (base values, scaled by tech level)
FRIGATE_RANGE = 5000.0              # km
CRUISER_RANGE = 10000.0
CAPITAL_RANGE = 20000.0
STEALTH_RANGE = 2500.0              # 50% penalty

# Damage values
FRIGATE_DAMAGE = 20.0
CRUISER_DAMAGE = 50.0
CAPITAL_DAMAGE = 100.0
STEALTH_DAMAGE = 30.0

# Armor reduction
ARMOR_REDUCTION_PER_LEVEL = 0.1     # 10% per level
MAX_ARMOR_REDUCTION = 0.8           # 80% cap

# Velocity bonus
MAX_RELATIVE_VELOCITY = 10000.0     # m/s, caps at 10 km/s
MAX_VELOCITY_MULTIPLIER = 2.0       # 2.0x damage at max velocity
```

### Reputation
```python
MIN_REPUTATION = -100.0
MAX_REPUTATION = 100.0
NEGATIVE_REP_RECOVERY = 0.5         # per tick
POSITIVE_REP_DECAY = 0.2            # per tick

# Thresholds for mechanics
MIN_REP_FOR_TREATY = -20.0
MIN_REP_FOR_ALLIANCE = 20.0
MIN_REP_FOR_TECH_SHARING = 10.0

# Levels
BELOVED_HERO_REP = 80
RESPECTED_ALLY_REP = 50
KNOWN_FRIEND_REP = 20
TRUSTED_REP = 0
NEUTRAL_REP = -20
DISTRUSTED_REP = -50
ENEMY_REP = -80
PARIAH_REP = -100
```

### Treaties
```python
# Violation penalties
NAP_PENALTY = -20.0
TRADE_PENALTY = -10.0
ALLIANCE_PENALTY = -30.0
DMZ_PENALTY = -15.0                 # per tick
TECH_PENALTY = -5.0
MINING_PENALTY = -10.0

# Penalty severity multiplier
# Applies to all penalties
# Typical range: 1-5
```

## Database Methods Required

```python
class GameDatabase:
    def load_treaties(self, game_id: str) -> List[Treaty]:
        """Load all treaties for a game"""
        
    def save_treaty(self, treaty: Treaty) -> bool:
        """Save or update a treaty"""
        
    def log_reputation_change(
        self,
        game_id: str,
        faction_id: str,
        change_amount: float,
        reason: str,
        tick: int,
    ) -> bool:
        """Log a reputation change"""
```

## Enums

```python
# Combat
class CombatOutcome(str, Enum):
    DESTROYED = "destroyed"
    HEAVILY_DAMAGED = "heavily_damaged"
    DAMAGED = "damaged"
    LIGHTLY_DAMAGED = "lightly_damaged"
    INTACT = "intact"

# Treaties
class TreatyType(str, Enum):
    NON_AGGRESSION_PACT = "non_aggression_pact"
    TRADE_AGREEMENT = "trade_agreement"
    MILITARY_ALLIANCE = "military_alliance"
    RESEARCH_COOPERATION = "research_cooperation"
    DEMILITARIZATION_ZONE = "demilitarization_zone"
    TECHNOLOGY_SHARING = "technology_sharing"
    MINING_RIGHTS = "mining_rights"

class TreatyStatus(str, Enum):
    PROPOSED = "proposed"
    ACTIVE = "active"
    BROKEN = "broken"
    EXPIRED = "expired"
    CANCELLED = "cancelled"

# Reputation
class ReputationChange(str, Enum):
    TREATY_VIOLATION = "treaty_violation"
    UNPROVOKED_ATTACK = "unprovoked_attack"
    ALLIANCE_BETRAYAL = "alliance_betrayal"
    FAIR_VICTORY = "fair_victory"
    DEFENDED_ALLY = "defended_ally"
    # ... etc
```

## Testing

```bash
# Run all tests
python -m pytest test_combat_treaties.py -v

# Run specific test class
python -m pytest test_combat_treaties.py::TestCombatResolution -v

# Run specific test
python -m pytest test_combat_treaties.py::TestCombatResolution::test_engagement_range_by_class -v

# Run with coverage
python -m pytest test_combat_treaties.py --cov=game_engine --cov-report=html
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Combat not resolving | Check maneuver has `type="attack"` and `status="committed"` |
| Reputation not changing | Verify Chronicle events being logged and persisted |
| Treaties not breaking | Ensure treaties loaded from DB before tick execution |
| Atomic transaction fails | Check DB in autocommit=False mode |
| Hull integrity <0 | Min-clamp in resolve_combat: hull = max(0, hull - damage) |
| Reputation out of bounds | Min/max clamped automatically |
| Missing event data | Check Chronicle log_event has event_data parameter |

## Performance Tips

1. Cache treaties by signatory for O(1) lookup
2. Batch chronicle writes with single DB insert
3. Skip irrelevant treaty checks (filter by status first)
4. Add database indexes on foreign keys
5. Parallel execution for independent games

## Important Notes

- **Atomicity**: All tick operations within single transaction
- **Order Matters**: Execute in specific sequence (see tick.py)
- **Reputation Bounded**: Always clamped to [-100, +100]
- **Combat Terminal**: Hull=0 means ship destroyed (removed from play)
- **Treaty Expiration**: Expired treaties cannot trigger violations
- **Factional Reputation**: Global (not per-faction relationships)

## See Also

- `COMBAT_TREATY_SYSTEM.md` - Full documentation
- `INTEGRATION_GUIDE.md` - Integration steps
- `IMPLEMENTATION_SUMMARY.md` - Overview
- `test_combat_treaties.py` - Example tests
