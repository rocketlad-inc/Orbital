"""
Treaty System
=============

Manages diplomatic agreements and their enforcement.

Treaties include:
- Non-Aggression Pacts (NAP): Can't attack bodies/ships during term
- Trade Agreements: Reduced costs for resource transfers
- Military Alliances: Can use ally's bodies as resupply, combined defense
- Research Cooperation: Shared tech advancement, cost reduction
- Demilitarization Zones: Cannot move military ships into zone
- Technology Sharing: Automatic tech level syncing
- Mining Rights: Exclusive mining access to body

Each treaty has:
- Signatories (factions)
- Start and expiration ticks
- Terms (which violations are checked)
- Status (active, broken, expired, proposed, cancelled)

Violation Detection:
====================

1. NON-AGGRESSION PACT
   - Detects: Direct attack on signatory's ships or owned bodies
   - Penalty: -20 reputation, allows counter-attack without penalty

2. TRADE AGREEMENT
   - Detects: Blocking trade routes, preventing transfer
   - Penalty: -10 reputation, automatic contract cancellation

3. MILITARY ALLIANCE
   - Detects: Not defending ally under attack, attacking ally
   - Penalty: -30 reputation, ally gains +20 reputation
   - Effect: Loss of alliance benefits (shared defense, resupply)

4. RESEARCH COOPERATION
   - Detects: Refusing to share completed research
   - Penalty: -5 reputation, tech sync disabled

5. DEMILITARIZATION ZONE
   - Detects: Moving military ships into designated zone
   - Penalty: -15 reputation per tick in violation

6. TECHNOLOGY SHARING
   - Detects: Hiding tech level or refusing updates
   - Penalty: -5 reputation, sharing suspended

7. MINING RIGHTS
   - Detects: Mining from protected body as non-signatory
   - Penalty: -10 reputation, mining halted

Atomic Treaty Enforcement:
- All violation checks happen in one pass
- Penalties applied atomically
- Chronicle logged for player visibility
"""

from typing import Optional, Tuple, List, Dict, Any
from dataclasses import dataclass, field
from enum import Enum

from .models import GameState, Faction, Ship, Body
from .chronicle import Chronicle


class TreatyType(str, Enum):
    """Types of treaties."""
    NON_AGGRESSION_PACT = "non_aggression_pact"
    TRADE_AGREEMENT = "trade_agreement"
    MILITARY_ALLIANCE = "military_alliance"
    RESEARCH_COOPERATION = "research_cooperation"
    DEMILITARIZATION_ZONE = "demilitarization_zone"
    TECHNOLOGY_SHARING = "technology_sharing"
    MINING_RIGHTS = "mining_rights"


class TreatyStatus(str, Enum):
    """Status of a treaty."""
    PROPOSED = "proposed"
    ACTIVE = "active"
    BROKEN = "broken"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


@dataclass
class TreatyViolation:
    """A violation of a treaty term."""
    treaty_id: str
    treaty_type: TreatyType
    violator_faction_id: str
    violated_by_faction_id: Optional[str]  # For bilateral treaties
    violation_type: str  # Specific violation code
    severity: int  # 1 (minor) to 5 (severe)
    description: str
    tick: int


@dataclass
class Treaty:
    """
    A diplomatic agreement between factions.
    """
    id: str
    type: TreatyType
    signatories: List[str]  # List of faction IDs
    start_tick: int
    expires_at_tick: Optional[int]  # None = indefinite
    status: TreatyStatus = TreatyStatus.ACTIVE
    terms: Dict[str, Any] = field(default_factory=dict)  # Type-specific terms
    broken_at_tick: Optional[int] = None
    broken_by_faction_id: Optional[str] = None
    violations: List[TreatyViolation] = field(default_factory=list)


def check_treaty_expiration(
    treaty: Treaty,
    current_tick: int,
) -> bool:
    """
    Check if a treaty has expired.

    Args:
        treaty: The treaty to check
        current_tick: Current game tick

    Returns:
        True if treaty has expired
    """
    if treaty.status == TreatyStatus.EXPIRED:
        return True

    if current_tick >= treaty.expires_at_tick:
        treaty.status = TreatyStatus.EXPIRED
        return True

    return False


def check_nap_violation(
    treaty: Treaty,
    attacker_faction_id: str,
    defender_faction_id: str,
) -> bool:
    """
    Check if a NAP violation has occurred.

    A NAP violation is when a signatory attacks a body owned by
    another signatory during the treaty term.

    Args:
        treaty: The NAP treaty
        attacker_faction_id: Faction attacking
        defender_faction_id: Faction defending

    Returns:
        True if violation occurred
    """
    if treaty.type != TreatyType.NON_AGGRESSION_PACT:
        return False

    if treaty.status != TreatyStatus.ACTIVE:
        return False

    # Both must be signatories
    if attacker_faction_id not in treaty.signatories:
        return False

    if defender_faction_id not in treaty.signatories:
        return False

    # Different factions
    if attacker_faction_id == defender_faction_id:
        return False

    # Violation!
    return True


def apply_violation_penalty(
    faction: Faction,
    violation_type: str,
) -> float:
    """
    Apply reputation penalty for a violation.

    Args:
        faction: Faction that violated
        violation_type: Type of violation (e.g., 'treaty_nap')

    Returns:
        Reputation penalty amount
    """
    penalties = {
        "treaty_nap": -20.0,
        "treaty_trade": -10.0,
        "treaty_alliance": -30.0,
        "treaty_research": -5.0,
    }

    penalty = penalties.get(violation_type, -10.0)
    faction.reputation = max(-100, faction.reputation + penalty)

    return penalty


def check_nap_violation_extended(
    treaty: Treaty,
    attacker_faction_id: str,
    defender_faction_id: str,
    current_tick: int,
) -> Tuple[bool, Optional[str]]:
    """
    Check if a NAP violation has occurred (extended).

    A NAP violation is when a signatory attacks a body, ship, or facility
    owned by another signatory during the treaty term.

    Args:
        treaty: The NAP treaty
        attacker_faction_id: Faction attacking
        defender_faction_id: Faction defending
        current_tick: Current game tick

    Returns:
        Tuple of (violation_occurred, violation_code)
    """
    if treaty.type != TreatyType.NON_AGGRESSION_PACT:
        return False, None

    # Check if expired
    if treaty.status != TreatyStatus.ACTIVE:
        return False, None

    if treaty.expires_at_tick and current_tick >= treaty.expires_at_tick:
        return False, None

    # Both must be signatories
    if attacker_faction_id not in treaty.signatories:
        return False, None

    if defender_faction_id not in treaty.signatories:
        return False, None

    # Different factions
    if attacker_faction_id == defender_faction_id:
        return False, None

    # Violation!
    return True, "direct_attack"


def check_alliance_betrayal(
    treaty: Treaty,
    ally_faction_id: str,
    attacker_faction_id: str,
    current_tick: int,
) -> Tuple[bool, Optional[str]]:
    """
    Check if a military alliance has been betrayed.

    Betrayal occurs when:
    1. An ally doesn't defend another ally under attack
    2. An ally attacks another ally

    Args:
        treaty: The military alliance treaty
        ally_faction_id: Faction that should defend
        attacker_faction_id: Faction attacking the ally
        current_tick: Current game tick

    Returns:
        Tuple of (betrayal_occurred, betrayal_code)
    """
    if treaty.type != TreatyType.MILITARY_ALLIANCE:
        return False, None

    if treaty.status != TreatyStatus.ACTIVE:
        return False, None

    if treaty.expires_at_tick and current_tick >= treaty.expires_at_tick:
        return False, None

    # Check if both are signatories
    if ally_faction_id not in treaty.signatories:
        return False, None

    if attacker_faction_id not in treaty.signatories:
        return False, None

    # Can't betray yourself
    if ally_faction_id == attacker_faction_id:
        return False, None

    # Betrayal!
    return True, "alliance_betrayal"


def check_demilitarization_zone_violation(
    treaty: Treaty,
    ship: Ship,
    ship_location_body_id: str,
    current_tick: int,
) -> Tuple[bool, Optional[str]]:
    """
    Check if a ship has entered a demilitarized zone.

    Args:
        treaty: The demilitarization zone treaty
        ship: Ship to check
        ship_location_body_id: Body the ship is currently at
        current_tick: Current game tick

    Returns:
        Tuple of (violation_occurred, violation_code)
    """
    if treaty.type != TreatyType.DEMILITARIZATION_ZONE:
        return False, None

    if treaty.status != TreatyStatus.ACTIVE:
        return False, None

    if treaty.expires_at_tick and current_tick >= treaty.expires_at_tick:
        return False, None

    # Get the zone body ID from treaty terms
    zone_body_id = treaty.terms.get("zone_body_id")
    if not zone_body_id:
        return False, None

    # Check if ship is in the zone
    if ship_location_body_id != zone_body_id:
        return False, None

    # Check if ship owner is a non-military signatory
    # Military ships are only prohibited for non-core signatories
    authorized_signatories = treaty.terms.get("authorized_signatories", [])
    if ship.owned_by in authorized_signatories:
        return False, None

    # Violation!
    return True, "dmz_entry"


def check_mining_rights_violation(
    treaty: Treaty,
    mining_faction_id: str,
    mined_body_id: str,
) -> Tuple[bool, Optional[str]]:
    """
    Check if mining rights have been violated.

    Args:
        treaty: The mining rights treaty
        mining_faction_id: Faction attempting to mine
        mined_body_id: Body being mined

    Returns:
        Tuple of (violation_occurred, violation_code)
    """
    if treaty.type != TreatyType.MINING_RIGHTS:
        return False, None

    if treaty.status != TreatyStatus.ACTIVE:
        return False, None

    # Get protected body from treaty terms
    protected_body_id = treaty.terms.get("body_id")
    if mined_body_id != protected_body_id:
        return False, None

    # Check if miner is authorized
    authorized_miners = treaty.terms.get("authorized_factions", [])
    if mining_faction_id in authorized_miners:
        return False, None

    # Violation!
    return True, "unauthorized_mining"


def apply_violation_penalty(
    faction: Faction,
    violation_type: str,
    severity: int = 1,
) -> float:
    """
    Apply reputation penalty for a violation.

    Args:
        faction: Faction that violated
        violation_type: Type of violation
        severity: Severity multiplier (1-5)

    Returns:
        Reputation penalty amount (negative)
    """
    penalties = {
        "direct_attack": -20.0,
        "alliance_betrayal": -30.0,
        "dmz_entry": -15.0,
        "unauthorized_mining": -10.0,
        "trade_block": -10.0,
        "tech_refusal": -5.0,
    }

    base_penalty = penalties.get(violation_type, -10.0)
    total_penalty = base_penalty * severity

    faction.reputation = max(-100, faction.reputation + total_penalty)

    return total_penalty


def tick_treaty_enforcement(
    state: GameState,
    chronicle: Chronicle,
    treaties: List[Treaty],
) -> int:
    """
    Check all active treaties for violations and apply penalties.

    Iterates through:
    1. All active treaties
    2. All game actions this tick (combat, mining, movement)
    3. Checks for violations
    4. Applies reputation penalties
    5. Logs to chronicle

    Args:
        state: Game state (modified in-place)
        chronicle: Chronicle to log events
        treaties: List of treaties to check

    Returns:
        Number of violations detected and enforced
    """
    violations_detected = 0

    for treaty in treaties:
        # Check expiration
        if treaty.expires_at_tick and state.current_tick >= treaty.expires_at_tick:
            treaty.status = TreatyStatus.EXPIRED
            chronicle.log_event(
                tick=state.current_tick,
                event_type="treaty_expired",
                headline=f"Treaty expired: {treaty.type.value}",
                description=f"Between {', '.join(treaty.signatories)}",
                primary_faction_id=treaty.signatories[0] if treaty.signatories else None,
                event_data={"treaty_id": treaty.id},
            )
            continue

        if treaty.status != TreatyStatus.ACTIVE:
            continue

        # === CHECK NON-AGGRESSION PACTS ===
        if treaty.type == TreatyType.NON_AGGRESSION_PACT:
            # Check for attacks between signatories
            for attacker in state.ships:
                if attacker.owned_by not in treaty.signatories:
                    continue

                for target in state.ships:
                    if target.owned_by not in treaty.signatories:
                        continue
                    if attacker.owned_by == target.owned_by:
                        continue

                    # Check if combat occurred (would need combat log from tick)
                    # For now, stub this check
                    # if combat_log.has_attacker_vs_target(attacker.id, target.id):
                    #     violations_detected += 1
                    #     apply_violation_penalty(...)

        # === CHECK MILITARY ALLIANCES ===
        elif treaty.type == TreatyType.MILITARY_ALLIANCE:
            # Check for betrayals (attacking another signatory)
            for ship in state.ships:
                if ship.owned_by not in treaty.signatories:
                    continue

                # Would check combat log for attacks on other signatories
                # If ally was under attack and this faction didn't defend:
                #     violations_detected += 1

        # === CHECK DEMILITARIZATION ZONES ===
        elif treaty.type == TreatyType.DEMILITARIZATION_ZONE:
            zone_body_id = treaty.terms.get("zone_body_id")
            if zone_body_id:
                for ship in state.ships:
                    if ship.owned_by in treaty.terms.get("authorized_signatories", []):
                        continue

                    # Check if ship is at zone location
                    # Would need to track ship location in orbit
                    # if ship.current_location == zone_body_id:
                    #     violations_detected += 1
                    #     apply_violation_penalty(...)

    return violations_detected


def get_factional_reputation_bonus(
    faction: Faction,
    other_faction_id: str,
) -> float:
    """
    Get any reputation-based interaction bonus with another faction.

    Used for cost modifiers, success chance, etc.

    Args:
        faction: The faction checking reputation
        other_faction_id: The other faction to check against

    Returns:
        Bonus modifier (-1.0 to +1.0)
    """
    # Simple model: reputation / 100
    return max(-1.0, min(1.0, faction.reputation / 100.0))
