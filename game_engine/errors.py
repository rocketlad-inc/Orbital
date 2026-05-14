"""
Game Engine Errors
==================

Custom exception types for game engine operations.
"""


class GameEngineError(Exception):
    """Base exception for all game engine errors."""
    pass


class GameNotFoundError(GameEngineError):
    """Raised when a game cannot be found in the database."""
    pass


class InvalidStateError(GameEngineError):
    """Raised when game state is invalid or corrupted."""
    pass


class ManeuverExecutionError(GameEngineError):
    """Raised when a maneuver cannot be executed."""
    pass


class InsufficientResourcesError(GameEngineError):
    """Raised when a faction lacks resources for an operation."""
    pass


class TreatyViolationError(GameEngineError):
    """Raised when a treaty violation is detected."""
    pass


class PhysicsCalculationError(GameEngineError):
    """Raised when orbital mechanics calculations fail."""
    pass


class TransactionError(GameEngineError):
    """Raised when a database transaction fails."""
    pass
