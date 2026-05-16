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

  surfaceAngle?: number;              // city: angle on body surface (radians)
  orbit?: OrbitElements;              // station: orbit around body

  // Local stockpile — extracted resources awaiting freighter pickup
  stockpile: { fuel: number; ore: number; credits: number; science: number };

  lastHarvestTick: number;            // tick when stockpile last grew
}

/**
 * Per-faction tech progress (forward-declared; the canonical shape lives
 * in src/game/techs.ts).
 */
export interface FactionTechStateBase {
  levels: Record<string, number>;
  researching: string | null;
  progress: number;
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
  aiActivityLog?: AIActivityEntry[];   // optional — rolling log of recent AI decisions

  // Match shape — populated in single-player by setup, in multiplayer by
  // the server. When status === 'completed' the game ends and the
  // VictoryOverlay renders.
  status?: 'lobby' | 'active' | 'completed' | 'abandoned';
  totalTickTarget?: number;            // tick at which the game ends
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
  totalTickTarget: number;             // match length
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
