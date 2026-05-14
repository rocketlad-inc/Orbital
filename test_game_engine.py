"""
Unit and integration tests for the game engine.

Tests cover:
- Atomic tick execution
- Maneuver execution with fuel consumption
- SOI transition detection
- Standing order evaluation
- Resource production accumulation
- Tech research progression
- Production queue advancement
- Chronicle logging
- Transaction rollback on failure
"""

import json
import pytest
from unittest.mock import Mock, MagicMock, patch, call
from typing import Dict, List, Any

from game_engine import (
    GameEngine,
    Database,
    OrbitElement,
    Ship,
    Body,
    ManeuverOrder,
    ManeuverStatus,
    StandingOrder,
    ResourceInventory,
    TechResearch,
    TechStatus,
    ProductionQueueItem,
    GameState,
    ChronicleEntry,
    ChronicleEventType,
    TickResult,
    OrbitalPhysics,
)


# ============================================================================
# Mock Database
# ============================================================================


class MockDatabase(Database):
    """In-memory mock database for testing."""

    def __init__(self):
        self.tables = {
            "ships": [],
            "bodies": [],
            "factions": [],
            "resources": [],
            "maneuver_orders": [],
            "standing_orders": [],
            "tech_research": [],
            "production_queue": [],
            "chronicle_entries": [],
            "tick_execution_state": [],
        }
        self.in_transaction = False
        self.committed = False
        self.rolled_back = False

    def begin_transaction(self) -> None:
        self.in_transaction = True
        self.committed = False
        self.rolled_back = False

    def commit(self) -> None:
        assert self.in_transaction, "No transaction in progress"
        self.committed = True
        self.in_transaction = False

    def rollback(self) -> None:
        assert self.in_transaction, "No transaction in progress"
        self.rolled_back = True
        self.in_transaction = False

    def query(self, sql: str, params: List[Any] = None) -> List[Dict[str, Any]]:
        # Simple query simulation for testing
        if "ships WHERE gameId = ?" in sql:
            game_id = params[0] if params else None
            return [r for r in self.tables["ships"] if r.get("gameId") == game_id]
        elif "bodies WHERE gameId = ?" in sql:
            game_id = params[0] if params else None
            return [r for r in self.tables["bodies"] if r.get("gameId") == game_id]
        elif "factions WHERE gameId = ?" in sql:
            game_id = params[0] if params else None
            return [r for r in self.tables["factions"] if r.get("gameId") == game_id]
        elif "resources WHERE gameId = ?" in sql:
            game_id = params[0] if params else None
            return [r for r in self.tables["resources"] if r.get("gameId") == game_id]
        elif "maneuver_orders" in sql and "plannedBurnTime = ?" in sql:
            game_id, tick, status = params
            return [
                r
                for r in self.tables["maneuver_orders"]
                if r.get("gameId") == game_id
                and r.get("plannedBurnTime") == tick
                and r.get("status") == status
            ]
        elif "standing_orders WHERE gameId = ?" in sql:
            game_id = params[0] if params else None
            return [
                r
                for r in self.tables["standing_orders"]
                if r.get("gameId") == game_id and r.get("enabled")
            ]
        elif "tech_research WHERE gameId = ?" in sql:
            game_id = params[0] if params else None
            return [
                r
                for r in self.tables["tech_research"]
                if r.get("gameId") == game_id
                and r.get("status") in params[1:]
            ]
        elif "production_queue WHERE gameId = ?" in sql:
            game_id = params[0] if params else None
            return [r for r in self.tables["production_queue"] if r.get("gameId") == game_id]
        return []

    def execute(self, sql: str, params: List[Any] = None) -> None:
        # Simple execute simulation
        if "UPDATE ships SET" in sql:
            ship_id, game_id = params[-2:]
            self.tables["ships"] = [
                r for r in self.tables["ships"] if not (r.get("id") == ship_id)
            ]
        elif "UPDATE bodies SET" in sql:
            body_id, game_id = params[-2:]
            self.tables["bodies"] = [
                r for r in self.tables["bodies"] if not (r.get("id") == body_id)
            ]
        elif "UPDATE resources SET" in sql:
            game_id, faction_id = params[-2:]
            self.tables["resources"] = [
                r
                for r in self.tables["resources"]
                if not (r.get("gameId") == game_id and r.get("factionId") == faction_id)
            ]
        elif "INSERT INTO chronicle_entries" in sql:
            self.tables["chronicle_entries"].append(
                {
                    "gameId": params[0],
                    "tick": params[1],
                    "type": params[2],
                    "data_json": params[3],
                    "displayText": params[4],
                }
            )

    def execute_many(self, sql: str, param_list: List[List[Any]]) -> None:
        for params in param_list:
            self.execute(sql, params)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def mock_db():
    return MockDatabase()


@pytest.fixture
def game_engine(mock_db):
    return GameEngine(mock_db)


@pytest.fixture
def sample_orbit():
    return OrbitElement(
        rp=6378.0,
        ra=6378.0,
        omega=0.0,
        M0=0.0,
        epoch=0,
        direction="prograde",
        period=90.0,
        parentBodyId="earth",
    )


@pytest.fixture
def sample_ship(sample_orbit):
    return Ship(
        id="ship_1",
        gameId="game_1",
        ownedBy="faction_1",
        name="Explorer-1",
        shipClass="explorer",
        fuel=1000.0,
        maxFuel=1000.0,
        currentOrbit=sample_orbit,
        currentTick=0,
    )


@pytest.fixture
def sample_body():
    return Body(
        id="mars",
        gameId="game_1",
        name="Mars",
        bodyType="planet",
        orbitRadius=227.9e6,
        orbitPeriod=687.0,
        soi=577.0e3,
        ownedBy="faction_1",
        developmentLevel=2,
        resources_per_tick={"metal": 10.0, "fuel": 5.0, "gold": 2.0, "science": 1.0},
        storedResources={"metal": 100.0, "fuel": 50.0, "gold": 20.0, "science": 10.0},
        parent="sun",
    )


@pytest.fixture
def sample_game_state():
    return GameState(gameId="game_1", currentTick=100)


# ============================================================================
# Tests: Data Classes
# ============================================================================


class TestOrbitElement:
    def test_to_dict(self, sample_orbit):
        """OrbitElement.to_dict() serializes to JSON-compatible dict."""
        d = sample_orbit.to_dict()
        assert d["rp"] == 6378.0
        assert d["ra"] == 6378.0
        assert d["parentBodyId"] == "earth"

    def test_from_dict(self):
        """OrbitElement.from_dict() deserializes from dict."""
        data = {
            "rp": 6378.0,
            "ra": 6378.0,
            "omega": 0.0,
            "M0": 0.0,
            "epoch": 0,
            "direction": "prograde",
            "period": 90.0,
            "parentBodyId": "earth",
        }
        orbit = OrbitElement.from_dict(data)
        assert orbit.rp == 6378.0
        assert orbit.parentBodyId == "earth"


class TestShip:
    def test_to_db_dict(self, sample_ship):
        """Ship.to_db_dict() produces database-ready columns."""
        db_dict = sample_ship.to_db_dict()
        assert db_dict["id"] == "ship_1"
        assert db_dict["fuel"] == 1000.0
        assert "currentOrbit_json" in db_dict


class TestBody:
    def test_to_db_dict(self, sample_body):
        """Body.to_db_dict() produces database-ready columns."""
        db_dict = sample_body.to_db_dict()
        assert db_dict["id"] == "mars"
        assert db_dict["resources_per_tick_metal"] == 10.0
        assert db_dict["stored_fuel"] == 50.0


# ============================================================================
# Tests: Game Engine - Initialization
# ============================================================================


class TestGameEngineInit:
    def test_init_with_database(self, mock_db):
        """GameEngine initializes with a database."""
        engine = GameEngine(mock_db)
        assert engine.db == mock_db
        assert engine.physics is not None

    def test_init_with_custom_physics(self, mock_db):
        """GameEngine accepts custom physics engine."""
        physics = OrbitalPhysics()
        engine = GameEngine(mock_db, physics)
        assert engine.physics == physics


# ============================================================================
# Tests: Game Engine - State Loading
# ============================================================================


class TestLoadGameState:
    def test_load_empty_game_state(self, game_engine, mock_db):
        """Loading empty game state returns valid GameState."""
        state = game_engine._load_game_state("game_1", 100)
        assert state.gameId == "game_1"
        assert state.currentTick == 100
        assert len(state.ships) == 0
        assert len(state.bodies) == 0

    def test_load_game_state_with_ships(self, game_engine, mock_db, sample_ship):
        """Loading game state includes ships."""
        mock_db.tables["ships"].append(sample_ship.to_db_dict())
        state = game_engine._load_game_state("game_1", 100)
        assert len(state.ships) == 1
        assert "ship_1" in state.ships
        assert state.ships["ship_1"].name == "Explorer-1"

    def test_load_game_state_with_bodies(self, game_engine, mock_db, sample_body):
        """Loading game state includes bodies."""
        mock_db.tables["bodies"].append(sample_body.to_db_dict())
        state = game_engine._load_game_state("game_1", 100)
        assert len(state.bodies) == 1
        assert "mars" in state.bodies
        assert state.bodies["mars"].name == "Mars"

    def test_load_game_state_with_resources(self, game_engine, mock_db):
        """Loading game state includes resource inventories."""
        mock_db.tables["resources"].append(
            {
                "id": "res_1",
                "gameId": "game_1",
                "factionId": "faction_1",
                "metal": 100.0,
                "fuel": 50.0,
                "gold": 20.0,
                "science": 10.0,
            }
        )
        state = game_engine._load_game_state("game_1", 100)
        assert "faction_1" in state.resources
        assert state.resources["faction_1"].metal == 100.0


# ============================================================================
# Tests: Maneuver Execution
# ============================================================================


class TestExecuteManeuvers:
    def test_maneuver_execution_success(self, game_engine, sample_game_state, sample_ship):
        """Maneuver executes successfully with sufficient fuel."""
        sample_game_state.ships["ship_1"] = sample_ship
        order = ManeuverOrder(
            id="order_1",
            gameId="game_1",
            shipId="ship_1",
            orderType="transfer",
            status=ManeuverStatus.COMMITTED,
            plannedBurnTime=100,
            deltaV=100.0,
        )
        sample_game_state.maneuverOrders.append(order)

        game_engine._execute_maneuvers(sample_game_state)

        assert order.status == ManeuverStatus.EXECUTED
        assert sample_ship.fuel < 1000.0
        assert order.postOrbit is not None
        assert len(sample_game_state.chronicle) == 1
        assert (
            sample_game_state.chronicle[0].eventType
            == ChronicleEventType.MANEUVER_EXECUTED
        )

    def test_maneuver_execution_insufficient_fuel(
        self, game_engine, sample_game_state, sample_ship
    ):
        """Maneuver fails when fuel is insufficient."""
        sample_ship.fuel = 1.0  # Very low fuel
        sample_game_state.ships["ship_1"] = sample_ship
        order = ManeuverOrder(
            id="order_1",
            gameId="game_1",
            shipId="ship_1",
            orderType="transfer",
            status=ManeuverStatus.COMMITTED,
            plannedBurnTime=100,
            deltaV=1000.0,  # Large burn
        )
        sample_game_state.maneuverOrders.append(order)

        game_engine._execute_maneuvers(sample_game_state)

        assert order.status == ManeuverStatus.FAILED
        assert sample_ship.fuel == 1.0  # Unchanged

    def test_maneuver_missing_ship(self, game_engine, sample_game_state):
        """Maneuver skips if ship not found."""
        order = ManeuverOrder(
            id="order_1",
            gameId="game_1",
            shipId="nonexistent",
            orderType="transfer",
            status=ManeuverStatus.COMMITTED,
            plannedBurnTime=100,
            deltaV=100.0,
        )
        sample_game_state.maneuverOrders.append(order)

        # Should not raise an exception
        game_engine._execute_maneuvers(sample_game_state)
        assert order.status == ManeuverStatus.COMMITTED


# ============================================================================
# Tests: Production Accumulation
# ============================================================================


class TestAccumulateProduction:
    def test_production_accumulation(self, game_engine, sample_game_state, sample_body):
        """Production is accumulated for owned bodies."""
        sample_game_state.bodies["mars"] = sample_body
        sample_game_state.resources["faction_1"] = ResourceInventory(
            id="res_1",
            gameId="game_1",
            factionId="faction_1",
            metal=0.0,
            fuel=0.0,
            gold=0.0,
            science=0.0,
        )

        initial_metal = sample_game_state.resources["faction_1"].metal
        game_engine._accumulate_production(sample_game_state)

        # With developmentLevel=2, modifier should be 1.2
        expected_metal = 10.0 * 1.2
        assert sample_game_state.resources["faction_1"].metal > initial_metal
        assert len(sample_game_state.chronicle) == 1

    def test_production_no_effect_unowned_body(
        self, game_engine, sample_game_state, sample_body
    ):
        """Production does not occur for unowned bodies."""
        sample_body.ownedBy = None
        sample_game_state.bodies["mars"] = sample_body

        game_engine._accumulate_production(sample_game_state)

        assert len(sample_game_state.chronicle) == 0


# ============================================================================
# Tests: Tech Research
# ============================================================================


class TestAdvanceResearch:
    def test_tech_research_progress(self, game_engine, sample_game_state):
        """Tech research increments progress each tick."""
        tech = TechResearch(
            id="tech_1",
            gameId="game_1",
            factionId="faction_1",
            techId="propulsion_v2",
            status=TechStatus.IN_PROGRESS,
            progress_ticks=8,
            totalTicks=10,
        )
        sample_game_state.techResearch.append(tech)

        game_engine._advance_research(sample_game_state)

        assert tech.progress_ticks == 9
        assert tech.status == TechStatus.IN_PROGRESS
        assert len(sample_game_state.chronicle) == 0

    def test_tech_research_completion(self, game_engine, sample_game_state):
        """Tech research completes when progress reaches total."""
        tech = TechResearch(
            id="tech_1",
            gameId="game_1",
            factionId="faction_1",
            techId="propulsion_v2",
            status=TechStatus.IN_PROGRESS,
            progress_ticks=9,
            totalTicks=10,
        )
        sample_game_state.techResearch.append(tech)

        game_engine._advance_research(sample_game_state)

        assert tech.progress_ticks == 10
        assert tech.status == TechStatus.COMPLETED
        assert tech.completedAtTick == 100
        assert len(sample_game_state.chronicle) == 1
        assert sample_game_state.chronicle[0].eventType == ChronicleEventType.TECH_COMPLETED


# ============================================================================
# Tests: Production Queue
# ============================================================================


class TestAdvanceProductionQueue:
    def test_production_queue_progress(self, game_engine, sample_game_state):
        """Production queue items increment progress each tick."""
        item = ProductionQueueItem(
            id="prod_1",
            gameId="game_1",
            factionId="faction_1",
            itemType="ship",
            targetId="explorer_design",
            progress_ticks=5,
            totalTicks=10,
        )
        sample_game_state.productionQueue.append(item)

        game_engine._advance_production_queue(sample_game_state)

        assert item.progress_ticks == 6
        assert len(sample_game_state.productionQueue) == 1

    def test_production_queue_completion(self, game_engine, sample_game_state):
        """Production queue items complete when progress reaches total."""
        item = ProductionQueueItem(
            id="prod_1",
            gameId="game_1",
            factionId="faction_1",
            itemType="ship",
            targetId="explorer_design",
            progress_ticks=9,
            totalTicks=10,
        )
        sample_game_state.productionQueue.append(item)

        game_engine._advance_production_queue(sample_game_state)

        assert item.progress_ticks == 10
        assert len(sample_game_state.productionQueue) == 0
        assert len(sample_game_state.chronicle) == 1
        assert (
            sample_game_state.chronicle[0].eventType
            == ChronicleEventType.PRODUCTION_COMPLETED
        )


# ============================================================================
# Tests: Transaction Management
# ============================================================================


class TestTransactionManagement:
    def test_execute_tick_commits_on_success(self, game_engine, mock_db):
        """execute_tick commits transaction on success."""
        result = game_engine.execute_tick("game_1", 100)

        assert result.success is True
        assert mock_db.committed is True
        assert mock_db.rolled_back is False

    def test_execute_tick_rollback_on_error(self, game_engine, mock_db):
        """execute_tick rolls back on any error."""
        # Mock _load_game_state to raise an exception
        with patch.object(game_engine, "_load_game_state", side_effect=Exception("DB error")):
            result = game_engine.execute_tick("game_1", 100)

        assert result.success is False
        assert mock_db.rolled_back is True
        assert len(result.errors) > 0


# ============================================================================
# Tests: Full Tick Execution
# ============================================================================


class TestFullTickExecution:
    def test_full_tick_execution_empty_game(self, game_engine, mock_db):
        """Full tick execution completes successfully on empty game."""
        result = game_engine.execute_tick("game_1", 100)

        assert result.success is True
        assert result.tick == 100
        assert result.executionTime > 0

    def test_full_tick_execution_with_maneuvers(
        self, game_engine, mock_db, sample_ship, sample_orbit
    ):
        """Full tick execution includes maneuver execution."""
        # Setup mock data
        mock_db.tables["ships"].append(sample_ship.to_db_dict())
        mock_db.tables["maneuver_orders"].append(
            {
                "id": "order_1",
                "gameId": "game_1",
                "shipId": "ship_1",
                "type": "transfer",
                "status": "committed",
                "plannedBurnTime": 100,
                "deltav": 100.0,
                "postOrbit_json": None,
            }
        )

        result = game_engine.execute_tick("game_1", 100)

        assert result.success is True
        assert mock_db.committed is True


# ============================================================================
# Tests: Orbital Physics
# ============================================================================


class TestOrbitalPhysics:
    def test_compute_post_burn_orbit(self, sample_orbit):
        """Physics engine computes post-burn orbit."""
        physics = OrbitalPhysics()
        post_orbit = physics.computePostBurnOrbit(sample_orbit, 100.0, 100)

        assert post_orbit.parentBodyId == "earth"
        assert post_orbit.epoch == 100
        # Periapsis should increase with positive deltaV
        assert post_orbit.rp > sample_orbit.rp

    def test_fuel_required(self, sample_orbit):
        """Physics engine estimates fuel requirement."""
        physics = OrbitalPhysics()
        pre_orbit = sample_orbit
        post_orbit = physics.computePostBurnOrbit(pre_orbit, 100.0, 100)
        fuel = physics.fuelRequired(pre_orbit, post_orbit)

        assert fuel > 0


# ============================================================================
# Edge Cases and Error Handling
# ============================================================================


class TestErrorHandling:
    def test_standing_order_evaluation_error_handling(self, game_engine, sample_game_state):
        """Standing order evaluation errors are logged but don't crash tick."""
        order = StandingOrder(
            id="order_1",
            gameId="game_1",
            factionId="faction_1",
            condition={"invalid": "condition"},
            action={"invalid": "action"},
            enabled=True,
        )
        sample_game_state.standingOrders.append(order)

        # Should not raise an exception
        game_engine._evaluate_standing_orders(sample_game_state)

    def test_maneuver_execution_error_handling(self, game_engine, sample_game_state):
        """Maneuver errors are logged and marked as failed."""
        ship = Ship(
            id="ship_1",
            gameId="game_1",
            ownedBy="faction_1",
            name="BadShip",
            shipClass="test",
            fuel=100.0,
            maxFuel=100.0,
            currentOrbit=None,  # Invalid: will cause error
            currentTick=0,
        )
        sample_game_state.ships["ship_1"] = ship
        order = ManeuverOrder(
            id="order_1",
            gameId="game_1",
            shipId="ship_1",
            orderType="transfer",
            status=ManeuverStatus.COMMITTED,
            plannedBurnTime=100,
            deltaV=100.0,
        )
        sample_game_state.maneuverOrders.append(order)

        game_engine._execute_maneuvers(sample_game_state)

        # Should mark as failed, not raise
        assert order.status == ManeuverStatus.FAILED


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
