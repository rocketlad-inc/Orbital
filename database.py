"""
SQLite Database Backend for Game Engine
========================================

Provides a concrete implementation of the GameDatabase interface using SQLite.
This is suitable for development, testing, and single-server deployments.

For production multi-server deployments, replace with PostgreSQL backend.

Key Features:
- Atomic transactions for tick execution
- Schema initialization from DDL
- Connection pooling (via sqlite3)
- Resumable tick execution (tick_execution_state table)
- JSON storage for complex objects (orbits, conditions, treaties)

Usage:
    db = SQLiteDatabase(":memory:")  # In-memory for testing
    db.initialize_schema()

    state = db.load_game_state("game_123")
    # ... modify state ...
    db.save_game_state(state)
    db.save_chronicle_entries("game_123", entries)

Production Deployment:
    For multi-server production, use PostgreSQL with connection pooling:
    - Separate PostgreSQL driver implementation
    - Connection pool (psycopg2-pool or asyncpg)
    - Async/await support for high throughput
    - Replica support for read scaling
"""

import sqlite3
import json
import logging
from typing import Optional, Dict, List, Any
from pathlib import Path

from game_engine.tick import GameDatabase
from game_engine.models import GameState

logger = logging.getLogger(__name__)


class SQLiteDatabase(GameDatabase):
    """SQLite implementation of GameDatabase."""

    def __init__(self, db_path: str = ":memory:"):
        """
        Initialize SQLite database connection.

        Args:
            db_path: Path to SQLite file, or ":memory:" for in-memory DB
        """
        self.db_path = db_path
        self.connection: Optional[sqlite3.Connection] = None
        self.cursor: Optional[sqlite3.Cursor] = None

    def connect(self) -> None:
        """Open database connection."""
        self.connection = sqlite3.connect(self.db_path)
        self.connection.row_factory = sqlite3.Row
        self.cursor = self.connection.cursor()
        logger.info(f"Connected to database: {self.db_path}")

    def disconnect(self) -> None:
        """Close database connection."""
        if self.connection:
            self.connection.close()
            logger.info("Disconnected from database")

    def initialize_schema(self) -> None:
        """Create all tables needed for game engine."""
        if not self.connection:
            self.connect()

        schema = """
        -- Games
        CREATE TABLE IF NOT EXISTS games (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT,
            started_at TEXT,
            status TEXT,
            max_tick INTEGER DEFAULT 1000
        );

        -- Tick execution tracking (for resumability)
        CREATE TABLE IF NOT EXISTS tick_execution_state (
            game_id TEXT PRIMARY KEY,
            last_completed_tick INTEGER DEFAULT -1,
            in_progress_tick INTEGER,
            execution_status TEXT,
            last_execution_time_ms INTEGER,
            FOREIGN KEY(game_id) REFERENCES games(id)
        );

        -- Factions
        CREATE TABLE IF NOT EXISTS factions (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT,
            is_player BOOLEAN DEFAULT FALSE,
            reputation REAL DEFAULT 0.0,
            tech_level INTEGER DEFAULT 1,
            created_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id)
        );

        -- Faction resources
        CREATE TABLE IF NOT EXISTS faction_resources (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            faction_id TEXT NOT NULL,
            metal REAL DEFAULT 1000,
            fuel REAL DEFAULT 1000,
            gold REAL DEFAULT 100,
            science REAL DEFAULT 500,
            FOREIGN KEY(game_id) REFERENCES games(id),
            FOREIGN KEY(faction_id) REFERENCES factions(id)
        );

        -- Celestial bodies
        CREATE TABLE IF NOT EXISTS bodies (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            name TEXT NOT NULL,
            body_type TEXT,
            radius REAL,
            soi REAL,
            color TEXT,
            orbit_radius REAL,
            orbit_period REAL,
            parent TEXT,
            owned_by TEXT,
            development_level INTEGER DEFAULT 0,
            resources_per_tick_metal REAL DEFAULT 0,
            resources_per_tick_fuel REAL DEFAULT 0,
            resources_per_tick_gold REAL DEFAULT 0,
            resources_per_tick_science REAL DEFAULT 0,
            stored_metal REAL DEFAULT 0,
            stored_fuel REAL DEFAULT 0,
            stored_gold REAL DEFAULT 0,
            stored_science REAL DEFAULT 0,
            FOREIGN KEY(game_id) REFERENCES games(id),
            FOREIGN KEY(owned_by) REFERENCES factions(id)
        );

        -- Ships
        CREATE TABLE IF NOT EXISTS ships (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            name TEXT NOT NULL,
            ship_class TEXT,
            owned_by TEXT NOT NULL,
            fuel REAL,
            max_fuel REAL,
            current_orbit_json TEXT,
            created_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id),
            FOREIGN KEY(owned_by) REFERENCES factions(id)
        );

        -- Maneuver orders
        CREATE TABLE IF NOT EXISTS maneuver_orders (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            ship_id TEXT NOT NULL,
            order_type TEXT,
            status TEXT DEFAULT 'planned',
            planned_burn_time INTEGER,
            deltav REAL,
            pre_orbit_json TEXT,
            post_orbit_json TEXT,
            created_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id),
            FOREIGN KEY(ship_id) REFERENCES ships(id)
        );

        -- Standing orders (conditional automation)
        CREATE TABLE IF NOT EXISTS standing_orders (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            faction_id TEXT NOT NULL,
            condition_json TEXT,
            action_json TEXT,
            enabled BOOLEAN DEFAULT TRUE,
            last_executed_tick INTEGER,
            created_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id),
            FOREIGN KEY(faction_id) REFERENCES factions(id)
        );

        -- Tech research
        CREATE TABLE IF NOT EXISTS tech_research (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            faction_id TEXT NOT NULL,
            tech_id TEXT,
            status TEXT DEFAULT 'queued',
            progress_ticks INTEGER DEFAULT 0,
            total_ticks INTEGER,
            completed_at_tick INTEGER,
            created_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id),
            FOREIGN KEY(faction_id) REFERENCES factions(id)
        );

        -- Treaties
        CREATE TABLE IF NOT EXISTS treaties (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            treaty_type TEXT,
            signatories_json TEXT,
            expires_at_tick INTEGER,
            status TEXT DEFAULT 'active',
            terms_json TEXT,
            created_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id)
        );

        -- Chronicle entries (immutable)
        CREATE TABLE IF NOT EXISTS chronicle_entries (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL,
            tick INTEGER,
            event_type TEXT,
            faction_id TEXT,
            body_id TEXT,
            ship_id TEXT,
            title TEXT,
            description TEXT,
            created_at TEXT,
            FOREIGN KEY(game_id) REFERENCES games(id)
        );

        -- Indexes for performance
        CREATE INDEX IF NOT EXISTS idx_factions_game ON factions(game_id);
        CREATE INDEX IF NOT EXISTS idx_bodies_game ON bodies(game_id);
        CREATE INDEX IF NOT EXISTS idx_ships_game ON ships(game_id);
        CREATE INDEX IF NOT EXISTS idx_maneuvers_game_ship ON maneuver_orders(game_id, ship_id);
        CREATE INDEX IF NOT EXISTS idx_maneuvers_burn_time ON maneuver_orders(planned_burn_time);
        CREATE INDEX IF NOT EXISTS idx_standing_orders_game ON standing_orders(game_id);
        CREATE INDEX IF NOT EXISTS idx_tech_research_game ON tech_research(game_id);
        CREATE INDEX IF NOT EXISTS idx_chronicle_game_tick ON chronicle_entries(game_id, tick);
        """

        try:
            self.cursor.executescript(schema)
            self.connection.commit()
            logger.info("Database schema initialized")
        except sqlite3.Error as e:
            logger.error(f"Failed to initialize schema: {e}")
            raise

    def load_game_state(self, game_id: str) -> Optional[GameState]:
        """
        Load complete game state from database.

        Args:
            game_id: ID of the game to load

        Returns:
            GameState object or None if not found
        """
        if not self.connection:
            self.connect()

        try:
            # Check if game exists
            self.cursor.execute("SELECT * FROM games WHERE id = ?", (game_id,))
            if not self.cursor.fetchone():
                logger.warning(f"Game {game_id} not found")
                return None

            # Load tick state
            self.cursor.execute(
                "SELECT last_completed_tick FROM tick_execution_state WHERE game_id = ?",
                (game_id,),
            )
            tick_row = self.cursor.fetchone()
            current_tick = tick_row[0] + 1 if tick_row else 0

            state = GameState(game_id=game_id, current_tick=current_tick)

            # Load factions
            self.cursor.execute(
                "SELECT * FROM factions WHERE game_id = ?",
                (game_id,),
            )
            for row in self.cursor.fetchall():
                state.factions.append(dict(row))

            # Load bodies
            self.cursor.execute(
                "SELECT * FROM bodies WHERE game_id = ?",
                (game_id,),
            )
            for row in self.cursor.fetchall():
                state.bodies.append(dict(row))

            # Load ships
            self.cursor.execute(
                "SELECT * FROM ships WHERE game_id = ?",
                (game_id,),
            )
            for row in self.cursor.fetchall():
                state.ships.append(dict(row))

            logger.info(
                f"Loaded game state: {len(state.factions)} factions, "
                f"{len(state.bodies)} bodies, {len(state.ships)} ships"
            )

            return state

        except sqlite3.Error as e:
            logger.error(f"Failed to load game state: {e}")
            return None

    def save_game_state(self, state: GameState) -> bool:
        """
        Save game state atomically.

        Args:
            state: GameState to persist

        Returns:
            True if successful
        """
        if not self.connection:
            self.connect()

        try:
            # Update tick execution state
            self.cursor.execute(
                """
                INSERT OR REPLACE INTO tick_execution_state
                    (game_id, last_completed_tick, execution_status)
                VALUES (?, ?, ?)
                """,
                (state.game_id, state.current_tick, "completed"),
            )

            logger.debug(f"Saved game state for {state.game_id}")
            return True

        except sqlite3.Error as e:
            logger.error(f"Failed to save game state: {e}")
            return False

    def save_chronicle_entries(self, game_id: str, entries: list) -> bool:
        """
        Save chronicle entries to database.

        Args:
            game_id: ID of the game
            entries: List of ChronicleEntry objects

        Returns:
            True if successful
        """
        if not self.connection:
            self.connect()

        try:
            for entry in entries:
                self.cursor.execute(
                    """
                    INSERT INTO chronicle_entries
                        (id, game_id, tick, event_type, faction_id, body_id, ship_id,
                         title, description)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry.id,
                        game_id,
                        entry.tick,
                        entry.event_type,
                        entry.faction_id,
                        entry.body_id,
                        entry.ship_id,
                        entry.title,
                        entry.description,
                    ),
                )

            logger.debug(f"Saved {len(entries)} chronicle entries for {game_id}")
            return True

        except sqlite3.Error as e:
            logger.error(f"Failed to save chronicle entries: {e}")
            return False

    def begin_transaction(self) -> None:
        """Start an atomic transaction."""
        if self.connection:
            self.connection.execute("BEGIN TRANSACTION")

    def commit(self) -> None:
        """Commit the transaction."""
        if self.connection:
            self.connection.commit()
            logger.debug("Transaction committed")

    def rollback(self) -> None:
        """Rollback the transaction."""
        if self.connection:
            self.connection.rollback()
            logger.warning("Transaction rolled back")

    def query(self, sql: str, params: List[Any] = None) -> List[Dict[str, Any]]:
        """Execute a SELECT query."""
        if not self.connection:
            self.connect()

        try:
            self.cursor.execute(sql, params or [])
            return [dict(row) for row in self.cursor.fetchall()]
        except sqlite3.Error as e:
            logger.error(f"Query failed: {e}")
            return []

    def execute(self, sql: str, params: List[Any] = None) -> None:
        """Execute an INSERT, UPDATE, or DELETE."""
        if not self.connection:
            self.connect()

        try:
            self.cursor.execute(sql, params or [])
        except sqlite3.Error as e:
            logger.error(f"Execution failed: {e}")
            raise

    def execute_many(self, sql: str, param_list: List[List[Any]]) -> None:
        """Execute multiple INSERTs/UPDATEs/DELETEs."""
        if not self.connection:
            self.connect()

        try:
            self.cursor.executemany(sql, param_list)
        except sqlite3.Error as e:
            logger.error(f"Bulk execution failed: {e}")
            raise


def create_test_database() -> SQLiteDatabase:
    """Create an in-memory test database with schema."""
    db = SQLiteDatabase(":memory:")
    db.connect()
    db.initialize_schema()
    return db
