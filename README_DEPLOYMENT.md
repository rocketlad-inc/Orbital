# Orbital — Deployment & Getting Started

## Quick Start Guide

### Option 1: Run React Frontend (Recommended)

The primary UI is now a React application with Canvas-based rendering.

```bash
# Install dependencies
npm install --legacy-peer-deps

# Start development server
npm start

# Opens at http://localhost:3000
```

**What you'll see:**
- Interactive system map with all planets and ships
- Click ships to select them
- Use "TRANSFER MANEUVER" to plan burns to other planets
- Use "ORBITAL MANEUVER" to plan orbital changes
- See committed (solid amber) and planned (dashed amber) trajectories on the map
- Switch between 3 demo scenarios using the scenario selector

### Option 2: Run Legacy Prototype (Reference)

The original HTML prototype is still available:

```bash
# Open in browser
open index.html  # macOS
start index.html  # Windows
```

This is a working, complete reference implementation in vanilla JS. The React version is now the primary frontend.

---

## Backend Game Engine

### Initialize Database

```bash
sqlite3 orbital.db < schema.sql
```

This creates 17 tables for:
- Games and factions
- Bodies and ships
- Resources and production
- Maneuver orders and standing orders
- Treaties and reputation
- Tech research and proposals
- Chronicle entries and game log

### Run Game Engine

```bash
python game_engine.py
```

This starts the atomic tick execution loop with:
- Maneuver execution (burn orders)
- SOI transitions
- Standing orders processing
- Resource production
- Technology research
- Combat resolution
- Treaty enforcement
- Reputation decay
- Chronicle logging

### Run Tests

```bash
# Comprehensive engine tests
python test_engine_comprehensive.py

# Combat and treaty system tests
python test_combat_treaties.py
```

All tests are passing. Test coverage includes:
- Tick execution pipeline
- Maneuver computation
- Combat with orbital velocity modifiers
- Treaty violation detection
- Reputation system
- Resource production
- Tech research queuing

---

## Project Files

### Frontend
- `src/` — React components and logic
- `public/` — React HTML entry point
- `package.json` — npm dependencies
- `tsconfig.json` — TypeScript configuration

### Backend
- `game_engine/` — Python game engine modules
  - `tick.py` — 10-step atomic tick execution
  - `combat.py` — Combat resolution
  - `treaties.py` — Treaty enforcement
  - `reputation.py` — Reputation system
  - `maneuvers.py` — Burn execution
  - `resources.py` — Resource production
  - `tech.py` — Tech research
  - `standing_orders.py` — Recurring orders
  - `chronicle.py` — Event logging
- `database.py` — SQLite interface
- `schema.sql` — Database schema

### Tests
- `test_engine_comprehensive.py` — 50+ unit/integration tests
- `test_combat_treaties.py` — 34 combat and treaty tests
- `test_engine.py`, `test_game_engine.py` — Additional test suites

### Documentation
- `API_REFERENCE.md` — Complete API reference
- `ENGINE_DESIGN.md` — Architecture and design
- `INTEGRATION_GUIDE.md` — Backend/frontend integration
- `COMBAT_TREATY_SYSTEM.md` — Game mechanics
- `schema_documentation.md` — Database schema

---

## What Changed

### Frontend
✅ Complete React + TypeScript rebuild
✅ Canvas-based rendering (not web components)
✅ Real orbital mechanics integrated
✅ Trajectory visualization with commit/plan states
✅ Maneuver planning UI (Transfer & Orbital)
✅ 3 playable demo scenarios
✅ Interactive click detection and selection

### Backend
✅ Production-ready game engine (4,500+ lines)
✅ Atomic 10-step tick execution
✅ Combat system with orbital velocity mechanics
✅ Treaty system (7 types)
✅ Reputation system (8 tiers, decay mechanics)
✅ Resource production and tech research
✅ 100+ comprehensive tests
✅ SQLite database with 17 tables
✅ Resumable tick execution

---

## Next Steps

1. **Connect Frontend to Backend**: Implement API calls to game_engine.py
2. **Deploy Database**: Use persistent SQLite connection
3. **Real-Time Sync**: Stream tick updates via WebSocket
4. **Multi-Player**: Add faction/player management
5. **Alpha Testing**: Run with 6-8 players

See `INTEGRATION_GUIDE.md` for detailed implementation steps.
