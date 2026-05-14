"""
Chronicle System
================

Comprehensive event logging for the game. Chronicle entries are immutable historical records
of everything that happens in the game.

Each tick generates zero or more chronicle entries describing what happened.
These form the game's historical narrative and are the primary way players see game state changes.

Chronicle Event Types:
- Combat: Battles, ship destruction, damage
- Diplomacy: Treaty signed/broken, reputation changes
- Production: Resource generation, facility completion
- Exploration: Body discovery, SOI transitions
- Technology: Research completion, tech upgrades
- Politics: Senate votes, proposals
- Military: Maneuvers executed, fleet movements
- Miscellaneous: Custom events, system messages

All events are immutable once created and include:
- Unique ID for deduplication
- Tick number for temporal ordering
- Event type for filtering/categorization
- Primary and secondary faction IDs for diplomacy events
- Optional body/ship IDs for spatial context
- Human-readable headline and description
- Machine-readable event data for UI processing
"""

import uuid
from typing import List, Optional, Dict, Any
from dataclasses import dataclass
from .models import ChronicleEntry


@dataclass
class ChronicleEvent:
    """Extended chronicle event with full data."""
    id: str
    tick: int
    event_type: str
    headline: str
    description: Optional[str]
    primary_faction_id: Optional[str]
    secondary_faction_id: Optional[str]
    body_id: Optional[str]
    ship_id: Optional[str]
    event_data: Dict[str, Any] = None


class Chronicle:
    """Manages game event logging for a tick."""

    def __init__(self):
        """Initialize a new chronicle for a tick."""
        self.entries: List[ChronicleEntry] = []
        self.extended_entries: List[ChronicleEvent] = []

    def log_production(
        self,
        tick: int,
        faction_id: str,
        body_id: str,
        resources: dict,
    ) -> ChronicleEntry:
        """
        Log resource production from a body.

        Args:
            tick: Current game tick
            faction_id: Faction that owns the body
            body_id: ID of the body producing resources
            resources: Dictionary of {resource_type: amount}
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type="production",
            faction_id=faction_id,
            body_id=body_id,
            ship_id=None,
            title="Resource Production",
            description=self._format_resources(resources),
        )
        self.entries.append(entry)
        return entry

    def log_maneuver_executed(
        self,
        tick: int,
        faction_id: str,
        ship_id: str,
        maneuver_id: str,
        deltav: float,
        fuel_consumed: float,
    ) -> ChronicleEntry:
        """
        Log the execution of a maneuver.

        Args:
            tick: Current game tick
            faction_id: Faction that owns the ship
            ship_id: ID of the ship
            maneuver_id: ID of the maneuver node
            deltav: Delta-v applied in km/s
            fuel_consumed: Fuel consumed by the maneuver
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type="maneuver_executed",
            faction_id=faction_id,
            body_id=None,
            ship_id=ship_id,
            title="Maneuver Executed",
            description=(
                f"Applied {deltav:.1f} km/s delta-v, consumed {fuel_consumed:.1f} fuel. "
                f"Maneuver ID: {maneuver_id}"
            ),
        )
        self.entries.append(entry)
        return entry

    def log_body_claimed(
        self,
        tick: int,
        faction_id: str,
        body_id: str,
        body_name: str,
    ) -> ChronicleEntry:
        """
        Log the claiming of an unclaimed body.

        Args:
            tick: Current game tick
            faction_id: Faction claiming the body
            body_id: ID of the body
            body_name: Name of the body for the title
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type="body_claimed",
            faction_id=faction_id,
            body_id=body_id,
            ship_id=None,
            title=f"Claimed {body_name}",
            description=f"Faction has established control over {body_name}.",
        )
        self.entries.append(entry)
        return entry

    def log_body_captured(
        self,
        tick: int,
        attacker_id: str,
        defender_id: str,
        body_id: str,
        body_name: str,
    ) -> ChronicleEntry:
        """
        Log the capture of a body from another faction.

        Args:
            tick: Current game tick
            attacker_id: Faction attacking
            defender_id: Faction defending
            body_id: ID of the body
            body_name: Name of the body
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type="body_captured",
            faction_id=attacker_id,
            body_id=body_id,
            ship_id=None,
            title=f"Captured {body_name}",
            description=f"Faction defeated {defender_id} and captured {body_name}.",
        )
        self.entries.append(entry)
        return entry

    def log_tech_researched(
        self,
        tick: int,
        faction_id: str,
        tech_name: str,
        tech_level: int,
    ) -> ChronicleEntry:
        """
        Log completion of technology research.

        Args:
            tick: Current game tick
            faction_id: Faction completing research
            tech_name: Name of the technology
            tech_level: Tier reached
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type="tech_researched",
            faction_id=faction_id,
            body_id=None,
            ship_id=None,
            title=f"Technology: {tech_name}",
            description=f"Reached tech level {tech_level}. {tech_name} capabilities unlocked.",
        )
        self.entries.append(entry)
        return entry

    def log_treaty_violated(
        self,
        tick: int,
        violator_id: str,
        treaty_name: str,
        body_id: Optional[str],
    ) -> ChronicleEntry:
        """
        Log a treaty violation.

        Args:
            tick: Current game tick
            violator_id: Faction violating the treaty
            treaty_name: Name/ID of the treaty
            body_id: Body involved in violation, if any
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type="treaty_violated",
            faction_id=violator_id,
            body_id=body_id,
            ship_id=None,
            title="Treaty Violation",
            description=f"Broke {treaty_name}. Reputation penalty applied.",
        )
        self.entries.append(entry)
        return entry

    def log_standing_order_executed(
        self,
        tick: int,
        faction_id: str,
        order_id: str,
        description: str,
    ) -> ChronicleEntry:
        """
        Log execution of a standing order.

        Args:
            tick: Current game tick
            faction_id: Faction executing the order
            order_id: ID of the standing order
            description: Human-readable description of what was executed
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type="standing_order_executed",
            faction_id=faction_id,
            body_id=None,
            ship_id=None,
            title="Standing Order Executed",
            description=description,
        )
        self.entries.append(entry)
        return entry

    def log_error(
        self,
        tick: int,
        faction_id: Optional[str],
        error_type: str,
        description: str,
    ) -> ChronicleEntry:
        """
        Log an error or exception that occurred during the tick.

        Args:
            tick: Current game tick
            faction_id: Faction affected, if any
            error_type: Type of error
            description: Error description
        """
        entry = ChronicleEntry(
            id=str(uuid.uuid4()),
            tick=tick,
            event_type=f"error_{error_type}",
            faction_id=faction_id,
            body_id=None,
            ship_id=None,
            title="Error Occurred",
            description=description,
        )
        self.entries.append(entry)
        return entry

    @staticmethod
    def _format_resources(resources: dict) -> str:
        """Format a resource dictionary as a readable string."""
        parts = []
        for resource_type in ['metal', 'fuel', 'gold', 'science']:
            if resource_type in resources and resources[resource_type] > 0:
                parts.append(f"{resources[resource_type]} {resource_type.title()}")
        if not parts:
            return "No resources produced"
        return "Produced: " + ", ".join(parts)

    def log_event(
        self,
        tick: int,
        event_type: str,
        headline: str,
        description: Optional[str] = None,
        primary_faction_id: Optional[str] = None,
        secondary_faction_id: Optional[str] = None,
        body_id: Optional[str] = None,
        ship_id: Optional[str] = None,
        event_data: Optional[Dict[str, Any]] = None,
    ) -> ChronicleEvent:
        """
        Log a generic game event.

        Args:
            tick: Current game tick
            event_type: Type of event (for filtering/categorization)
            headline: Short title for the event
            description: Longer description of the event
            primary_faction_id: Main faction involved
            secondary_faction_id: Secondary faction (diplomacy, combat)
            body_id: Body involved, if any
            ship_id: Ship involved, if any
            event_data: Machine-readable data for UI processing

        Returns:
            ChronicleEvent
        """
        event_id = str(uuid.uuid4())

        # Create extended entry with full data
        extended = ChronicleEvent(
            id=event_id,
            tick=tick,
            event_type=event_type,
            headline=headline,
            description=description,
            primary_faction_id=primary_faction_id,
            secondary_faction_id=secondary_faction_id,
            body_id=body_id,
            ship_id=ship_id,
            event_data=event_data or {},
        )
        self.extended_entries.append(extended)

        # Also create legacy entry for compatibility
        entry = ChronicleEntry(
            id=event_id,
            tick=tick,
            event_type=event_type,
            faction_id=primary_faction_id,
            body_id=body_id,
            ship_id=ship_id,
            title=headline,
            description=description or "",
        )
        self.entries.append(entry)

        return extended

    def log_combat(
        self,
        tick: int,
        attacker_id: str,
        attacker_faction_id: str,
        target_id: str,
        target_faction_id: str,
        outcome: str,
        damage: float,
        target_hull_after: float,
    ) -> ChronicleEvent:
        """
        Log a combat engagement.

        Args:
            tick: Current game tick
            attacker_id: ID of attacking ship
            attacker_faction_id: Faction of attacker
            target_id: ID of target ship
            target_faction_id: Faction of target
            outcome: Combat outcome (destroyed, damaged, lightly_damaged, intact)
            damage: Damage dealt (normalized 0-1)
            target_hull_after: Target hull integrity after combat

        Returns:
            ChronicleEvent
        """
        outcome_map = {
            "destroyed": "Ship destroyed",
            "heavily_damaged": "Ship heavily damaged",
            "damaged": "Ship damaged",
            "lightly_damaged": "Ship lightly damaged",
            "intact": "Ship remained intact",
        }

        headline = f"Combat: {outcome_map.get(outcome, outcome)}"
        description = (
            f"Ship {attacker_id} from {attacker_faction_id} attacked ship {target_id}. "
            f"Dealt {damage:.1f} damage. Target hull: {target_hull_after:.1%}"
        )

        return self.log_event(
            tick=tick,
            event_type="combat",
            headline=headline,
            description=description,
            primary_faction_id=attacker_faction_id,
            secondary_faction_id=target_faction_id,
            ship_id=attacker_id,
            event_data={
                "attacker_id": attacker_id,
                "target_id": target_id,
                "outcome": outcome,
                "damage_dealt": damage,
                "target_hull_after": target_hull_after,
            },
        )

    def log_treaty_event(
        self,
        tick: int,
        event_subtype: str,
        treaty_type: str,
        factions: List[str],
        description: str,
    ) -> ChronicleEvent:
        """
        Log a treaty-related event (signed, broken, expired).

        Args:
            tick: Current game tick
            event_subtype: 'signed', 'broken', 'expired'
            treaty_type: Type of treaty
            factions: List of involved factions
            description: Event description

        Returns:
            ChronicleEvent
        """
        subtype_map = {
            "signed": "Treaty Signed",
            "broken": "Treaty Broken",
            "expired": "Treaty Expired",
        }

        headline = f"{subtype_map.get(event_subtype, event_subtype)}: {treaty_type}"

        return self.log_event(
            tick=tick,
            event_type=f"treaty_{event_subtype}",
            headline=headline,
            description=description,
            primary_faction_id=factions[0] if factions else None,
            secondary_faction_id=factions[1] if len(factions) > 1 else None,
            event_data={
                "treaty_type": treaty_type,
                "signatories": factions,
            },
        )

    def all_entries(self) -> List[ChronicleEntry]:
        """Get all chronicle entries from this tick."""
        return self.entries.copy()

    def all_extended_entries(self) -> List[ChronicleEvent]:
        """Get all extended chronicle entries from this tick."""
        return self.extended_entries.copy()
