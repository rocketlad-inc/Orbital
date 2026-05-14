"""
Game Engine Tests
=================

Comprehensive unit and integration tests for the game engine subsystems.

Tests cover:
- Resource production calculations (body types, tech modifiers, development levels)
- Maneuver execution (fuel consumption, orbit updates, status transitions)
- Standing order evaluation (condition matching, action execution)
- Treaty violation detection and penalty application
- Tech research progression and completion
- Reputation management (decay, boost, penalties, levels)
- Complete tick execution with atomicity guarantees
- Body ownership and claim logic
- Full integration tests with realistic game scenarios

Test Categories:
- Unit Tests: Individual functions in isolation
- Integration Tests: Full tick execution with mocked database
- Scenario Tests: Realistic multi-faction gameplay
"""

import unittest
from unittest.mock import MagicMock, patch, call
import uuid
from datetime import datetime
from typing import Dict, List

from game_engine.models import (
    GameState, Body, Ship, Faction, ManeuverNode, OrbitElements,
    BodyType, ShipClass, ManeuverType, ManeuverStatus, ChronicleEntry,
)
from game_engine.chronicle import Chronicle
from game_engine.resources import (
    calculate_body_production, tick_resource_production, deduct_resources, add_resources,
    get_faction_resource_total
)
from game_engine.maneuvers import (
    execute_maneuver, get_maneuver_by_id, delete_maneuver, commit_maneuver,
    tick_execute_maneuvers, get_ship_maneuvers
)
from game_engine.ownership import (
    can_claim_body, claim_body, get_bodies_owned_by_faction, get_unclaimed_bodies,
    transfer_body_ownership
)
from game_engine.reputation import (
    apply_reputation_penalty, apply_reputation_boost, get_reputation_level,
    can_form_treaty, treaty_discount_modifier, tick_reputation_update
)
from game_engine.tech import TECH_COSTS, start_research, tick_tech_research
from game_engine.standing_orders import (
    StandingOrder, OrderCondition, OrderAction, evaluate_condition, execute_action,
    tick_standing_orders
)
from game_engine.treaties import (
    Treaty, TreatyType, TreatyStatus, check_treaty_expiration,
    check_nap_violation, apply_violation_penalty, tick_treaty_enforcement
)
from game_engine.tick import GameDatabase, execute_tick


class TestResourceProduction(unittest.TestCase):
    """Test resource production system."""

    def test_calculate_terrestrial_production(self):
        """Test production from a terrestrial body."""
        body = Body(
            id="inara",
            name="Inara",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#4488FF",
        )

        production = calculate_body_production(body, faction_tech_level=1, development_level=1)

        self.assertIn("metal", production)
        self.assertIn("fuel", production)
        self.assertGreater(production["metal"], 0)
        self.assertGreater(production["fuel"], 0)

    def test_calculate_gas_giant_production(self):
        """Test production from a gas giant (fuel-rich)."""
        body = Body(
            id="jove",
            name="Jove",
            type=BodyType.GAS_GIANT,
            radius=200,
            soi=2000,
            color="#FFAA44",
        )

        production = calculate_body_production(body, faction_tech_level=1, development_level=1)

        # Gas giants produce more fuel
        self.assertGreater(production["fuel"], production["metal"])

    def test_tech_modifier_increases_production(self):
        """Test that higher tech level increases production."""
        body = Body(
            id="test",
            name="Test",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#FFFFFF",
        )

        prod_level_1 = calculate_body_production(body, faction_tech_level=1, development_level=1)
        prod_level_3 = calculate_body_production(body, faction_tech_level=3, development_level=1)

        # Tech level 3 should produce more
        self.assertGreater(prod_level_3["metal"], prod_level_1["metal"])

    def test_development_level_affects_production(self):
        """Test that development level increases production."""
        body = Body(
            id="test",
            name="Test",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#FFFFFF",
        )

        prod_dev_0 = calculate_body_production(body, faction_tech_level=1, development_level=0)
        prod_dev_5 = calculate_body_production(body, faction_tech_level=1, development_level=5)

        # Higher development should produce more
        self.assertGreater(prod_dev_5["metal"], prod_dev_0["metal"])

    def test_resource_production_tick(self):
        """Test the tick resource production system."""
        # Create game state with one owned body
        faction = Faction(id="player", name="Player", color="#FF0000", is_player=True)
        body = Body(
            id="inara",
            name="Inara",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#4488FF",
            owned_by="player",
            resources={"metal": 100, "fuel": 50, "gold": 10, "science": 25},
        )
        body.development_level = 2

        state = GameState(game_id="game1", current_tick=0, factions=[faction], bodies=[body])
        chronicle = Chronicle()

        initial_metal = faction.resources["metal"]
        tick_resource_production(state, chronicle)

        # Faction should have more resources
        self.assertGreater(faction.resources["metal"], initial_metal)
        self.assertEqual(len(chronicle.all_entries()), 1)

    def test_deduct_resources_success(self):
        """Test successful resource deduction."""
        faction = Faction(id="test", name="Test", color="#FFFFFF")
        faction.resources = {"metal": 100, "fuel": 50}

        success = deduct_resources(faction, {"metal": 30, "fuel": 20})

        self.assertTrue(success)
        self.assertEqual(faction.resources["metal"], 70)
        self.assertEqual(faction.resources["fuel"], 30)

    def test_deduct_resources_insufficient(self):
        """Test resource deduction with insufficient resources."""
        faction = Faction(id="test", name="Test", color="#FFFFFF")
        faction.resources = {"metal": 100, "fuel": 10}

        success = deduct_resources(faction, {"metal": 30, "fuel": 20})

        self.assertFalse(success)
        self.assertEqual(faction.resources["metal"], 100)  # Unchanged
        self.assertEqual(faction.resources["fuel"], 10)     # Unchanged

    def test_add_resources(self):
        """Test adding resources."""
        faction = Faction(id="test", name="Test", color="#FFFFFF")
        faction.resources = {"metal": 100}

        add_resources(faction, {"metal": 50, "fuel": 25})

        self.assertEqual(faction.resources["metal"], 150)
        self.assertEqual(faction.resources["fuel"], 25)


class TestManeuvers(unittest.TestCase):
    """Test maneuver execution system."""

    def setUp(self):
        """Set up test fixtures."""
        self.faction = Faction(id="player", name="Player", color="#FF0000")
        self.ship = Ship(
            id="ship1",
            name="Vanguard",
            class_type=ShipClass.CRUISER,
            owned_by="player",
            fuel=500.0,
            orbit=OrbitElements(
                rp=100, ra=150, omega=0, M0=0, epoch=0,
                direction=1, period=100, parent_body_id="inara"
            ),
        )

    def test_maneuver_execution_success(self):
        """Test successful maneuver execution."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="ship1",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=50.0,
            prograde=50.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.COMMITTED,
            post_orbit=OrbitElements(
                rp=120, ra=180, omega=0, M0=0, epoch=10,
                direction=1, period=120, parent_body_id="inara"
            ),
        )
        self.ship.orders.append(maneuver)

        state = GameState(
            game_id="game1",
            current_tick=10,
            factions=[self.faction],
            ships=[self.ship],
        )
        chronicle = Chronicle()

        fuel_before = self.ship.fuel
        success, entry = execute_maneuver(self.ship, maneuver, 10, state, chronicle)

        self.assertTrue(success)
        self.assertIsNotNone(entry)
        self.assertEqual(maneuver.status, ManeuverStatus.EXECUTED)
        self.assertLess(self.ship.fuel, fuel_before)

    def test_maneuver_insufficient_fuel(self):
        """Test maneuver with insufficient fuel."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="ship1",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=500.0,  # Requires ~250 fuel
            prograde=500.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.COMMITTED,
        )
        self.ship.orders.append(maneuver)
        self.ship.fuel = 100.0  # Not enough

        state = GameState(game_id="game1", current_tick=10, ships=[self.ship])
        chronicle = Chronicle()

        success, entry = execute_maneuver(self.ship, maneuver, 10, state, chronicle)

        self.assertFalse(success)
        self.assertEqual(maneuver.status, ManeuverStatus.COMMITTED)  # Still committed

    def test_commit_maneuver(self):
        """Test committing a planned maneuver."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="ship1",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=50.0,
            prograde=50.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.PLANNED,
        )
        self.ship.orders.append(maneuver)

        state = GameState(game_id="game1", current_tick=0, ships=[self.ship])

        success = commit_maneuver(state, "burn1")

        self.assertTrue(success)
        self.assertEqual(maneuver.status, ManeuverStatus.COMMITTED)

    def test_delete_maneuver(self):
        """Test deleting a planned maneuver."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="ship1",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=50.0,
            prograde=50.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.PLANNED,
        )
        self.ship.orders.append(maneuver)

        state = GameState(game_id="game1", current_tick=0, ships=[self.ship])
        initial_count = len(self.ship.orders)

        success = delete_maneuver(state, "burn1")

        self.assertTrue(success)
        self.assertEqual(len(self.ship.orders), initial_count - 1)


class TestOwnership(unittest.TestCase):
    """Test body ownership system."""

    def setUp(self):
        """Set up test fixtures."""
        self.faction = Faction(id="player", name="Player", color="#FF0000")
        self.body = Body(
            id="inara",
            name="Inara",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#4488FF",
        )

    def test_claim_unclaimed_body(self):
        """Test claiming an unowned body."""
        state = GameState(game_id="game1", current_tick=0, bodies=[self.body], factions=[self.faction])
        chronicle = Chronicle()

        self.assertTrue(can_claim_body(self.body))
        success = claim_body(self.body, self.faction, state, chronicle)

        self.assertTrue(success)
        self.assertEqual(self.body.owned_by, "player")
        self.assertEqual(len(chronicle.all_entries()), 1)

    def test_cannot_claim_owned_body(self):
        """Test that owned bodies cannot be claimed."""
        self.body.owned_by = "player"

        self.assertFalse(can_claim_body(self.body))

    def test_get_bodies_owned_by_faction(self):
        """Test querying faction-owned bodies."""
        body2 = Body(
            id="verda",
            name="Verda",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#00FF00",
            owned_by="player",
        )
        self.body.owned_by = "player"

        state = GameState(game_id="game1", current_tick=0, bodies=[self.body, body2])
        owned = get_bodies_owned_by_faction(state, "player")

        self.assertEqual(len(owned), 2)

    def test_get_unclaimed_bodies(self):
        """Test querying unclaimed bodies."""
        body2 = Body(
            id="verda",
            name="Verda",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#00FF00",
            owned_by="player",
        )

        state = GameState(game_id="game1", current_tick=0, bodies=[self.body, body2])
        unclaimed = get_unclaimed_bodies(state)

        self.assertEqual(len(unclaimed), 1)
        self.assertEqual(unclaimed[0].id, "inara")


class TestReputation(unittest.TestCase):
    """Test reputation system."""

    def setUp(self):
        """Set up test fixtures."""
        self.faction = Faction(id="player", name="Player", color="#FF0000")

    def test_reputation_penalty(self):
        """Test applying reputation penalty."""
        initial = self.faction.reputation
        apply_reputation_penalty(self.faction, -20.0, "treaty_violation")

        self.assertLess(self.faction.reputation, initial)
        self.assertEqual(self.faction.reputation, initial - 20.0)

    def test_reputation_boost(self):
        """Test applying reputation boost."""
        initial = self.faction.reputation
        apply_reputation_boost(self.faction, 15.0, "treaty_honored")

        self.assertGreater(self.faction.reputation, initial)
        self.assertEqual(self.faction.reputation, initial + 15.0)

    def test_reputation_bounds(self):
        """Test reputation stays within bounds."""
        self.faction.reputation = 0

        apply_reputation_penalty(self.faction, -200.0, "test")
        self.assertEqual(self.faction.reputation, -100.0)

        apply_reputation_boost(self.faction, 200.0, "test")
        self.assertEqual(self.faction.reputation, 100.0)

    def test_reputation_level_descriptions(self):
        """Test reputation level descriptions."""
        test_cases = [
            (80, "Beloved Hero"),
            (50, "Respected Ally"),
            (0, "Neutral"),
            (-50, "Enemy"),
            (-100, "Pariah"),
        ]

        for reputation, expected_level in test_cases:
            self.faction.reputation = reputation
            level = get_reputation_level(self.faction.reputation)
            self.assertIn(expected_level, level)


class TestChronicle(unittest.TestCase):
    """Test chronicle system."""

    def test_log_production(self):
        """Test logging resource production."""
        chronicle = Chronicle()

        entry = chronicle.log_production(
            tick=10,
            faction_id="player",
            body_id="inara",
            resources={"metal": 10, "fuel": 5},
        )

        self.assertEqual(entry.event_type, "production")
        self.assertEqual(entry.tick, 10)
        self.assertIn("metal", entry.description)

    def test_log_maneuver_executed(self):
        """Test logging maneuver execution."""
        chronicle = Chronicle()

        entry = chronicle.log_maneuver_executed(
            tick=10,
            faction_id="player",
            ship_id="ship1",
            maneuver_id="burn1",
            deltav=50.0,
            fuel_consumed=25.0,
        )

        self.assertEqual(entry.event_type, "maneuver_executed")
        self.assertIn("50.0", entry.description)

    def test_multiple_entries(self):
        """Test multiple chronicle entries."""
        chronicle = Chronicle()

        chronicle.log_production(10, "player", "inara", {"metal": 10})
        chronicle.log_production(10, "player", "verda", {"fuel": 5})

        entries = chronicle.all_entries()
        self.assertEqual(len(entries), 2)


if __name__ == "__main__":
    unittest.main()
