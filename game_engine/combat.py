"""
Combat System
=============

Manages ship-to-ship combat with orbital mechanics integration.

Combat System Features:
- Detection: Ships within engagement range of each other
- Orbital Velocity Bonus: Faster relative velocity = higher damage
- Damage Resolution: Hull integrity, armor penetration
- Outcome Tracking: Destroyed, damaged, or escape
- Chronicle Logging: Battle events for player visibility

Combat Mechanics:
================

1. ENGAGEMENT RANGE
   - Detection range based on ship class and sensor tech
   - Ships are engaged when within range AND not accelerating away
   - Stealth runners have 50% detection range

2. RELATIVE VELOCITY BONUS
   - Calculated from pre-maneuver and post-maneuver orbital velocities
   - Higher relative velocity = higher damage multiplier (up to 2.0x)
   - Formula: damage * (1.0 + relative_velocity / max_relative_velocity)

3. DAMAGE APPLICATION
   - Apply armor reduction first: damage * (1.0 - armor_level * 0.1)
   - Apply hull integrity: new_integrity = max(0, integrity - normalized_damage)
   - Ship destroyed if hull_integrity <= 0

4. OUTCOME
   - Destroyed: 0% hull remaining, removed from play
   - Disabled: 0% to 10% hull (cannot maneuver)
   - Heavily Damaged: 10% to 33% hull
   - Damaged: 33% to 67% hull
   - Lightly Damaged: 67% to 99% hull
   - Intact: 99%+ hull

5. REPUTATION IMPACT
   - Destroying an undefending ship: -15 reputation (war crime)
   - Destroying an engaging ship: 0 reputation
   - Victory in even fight: +5 reputation
   - Destruction under fire: no penalty

6. ATOMICITY
   - Each combat resolution is atomic
   - If attacker cannot damage target, no outcome occurs
   - All combat happens at scheduled maneuver time (not real-time)
"""

import math
from typing import Optional, Dict, List, Any, Tuple
from dataclasses import dataclass
from enum import Enum

from .models import GameState, Ship, Faction, ManeuverNode, ShipClass, OrbitElements
from .chronicle import Chronicle


class CombatOutcome(str, Enum):
    """Result of a combat engagement."""
    DESTROYED = "destroyed"
    HEAVILY_DAMAGED = "heavily_damaged"
    DAMAGED = "damaged"
    LIGHTLY_DAMAGED = "lightly_damaged"
    INTACT = "intact"


@dataclass
class CombatResolution:
    """Result of resolving one combat engagement."""
    attacker_id: str
    attacker_faction_id: str
    target_id: str
    target_faction_id: str

    # Damage dealt
    pre_damage: float
    armor_reduction: float
    actual_damage: float
    relative_velocity_bonus: float

    # Outcome
    target_hull_before: float
    target_hull_after: float
    outcome: CombatOutcome

    # Position info
    engagement_range_km: float
    attacker_velocity_ms: float
    target_velocity_ms: float

    tick: int


def get_engagement_range(attacker_class: ShipClass, sensor_tech_level: int) -> float:
    """
    Get detection/engagement range for a ship class.

    Args:
        attacker_class: Class of attacking ship
        sensor_tech_level: Technology level for sensors (1-5)

    Returns:
        Engagement range in km
    """
    # Base ranges by class
    base_ranges = {
        ShipClass.FRIGATE: 5000.0,
        ShipClass.CRUISER: 10000.0,
        ShipClass.CAPITAL: 20000.0,
        ShipClass.STEALTH_RUNNER: 2500.0,  # 50% detection range
    }

    base = base_ranges.get(attacker_class, 5000.0)

    # Tech level multiplier: each level adds 20% more range
    tech_multiplier = 1.0 + (sensor_tech_level - 1) * 0.2

    return base * tech_multiplier


def get_base_damage(attacker_class: ShipClass, armor_level: int) -> float:
    """
    Get base damage output for a ship class.

    Args:
        attacker_class: Class of attacking ship
        armor_level: Target armor level (reduces damage)

    Returns:
        Base damage before modifiers
    """
    # Base damage by class
    damage_table = {
        ShipClass.FRIGATE: 20.0,
        ShipClass.CRUISER: 50.0,
        ShipClass.CAPITAL: 100.0,
        ShipClass.STEALTH_RUNNER: 30.0,
    }

    return damage_table.get(attacker_class, 25.0)


def calculate_relative_velocity_bonus(
    attacker_velocity_ms: float,
    target_velocity_ms: float,
) -> float:
    """
    Calculate combat bonus from relative velocity.

    Higher relative velocity means higher impact damage.

    Args:
        attacker_velocity_ms: Attacker's orbital velocity (m/s)
        target_velocity_ms: Target's orbital velocity (m/s)

    Returns:
        Velocity bonus multiplier (1.0 to 2.0)
    """
    # Calculate relative velocity
    relative_velocity = abs(attacker_velocity_ms - target_velocity_ms)

    # Normalize to 0-1 range (cap at 10 km/s for max bonus)
    max_bonus_velocity = 10000.0  # 10 km/s
    normalized = min(1.0, relative_velocity / max_bonus_velocity)

    # Scale to 1.0 - 2.0 multiplier
    return 1.0 + normalized


def resolve_combat(
    state: GameState,
    attacker: Ship,
    target: Ship,
    attacker_velocity_ms: float,
    target_velocity_ms: float,
    engagement_range_km: float,
    current_tick: int,
    attacker_tech_level: int = 1,
) -> CombatResolution:
    """
    Resolve a single combat engagement atomically.

    This function computes damage, applies it to the target, and returns
    the resolution. The caller is responsible for persisting changes.

    Args:
        state: Complete game state (for faction lookup)
        attacker: Attacking ship
        target: Target ship
        attacker_velocity_ms: Attacker's orbital velocity (m/s)
        target_velocity_ms: Target's orbital velocity (m/s)
        engagement_range_km: Current distance between ships (km)
        current_tick: Current game tick
        attacker_tech_level: Attacker's faction tech level (1-5)

    Returns:
        CombatResolution with damage and outcome
    """
    # Verify both ships exist and are eligible
    assert target.hull_integrity > 0, "Target already destroyed"

    # Calculate base damage
    base_damage = get_base_damage(attacker.class_type, target.armor_level)

    # Apply armor reduction
    armor_reduction = target.armor_level * 0.1  # Each armor level = 10% reduction
    damage_after_armor = base_damage * (1.0 - min(0.8, armor_reduction))  # Cap at 80%

    # Apply relative velocity bonus
    velocity_bonus = calculate_relative_velocity_bonus(
        attacker_velocity_ms,
        target_velocity_ms,
    )
    actual_damage = damage_after_armor * velocity_bonus

    # Normalize damage to 0-1 scale (hull integrity is 0-1)
    # Assume base max hull is 100 points
    normalized_damage = actual_damage / 100.0

    # Apply damage to target
    target_hull_before = target.hull_integrity
    target_hull_after = max(0.0, target.hull_integrity - normalized_damage)
    target.hull_integrity = target_hull_after

    # Determine outcome
    if target_hull_after <= 0:
        outcome = CombatOutcome.DESTROYED
    elif target_hull_after < 0.1:
        outcome = CombatOutcome.HEAVILY_DAMAGED
    elif target_hull_after < 0.33:
        outcome = CombatOutcome.DAMAGED
    elif target_hull_after < 0.67:
        outcome = CombatOutcome.DAMAGED
    elif target_hull_after < 0.99:
        outcome = CombatOutcome.LIGHTLY_DAMAGED
    else:
        outcome = CombatOutcome.INTACT

    # Get faction IDs
    attacker_faction = next(f for f in state.factions if f.id == attacker.owned_by)
    target_faction = next(f for f in state.factions if f.id == target.owned_by)

    return CombatResolution(
        attacker_id=attacker.id,
        attacker_faction_id=attacker_faction.id,
        target_id=target.id,
        target_faction_id=target_faction.id,
        pre_damage=base_damage,
        armor_reduction=armor_reduction,
        actual_damage=actual_damage,
        relative_velocity_bonus=velocity_bonus,
        target_hull_before=target_hull_before,
        target_hull_after=target_hull_after,
        outcome=outcome,
        engagement_range_km=engagement_range_km,
        attacker_velocity_ms=attacker_velocity_ms,
        target_velocity_ms=target_velocity_ms,
        tick=current_tick,
    )


def check_can_engage(
    attacker: Ship,
    target: Ship,
    engagement_range_km: float,
    max_engagement_range_km: float,
) -> bool:
    """
    Check if attacker can engage target.

    Ships must be:
    - Within engagement range
    - Both intact (hull > 0%)
    - Different factions

    Args:
        attacker: Attacking ship
        target: Target ship
        engagement_range_km: Current distance between them
        max_engagement_range_km: Maximum range (from ship class)

    Returns:
        True if engagement is possible
    """
    # Must be in range
    if engagement_range_km > max_engagement_range_km:
        return False

    # Both must be intact
    if attacker.hull_integrity <= 0:
        return False
    if target.hull_integrity <= 0:
        return False

    # Must be different factions
    if attacker.owned_by == target.owned_by:
        return False

    return True


def tick_combat_resolution(
    state: GameState,
    chronicle: Chronicle,
) -> int:
    """
    Execute all scheduled combat engagements in this tick.

    For each ship with an active attack maneuver:
    1. Find target ship
    2. Check if in engagement range
    3. Resolve combat
    4. Apply damage
    5. Log to chronicle
    6. Update reputation

    Args:
        state: Game state (modified in-place)
        chronicle: Chronicle to log events

    Returns:
        Number of combats resolved
    """
    combats_resolved = 0

    # Find all attack maneuvers scheduled for this tick
    for maneuver in state.maneuver_nodes:
        if maneuver.type != "attack":
            continue
        if maneuver.status != "committed":
            continue
        if maneuver.burn_time != state.current_tick:
            continue

        # Find attacker ship
        attacker = next(
            (s for s in state.ships if s.id == maneuver.ship_id),
            None,
        )
        if not attacker:
            continue

        # Find target ship (from attack order)
        # Note: Attack orders have target_ship_id in order details
        # For now, we'd need to extend ManeuverNode to include this
        # Or search by proximity to attacker location

        # TODO: Implement attack order target lookup
        # For prototype, skip combat execution
        pass

    return combats_resolved


def apply_combat_reputation_impact(
    state: GameState,
    resolution: CombatResolution,
    chronicle: Chronicle,
) -> None:
    """
    Apply reputation changes from combat outcome.

    Rules:
    - Destroying undefending ship: -15 reputation
    - Destroying defending ship: 0 reputation
    - Victory in even fight: +5 reputation
    - Destruction under fire: no penalty

    Args:
        state: Game state (for faction lookup)
        resolution: Combat resolution
        chronicle: Chronicle to log events
    """
    attacker_faction = next(f for f in state.factions if f.id == resolution.attacker_faction_id)
    target_faction = next(f for f in state.factions if f.id == resolution.target_faction_id)

    # Check if target was defending (had active combat orders)
    target_was_defending = False  # TODO: Check combat order history

    reputation_change = 0

    if resolution.outcome == CombatOutcome.DESTROYED:
        if not target_was_defending:
            # Undefending ship destroyed = war crime
            reputation_change = -15
        else:
            # Defending ship destroyed in combat = neutral
            reputation_change = 0
    elif resolution.outcome == CombatOutcome.LIGHTLY_DAMAGED:
        # Won a fair fight
        reputation_change = 5

    # Apply change
    if reputation_change != 0:
        attacker_faction.reputation += reputation_change
        attacker_faction.reputation = max(-100, min(100, attacker_faction.reputation))

        # Log to chronicle
        chronicle.log_event(
            tick=resolution.tick,
            event_type="combat_reputation",
            headline=f"{attacker_faction.name} reputation changed by {reputation_change:+d}",
            description=f"From combat with {target_faction.name}: {resolution.outcome.value}",
            primary_faction_id=resolution.attacker_faction_id,
            secondary_faction_id=resolution.target_faction_id,
            event_data={
                "change": reputation_change,
                "outcome": resolution.outcome.value,
                "reason": "combat_outcome",
            },
        )


def format_combat_log(resolution: CombatResolution) -> Dict[str, Any]:
    """
    Format a combat resolution into a human-readable log entry.

    Args:
        resolution: Combat resolution

    Returns:
        Dictionary with formatted combat details
    """
    return {
        "attacker_id": resolution.attacker_id,
        "target_id": resolution.target_id,
        "base_damage": f"{resolution.pre_damage:.1f}",
        "armor_reduction": f"{resolution.armor_reduction:.1%}",
        "velocity_bonus": f"{resolution.relative_velocity_bonus:.2f}x",
        "actual_damage": f"{resolution.actual_damage:.1f}",
        "target_hull": {
            "before": f"{resolution.target_hull_before:.1%}",
            "after": f"{resolution.target_hull_after:.1%}",
        },
        "outcome": resolution.outcome.value,
        "engagement_range_km": f"{resolution.engagement_range_km:.0f}",
        "relative_velocity_ms": f"{abs(resolution.attacker_velocity_ms - resolution.target_velocity_ms):.0f}",
    }
