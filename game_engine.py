"""
Game Engine — Atomic Tick Execution

This module orchestrates one complete game tick, atomically persisting all mutations
to the database. The order of operations is carefully defined to ensure consistency
across the orbital mechanics, resource economy, and standing order system.

Key principles:
- ALL mutations happen in ONE transaction per tick
- If any step fails, the entire tick rolls back
- The tick_execution_state table tracks progress for resumability
- JSON fields (orbits, conditions, treaties) are flexible without schema migration
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from enum import Enum

logger = logging.getLogger(__name__)


# ============================================================================
# Data Classes
# ============================================================================


class ChronicleEventType(Enum):
    """Types of events that can be logged to the chronicle."""
    MANEUVER_EXECUTED = "maneuver_executed"
    SOI_ENTERED = "soi_entered"
    SOI_EXITED = "soi_exited"
    BODY_CLAIMED = "body_claimed"
    COMBAT_ENGAGED = "combat_engaged"
    STANDING_ORDER_TRIGGERED = "standing_order_triggered"
    TECH_COMPLETED = "tech_completed"
    PRODUCTION_COMPLETED = "production_completed"
    TREATY_SIGNED = "treaty_signed"
    TREATY_BROKEN = "treaty_broken"
    REPUTATION_DECAYED = "reputation_decayed"
    PRODUCTION_ACCUMULATED = "production_accumulated"


class ManeuverStatus(Enum):
    """Status of a maneuver order."""
    COMMITTED = "committed"
    EXECUTING = "executing"
    EXECUTED = "executed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TechStatus(Enum):
    """Status of tech research."""
    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


@dataclass
class OrbitElement:
    """Orbital elements stored as JSON in the database."""
    rp: float  # Periapsis distance (km)
    ra: float  # Apoapsis distance (km)
    omega: float  # Argument of periapsis (radians)
    M0: float  # Mean anomaly at epoch (radians)
    epoch: float  # Reference time for orbital state (ticks)
    direction: str  # "prograde" or "retrograde"
    period: float  # Orbital period (ticks)
    parentBodyId: str  # ID of the body being orbited

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rp": self.rp,
            "ra": self.ra,
            "omega": self.omega,
            "M0": self.M0,
            "epoch": self.epoch,
            "direction": self.direction,
            "period": self.period,
            "parentBodyId": self.parentBodyId,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OrbitElement":
        return cls(**data)


@dataclass
class Ship:
    """Fleet unit representation."""
    id: str
    gameId: str
    ownedBy: str
    name: str
    shipClass: str
    fuel: float
    maxFuel: float
    currentOrbit: OrbitElement
    currentTick: int

    def to_db_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "gameId": self.gameId,
            "ownedBy": self.ownedBy,
            "name": self.name,
            "class": self.shipClass,
            "fuel": self.fuel,
            "maxFuel": self.maxFuel,
            "currentOrbit_json": json.dumps(self.currentOrbit.to_dict()),
            "currentTick": self.currentTick,
        }


@dataclass
class Body:
    """Celestial body (planet, moon, or station)."""
    id: str
    gameId: str
    name: str
    bodyType: str  # "planet", "moon", "station"
    orbitRadius: float
    orbitPeriod: float
    soi: float  # Sphere of influence
    ownedBy: Optional[str]
    developmentLevel: int
    resources_per_tick: Dict[str, float]  # metal, fuel, gold, science
    storedResources: Dict[str, float]
    parent: Optional[str]

    def to_db_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "gameId": self.gameId,
            "name": self.name,
            "type": self.bodyType,
            "orbitRadius": self.orbitRadius,
            "orbitPeriod": self.orbitPeriod,
            "soi": self.soi,
            "ownedBy": self.ownedBy,
            "developmentLevel": self.developmentLevel,
            "resources_per_tick_metal": self.resources_per_tick.get("metal", 0),
            "resources_per_tick_fuel": self.resources_per_tick.get("fuel", 0),
            "resources_per_tick_gold": self.resources_per_tick.get("gold", 0),
            "resources_per_tick_science": self.resources_per_tick.get("science", 0),
            "stored_metal": self.storedResources.get("metal", 0),
            "stored_fuel": self.storedResources.get("fuel", 0),
            "stored_gold": self.storedResources.get("gold", 0),
            "stored_science": self.storedResources.get("science", 0),
            "parent": self.parent,
        }


@dataclass
class ManeuverOrder:
    """Fleet movement order."""
    id: str
    gameId: str
    shipId: str
    orderType: str
    status: ManeuverStatus
    plannedBurnTime: int  # Tick at which burn is scheduled
    deltaV: float  # m/s
    postOrbit: Optional[OrbitElement] = None


@dataclass
class StandingOrder:
    """Conditional automation rule."""
    id: str
    gameId: str
    factionId: str
    condition: Dict[str, Any]  # JSON condition string
    action: Dict[str, Any]  # JSON action string
    enabled: bool
    lastExecutedTick: Optional[int] = None


@dataclass
class ResourceInventory:
    """Faction resource holdings."""
    id: str
    gameId: str
    factionId: str
    metal: float = 0
    fuel: float = 0
    gold: float = 0
    science: float = 0

    def to_dict(self) -> Dict[str, float]:
        return {
            "metal": self.metal,
            "fuel": self.fuel,
            "gold": self.gold,
            "science": self.science,
        }


@dataclass
class TechResearch:
    """Technology research progression."""
    id: str
    gameId: str
    factionId: str
    techId: str
    status: TechStatus
    progress_ticks: int
    totalTicks: int
    completedAtTick: Optional[int] = None


@dataclass
class ProductionQueueItem:
    """Ship or facility under construction."""
    id: str
    gameId: str
    factionId: str
    itemType: str  # "ship" or "facility"
    targetId: str  # Body ID or design ID
    progress_ticks: int
    totalTicks: int


@dataclass
class ChronicleEntry:
    """Historical record of a game event."""
    gameId: str
    tick: int
    eventType: ChronicleEventType
    data: Dict[str, Any]
    displayText: str


@dataclass
class GameState:
    """In-memory representation of game state for a tick."""
    gameId: str
    currentTick: int
    ships: Dict[str, Ship] = field(default_factory=dict)
    bodies: Dict[str, Body] = field(default_factory=dict)
    factions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    resources: Dict[str, ResourceInventory] = field(default_factory=dict)
    maneuverOrders: List[ManeuverOrder] = field(default_factory=list)
    standingOrders: List[StandingOrder] = field(default_factory=list)
    techResearch: List[TechResearch] = field(default_factory=list)
    productionQueue: List[ProductionQueueItem] = field(default_factory=list)
    chronicle: List[ChronicleEntry] = field(default_factory=list)


@dataclass
class TickResult:
    """Result of executing one tick."""
    success: bool
    tick: int
    eventsLogged: int
    errors: List[str] = field(default_factory=list)
    executionTime: float = 0.0


# ============================================================================
# Physics Module (Placeholder)
# ============================================================================


class OrbitalPhysics:
    """
    Encapsulates orbital mechanics calculations.

    In a full implementation, this would integrate with an actual
    physics engine (e.g., based on vis-viva, Kepler's equations).
    For now, this is a stub for the game engine structure.
    """

    @staticmethod
    def computePostBurnOrbit(
        preOrbit: OrbitElement,
        deltaV: float,
        burnTime: int,
    ) -> OrbitElement:
        """
        Compute the post-burn orbit after applying a delta-v burn.

        Args:
            preOrbit: Current orbital elements
            deltaV: Change in velocity (m/s)
            burnTime: Tick at which burn occurred

        Returns:
            New orbital elements after burn
        """
        # TODO: Implement using vis-viva equation and Kepler's equations
        # For now, return a modified copy
        newOrbit = OrbitElement(
            rp=preOrbit.rp * (1.0 + deltaV / 1000.0),
            ra=preOrbit.ra * (1.0 + deltaV / 1000.0),
            omega=preOrbit.omega,
            M0=preOrbit.M0,
            epoch=burnTime,
            direction=preOrbit.direction,
            period=preOrbit.period,
            parentBodyId=preOrbit.parentBodyId,
        )
        return newOrbit

    @staticmethod
    def fuelRequired(preOrbit: OrbitElement, postOrbit: OrbitElement) -> float:
        """
        Estimate fuel consumption based on Tsiolkovsky rocket equation.

        Returns fuel units needed (implementation-dependent).
        """
        # TODO: Implement actual Tsiolkovsky calculation
        return 10.0  # Stub


# ============================================================================
# Database Interface (Abstraction)
# ============================================================================


class Database:
    """
    Abstract interface for database operations.

    Implementations (e.g., PostgreSQL, SQLite) handle connection pooling,
    transaction management, and query execution.
    """

    def begin_transaction(self) -> None:
        """Start an atomic transaction."""
        raise NotImplementedError

    def commit(self) -> None:
        """Commit the transaction."""
        raise NotImplementedError

    def rollback(self) -> None:
        """Rollback the transaction."""
        raise NotImplementedError

    def query(self, sql: str, params: List[Any] = None) -> List[Dict[str, Any]]:
        """Execute a SELECT query."""
        raise NotImplementedError

    def execute(self, sql: str, params: List[Any] = None) -> None:
        """Execute an INSERT, UPDATE, or DELETE."""
        raise NotImplementedError

    def execute_many(
        self, sql: str, param_list: List[List[Any]]
    ) -> None:
        """Execute multiple INSERTs/UPDATEs/DELETEs."""
        raise NotImplementedError


# ============================================================================
# Main Engine
# ============================================================================


class GameEngine:
    """
    Orchestrates atomic tick execution.

    The engine follows a strict order of operations:
    1. Load game state
    2. Execute maneuvers
    3. Check SOI transitions
    4. Evaluate standing orders
    5. Resolve combat (delegated)
    6. Accumulate production
    7. Advance research
    8. Advance production queue
    9. Check treaty violations
    10. Decay reputation
    11. Generate chronicle
    12. Persist state (atomic)
    """

    def __init__(self, db: Database, physics_engine: OrbitalPhysics = None):
        self.db = db
        self.physics = physics_engine or OrbitalPhysics()

    def execute_tick(self, game_id: str, tick: int) -> TickResult:
        """
        Execute one complete game tick atomically.

        Args:
            game_id: The ID of the game being advanced
            tick: The tick number to execute

        Returns:
            TickResult with success status and event count
        """
        import time

        start_time = time.time()
        result = TickResult(success=False, tick=tick, eventsLogged=0)

        try:
            self.db.begin_transaction()

            # 1. Load game state
            game_state = self._load_game_state(game_id, tick)
            logger.info(f"Loaded game state for {game_id} tick {tick}")

            # 2. Execute maneuvers
            self._execute_maneuvers(game_state)
            logger.debug(f"Executed maneuvers for {len(game_state.maneuverOrders)} orders")

            # 3. Check SOI transitions
            self._check_soi_transitions(game_state)
            logger.debug(f"Checked SOI transitions for {len(game_state.ships)} ships")

            # 4. Evaluate standing orders
            self._evaluate_standing_orders(game_state)
            logger.debug(f"Evaluated {len(game_state.standingOrders)} standing orders")

            # 5. Resolve combat (delegated to combat system)
            # self._resolve_combat(game_state)

            # 6. Accumulate production
            self._accumulate_production(game_state)
            logger.debug(f"Accumulated production for {len(game_state.bodies)} bodies")

            # 7. Advance tech research
            self._advance_research(game_state)
            logger.debug(f"Advanced {len(game_state.techResearch)} tech researches")

            # 8. Advance production queue
            self._advance_production_queue(game_state)
            logger.debug(f"Advanced {len(game_state.productionQueue)} production items")

            # 9. Check treaty violations
            # self._check_treaty_violations(game_state)

            # 10. Decay reputation
            self._decay_reputation(game_state)
            logger.debug("Decayed faction reputations")

            # 11. Generate chronicle
            # Chronicles are added during each step above

            # 12. Persist state
            self._save_tick_state(game_id, tick, game_state)
            logger.info(f"Saved tick state for {game_id} tick {tick}")

            self.db.commit()
            result.success = True
            result.eventsLogged = len(game_state.chronicle)

        except Exception as e:
            logger.error(f"Tick execution failed: {e}", exc_info=True)
            self.db.rollback()
            result.errors.append(str(e))

        finally:
            result.executionTime = time.time() - start_time

        return result

    def _load_game_state(self, game_id: str, tick: int) -> GameState:
        """
        Query all relevant tables into in-memory structs.

        This is a critical step that determines what data the engine will work with.
        All subsequent operations work on this snapshot.
        """
        game_state = GameState(gameId=game_id, currentTick=tick)

        # Load ships
        ship_rows = self.db.query(
            "SELECT * FROM ships WHERE gameId = ?",
            [game_id],
        )
        for row in ship_rows:
            orbit = OrbitElement.from_dict(json.loads(row["currentOrbit_json"]))
            ship = Ship(
                id=row["id"],
                gameId=row["gameId"],
                ownedBy=row["ownedBy"],
                name=row["name"],
                shipClass=row["class"],
                fuel=row["fuel"],
                maxFuel=row["maxFuel"],
                currentOrbit=orbit,
                currentTick=row["currentTick"],
            )
            game_state.ships[ship.id] = ship

        # Load bodies
        body_rows = self.db.query(
            "SELECT * FROM bodies WHERE gameId = ?",
            [game_id],
        )
        for row in body_rows:
            body = Body(
                id=row["id"],
                gameId=row["gameId"],
                name=row["name"],
                bodyType=row["type"],
                orbitRadius=row["orbitRadius"],
                orbitPeriod=row["orbitPeriod"],
                soi=row["soi"],
                ownedBy=row["ownedBy"],
                developmentLevel=row["developmentLevel"],
                resources_per_tick={
                    "metal": row["resources_per_tick_metal"],
                    "fuel": row["resources_per_tick_fuel"],
                    "gold": row["resources_per_tick_gold"],
                    "science": row["resources_per_tick_science"],
                },
                storedResources={
                    "metal": row.get("stored_metal", 0),
                    "fuel": row.get("stored_fuel", 0),
                    "gold": row.get("stored_gold", 0),
                    "science": row.get("stored_science", 0),
                },
                parent=row.get("parent"),
            )
            game_state.bodies[body.id] = body

        # Load factions
        faction_rows = self.db.query(
            "SELECT * FROM factions WHERE gameId = ?",
            [game_id],
        )
        for row in faction_rows:
            game_state.factions[row["id"]] = row

        # Load resources
        resource_rows = self.db.query(
            "SELECT * FROM resources WHERE gameId = ?",
            [game_id],
        )
        for row in resource_rows:
            inv = ResourceInventory(
                id=row["id"],
                gameId=row["gameId"],
                factionId=row["factionId"],
                metal=row["metal"],
                fuel=row["fuel"],
                gold=row["gold"],
                science=row["science"],
            )
            game_state.resources[row["factionId"]] = inv

        # Load maneuver orders due this tick
        maneuver_rows = self.db.query(
            "SELECT * FROM maneuver_orders WHERE gameId = ? AND plannedBurnTime = ? AND status = ?",
            [game_id, tick, ManeuverStatus.COMMITTED.value],
        )
        for row in maneuver_rows:
            order = ManeuverOrder(
                id=row["id"],
                gameId=row["gameId"],
                shipId=row["shipId"],
                orderType=row["type"],
                status=ManeuverStatus(row["status"]),
                plannedBurnTime=row["plannedBurnTime"],
                deltaV=row["deltav"],
                postOrbit=(
                    OrbitElement.from_dict(json.loads(row["postOrbit_json"]))
                    if row.get("postOrbit_json")
                    else None
                ),
            )
            game_state.maneuverOrders.append(order)

        # Load standing orders
        standing_rows = self.db.query(
            "SELECT * FROM standing_orders WHERE gameId = ? AND enabled = TRUE",
            [game_id],
        )
        for row in standing_rows:
            order = StandingOrder(
                id=row["id"],
                gameId=row["gameId"],
                factionId=row["factionId"],
                condition=json.loads(row["condition_json"]),
                action=json.loads(row["action_json"]),
                enabled=row["enabled"],
                lastExecutedTick=row.get("lastExecutedTick"),
            )
            game_state.standingOrders.append(order)

        # Load tech research
        tech_rows = self.db.query(
            "SELECT * FROM tech_research WHERE gameId = ? AND status IN (?, ?)",
            [game_id, TechStatus.QUEUED.value, TechStatus.IN_PROGRESS.value],
        )
        for row in tech_rows:
            tech = TechResearch(
                id=row["id"],
                gameId=row["gameId"],
                factionId=row["factionId"],
                techId=row["techId"],
                status=TechStatus(row["status"]),
                progress_ticks=row["progress_ticks"],
                totalTicks=row["totalTicks"],
                completedAtTick=row.get("completedAtTick"),
            )
            game_state.techResearch.append(tech)

        # Load production queue
        prod_rows = self.db.query(
            "SELECT * FROM production_queue WHERE gameId = ?",
            [game_id],
        )
        for row in prod_rows:
            item = ProductionQueueItem(
                id=row["id"],
                gameId=row["gameId"],
                factionId=row["factionId"],
                itemType=row["type"],
                targetId=row["targetId"],
                progress_ticks=row["progress_ticks"],
                totalTicks=row["totalTicks"],
            )
            game_state.productionQueue.append(item)

        logger.info(
            f"Loaded state: {len(game_state.ships)} ships, "
            f"{len(game_state.bodies)} bodies, "
            f"{len(game_state.maneuverOrders)} maneuvers due"
        )

        return game_state

    def _execute_maneuvers(self, game_state: GameState) -> None:
        """
        Execute all maneuvers due this tick.

        For each maneuver order:
        - Use physics module to compute post-burn orbit
        - Update ship.currentOrbit_json
        - Deduct fuel
        - Mark order as executed
        """
        for order in game_state.maneuverOrders:
            ship = game_state.ships.get(order.shipId)
            if not ship:
                logger.warning(f"Ship {order.shipId} not found for maneuver {order.id}")
                continue

            try:
                # Compute post-burn orbit
                postOrbit = self.physics.computePostBurnOrbit(
                    ship.currentOrbit, order.deltaV, order.plannedBurnTime
                )

                # Check fuel
                fuelRequired = self.physics.fuelRequired(ship.currentOrbit, postOrbit)
                if ship.fuel < fuelRequired:
                    logger.warning(
                        f"Insufficient fuel for maneuver {order.id}: "
                        f"have {ship.fuel}, need {fuelRequired}"
                    )
                    order.status = ManeuverStatus.FAILED
                    continue

                # Apply maneuver
                ship.currentOrbit = postOrbit
                ship.fuel -= fuelRequired
                order.postOrbit = postOrbit
                order.status = ManeuverStatus.EXECUTED

                # Log event
                game_state.chronicle.append(
                    ChronicleEntry(
                        gameId=game_state.gameId,
                        tick=game_state.currentTick,
                        eventType=ChronicleEventType.MANEUVER_EXECUTED,
                        data={
                            "shipId": ship.id,
                            "orderId": order.id,
                            "deltaV": order.deltaV,
                            "postOrbit": postOrbit.to_dict(),
                            "fuelConsumed": fuelRequired,
                        },
                        displayText=f"{ship.name} executed maneuver (Δv={order.deltaV:.1f} m/s)",
                    )
                )

            except Exception as e:
                logger.error(f"Maneuver execution failed for {order.id}: {e}")
                order.status = ManeuverStatus.FAILED
                game_state.chronicle.append(
                    ChronicleEntry(
                        gameId=game_state.gameId,
                        tick=game_state.currentTick,
                        eventType=ChronicleEventType.MANEUVER_EXECUTED,
                        data={"orderId": order.id, "error": str(e)},
                        displayText=f"Maneuver {order.id} failed: {str(e)}",
                    )
                )

    def _check_soi_transitions(self, game_state: GameState) -> None:
        """
        Detect ships entering/exiting sphere of influence.

        For each ship:
        - Compute distance to potential bodies
        - If entering SOI: update orbit parent
        - If unclaimed body → create claim record
        - If rival's body → log combat situation
        """
        # TODO: Implement position calculation from orbital elements
        # For now, this is a stub that demonstrates the structure
        pass

    def _evaluate_standing_orders(self, game_state: GameState) -> None:
        """
        Evaluate standing order conditions and execute matched actions.

        For each standing order:
        - Parse condition_json (e.g., "ship_location==BodyX && fuel<50%")
        - If condition matches, execute action_json (e.g., "launch_defensive_fleet")
        """
        for order in game_state.standingOrders:
            try:
                if self._evaluate_condition(order.condition, game_state):
                    self._execute_action(order.action, game_state)
                    order.lastExecutedTick = game_state.currentTick

                    game_state.chronicle.append(
                        ChronicleEntry(
                            gameId=game_state.gameId,
                            tick=game_state.currentTick,
                            eventType=ChronicleEventType.STANDING_ORDER_TRIGGERED,
                            data={"orderId": order.id, "action": order.action},
                            displayText=f"Standing order triggered: {order.action}",
                        )
                    )

            except Exception as e:
                logger.error(f"Standing order evaluation failed for {order.id}: {e}")

    def _evaluate_condition(self, condition: Dict[str, Any], game_state: GameState) -> bool:
        """
        Evaluate a condition JSON against the game state.

        Example conditions:
        - {"type": "ship_location", "bodyId": "mars", "threshold": "entering"}
        - {"type": "resource", "factionId": "faction1", "resource": "fuel", "comparison": "<", "value": 100}
        """
        # TODO: Implement a full condition evaluator
        # This is a stub
        return False

    def _execute_action(self, action: Dict[str, Any], game_state: GameState) -> None:
        """
        Execute an action JSON (e.g., launch fleet, adjust research).

        Example actions:
        - {"type": "launch_fleet", "fromBody": "mars", "ships": 5}
        - {"type": "set_research", "tech": "propulsion_level_2"}
        """
        # TODO: Implement action executor
        # This is a stub
        pass

    def _accumulate_production(self, game_state: GameState) -> None:
        """
        Generate resources for all owned bodies.

        For each body:
        - Base production from body.resources_per_tick_{metal,fuel,gold,science}
        - Apply developmentLevel modifier (e.g., level 2 = 1.2x)
        - Apply tech bonus from tech_research table
        - Add to faction's resources row
        """
        for body in game_state.bodies.values():
            if not body.ownedBy:
                continue

            faction_resources = game_state.resources.get(body.ownedBy)
            if not faction_resources:
                logger.warning(f"No resource entry for faction {body.ownedBy}")
                continue

            # Calculate production with modifiers
            dev_modifier = 1.0 + (body.developmentLevel * 0.1)
            # TODO: Apply tech bonuses from game_state.techResearch

            production = {
                "metal": body.resources_per_tick.get("metal", 0) * dev_modifier,
                "fuel": body.resources_per_tick.get("fuel", 0) * dev_modifier,
                "gold": body.resources_per_tick.get("gold", 0) * dev_modifier,
                "science": body.resources_per_tick.get("science", 0) * dev_modifier,
            }

            # Add to faction resources
            faction_resources.metal += production["metal"]
            faction_resources.fuel += production["fuel"]
            faction_resources.gold += production["gold"]
            faction_resources.science += production["science"]

            # Add to body storage
            body.storedResources["metal"] += production["metal"]
            body.storedResources["fuel"] += production["fuel"]
            body.storedResources["gold"] += production["gold"]
            body.storedResources["science"] += production["science"]

            game_state.chronicle.append(
                ChronicleEntry(
                    gameId=game_state.gameId,
                    tick=game_state.currentTick,
                    eventType=ChronicleEventType.PRODUCTION_ACCUMULATED,
                    data={
                        "bodyId": body.id,
                        "factionId": body.ownedBy,
                        "production": production,
                    },
                    displayText=f"{body.name} produced: M={production['metal']:.0f}, F={production['fuel']:.0f}, G={production['gold']:.0f}, S={production['science']:.0f}",
                )
            )

    def _advance_research(self, game_state: GameState) -> None:
        """
        Advance tech research by one tick.

        For each tech_research row:
        - Increment progress_ticks
        - If progress_ticks >= totalTicks: mark completed, apply bonuses
        """
        for tech in game_state.techResearch:
            tech.progress_ticks += 1

            if tech.progress_ticks >= tech.totalTicks:
                tech.status = TechStatus.COMPLETED
                tech.completedAtTick = game_state.currentTick

                game_state.chronicle.append(
                    ChronicleEntry(
                        gameId=game_state.gameId,
                        tick=game_state.currentTick,
                        eventType=ChronicleEventType.TECH_COMPLETED,
                        data={"factionId": tech.factionId, "techId": tech.techId},
                        displayText=f"Faction {tech.factionId} completed research: {tech.techId}",
                    )
                )

    def _advance_production_queue(self, game_state: GameState) -> None:
        """
        Advance ship/facility production by one tick.

        For each production_queue row:
        - Increment progress_ticks
        - If complete: create ship or facility, deduct resources
        """
        completed = []

        for item in game_state.productionQueue:
            item.progress_ticks += 1

            if item.progress_ticks >= item.totalTicks:
                # Production complete
                faction_resources = game_state.resources.get(item.factionId)

                # TODO: Create ship or facility in game_state
                # TODO: Deduct resources

                game_state.chronicle.append(
                    ChronicleEntry(
                        gameId=game_state.gameId,
                        tick=game_state.currentTick,
                        eventType=ChronicleEventType.PRODUCTION_COMPLETED,
                        data={"itemId": item.id, "itemType": item.itemType},
                        displayText=f"Production complete: {item.itemType}",
                    )
                )

                completed.append(item)

        for item in completed:
            game_state.productionQueue.remove(item)

    def _decay_reputation(self, game_state: GameState) -> None:
        """
        Slowly recover faction reputation over time.

        Honest behavior gains reputation; war crimes decay slowly.
        For now, apply +1 per 10 ticks as a simplified model.
        """
        # TODO: Query reputation table and apply decay
        # For now, log that this step occurred
        logger.debug(f"Reputation decay step for tick {game_state.currentTick}")

    def _save_tick_state(
        self, game_id: str, tick: int, game_state: GameState
    ) -> None:
        """
        Persist all mutations to the database in one atomic transaction.

        This is critical: if any INSERT/UPDATE fails, the entire tick rolls back.
        """
        # Update ships
        for ship in game_state.ships.values():
            self.db.execute(
                """
                UPDATE ships SET
                    fuel = ?,
                    currentOrbit_json = ?,
                    currentTick = ?
                WHERE id = ? AND gameId = ?
                """,
                [
                    ship.fuel,
                    json.dumps(ship.currentOrbit.to_dict()),
                    tick,
                    ship.id,
                    game_id,
                ],
            )

        # Update bodies
        for body in game_state.bodies.values():
            self.db.execute(
                """
                UPDATE bodies SET
                    ownedBy = ?,
                    developmentLevel = ?,
                    stored_metal = ?,
                    stored_fuel = ?,
                    stored_gold = ?,
                    stored_science = ?
                WHERE id = ? AND gameId = ?
                """,
                [
                    body.ownedBy,
                    body.developmentLevel,
                    body.storedResources.get("metal", 0),
                    body.storedResources.get("fuel", 0),
                    body.storedResources.get("gold", 0),
                    body.storedResources.get("science", 0),
                    body.id,
                    game_id,
                ],
            )

        # Update resources
        for inv in game_state.resources.values():
            self.db.execute(
                """
                UPDATE resources SET
                    metal = ?,
                    fuel = ?,
                    gold = ?,
                    science = ?
                WHERE gameId = ? AND factionId = ?
                """,
                [inv.metal, inv.fuel, inv.gold, inv.science, game_id, inv.factionId],
            )

        # Update maneuver orders
        for order in game_state.maneuverOrders:
            self.db.execute(
                """
                UPDATE maneuver_orders SET
                    status = ?,
                    postOrbit_json = ?
                WHERE id = ? AND gameId = ?
                """,
                [
                    order.status.value,
                    json.dumps(order.postOrbit.to_dict()) if order.postOrbit else None,
                    order.id,
                    game_id,
                ],
            )

        # Update standing orders
        for order in game_state.standingOrders:
            self.db.execute(
                """
                UPDATE standing_orders SET
                    lastExecutedTick = ?
                WHERE id = ? AND gameId = ?
                """,
                [order.lastExecutedTick, order.id, game_id],
            )

        # Update tech research
        for tech in game_state.techResearch:
            self.db.execute(
                """
                UPDATE tech_research SET
                    status = ?,
                    progress_ticks = ?,
                    completedAtTick = ?
                WHERE id = ? AND gameId = ?
                """,
                [
                    tech.status.value,
                    tech.progress_ticks,
                    tech.completedAtTick,
                    tech.id,
                    game_id,
                ],
            )

        # Update tick execution state
        self.db.execute(
            """
            UPDATE tick_execution_state SET
                lastCompletedTick = ?,
                executionStatus = ?
            WHERE gameId = ?
            """,
            [tick, "completed", game_id],
        )

        # Insert chronicle entries
        for entry in game_state.chronicle:
            self.db.execute(
                """
                INSERT INTO chronicle_entries
                    (gameId, tick, type, data_json, displayText)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    entry.gameId,
                    entry.tick,
                    entry.eventType.value,
                    json.dumps(entry.data),
                    entry.displayText,
                ],
            )

        logger.info(
            f"Persisted tick state: {len(game_state.chronicle)} chronicle entries"
        )


# ============================================================================
# Entry Point
# ============================================================================


def main():
    """Simple test/demo of the game engine."""
    import logging

    logging.basicConfig(level=logging.INFO)

    # This would normally use a real database connection
    # For now, just show the structure
    print("Game Engine initialized and ready.")
    print(
        "Use GameEngine.execute_tick(db, game_id, tick) to run a tick."
    )


if __name__ == "__main__":
    main()
