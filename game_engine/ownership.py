"""
Body Ownership System
====================

Handles claiming and transfer of celestial body ownership.

When a ship enters a body's SOI:
- If unowned: faction can claim it
- If owned by rival: potential combat situation (deferred to combat module)
- Updates body.owned_by when ownership changes
"""

from typing import Optional, Tuple
from .models import GameState, Body, Ship, Faction
from .chronicle import Chronicle


def can_claim_body(body: Body) -> bool:
    """
    Check if a body can be claimed (is currently unowned).

    Args:
        body: The body to check

    Returns:
        True if body is unowned and can be claimed
    """
    return body.owned_by is None


def claim_body(
    body: Body,
    faction: Faction,
    state: GameState,
    chronicle: Chronicle,
) -> bool:
    """
    Claim an unowned body for a faction.

    Args:
        body: The body to claim (must be unowned)
        faction: The faction claiming it
        state: Game state (for logging)
        chronicle: Chronicle to log the event

    Returns:
        True if claimed successfully
    """
    if body.owned_by is not None:
        return False

    body.owned_by = faction.id

    # Initialize resources if needed
    if not body.resources:
        body.resources = {
            "metal": 0,
            "fuel": 0,
            "gold": 0,
            "science": 0,
        }

    # Log in chronicle
    chronicle.log_body_claimed(
        tick=state.current_tick,
        faction_id=faction.id,
        body_id=body.id,
        body_name=body.name,
    )

    return True


def transfer_body_ownership(
    body: Body,
    from_faction: Faction,
    to_faction: Faction,
    state: GameState,
    chronicle: Chronicle,
) -> bool:
    """
    Transfer ownership of a body from one faction to another.

    Typically called after combat resolution.

    Args:
        body: The body to transfer
        from_faction: Current owner
        to_faction: New owner
        state: Game state
        chronicle: Chronicle to log the event

    Returns:
        True if transferred successfully
    """
    if body.owned_by != from_faction.id:
        return False

    body.owned_by = to_faction.id

    # Log in chronicle
    chronicle.log_body_captured(
        tick=state.current_tick,
        attacker_id=to_faction.id,
        defender_id=from_faction.id,
        body_id=body.id,
        body_name=body.name,
    )

    return True


def check_soi_entry(
    ship: Ship,
    body: Body,
) -> bool:
    """
    Check if a ship is now inside a body's sphere of influence.

    NOTE: In the full implementation, this would use orbital mechanics
    to compute the ship's position and check against body.soi.

    For now, this is a stub that returns False (SOI checking deferred
    to orbital mechanics module integration).

    Args:
        ship: The ship to check
        body: The body to check against

    Returns:
        True if ship is inside body's SOI
    """
    # TODO: Implement using orbital mechanics
    # Would compute ship position from orbit and check distance < body.soi
    return False


def get_bodies_owned_by_faction(state: GameState, faction_id: str) -> list:
    """
    Get all bodies owned by a faction.

    Args:
        state: Game state
        faction_id: ID of the faction

    Returns:
        List of bodies owned by the faction
    """
    return [b for b in state.bodies if b.owned_by == faction_id]


def get_unclaimed_bodies(state: GameState) -> list:
    """
    Get all unclaimed bodies.

    Args:
        state: Game state

    Returns:
        List of unowned bodies
    """
    return [b for b in state.bodies if b.owned_by is None]
