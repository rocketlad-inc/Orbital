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
 * A starship under player or enemy control
 */
export interface Ship {
  id: string;
  name: string;
  class: 'frigate' | 'cruiser' | 'capital' | 'stealth_runner';
  ownedBy: string;                      // faction id

  // Current state
  fuel: number;                         // remaining fuel

  // Orbital position
  orbit: OrbitElements;                 // current orbit around parent body

  // Maneuvers
  orders: ManeuverNode[];               // planned/committed burns for this ship

  // Display info
  isSelected?: boolean;
  color?: string;                       // override faction color if needed
}

/**
 * A faction (player, enemy, ally)
 */
export interface Faction {
  id: string;
  name: string;
  color: string;                        // hex color for faction assets
  isPlayer: boolean;
}

/**
 * Complete game state snapshot
 */
export interface GameState {
  currentTick: number;
  bodies: Body[];
  ships: Ship[];
  factions: Faction[];
  orders: ManeuverNode[];              // all maneuvers in the game
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
  maneuverMode?: 'transfer' | 'orbital_change' | null;
  transferTargetId?: string;            // when planning a transfer
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
