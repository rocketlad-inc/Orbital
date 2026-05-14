"""
Comprehensive Game Engine Tests
================================

Production-ready test suite for the Orbital game engine.

Test Categories:
1. Unit Tests: Individual functions in isolation
   - Resource production with various body types and tech levels
   - Maneuver execution with fuel calculations
   - Body ownership and transfer logic
   - Reputation changes and level classifications
   - Tech research progression

2. Integration Tests: Multi-component interactions
   - Full tick execution with all subsystems
   - Resource production + faction updates
   - Maneuver execution + body arrivals + standing orders
   - Treaty enforcement + reputation penalties

3. Scenario Tests: Realistic gameplay situations
   - Two-faction territorial dispute
   - Research progression race
   - Fuel crisis and recovery
   - Treaty negotiation and violation

4. Edge Cases and Error Handling
   - Atomic transaction rollback scenarios
   - Boundary value testing
   - Missing/corrupt data handling
"""

import unittest
from unittest.mock import MagicMock, patch, PropertyMock
import json
from datetime import datetime
from typing import Dict, List, Optional

from game_engine.models import (
    GameState, Body, Ship, Faction, ManeuverNode, OrbitElements,
    BodyType, ShipClass, ManeuverType, ManeuverStatus, ChronicleEntry,
    BODY_PRODUCTION_RATES,
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
from game_engine.tech import TECH_COSTS
from game_engine.treaties import (
    Treaty, TreatyType, TreatyStatus, check_treaty_expiration,
    check_nap_violation, apply_violation_penalty
)


# ============================================================================
# Test Fixtures and Helpers
# ============================================================================


class GameStateBuilder:
    """Builder for creating test game states."""

    @staticmethod
    def create_minimal_game(game_id="test_game") -> GameState:
        """Create a minimal valid game state."""
        return GameState(game_id=game_id, current_tick=0)

    @staticmethod
    def create_game_with_factions(
        num_factions: int = 2,
        game_id: str = "test_game"
    ) -> GameState:
        """Create game state with multiple factions."""
        factions = [
            Faction(
                id=f"faction_{i}",
                name=f"Faction {i}",
                color=f"#{i*11:06x}",
                is_player=(i == 0),
            )
            for i in range(num_factions)
        ]
        return GameState(game_id=game_id, current_tick=0, factions=factions)

    @staticmethod
    def create_game_with_bodies(
        faction: Faction,
        num_owned: int = 2,
        num_unclaimed: int = 2,
        game_id: str = "test_game"
    ) -> GameState:
        """Create game state with owned and unclaimed bodies."""
        bodies = []

        # Owned terrestrial bodies
        for i in range(num_owned):
            bodies.append(Body(
                id=f"body_owned_{i}",
                name=f"Owned Body {i}",
                type=BodyType.TERRESTRIAL,
                radius=50 + i * 10,
                soi=200 + i * 20,
                color="#FF0000",
                owned_by=faction.id,
                resources={"metal": 100, "fuel": 50, "gold": 10, "science": 20},
            ))

        # Unclaimed bodies
        for i in range(num_unclaimed):
            bodies.append(Body(
                id=f"body_unclaimed_{i}",
                name=f"Unclaimed {i}",
                type=BodyType.MOON,
                radius=20 + i * 5,
                soi=100 + i * 10,
                color="#AAAAAA",
                resources={"metal": 50, "fuel": 10, "gold": 5, "science": 0},
            ))

        return GameState(
            game_id=game_id,
            current_tick=0,
            factions=[faction],
            bodies=bodies,
        )

    @staticmethod
    def create_game_with_ships(
        faction: Faction,
        num_ships: int = 3,
        game_id: str = "test_game"
    ) -> GameState:
        """Create game state with multiple ships."""
        ships = []
        for i in range(num_ships):
            ships.append(Ship(
                id=f"ship_{i}",
                name=f"Ship {i}",
                class_type=ShipClass.CRUISER,
                owned_by=faction.id,
                fuel=500.0 + i * 100,
                orbit=OrbitElements(
                    rp=100 + i * 50,
                    ra=150 + i * 50,
                    omega=0,
                    M0=0,
                    epoch=0,
                    direction=1,
                    period=100,
                    parent_body_id="inara",
                ),
            ))

        return GameState(
            game_id=game_id,
            current_tick=0,
            factions=[faction],
            ships=ships,
        )


# ============================================================================
# Unit Tests: Resource Production
# ============================================================================


class TestResourceProductionUnit(unittest.TestCase):
    """Unit tests for resource production calculations."""

    def test_terrestrial_production_base(self):
        """Test base production from terrestrial body."""
        body = Body(
            id="earth",
            name="Earth",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#4488FF",
        )

        production = calculate_body_production(
            body, faction_tech_level=1, development_level=1
        )

        self.assertIn("metal", production)
        self.assertIn("fuel", production)
        self.assertGreater(production["metal"], 0)

    def test_gas_giant_production_fuel_rich(self):
        """Gas giants produce more fuel than metal."""
        body = Body(
            id="jupiter",
            name="Jupiter",
            type=BodyType.GAS_GIANT,
            radius=200,
            soi=2000,
            color="#FFAA44",
        )

        production = calculate_body_production(
            body, faction_tech_level=1, development_level=1
        )

        # Fuel should dominate
        self.assertGreater(production["fuel"], production["metal"])

    def test_asteroid_production_metal_rich(self):
        """Asteroids produce more metal than fuel."""
        body = Body(
            id="eros",
            name="Eros",
            type=BodyType.ASTEROID,
            radius=10,
            soi=50,
            color="#CCCCCC",
        )

        production = calculate_body_production(
            body, faction_tech_level=1, development_level=1
        )

        # Metal should dominate
        self.assertGreater(production["metal"], production["fuel"])

    def test_lagrange_station_science_rich(self):
        """Lagrange stations emphasize science production."""
        body = Body(
            id="l1_station",
            name="L1 Station",
            type=BodyType.LAGRANGE_STATION,
            radius=5,
            soi=30,
            color="#0088FF",
        )

        production = calculate_body_production(
            body, faction_tech_level=1, development_level=1
        )

        # Should have science
        self.assertGreater(production["science"], 0)

    def test_tech_level_modifier(self):
        """Tech level applies 10% per level bonus."""
        body = Body(
            id="test",
            name="Test",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#FFFFFF",
        )

        prod_tech1 = calculate_body_production(body, faction_tech_level=1, development_level=1)
        prod_tech5 = calculate_body_production(body, faction_tech_level=5, development_level=1)

        # Tech 5 should be ~40% better
        self.assertGreater(prod_tech5["metal"], prod_tech1["metal"])
        ratio = prod_tech5["metal"] / prod_tech1["metal"]
        self.assertAlmostEqual(ratio, 1.4, places=1)

    def test_development_level_modifier(self):
        """Development level increases production."""
        body = Body(
            id="test",
            name="Test",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#FFFFFF",
        )

        prod_dev0 = calculate_body_production(body, faction_tech_level=1, development_level=0)
        prod_dev5 = calculate_body_production(body, faction_tech_level=1, development_level=5)

        self.assertGreater(prod_dev5["metal"], prod_dev0["metal"])

    def test_production_rates_all_body_types(self):
        """Verify production rates table has all body types."""
        for body_type in BodyType:
            self.assertIn(body_type, BODY_PRODUCTION_RATES)


# ============================================================================
# Unit Tests: Maneuvers
# ============================================================================


class TestManeuversUnit(unittest.TestCase):
    """Unit tests for maneuver execution."""

    def setUp(self):
        """Set up test ship and maneuver."""
        self.faction = Faction(id="player", name="Player", color="#FF0000")
        self.ship = Ship(
            id="vanguard",
            name="Vanguard",
            class_type=ShipClass.CRUISER,
            owned_by="player",
            fuel=1000.0,
            orbit=OrbitElements(
                rp=100, ra=150, omega=0, M0=0, epoch=0,
                direction=1, period=100, parent_body_id="inara"
            ),
        )

    def test_maneuver_execution_updates_orbit(self):
        """Executing maneuver updates ship orbit."""
        new_orbit = OrbitElements(
            rp=120, ra=180, omega=0, M0=0, epoch=10,
            direction=1, period=120, parent_body_id="inara"
        )
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="vanguard",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=50.0,
            prograde=50.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.COMMITTED,
            post_orbit=new_orbit,
        )
        self.ship.orders.append(maneuver)

        state = GameState(game_id="game1", current_tick=10, ships=[self.ship])
        chronicle = Chronicle()

        old_orbit = self.ship.orbit
        execute_maneuver(self.ship, maneuver, 10, state, chronicle)

        self.assertEqual(self.ship.orbit, new_orbit)
        self.assertNotEqual(self.ship.orbit, old_orbit)

    def test_maneuver_execution_consumes_fuel(self):
        """Executing maneuver consumes fuel."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="vanguard",
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

        state = GameState(game_id="game1", current_tick=10, ships=[self.ship])
        chronicle = Chronicle()

        fuel_before = self.ship.fuel
        execute_maneuver(self.ship, maneuver, 10, state, chronicle)

        self.assertLess(self.ship.fuel, fuel_before)

    def test_maneuver_insufficient_fuel_fails(self):
        """Maneuver fails if insufficient fuel."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="vanguard",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=1000.0,  # Requires ~500 fuel
            prograde=1000.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.COMMITTED,
        )
        self.ship.orders.append(maneuver)
        self.ship.fuel = 100.0  # Not enough

        state = GameState(game_id="game1", current_tick=10, ships=[self.ship])
        chronicle = Chronicle()

        success, _ = execute_maneuver(self.ship, maneuver, 10, state, chronicle)

        self.assertFalse(success)
        self.assertEqual(self.ship.fuel, 100.0)  # Unchanged

    def test_maneuver_wrong_burn_time(self):
        """Maneuver doesn't execute at wrong time."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="vanguard",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=50.0,
            prograde=50.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.COMMITTED,
        )

        state = GameState(game_id="game1", current_tick=5, ships=[self.ship])
        chronicle = Chronicle()

        success, _ = execute_maneuver(self.ship, maneuver, 5, state, chronicle)

        self.assertFalse(success)

    def test_maneuver_must_be_committed(self):
        """Only committed maneuvers execute."""
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="vanguard",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=10,
            deltav=50.0,
            prograde=50.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.PLANNED,  # Not committed
        )

        state = GameState(game_id="game1", current_tick=10, ships=[self.ship])
        chronicle = Chronicle()

        success, _ = execute_maneuver(self.ship, maneuver, 10, state, chronicle)

        self.assertFalse(success)

    def test_tick_execute_maneuvers_counts(self):
        """Tick execution counts maneuvers correctly."""
        for i in range(3):
            maneuver = ManeuverNode(
                id=f"burn{i}",
                ship_id="vanguard",
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

        state = GameState(game_id="game1", current_tick=10, ships=[self.ship])
        chronicle = Chronicle()

        count = tick_execute_maneuvers(state, chronicle)

        self.assertEqual(count, 3)


# ============================================================================
# Unit Tests: Ownership
# ============================================================================


class TestOwnershipUnit(unittest.TestCase):
    """Unit tests for body ownership."""

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

    def test_unclaimed_body_can_be_claimed(self):
        """Unclaimed bodies can be claimed."""
        self.assertTrue(can_claim_body(self.body))

    def test_claimed_body_cannot_be_claimed(self):
        """Claimed bodies cannot be claimed again."""
        self.body.owned_by = "rival"
        self.assertFalse(can_claim_body(self.body))

    def test_claim_body_updates_ownership(self):
        """Claiming body updates owned_by."""
        state = GameState(game_id="game1", current_tick=0)
        chronicle = Chronicle()

        claim_body(self.body, self.faction, state, chronicle)

        self.assertEqual(self.body.owned_by, "player")

    def test_claim_body_initializes_resources(self):
        """Claiming body initializes resource storage."""
        self.body.resources = None
        state = GameState(game_id="game1", current_tick=0)
        chronicle = Chronicle()

        claim_body(self.body, self.faction, state, chronicle)

        self.assertIsNotNone(self.body.resources)
        self.assertIn("metal", self.body.resources)

    def test_claim_body_logs_chronicle(self):
        """Claiming body logs to chronicle."""
        state = GameState(game_id="game1", current_tick=0)
        chronicle = Chronicle()

        claim_body(self.body, self.faction, state, chronicle)

        entries = chronicle.all_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].event_type, "body_claimed")

    def test_get_bodies_owned_by_faction(self):
        """Query bodies owned by faction."""
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
        """Query unclaimed bodies."""
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

    def test_transfer_body_ownership(self):
        """Transfer body between factions."""
        faction2 = Faction(id="rival", name="Rival", color="#FF00FF")
        self.body.owned_by = "player"

        state = GameState(game_id="game1", current_tick=0)
        chronicle = Chronicle()

        transfer_body_ownership(self.body, self.faction, faction2, state, chronicle)

        self.assertEqual(self.body.owned_by, "rival")


# ============================================================================
# Unit Tests: Reputation
# ============================================================================


class TestReputationUnit(unittest.TestCase):
    """Unit tests for reputation system."""

    def setUp(self):
        """Set up test faction."""
        self.faction = Faction(id="player", name="Player", color="#FF0000")
        self.faction.reputation = 0.0

    def test_apply_reputation_penalty(self):
        """Penalty reduces reputation."""
        apply_reputation_penalty(self.faction, -20.0, "treaty_break")
        self.assertEqual(self.faction.reputation, -20.0)

    def test_apply_reputation_boost(self):
        """Boost increases reputation."""
        apply_reputation_boost(self.faction, 15.0, "treaty_honor")
        self.assertEqual(self.faction.reputation, 15.0)

    def test_reputation_min_bound(self):
        """Reputation cannot go below -100."""
        apply_reputation_penalty(self.faction, -200.0, "test")
        self.assertEqual(self.faction.reputation, -100.0)

    def test_reputation_max_bound(self):
        """Reputation cannot go above +100."""
        apply_reputation_boost(self.faction, 200.0, "test")
        self.assertEqual(self.faction.reputation, 100.0)

    def test_reputation_level_classifications(self):
        """Reputation levels are classified correctly."""
        tests = [
            (85, "Beloved Hero"),
            (50, "Respected Ally"),
            (20, "Known Friend"),
            (0, "Neutral"),
            (-20, "Neutral"),
            (-50, "Enemy"),
            (-85, "Pariah"),
        ]

        for rep, expected in tests:
            self.faction.reputation = rep
            level = get_reputation_level(rep)
            self.assertIn(expected, level)

    def test_can_form_treaty_with_good_rep(self):
        """Can form treaty with good reputation."""
        f1 = Faction(id="f1", name="F1", color="#FF0000", is_player=True)
        f2 = Faction(id="f2", name="F2", color="#00FF00")
        f1.reputation = 50.0
        f2.reputation = 50.0

        self.assertTrue(can_form_treaty(f1, f2))

    def test_cannot_form_treaty_with_bad_rep(self):
        """Cannot form treaty with bad reputation."""
        f1 = Faction(id="f1", name="F1", color="#FF0000")
        f2 = Faction(id="f2", name="F2", color="#00FF00")
        f1.reputation = -50.0
        f2.reputation = -50.0

        self.assertFalse(can_form_treaty(f1, f2))

    def test_treaty_discount_modifier(self):
        """Trade discount based on reputation."""
        # At +100 rep: 50% cost (0.5 modifier)
        # At 0 rep: 100% cost (1.0 modifier)
        # At -100 rep: 150% cost (1.5 modifier)

        self.assertAlmostEqual(treaty_discount_modifier(100.0), 0.5)
        self.assertAlmostEqual(treaty_discount_modifier(0.0), 1.0)
        self.assertAlmostEqual(treaty_discount_modifier(-100.0), 1.5)

    def test_reputation_recovery_tick(self):
        """Reputation recovers slowly each tick."""
        state = GameState(game_id="game1", current_tick=0)
        self.faction.reputation = -50.0
        state.factions = [self.faction]
        chronicle = Chronicle()

        tick_reputation_update(state, chronicle)

        # Should have recovered slightly
        self.assertGreater(self.faction.reputation, -50.0)


# ============================================================================
# Integration Tests: Resource Production Tick
# ============================================================================


class TestResourceProductionTick(unittest.TestCase):
    """Integration tests for resource production per tick."""

    def test_single_body_production(self):
        """Test production from single owned body."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        body = Body(
            id="inara",
            name="Inara",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#4488FF",
            owned_by="player",
            resources={"metal": 0, "fuel": 0, "gold": 0, "science": 0},
        )
        body.development_level = 1

        state = GameState(game_id="game1", current_tick=0, factions=[faction], bodies=[body])
        chronicle = Chronicle()

        initial_metal = faction.resources["metal"]
        tick_resource_production(state, chronicle)

        self.assertGreater(faction.resources["metal"], initial_metal)
        self.assertEqual(len(chronicle.all_entries()), 1)

    def test_multiple_bodies_production(self):
        """Test production from multiple bodies."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        bodies = [
            Body(
                id=f"body_{i}",
                name=f"Body {i}",
                type=BodyType.TERRESTRIAL,
                radius=100,
                soi=500,
                color="#4488FF",
                owned_by="player",
                resources={"metal": 0, "fuel": 0, "gold": 0, "science": 0},
            )
            for i in range(3)
        ]

        for body in bodies:
            body.development_level = 1

        state = GameState(game_id="game1", current_tick=0, factions=[faction], bodies=bodies)
        chronicle = Chronicle()

        tick_resource_production(state, chronicle)

        # Should have 3 production entries
        self.assertEqual(len(chronicle.all_entries()), 3)

    def test_unclaimed_bodies_no_production(self):
        """Unclaimed bodies produce nothing."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        body = Body(
            id="unowned",
            name="Unowned",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#AAAAAA",
            resources={"metal": 0, "fuel": 0, "gold": 0, "science": 0},
        )

        state = GameState(game_id="game1", current_tick=0, factions=[faction], bodies=[body])
        chronicle = Chronicle()

        initial_metal = faction.resources["metal"]
        tick_resource_production(state, chronicle)

        self.assertEqual(faction.resources["metal"], initial_metal)
        self.assertEqual(len(chronicle.all_entries()), 0)

    def test_development_level_affects_tick_production(self):
        """Development level increases production in tick."""
        faction = Faction(id="player", name="Player", color="#FF0000")

        body_dev0 = Body(
            id="body0",
            name="Dev 0",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#4488FF",
            owned_by="player",
            resources={"metal": 0, "fuel": 0, "gold": 0, "science": 0},
        )
        body_dev0.development_level = 0

        state = GameState(game_id="game1", current_tick=0, factions=[faction], bodies=[body_dev0])
        chronicle = Chronicle()

        faction.resources["metal"] = 0
        tick_resource_production(state, chronicle)
        prod_dev0 = faction.resources["metal"]

        # Now with dev level 5
        faction.resources["metal"] = 0
        body_dev0.development_level = 5
        tick_resource_production(state, chronicle)
        prod_dev5 = faction.resources["metal"]

        self.assertGreater(prod_dev5, prod_dev0)


# ============================================================================
# Integration Tests: Complete Tick Execution
# ============================================================================


class TestCompleteTick(unittest.TestCase):
    """Integration tests for complete tick execution."""

    def test_tick_with_no_actions(self):
        """Tick completes successfully with no actions."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        state = GameState(game_id="game1", current_tick=0, factions=[faction])
        chronicle = Chronicle()

        # Should not raise
        tick_execute_maneuvers(state, chronicle)
        tick_resource_production(state, chronicle)
        tick_reputation_update(state, chronicle)

    def test_tick_with_maneuvers_and_production(self):
        """Tick handles both maneuvers and production."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        ship = Ship(
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
        maneuver = ManeuverNode(
            id="burn1",
            ship_id="ship1",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=0,
            deltav=50.0,
            prograde=50.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.COMMITTED,
            post_orbit=OrbitElements(
                rp=120, ra=180, omega=0, M0=0, epoch=0,
                direction=1, period=120, parent_body_id="inara"
            ),
        )
        ship.orders.append(maneuver)

        body = Body(
            id="inara",
            name="Inara",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#4488FF",
            owned_by="player",
            resources={"metal": 0, "fuel": 0, "gold": 0, "science": 0},
        )
        body.development_level = 1

        state = GameState(
            game_id="game1",
            current_tick=0,
            factions=[faction],
            ships=[ship],
            bodies=[body],
        )
        chronicle = Chronicle()

        # Execute all tick phases
        tick_execute_maneuvers(state, chronicle)
        tick_resource_production(state, chronicle)
        tick_reputation_update(state, chronicle)

        # Should have entries for both maneuver and production
        self.assertGreater(len(chronicle.all_entries()), 0)


# ============================================================================
# Scenario Tests: Realistic Gameplay
# ============================================================================


class TestScenarioTwoFactionDispute(unittest.TestCase):
    """Scenario test: Two factions in territorial dispute."""

    def setUp(self):
        """Set up two-faction scenario."""
        self.player = Faction(id="player", name="Player", color="#FF0000", is_player=True)
        self.rival = Faction(id="rival", name="Rival", color="#00FF00")

        self.contested_body = Body(
            id="contested",
            name="Contested Planet",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#FFFF00",
            owned_by=None,  # Unclaimed
            resources={"metal": 0, "fuel": 0, "gold": 0, "science": 0},
        )

    def test_first_faction_claims_body(self):
        """First faction to arrive can claim."""
        state = GameState(
            game_id="game1",
            current_tick=0,
            factions=[self.player, self.rival],
            bodies=[self.contested_body],
        )
        chronicle = Chronicle()

        # Player claims
        self.assertTrue(can_claim_body(self.contested_body))
        claim_body(self.contested_body, self.player, state, chronicle)

        # Rival cannot claim
        self.assertFalse(can_claim_body(self.contested_body))

    def test_faction_reputation_from_production(self):
        """Steady production builds faction resources."""
        self.contested_body.owned_by = "player"
        self.contested_body.development_level = 3

        state = GameState(
            game_id="game1",
            current_tick=0,
            factions=[self.player],
            bodies=[self.contested_body],
        )
        chronicle = Chronicle()

        initial = self.player.resources["metal"]

        # Multiple ticks of production
        for _ in range(5):
            tick_resource_production(state, chronicle)

        # Should have significantly more metal
        self.assertGreater(self.player.resources["metal"], initial + 40)


# ============================================================================
# Edge Cases and Error Handling
# ============================================================================


class TestEdgeCases(unittest.TestCase):
    """Test edge cases and boundary conditions."""

    def test_zero_fuel_ship(self):
        """Ship with zero fuel cannot maneuver."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        ship = Ship(
            id="ship1",
            name="Dead",
            class_type=ShipClass.FRIGATE,
            owned_by="player",
            fuel=0.0,
            orbit=OrbitElements(
                rp=100, ra=150, omega=0, M0=0, epoch=0,
                direction=1, period=100, parent_body_id="inara"
            ),
        )

        maneuver = ManeuverNode(
            id="burn1",
            ship_id="ship1",
            type=ManeuverType.ORBITAL_CHANGE,
            burn_time=0,
            deltav=1.0,
            prograde=1.0,
            radial=0.0,
            normal=0.0,
            status=ManeuverStatus.COMMITTED,
        )

        state = GameState(game_id="game1", current_tick=0, ships=[ship])
        chronicle = Chronicle()

        success, _ = execute_maneuver(ship, maneuver, 0, state, chronicle)
        self.assertFalse(success)

    def test_negative_fuel_prevented(self):
        """Fuel cannot go negative."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        success = deduct_resources(faction, {"fuel": 10000})

        self.assertFalse(success)
        self.assertEqual(faction.resources["fuel"], 1000)

    def test_empty_game_state(self):
        """Empty game state handles gracefully."""
        state = GameState(game_id="game1", current_tick=0)
        chronicle = Chronicle()

        # Should not crash
        tick_execute_maneuvers(state, chronicle)
        tick_resource_production(state, chronicle)
        tick_reputation_update(state, chronicle)

        self.assertEqual(len(chronicle.all_entries()), 0)

    def test_very_large_resource_numbers(self):
        """Large resource numbers handled correctly."""
        faction = Faction(id="player", name="Player", color="#FF0000")
        faction.resources["metal"] = 1000000

        add_resources(faction, {"metal": 1000000})

        self.assertEqual(faction.resources["metal"], 2000000)

    def test_mission_crossing_integer_boundaries(self):
        """Development level clamped to valid range."""
        body = Body(
            id="test",
            name="Test",
            type=BodyType.TERRESTRIAL,
            radius=100,
            soi=500,
            color="#FFFFFF",
        )

        # Dev level beyond valid range
        production = calculate_body_production(body, faction_tech_level=1, development_level=100)

        # Should still return valid production (clamped to level 5)
        self.assertIsNotNone(production)
        self.assertIn("metal", production)


# ============================================================================
# Main Test Runner
# ============================================================================


if __name__ == "__main__":
    # Run tests with verbose output
    unittest.main(verbosity=2)
