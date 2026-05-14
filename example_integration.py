"""
Example integration showing how to use the game engine in a real application.

This module demonstrates:
- Setting up the database
- Creating and initializing a game
- Running the main game loop
- Broadcasting events to players
- Handling errors gracefully
"""

import logging
import json
import uuid
from datetime import datetime
from typing import Dict, List, Any, Optional

from game_engine import GameEngine, ChronicleEventType
from database_adapters import DatabaseFactory, init_schema

logger = logging.getLogger(__name__)


# ============================================================================
# Game Manager
# ============================================================================


class GameManager:
    """
    High-level manager for game lifecycle.

    Handles:
    - Game creation and configuration
    - Tick execution loop
    - Event broadcasting
    - Error recovery
    """

    def __init__(self, db_config: Dict[str, Any]):
        """
        Initialize game manager.

        Args:
            db_config: Database configuration dict
        """
        self.db = DatabaseFactory.create(db_config)
        self.engine = GameEngine(self.db)
        self.listeners = []  # Event listeners

    def register_listener(self, listener):
        """Register a listener for game events."""
        self.listeners.append(listener)

    def _broadcast_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Broadcast event to all listeners."""
        for listener in self.listeners:
            try:
                listener.on_event(event_type, data)
            except Exception as e:
                logger.error(f"Listener error: {e}")

    def create_game(
        self,
        name: str,
        max_ticks: int = 10000,
        factions: List[Dict[str, Any]] = None,
    ) -> str:
        """
        Create a new game.

        Args:
            name: Game name
            max_ticks: Maximum ticks before game ends
            factions: List of faction configs

        Returns:
            Game ID
        """
        game_id = str(uuid.uuid4())

        self.db.begin_transaction()
        try:
            # Create game
            self.db.execute(
                "INSERT INTO games (id, name, startTime, currentTick, status, maxTicks) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [game_id, name, datetime.now(), 0, "active", max_ticks],
            )

            # Create factions
            if factions:
                for faction_config in factions:
                    faction_id = str(uuid.uuid4())
                    self.db.execute(
                        "INSERT INTO factions (id, gameId, userId, name, color, reputation) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        [
                            faction_id,
                            game_id,
                            faction_config.get("userId"),
                            faction_config.get("name"),
                            faction_config.get("color", "#000000"),
                            50.0,  # Starting reputation
                        ],
                    )

                    # Create resource inventory
                    res_id = str(uuid.uuid4())
                    self.db.execute(
                        "INSERT INTO resources (id, gameId, factionId, metal, fuel, gold, science) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        [
                            res_id,
                            game_id,
                            faction_id,
                            faction_config.get("startingMetal", 500),
                            faction_config.get("startingFuel", 250),
                            faction_config.get("startingGold", 100),
                            faction_config.get("startingScience", 150),
                        ],
                    )

            # Create tick execution state
            self.db.execute(
                "INSERT INTO tick_execution_state (id, gameId, currentTick, lastCompletedTick, executionStatus) "
                "VALUES (?, ?, ?, ?, ?)",
                [str(uuid.uuid4()), game_id, 0, -1, "idle"],
            )

            self.db.commit()
            logger.info(f"Created game {game_id}: {name}")
            self._broadcast_event("game_created", {"gameId": game_id, "name": name})

        except Exception as e:
            self.db.rollback()
            logger.error(f"Failed to create game: {e}")
            raise

        return game_id

    def run_tick(self, game_id: str, tick: int) -> bool:
        """
        Execute one game tick.

        Args:
            game_id: Game ID
            tick: Tick number

        Returns:
            True if successful, False otherwise
        """
        logger.info(f"Running tick {tick} for game {game_id}")

        try:
            result = self.engine.execute_tick(game_id, tick)

            if result.success:
                logger.info(
                    f"Tick {tick} successful: {result.eventsLogged} events in "
                    f"{result.executionTime:.3f}s"
                )

                # Broadcast chronicle events
                for entry in result.chronicle:
                    self._broadcast_event("chronicle_event", {
                        "tick": entry.tick,
                        "type": entry.eventType.value,
                        "displayText": entry.displayText,
                        "data": entry.data,
                    })

                return True
            else:
                logger.error(f"Tick {tick} failed: {result.errors}")
                self._broadcast_event("tick_failed", {
                    "gameId": game_id,
                    "tick": tick,
                    "errors": result.errors,
                })
                return False

        except Exception as e:
            logger.error(f"Unexpected error in tick {tick}: {e}")
            self._broadcast_event("tick_error", {
                "gameId": game_id,
                "tick": tick,
                "error": str(e),
            })
            return False

    def run_game_loop(self, game_id: str, max_consecutive_failures: int = 3) -> None:
        """
        Run the main game loop from current tick to max ticks.

        Args:
            game_id: Game ID
            max_consecutive_failures: Stop after this many consecutive tick failures
        """
        # Get game state
        game_data = self.db.query(
            "SELECT currentTick, maxTicks, status FROM games WHERE id = ?",
            [game_id],
        )
        if not game_data:
            logger.error(f"Game {game_id} not found")
            return

        current_tick = game_data[0]["currentTick"]
        max_ticks = game_data[0]["maxTicks"]
        failures = 0

        logger.info(f"Starting game loop for {game_id} from tick {current_tick}")
        self._broadcast_event("game_loop_started", {
            "gameId": game_id,
            "startTick": current_tick,
            "maxTicks": max_ticks,
        })

        for tick in range(current_tick, max_ticks):
            if not self.run_tick(game_id, tick):
                failures += 1
                if failures >= max_consecutive_failures:
                    logger.error(f"Too many failures, stopping game loop")
                    self._broadcast_event("game_loop_stopped", {
                        "gameId": game_id,
                        "reason": "max_failures",
                        "tick": tick,
                    })
                    return
            else:
                failures = 0

            # Update game tick counter
            self.db.execute(
                "UPDATE games SET currentTick = ? WHERE id = ?",
                [tick + 1, game_id],
            )

        logger.info(f"Game loop completed for {game_id}")
        self._broadcast_event("game_loop_completed", {
            "gameId": game_id,
            "finalTick": max_ticks,
        })

    def get_game_state(self, game_id: str) -> Dict[str, Any]:
        """
        Get current game state.

        Args:
            game_id: Game ID

        Returns:
            Game state dictionary
        """
        games = self.db.query("SELECT * FROM games WHERE id = ?", [game_id])
        if not games:
            return None

        game = games[0]
        factions = self.db.query("SELECT * FROM factions WHERE gameId = ?", [game_id])
        bodies = self.db.query("SELECT * FROM bodies WHERE gameId = ?", [game_id])
        ships = self.db.query("SELECT * FROM ships WHERE gameId = ?", [game_id])

        return {
            "game": game,
            "factions": factions,
            "bodies": bodies,
            "ships": ships,
        }


# ============================================================================
# Event Listeners
# ============================================================================


class GameEventListener:
    """Base class for game event listeners."""

    def on_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Handle game event."""
        raise NotImplementedError


class LoggingListener(GameEventListener):
    """Simple listener that logs all events."""

    def on_event(self, event_type: str, data: Dict[str, Any]) -> None:
        logger.info(f"[{event_type}] {json.dumps(data)}")


class WebsocketBroadcaster(GameEventListener):
    """Example listener that would broadcast to WebSocket clients."""

    def on_event(self, event_type: str, data: Dict[str, Any]) -> None:
        # In a real app, this would broadcast to connected WebSocket clients
        # For demo, we just log
        logger.debug(f"[WS Broadcast] {event_type}: {data}")


# ============================================================================
# Example Usage
# ============================================================================


def example_single_game():
    """Example: Create and run a single game."""
    logging.basicConfig(level=logging.INFO)

    # Create game manager
    db_config = {
        "type": "sqlite",
        "path": "orbital_example.db"
    }
    manager = GameManager(db_config)

    # Initialize database
    init_schema(manager.db)

    # Register listeners
    manager.register_listener(LoggingListener())
    manager.register_listener(WebsocketBroadcaster())

    # Create game with two factions
    game_id = manager.create_game(
        name="Test Game",
        max_ticks=10,
        factions=[
            {
                "userId": "user_1",
                "name": "Terra Federation",
                "color": "#0066cc",
                "startingMetal": 500,
                "startingFuel": 250,
                "startingGold": 100,
                "startingScience": 150,
            },
            {
                "userId": "user_2",
                "name": "Mars Collective",
                "color": "#cc0000",
                "startingMetal": 450,
                "startingFuel": 200,
                "startingGold": 80,
                "startingScience": 120,
            },
        ],
    )

    # Run game loop
    manager.run_game_loop(game_id)

    # Get final state
    state = manager.get_game_state(game_id)
    print(f"\nFinal game state:")
    print(f"  Status: {state['game']['status']}")
    print(f"  Final tick: {state['game']['currentTick']}")
    print(f"  Factions: {len(state['factions'])}")


def example_resume_game():
    """Example: Resume a previously started game."""
    logging.basicConfig(level=logging.INFO)

    db_config = {"type": "sqlite", "path": "orbital_example.db"}
    manager = GameManager(db_config)

    # Get list of active games
    games = manager.db.query(
        "SELECT id, name, currentTick, maxTicks FROM games WHERE status = ?",
        ["active"],
    )

    for game in games:
        print(f"Resuming {game['name']} (tick {game['currentTick']}/{game['maxTicks']})")
        # Resume from current tick
        manager.run_game_loop(game["id"])


def example_custom_game_setup():
    """Example: Create a game with custom setup (bodies, ships, etc.)."""
    import json

    logging.basicConfig(level=logging.INFO)

    db_config = {"type": "sqlite", "path": ":memory:"}
    manager = GameManager(db_config)

    init_schema(manager.db)

    # Create base game
    game_id = manager.create_game(
        name="Custom Game",
        max_ticks=100,
        factions=[
            {"userId": "player_1", "name": "Player 1", "color": "#0066cc"},
        ],
    )

    # Get faction ID
    factions = manager.db.query(
        "SELECT id FROM factions WHERE gameId = ?",
        [game_id],
    )
    faction_id = factions[0]["id"]

    # Add a body
    body_id = str(uuid.uuid4())
    manager.db.execute(
        "INSERT INTO bodies "
        "(id, gameId, name, type, orbitRadius, orbitPeriod, soi, ownedBy, "
        "developmentLevel, resources_per_tick_metal, resources_per_tick_fuel, "
        "resources_per_tick_gold, resources_per_tick_science, parent) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            body_id,
            game_id,
            "Earth",
            "planet",
            149.6e6,
            365.25,
            924e3,
            faction_id,
            2,
            100,  # metal/tick
            50,   # fuel/tick
            20,   # gold/tick
            30,   # science/tick
            "sun",
        ],
    )

    # Add a ship
    ship_id = str(uuid.uuid4())
    orbit_json = json.dumps({
        "rp": 6378,
        "ra": 6378,
        "omega": 0,
        "M0": 0,
        "epoch": 0,
        "direction": "prograde",
        "period": 90,
        "parentBodyId": body_id,
    })
    manager.db.execute(
        "INSERT INTO ships "
        "(id, gameId, ownedBy, name, class, fuel, maxFuel, currentOrbit_json, currentTick) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ship_id,
            game_id,
            faction_id,
            "Explorer-1",
            "explorer",
            1000,
            1000,
            orbit_json,
            0,
        ],
    )

    logger.info(f"Created custom game {game_id}")

    # Run a few ticks
    for tick in range(5):
        manager.run_tick(game_id, tick)

    print("Custom game example completed!")


# ============================================================================
# Main
# ============================================================================


if __name__ == "__main__":
    print("=== Orbital Game Engine Integration Examples ===\n")

    print("1. Running single game example...")
    example_single_game()

    print("\n" + "="*50)
    print("2. Custom game setup example...")
    example_custom_game_setup()

    print("\n" + "="*50)
    print("\nExamples completed!")
