"""
Technology Research System
==========================

Manages tech advancement and research progression.

Each faction has a tech level (1-5) and can research new technologies.
Research progresses incrementally each tick, with completion unlocking
bonuses to production, movement, and combat.

Research Queue:
- Each faction has at most one active research project
- Progress accumulates each tick based on science resources
- When complete, tech level increases and gains are logged

Tech Levels affect:
- Resource production (+10% per level)
- Fuel efficiency (enables better maneuver planning)
- Combat bonuses (weapons, shields, armor)
"""

from typing import Optional, Dict, Any
from dataclasses import dataclass

from .models import GameState, Faction
from .chronicle import Chronicle


@dataclass
class ResearchProject:
    """An active research project."""
    id: str
    faction_id: str
    tech_name: str
    target_level: int  # 1-5
    progress: int  # 0-100
    science_cost: int  # Total science required


# Research costs to reach each level
TECH_COSTS = {
    1: 500,      # Starting tech
    2: 1500,     # Industrial age
    3: 3000,     # Information age
    4: 6000,     # Space age
    5: 12000,    # Interstellar age
}


def get_research_project(
    state: GameState,
    faction_id: str,
) -> Optional[ResearchProject]:
    """
    Get the active research project for a faction.

    In the full implementation, would load from database.

    Args:
        state: Game state
        faction_id: ID of the faction

    Returns:
        The active research project, or None
    """
    # TODO: Load from database
    return None


def start_research(
    faction: Faction,
    target_level: int,
) -> bool:
    """
    Start a new research project for a faction.

    Can only have one active project at a time.

    Args:
        faction: The faction starting research
        target_level: Tech level to research (1-5)

    Returns:
        True if research started successfully
    """
    if target_level < 1 or target_level > 5:
        return False

    if target_level <= faction.tech_level:
        return False  # Already researched

    # Check science cost
    cost = TECH_COSTS.get(target_level, 0)
    if faction.resources.get("science", 0) < cost:
        return False  # Insufficient science

    # Deduct cost
    faction.resources["science"] -= cost

    # TODO: Create research project and store in database

    return True


def tick_tech_research(
    state: GameState,
    chronicle: Chronicle,
) -> int:
    """
    Advance all active research projects.

    Each faction's research project gains progress based on available
    science resources. When progress reaches 100%, tech level increases.

    Args:
        state: Game state (modified in-place)
        chronicle: Chronicle to log events

    Returns:
        Number of research projects completed
    """
    completed = 0

    for faction in state.factions:
        # Would load active research project from database
        # project = get_research_project(state, faction.id)
        # if project:
        #     # Allocate science to research
        #     science_available = faction.resources.get("science", 0)
        #     if science_available > 0:
        #         # Simple model: 10 science per tick
        #         progress_rate = min(10, science_available)
        #         project.progress += progress_rate
        #         faction.resources["science"] -= progress_rate
        #
        #         # Check for completion
        #         if project.progress >= 100:
        #             faction.tech_level = project.target_level
        #             completed += 1
        #             chronicle.log_tech_researched(...)

        pass

    return completed


def get_tech_bonuses(tech_level: int) -> Dict[str, float]:
    """
    Get all bonuses for a given tech level.

    Args:
        tech_level: Tech level (1-5)

    Returns:
        Dictionary of bonus modifiers
    """
    bonuses = {
        1: {
            "production": 1.0,
            "fuel_efficiency": 1.0,
            "weapon_power": 1.0,
            "sensor_range": 1.0,
        },
        2: {
            "production": 1.1,
            "fuel_efficiency": 1.15,
            "weapon_power": 1.1,
            "sensor_range": 1.2,
        },
        3: {
            "production": 1.2,
            "fuel_efficiency": 1.3,
            "weapon_power": 1.2,
            "sensor_range": 1.4,
        },
        4: {
            "production": 1.3,
            "fuel_efficiency": 1.45,
            "weapon_power": 1.3,
            "sensor_range": 1.6,
        },
        5: {
            "production": 1.4,
            "fuel_efficiency": 1.6,
            "weapon_power": 1.4,
            "sensor_range": 1.8,
        },
    }

    return bonuses.get(tech_level, bonuses[1])
