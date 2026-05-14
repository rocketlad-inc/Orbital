"""
Standing Orders System
======================

Conditional automation - orders that trigger based on game state.

Standing orders allow factions to set up conditional actions:
- "If rival faction near body X, launch from Y"
- "Maintain N ships at body Z"
- "Auto-resupply from ally when fuel < threshold"

Each tick, all standing orders are evaluated and matched actions are executed.
"""

from typing import Optional, Callable, Dict, Any
from dataclasses import dataclass
from enum import Enum

from .models import GameState, Faction, Ship, Body
from .chronicle import Chronicle


class OrderCondition(str, Enum):
    """Types of conditions for standing orders."""
    RIVAL_NEAR_BODY = "rival_near_body"
    FUEL_LOW = "fuel_low"
    BODY_UNDEFENDED = "body_undefended"
    TREATY_EXPIRES = "treaty_expires"


class OrderAction(str, Enum):
    """Types of actions for standing orders."""
    LAUNCH_FLEET = "launch_fleet"
    REINFORCE_BODY = "reinforce_body"
    RESUPPLY_SHIP = "resupply_ship"
    CANCEL_RESEARCH = "cancel_research"


@dataclass
class StandingOrder:
    """
    A conditional order that triggers based on game state.

    Example:
        condition_type: RIVAL_NEAR_BODY
        condition_data: {"body_id": "verda", "threat_radius": 500}
        action_type: LAUNCH_FLEET
        action_data: {"from_body_id": "inara", "fleet_size": 5}
    """
    id: str
    faction_id: str
    enabled: bool = True

    # Condition
    condition_type: OrderCondition
    condition_data: Dict[str, Any]

    # Action
    action_type: OrderAction
    action_data: Dict[str, Any]


def evaluate_condition(
    order: StandingOrder,
    state: GameState,
) -> bool:
    """
    Evaluate if a standing order's condition is met.

    Args:
        order: The standing order to evaluate
        state: Current game state

    Returns:
        True if condition is triggered
    """
    if not order.enabled:
        return False

    if order.condition_type == OrderCondition.RIVAL_NEAR_BODY:
        return _check_rival_near_body(order, state)
    elif order.condition_type == OrderCondition.FUEL_LOW:
        return _check_fuel_low(order, state)
    elif order.condition_type == OrderCondition.BODY_UNDEFENDED:
        return _check_body_undefended(order, state)
    elif order.condition_type == OrderCondition.TREATY_EXPIRES:
        return _check_treaty_expires(order, state)

    return False


def execute_action(
    order: StandingOrder,
    state: GameState,
    chronicle: Chronicle,
) -> bool:
    """
    Execute the action of a standing order.

    Args:
        order: The standing order whose action to execute
        state: Current game state (modified in-place)
        chronicle: Chronicle to log events

    Returns:
        True if action was executed successfully
    """
    if order.action_type == OrderAction.LAUNCH_FLEET:
        return _action_launch_fleet(order, state, chronicle)
    elif order.action_type == OrderAction.REINFORCE_BODY:
        return _action_reinforce_body(order, state, chronicle)
    elif order.action_type == OrderAction.RESUPPLY_SHIP:
        return _action_resupply_ship(order, state, chronicle)
    elif order.action_type == OrderAction.CANCEL_RESEARCH:
        return _action_cancel_research(order, state, chronicle)

    return False


def tick_standing_orders(
    state: GameState,
    chronicle: Chronicle,
) -> int:
    """
    Evaluate and execute all standing orders.

    Iterates through all standing orders, checks conditions,
    and executes matched actions.

    Args:
        state: Game state (modified in-place)
        chronicle: Chronicle to log events

    Returns:
        Number of standing orders triggered
    """
    triggered_count = 0

    # For now, standing orders are deferred - would need to load from DB
    # This structure shows how to integrate them
    for faction in state.factions:
        # Would load standing_orders from database
        # for order in db.get_standing_orders(faction.id):
        #     if evaluate_condition(order, state):
        #         if execute_action(order, state, chronicle):
        #             triggered_count += 1

        pass

    return triggered_count


# === Condition Checkers ===

def _check_rival_near_body(order: StandingOrder, state: GameState) -> bool:
    """Check if a rival faction has ships near a protected body."""
    body_id = order.condition_data.get("body_id")
    threat_radius = order.condition_data.get("threat_radius", 1000)

    # Find the body
    body = next((b for b in state.bodies if b.id == body_id), None)
    if not body:
        return False

    # Check if any rival ship is nearby
    # Would use orbital mechanics to compute distances
    # For now, return False (deferred)
    return False


def _check_fuel_low(order: StandingOrder, state: GameState) -> bool:
    """Check if a ship's fuel is below threshold."""
    ship_id = order.condition_data.get("ship_id")
    threshold = order.condition_data.get("threshold", 100)

    ship = next((s for s in state.ships if s.id == ship_id), None)
    if not ship:
        return False

    return ship.fuel < threshold


def _check_body_undefended(order: StandingOrder, state: GameState) -> bool:
    """Check if a body lacks defensive ships."""
    body_id = order.condition_data.get("body_id")
    min_ships = order.condition_data.get("min_ships", 1)

    # Count ships in this body's SOI
    # Would use orbital mechanics for SOI detection
    # For now, return False (deferred)
    return False


def _check_treaty_expires(order: StandingOrder, state: GameState) -> bool:
    """Check if a treaty is about to expire."""
    treaty_id = order.condition_data.get("treaty_id")
    expiry_ticks = order.condition_data.get("expiry_ticks", 5)

    # Would check treaty database for expiration
    # For now, return False (deferred)
    return False


# === Action Executors ===

def _action_launch_fleet(
    order: StandingOrder,
    state: GameState,
    chronicle: Chronicle,
) -> bool:
    """Launch a fleet from a body."""
    # Would create new ship objects and maneuver orders
    # For now, stub implementation
    return False


def _action_reinforce_body(
    order: StandingOrder,
    state: GameState,
    chronicle: Chronicle,
) -> bool:
    """Send ships to reinforce a body."""
    # Would create transfer maneuvers to target body
    # For now, stub implementation
    return False


def _action_resupply_ship(
    order: StandingOrder,
    state: GameState,
    chronicle: Chronicle,
) -> bool:
    """Resupply a ship from a friendly supply point."""
    # Would transfer fuel from body to ship
    # For now, stub implementation
    return False


def _action_cancel_research(
    order: StandingOrder,
    state: GameState,
    chronicle: Chronicle,
) -> bool:
    """Cancel active research."""
    # Would stop tech research for a faction
    # For now, stub implementation
    return False
