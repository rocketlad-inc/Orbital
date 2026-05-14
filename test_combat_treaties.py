"""
Combat and Treaty System Tests
==============================

Comprehensive test suite for:
- Combat resolution with orbital velocity mechanics
- Treaty violation detection
- Reputation tracking and decay
- Chronicle logging
- Atomic transaction handling
"""

import unittest
from game_engine.combat import (
    resolve_combat, check_can_engage, get_engagement_range, get_base_damage,
    calculate_relative_velocity_bonus, CombatOutcome, format_combat_log,
)
from game_engine.treaties import (
    Treaty, TreatyType, TreatyStatus, TreatyViolation,
    check_nap_violation_extended, check_alliance_betrayal,
    check_demilitarization_zone_violation, check_mining_rights_violation,
    apply_violation_penalty, tick_treaty_enforcement,
)
from game_engine.reputation import (
    apply_reputation_change, tick_reputation_decay, get_reputation_level,
    can_form_treaty, can_form_alliance, can_share_tech, treaty_discount_modifier,
    MIN_REPUTATION, MAX_REPUTATION, ReputationChange,
)
from game_engine.models import (
    GameState, Ship, Faction, Body, OrbitElements, ShipClass, BodyType,
)
from game_engine.chronicle import Chronicle


class TestCombatResolution(unittest.TestCase):
    """Test combat system."""

    def setUp(self):
        """Set up test fixtures."""
        self.state = GameState(game_id="test_game", current_tick=0)

        # Create two factions
        self.faction_a = Faction(id="faction_a", name="Faction A", color="#FF0000")
        self.faction_b = Faction(id="faction_b", name="Faction B", color="#0000FF")
        self.state.factions = [self.faction_a, self.faction_b]

        # Create common orbit
        orbit = OrbitElements(
            rp=100.0,
            ra=100.0,
            omega=0.0,
            M0=0.0,
            epoch=0,
            direction=1,
            period=10.0,
            parent_body_id="inara",
        )

        # Create two ships
        self.attacker = Ship(
            id="ship_a",
            name="Attacker",
            class_type=ShipClass.CRUISER,
            owned_by="faction_a",
            fuel=100.0,
            orbit=orbit,
        )
        self.target = Ship(
            id="ship_b",
            name="Target",
            class_type=ShipClass.FRIGATE,
            owned_by="faction_b",
            fuel=100.0,
            orbit=orbit,
        )
        self.state.ships = [self.attacker, self.target]

    def test_engagement_range_by_class(self):
        """Test that engagement range varies by ship class."""
        frigate_range = get_engagement_range(ShipClass.FRIGATE, sensor_tech_level=1)
        cruiser_range = get_engagement_range(ShipClass.CRUISER, sensor_tech_level=1)
        capital_range = get_engagement_range(ShipClass.CAPITAL, sensor_tech_level=1)
        stealth_range = get_engagement_range(ShipClass.STEALTH_RUNNER, sensor_tech_level=1)

        # Capital > Cruiser > Frigate > Stealth
        self.assertGreater(capital_range, cruiser_range)
        self.assertGreater(cruiser_range, frigate_range)
        self.assertGreater(frigate_range, stealth_range)

    def test_engagement_range_with_tech(self):
        """Test that tech level increases engagement range."""
        range_level_1 = get_engagement_range(ShipClass.CRUISER, sensor_tech_level=1)
        range_level_5 = get_engagement_range(ShipClass.CRUISER, sensor_tech_level=5)

        self.assertGreater(range_level_5, range_level_1)
        # Each tech level adds 20%
        expected = range_level_1 * 1.8
        self.assertAlmostEqual(range_level_5, expected, places=1)

    def test_base_damage_by_class(self):
        """Test that base damage varies by ship class."""
        frigate_dmg = get_base_damage(ShipClass.FRIGATE, armor_level=0)
        cruiser_dmg = get_base_damage(ShipClass.CRUISER, armor_level=0)
        capital_dmg = get_base_damage(ShipClass.CAPITAL, armor_level=0)

        # Capital > Cruiser > Frigate
        self.assertGreater(capital_dmg, cruiser_dmg)
        self.assertGreater(cruiser_dmg, frigate_dmg)

    def test_relative_velocity_bonus(self):
        """Test that relative velocity affects damage."""
        # No relative velocity
        bonus_zero = calculate_relative_velocity_bonus(5000, 5000)
        self.assertAlmostEqual(bonus_zero, 1.0, places=2)

        # High relative velocity
        bonus_high = calculate_relative_velocity_bonus(15000, 5000)
        self.assertGreater(bonus_high, 1.5)

        # Max bonus capped at 2.0
        bonus_max = calculate_relative_velocity_bonus(20000, 0)
        self.assertLessEqual(bonus_max, 2.0)

    def test_can_engage_success(self):
        """Test successful engagement check."""
        # Both ships intact and within range
        result = check_can_engage(
            self.attacker,
            self.target,
            engagement_range_km=5000.0,
            max_engagement_range_km=10000.0,
        )
        self.assertTrue(result)

    def test_can_engage_out_of_range(self):
        """Test engagement fails when out of range."""
        result = check_can_engage(
            self.attacker,
            self.target,
            engagement_range_km=15000.0,
            max_engagement_range_km=10000.0,
        )
        self.assertFalse(result)

    def test_can_engage_same_faction(self):
        """Test engagement fails between same faction ships."""
        self.target.owned_by = self.attacker.owned_by

        result = check_can_engage(
            self.attacker,
            self.target,
            engagement_range_km=5000.0,
            max_engagement_range_km=10000.0,
        )
        self.assertFalse(result)

    def test_can_engage_target_destroyed(self):
        """Test engagement fails when target is destroyed."""
        self.target.hull_integrity = 0.0

        result = check_can_engage(
            self.attacker,
            self.target,
            engagement_range_km=5000.0,
            max_engagement_range_km=10000.0,
        )
        self.assertFalse(result)

    def test_combat_resolution_basic(self):
        """Test basic combat resolution."""
        resolution = resolve_combat(
            self.state,
            self.attacker,
            self.target,
            attacker_velocity_ms=5000.0,
            target_velocity_ms=5000.0,
            engagement_range_km=5000.0,
            current_tick=0,
            attacker_tech_level=1,
        )

        # Verify resolution structure
        self.assertEqual(resolution.attacker_id, self.attacker.id)
        self.assertEqual(resolution.target_id, self.target.id)
        self.assertGreater(resolution.actual_damage, 0)
        self.assertLess(resolution.target_hull_after, 1.0)

    def test_combat_damage_with_velocity_bonus(self):
        """Test that velocity bonus increases damage."""
        # Same velocity
        res_no_bonus = resolve_combat(
            self.state,
            self.attacker,
            self.target,
            attacker_velocity_ms=5000.0,
            target_velocity_ms=5000.0,
            engagement_range_km=5000.0,
            current_tick=0,
        )

        # Reset target hull
        self.target.hull_integrity = 1.0

        # High relative velocity
        res_with_bonus = resolve_combat(
            self.state,
            self.attacker,
            self.target,
            attacker_velocity_ms=10000.0,
            target_velocity_ms=2000.0,
            engagement_range_km=5000.0,
            current_tick=0,
        )

        # Higher velocity should cause more damage
        self.assertGreater(res_with_bonus.actual_damage, res_no_bonus.actual_damage)

    def test_combat_armor_reduction(self):
        """Test that armor reduces damage."""
        # No armor
        res_no_armor = resolve_combat(
            self.state,
            self.attacker,
            self.target,
            attacker_velocity_ms=5000.0,
            target_velocity_ms=5000.0,
            engagement_range_km=5000.0,
            current_tick=0,
        )

        # Reset
        self.target.hull_integrity = 1.0

        # Add armor
        self.target.armor_level = 3
        res_with_armor = resolve_combat(
            self.state,
            self.attacker,
            self.target,
            attacker_velocity_ms=5000.0,
            target_velocity_ms=5000.0,
            engagement_range_km=5000.0,
            current_tick=0,
        )

        # Armor should reduce damage
        self.assertLess(res_with_armor.actual_damage, res_no_armor.actual_damage)

    def test_combat_outcome_destroyed(self):
        """Test destruction outcome."""
        # Apply multiple hits to destroy
        self.target.hull_integrity = 0.05
        resolution = resolve_combat(
            self.state,
            self.attacker,
            self.target,
            attacker_velocity_ms=5000.0,
            target_velocity_ms=5000.0,
            engagement_range_km=5000.0,
            current_tick=0,
        )

        self.assertEqual(resolution.outcome, CombatOutcome.DESTROYED)
        self.assertEqual(self.target.hull_integrity, 0.0)

    def test_combat_format_log(self):
        """Test combat log formatting."""
        resolution = resolve_combat(
            self.state,
            self.attacker,
            self.target,
            attacker_velocity_ms=5000.0,
            target_velocity_ms=5000.0,
            engagement_range_km=5000.0,
            current_tick=0,
        )

        log = format_combat_log(resolution)
        self.assertIn("attacker_id", log)
        self.assertIn("target_id", log)
        self.assertIn("outcome", log)
        self.assertIn("actual_damage", log)


class TestTreatyViolations(unittest.TestCase):
    """Test treaty violation detection."""

    def setUp(self):
        """Set up test fixtures."""
        self.faction_a = Faction(id="faction_a", name="Faction A", color="#FF0000")
        self.faction_b = Faction(id="faction_b", name="Faction B", color="#0000FF")

    def test_nap_violation_detection(self):
        """Test NAP violation detection."""
        treaty = Treaty(
            id="nap_1",
            type=TreatyType.NON_AGGRESSION_PACT,
            signatories=["faction_a", "faction_b"],
            start_tick=0,
            expires_at_tick=100,
            status=TreatyStatus.ACTIVE,
        )

        # Check violation
        violated, code = check_nap_violation_extended(
            treaty,
            attacker_faction_id="faction_a",
            defender_faction_id="faction_b",
            current_tick=50,
        )

        self.assertTrue(violated)
        self.assertEqual(code, "direct_attack")

    def test_nap_violation_expired_treaty(self):
        """Test NAP doesn't trigger on expired treaty."""
        treaty = Treaty(
            id="nap_1",
            type=TreatyType.NON_AGGRESSION_PACT,
            signatories=["faction_a", "faction_b"],
            start_tick=0,
            expires_at_tick=50,
            status=TreatyStatus.ACTIVE,
        )

        # Check when expired
        violated, code = check_nap_violation_extended(
            treaty,
            attacker_faction_id="faction_a",
            defender_faction_id="faction_b",
            current_tick=100,
        )

        self.assertFalse(violated)

    def test_nap_violation_same_faction(self):
        """Test NAP doesn't trigger for same faction."""
        treaty = Treaty(
            id="nap_1",
            type=TreatyType.NON_AGGRESSION_PACT,
            signatories=["faction_a", "faction_b"],
            start_tick=0,
            expires_at_tick=100,
            status=TreatyStatus.ACTIVE,
        )

        # Check same faction
        violated, code = check_nap_violation_extended(
            treaty,
            attacker_faction_id="faction_a",
            defender_faction_id="faction_a",
            current_tick=50,
        )

        self.assertFalse(violated)

    def test_alliance_betrayal_detection(self):
        """Test military alliance betrayal detection."""
        treaty = Treaty(
            id="alliance_1",
            type=TreatyType.MILITARY_ALLIANCE,
            signatories=["faction_a", "faction_b"],
            start_tick=0,
            expires_at_tick=100,
            status=TreatyStatus.ACTIVE,
        )

        # Check betrayal
        betrayed, code = check_alliance_betrayal(
            treaty,
            ally_faction_id="faction_a",
            attacker_faction_id="faction_b",
            current_tick=50,
        )

        self.assertTrue(betrayed)
        self.assertEqual(code, "alliance_betrayal")

    def test_dmz_violation_detection(self):
        """Test demilitarization zone violation detection."""
        treaty = Treaty(
            id="dmz_1",
            type=TreatyType.DEMILITARIZATION_ZONE,
            signatories=["faction_a", "faction_b"],
            start_tick=0,
            expires_at_tick=100,
            status=TreatyStatus.ACTIVE,
            terms={"zone_body_id": "inara", "authorized_signatories": ["faction_a"]},
        )

        orbit = OrbitElements(
            rp=100.0, ra=100.0, omega=0.0, M0=0.0, epoch=0,
            direction=1, period=10.0, parent_body_id="inara"
        )
        ship = Ship(
            id="ship_1", name="Ship", class_type=ShipClass.FRIGATE,
            owned_by="faction_b", fuel=100.0, orbit=orbit
        )

        # Check DMZ violation
        violated, code = check_dmz_violation_detection(
            treaty, ship, "inara", current_tick=50
        )

        self.assertTrue(violated)
        self.assertEqual(code, "dmz_entry")

    def test_mining_rights_violation(self):
        """Test mining rights violation detection."""
        treaty = Treaty(
            id="mining_1",
            type=TreatyType.MINING_RIGHTS,
            signatories=["faction_a"],
            start_tick=0,
            expires_at_tick=100,
            status=TreatyStatus.ACTIVE,
            terms={"body_id": "inara", "authorized_factions": ["faction_a"]},
        )

        # Check violation
        violated, code = check_mining_rights_violation(
            treaty,
            mining_faction_id="faction_b",
            mined_body_id="inara",
        )

        self.assertTrue(violated)
        self.assertEqual(code, "unauthorized_mining")

    def test_violation_penalty_application(self):
        """Test reputation penalty for violations."""
        initial_rep = self.faction_a.reputation
        penalty = apply_violation_penalty(
            self.faction_a,
            violation_type="direct_attack",
            severity=1,
        )

        self.assertLess(self.faction_a.reputation, initial_rep)
        self.assertEqual(penalty, -20.0)

    def test_violation_penalty_with_severity(self):
        """Test penalty scaling with severity."""
        self.faction_a.reputation = 0
        self.faction_b.reputation = 0

        # Severity 1
        penalty_1 = apply_violation_penalty(
            self.faction_a,
            violation_type="direct_attack",
            severity=1,
        )

        self.faction_a.reputation = 0  # Reset
        self.faction_b.reputation = 0

        # Severity 3
        penalty_3 = apply_violation_penalty(
            self.faction_a,
            violation_type="direct_attack",
            severity=3,
        )

        # Higher severity = worse penalty
        self.assertLess(penalty_3, penalty_1)


class TestReputationSystem(unittest.TestCase):
    """Test reputation tracking and decay."""

    def setUp(self):
        """Set up test fixtures."""
        self.faction = Faction(id="faction_1", name="Test Faction", color="#FFFFFF")
        self.state = GameState(game_id="test_game", current_tick=0)
        self.state.factions = [self.faction]
        self.chronicle = Chronicle()

    def test_reputation_change_positive(self):
        """Test positive reputation change."""
        old_rep = self.faction.reputation
        apply_reputation_change(
            self.faction,
            change=10.0,
            reason=ReputationChange.FAIR_VICTORY,
            description="Won a fair fight",
        )

        self.assertGreater(self.faction.reputation, old_rep)

    def test_reputation_change_negative(self):
        """Test negative reputation change."""
        old_rep = self.faction.reputation
        apply_reputation_change(
            self.faction,
            change=-20.0,
            reason=ReputationChange.TREATY_VIOLATION,
            description="Broke treaty",
        )

        self.assertLess(self.faction.reputation, old_rep)

    def test_reputation_bounds(self):
        """Test reputation clamping to bounds."""
        apply_reputation_change(
            self.faction,
            change=200.0,
            reason=ReputationChange.FAIR_VICTORY,
            description="Test",
        )

        self.assertLessEqual(self.faction.reputation, MAX_REPUTATION)

        apply_reputation_change(
            self.faction,
            change=-300.0,
            reason=ReputationChange.TREATY_VIOLATION,
            description="Test",
        )

        self.assertGreaterEqual(self.faction.reputation, MIN_REPUTATION)

    def test_reputation_decay_negative(self):
        """Test negative reputation recovers toward 0."""
        self.faction.reputation = -50.0
        tick_reputation_decay(self.state, self.chronicle)

        self.assertGreater(self.faction.reputation, -50.0)
        self.assertLess(self.faction.reputation, 0)

    def test_reputation_decay_positive(self):
        """Test positive reputation slowly fades."""
        self.faction.reputation = 50.0
        old_rep = self.faction.reputation
        tick_reputation_decay(self.state, self.chronicle)

        self.assertLess(self.faction.reputation, old_rep)
        self.assertGreater(self.faction.reputation, 0)

    def test_reputation_level_thresholds(self):
        """Test reputation level descriptions."""
        test_cases = [
            (100, "Beloved Hero"),
            (50, "Respected Ally"),
            (20, "Known Friend"),
            (0, "Trusted"),
            (-20, "Neutral"),
            (-50, "Distrusted"),
            (-80, "Enemy"),
            (-100, "Pariah"),
        ]

        for rep_value, expected_level in test_cases:
            level = get_reputation_level(rep_value)
            self.assertEqual(level, expected_level)

    def test_can_form_treaty_sufficient_rep(self):
        """Test treaty formation with sufficient reputation."""
        faction1 = Faction(id="f1", name="F1", color="#FF0000", reputation=0)
        faction2 = Faction(id="f2", name="F2", color="#0000FF", reputation=0)

        result = can_form_treaty(faction1, faction2)
        self.assertTrue(result)

    def test_can_form_treaty_insufficient_rep(self):
        """Test treaty formation with insufficient reputation."""
        faction1 = Faction(id="f1", name="F1", color="#FF0000", reputation=-50)
        faction2 = Faction(id="f2", name="F2", color="#0000FF", reputation=-50)

        result = can_form_treaty(faction1, faction2)
        self.assertFalse(result)

    def test_can_form_alliance_requires_higher_rep(self):
        """Test alliance requires higher reputation than treaty."""
        faction1 = Faction(id="f1", name="F1", color="#FF0000", reputation=10)
        faction2 = Faction(id="f2", name="F2", color="#0000FF", reputation=10)

        # Can form treaty but not alliance
        self.assertTrue(can_form_treaty(faction1, faction2))
        self.assertFalse(can_form_alliance(faction1, faction2))

        # With higher reputation
        faction1.reputation = 25
        faction2.reputation = 25
        self.assertTrue(can_form_alliance(faction1, faction2))

    def test_trade_discount_modifier(self):
        """Test trade cost modifier based on reputation."""
        # Positive reputation = discount
        modifier_positive = treaty_discount_modifier(100)
        self.assertEqual(modifier_positive, 0.5)

        # Neutral reputation = full cost
        modifier_neutral = treaty_discount_modifier(0)
        self.assertEqual(modifier_neutral, 1.0)

        # Negative reputation = premium
        modifier_negative = treaty_discount_modifier(-100)
        self.assertEqual(modifier_negative, 1.5)


class TestChronicleLogging(unittest.TestCase):
    """Test chronicle event logging."""

    def setUp(self):
        """Set up test fixtures."""
        self.chronicle = Chronicle()

    def test_combat_logging(self):
        """Test combat event logging."""
        self.chronicle.log_combat(
            tick=5,
            attacker_id="ship_a",
            attacker_faction_id="faction_a",
            target_id="ship_b",
            target_faction_id="faction_b",
            outcome="destroyed",
            damage=50.0,
            target_hull_after=0.0,
        )

        entries = self.chronicle.all_extended_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].event_type, "combat")
        self.assertIn("destroyed", entries[0].headline)

    def test_treaty_event_logging(self):
        """Test treaty event logging."""
        self.chronicle.log_treaty_event(
            tick=10,
            event_subtype="signed",
            treaty_type="non_aggression_pact",
            factions=["faction_a", "faction_b"],
            description="NAP signed between factions",
        )

        entries = self.chronicle.all_extended_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].event_type, "treaty_signed")

    def test_generic_event_logging(self):
        """Test generic event logging."""
        self.chronicle.log_event(
            tick=15,
            event_type="custom_event",
            headline="Test Event",
            description="A test event",
            primary_faction_id="faction_a",
        )

        entries = self.chronicle.all_extended_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].event_type, "custom_event")
        self.assertEqual(entries[0].headline, "Test Event")


if __name__ == "__main__":
    unittest.main()
