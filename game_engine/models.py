"""
Game State Data Models
======================

Core data structures for the game engine. These closely mirror the frontend types
but are optimized for server-side operations and database persistence.
"""

from typing import Optional, List, Dict, Any, Literal
from dataclasses import dataclass, field, asdict
from enum import Enum


class BodyType(str, Enum):
    """Types of celestial bodies."""
    STAR = "star"
    TERRESTRIAL = "terrestrial"
    GAS_GIANT = "gas_giant"
    MOON = "moon"
    ASTEROID = "asteroid"
    LAGRANGE_STATION = "lagrange_station"


class ShipClass(str, Enum):
    """Ship classifications."""
    FRIGATE = "frigate"
    CRUISER = "cruiser"
    CAPITAL = "capital"
    STEALTH_RUNNER = "stealth_runner"


class ManeuverType(str, Enum):
    """Types of maneuvers."""
    TRANSFER = "transfer"
    ORBITAL_CHANGE = "orbital_change"
    MANUAL_BURN = "manual_burn"


class ManeuverStatus(str, Enum):
    """Status of a maneuver node."""
    PLANNED = "planned"
    COMMITTED = "committed"
    EXECUTED = "executed"


@dataclass
class OrbitElements:
    """
    Orbital elements describing an elliptical orbit.

    Uses Kepler elements: semi-major axis (a), eccentricity (e), etc.
    All distances in game units, all angles in radians, all times in ticks.
    """
    rp: float                   # periapsis radius (closest approach)
    ra: float                   # apoapsis radius (farthest point)
    omega: float                # argument of periapsis (angle to Pe in orbital plane)
    M0: float                   # mean anomaly at epoch (stored as true anomaly)
    epoch: int                  # tick number when this orbit was computed
    direction: int              # +1 for prograde, -1 for retrograde
    period: float               # orbital period in ticks
    parent_body_id: str         # ID of the body this orbit is around

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OrbitElements":
        """Create from dictionary."""
        return cls(**data)


@dataclass
class ManeuverNode:
    """
    A planned burn at a specific time.

    Maneuvers progress through states:
    - planned: queued but not committed
    - committed: ready to execute
    - executed: has been performed
    """
    id: str
    ship_id: str
    type: ManeuverType
    burn_time: int              # tick when burn occurs
    deltav: float               # delta-v in km/s equivalent
    prograde: float             # prograde component of burn
    radial: float               # radial component of burn
    normal: float               # normal component of burn
    status: ManeuverStatus = ManeuverStatus.PLANNED

    # Predicted outcome
    pre_orbit: Optional[OrbitElements] = None
    post_orbit: Optional[OrbitElements] = None
    captured_at_body: Optional[str] = None
    escapes_body: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        data = asdict(self)
        data['type'] = self.type.value
        data['status'] = self.status.value
        if self.pre_orbit:
            data['pre_orbit'] = self.pre_orbit.to_dict()
        if self.post_orbit:
            data['post_orbit'] = self.post_orbit.to_dict()
        return data


@dataclass
class Body:
    """A celestial body: planet, star, moon, asteroid, or Lagrange station."""
    id: str
    name: str
    type: BodyType
    radius: float               # visible radius in game units
    soi: float                  # sphere of influence radius
    color: str                  # hex color for rendering

    # Orbital parameters (null for stars)
    parent: Optional[str] = None
    orbit_radius: float = 0.0   # semi-major axis of orbit around parent
    orbit_period: float = 0.0   # orbital period in ticks
    angle0: float = 0.0         # initial angle (radians) on orbit

    # Resources
    resources: Dict[str, int] = field(default_factory=lambda: {
        "metal": 0,
        "fuel": 0,
        "gold": 0,
        "science": 0,
    })

    # Ownership
    owned_by: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        data = asdict(self)
        data['type'] = self.type.value
        return data


@dataclass
class Ship:
    """A starship under player or faction control."""
    id: str
    name: str
    class_type: ShipClass
    owned_by: str               # faction id
    fuel: float                 # remaining fuel in units
    orbit: OrbitElements        # current orbit around parent body
    orders: List[ManeuverNode] = field(default_factory=list)
    color: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        data = asdict(self)
        data['class_type'] = self.class_type.value
        data['orbit'] = self.orbit.to_dict()
        data['orders'] = [o.to_dict() for o in self.orders]
        return data


@dataclass
class Faction:
    """A faction (player, enemy, ally)."""
    id: str
    name: str
    color: str                  # hex color for faction assets
    is_player: bool = False

    # Resources
    resources: Dict[str, int] = field(default_factory=lambda: {
        "metal": 1000,
        "fuel": 1000,
        "gold": 100,
        "science": 500,
    })

    # Reputation
    reputation: float = 0.0     # -100 (pariah) to +100 (hero)
    tech_level: int = 1         # research tier (1-5)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return asdict(self)


@dataclass
class GameState:
    """Complete game state snapshot."""
    game_id: str
    current_tick: int
    bodies: List[Body] = field(default_factory=list)
    ships: List[Ship] = field(default_factory=list)
    factions: List[Faction] = field(default_factory=list)
    maneuver_nodes: List[ManeuverNode] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            'game_id': self.game_id,
            'current_tick': self.current_tick,
            'bodies': [b.to_dict() for b in self.bodies],
            'ships': [s.to_dict() for s in self.ships],
            'factions': [f.to_dict() for f in self.factions],
            'maneuver_nodes': [m.to_dict() for m in self.maneuver_nodes],
        }


@dataclass
class ChronicleEntry:
    """An immutable historical event in the game chronicle."""
    id: str
    tick: int
    event_type: str             # 'production', 'maneuver', 'capture', etc.
    faction_id: Optional[str]
    body_id: Optional[str]
    ship_id: Optional[str]
    title: str
    description: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return asdict(self)


@dataclass
class TickResult:
    """Result of executing one game tick."""
    game_id: str
    tick: int
    chronicle_entries: List[ChronicleEntry] = field(default_factory=list)
    state_delta: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            'game_id': self.game_id,
            'tick': self.tick,
            'chronicle_entries': [e.to_dict() for e in self.chronicle_entries],
            'state_delta': self.state_delta,
            'errors': self.errors,
        }


# Production rate table by body type
# Format: {development_level: base_production}
BODY_PRODUCTION_RATES = {
    BodyType.TERRESTRIAL: {
        0: {"metal": 5, "fuel": 2, "gold": 0, "science": 1},
        1: {"metal": 10, "fuel": 4, "gold": 1, "science": 2},
        2: {"metal": 15, "fuel": 6, "gold": 2, "science": 3},
        3: {"metal": 20, "fuel": 8, "gold": 3, "science": 4},
        4: {"metal": 25, "fuel": 10, "gold": 4, "science": 5},
        5: {"metal": 30, "fuel": 12, "gold": 5, "science": 6},
    },
    BodyType.GAS_GIANT: {
        0: {"metal": 1, "fuel": 15, "gold": 0, "science": 2},
        1: {"metal": 2, "fuel": 20, "gold": 1, "science": 3},
        2: {"metal": 3, "fuel": 25, "gold": 2, "science": 4},
        3: {"metal": 4, "fuel": 30, "gold": 3, "science": 5},
        4: {"metal": 5, "fuel": 35, "gold": 4, "science": 6},
        5: {"metal": 6, "fuel": 40, "gold": 5, "science": 7},
    },
    BodyType.MOON: {
        0: {"metal": 3, "fuel": 1, "gold": 0, "science": 0},
        1: {"metal": 6, "fuel": 2, "gold": 0, "science": 1},
        2: {"metal": 9, "fuel": 3, "gold": 1, "science": 1},
        3: {"metal": 12, "fuel": 4, "gold": 1, "science": 2},
        4: {"metal": 15, "fuel": 5, "gold": 2, "science": 2},
        5: {"metal": 18, "fuel": 6, "gold": 2, "science": 3},
    },
    BodyType.ASTEROID: {
        0: {"metal": 8, "fuel": 0, "gold": 1, "science": 0},
        1: {"metal": 16, "fuel": 1, "gold": 2, "science": 0},
        2: {"metal": 24, "fuel": 2, "gold": 3, "science": 1},
        3: {"metal": 32, "fuel": 3, "gold": 4, "science": 1},
        4: {"metal": 40, "fuel": 4, "gold": 5, "science": 2},
        5: {"metal": 48, "fuel": 5, "gold": 6, "science": 2},
    },
    BodyType.LAGRANGE_STATION: {
        0: {"metal": 2, "fuel": 2, "gold": 0, "science": 3},
        1: {"metal": 3, "fuel": 3, "gold": 1, "science": 5},
        2: {"metal": 4, "fuel": 4, "gold": 1, "science": 7},
        3: {"metal": 5, "fuel": 5, "gold": 2, "science": 9},
        4: {"metal": 6, "fuel": 6, "gold": 2, "science": 11},
        5: {"metal": 7, "fuel": 7, "gold": 3, "science": 13},
    },
}
