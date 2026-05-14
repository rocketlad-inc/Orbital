"""
Resource Production System
==========================

Calculates and applies resource production from controlled bodies.

Every owned body generates resources per tick based on:
- Body type (terrestrial, gas_giant, moon, asteroid, lagrange_station)
- Development level (0-5)
- Owner's tech level
- Base production rates from BODY_PRODUCTION_RATES

Production happens atomically at the start of each tick.
"""

from typing import Dict
from .models import (
    GameState, Body, Faction, ChronicleEntry, BODY_PRODUCTION_RATES, BodyType
)
from .chronicle import Chronicle


def calculate_body_production(
    body: Body,
    faction_tech_level: int,
    development_level: int = 1,
) -> Dict[str, int]:
    """
    Calculate per-tick resource generation for one body.

    Args:
        body: The celestial body
        faction_tech_level: Owner's tech level (1-5, default 1)
        development_level: Infrastructure level on body (0-5, default 1)

    Returns:
        Dictionary of {resource_type: amount_per_tick}
    """
    # Get base production for this body type
    base_rates = BODY_PRODUCTION_RATES.get(body.type, {})
    if development_level not in base_rates:
        # Clamp to valid range
        development_level = max(0, min(5, development_level))

    base = base_rates.get(development_level, {
        "metal": 0,
        "fuel": 0,
        "gold": 0,
        "science": 0,
    })

    # Apply tech modifier (each tech level adds ~10% bonus)
    tech_modifier = 1.0 + (faction_tech_level - 1) * 0.1

    # Round down to integers
    production = {
        resource: max(0, int(amount * tech_modifier))
        for resource, amount in base.items()
    }

    return production


def tick_resource_production(
    state: GameState,
    chronicle: Chronicle,
) -> None:
    """
    Execute resource production for all owned bodies.

    Iterates through all bodies and adds resources to owning factions.
    Logs all production in the chronicle.

    Args:
        state: Current game state (modified in-place)
        chronicle: Chronicle to log events to
    """
    # Create faction lookup by ID
    faction_map = {f.id: f for f in state.factions}

    for body in state.bodies:
        # Skip unowned bodies
        if not body.owned_by:
            continue

        faction = faction_map.get(body.owned_by)
        if not faction:
            continue

        # Get development level from body (stored in resources for now)
        # In production, this would be a separate field on Body
        development_level = getattr(body, 'development_level', 1)

        # Calculate production
        production = calculate_body_production(
            body,
            faction.tech_level,
            development_level,
        )

        # Add to faction resources
        for resource, amount in production.items():
            faction.resources[resource] = faction.resources.get(resource, 0) + amount

        # Log in chronicle
        chronicle.log_production(
            tick=state.current_tick,
            faction_id=faction.id,
            body_id=body.id,
            resources=production,
        )


def get_faction_resource_total(faction: Faction) -> Dict[str, int]:
    """
    Get the current total resources for a faction.

    Args:
        faction: The faction

    Returns:
        Dictionary of {resource: total_amount}
    """
    return faction.resources.copy()


def deduct_resources(
    faction: Faction,
    resources: Dict[str, int],
) -> bool:
    """
    Attempt to deduct resources from a faction.

    Args:
        faction: The faction
        resources: Resources to deduct {resource: amount}

    Returns:
        True if resources were successfully deducted, False if insufficient
    """
    # Check if faction has enough resources
    for resource, amount in resources.items():
        if faction.resources.get(resource, 0) < amount:
            return False

    # Deduct resources
    for resource, amount in resources.items():
        faction.resources[resource] = faction.resources.get(resource, 0) - amount

    return True


def add_resources(
    faction: Faction,
    resources: Dict[str, int],
) -> None:
    """
    Add resources to a faction.

    Args:
        faction: The faction
        resources: Resources to add {resource: amount}
    """
    for resource, amount in resources.items():
        faction.resources[resource] = faction.resources.get(resource, 0) + amount
