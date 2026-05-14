# API Reference - Orbital Frontend

Complete reference for all public APIs in the frontend prototype.

## Game Context (`useGameContext()`)

The primary API for accessing and modifying game state. Available in all components via React Context.

### Accessing the Context

```typescript
import { useGameContext } from './state/gameContext';

export function MyComponent() {
  const context = useGameContext();
  // Now access all context methods and state
}
```

### State Properties

#### `gameState: GameState`

Complete game snapshot.

```typescript
interface GameState {
  currentTick: number;      // Game tick counter
  bodies: Body[];           // All celestial bodies
  ships: Ship[];            // All ships in game
  factions: Faction[];      // Player, allies, enemies
  orders: ManeuverNode[];   // All maneuver nodes
}
```

#### `camera: CameraState`

Viewport state for rendering.

```typescript
interface CameraState {
  x: number;                // Camera center X
  y: number;                // Camera center Y
  scale: number;            // Zoom level (pixels per game unit)
  zoomLevel: 1 | 2 | 3;     // Discrete zoom mode
}
```

#### `uiState: MapUIState`

UI interaction state.

```typescript
interface MapUIState {
  selectedShipId?: string;      // Currently selected ship
  selectedBodyId?: string;      // Currently selected body
  hoveredBodyId?: string;       // Currently hovered body
  maneuverMode?: 'transfer' | 'orbital_change' | null;
  transferTargetId?: string;    // Target for transfer maneuver
}
```

### Action Methods

#### Game State Updates

```typescript
setGameState(state: GameState): void
```
Replace entire game state. Use for major updates or loading from backend.

```typescript
updateTick(tick: number): void
```
Update the game tick counter. Called each game frame.

```typescript
loadScenario(type: ScenarioType): void
```
Load a demo scenario (1, 2, or 3). Resets camera and selection.

#### Camera Control

```typescript
updateCamera(partial: Partial<CameraState>): void
```
Update camera position or zoom. Can update individual properties.

```typescript
// Pan camera
updateCamera({ x: 50, y: 100 });

// Zoom in
updateCamera({ scale: 2.0 });

// Change zoom level
updateCamera({ zoomLevel: 2 });
```

```typescript
setZoomLevel(level: 1 | 2 | 3): void
```
Switch to discrete zoom level.

#### Selection

```typescript
selectShip(shipId: string): void
deselectShip(): void
```
Select/deselect a ship. Opens ShipPanel when selected.

```typescript
selectBody(bodyId: string): void
deselectBody(): void
```
Select/deselect a body. Opens BodyInspector when selected.

```typescript
hoverBody(bodyId: string | null): void
```
Set body hover state. Used for visual indicators on map.

#### Maneuver Planning

```typescript
setManeuverMode(mode: 'transfer' | 'orbital_change' | null): void
```
Enter maneuver planning mode. Null to exit planning.

```typescript
setTransferTarget(bodyId: string | null): void
```
Set the target body for transfer maneuver planning.

#### Maneuver Management

```typescript
addManeuverNode(node: ManeuverNode): void
```
Add a new maneuver node to a ship.

```typescript
const newNode: ManeuverNode = {
  id: 'node-123',
  shipId: 'ship-alpha',
  type: 'transfer',
  burnTime: 50,
  deltav: 2.5,
  prograde: 2.3,
  radial: 0.6,
  normal: 0.2,
  status: 'planned',
};
addManeuverNode(newNode);
```

```typescript
commitManeuverNode(nodeId: string): void
```
Mark a node as committed (ready to execute). Changes status from 'planned' to 'committed'.

```typescript
deleteManeuverNode(nodeId: string): void
```
Remove a maneuver node.

---

## Physics Module (`orbitalMechanics.ts`)

Low-level orbital mechanics calculations.

### Constants

```typescript
export const GRAVITATIONAL_PARAMS = {
  SOL: 4 * Math.PI * Math.PI * ..., // ~3.94e3
  PLANET: 200,                        // Terrestrial planets
  GAS_GIANT: 600,                     // Gas giants
};
```

### Functions

#### Orbital Elements

```typescript
function semiMajor(orbit: OrbitElements): number
```
Get semi-major axis (a) from orbit. Averages periapsis and apoapsis.

```typescript
function eccentricity(orbit: OrbitElements): number
```
Get eccentricity (e) from orbit. Ranges 0 (circular) to <1 (elliptical).

#### Kepler's Equation

```typescript
function solveKepler(M: number, e: number): number
```
Solve M = E - e·sin(E) for true anomaly θ.
- **M**: Mean anomaly (0 to 2π)
- **e**: Eccentricity (0 to <1)
- **Returns**: True anomaly θ (0 to 2π)

Uses Newton-Raphson iteration, converges in ~5-8 iterations.

#### Position & Velocity

```typescript
function trueAnomalyAt(orbit: OrbitElements, t: number): number
```
Get true anomaly (position in orbit) at time t.

```typescript
function radiusAt(orbit: OrbitElements, theta: number): number
```
Get orbital radius at true anomaly θ.
Formula: r = a(1-e²)/(1 + e·cos(θ))

```typescript
function localPositionAt(orbit: OrbitElements, t: number): LocalPosition
```
Get position relative to orbit's parent body at time t.

```typescript
interface LocalPosition {
  x: number;      // Local X coordinate
  y: number;      // Local Y coordinate
  theta: number;  // True anomaly (position in orbit)
  r: number;      // Radius from parent
  phi: number;    // Absolute angle in orbital plane
}
```

```typescript
function velocityVectorsAt(orbit: OrbitElements, t: number): VelocityVectors
```
Get velocity unit vectors (prograde, radial) at time t.

```typescript
interface VelocityVectors {
  prograde: { x: number; y: number };  // Tangent to orbit
  radialOut: { x: number; y: number }; // Away from parent
  r: number;      // Radius at position
  theta: number;  // True anomaly
  phi: number;    // Orbital angle
}
```

#### World Coordinates

```typescript
function bodyPosition(
  body: Body,
  t: number,
  bodies: Body[]
): WorldPosition
```
Get world position of a body at time t.

```typescript
function orbitWorldPos(
  orbit: OrbitElements,
  t: number,
  bodies: Body[]
): WorldPosition
```
Get world position of a ship on an orbit at time t.

#### Orbital Mechanics

```typescript
function muOf(bodyId: string, bodies: Body[]): number
```
Get gravitational parameter (μ) for a body. Used in all orbital math.

```typescript
function visVivaSpeed(mu: number, r: number, a: number): number
```
Vis-viva equation: compute orbital speed at radius r.
Formula: v = √(μ(2/r - 1/a))

```typescript
function semiMajorFromVisViva(mu: number, r: number, vMag: number): number
```
Inverse vis-viva: compute semi-major axis from velocity.
Formula: a = 1/(2/r - v²/μ)

#### Sphere of Influence (SOI)

```typescript
function isInsideSOI(
  worldX: number,
  worldY: number,
  body: Body,
  t: number,
  bodies: Body[]
): boolean
```
Check if world position is inside a body's SOI.

```typescript
function whichSOI(
  worldX: number,
  worldY: number,
  t: number,
  bodies: Body[]
): Body
```
Find the deepest (smallest, most specific) SOI containing a position.

#### Orbit Creation Helpers

```typescript
function createCircularOrbit(
  bodyId: string,
  radius: number,
  t: number,
  bodies: Body[]
): OrbitElements
```
Create a circular orbit at a given radius around a body.

```typescript
function createTransferOrbit(
  fromRadius: number,
  toRadius: number,
  parentBodyId: string,
  t: number,
  bodies: Body[]
): OrbitElements
```
Create a transfer ellipse between two orbital radii.

---

## Rendering Module (`mapRenderer.ts`)

Canvas drawing utilities.

### Types

```typescript
interface RenderContext {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  camera: { x: number; y: number; scale: number };
  t: number;           // Game tick
  bodies: Body[];      // All bodies (for lookups)
}
```

### Functions

#### Coordinate Transforms

```typescript
function worldToCanvas(
  worldX: number,
  worldY: number,
  ctx: RenderContext
): { x: number; y: number }
```
Convert world coordinates to canvas coordinates (for drawing).

```typescript
function canvasToWorld(
  canvasX: number,
  canvasY: number,
  ctx: RenderContext
): { x: number; y: number }
```
Convert canvas coordinates to world coordinates (for click detection).

#### Rendering Primitives

```typescript
function clearCanvas(ctx: RenderContext): void
```
Fill canvas with background color and draw grid.

```typescript
function drawOrbit(
  body: Body,
  ctx: RenderContext,
  color?: string,
  width?: number
): void
```
Draw circular orbit of a body around its parent.

```typescript
function drawOrbitEllipse(
  orbit: OrbitElements,
  ctx: RenderContext,
  color?: string,
  width?: number,
  isDashed?: boolean
): void
```
Draw elliptical transfer orbit.

```typescript
function drawBody(
  body: Body,
  ctx: RenderContext,
  isSelected?: boolean,
  isHovered?: boolean
): void
```
Draw a body (circle) with label and selection indicators.

```typescript
function drawShip(
  ship: Ship,
  ctx: RenderContext,
  isSelected?: boolean
): void
```
Draw a ship on its orbit.

```typescript
function drawResourcePanel(
  body: Body,
  canvasX: number,
  canvasY: number,
  ctx: RenderContext
): void
```
Draw a resource readout panel at canvas position.

```typescript
function drawText(
  text: string,
  canvasX: number,
  canvasY: number,
  ctx: RenderContext,
  color?: string,
  fontSize?: number,
  align?: CanvasTextAlign
): void
```
Draw text on canvas.

---

## Color Module (`colors.ts`)

Color constants and utilities.

### Colors

```typescript
export const COLORS = {
  // Background
  bg: '#0a0e14',
  bgGrid: '#14202c',
  fg: '#d8e4ee',
  
  // Orbits
  orbitTrajectory: '#2d4255',      // Light blue
  orbitCurrent: '#4ecdc4',          // Cyan
  
  // Maneuvers
  maneuverPlanned: '#ffb84d',       // Amber dashed
  maneuverCommitted: '#ffb84d',     // Amber solid
  captureLabel: '#6ee7b7',          // Green
  escapeLabel: '#ff5e5e',           // Red
  
  // Factions
  playerFriendly: '#ff4444',        // Red
  enemyHostile: '#888888',          // Gray
};
```

### Utilities

```typescript
function withOpacity(hexColor: string, opacity: number): string
```
Convert hex color to rgba with opacity (0-1).

```typescript
const transparent = withOpacity('#4ecdc4', 0.5);
// Returns: 'rgba(78, 205, 196, 0.5)'
```

```typescript
function lighten(hexColor: string, factor?: number): string
```
Brighten a hex color. Default factor: 1.2

```typescript
function darken(hexColor: string, factor?: number): string
```
Darken a hex color. Default factor: 0.8

---

## Type Definitions (`types.ts`)

Core TypeScript interfaces.

### Body

```typescript
interface Body {
  id: string;
  name: string;
  type: 'star' | 'terrestrial' | 'gas_giant' | 'moon' | 'asteroid' | 'lagrange';
  parent?: string;                    // Parent body ID
  orbitRadius: number;                // Semi-major axis around parent
  orbitPeriod: number;                // Orbital period in ticks
  angle0: number;                     // Initial angle on orbit
  radius: number;                     // Visual radius for rendering
  soi: number;                        // Sphere of influence
  color: string;                      // Hex color
  resources?: {
    metal: number;
    fuel: number;
    gold: number;
    science: number;
  };
  ownedBy?: string;                   // Faction ID
}
```

### Ship

```typescript
interface Ship {
  id: string;
  name: string;
  class: 'frigate' | 'cruiser' | 'capital' | 'stealth_runner';
  ownedBy: string;                    // Faction ID
  fuel: number;
  orbit: OrbitElements;
  orders: ManeuverNode[];
  isSelected?: boolean;
  color?: string;                     // Override faction color
}
```

### OrbitElements

```typescript
interface OrbitElements {
  rp: number;              // Periapsis radius
  ra: number;              // Apoapsis radius
  omega: number;           // Argument of periapsis
  M0: number;              // Mean anomaly at epoch
  epoch: number;           // Reference time
  direction: 1 | -1;       // Prograde (+1) or retrograde (-1)
  period: number;          // Orbital period (Kepler's 3rd law)
  parentBodyId: string;
}
```

### ManeuverNode

```typescript
interface ManeuverNode {
  id: string;
  shipId: string;
  type: 'transfer' | 'orbital_change' | 'manual_burn';
  burnTime: number;                   // Tick when burn occurs
  deltav: number;                     // Total delta-v
  prograde: number;                   // Prograde component
  radial: number;                     // Radial component
  normal: number;                     // Normal component
  status: 'planned' | 'committed' | 'executed';
  preOrbit?: OrbitElements;
  postOrbit?: OrbitElements;
  capturedAtBody?: string;
  escapesBody?: boolean;
}
```

---

## Component Props

### MapCanvas

```typescript
interface MapCanvasProps {
  width?: number;     // Default: window.innerWidth
  height?: number;    // Default: window.innerHeight
}
```

```typescript
<MapCanvas width={1280} height={800} />
```

### ShipPanel

No props — uses `useGameContext()` internally.

```typescript
<ShipPanel />
```

### BodyInspector

No props — uses `useGameContext()` internally.

```typescript
<BodyInspector />
```

### ScenarioSelector

No props — uses `useGameContext()` internally.

```typescript
<ScenarioSelector />
```

---

## Mock Game State (`mockGameState.ts`)

### Scenario Functions

```typescript
export function createScenario1(): GameState
export function createScenario2(): GameState
export function createScenario3(): GameState

export function getScenario(type: ScenarioType): GameState
```

Load a scenario by number (1, 2, or 3).

### Helper Functions

```typescript
function circularOrbitAround(
  bodyId: string,
  altitude: number,
  direction?: 1 | -1
): OrbitElements
```
Create a circular orbit at a given altitude above a body.

### Constants

```typescript
export const SHARED_BODIES: Body[]
export const SHARED_FACTIONS: Faction[]
export const SCENARIO_DESCRIPTIONS: Record<1|2|3, string>
```

---

## Events & Callbacks

### Canvas Events (MapCanvas)

- **onClick**: Select ship or body at click position
- **onMouseMove**: Pan camera (right-drag), hover body
- **onMouseDown**: Start pan (right-click)
- **onMouseUp**: End pan
- **onWheel**: Zoom camera (scroll wheel)
- **onContextMenu**: Prevent default right-click menu

### Context Actions

All context actions are fire-and-forget (no return values). They update state synchronously.

---

## Common Usage Patterns

### Loading a Scenario

```typescript
const { loadScenario } = useGameContext();

// Load scenario 3
loadScenario(3);
```

### Getting Selected Ship

```typescript
const { gameState, uiState } = useGameContext();

const selectedShip = gameState.ships.find(
  s => s.id === uiState.selectedShipId
);
```

### Adding a Maneuver

```typescript
const { addManeuverNode } = useGameContext();

const node: ManeuverNode = {
  id: 'node-' + Date.now(),
  shipId: 'ship-alpha',
  type: 'transfer',
  burnTime: 50,
  deltav: 2.5,
  prograde: 2.3,
  radial: 0.6,
  normal: 0.2,
  status: 'planned',
};

addManeuverNode(node);
```

### Updating Camera

```typescript
const { updateCamera } = useGameContext();

// Pan
updateCamera({ x: newX, y: newY });

// Zoom
updateCamera({ scale: 2.0 });

// Both
updateCamera({ x: 0, y: 0, scale: 1.5 });
```

### Computing Orbit Position

```typescript
import { orbitWorldPos, localPositionAt } from '@/physics';

const ship = gameState.ships[0];
const worldPos = orbitWorldPos(ship.orbit, gameState.currentTick, gameState.bodies);
const localPos = localPositionAt(ship.orbit, gameState.currentTick);

console.log('Ship at world:', worldPos);
console.log('Ship local position:', localPos);
```

---

## Error Handling

The frontend is defensive but assumes valid input. Common error scenarios:

### Invalid Body ID

```typescript
const body = gameState.bodies.find(b => b.id === 'invalid');
if (!body) {
  console.warn('Body not found');
  // Handle gracefully
}
```

### Invalid Ship ID

```typescript
const ship = gameState.ships.find(s => s.id === 'invalid');
if (!ship) {
  // Ship doesn't exist — deselect
  deselectShip();
}
```

### Canvas Context Null

```typescript
if (!canvasRef.current) return;
const ctx = canvasRef.current.getContext('2d');
if (!ctx) return;
```

---

## Performance Notes

- **Physics calculations**: O(1) — constant time lookup
- **SOI checks**: O(n) where n = number of bodies
- **Canvas rendering**: O(n) where n = bodies + ships + orbits
- **Rendering one frame**: <5ms typical, <16ms budget (60 FPS)

---

**End of API Reference**
