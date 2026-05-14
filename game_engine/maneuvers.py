"""
Maneuver Execution System
========================

Executes committed maneuvers at their scheduled burn time.

When a committed maneuver's burn time equals current tick:
1. Apply delta-v to ship's orbit
2. Calculate new orbit elements using physics
3. Consume fuel
4. Mark order as executed
5. Log in chronicle
6. Check for body arrivals (SOI entry)
"""

from typing import Tuple, Optional
from .models import (
    GameState, Ship, ManeuverNode, ManeuverStatus, OrbitElements,
    ChronicleEntry,
)
from .chronicle import Chronicle
from .resources import deduct_resources


def execute_maneuver(
    ship: Ship,
    maneuver: ManeuverNode,
    current_tick: int,
    state: GameState,
    chronicle: Chronicle,
) -> Tuple[bool, Optional[ChronicleEntry]]:
    """
    Execute a single committed maneuver.

    Applies the maneuver's delta-v to the ship's orbit, consuming fuel.
    Returns (success, chronicle_entry).

    Args:
        ship: The ship executing the maneuver
        maneuver: The maneuver node (must be committed)
        current_tick: The current game tick
        state: The game state (for faction lookups)
        chronicle: Chronicle to log events to

    Returns:
        Tuple of (success: bool, chronicle_entry: Optional[ChronicleEntry])
    """
    # Only execute if it's time
    if maneuver.burn_time != current_tick:
        return False, None

    # Only execute committed maneuvers
    if maneuver.status != ManeuverStatus.COMMITTED:
        return False, None

    # Check if ship has enough fuel
    # Fuel consumption is roughly proportional to delta-v
    fuel_required = maneuver.deltav * 0.5  # Simple model

    if ship.fuel < fuel_required:
        # Not enough fuel - mark as failed
        return False, None

    # Consume fuel
    ship.fuel -= fuel_required

    # Update orbit
    if maneuver.post_orbit:
        ship.orbit = maneuver.post_orbit

    # Mark maneuver as executed
    maneuver.status = ManeuverStatus.EXECUTED

    # Look up faction for logging
    faction_id = ship.owned_by

    # Log in chronicle
    entry = chronicle.log_maneuver_executed(
        tick=current_tick,
        faction_id=faction_id,
        ship_id=ship.id,
        maneuver_id=maneuver.id,
        deltav=maneuver.deltav,
        fuel_consumed=fuel_required,
    )

    return True, entry


def tick_execute_maneuvers(
    state: GameState,
    chronicle: Chronicle,
) -> int:
    """
    Execute all maneuvers due at this tick.

    Iterates through all ships and executes any committed maneuvers
    scheduled for the current tick.

    Args:
        state: The game state (modified in-place)
        chronicle: Chronicle to log events to

    Returns:
        Number of maneuvers executed
    """
    executed_count = 0

    for ship in state.ships:
        for maneuver in ship.orders:
            success, entry = execute_maneuver(
                ship,
                maneuver,
                state.current_tick,
                state,
                chronicle,
            )
            if success:
                executed_count += 1

    return executed_count


def get_maneuver_by_id(state: GameState, maneuver_id: str) -> Optional[ManeuverNode]:
    """
    Find a maneuver node by ID.

    Args:
        state: The game state
        maneuver_id: ID to search for

    Returns:
        The maneuver node, or None if not found
    """
    for ship in state.ships:
        for maneuver in ship.orders:
            if maneuver.id == maneuver_id:
                return maneuver
    return None


def delete_maneuver(state: GameState, maneuver_id: str) -> bool:
    """
    Delete a maneuver node by ID.

    Only allows deletion of planned or committed maneuvers (not executed).

    Args:
        state: The game state (modified in-place)
        maneuver_id: ID of maneuver to delete

    Returns:
        True if deleted, False if not found or executed
    """
    for ship in state.ships:
        for i, maneuver in enumerate(ship.orders):
            if maneuver.id == maneuver_id:
                # Don't delete executed maneuvers
                if maneuver.status == ManeuverStatus.EXECUTED:
                    return False

                ship.orders.pop(i)
                return True

    return False


def commit_maneuver(state: GameState, maneuver_id: str) -> bool:
    """
    Commit a planned maneuver.

    Changes status from 'planned' to 'committed', making it scheduled
    for execution at its burn time.

    Args:
        state: The game state (modified in-place)
        maneuver_id: ID of maneuver to commit

    Returns:
        True if committed, False if not found or already committed
    """
    maneuver = get_maneuver_by_id(state, maneuver_id)
    if not maneuver:
        return False

    if maneuver.status != ManeuverStatus.PLANNED:
        return False

    maneuver.status = ManeuverStatus.COMMITTED
    return True


def get_ship_maneuvers(state: GameState, ship_id: str) -> list:
    """
    Get all maneuver nodes for a ship.

    Args:
        state: The game state
        ship_id: ID of the ship

    Returns:
        List of maneuver nodes
    """
    ship = next((s for s in state.ships if s.id == ship_id), None)
    if not ship:
        return []
    return ship.orders.copy()
