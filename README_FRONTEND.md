# Orbital Frontend - React + Canvas Prototype

A React + TypeScript frontend for the Orbital space game. This prototype implements the map UI, ship control panel, and maneuver visualization using patched conics orbital mechanics.

## Overview

This is a **visual prototype** with mock game state — not yet integrated with a backend. It demonstrates:

- **System Map (Zoom Level 1)**: Full solar system with all 5 bodies and orbital paths
- **Planetary Close-up (Zoom Level 2)**: Individual planet with orbital rings and ships
- **Body Inspector (Zoom Level 3)**: Resource readout panel
- **Ship Panel**: Current ship info, maneuver controls, and commit/execute lifecycle
- **Maneuver Preview**: Visual prediction of transfer orbits with capture/escape labels

## Quick Start

### Prerequisites

- Node.js 16+ and npm
- A text editor or IDE

### Installation

```bash
npm install
npm start
```

The app will open at `http://localhost:3000`.

### Build for Production

```bash
npm run build
```

## Project Structure

```
src/
├── components/              # React UI components
│   ├── MapCanvas.tsx        # Main orbital system visualization (Canvas)
│   ├── MapCanvas.css
│   ├── ShipPanel.tsx        # Ship info and maneuver controls
│   ├── ShipPanel.css
│   ├── BodyInspector.tsx    # Resource readout
│   ├── BodyInspector.css
│   ├── ScenarioSelector.tsx # Demo scenario picker
│   └── ScenarioSelector.css
├── state/                   # Game state management
│   ├── gameContext.tsx      # React Context for global state
│   ├── mockGameState.ts     # Three demo scenarios
│   └── types.ts             # TypeScript type definitions
├── physics/                 # Orbital mechanics
│   └── orbitalMechanics.ts  # Kepler solver, vis-viva, orbit math
├── render/                  # Canvas rendering utilities
│   ├── mapRenderer.ts       # Drawing functions (bodies, orbits, ships)
│   └── colors.ts            # Color constants and utilities
├── App.tsx                  # Top-level component
├── App.css
├── index.tsx                # React entry point
└── types.ts                 # Shared type definitions
public/
└── index.html               # HTML root
package.json
tsconfig.json
```

## Features

### Scenario Selector (Top Right)

Switch between three pre-built scenarios:

1. **Scenario 1**: Two ships at Inara (player-owned)
   - Demonstrates basic positioning on orbital rings
   - Shows friendly faction coloring

2. **Scenario 2**: Player at Inara, Enemy at Verda
   - Multiple bodies with ships at different locations
   - Faction color differentiation

3. **Scenario 3**: Ship in Transit with Planned Burns
   - Hohmann-style transfer to Verda
   - Shows maneuver nodes (planned + committed)
   - Demonstrates transfer orbit visualization

### Map Controls

- **Scroll**: Zoom in/out
- **Right-drag**: Pan the view
- **Left-click bodies**: Select and inspect
- **Left-click ships**: Select and open ship panel

### Ship Panel (Bottom Left)

When a ship is selected:

- Ship name, class, fuel, and current location
- List of maneuver nodes with status (planned/committed/executed)
- **TRANSFER MANEUVER** button: Plan Hohmann transfer (UI only for now)
- **ORBITAL MANEUVER** button: Raise/lower orbit (UI only for now)
- **COMMIT** button per node: Mark as ready to execute
- **Advanced Manual Steps**: Collapsible section for manual burn entry

### Body Inspector (Bottom Right)

When a body is selected:

- Resource readout: Fuel, Gold, Metal, Science (per-tick production)
- Body type, parent, orbit parameters, and SOI size

## Core Physics

The physics module (`src/physics/orbitalMechanics.ts`) implements:

### Kepler's Equation Solver

```typescript
solveKepler(M: number, e: number): number
```

Solves M = E - e·sin(E) using Newton-Raphson iteration, converts eccentric anomaly (E) to true anomaly (θ).

### Orbital Position & Velocity

```typescript
localPositionAt(orbit: OrbitElements, t: number): LocalPosition
velocityVectorsAt(orbit: OrbitElements, t: number): VelocityVectors
```

Gets position and velocity components (prograde, radial) at a given time along an orbit.

### Vis-Viva Equation

```typescript
visVivaSpeed(mu: number, r: number, a: number): number
semiMajorFromVisViva(mu: number, r: number, vMag: number): number
```

Computes orbital velocity at radius r, or semi-major axis from velocity.

### Sphere of Influence (SOI)

```typescript
isInsideSOI(worldX: number, worldY: number, body: Body, t: number): boolean
whichSOI(worldX: number, worldY: number, t: number): Body
```

Determines which body's SOI contains a position (for patched conics transitions).

### Orbital Elements

All orbits are stored as Kepler elements:

```typescript
interface OrbitElements {
  rp: number;        // periapsis radius
  ra: number;        // apoapsis radius
  omega: number;     // argument of periapsis
  M0: number;        // mean anomaly at epoch
  epoch: number;     // reference time
  direction: 1 | -1; // prograde (+1) or retrograde (-1)
  period: number;    // orbital period (Kepler's 3rd law)
  parentBodyId: string;
}
```

## Mock Game State

### Creating a New Scenario

Edit `src/state/mockGameState.ts`:

```typescript
export function createScenario4(): GameState {
  const bodies = SHARED_BODIES.map(b => ({ ...b }));
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  const ship: Ship = {
    id: 'ship-4',
    name: 'NewShip',
    class: 'frigate',
    ownedBy: 'player',
    fuel: 100,
    orbit: circularOrbitAround('rust', 20, 1),
    orders: [],
  };

  return {
    currentTick: 0,
    bodies,
    ships: [ship],
    factions,
    orders: [],
  };
}
```

Then add to scenario selector:

```typescript
export const SCENARIO_DESCRIPTIONS = {
  1: 'Scenario 1...',
  2: 'Scenario 2...',
  3: 'Scenario 3...',
  4: 'Scenario 4...',
} as const;
```

### Adding New Bodies

Edit the `SHARED_BODIES` array in `mockGameState.ts`:

```typescript
{
  id: 'kepler',
  name: 'Kepler',
  type: 'terrestrial',
  parent: 'sol',
  radius: 5,
  soi: 35,
  color: '#7fb3d5',
  orbitRadius: 180,
  orbitPeriod: 120,
  angle0: 2.1,
  resources: { fuel: 3, gold: 1, metal: 4, science: 2 },
}
```

### Adding New Ships

Create a ship object:

```typescript
const ship: Ship = {
  id: 'ship-explorer',
  name: 'Explorer',
  class: 'cruiser',
  ownedBy: 'player',
  fuel: 150,
  orbit: circularOrbitAround('verda', 18, 1),
  orders: [],
};
```

Add to the `ships` array in a scenario function.

## Extending Components

### Creating a New Panel

```typescript
import React from 'react';
import { useGameContext } from '../state/gameContext';
import './MyPanel.css';

export const MyPanel: React.FC = () => {
  const { gameState, uiState } = useGameContext();

  return (
    <div className="my-panel">
      <div className="panel-header">MY PANEL</div>
      <div className="panel-body">
        {/* Content here */}
      </div>
    </div>
  );
};
```

Styling patterns (see `ShipPanel.css` for reference):

```css
.my-panel {
  position: fixed;
  /* ... */
  background: rgba(10, 14, 20, 0.96);
  border: 1px solid #2a3d50;
  color: #d8e4ee;
  font-family: 'JetBrains Mono', monospace;
}
```

### Adding Rendering to the Canvas

Edit `src/render/mapRenderer.ts`:

```typescript
export function drawNewFeature(
  context: RenderContext,
  /* params */
) {
  const canvasPos = worldToCanvas(worldX, worldY, context);
  context.ctx.fillStyle = COLORS.accent;
  context.ctx.fillRect(canvasPos.x, canvasPos.y, 10, 10);
}
```

Call from `MapCanvas.tsx` render function:

```typescript
drawNewFeature(renderContext, /* args */);
```

## Color System

All colors are defined in `src/render/colors.ts`:

```typescript
export const COLORS = {
  // Background
  bg: '#0a0e14',
  bgGrid: '#14202c',
  
  // Orbits
  orbitTrajectory: '#2d4255',      // light blue
  orbitCurrent: '#4ecdc4',          // cyan
  
  // Maneuvers
  maneuverPlanned: '#ffb84d',       // amber dashed
  maneuverCommitted: '#ffb84d',     // amber solid
  captureLabel: '#6ee7b7',          // green
  escapeLabel: '#ff5e5e',           // red
  
  // ...
};
```

Use the helper functions:

```typescript
import { withOpacity, lighten, darken } from '../render/colors';

const transparentColor = withOpacity(COLORS.orbitCurrent, 0.5);
const brightColor = lighten(COLORS.accent);
const darkColor = darken(COLORS.accent);
```

## Type Definitions

Core types are in `src/types.ts`:

- **Body**: Celestial body (star, planet, moon, etc.)
- **Ship**: Spaceship with orbit and orders
- **OrbitElements**: Kepler orbital elements
- **ManeuverNode**: Planned/committed burn
- **Faction**: Player/enemy/ally group
- **GameState**: Complete game snapshot

## Game Context API

Access global state with `useGameContext()`:

```typescript
const {
  gameState,        // Current game state
  camera,           // Viewport { x, y, scale, zoomLevel }
  uiState,          // UI state { selectedShipId, ... }
  
  // Updates
  updateTick,
  loadScenario,
  updateCamera,
  selectShip,
  selectBody,
  hoverBody,
  
  // Maneuvers
  addManeuverNode,
  commitManeuverNode,
  deleteManeuverNode,
} = useGameContext();
```

## Known Limitations & TODOs

### Not Yet Implemented

- **Maneuver Planning**: TRANSFER/ORBITAL buttons don't compute burns yet
- **Trajectory Projection**: SOI transitions and multi-arc trajectories
- **Hohmann Transfer Computation**: Auto-planner for transfers
- **Orbital Changes**: Circularization, eccentricity adjustments
- **Time Control**: Play/pause/4x/16x time speed
- **Animation**: Ships move on ticks, not smoothly animated
- **Moons**: Data structure ready, but not rendered
- **Asteroid Belts**: Not modeled
- **Combat**: Not implemented
- **Diplomacy**: No treaty/alliance UI

### Next Steps (Future Work)

1. **Connect Maneuver Planning**
   - Implement Hohmann transfer solver
   - Call `addManeuverNode()` with computed burns
   - Show predicted trajectory with `drawOrbitEllipse()`

2. **Add Trajectory Projection**
   - Implement `computeTrajectory()` (multi-arc following SOI)
   - Draw full path on map
   - Highlight SOI crossing events

3. **Tick Simulation**
   - Add game loop that increments `currentTick`
   - Update ship positions each tick
   - Execute committed maneuvers at burn time

4. **Time Controls**
   - Implement play/pause toggle
   - Add speed selector (1x, 4x, 16x)
   - Show time warp indicator

5. **Backend Integration**
   - Replace mock state with API calls
   - Send maneuver commits to server
   - Sync game state each tick

## Architecture Notes

### Separation of Concerns

- **Components**: React UI (ShipPanel, MapCanvas, etc.)
- **State**: Game logic and data (GameContext, mockGameState)
- **Physics**: Orbital math (orbitalMechanics.ts)
- **Render**: Canvas drawing (mapRenderer.ts)

This makes it easy to swap in a real backend or replace the Canvas with WebGL without touching game logic.

### Coordinate Systems

- **World coordinates**: Game units (1 unit ≈ 1000 km)
- **Canvas coordinates**: Screen pixels
- **Local coordinates**: Relative to orbit parent body
- **Orbit elements**: Kepler elements (rp, ra, omega, etc.)

All transformations are in `mapRenderer.ts`:

```typescript
worldToCanvas(worldX, worldY, ctx)  // world → screen
canvasToWorld(canvasX, canvasY, ctx) // screen → world
```

### State Flow

```
GameContextProvider (gameContext.tsx)
  ├── gameState (GameState)
  ├── camera (CameraState)
  └── uiState (MapUIState)
    └── useGameContext() ← Available to all components
      ├── MapCanvas.tsx
      ├── ShipPanel.tsx
      ├── BodyInspector.tsx
      └── ScenarioSelector.tsx
```

## Performance Considerations

- **Canvas rendering**: O(bodies + ships + orbits) per frame
- **Physics**: O(1) for orbital position at time t (Kepler solver ~20 iterations)
- **SOI checks**: O(bodies) per trajectory step
- **No virtual lists**: Assumes <100 bodies/ships

For larger numbers, consider:
- Quadtree for spatial queries
- WebGL for rendering
- Worker thread for trajectory computation

## Testing

### Manual Testing Checklist

- [ ] Scenario selector switches scenarios correctly
- [ ] Map pans with right-drag
- [ ] Map zooms with scroll wheel
- [ ] Clicking bodies selects and shows BodyInspector
- [ ] Clicking ships selects and shows ShipPanel
- [ ] Resource values display correctly
- [ ] Maneuver list shows in ShipPanel
- [ ] Commit buttons change status from planned → committed
- [ ] Delete buttons remove maneuvers
- [ ] Panel close buttons (✕) deselect

### Browser Compatibility

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## License

Part of the Orbital game project.

## Contact

For questions or issues, contact the Orbital development team.
