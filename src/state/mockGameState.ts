// ============================================================
// Mock Game State - Three Demo Scenarios
// ============================================================

import { Body, Ship, Faction, GameState, OrbitElements } from '../types';

// Shared bodies across all scenarios
export const SHARED_BODIES: Body[] = [
  {
    id: 'sol',
    name: 'Sol',
    type: 'star',
    radius: 28,
    soi: Infinity,
    color: '#ffd180',
    orbitRadius: 0,
    orbitPeriod: 0,
    angle0: 0,
  },
  {
    id: 'inara',
    name: 'Inara',
    type: 'terrestrial',
    parent: 'sol',
    radius: 6,
    soi: 40,
    color: '#a89878',
    orbitRadius: 130,
    orbitPeriod: 88,
    angle0: 0.3,
    resources: { fuel: 6, gold: 2, metal: 5, science: 4 },
  },
  {
    id: 'verda',
    name: 'Verda',
    type: 'terrestrial',
    parent: 'sol',
    radius: 7,
    soi: 50,
    color: '#5fb079',
    orbitRadius: 210,
    orbitPeriod: 168,
    angle0: 1.7,
    resources: { fuel: 5, gold: 3, metal: 4, science: 6 },
  },
  {
    id: 'rust',
    name: 'Rust',
    type: 'terrestrial',
    parent: 'sol',
    radius: 6,
    soi: 60,
    color: '#c0664a',
    orbitRadius: 300,
    orbitPeriod: 320,
    angle0: 3.4,
    resources: { fuel: 2, gold: 1, metal: 7, science: 3 },
  },
  {
    id: 'jove',
    name: 'Jove',
    type: 'gas_giant',
    parent: 'sol',
    radius: 14,
    soi: 100,
    color: '#d4a574',
    orbitRadius: 460,
    orbitPeriod: 800,
    angle0: 5.2,
    resources: { fuel: 8, gold: 1, metal: 2, science: 2 },
  },
];

// Shared factions
export const SHARED_FACTIONS: Faction[] = [
  {
    id: 'player',
    name: 'Player',
    color: '#ff4444',
    isPlayer: true,
  },
  {
    id: 'enemy',
    name: 'Enemy',
    color: '#888888',
    isPlayer: false,
  },
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
  const mu = bodyId === 'sol' ? MU_SOL : (body.type === 'gas_giant' ? MU_GAS_GIANT : MU_PLANET);

  // For circular orbit: period = 2π√(r³/μ)
  const period = 2 * Math.PI * Math.sqrt((r * r * r) / mu);

  return {
    rp: r,
    ra: r,
    omega: 0,
    M0: 0,
    epoch: 0,
    direction,
    period,
    parentBodyId: bodyId,
  };
}

// Gravitational parameters (must match prototype values)
const MU_SOL =
  4 * Math.PI * Math.PI * Math.pow(130, 3) / Math.pow(88, 2);
const MU_PLANET = 200;
const MU_GAS_GIANT = 600;

// ============================================================
// SCENARIO 1: Two ships in low Inara orbit (player-controlled)
// ============================================================
export function createScenario1(): GameState {
  const bodies = SHARED_BODIES.map(b => ({ ...b }));
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  const ship1: Ship = {
    id: 'ship-alpha',
    name: 'Alpha',
    class: 'frigate',
    ownedBy: 'player',
    fuel: 100,
    orbit: circularOrbitAround('inara', 10, 1),
    orders: [],
  };

  const ship2: Ship = {
    id: 'ship-beta',
    name: 'Beta',
    class: 'cruiser',
    ownedBy: 'player',
    fuel: 150,
    orbit: { ...circularOrbitAround('inara', 15, 1), M0: Math.PI },
    orders: [],
  };

  return {
    currentTick: 0,
    bodies,
    ships: [ship1, ship2],
    factions,
    orders: [],
  };
}

// ============================================================
// SCENARIO 2: Player at Inara, Enemy at Verda (different orbits)
// ============================================================
export function createScenario2(): GameState {
  const bodies = SHARED_BODIES.map(b => ({ ...b }));
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  const playerShip: Ship = {
    id: 'ship-player',
    name: 'Flagship',
    class: 'capital',
    ownedBy: 'player',
    fuel: 200,
    orbit: circularOrbitAround('inara', 12, 1),
    orders: [],
  };

  const enemyShip: Ship = {
    id: 'ship-enemy',
    name: 'Scout',
    class: 'frigate',
    ownedBy: 'enemy',
    fuel: 80,
    orbit: circularOrbitAround('verda', 15, -1),
    orders: [
      {
        id: 'order-1',
        type: 'transfer',
        burnTime: 50,
        deltav: 2.5,
        prograde: 2.5,
        radial: 0,
        normal: 0,
        status: 'planned',
        capturedAtBody: 'inara',
      },
      {
        id: 'order-2',
        type: 'transfer',
        burnTime: 120,
        deltav: 1.8,
        prograde: 1.8,
        radial: 0,
        normal: 0,
        status: 'planned',
        capturedAtBody: 'inara',
      },
    ],
  };

  return {
    currentTick: 0,
    bodies,
    ships: [playerShip, enemyShip],
    factions,
    orders: [],
  };
}

// ============================================================
// SCENARIO 3: Ship in transit with planned burns
// ============================================================
export function createScenario3(): GameState {
  const bodies = SHARED_BODIES.map(b => ({ ...b }));
  const factions = SHARED_FACTIONS.map(f => ({ ...f }));

  // Ship starting at Inara in heliocentric transfer toward Verda
  // Approximate a Hohmann-like transfer by setting up a wide ellipse
  const transferOrbit: OrbitElements = {
    rp: 130,        // perihelion at Inara
    ra: 210,        // aphelion at Verda
    omega: 0,
    M0: 0,
    epoch: 0,
    direction: 1,
    period: 2 * Math.PI * Math.sqrt(Math.pow((130 + 210) / 2, 3) / MU_SOL),
    parentBodyId: 'sol',
  };

  const ship: Ship = {
    id: 'ship-transit',
    name: 'Explorer',
    class: 'cruiser',
    ownedBy: 'player',
    fuel: 120,
    orbit: transferOrbit,
    orders: [
      {
        id: 'node-departure-burn',
        shipId: 'ship-transit',
        type: 'transfer',
        burnTime: 5,
        deltav: 2.5,
        prograde: 2.3,
        radial: 0.6,
        normal: 0.2,
        status: 'committed',
        preOrbit: circularOrbitAround('inara', 10, 1),
        postOrbit: transferOrbit,
        capturedAtBody: 'verda',
      },
      {
        id: 'node-arrival-burn',
        shipId: 'ship-transit',
        type: 'transfer',
        burnTime: 50,
        deltav: 1.8,
        prograde: -1.7,
        radial: 0.3,
        normal: 0.1,
        status: 'planned',
        preOrbit: transferOrbit,
        postOrbit: circularOrbitAround('verda', 12, 1),
        capturedAtBody: 'verda',
      },
    ],
  };

  return {
    currentTick: 0,
    bodies,
    ships: [ship],
    factions,
    orders: ship.orders,
  };
}

// Export a scenario selector
export type ScenarioType = 1 | 2 | 3;

export function getScenario(type: ScenarioType): GameState {
  switch (type) {
    case 1:
      return createScenario1();
    case 2:
      return createScenario2();
    case 3:
      return createScenario3();
    default:
      return createScenario1();
  }
}

export const SCENARIO_DESCRIPTIONS = {
  1: 'Two ships at Inara (player-owned, basic positioning)',
  2: 'Player at Inara, Enemy at Verda (faction colors)',
  3: 'Ship in transit with planned burns (maneuver preview)',
} as const;
