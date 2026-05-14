"""
Economy System
==============

Manages all economic gameplay: ship production, body development, fuel transfers,
trading, and resource management.

Economy operates on production queues for all multi-tick activities:
- Ship production: Build new ships from metal/fuel/gold resources
- Development: Upgrade body development level to increase production
- Research: Advance technology level using science resources

All transactions are atomic within a single game tick.
"""

import uuid
from typing import Optional, Dict, List, Tuple
from .models import (
    GameState, Faction, Body, Ship, ShipClass, OrbitElements,
    SHIP_DESIGNS, BODY_PRODUCTION_RATES, BodyType
)
from .resources import deduct_resources, add_resources
from .chronicle import Chronicle


# Development upgrade costs: {level: {resource: cost}}
DEVELOPMENT_COSTS = {
    0: {"metal": 200, "gold": 100},      # level 0 -> 1
    1: {"metal": 400, "gold": 200},      # level 1 -> 2
    2: {"metal": 600, "gold": 400},      # level 2 -> 3
    3: {"metal": 800, "gold": 600},      # level 3 -> 4
    4: {"metal": 1000, "gold": 800},     # level 4 -> 5
}


def build_ship(
    state: GameState,
    faction: Faction,
    ship_class: ShipClass,
    body_id: str,
    chronicle: Chronicle,
) -> Tuple[bool, Optional[str]]:
    """
    Queue a new ship for production.

    Args:
        state: Game state (modified in-place)
        faction: Faction building the ship
        ship_class: Class of ship to build
        body_id: Body where ship is built
        chronicle: Chronicle to log events

    Returns:
        (success, queue_item_id)
    """
    design = SHIP_DESIGNS.get(ship_class)
    if not design:
        return False, None

    # Check resources
    cost = {
        "metal": design.metal_cost,
        "fuel": design.fuel_cost,
        "gold": design.gold_cost,
    }

    if not deduct_resources(faction, cost):
        return False, None

    # Create queue item
    queue_item_id = str(uuid.uuid4())
    queue_item = {
        "id": queue_item_id,
        "faction_id": faction.id,
        "type": "ship",
        "target_id": ship_class.value,  # Ship class
        "body_id": body_id,
        "progress_ticks": 0,
        "total_ticks": design.build_ticks,
    }

    # In production: would insert into production_queue table
    # For now, log and return success
    chronicle.log_event(
        tick=state.current_tick,
        event_type="ship_queued",
        headline=f"{ship_class.value.title()} Queued",
        description=f"Construction started at {body_id}. Completes in {design.build_ticks} ticks.",
        primary_faction_id=faction.id,
        body_id=body_id,
    )

    return True, queue_item_id


def complete_ship_production(
    state: GameState,
    faction: Faction,
    ship_class: ShipClass,
    body: Body,
    queue_item_id: str,
    chronicle: Chronicle,
) -> Tuple[bool, Optional[Ship]]:
    """
    Complete a ship production queue item and create the ship.

    Args:
        state: Game state (modified in-place)
        faction: Faction that built the ship
        ship_class: Class of ship being built
        body: Body where ship was built
        queue_item_id: Production queue item ID
        chronicle: Chronicle to log events

    Returns:
        (success, ship) - New ship instance if successful
    """
    design = SHIP_DESIGNS.get(ship_class)
    if not design:
        return False, None

    # Create ship with initial fuel
    ship_id = str(uuid.uuid4())
    ship = Ship(
        id=ship_id,
        name=f"{faction.name} {ship_class.value.title()}",
        class_type=ship_class,
        owned_by=faction.id,
        fuel=design.max_fuel,
        orbit=body.orbit if hasattr(body, 'orbit') else None,
    )

    # Add to game state
    if ship_id not in state.ships:
        state.ships[ship_id] = ship

    # Log completion
    chronicle.log_event(
        tick=state.current_tick,
        event_type="ship_completed",
        headline=f"{ship_class.value.title()} Completed",
        description=f"New {ship_class.value} completed at {body.name}. ID: {ship_id}",
        primary_faction_id=faction.id,
        body_id=body.id,
        ship_id=ship_id,
    )

    return True, ship


def upgrade_body_development(
    state: GameState,
    faction: Faction,
    body: Body,
    chronicle: Chronicle,
) -> Tuple[bool, str]:
    """
    Queue a body development upgrade.

    Args:
        state: Game state (modified in-place)
        faction: Faction upgrading the body
        body: Body to upgrade
        chronicle: Chronicle to log events

    Returns:
        (success, queue_item_id)
    """
    if body.development_level >= 5:
        return False, ""

    # Get cost for next level
    current_level = body.development_level
    cost = DEVELOPMENT_COSTS.get(current_level)
    if not cost:
        return False, ""

    # Check resources
    if not deduct_resources(faction, cost):
        return False, ""

    # Create queue item
    queue_item_id = str(uuid.uuid4())

    # In production: would insert into production_queue table
    # Build time: 3 ticks per development level
    build_ticks = 3 * (current_level + 1)

    chronicle.log_event(
        tick=state.current_tick,
        event_type="development_queued",
        headline=f"Development Upgrade: {body.name}",
        description=f"Upgrading {body.name} from level {current_level} to {current_level + 1}. "
                    f"Completes in {build_ticks} ticks.",
        primary_faction_id=faction.id,
        body_id=body.id,
    )

    return True, queue_item_id


def complete_body_development(
    state: GameState,
    faction: Faction,
    body: Body,
    chronicle: Chronicle,
) -> bool:
    """
    Complete a body development upgrade.

    Args:
        state: Game state (modified in-place)
        faction: Faction that owns the body
        body: Body being upgraded
        chronicle: Chronicle to log events

    Returns:
        Success
    """
    if body.development_level >= 5:
        return False

    old_level = body.development_level
    new_level = old_level + 1
    body.development_level = new_level

    chronicle.log_event(
        tick=state.current_tick,
        event_type="development_completed",
        headline=f"{body.name} Upgraded",
        description=f"Development level increased from {old_level} to {new_level}. "
                    f"Production increased by ~{10 * (new_level - old_level)}%.",
        primary_faction_id=faction.id,
        body_id=body.id,
    )

    return True


def transfer_fuel(
    state: GameState,
    faction: Faction,
    ship_id: str,
    body_id: str,
    amount: float,
    chronicle: Chronicle,
) -> bool:
    """
    Transfer fuel from a body to a ship.

    Args:
        state: Game state (modified in-place)
        faction: Faction performing the transfer
        ship_id: Ship receiving fuel
        body_id: Body providing fuel
        amount: Amount of fuel to transfer
        chronicle: Chronicle to log events

    Returns:
        Success
    """
    # Validate entities exist and faction owns both
    ship = state.ships.get(ship_id)
    body = state.bodies.get(body_id)

    if not ship or not body:
        return False

    if ship.owned_by != faction.id or body.owned_by != faction.id:
        return False

    # Check body has enough fuel
    if body.resources.get("fuel", 0) < amount:
        return False

    # Check ship has capacity
    if ship.fuel + amount > ship.max_fuel:
        # Transfer only what fits
        amount = ship.max_fuel - ship.fuel

    # Transfer
    body.resources["fuel"] = body.resources.get("fuel", 0) - amount
    ship.fuel += amount

    chronicle.log_event(
        tick=state.current_tick,
        event_type="fuel_transfer",
        headline="Fuel Transfer",
        description=f"Transferred {amount:.0f} fuel from {body.name} to {ship.name}.",
        primary_faction_id=faction.id,
        body_id=body_id,
        ship_id=ship_id,
    )

    return True


def initiate_trade(
    state: GameState,
    from_faction: Faction,
    to_faction: Faction,
    resource_type: str,
    amount: int,
    price_per_unit: int,
    chronicle: Chronicle,
) -> bool:
    """
    Execute a resource trade between two factions.

    Args:
        state: Game state (modified in-place)
        from_faction: Selling faction
        to_faction: Buying faction
        resource_type: Type of resource (metal, fuel, gold, science)
        amount: Quantity to trade
        price_per_unit: Price in gold per unit
        chronicle: Chronicle to log events

    Returns:
        Success
    """
    # Validate resources
    if from_faction.resources.get(resource_type, 0) < amount:
        return False

    total_cost = amount * price_per_unit
    if to_faction.resources.get("gold", 0) < total_cost:
        return False

    # Execute trade
    from_faction.resources[resource_type] -= amount
    to_faction.resources[resource_type] = to_faction.resources.get(resource_type, 0) + amount

    to_faction.resources["gold"] -= total_cost
    from_faction.resources["gold"] = from_faction.resources.get("gold", 0) + total_cost

    # Log both factions
    chronicle.log_event(
        tick=state.current_tick,
        event_type="trade_completed",
        headline="Trade Completed",
        description=f"Sold {amount} {resource_type} to {to_faction.name} for {total_cost} gold.",
        primary_faction_id=from_faction.id,
        secondary_faction_id=to_faction.id,
    )

    chronicle.log_event(
        tick=state.current_tick,
        event_type="trade_completed",
        headline="Trade Completed",
        description=f"Purchased {amount} {resource_type} from {from_faction.name} for {total_cost} gold.",
        primary_faction_id=to_faction.id,
        secondary_faction_id=from_faction.id,
    )

    return True


def get_ship_design(ship_class: ShipClass) -> Optional[Dict]:
    """
    Get the design specifications for a ship class.

    Args:
        ship_class: Ship class to look up

    Returns:
        Design dict with costs and build time, or None
    """
    design = SHIP_DESIGNS.get(ship_class)
    if design:
        return {
            "class_type": design.class_type.value,
            "metal_cost": design.metal_cost,
            "fuel_cost": design.fuel_cost,
            "gold_cost": design.gold_cost,
            "build_ticks": design.build_ticks,
            "max_fuel": design.max_fuel,
        }
    return None


def tick_advance_production_queue(
    state: GameState,
    chronicle: Chronicle,
) -> int:
    """
    Advance production queue items by one tick.

    For each production queue item:
    - Increment progress_ticks
    - If complete: create ship, upgrade body, or complete research

    Note: In production, queue items would be stored in database.
    For now, this is a stub for integration.

    Args:
        state: Game state (modified in-place)
        chronicle: Chronicle to log events

    Returns:
        Number of items completed
    """
    # TODO: In production, load from database production_queue table
    # For each item where progress_ticks < total_ticks:
    #   - increment progress_ticks
    #   - if complete, execute completion logic
    #   - remove from queue
    # For now, return 0 (no queue items)
    return 0
