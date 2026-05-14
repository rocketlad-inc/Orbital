"""
Reputation System
=================

Comprehensive faction reputation tracking with decay mechanics.

Reputation Effects:
- Treaty negotiation chances (higher = easier)
- Trade deal discounts (higher = cheaper)
- Allied faction support (higher = more willing)
- Voting weight in council (higher = more influence)
- Victory conditions (negative reputation = harder to win)

Reputation Mechanics:
====================

1. REPUTATION SCALE
   Range: -100 (pariah) to +100 (hero)

   Levels:
   - 80+: "Beloved Hero" (max alliance benefits)
   - 50-79: "Respected Ally" (strong benefits)
   - 20-49: "Known Friend" (moderate benefits)
   - 0-19: "Trusted" (minor benefits)
   - -20-(-1): "Neutral" (no benefits/penalties)
   - -50-(-21): "Distrusted" (penalties, harder deals)
   - -80-(-51): "Enemy" (severe penalties, limited diplomacy)
   - -100-(-81): "Pariah" (cannot form treaties, enemies everywhere)

2. REPUTATION SOURCES

   Penalties:
   - Treaty violation: -5 to -30 depending on type
   - Attacking non-aggressor: -15
   - Failed promise/cancellation: -10
   - Destruction of unprepared faction: -20
   - Alliance betrayal: -30

   Boosts:
   - Successful trade: +2
   - Keeping treaty term: +0.1/tick
   - Defending ally under attack: +5
   - Victory in fair fight: +5
   - Sharing resources: +3
   - Tech cooperation: +2

3. REPUTATION DECAY

   Negative reputation decays toward 0 slowly:
   - Range: -100 to -1
   - Decay rate: +0.5 per tick toward 0
   - Minimum decay: never heals below -50 without action

   Positive reputation decays toward 0:
   - Range: +1 to +100
   - Decay rate: -0.2 per tick (slower fade)
   - Decay pauses if alliance active (treaty boost)

   Effect: Encourages continuous good behavior, not one-time help

4. ATOMIC REPUTATION CHANGES
   - All changes logged to reputation_logs table
   - Each change references the causing event
   - Tick number recorded for temporal tracking
   - Cumulative display in UI

5. FACTIONAL REPUTATION
   - Reputation affects perception by other factions
   - Affects trade costs and alliance formation
   - Affects voting power in senate
   - Can be directional (A likes B, B dislikes A)
"""

from typing import Dict, Optional, Tuple
from enum import Enum
from dataclasses import dataclass, field

from .models import GameState, Faction
from .chronicle import Chronicle


# Reputation recovery/decay rates
NEGATIVE_REP_RECOVERY = 0.5  # Negative reputation decays toward 0
POSITIVE_REP_DECAY = 0.2     # Positive reputation slowly fades
TREATY_BONUS_MAGNITUDE = 0.1  # Keeps positive rep from decaying if treaty active

# Hard bounds
MIN_REPUTATION = -100.0
MAX_REPUTATION = 100.0

# Reputation threshold for various mechanics
MIN_REP_FOR_TREATY = -20.0
MIN_REP_FOR_ALLIANCE = 20.0
MIN_REP_FOR_TECH_SHARING = 10.0


class ReputationChange(str, Enum):
    """Reasons for reputation changes."""
    # Penalties
    TREATY_VIOLATION = "treaty_violation"
    UNPROVOKED_ATTACK = "unprovoked_attack"
    ALLIANCE_BETRAYAL = "alliance_betrayal"
    BROKEN_PROMISE = "broken_promise"
    DESTRUCTION_UNDEFENDING = "destruction_undefending"
    CAPTURED_UNARMED = "captured_unarmed"

    # Boosts
    SUCCESSFUL_TRADE = "successful_trade"
    TREATY_HONORED = "treaty_honored"
    DEFENDED_ALLY = "defended_ally"
    FAIR_VICTORY = "fair_victory"
    RESOURCE_GIFT = "resource_gift"
    TECH_COOPERATION = "tech_cooperation"

    # System
    DECAY_NEGATIVE = "decay_negative"
    DECAY_POSITIVE = "decay_positive"


@dataclass
class ReputationRecord:
    """Record of a reputation change."""
    tick: int
    faction_id: str
    other_faction_id: Optional[str]  # For factional reputation
    change_amount: float
    reason: ReputationChange
    description: str


def apply_reputation_change(
    faction: Faction,
    change: float,
    reason: ReputationChange,
    description: str,
    records: list = None,
) -> float:
    """
    Apply a reputation change to a faction.

    Args:
        faction: The faction
        change: Change amount (can be negative or positive)
        reason: Reason enum for change
        description: Human-readable description
        records: Optional list to append record to

    Returns:
        New reputation value
    """
    old_rep = faction.reputation
    faction.reputation = max(MIN_REPUTATION, min(MAX_REPUTATION, old_rep + change))

    if records is not None:
        records.append({
            "change": change,
            "reason": reason.value,
            "description": description,
            "before": old_rep,
            "after": faction.reputation,
        })

    return faction.reputation


def apply_reputation_penalty(
    faction: Faction,
    amount: float,
    reason: str,
) -> float:
    """
    Apply a reputation penalty to a faction.

    Legacy interface for compatibility.

    Args:
        faction: The faction
        amount: Penalty amount (should be negative)
        reason: Reason for penalty (for logging)

    Returns:
        New reputation value
    """
    faction.reputation = max(MIN_REPUTATION, faction.reputation + amount)
    return faction.reputation


def apply_reputation_boost(
    faction: Faction,
    amount: float,
    reason: str,
) -> float:
    """
    Apply a reputation boost to a faction.

    Legacy interface for compatibility.

    Args:
        faction: The faction
        amount: Boost amount (should be positive)
        reason: Reason for boost (for logging)

    Returns:
        New reputation value
    """
    faction.reputation = min(MAX_REPUTATION, faction.reputation + amount)
    return faction.reputation


def get_reputation_level(reputation: float) -> str:
    """
    Get human-readable reputation level.

    Args:
        reputation: Reputation value (-100 to +100)

    Returns:
        Description like "Ally", "Neutral", "Pariah"
    """
    if reputation >= 80:
        return "Beloved Hero"
    elif reputation >= 50:
        return "Respected Ally"
    elif reputation >= 20:
        return "Known Friend"
    elif reputation >= 0:
        return "Trusted"
    elif reputation >= -20:
        return "Neutral"
    elif reputation >= -50:
        return "Distrusted"
    elif reputation >= -80:
        return "Enemy"
    else:
        return "Pariah"


def get_reputation_color(reputation: float) -> str:
    """
    Get color code for reputation display.

    Args:
        reputation: Reputation value

    Returns:
        Hex color code
    """
    if reputation >= 80:
        return "#00FF00"  # Green
    elif reputation >= 20:
        return "#88FF00"  # Yellow-green
    elif reputation >= -20:
        return "#FFFFFF"  # White (neutral)
    elif reputation >= -80:
        return "#FF8800"  # Orange-red
    else:
        return "#FF0000"  # Red


def can_form_treaty(faction1: Faction, faction2: Faction) -> bool:
    """
    Check if two factions can form a treaty.

    Requires minimum mutual reputation.

    Args:
        faction1: First faction
        faction2: Second faction

    Returns:
        True if treaty formation is possible
    """
    # Need at least "Neutral" reputation to form treaties
    return faction1.reputation >= MIN_REP_FOR_TREATY and faction2.reputation >= MIN_REP_FOR_TREATY


def can_form_alliance(faction1: Faction, faction2: Faction) -> bool:
    """
    Check if two factions can form a military alliance.

    Requires higher minimum reputation than basic treaties.

    Args:
        faction1: First faction
        faction2: Second faction

    Returns:
        True if alliance formation is possible
    """
    return faction1.reputation >= MIN_REP_FOR_ALLIANCE and faction2.reputation >= MIN_REP_FOR_ALLIANCE


def can_share_tech(faction1: Faction, faction2: Faction) -> bool:
    """
    Check if two factions can share technology.

    Args:
        faction1: First faction
        faction2: Second faction

    Returns:
        True if tech sharing is possible
    """
    return faction1.reputation >= MIN_REP_FOR_TECH_SHARING and faction2.reputation >= MIN_REP_FOR_TECH_SHARING


def treaty_discount_modifier(reputation: float) -> float:
    """
    Get trade discount modifier based on reputation.

    Better reputation = better discounts on trade deals.

    Args:
        reputation: Reputation value

    Returns:
        Modifier (0.5 = 50% cost, 1.0 = full cost, 1.5 = 150% cost)
    """
    # Linear scale
    # At +100 rep: 50% cost (0.5 modifier)
    # At 0 rep: 100% cost (1.0 modifier)
    # At -100 rep: 150% cost (1.5 modifier)

    return 1.0 - (reputation / 200.0)


def tick_reputation_decay(
    state: GameState,
    chronicle: Chronicle,
) -> None:
    """
    Apply reputation decay/recovery for this tick.

    Rules:
    - Negative reputation slowly recovers toward 0 (decay prevention)
    - Positive reputation slowly fades (encourage continuous good behavior)
    - Active treaties slow positive decay
    - Major events can override decay

    Args:
        state: Game state (modified in-place)
        chronicle: Chronicle to log events
    """
    for faction in state.factions:
        old_rep = faction.reputation
        new_rep = old_rep

        if old_rep < 0:
            # Negative reputation recovers slowly
            new_rep = old_rep + NEGATIVE_REP_RECOVERY
            if new_rep > 0:
                new_rep = 0

        elif old_rep > 0:
            # Positive reputation decays slowly
            new_rep = old_rep - POSITIVE_REP_DECAY
            if new_rep < 0:
                new_rep = 0

        # Clamp to bounds
        new_rep = max(MIN_REPUTATION, min(MAX_REPUTATION, new_rep))

        # Only log if change occurred
        if new_rep != old_rep:
            faction.reputation = new_rep

            if new_rep > old_rep:
                reason = ReputationChange.DECAY_NEGATIVE
                description = f"Negative reputation recovery: {old_rep:.1f} → {new_rep:.1f}"
            else:
                reason = ReputationChange.DECAY_POSITIVE
                description = f"Positive reputation decay: {old_rep:.1f} → {new_rep:.1f}"

            chronicle.log_event(
                tick=state.current_tick,
                event_type="reputation_change",
                headline=f"{faction.name} reputation changed",
                description=description,
                primary_faction_id=faction.id,
                event_data={
                    "old_reputation": old_rep,
                    "new_reputation": new_rep,
                    "reason": reason.value,
                },
            )


def tick_reputation_update(
    state: GameState,
    chronicle: Chronicle,
) -> None:
    """
    Legacy wrapper for decay function.

    Args:
        state: Game state (modified in-place)
        chronicle: Chronicle to log events
    """
    tick_reputation_decay(state, chronicle)
