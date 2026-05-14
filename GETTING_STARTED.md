# Getting Started - Orbital Frontend

## Prerequisites

- **Node.js** 16.0.0 or higher (check with `node --version`)
- **npm** 7.0.0 or higher (check with `npm --version`)
- A modern web browser (Chrome, Firefox, Safari, or Edge)

## Installation & Setup

### 1. Install Dependencies

```bash
npm install
```

This will install all required packages:
- React 18.2
- React DOM 18.2
- TypeScript 5.0
- React Scripts (webpack, Babel, etc.)

### 2. Start Development Server

```bash
npm start
```

The app will automatically open in your default browser at `http://localhost:3000`.

If it doesn't open automatically, navigate to that URL manually.

## First Run Checklist

Once the app loads, verify these features work:

### ✓ Visual Verification
- [ ] Dark background with light grid pattern visible
- [ ] Title "ORBITAL" in top-left corner
- [ ] Scenario selector in top-right corner
- [ ] 5 celestial bodies visible on the map (Sol center, Inara, Verda, Rust, Jove)
- [ ] Orbital paths shown as circles around Sol

### ✓ Interaction Verification
- [ ] Right-drag pans the map
- [ ] Scroll wheel zooms in/out
- [ ] Clicking a body opens resource panel (bottom-right)
- [ ] Clicking a ship opens ship panel (bottom-left)
- [ ] Clicking empty space closes panels

### ✓ Scenario Switching
- [ ] Click "Scenario #1" button → Two ships appear at Inara
- [ ] Click "Scenario #2" button → Ships at different bodies
- [ ] Click "Scenario #3" button → Ship with maneuver nodes visible

## Project Structure

Quick reference for navigating the codebase:

```
src/
├── components/           ← React UI components
├── state/               ← Game state & context
├── physics/             ← Orbital mechanics math
├── render/              ← Canvas drawing utilities
├── App.tsx              ← Root component
└── types.ts             ← TypeScript definitions

public/
└── index.html           ← HTML entry point
```

See `README_FRONTEND.md` for detailed file descriptions.

## Common Tasks

### Running the App

```bash
npm start        # Development mode (with hot reload)
npm run build    # Production build (optimized)
npm test         # Run tests (if added)
```

### Modifying Scenarios

Edit `src/state/mockGameState.ts`:

```typescript
// Add a new ship to Scenario 1
const ship3: Ship = {
  id: 'ship-gamma',
  name: 'Gamma',
  class: 'stealth_runner',
  ownedBy: 'player',
  fuel: 80,
  orbit: circularOrbitAround('inara', 20, -1),
  orders: [],
};
```

Save the file — the browser will hot-reload automatically.

### Adding a New Body

Edit the `SHARED_BODIES` array in `src/state/mockGameState.ts`:

```typescript
{
  id: 'kepler',
  name: 'Kepler',
  type: 'terrestrial',
  parent: 'sol',
  radius: 5,
  soi: 35,
  color: '#7fb3d5',
  orbitRadius: 175,      // Distance from Sol
  orbitPeriod: 140,      // Time to orbit Sol
  angle0: 2.5,           // Starting angle
  resources: { fuel: 3, gold: 1, metal: 4, science: 2 },
}
```

### Changing Ship Appearance

Ships inherit color from their faction. To customize:

1. In `src/state/mockGameState.ts`, add a `color` override to the ship:
   ```typescript
   const ship: Ship = {
     // ... other properties
     color: '#ff00ff', // Custom purple color
   };
   ```

2. Or modify faction colors in `SHARED_FACTIONS`:
   ```typescript
   {
     id: 'player',
     name: 'Player',
     color: '#00ff00', // Green instead of red
     isPlayer: true,
   }
   ```

## Development Tips

### Console Debugging

Open browser DevTools (F12) to see:
- React errors and warnings
- Network activity
- Canvas rendering performance

### Hot Module Replacement (HMR)

The app automatically reloads when you save files. No need to manually refresh!

Exception: Changes to `types.ts` might require a manual refresh.

### React DevTools

Install the React DevTools browser extension to inspect:
- Component tree
- Props and state
- Context values
- Performance profiling

### Performance Profiling

In the browser DevTools:
1. Open **Performance** tab
2. Click **Record**
3. Interact with the app
4. Click **Stop** and analyze

Look for:
- FPS stability (should stay near 60)
- Long rendering frames (should be <16ms)
- Memory usage (should stay constant)

## Troubleshooting

### Port 3000 Already in Use

If you get "Port 3000 is already in use":

**Option 1**: Kill the process on that port
```bash
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# macOS/Linux
lsof -i :3000
kill -9 <PID>
```

**Option 2**: Use a different port
```bash
PORT=3001 npm start
```

### Blank White Screen

1. Check browser console (F12) for errors
2. Try hard refresh (Ctrl+Shift+R or Cmd+Shift+R)
3. Clear browser cache and restart
4. Ensure Node.js and npm are up to date

### Canvas Not Rendering

If you see a blank canvas:
1. Open DevTools console
2. Check for errors mentioning "canvas" or "context"
3. Verify GPU acceleration is enabled in browser
4. Try a different browser

### Styles Look Wrong

1. Clear browser cache (DevTools → Network → Disable cache → Refresh)
2. Hard refresh the page (Ctrl+Shift+R)
3. Check that CSS files are in `src/components/`

## Next Steps

### 1. Explore the Code

- Open `src/components/MapCanvas.tsx` to see how rendering works
- Open `src/physics/orbitalMechanics.ts` to understand the orbital math
- Open `src/state/gameContext.tsx` to see state management

### 2. Read the Documentation

- `README_FRONTEND.md` — Comprehensive feature guide
- `IMPLEMENTATION_SUMMARY.md` — Architecture and design decisions

### 3. Experiment

- Modify scenario ships and bodies
- Change colors and styling
- Add console logs to trace execution
- Test edge cases (very zoomed in/out, rapid clicking, etc.)

### 4. Prepare for Backend Integration

When ready to connect a backend:

1. Replace mock state in `src/state/gameContext.tsx`
2. Add API calls for maneuver planning
3. Implement real-time state synchronization
4. See integration points in `README_FRONTEND.md`

## Testing Scenarios

### Scenario 1: Basic Positioning

Expected behavior:
- Two ships visible at Inara in low orbit
- Both ships should be at different positions on the orbital ring
- Resource panel shows Inara's resources when clicked

### Scenario 2: Faction Colors

Expected behavior:
- Player ship (red) at Inara
- Enemy ship (gray) at Verda
- Both bodies visible and selectable
- Resources differ per body

### Scenario 3: Maneuver Preview

Expected behavior:
- One ship visible in heliocentric transfer to Verda
- Ship panel shows 2 maneuver nodes
- First node marked as "committed" (amber solid)
- Second node marked as "planned" (amber dashed)
- Can click COMMIT on planned node to change status
- Can click ✕ to delete nodes

## Keyboard Shortcuts (Ready for Implementation)

These are defined in the legend but not yet functional. Coming soon:
- **F** — Focus on selected ship
- **Esc** — View full system (reset zoom/pan)

## Performance Expectations

- **First load**: ~2-3 seconds (including npm dependencies)
- **FPS**: Constant 60 on modern hardware
- **Memory**: 5-10 MB baseline
- **Canvas rendering**: <5ms per frame

If you see performance issues:
1. Check if DevTools is open (slows rendering)
2. Verify GPU acceleration is enabled
3. Check for browser extensions interfering
4. Try closing other browser tabs

## Getting Help

If you encounter issues:

1. **Check the console** (F12 → Console tab)
   - Most errors are logged with helpful messages

2. **Read the docs**
   - `README_FRONTEND.md` has extensive API documentation
   - `IMPLEMENTATION_SUMMARY.md` explains architecture

3. **Check source code**
   - Comments throughout explain complex logic
   - Function signatures include JSDoc

4. **Try a clean install**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   npm start
   ```

## Contact

For questions about:
- **Orbital mechanics**: See `src/physics/orbitalMechanics.ts` comments
- **React/UI patterns**: See component files and CSS
- **Architecture**: Read `IMPLEMENTATION_SUMMARY.md`
- **Gameplay**: See scenario definitions in `mockGameState.ts`

---

**You're all set! Start with `npm start` and enjoy exploring the Orbital prototype.** 🚀
