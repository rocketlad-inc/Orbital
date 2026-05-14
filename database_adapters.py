"""
Concrete database adapter implementations for the game engine.

Provides adapters for PostgreSQL, SQLite, and other database backends.
Each adapter implements the Database interface from game_engine.py.
"""

import sqlite3
import logging
from typing import List, Dict, Any, Optional
from contextlib import contextmanager

from game_engine import Database

logger = logging.getLogger(__name__)


# ============================================================================
# SQLite Adapter
# ============================================================================


class SQLiteDatabase(Database):
    """
    SQLite database adapter with transaction support.

    Recommended for local development and testing.
    Uses WAL mode for better concurrency.
    """

    def __init__(self, db_path: str):
        """
        Initialize SQLite connection.

        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = db_path
        self.connection = None
        self.cursor = None
        self.in_transaction = False
        self._connect()

    def _connect(self) -> None:
        """Establish database connection and enable WAL mode."""
        self.connection = sqlite3.connect(self.db_path)
        self.connection.row_factory = sqlite3.Row
        # Enable WAL mode for better concurrent access
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        logger.info(f"Connected to SQLite database: {self.db_path}")

    def begin_transaction(self) -> None:
        """Start a transaction."""
        self.connection.execute("BEGIN")
        self.in_transaction = True
        logger.debug("Transaction started")

    def commit(self) -> None:
        """Commit the current transaction."""
        if not self.in_transaction:
            raise RuntimeError("No transaction in progress")
        self.connection.commit()
        self.in_transaction = False
        logger.debug("Transaction committed")

    def rollback(self) -> None:
        """Rollback the current transaction."""
        if not self.in_transaction:
            raise RuntimeError("No transaction in progress")
        self.connection.rollback()
        self.in_transaction = False
        logger.debug("Transaction rolled back")

    def query(self, sql: str, params: List[Any] = None) -> List[Dict[str, Any]]:
        """
        Execute a SELECT query and return results.

        Args:
            sql: SQL SELECT statement
            params: Query parameters (parameterized to prevent SQL injection)

        Returns:
            List of rows as dictionaries
        """
        if params is None:
            params = []

        cursor = self.connection.cursor()
        cursor.execute(sql, params)
        rows = cursor.fetchall()

        # Convert sqlite3.Row to dict
        result = [dict(row) for row in rows]
        logger.debug(f"Query returned {len(result)} rows")
        return result

    def execute(self, sql: str, params: List[Any] = None) -> None:
        """
        Execute an INSERT, UPDATE, or DELETE statement.

        Args:
            sql: SQL statement
            params: Statement parameters
        """
        if params is None:
            params = []

        cursor = self.connection.cursor()
        cursor.execute(sql, params)
        logger.debug(f"Executed statement, {cursor.rowcount} rows affected")

    def execute_many(self, sql: str, param_list: List[List[Any]]) -> None:
        """
        Execute multiple statements with different parameters.

        Args:
            sql: SQL statement
            param_list: List of parameter sets
        """
        cursor = self.connection.cursor()
        cursor.executemany(sql, param_list)
        logger.debug(f"Executed {cursor.rowcount} rows")

    def close(self) -> None:
        """Close database connection."""
        if self.connection:
            self.connection.close()
            logger.info("Database connection closed")


# ============================================================================
# PostgreSQL Adapter (Stub)
# ============================================================================


class PostgreSQLDatabase(Database):
    """
    PostgreSQL database adapter.

    Recommended for production deployments with multiple servers.
    Supports connection pooling and advanced features.

    Note: This is a stub. Full implementation requires psycopg3 library.
    """

    def __init__(
        self,
        host: str,
        port: int = 5432,
        database: str = "orbital",
        user: str = "postgres",
        password: str = "",
    ):
        """
        Initialize PostgreSQL connection.

        Args:
            host: Database server hostname
            port: Database server port
            database: Database name
            user: Database user
            password: Database password
        """
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        self.connection = None
        self.cursor = None
        self.in_transaction = False

        # TODO: Implement connection using psycopg3
        # import psycopg
        # self.connection = psycopg.connect(...)

    def begin_transaction(self) -> None:
        """Start a transaction."""
        # TODO: Implement
        self.in_transaction = True

    def commit(self) -> None:
        """Commit the current transaction."""
        if not self.in_transaction:
            raise RuntimeError("No transaction in progress")
        # TODO: Implement
        self.in_transaction = False

    def rollback(self) -> None:
        """Rollback the current transaction."""
        if not self.in_transaction:
            raise RuntimeError("No transaction in progress")
        # TODO: Implement
        self.in_transaction = False

    def query(self, sql: str, params: List[Any] = None) -> List[Dict[str, Any]]:
        """Execute a SELECT query."""
        # TODO: Implement
        return []

    def execute(self, sql: str, params: List[Any] = None) -> None:
        """Execute an INSERT, UPDATE, or DELETE."""
        # TODO: Implement
        pass

    def execute_many(self, sql: str, param_list: List[List[Any]]) -> None:
        """Execute multiple statements."""
        # TODO: Implement
        pass


# ============================================================================
# Database Factory
# ============================================================================


class DatabaseFactory:
    """Factory for creating database adapters based on configuration."""

    @staticmethod
    def create(config: Dict[str, Any]) -> Database:
        """
        Create a database adapter from configuration.

        Args:
            config: Configuration dictionary with 'type' and other settings

        Returns:
            Concrete Database adapter

        Example:
            ```python
            config = {
                "type": "sqlite",
                "path": "/path/to/orbital.db"
            }
            db = DatabaseFactory.create(config)
            ```
        """
        db_type = config.get("type", "sqlite").lower()

        if db_type == "sqlite":
            path = config.get("path", ":memory:")
            return SQLiteDatabase(path)

        elif db_type == "postgresql":
            return PostgreSQLDatabase(
                host=config.get("host", "localhost"),
                port=config.get("port", 5432),
                database=config.get("database", "orbital"),
                user=config.get("user", "postgres"),
                password=config.get("password", ""),
            )

        else:
            raise ValueError(f"Unknown database type: {db_type}")


# ============================================================================
# Schema Initialization
# ============================================================================


def init_schema(db: Database) -> None:
    """
    Initialize database schema for the game engine.

    Creates all required tables. Safe to call multiple times
    (tables are created only if they don't exist).

    Args:
        db: Database adapter
    """
    schema_sql = """
    -- Games table
    CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
        currentTick INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        maxTicks INTEGER DEFAULT 10000
    );

    -- Factions (players)
    CREATE TABLE IF NOT EXISTS factions (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        userId TEXT,
        name TEXT NOT NULL,
        color TEXT,
        capitalBodyId TEXT,
        reputation REAL DEFAULT 0,
        eliminated BOOLEAN DEFAULT FALSE,
        eliminatedAtTick INTEGER,
        FOREIGN KEY (gameId) REFERENCES games(id)
    );

    -- Celestial bodies (planets, moons, stations)
    CREATE TABLE IF NOT EXISTS bodies (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        orbitRadius REAL,
        orbitPeriod REAL,
        soi REAL,
        ownedBy TEXT,
        developmentLevel INTEGER DEFAULT 0,
        resources_per_tick_metal REAL DEFAULT 0,
        resources_per_tick_fuel REAL DEFAULT 0,
        resources_per_tick_gold REAL DEFAULT 0,
        resources_per_tick_science REAL DEFAULT 0,
        stored_metal REAL DEFAULT 0,
        stored_fuel REAL DEFAULT 0,
        stored_gold REAL DEFAULT 0,
        stored_science REAL DEFAULT 0,
        parent TEXT,
        FOREIGN KEY (gameId) REFERENCES games(id),
        FOREIGN KEY (ownedBy) REFERENCES factions(id)
    );

    -- Ships (fleet units)
    CREATE TABLE IF NOT EXISTS ships (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        ownedBy TEXT NOT NULL,
        name TEXT NOT NULL,
        class TEXT NOT NULL,
        fuel REAL NOT NULL,
        maxFuel REAL NOT NULL,
        currentOrbit_json TEXT NOT NULL,
        currentTick INTEGER NOT NULL,
        FOREIGN KEY (gameId) REFERENCES games(id),
        FOREIGN KEY (ownedBy) REFERENCES factions(id)
    );

    -- Maneuver orders (queued fleet movements)
    CREATE TABLE IF NOT EXISTS maneuver_orders (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        shipId TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT DEFAULT 'committed',
        plannedBurnTime INTEGER NOT NULL,
        deltav REAL NOT NULL,
        postOrbit_json TEXT,
        FOREIGN KEY (gameId) REFERENCES games(id),
        FOREIGN KEY (shipId) REFERENCES ships(id)
    );

    -- Standing orders (conditional automation)
    CREATE TABLE IF NOT EXISTS standing_orders (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        factionId TEXT NOT NULL,
        condition_json TEXT NOT NULL,
        action_json TEXT NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        lastExecutedTick INTEGER,
        FOREIGN KEY (gameId) REFERENCES games(id),
        FOREIGN KEY (factionId) REFERENCES factions(id)
    );

    -- Faction resources
    CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        factionId TEXT NOT NULL,
        metal REAL DEFAULT 0,
        fuel REAL DEFAULT 0,
        gold REAL DEFAULT 0,
        science REAL DEFAULT 0,
        FOREIGN KEY (gameId) REFERENCES games(id),
        FOREIGN KEY (factionId) REFERENCES factions(id),
        UNIQUE(gameId, factionId)
    );

    -- Technology research
    CREATE TABLE IF NOT EXISTS tech_research (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        factionId TEXT NOT NULL,
        techId TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        progress_ticks INTEGER DEFAULT 0,
        totalTicks INTEGER NOT NULL,
        completedAtTick INTEGER,
        FOREIGN KEY (gameId) REFERENCES games(id),
        FOREIGN KEY (factionId) REFERENCES factions(id)
    );

    -- Production queue (ship and facility construction)
    CREATE TABLE IF NOT EXISTS production_queue (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        factionId TEXT NOT NULL,
        type TEXT NOT NULL,
        targetId TEXT NOT NULL,
        progress_ticks INTEGER DEFAULT 0,
        totalTicks INTEGER NOT NULL,
        FOREIGN KEY (gameId) REFERENCES games(id),
        FOREIGN KEY (factionId) REFERENCES factions(id)
    );

    -- Game chronicle (historical log)
    CREATE TABLE IF NOT EXISTS chronicle_entries (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        tick INTEGER NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT,
        displayText TEXT NOT NULL,
        FOREIGN KEY (gameId) REFERENCES games(id)
    );

    -- Tick execution state (resumability tracking)
    CREATE TABLE IF NOT EXISTS tick_execution_state (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL UNIQUE,
        currentTick INTEGER DEFAULT 0,
        lastCompletedTick INTEGER DEFAULT -1,
        executionStatus TEXT DEFAULT 'idle',
        FOREIGN KEY (gameId) REFERENCES games(id)
    );

    -- Treaties
    CREATE TABLE IF NOT EXISTS treaties (
        id TEXT PRIMARY KEY,
        gameId TEXT NOT NULL,
        type TEXT NOT NULL,
        signatories_json TEXT NOT NULL,
        startTick INTEGER NOT NULL,
        endTick INTEGER,
        broken BOOLEAN DEFAULT FALSE,
        brokenBy TEXT,
        terms_json TEXT,
        FOREIGN KEY (gameId) REFERENCES games(id)
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_bodies_gameId ON bodies(gameId);
    CREATE INDEX IF NOT EXISTS idx_ships_gameId ON ships(gameId);
    CREATE INDEX IF NOT EXISTS idx_ships_ownedBy ON ships(ownedBy);
    CREATE INDEX IF NOT EXISTS idx_factions_gameId ON factions(gameId);
    CREATE INDEX IF NOT EXISTS idx_maneuver_orders_gameId_tick ON maneuver_orders(gameId, plannedBurnTime);
    CREATE INDEX IF NOT EXISTS idx_standing_orders_gameId ON standing_orders(gameId);
    CREATE INDEX IF NOT EXISTS idx_tech_research_gameId_faction ON tech_research(gameId, factionId);
    CREATE INDEX IF NOT EXISTS idx_production_queue_gameId_faction ON production_queue(gameId, factionId);
    CREATE INDEX IF NOT EXISTS idx_chronicle_gameId_tick ON chronicle_entries(gameId, tick);
    CREATE INDEX IF NOT EXISTS idx_resources_gameId_faction ON resources(gameId, factionId);
    """

    # Execute schema statements
    for statement in schema_sql.split(";"):
        statement = statement.strip()
        if statement:
            db.execute(statement)

    logger.info("Database schema initialized")


# ============================================================================
# Seed Data
# ============================================================================


def seed_sample_game(db: Database) -> str:
    """
    Create a sample game for testing/demo purposes.

    Returns:
        Game ID
    """
    import uuid
    from datetime import datetime

    game_id = str(uuid.uuid4())
    faction_1_id = str(uuid.uuid4())
    faction_2_id = str(uuid.uuid4())
    earth_id = str(uuid.uuid4())
    mars_id = str(uuid.uuid4())
    ship_1_id = str(uuid.uuid4())
    res_1_id = str(uuid.uuid4())
    res_2_id = str(uuid.uuid4())

    # Create game
    db.execute(
        "INSERT INTO games (id, name, startTime, currentTick, status, maxTicks) VALUES (?, ?, ?, ?, ?, ?)",
        [game_id, "Sample Game", datetime.now(), 0, "active", 10000],
    )

    # Create factions
    db.execute(
        "INSERT INTO factions (id, gameId, userId, name, color, capitalBodyId, reputation) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [faction_1_id, game_id, "user_1", "Terra Federation", "#0066cc", earth_id, 50],
    )
    db.execute(
        "INSERT INTO factions (id, gameId, userId, name, color, capitalBodyId, reputation) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [faction_2_id, game_id, "user_2", "Mars Collective", "#cc0000", mars_id, 50],
    )

    # Create bodies
    db.execute(
        "INSERT INTO bodies (id, gameId, name, type, orbitRadius, orbitPeriod, soi, ownedBy, developmentLevel, "
        "resources_per_tick_metal, resources_per_tick_fuel, resources_per_tick_gold, resources_per_tick_science, parent) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            earth_id,
            game_id,
            "Earth",
            "planet",
            149.6e6,
            365.25,
            924e3,
            faction_1_id,
            3,
            100,
            50,
            20,
            30,
            "sun",
        ],
    )
    db.execute(
        "INSERT INTO bodies (id, gameId, name, type, orbitRadius, orbitPeriod, soi, ownedBy, developmentLevel, "
        "resources_per_tick_metal, resources_per_tick_fuel, resources_per_tick_gold, resources_per_tick_science, parent) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            mars_id,
            game_id,
            "Mars",
            "planet",
            227.9e6,
            687.0,
            577e3,
            faction_2_id,
            2,
            80,
            40,
            15,
            25,
            "sun",
        ],
    )

    # Create ships
    orbit_json = (
        '{"rp": 6378, "ra": 6378, "omega": 0, "M0": 0, "epoch": 0, '
        '"direction": "prograde", "period": 90, "parentBodyId": "%s"}'
        % earth_id
    )
    db.execute(
        "INSERT INTO ships (id, gameId, ownedBy, name, class, fuel, maxFuel, currentOrbit_json, currentTick) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ship_1_id,
            game_id,
            faction_1_id,
            "Explorer-1",
            "explorer",
            1000,
            1000,
            orbit_json,
            0,
        ],
    )

    # Create resource inventories
    db.execute(
        "INSERT INTO resources (id, gameId, factionId, metal, fuel, gold, science) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [res_1_id, game_id, faction_1_id, 500, 250, 100, 150],
    )
    db.execute(
        "INSERT INTO resources (id, gameId, factionId, metal, fuel, gold, science) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [res_2_id, game_id, faction_2_id, 400, 200, 80, 120],
    )

    # Create tick execution state
    db.execute(
        "INSERT INTO tick_execution_state (id, gameId, currentTick, lastCompletedTick, executionStatus) VALUES (?, ?, ?, ?, ?)",
        [str(uuid.uuid4()), game_id, 0, -1, "idle"],
    )

    logger.info(f"Seeded sample game: {game_id}")
    return game_id


# ============================================================================
# Usage Example
# ============================================================================


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)

    # Create in-memory SQLite database
    db = DatabaseFactory.create({"type": "sqlite", "path": ":memory:"})

    # Initialize schema
    init_schema(db)

    # Seed sample data
    game_id = seed_sample_game(db)

    # Query sample data
    games = db.query("SELECT * FROM games WHERE id = ?", [game_id])
    print(f"Created game: {games[0]['name']}")

    ships = db.query("SELECT * FROM ships WHERE gameId = ?", [game_id])
    print(f"Ships: {len(ships)}")
    for ship in ships:
        print(f"  - {ship['name']} ({ship['class']})")

    bodies = db.query("SELECT * FROM bodies WHERE gameId = ?", [game_id])
    print(f"Bodies: {len(bodies)}")
    for body in bodies:
        print(f"  - {body['name']} (owned by {body['ownedBy']})")
