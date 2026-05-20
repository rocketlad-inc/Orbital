// ============================================================
// Core Type Definitions for Orbital Game State and UI
// ============================================================

/**
 * Orbital elements: describes an elliptical orbit around a parent body
 * Uses Kepler elements: semi-major axis (a), eccentricity (e), etc.
 */
export interface OrbitElements {
  rp: number;              // periapsis radius (closest approach)
  ra: number;              // apoapsis radius (farthest point)
  omega: number;           // argument of periapsis (angle to Pe in orbital plane)
  M0: number;              // mean anomaly at epoch (stored as true anomaly)
  epoch: number;           // tick number when this orbit was computed
  direction: 1 | -1;       // +1 for prograde, -1 for retrograde
  period: number;          // orbital period in ticks (Kepler's 3rd law)
  parentBodyId: string;    // ID of the body this orbit is around
}

/**
 * Maneuver node: a planned burn at a specific time
 * status: 'planned' (not yet committed), 'committed' (ready to execute),
 *         'executed' (has been performed)
 */
export interface ManeuverNode {
  id: string;
  shipId: string;
  type: 'transfer' | 'orbital_change' | 'manual_burn';
  burnTime: number;                    // tick when burn occurs
  deltav: number;                      // delta-v in km/s equivalent
  prograde: number;                    // prograde component of burn
  radial: number;                      // radial component of burn
  normal: number;                      // normal component of burn
  status: 'planned' | 'committed' | 'executed';
  label?: string;                      // human-readable burn label

  // Predicted outcome after burn
  preOrbit?: OrbitElements;            // orbit before burn
  postOrbit?: OrbitElements;           // orbit after burn
  capturedAtBody?: string;             // if transfer, body where capture occurs
  escapesBody?: boolean;               // if true, escapes to hyperbolic
}

/**
 * A celestial body: planet, star, moon, asteroid, or Lagrange point
 */
export interface Body {
  id: string;
  name: string;
  type: 'star' | 'terrestrial' | 'gas_giant' | 'ice_giant' | 'moon' | 'dwarf' | 'asteroid' | 'lagrange';
  mu?: number;                          // gravitational parameter (per-body override)

  // Orbital parameters (if not a star)
  parent?: string;                      // parent body id (null for Sol)
  orbitRadius: number;                  // semi-major axis of orbit around parent
  orbitPeriod: number;                  // orbital period in ticks
  angle0: number;                       // initial angle (radians) on orbit

  // Physical properties
  radius: number;                       // visible radius in game units (for rendering)
  soi: number;                          // sphere of influence

  // Appearance
  color: string;                        // hex color for rendering

  // Resources (per tick production/storage)
  resources?: {
    metal: number;
    fuel: number;
    gold: number;
    science: number;
  };

  // Ownership
  ownedBy?: string;                     // faction id

  /** Hidden surprise — set at game start by the secrets seeder for a
   *  handful of non-capital bodies. Revealed when a player ship first
   *  reaches the body; the effect fires and `revealed` flips true.
   *  Persistent secrets (portal_to_sun, slingshot_anomaly) keep
   *  applying after reveal; one-shot secrets are inert after firing. */
  secret?: BodySecret;
}

/**
 * Kinds of exploration surprises seeded onto non-capital bodies.
 *
 *   portal_to_sun     — every arriving ship is warped to a low Sol orbit
 *                       (persistent shortcut once discovered)
 *   ancient_city      — discoverer gets a free city (pop 3, free Lab L2)
 *   free_collector    — discoverer gets a free city with hasCollector
 *   derelict_warship  — discoverer claims a free Destroyer-class ship
 *   resource_cache    — discoverer's pool gets +500 ore + 500 credits
 *   ancient_databank  — discoverer gets +1 level in a random tech
 */
export type BodySecretKind =
  | 'portal_to_sun'
  | 'ancient_city'
  | 'free_collector'
  | 'derelict_warship'
  | 'resource_cache'
  | 'ancient_databank';

export interface BodySecret {
  kind: BodySecretKind;
  revealed?: boolean;                   // set when the effect first fires
  discoveredByFactionId?: string;
  discoveredAtTick?: number;
}

/**
 * Fleet: a group of ships that move and fight together
 */
export interface Fleet {
  id: string;
  name: string;
  shipIds: string[];
  leadShipId: string;                   // the ship whose position represents the fleet
  ownedBy: string;                      // faction id
}

/**
 * A starship under player or enemy control
 */
export interface Ship {
  id: string;
  name: string;
  class: 'corvette' | 'frigate' | 'destroyer' | 'freighter';
  ownedBy: string;                      // faction id

  // Current state
  fuel: number;                         // remaining fuel
  hp?: number;                          // current HP (undefined = full from class def)
  fleetId?: string;                     // fleet this ship belongs to (if any)

  // Orbital position
  orbit: OrbitElements;                 // current orbit around parent body

  // Maneuvers
  orders: ManeuverNode[];               // planned/committed burns for this ship

  // Bezier transfer state
  pendingTransfer?: TransferArc;        // planned but not yet departed
  transfer?: TransferArc;               // currently in transit
  queuedTransfers?: TransferArc[];      // chained transfers waiting after current

  // Combat — tick when this ship last fired in auto-combat at its body
  lastCombatTick?: number;
  // Combat — tick when this ship last TOOK damage. Used by the renderer
  // to flash the ship marker briefly so the player sees hits land.
  lastDamagedTick?: number;
}

/**
 * A faction (player, enemy, ally)
 */
export interface Faction {
  id: string;
  name: string;
  color: string;                        // hex color for faction assets
  isPlayer: boolean;
  /** When true, this faction's turn is driven by src/game/factionAI.ts
   *  instead of waiting for player input. Single-player only for v1. */
  isAI?: boolean;
  /** Tick at which the AI last ran a decision cycle for this faction.
   *  Used to throttle AI evaluations to AI_DECISION_INTERVAL. */
  lastAIDecisionTick?: number;
}

/**
 * A single AI decision entry — what the AI did, when, and a one-line
 * human-readable description for the activity feed.
 */
export interface AIActivityEntry {
  id: string;
  tick: number;
  factionId: string;
  message: string;
  kind: 'build' | 'deploy' | 'transfer' | 'research' | 'idle';
}

/**
 * Build order: a ship under construction at a body
 */
export interface BuildOrder {
  id: string;
  bodyId: string;                       // where the ship is being built
  shipClass: 'corvette' | 'frigate' | 'destroyer' | 'freighter';
  ownedBy: string;                      // faction that ordered it
  startTick: number;                    // tick when construction started
  completeTick: number;                 // tick when ship launches to orbit
  shipName: string;                     // name for the new ship
}

/**
 * Player/faction resources (stubbed global pool)
 */
export interface FactionResources {
  fuel: number;
  ore: number;
  credits: number;
  science: number;
}

/**
 * Settlement: city or orbital station that extracts a body's resources
 * into a local stockpile. Freighters carry stockpile to the global pool.
 */
export type SettlementType = 'city' | 'station';

export interface Settlement {
  id: string;
  type: SettlementType;
  name: string;
  bodyId: string;                     // body it's on (city) or orbits (station)
  ownedBy: string;                    // faction id

  hp: number;
  maxHp: number;

  population: number;                 // starts at 1, +1 per growth interval
  lastGrowthTick: number;             // tick when population last grew
  lastCombatTick?: number;            // tick when this settlement last returned fire
  lastDamagedTick?: number;           // tick when this settlement last TOOK damage

  surfaceAngle?: number;              // city: angle on body surface (radians)
  orbit?: OrbitElements;              // station: orbit around body

  // Local stockpile — extracted resources awaiting freighter pickup
  stockpile: { fuel: number; ore: number; credits: number; science: number };

  lastHarvestTick: number;            // tick when stockpile last grew

  /** Collector network endpoint. When true, this settlement can receive
   *  freighter trade-route dropoffs AND it counts toward the empire's
   *  "has at least one collector" gate for the background stockpile
   *  auto-drain. Capitals start with this; everything else has to build
   *  one (high cost, see COLLECTOR_COST in src/game/settlements.ts). */
  hasCollector?: boolean;
  /** Tick this collector was constructed at, surfaced in the UI as a
   *  build date. undefined for the capital's free starting collector. */
  collectorBuiltTick?: number;

  /** Per-building level counters. Missing key = level 0.
   *  Cities can host forge / mint / lab; stations can host weapons /
   *  shipyard. Effects compound additively per level via the helpers
   *  in src/game/settlements.ts — see BUILDING_DEFS for the catalog. */
  buildings?: Partial<Record<BuildingKind, number>>;
  /** Single in-flight building upgrade for this settlement. Only one
   *  at a time per settlement — finish or cancel before queueing
   *  another. Cleared by the per-tick completion loop in
   *  advanceToTick once completeTick is reached. */
  buildingQueue?: SettlementBuildOrder;
}

/**
 * Kinds of upgrade buildings that can be queued at a settlement.
 * City-only: forge / mint / lab.  Station-only: weapons / shipyard.
 */
export type BuildingKind = 'forge' | 'mint' | 'lab' | 'weapons' | 'shipyard';

/**
 * One in-flight upgrade at a settlement. The "ship build queue"
 * pattern (see BuildOrder above) for the settlement-buildings system.
 */
export interface SettlementBuildOrder {
  id: string;
  settlementId: string;
  kind: BuildingKind;
  targetLevel: number;   // level the settlement will be at on completion
  startTick: number;
  completeTick: number;
}

/**
 * Trade route assigned to a freighter. The freighter runs origin → dest
 * (a settlement with a stockpile, e.g. a city) → (a collector) and back
 * indefinitely until the player cancels it. Auto-drain still flows in
 * the background; an active route layers a multiplier on top of that
 * base rate scaled by Flight Dynamics tech.
 *
 * NOTE: data shape only this turn. The execution loop, on-map
 * rendering, and piracy-on-death cargo drop land in the next pass —
 * the field exists now so the rest of the code can compile against it
 * and the lobby/load-save flows persist routes across reloads.
 */
export interface TradeRoute {
  id: string;
  ownedBy: string;          // faction running the route
  shipId: string;           // the freighter assigned (must be ownedBy)
  originBodyId: string;     // settlement we pick up from
  destBodyId: string;       // collector we drop off at
  status: 'outbound' | 'returning' | 'paused';
  /** Cargo currently sitting in the freighter's hold. Captured by the
   *  killer's pool if the freighter dies en route. */
  cargo: { fuel: number; ore: number; credits: number; science: number };
  createdAtTick: number;
}

/**
 * Per-faction tech progress (forward-declared; the canonical shape lives
 * in src/game/techs.ts). `queue` is optional so callers that haven't been
 * updated to the queue model keep type-checking.
 */
export interface FactionTechStateBase {
  levels: Record<string, number>;
  researching: string | null;
  progress: number;
  queue?: string[];
}

/**
 * Complete game state snapshot
 */
export interface GameState {
  currentTick: number;
  bodies: Body[];
  ships: Ship[];
  fleets: Fleet[];
  factions: Faction[];
  settlements: Settlement[];           // cities and orbital stations
  orders: ManeuverNode[];              // all maneuvers in the game
  buildOrders: BuildOrder[];           // ships under construction
  resources: Record<string, FactionResources>; // factionId → resources
  factionTech: Record<string, FactionTechStateBase>; // factionId → tech progress
  combatLog: string[];                 // recent combat events
  lastHarvestTick: number;             // tick when resources were last collected
  /** Active trade routes (freighter ↔ collector). Empty when no
   *  freighter has been assigned. Persisted with the save. Currently
   *  data-only — the execution loop lands next turn. */
  tradeRoutes?: TradeRoute[];
  aiActivityLog?: AIActivityEntry[];   // optional — rolling log of recent AI decisions

  // Match shape — populated in single-player by setup, in multiplayer by
  // the server. Games run indefinitely now; `status` only flips to
  // 'completed' via host-initiated abandon. The tick-countdown win
  // condition (`totalTickTarget`) was removed.
  status?: 'lobby' | 'active' | 'completed' | 'abandoned';
  winnerFactionId?: string;            // set when status flips to 'completed'
  victoryType?: 'hegemony' | 'wealth' | 'tiebreak';
}

/**
 * Single-player setup config — captured from the SinglePlayerSetup screen
 * and consumed by setupSinglePlayer() to seed an initial GameState.
 */
export interface SinglePlayerConfig {
  player: {
    factionName: string;
    color: string;
    startingBodyId: string;
  };
  aiOpponents: Array<{
    factionName: string;
    color: string;
    startingBodyId: string;
  }>;
  mapSeed?: string;                    // optional seed for repeatability
}

/**
 * Camera viewport state
 */
export interface CameraState {
  x: number;                            // center position x
  y: number;                            // center position y
  scale: number;                        // zoom level (pixels per game unit)
  zoomLevel: 1 | 2 | 3;                 // discrete zoom mode
  focusedBodyId?: string;               // if set, camera centers on this body and shows local SOI
}

/**
 * UI state for map interaction
 */
export interface MapUIState {
  selectedShipId?: string;
  selectedBodyId?: string;
  hoveredBodyId?: string;
  targetSelectionMode?: boolean;        // true when picking a transfer target on the map
}

/**
 * Bezier transfer arc: a precomputed cubic Bezier curve between two bodies.
 * Hohmann math drives fuel cost and travel time; the curve is purely visual.
 */
export interface TransferArc {
  id: string;
  departureBodyId: string;
  arrivalBodyId: string;
  departureTime: number;
  arrivalTime: number;
  departureDv: number;
  arrivalDv: number;
  label: string;
  p0: { x: number; y: number };
  p3: { x: number; y: number };
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
}

/**
 * Trajectory arc: one segment of a ship's path around a single parent
 */
export interface TrajectoryArc {
  orbit: OrbitElements;
  tStart: number;                       // start tick
  tEnd: number;                         // end tick
  endReason: 'exit' | 'enter' | 'node' | 'budget';
}

/**
 * Full trajectory: sequence of arcs as ship moves through SOIs
 */
export interface Trajectory {
  arcs: TrajectoryArc[];
}

/**
 * Rendering hints for maneuver visualization
 */
export interface ManeuverRenderHints {
  currentOrbitColor: string;            // cyan
  plannedBurnColor: string;             // amber dashed
  committedBurnColor: string;           // amber solid
  captureColor: string;                 // green
  escapeColor: string;                  // red
}
