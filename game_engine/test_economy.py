"""
Economy System Tests
====================

Tests for ship production, body development, fuel transfers, and trading.
"""

import pytest
from .models import (
    GameState, Faction, Body, BodyType, Ship, ShipClass,
    OrbitElements, SHIP_DESIGNS
)
from .chronicle import Chronicle
from .economy import (
    build_ship, complete_ship_production, upgrade_body_development,
    complete_body_development, transfer_fuel, initiate_trade,
    get_ship_design, DEVELOPMENT_COSTS
)


@pytest.fixture
def game_state():
    """Create a test game state."""
    orbit = OrbitElements(
        rp=100.0, ra=100.0, omega=0.0, M0=0.0, epoch=0,
        direction=1, period=100.0, parent_body_id="sol"
    )

    state = GameState(
        game_id="test_game",
        current_tick=0,
    )

    # Add factions
    faction_a = Faction(
        id="faction_a",
        name="Faction A",
        color="#ff0000",
        is_player=True,
        resources={"metal": 1000, "fuel": 500, "gold": 200, "science": 300},
        tech_level=1,
    )

    faction_b = Faction(
        id="faction_b",
        name="Faction B",
        color="#0000ff",
        resources={"metal": 800, "fuel": 400, "gold": 100, "science": 200},
        tech_level=1,
    )

    state.factions.append(faction_a)
    state.factions.append(faction_b)

    # Add bodies
    earth = Body(
        id="earth",
        name="Earth",
        type=BodyType.TERRESTRIAL,
        radius=6.4,
        soi=1000.0,
        color="#4488ff",
        parent="sol",
        orbit_radius=150.0,
        orbit_period=365,
        owned_by="faction_a",
        development_level=2,
        resources={"metal": 100, "fuel": 50, "gold": 20, "science": 30},
    )
    state.bodies.append(earth)

    mars = Body(
        id="mars",
        name="Mars",
        type=BodyType.TERRESTRIAL,
        radius=3.4,
        soi=600.0,
        color="#ff6633",
        parent="sol",
        orbit_radius=230.0,
        orbit_period=687,
        owned_by="faction_b",
        development_level=1,
        resources={"metal": 80, "fuel": 30, "gold": 15, "science": 20},
    )
    state.bodies.append(mars)

    return state


def _earth(state):
    return next(b for b in state.bodies if b.id == "earth")


def _mars(state):
    return next(b for b in state.bodies if b.id == "mars")


@pytest.fixture
def chronicle():
    """Create a test chronicle."""
    return Chronicle()


class TestShipProduction:
    """Test ship production system."""

    def test_build_ship_frigate(self, game_state, chronicle):
        """Test building a frigate."""
        faction = game_state.factions[0]
        initial_metal = faction.resources["metal"]
        initial_fuel = faction.resources["fuel"]

        success, queue_id = build_ship(
            game_state, faction, ShipClass.FRIGATE, "earth", chronicle
        )

        assert success
        assert queue_id is not None

        # Check resources deducted
        design = SHIP_DESIGNS[ShipClass.FRIGATE]
        assert faction.resources["metal"] == initial_metal - design.metal_cost
        assert faction.resources["fuel"] == initial_fuel - design.fuel_cost

    def test_build_ship_insufficient_resources(self, game_state, chronicle):
        """Test building ship with insufficient resources."""
        faction = game_state.factions[0]
        faction.resources["metal"] = 50  # Less than frigate cost (100)

        success, queue_id = build_ship(
            game_state, faction, ShipClass.FRIGATE, "earth", chronicle
        )

        assert not success
        assert queue_id is None

    def test_complete_ship_production(self, game_state, chronicle):
        """Test completing ship production."""
        faction = game_state.factions[0]
        body = _earth(game_state)

        success, ship = complete_ship_production(
            game_state, faction, ShipClass.CRUISER, body, "queue_1", chronicle
        )

        assert success
        assert ship is not None
        assert ship.class_type == ShipClass.CRUISER
        assert ship.owned_by == faction.id
        assert ship.fuel == SHIP_DESIGNS[ShipClass.CRUISER].max_fuel


class TestBodyDevelopment:
    """Test body development upgrade system."""

    def test_upgrade_body_development(self, game_state, chronicle):
        """Test upgrading a body's development level."""
        faction = game_state.factions[0]
        body = _earth(game_state)
        initial_level = body.development_level

        # Ensure faction has enough resources
        faction.resources["metal"] = 1000
        faction.resources["gold"] = 1000

        success, queue_id = upgrade_body_development(
            game_state, faction, body, chronicle
        )

        assert success
        assert queue_id is not None

    def test_upgrade_insufficient_resources(self, game_state, chronicle):
        """Test upgrade with insufficient resources."""
        faction = game_state.factions[0]
        body = _earth(game_state)
        faction.resources["gold"] = 50  # Less than upgrade cost

        success, queue_id = upgrade_body_development(
            game_state, faction, body, chronicle
        )

        assert not success
        assert queue_id == ""

    def test_complete_body_development(self, game_state, chronicle):
        """Test completing a body development upgrade."""
        faction = game_state.factions[0]
        body = _earth(game_state)
        initial_level = body.development_level

        success = complete_body_development(
            game_state, faction, body, chronicle
        )

        assert success
        assert body.development_level == initial_level + 1

    def test_max_development_level(self, game_state, chronicle):
        """Test that development can't exceed level 5."""
        faction = game_state.factions[0]
        body = _earth(game_state)
        body.development_level = 5

        success = complete_body_development(
            game_state, faction, body, chronicle
        )

        assert not success
        assert body.development_level == 5


class TestFuelTransfer:
    """Test fuel transfer system."""

    def test_transfer_fuel(self, game_state, chronicle):
        """Test transferring fuel from body to ship."""
        faction = game_state.factions[0]
        body = _earth(game_state)

        # Create a ship
        orbit = OrbitElements(
            rp=100.0, ra=100.0, omega=0.0, M0=0.0, epoch=0,
            direction=1, period=100.0, parent_body_id="earth"
        )
        ship = Ship(
            id="ship_1",
            name="Test Ship",
            class_type=ShipClass.FRIGATE,
            owned_by=faction.id,
            fuel=100.0,
            orbit=orbit,
        )
        game_state.ships.append(ship)

        initial_body_fuel = body.resources["fuel"]
        initial_ship_fuel = ship.fuel
        transfer_amount = 50.0

        success = transfer_fuel(
            game_state, faction, ship.id, body.id, transfer_amount, chronicle
        )

        assert success
        assert body.resources["fuel"] == initial_body_fuel - transfer_amount
        assert ship.fuel == initial_ship_fuel + transfer_amount

    def test_transfer_more_than_body_has(self, game_state, chronicle):
        """Test transferring more fuel than body has."""
        faction = game_state.factions[0]
        body = _earth(game_state)

        orbit = OrbitElements(
            rp=100.0, ra=100.0, omega=0.0, M0=0.0, epoch=0,
            direction=1, period=100.0, parent_body_id="earth"
        )
        ship = Ship(
            id="ship_1",
            name="Test Ship",
            class_type=ShipClass.FRIGATE,
            owned_by=faction.id,
            fuel=100.0,
            orbit=orbit,
        )
        game_state.ships.append(ship)

        success = transfer_fuel(
            game_state, faction, ship.id, body.id, 1000.0, chronicle
        )

        assert not success

    def test_transfer_to_wrong_faction(self, game_state, chronicle):
        """Test transferring from body owned by different faction."""
        faction_a = game_state.factions[0]
        faction_b = game_state.factions[1]
        body = _earth(game_state)

        orbit = OrbitElements(
            rp=100.0, ra=100.0, omega=0.0, M0=0.0, epoch=0,
            direction=1, period=100.0, parent_body_id="earth"
        )
        ship = Ship(
            id="ship_2",
            name="Enemy Ship",
            class_type=ShipClass.FRIGATE,
            owned_by=faction_b.id,
            fuel=100.0,
            orbit=orbit,
        )
        game_state.ships.append(ship)

        success = transfer_fuel(
            game_state, faction_b, ship.id, body.id, 50.0, chronicle
        )

        assert not success


class TestTrading:
    """Test trading system."""

    def test_initiate_trade(self, game_state, chronicle):
        """Test trading resources between factions."""
        faction_a = game_state.factions[0]
        faction_b = game_state.factions[1]

        faction_a.resources["metal"] = 500
        faction_b.resources["gold"] = 1000

        initial_a_metal = faction_a.resources["metal"]
        initial_a_gold = faction_a.resources.get("gold", 0)
        initial_b_metal = faction_b.resources.get("metal", 0)
        initial_b_gold = faction_b.resources["gold"]

        success = initiate_trade(
            game_state,
            faction_a, faction_b,
            "metal", 100, 5,  # 100 metal at 5 gold each = 500 gold
            chronicle
        )

        assert success
        assert faction_a.resources["metal"] == initial_a_metal - 100
        assert faction_a.resources["gold"] == initial_a_gold + 500
        assert faction_b.resources["metal"] == initial_b_metal + 100
        assert faction_b.resources["gold"] == initial_b_gold - 500

    def test_trade_insufficient_resources(self, game_state, chronicle):
        """Test trading with insufficient resources."""
        faction_a = game_state.factions[0]
        faction_b = game_state.factions[1]

        faction_a.resources["metal"] = 50  # Less than 100

        success = initiate_trade(
            game_state,
            faction_a, faction_b,
            "metal", 100, 5,
            chronicle
        )

        assert not success

    def test_trade_insufficient_gold(self, game_state, chronicle):
        """Test trading when buyer lacks gold."""
        faction_a = game_state.factions[0]
        faction_b = game_state.factions[1]

        faction_a.resources["metal"] = 500
        faction_b.resources["gold"] = 100  # Less than 500

        success = initiate_trade(
            game_state,
            faction_a, faction_b,
            "metal", 100, 5,  # 100 * 5 = 500 gold
            chronicle
        )

        assert not success


class TestShipDesigns:
    """Test ship design lookup."""

    def test_get_frigate_design(self):
        """Test getting frigate design."""
        design = get_ship_design(ShipClass.FRIGATE)

        assert design is not None
        assert design["class_type"] == "frigate"
        assert design["metal_cost"] == 100
        assert design["fuel_cost"] == 50
        assert design["build_ticks"] == 5

    def test_get_all_designs(self):
        """Test all ship designs have costs."""
        for ship_class in ShipClass:
            design = get_ship_design(ship_class)
            assert design is not None
            assert "metal_cost" in design
            assert "fuel_cost" in design
            assert "gold_cost" in design
            assert "build_ticks" in design
            assert "max_fuel" in design
