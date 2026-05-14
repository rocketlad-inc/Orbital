# Combat and Treaty System Documentation

## Overview

This document describes the comprehensive combat and treaty system for Orbital, including:
- Ship-to-ship combat with orbital mechanics integration
- Multi-type treaty system with violation detection
- Reputation tracking with decay mechanics
- Atomic transaction handling for all operations
- Chronicle logging for player visibility

## Combat System

### Core Mechanics

The combat system resolves ship-to-ship engagements using realistic orbital mechanics:

1. **Detection and Engagement Range**
   - Ships are detected when within engagement range
   - Detection range depends on ship class and sensor technology level
   - Stealth runners have 50% detection range penalty

2. **Orbital Velocity Integration**
   - Relative velocity between ships affects damage output
   - Formula: `damage_multiplier = 1.0 + (relative_velocity / max_velocity)`
   - Maximum multiplier: 2.0x (at 10+ km/s relative velocity)
   - Encourages strategic positioning and maneuver timing

3. **Damage Calculation**
   - Base damage varies by attacker ship class:
     - Frigate: 20 damage
     - Cruiser: 50 damage
     - Capital: 100 damage
     - Stealth Runner: 30 damage
   - Armor reduces damage: `damage * (1.0 - armor_level * 0.1)` (max 80% reduction)
   - Velocity bonus applied after armor: `final_damage = damage_after_armor * velocity_multiplier`

4. **Combat Outcomes**
   - **Destroyed** (0% hull): Ship removed from play, crew lost
   - **Heavily Damaged** (0-10% hull): Cannot maneuver, combat disabled
   - **Damaged** (10-33% hull): Reduced maneuver capability, slow repairs
   - **Lightly Damaged** (33-67% hull): Full capability, slow repairs
   - **Intact** (67-99% hull): Minimal damage, repairs needed
   - **Undamaged** (99%+ hull): Combat had minimal effect

### Implementation

```python
# File: game_engine/combat.py

# Resolve a single combat
resolution = resolve_combat(
    state=game_state,
    attacker=attacking_ship,
    target=target_ship,
    attacker_velocity_ms=5000.0,  # Orbital velocity in m/s
    target_velocity_ms=3000.0,
    engagement_range_km=5000.0,
    current_tick=100,
    attacker_tech_level=2,
)

# Result includes:
# - Pre and post-damage values
# - Armor reduction applied
# - Velocity bonus multiplier
# - Final outcome (destroyed/damaged/etc)
# - All data needed for chronicle logging
```

### Reputation Impact

Combat outcomes affect reputation:

- **Destroying Undefending Ship**: -15 reputation (war crime)
  - Target had no active defense or combat orders
  - Indicates unprovoked aggression

- **Destroying Defending Ship**: 0 reputation
  - Target was actively defending or had combat orders active
  - Neutral outcome - expected in warfare

- **Tactical Victory**: +5 reputation
  - Won combat against similar-class opponent
  - Demonstrates skill and strength

- **Destruction Under Fire**: 0 reputation penalty
  - Your ship was destroyed while defending
  - Honorable sacrifice - no reputation loss

### Atomic Combat Resolution

All combat is atomic:
- If attacker cannot deal enough damage to penetrate shields, no outcome occurs
- If target is already destroyed, no additional combat can occur
- All combat happens at scheduled maneuver execution time (not real-time)
- Combat results are persisted in single database transaction

## Treaty System

### Treaty Types

#### 1. Non-Aggression Pact (NAP)

**Purpose**: Prevent direct conflict between signatories

**Terms**:
- Signatories cannot attack each other's ships or owned bodies
- Duration: Specified in treaty (can be indefinite)

**Violations**:
- Direct attack on signatory's ship
- Attack on signatory's owned body
- Attempting to capture signatory's facilities

**Penalty**: -20 reputation
**Effect**: Allows counter-attack without penalty, alliance offers from other factions

#### 2. Trade Agreement

**Purpose**: Enable resource transfer with cost benefits

**Terms**:
- Reduced resource transfer costs (reputation discount applies)
- Access to trade routes without taxation
- Guaranteed supply availability

**Violations**:
- Blocking trade routes
- Preventing resource transfer
- Embargoes on signatory goods

**Penalty**: -10 reputation
**Effect**: Automatic contract cancellation, trade costs revert to premium

#### 3. Military Alliance

**Purpose**: Combined defense and mutual support

**Terms**:
- Signatories provide defense when ally under attack
- Can use each other's facilities for resupply
- Combined intelligence sharing
- Shared research advancement (slower than solo)

**Violations**:
- Failing to defend ally when under attack
- Attacking another alliance member
- Sharing alliance intelligence with enemies

**Penalty**: -30 reputation
**Effect**: Ally gains +20 reputation (breaks trust), loss of all alliance benefits

#### 4. Research Cooperation

**Purpose**: Accelerated tech advancement through partnership

**Terms**:
- Shared research costs (reduced by 20%)
- Automatic tech sync when either party researches
- Mutual protection of research facilities

**Violations**:
- Refusing to share completed research
- Attacking research facilities
- Stealing tech through espionage

**Penalty**: -5 reputation
**Effect**: Cooperation suspended, tech sync disabled

#### 5. Demilitarization Zone (DMZ)

**Purpose**: Create neutral territory free of military presence

**Terms**:
- Specified celestial body marked as DMZ
- Only authorized signatories may station military units
- Civilian/commercial vessels always permitted
- Regular inspections allowed

**Violations**:
- Moving military ship into zone as non-authorized faction
- Building military facilities in zone
- Launching attacks from zone boundaries

**Penalty**: -15 reputation per tick in violation
**Effect**: Continues accumulating while violation active, other factions may enforce DMZ

#### 6. Technology Sharing

**Purpose**: Mandatory tech level synchronization

**Terms**:
- Both parties must maintain same tech level
- Automatic tech updates to match highest party
- Costs shared equally
- Can only use researched technologies

**Violations**:
- Hiding or delaying tech level advancement
- Refusing tech upgrade request
- Hoarding exclusive technologies

**Penalty**: -5 reputation
**Effect**: Tech sharing suspended, automatic sync disabled

#### 7. Mining Rights

**Purpose**: Exclusive mining access to resource-rich bodies

**Terms**:
- Specified body designated for exclusive mining
- Only authorized factions may extract resources
- Non-authorized factions cannot mine or claim body
- May be limited to specific resource types

**Violations**:
- Unauthorized mining from protected body
- Claiming protected body
- Transporting mined resources off-world

**Penalty**: -10 reputation
**Effect**: Mining halted, resources seized, faction marked as thief

### Violation Detection

Violations are detected at tick execution time:

```python
# Atomic violation check for NAP
violated, code = check_nap_violation_extended(
    treaty=nap_treaty,
    attacker_faction_id="faction_a",
    defender_faction_id="faction_b",
    current_tick=current_tick,
)

if violated:
    apply_violation_penalty(faction_a, "direct_attack")
    chronicle.log_treaty_event(..., "broken", "non_aggression_pact")
```

**Key Properties**:
- All violations checked atomically (all-or-nothing)
- Expiration checked first (expired treaties don't trigger violations)
- Violation only if both parties are signatories
- Violations log to chronicle with full details

### Treaty Status Progression

```
Proposed → Active → (Broken | Expired | Cancelled)
           ↓
         Broken
```

- **Proposed**: Awaiting faction acceptance (not enforced)
- **Active**: Currently in effect, violations checked
- **Broken**: Violation occurred, treaty terminated
- **Expired**: Duration elapsed naturally, no violation
- **Cancelled**: Mutually agreed termination, no reputation penalty

## Reputation System

### Reputation Scale

```
     -100  Pariah                  Cannot form any treaties
      -80  Enemy                   Cannot diplomacy, enemies everywhere
      -50  Distrusted             Heavy penalties, treaties rejected
      -20  Neutral (Minimum)      Can form treaties, but not alliances
        0  Neutral (Center)       Baseline for new factions
       +20  Trusted               Alliance eligible
       +50  Respected Ally        Strong benefits, trusted trades
       +80  Beloved Hero          Maximum benefits, sought-after ally
      +100
```

### Reputation Changes

#### Penalty Events
- **Treaty Violation**: -5 to -30 (varies by type)
- **Unprovoked Attack**: -15
- **Alliance Betrayal**: -30
- **Broken Promise**: -10
- **Destruction of Undefending Ship**: -20
- **Captured Unarmed Ship**: -10

#### Boost Events
- **Successful Trade**: +2
- **Treaty Honored** (per tick): +0.1
- **Defended Ally Under Attack**: +5
- **Fair Victory in Combat**: +5
- **Resource Gift**: +3
- **Tech Cooperation**: +2

### Reputation Decay

**Negative Reputation Recovery**:
- Recovers toward 0 at +0.5 per tick
- Encourages good behavior even after violations
- Minimum recovery speed prevents permanent pariah status

**Positive Reputation Fade**:
- Decays toward 0 at -0.2 per tick (slower)
- Encourages continuous good behavior
- Decay pauses if active military alliance

**Incentive Design**:
- One-time help not enough (reputation fades)
- Ongoing treaties keep reputation high (by honoring them)
- Violations have immediate heavy cost
- Recovery is slow but steady (redemption possible)

### Reputation Effects

#### Trade Costs
```
Reputation  →  Cost Modifier
+100        →  0.50x (50% discount)
+50         →  0.75x (25% discount)
  0         →  1.00x (baseline)
-50         →  1.25x (25% premium)
-100        →  1.50x (50% premium)
```

#### Treaty Formation
- **Basic Treaty**: Requires minimum -20 reputation
- **Alliance**: Requires minimum +20 reputation
- **Tech Sharing**: Requires minimum +10 reputation

#### Voting Power
- Positive reputation: +0.1 per point (max +10 votes)
- Negative reputation: -0.1 per point (min -10 votes)
- Neutrals: 1 vote each

#### Victory Conditions
- Negative reputation makes victory much harder
- Required to reach positive net reputation for some endings
- High reputation unlocks diplomatic victory path

## Chronicle Logging

### Event Types Logged

#### Combat Events
- **combat**: Ship-to-ship engagement
  - `attacker_id`: Ship ID
  - `target_id`: Target ship ID
  - `outcome`: destroyed|damaged|lightly_damaged|intact
  - `damage_dealt`: Normalized 0-1 value
  - `target_hull_after`: Hull integrity percentage

#### Treaty Events
- **treaty_signed**: New treaty established
  - `treaty_type`: Type of treaty
  - `signatories`: Array of faction IDs

- **treaty_broken**: Treaty violation or termination
  - `treaty_type`: Type of treaty
  - `violator`: Faction that broke it
  - `reason`: Violation reason code

- **treaty_expired**: Treaty reached natural end
  - `treaty_type`: Type
  - `duration`: Ticks active

#### Reputation Events
- **reputation_change**: Faction reputation modified
  - `old_reputation`: Previous value
  - `new_reputation`: New value
  - `reason`: Change reason code
  - `delta`: Amount changed

#### Other Events
- **standing_order_executed**: Automated action triggered
- **production_accumulated**: Resources generated
- **maneuver_executed**: Ship burn completed
- **tech_researched**: Technology unlocked
- **body_claimed**: Unclaimed body taken
- **body_captured**: Body conquered from enemy

### Chronicle Visibility

All players see:
- All combat events (fog of war doesn't hide combat)
- All treaty events (public record)
- Own faction's reputation changes
- Public body/ship status changes
- Global tech breakthroughs
- Democratic vote results

Players DON'T see:
- Enemy production details
- Enemy maneuver plans (until executed)
- Private messages between other factions
- Standing orders of other factions
- Resource counts on unvisited bodies

## Atomic Transaction Handling

All game state changes are atomic:

```python
def execute_tick(db, game_id, tick):
    """Execute one tick atomically."""
    
    try:
        # Load state
        state = db.load_game_state(game_id)
        
        # Execute in order:
        # 1. Maneuvers (changes orbits)
        # 2. SOI transitions (ships at new locations)
        # 3. Standing orders (conditional actions)
        # 4. Resource production (uses body ownership)
        # 5. COMBAT RESOLUTION (our new system)
        # 6. Treaty enforcement (violation detection)
        # 7. Tech research (advancement)
        # 8. Reputation decay (natural recovery)
        
        # Persist atomically
        db.begin_transaction()
        db.save_game_state(state)
        db.save_chronicle_entries(chronicle.all_entries())
        db.commit_transaction()
        
    except Exception as e:
        db.rollback_transaction()
        raise
```

**Key Properties**:
- All-or-nothing execution (no partial ticks)
- No race conditions (single tick at a time)
- Resumable after server crash (tick state tracked in DB)
- Chronicle consistent with game state
- Orders of operations deterministic and fixed

## Integration with Tick Engine

The combat and treaty systems integrate into the main tick execution:

### Tick Execution Order (Updated)

```
1. Load game state from database
2. Execute maneuvers (orbital burns)
3. Check SOI transitions (body arrivals)
4. Execute standing orders (conditional automation)
5. Accumulate resource production
6. *** EXECUTE COMBAT (NEW) ***
7. *** ENFORCE TREATIES (ENHANCED) ***
8. Advance tech research
9. Update reputation (decay/recovery) (ENHANCED)
10. Generate chronicle entries (ENHANCED)
11. Persist all state changes in atomic transaction
12. Broadcast state delta to frontend
```

### Required Database Changes

Treaty system requires new schema tables:
- `treaties`: Treaty definitions
- `reputation_logs`: History of reputation changes
- `combat_logs`: Detailed combat records

All schema already defined in `schema.sql`.

## Testing

Comprehensive test suite in `test_combat_treaties.py`:

```python
# Combat tests
TestCombatResolution:
  - Engagement range calculation
  - Damage calculation with velocity bonus
  - Armor damage reduction
  - Combat outcome determination
  - Hull integrity tracking

# Treaty violation tests
TestTreatyViolations:
  - NAP violation detection
  - Alliance betrayal detection
  - DMZ zone violation
  - Mining rights violation
  - Penalty application

# Reputation tests
TestReputationSystem:
  - Reputation changes (positive/negative)
  - Reputation bounds enforcement
  - Decay mechanics (positive/negative)
  - Treaty formation eligibility
  - Alliance formation eligibility
  - Reputation levels and descriptions

# Chronicle tests
TestChronicleLogging:
  - Combat event logging
  - Treaty event logging
  - Generic event logging
  - Event data completeness
```

Run tests with:
```bash
python -m pytest test_combat_treaties.py -v
```

## Performance Considerations

### Scalability

For 8 concurrent games with ~50 factions each:
- Combat resolution: ~1ms per engagement (linear with # combats)
- Treaty checking: ~10ms per game (fixed set of treaties)
- Reputation decay: <1ms (linear with faction count)
- Chronicle logging: <1ms (append operations)

**Target**: < 5 seconds per tick across all games

### Optimization Techniques

1. **Batch Combat**: Resolve all combats in single pass
2. **Indexed Treaty Checks**: Pre-compute signatory lookups
3. **Reputation Cached**: Compute decay once per faction per tick
4. **Chronicle Buffered**: Batch write entries to database

## Future Extensions

Potential enhancements:

1. **Conditional Treaties**
   - Territory-specific terms
   - Conditional activation based on events
   - Escalation clauses (penalties increase over time)

2. **Treaty Renegotiation**
   - Change terms during active treaty
   - Cost modifiers for changes
   - Faction veto rights

3. **Fleet Combat**
   - Multi-ship engagements
   - Squad tactics and formations
   - Fleet command bonuses

4. **Economic Warfare**
   - Trade route interdiction
   - Resource embargoes
   - Tariffs and tolls

5. **Espionage and Sabotage**
   - Covert operations
   - Tech theft
   - Infrastructure destruction

6. **Diplomatic Resolution**
   - Negotiation outcomes
   - Third-party mediation
   - War crimes tribunal
