// ============================================================
// Mock Game State - Real Solar System (23 bodies)
// Ported from HTML prototype (trusting-mahavira branch)
// ============================================================

import { Body, Ship, Faction, GameState, OrbitElements, FactionResources, Settlement } from '../types';
import { createStation } from '../game/settlements';

const TWO_PI = 2 * Math.PI;

// MU_SOL derived from Jupiter's orbit: 4π²·460³/800²
const MU_SOL = 4 * Math.PI * Math.PI * Math.pow(460, 3) / Math.pow(800, 2);

// Full solar system — 23 bodies matching the HTML prototype
export const SHARED_BODIES: Body[] = [
  // Star
  {
    id: 'sol', name: 'Sol', type: 'star',
    radius: 10, soi: Infinity, mu: 0,
    color: '#ffd180', orbitRadius: 0, orbitPeriod: 0, angle0: 0,
  },
  // Terrestrial planets
  // Inner system scaled up ~1.4× on orbit radius and ~1.8× on SOI so
  // ships orbiting at low altitude don't visually overlap with moons.
  // Periods follow Kepler's 3rd law (T ∝ a^1.5).
  {
    id: 'mercury', name: 'Mercury', type: 'terrestrial', parent: 'sol',
    radius: 2, soi: 22, mu: 50, color: '#8c8680',
    orbitRadius: 72, orbitPeriod: 49, angle0: 4.40,
    resources: { fuel: 0, gold: 2, metal: 5, science: 1 },
  },
  {
    id: 'venus', name: 'Venus', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 43, mu: 150, color: '#e8cda0',
    orbitRadius: 134, orbitPeriod: 126, angle0: 3.18,
    resources: { fuel: 1, gold: 1, metal: 3, science: 4 },
  },
  {
    id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 54, mu: 100, color: '#4a90d9',
    orbitRadius: 186, orbitPeriod: 205, angle0: 1.75,
    resources: { fuel: 3, gold: 2, metal: 3, science: 5 },
  },
  {
    id: 'mars', name: 'Mars', type: 'terrestrial', parent: 'sol',
    radius: 2.5, soi: 43, mu: 80, color: '#c1440e',
    orbitRadius: 283, orbitPeriod: 386, angle0: 6.20,
    resources: { fuel: 1, gold: 1, metal: 6, science: 3 },
  },
  // Earth's moon — orbit pushed out so Luna doesn't kiss the Earth's
  // ship-orbit envelope at low altitude.
  {
    id: 'luna', name: 'Luna', type: 'moon', parent: 'earth',
    radius: 1.5, soi: 8, mu: 5, color: '#c0c0c0',
    orbitRadius: 20, orbitPeriod: TWO_PI * Math.sqrt(8000 / 100), angle0: 0,
    resources: { fuel: 0, gold: 0, metal: 2, science: 2 },
  },
  // Asteroid belt — five bodies share the 310-radius orbit, spaced 72°
  // apart so the belt feels populated and ships can resource-hop between
  // them without leaving the ring.
  {
    id: 'ceres', name: 'Ceres', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 0.5, color: '#6b6b6b',
    orbitRadius: 310, orbitPeriod: 443, angle0: 1.20,
    resources: { fuel: 1, gold: 3, metal: 5, science: 1 },
  },
  {
    id: 'vesta', name: 'Vesta', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.3, color: '#a89888',
    orbitRadius: 310, orbitPeriod: 443, angle0: 2.46,
    resources: { fuel: 0, gold: 2, metal: 6, science: 1 },
  },
  {
    id: 'pallas', name: 'Pallas', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.25, color: '#80706a',
    orbitRadius: 310, orbitPeriod: 443, angle0: 3.71,
    resources: { fuel: 0, gold: 1, metal: 5, science: 2 },
  },
  {
    id: 'hygiea', name: 'Hygiea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2, color: '#75655a',
    orbitRadius: 310, orbitPeriod: 443, angle0: 4.97,
    resources: { fuel: 1, gold: 1, metal: 5, science: 1 },
  },
  {
    id: 'juno', name: 'Juno', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2, color: '#aa9070',
    orbitRadius: 310, orbitPeriod: 443, angle0: 6.23,
    resources: { fuel: 0, gold: 3, metal: 4, science: 1 },
  },
  // Gas giants
  {
    id: 'jupiter', name: 'Jupiter', type: 'gas_giant', parent: 'sol',
    radius: 8, soi: 160, mu: 1000, color: '#d4a574',
    orbitRadius: 460.0, orbitPeriod: 800.0, angle0: 0.60,
    resources: { fuel: 6, gold: 1, metal: 1, science: 2 },
  },
  {
    id: 'saturn', name: 'Saturn', type: 'gas_giant', parent: 'sol',
    radius: 7, soi: 140, mu: 600, color: '#e8d5a3',
    orbitRadius: 843.2, orbitPeriod: 1987, angle0: 0.87,
    resources: { fuel: 5, gold: 2, metal: 1, science: 3 },
  },
  // Jupiter's Galilean moons
  {
    id: 'io', name: 'Io', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5, color: '#e8d44d',
    orbitRadius: 22, orbitPeriod: TWO_PI * Math.sqrt(10648 / 1000), angle0: 0,
    resources: { fuel: 2, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5, color: '#b8c8d8',
    orbitRadius: 34, orbitPeriod: TWO_PI * Math.sqrt(39304 / 1000), angle0: 1.57,
    resources: { fuel: 1, gold: 0, metal: 1, science: 6 },
  },
  {
    id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 8, color: '#8a7e72',
    orbitRadius: 50, orbitPeriod: TWO_PI * Math.sqrt(125000 / 1000), angle0: 3.14,
    resources: { fuel: 1, gold: 2, metal: 4, science: 3 },
  },
  {
    id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 6, color: '#5a5a5a',
    orbitRadius: 75, orbitPeriod: TWO_PI * Math.sqrt(421875 / 1000), angle0: 4.71,
    resources: { fuel: 0, gold: 3, metal: 3, science: 2 },
  },
  // Saturn's moons
  {
    id: 'enceladus', name: 'Enceladus', type: 'moon', parent: 'saturn',
    radius: 1, soi: 3, mu: 2, color: '#f0f0f0',
    orbitRadius: 20, orbitPeriod: TWO_PI * Math.sqrt(8000 / 600), angle0: 0,
    resources: { fuel: 3, gold: 0, metal: 1, science: 6 },
  },
  {
    id: 'rhea', name: 'Rhea', type: 'moon', parent: 'saturn',
    radius: 1.5, soi: 4, mu: 4, color: '#a0a0a0',
    orbitRadius: 37, orbitPeriod: TWO_PI * Math.sqrt(50653 / 600), angle0: 2.09,
    resources: { fuel: 1, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn',
    radius: 2, soi: 7, mu: 10, color: '#cc9944',
    orbitRadius: 65, orbitPeriod: TWO_PI * Math.sqrt(274625 / 600), angle0: 4.19,
    resources: { fuel: 5, gold: 1, metal: 2, science: 5 },
  },
  // Outer system compressed: Uranus/Neptune brought ~35-45% closer in
  // so a 200-tick match can actually reach them. Periods recomputed
  // per Kepler.
  {
    id: 'uranus', name: 'Uranus', type: 'ice_giant', parent: 'sol',
    radius: 5, soi: 110, mu: 200, color: '#73c2d6',
    orbitRadius: 1100, orbitPeriod: 2960, angle0: 5.47,
    resources: { fuel: 4, gold: 1, metal: 2, science: 4 },
  },
  {
    id: 'neptune', name: 'Neptune', type: 'ice_giant', parent: 'sol',
    radius: 5, soi: 120, mu: 250, color: '#3366cc',
    orbitRadius: 1500, orbitPeriod: 4710, angle0: 5.32,
    resources: { fuel: 4, gold: 2, metal: 1, science: 5 },
  },
  // Uranus moons — five-moon system (Miranda inner, Oberon outer).
  {
    id: 'miranda', name: 'Miranda', type: 'moon', parent: 'uranus',
    radius: 1, soi: 3, mu: 1.5, color: '#a8a8a8',
    orbitRadius: 12, orbitPeriod: TWO_PI * Math.sqrt(1728 / 200), angle0: 0.78,
    resources: { fuel: 0, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'ariel', name: 'Ariel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 2.5, color: '#b0a898',
    orbitRadius: 18, orbitPeriod: TWO_PI * Math.sqrt(5832 / 200), angle0: 2.10,
    resources: { fuel: 0, gold: 2, metal: 3, science: 2 },
  },
  {
    id: 'umbriel', name: 'Umbriel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 3, color: '#6a655e',
    orbitRadius: 26, orbitPeriod: TWO_PI * Math.sqrt(17576 / 200), angle0: 4.60,
    resources: { fuel: 0, gold: 1, metal: 4, science: 1 },
  },
  {
    id: 'titania', name: 'Titania', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4, color: '#909090',
    orbitRadius: 35, orbitPeriod: TWO_PI * Math.sqrt(42875 / 200), angle0: 0,
    resources: { fuel: 0, gold: 2, metal: 4, science: 2 },
  },
  {
    id: 'oberon', name: 'Oberon', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4, color: '#888070',
    orbitRadius: 50, orbitPeriod: TWO_PI * Math.sqrt(125000 / 200), angle0: 3.14,
    resources: { fuel: 0, gold: 3, metal: 3, science: 2 },
  },
  // Neptune moons — Proteus inner, Triton mid, Nereid outer.
  {
    id: 'proteus', name: 'Proteus', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 3, color: '#7a7a7a',
    orbitRadius: 28, orbitPeriod: TWO_PI * Math.sqrt(21952 / 250), angle0: 1.20,
    resources: { fuel: 1, gold: 1, metal: 3, science: 2 },
  },
  {
    id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune',
    radius: 1.5, soi: 5, mu: 5, color: '#b8d0e0',
    orbitRadius: 45, orbitPeriod: TWO_PI * Math.sqrt(91125 / 250), angle0: 0,
    resources: { fuel: 2, gold: 1, metal: 2, science: 5 },
  },
  {
    id: 'nereid', name: 'Nereid', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 2, color: '#aab8c4',
    orbitRadius: 78, orbitPeriod: TWO_PI * Math.sqrt(474552 / 250), angle0: 3.95,
    resources: { fuel: 1, gold: 2, metal: 2, science: 3 },
  },
  // Outer dwarf planets — compressed proportionally with Uranus/Neptune
  // so the trans-Neptunian neighborhood is still distinct but reachable.
  // Kuiper belt is metal-rich late-game territory.
  {
    id: 'pluto', name: 'Pluto', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 12, mu: 2, color: '#c8b898',
    orbitRadius: 1900, orbitPeriod: 6720, angle0: 4.17,
    resources: { fuel: 0, gold: 4, metal: 2, science: 3 },
  },
  {
    id: 'charon', name: 'Charon', type: 'moon', parent: 'pluto',
    radius: 1, soi: 3, mu: 1, color: '#9a8c7c',
    orbitRadius: 6, orbitPeriod: TWO_PI * Math.sqrt(216 / 2), angle0: 0,
    resources: { fuel: 0, gold: 1, metal: 6, science: 2 },
  },
  {
    id: 'haumea', name: 'Haumea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8, color: '#d8d0c0',
    orbitRadius: 2050, orbitPeriod: 7520, angle0: 0.95,
    resources: { fuel: 0, gold: 2, metal: 6, science: 2 },
  },
  {
    id: 'makemake', name: 'Makemake', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8, color: '#c89868',
    orbitRadius: 2200, orbitPeriod: 8360, angle0: 3.30,
    resources: { fuel: 0, gold: 3, metal: 5, science: 2 },
  },
  {
    id: 'quaoar', name: 'Quaoar', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.6, color: '#a09080',
    orbitRadius: 2100, orbitPeriod: 7800, angle0: 5.10,
    resources: { fuel: 0, gold: 2, metal: 6, science: 1 },
  },
  {
    id: 'eris', name: 'Eris', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 1, color: '#e0e0e0',
    orbitRadius: 2400, orbitPeriod: 9560, angle0: 1.80,
    resources: { fuel: 0, gold: 5, metal: 1, science: 4 },
  },
  {
    id: 'sedna', name: 'Sedna', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 8, mu: 0.7, color: '#b06040',
    orbitRadius: 3500, orbitPeriod: 16800, angle0: 2.55,
    resources: { fuel: 0, gold: 3, metal: 7, science: 3 },
  },
];

// Shared factions
export const SHARED_FACTIONS: Faction[] = [
  { id: 'player', name: 'Player', color: '#4ecdc4', isPlayer: true },
  // Enemy is AI-driven in single-player scenarios. Run by src/game/factionAI.ts.
  { id: 'enemy', name: 'Enemy', color: '#ff5e5e', isPlayer: false, isAI: true },
];

// Helper to create a basic circular orbit at a given body
function circularOrbitAround(
  bodyId: string,
  altitude: number,
  direction: 1 | -1 = 1
): OrbitElements {
  const body = SHARED_BODIES.find(b => b.id === bodyId);
  if (!body) throw new Error(`Body ${bodyId} not found`);

  const r = body.radius + altitude;
  let mu: number;
  if (bodyId === 'sol') {
    mu = MU_SOL;
  } else if (body.mu != null && body.mu > 0) {
    mu = body.mu;
  } else {
    mu = 100;
  }

  const period = TWO_PI * Math.sqrt((r * r * r) / mu);

  return {
    rp: r, ra: r, omega: 0, M0: 0, epoch: 0,
    direction, period, parentBodyId: bodyId,
  };
}

/**
 * DEFAULT_RESOURCES is a TEMPLATE — use freshResources() to get a deep copy
 * suitable for assignment into a new GameState. Don't spread DEFAULT_RESOURCES
 * directly: shallow-copying it shares the inner per-faction objects across
 * scenarios, so the first tick's mutation would leak into the template.
 */
const DEFAULT_RESOURCES: Record<string, FactionResources> = {
  player: { fuel: 100, ore: 200, credits: 150, science: 50 },
  enemy: { fuel: 100, ore: 200, credits: 150, science: 50 },
};

function freshResources(): Record<string, FactionResources> {
  return {
    player: { ...DEFAULT_RESOURCES.player },
    enemy: { ...DEFAULT_RESOURCES.enemy },
  };
}

function freshFactionTech(): GameState['factionTech'] {
  return {
    player: { levels: {}, researching: null, progress: 0 },
    enemy:  { levels: {}, researching: null, progress: 0 },
  };
}

function withOwnership(bodies: Body[]): Body[] {
  return bodies.map(b => {
    if (b.id === 'earth' || b.id === 'luna') return { ...b, ownedBy: 'player' };
    if (b.id === 'mars') return { ...b, ownedBy: 'enemy' };
    return { ...b };
  });
}

// ============================================================
// SCENARIO 1: Rocinante and Donnager at Earth
// ============================================================
export function createScenario1(): GameState {
  const bodies = withOwnership(SHARED_BODIES);
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  const ships: Ship[] = [
    {
      id: 'ship-roci', name: 'Rocinante', class: 'corvette',
      ownedBy: 'player', fuel: 80,
      orbit: circularOrbitAround('earth', 10, 1),
      orders: [],
    },
    {
      id: 'ship-donnager', name: 'Donnager', class: 'frigate',
      ownedBy: 'player', fuel: 120,
      orbit: { ...circularOrbitAround('earth', 15, 1), M0: Math.PI },
      orders: [],
    },
    {
      id: 'ship-canterbury', name: 'Canterbury', class: 'freighter',
      ownedBy: 'player', fuel: 100,
      orbit: { ...circularOrbitAround('earth', 18, 1), M0: Math.PI * 1.5 },
      orders: [],
    },
  ];

  return {
    currentTick: 0, bodies, ships, factions, orders: [],
    fleets: [], buildOrders: [], settlements: [],
    resources: freshResources(),
    combatLog: [], lastHarvestTick: 0,
    factionTech: freshFactionTech(),
  };
}

// ============================================================
// SCENARIO 2: Fleet combat — Player at Earth vs Enemy at Mars
// ============================================================
export function createScenario2(): GameState {
  const bodies = withOwnership(SHARED_BODIES);
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  const ships: Ship[] = [
    // Player fleet at Earth
    {
      id: 'ship-roci', name: 'Rocinante', class: 'corvette',
      ownedBy: 'player', fuel: 80,
      orbit: circularOrbitAround('earth', 10, 1),
      orders: [],
    },
    {
      id: 'ship-donnager', name: 'Donnager', class: 'destroyer',
      ownedBy: 'player', fuel: 150,
      orbit: { ...circularOrbitAround('earth', 14, 1), M0: Math.PI * 0.5 },
      orders: [],
    },
    {
      id: 'ship-canterbury', name: 'Canterbury', class: 'freighter',
      ownedBy: 'player', fuel: 100,
      orbit: { ...circularOrbitAround('earth', 18, 1), M0: Math.PI },
      orders: [],
    },
    // Enemy fleet at Mars — same shape as player so the AI has a real economy
    {
      id: 'ship-phantom', name: 'Phantom', class: 'corvette',
      ownedBy: 'enemy', fuel: 80,
      orbit: circularOrbitAround('mars', 10, -1),
      orders: [],
    },
    {
      id: 'ship-wraith', name: 'Wraith', class: 'frigate',
      ownedBy: 'enemy', fuel: 120,
      orbit: { ...circularOrbitAround('mars', 14, -1), M0: Math.PI },
      orders: [],
    },
    {
      id: 'ship-rove', name: 'Rove', class: 'freighter',
      ownedBy: 'enemy', fuel: 100,
      orbit: { ...circularOrbitAround('mars', 18, -1), M0: Math.PI * 0.5 },
      orders: [],
    },
  ];

  // Pre-deploy a station at each faction's capital so both can build ships
  // (the shipyard requires a station at the body) and the AI has an economic
  // toehold to start from.
  const earthBody = bodies.find(b => b.id === 'earth')!;
  const marsBody = bodies.find(b => b.id === 'mars')!;
  const settlements: Settlement[] = [
    createStation(earthBody, 'player', 0, bodies, 'Tycho Station'),
    createStation(marsBody, 'enemy', 0, bodies, 'Hellas Yards'),
  ];

  return {
    currentTick: 0, bodies, ships, factions, orders: [],
    fleets: [], buildOrders: [], settlements,
    resources: freshResources(),
    combatLog: [], lastHarvestTick: 0,
    factionTech: freshFactionTech(),
    aiActivityLog: [],
  };
}

// ============================================================
// SCENARIO 3: Trade route — Freighter at Earth, build corvette escort
// ============================================================
export function createScenario3(): GameState {
  const bodies = withOwnership(SHARED_BODIES);
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  const ships: Ship[] = [
    {
      id: 'ship-canterbury', name: 'Canterbury', class: 'freighter',
      ownedBy: 'player', fuel: 100,
      orbit: circularOrbitAround('earth', 12, 1),
      orders: [],
    },
    {
      id: 'ship-escort', name: 'Tachi', class: 'corvette',
      ownedBy: 'player', fuel: 80,
      orbit: { ...circularOrbitAround('earth', 14, 1), M0: Math.PI },
      orders: [],
    },
  ];

  return {
    currentTick: 0, bodies, ships, factions, orders: [],
    fleets: [], buildOrders: [], settlements: [],
    resources: { player: { fuel: 150, ore: 300, credits: 200, science: 75 }, enemy: { fuel: 100, ore: 200, credits: 150, science: 50 } },
    combatLog: [],
    lastHarvestTick: 0,
    factionTech: freshFactionTech(),
  };
}

// ============================================================
// SCENARIO 4: Jupiter system — Belter outpost
// ============================================================
export function createScenario4(): GameState {
  const bodies = SHARED_BODIES.map(b => {
    if (b.id === 'earth' || b.id === 'luna') return { ...b, ownedBy: 'player' };
    if (b.id === 'mars' || b.id === 'ceres') return { ...b, ownedBy: 'enemy' };
    if (b.id === 'ganymede') return { ...b, ownedBy: 'player' };
    return { ...b };
  });
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  const ships: Ship[] = [
    // Player ships at Ganymede
    {
      id: 'ship-roci', name: 'Rocinante', class: 'corvette',
      ownedBy: 'player', fuel: 80,
      orbit: circularOrbitAround('ganymede', 6, 1),
      orders: [],
    },
    {
      id: 'ship-somnambulist', name: 'Somnambulist', class: 'freighter',
      ownedBy: 'player', fuel: 100,
      orbit: { ...circularOrbitAround('ganymede', 8, 1), M0: Math.PI },
      orders: [],
    },
    // Enemy ships at Ceres
    {
      id: 'ship-behemoth', name: 'Behemoth', class: 'destroyer',
      ownedBy: 'enemy', fuel: 150,
      orbit: circularOrbitAround('ceres', 5, -1),
      orders: [],
    },
  ];

  return {
    currentTick: 0, bodies, ships, factions, orders: [],
    fleets: [], buildOrders: [], settlements: [],
    resources: { player: { fuel: 80, ore: 150, credits: 100, science: 50 }, enemy: { fuel: 120, ore: 250, credits: 200, science: 50 } },
    combatLog: [],
    lastHarvestTick: 0,
    factionTech: freshFactionTech(),
  };
}

// Export a scenario selector
export type ScenarioType = 1 | 2 | 3 | 4;

export function getScenario(type: ScenarioType): GameState {
  switch (type) {
    case 1: return createScenario1();
    case 2: return createScenario2();
    case 3: return createScenario3();
    case 4: return createScenario4();
    default: return createScenario1();
  }
}

export const SCENARIO_DESCRIPTIONS = {
  1: 'Rocinante and Donnager at Earth',
  2: 'Fleet combat — Player vs Enemy',
  3: 'Trade route — Freighter with escort',
  4: 'Jupiter system — Belter outpost',
} as const;
