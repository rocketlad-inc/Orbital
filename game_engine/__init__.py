"""
Orbital Game Engine
==================

Core game state management and daily tick processor.

This module provides the heartbeat of the game - executing one complete game tick
per day where all time-based events resolve atomically.

Key Features:
- Resource production from bodies
- Maneuver execution (orbital burns)
- Standing orders and conditional automation
- Treaty enforcement
- Tech research progression
- Reputation management
- Chronicle logging

Usage:
    from game_engine import execute_tick

    result = execute_tick(db, game_id, tick_number)
    print(result.chronicle_entries)
    print(result.state_delta)

Module Structure:
- tick.py: Main tick() entry point
- maneuvers.py: Execute maneuver orders
- resources.py: Resource production calculation
- standing_orders.py: Conditional automation
- treaties.py: Treaty enforcement
- tech.py: Tech research progression
- ownership.py: Body claim/transfer logic
- chronicle.py: Event logging
- errors.py: Custom exceptions
"""

__version__ = "0.1.0"

from .tick import execute_tick, TickResult
from .errors import GameEngineError

__all__ = ["execute_tick", "TickResult", "GameEngineError"]
