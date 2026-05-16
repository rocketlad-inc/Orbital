// ============================================================
// Single-player setup — seeds an initial GameState from a
// SinglePlayerConfig. Mirrors the server's worker/factions.js
// seedGameWorld() so single-player and multiplayer kick off in
// the same shape: one capital per faction, a starter station and
// city on it, and a starter fleet in orbit.
//
// Keep this in sync with worker/factions.js when the seeding rules
// change. The two parallel implementations are the price of having
// both an offline client sim and a server-authoritative tick.
// ============================================================

import {
  GameState, Ship, Faction, Body, Settlement, SinglePlayerConfig,
  FactionResources, FactionTechStateBase, OrbitElements,
} from '../types';
import { SHARED_BODIES } from './mockGameState';
import { createCity, createStation } from '../game/settlements';

// === Constants (mirror of worker/factions.js) =================

export const SP_STARTING_RESOURCES: FactionResources = {
  fuel: 200,
  ore: 100,        // server's 'metal'
  credits: 50,    // server's 'gold'
  science: 0,
};

export const SP_FACTION_NAMES = [
  'Solar Directorate',
  'Outer Alliance',
  'Mars Combine',
  'Belt Syndicate',
  'Jovian Hegemony',
  'Aurora League',
  'Helix Compact',
  'Ember Syndicate',
];

export const SP_FACTION_COLORS = [
  '#ff7043', // ember
  '#42a5f5', // azure
  '#66bb6a', // verdant
  '#ab47bc', // violet
  '#ffca28', // amber
  '#26c6da', // cyan
  '#ec407a', // rose
  '#8d6e63', // ferrous
];

// AI opponents cap — UI restricts the player to 1-3 enemies, but the
// engine itself can handle up to (FACTION_NAMES.length - 1).
export const SP_MAX_AI_OPPONENTS = 7;

/** Default match length. 200 ticks ≈ enough to reach Saturn and back. */
export const SP_DEFAULT_MATCH_LENGTH = 200;

/**
 * Subset of SHARED_BODIES that's a valid starting capital. Terrestrial +
 * moons only — keeps the menu manageable and avoids absurd starts on
 * tiny asteroids. Matches worker/factions.js STARTING_BODY_OPTIONS.
 */
export function getStartingBodyOptions(): Body[] {
  return SHARED_BODIES.filter(b => b.type === 'terrestrial' || b.type === 'moon');
}

// === Starter ship template ===================================

interface StarterShipSpec {
  shipClass: 'frigate' | 'destroyer' | 'freighter' | 'corvette';
  baseName: string;
}

const STARTER_FLEET: StarterShipSpec[] = [
  { shipClass: 'frigate',   baseName: 'Vanguard' },
  { shipClass: 'frigate',   baseName: 'Sentinel' },
  { shipClass: 'freighter', baseName: 'Hauler' },
];

// === Helpers =================================================

/** Simple deterministic PRNG so map_seed actually produces a repeatable world. */
function makeRand(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function circularOrbitAt(
  bodyId: string,
  altitude: number,
  initialAngle: number,
  direction: 1 | -1,
  bodies: Body[],
): OrbitElements {
  const body = bodies.find(b => b.id === bodyId);
  const mu = body?.mu ?? 100;
  const period = 2 * Math.PI * Math.sqrt((altitude * altitude * altitude) / mu);
  return {
    rp: altitude,
    ra: altitude,
    omega: 0,
    M0: initialAngle,
    epoch: 0,
    direction,
    period,
    parentBodyId: bodyId,
  };
}

function emptyTechState(): FactionTechStateBase {
  return { levels: {}, researching: null, progress: 0 };
}

// === Main entry point ========================================

/**
 * Seed a fresh GameState from a SinglePlayerConfig. The player gets the
 * 'player' faction id (so the existing client code's `ownedBy === 'player'`
 * checks keep working without rewrites). AI opponents get ids `ai-1`, `ai-2`,
 * etc. and isAI=true.
 *
 * Each faction gets:
 *   - Body ownership flipped to their faction
 *   - A starter station in orbit (so they can build ships immediately)
 *   - A starter city on the body (so they harvest resources from tick 0)
 *   - 3 starter ships (2 frigates + 1 freighter) in low orbit
 *   - STARTING_RESOURCES poured into their pool
 */
export function setupSinglePlayer(config: SinglePlayerConfig): GameState {
  const rand = makeRand(config.mapSeed ?? `sp-${Date.now()}`);

  // 1. Start with the shared body catalog, clear all ownership
  const bodies: Body[] = SHARED_BODIES.map(b => ({ ...b, ownedBy: undefined }));

  // 2. Build the factions list (player first, then AI opponents)
  const factions: Faction[] = [];
  factions.push({
    id: 'player',
    name: config.player.factionName || 'Commander',
    color: config.player.color || '#4ecdc4',
    isPlayer: true,
    isAI: false,
  });
  config.aiOpponents.forEach((ai, i) => {
    factions.push({
      id: `ai-${i + 1}`,
      name: ai.factionName || SP_FACTION_NAMES[(i + 1) % SP_FACTION_NAMES.length],
      color: ai.color || SP_FACTION_COLORS[(i + 1) % SP_FACTION_COLORS.length],
      isPlayer: false,
      isAI: true,
    });
  });

  // 3. Resources + tech pools — every faction starts equal
  const resources: Record<string, FactionResources> = {};
  const factionTech: Record<string, FactionTechStateBase> = {};
  for (const f of factions) {
    resources[f.id] = { ...SP_STARTING_RESOURCES };
    factionTech[f.id] = emptyTechState();
  }

  // 4. Seed each faction's capital — flip body ownership, drop starter
  //    settlements + fleet. Track which body each faction claimed so we
  //    can fall back to a random choice for AIs that didn't pick.
  const settlements: Settlement[] = [];
  const ships: Ship[] = [];
  const claimedBodies = new Set<string>();

  const desiredCapital: Record<string, string> = {};
  desiredCapital['player'] = config.player.startingBodyId;
  config.aiOpponents.forEach((ai, i) => {
    desiredCapital[`ai-${i + 1}`] = ai.startingBodyId;
  });

  const startingOptions = getStartingBodyOptions();

  for (const f of factions) {
    let capitalId = desiredCapital[f.id];
    // Conflict resolution: if two factions picked the same body or didn't
    // pick at all, fall back to a random unclaimed option.
    if (!capitalId || claimedBodies.has(capitalId)) {
      const remaining = startingOptions.filter(o => !claimedBodies.has(o.id));
      if (remaining.length === 0) break; // catalog exhausted
      capitalId = remaining[Math.floor(rand() * remaining.length)].id;
    }
    claimedBodies.add(capitalId);
    const capital = bodies.find(b => b.id === capitalId);
    if (!capital) continue;

    // Flip ownership of the body itself
    capital.ownedBy = f.id;

    // Auto-deploy starter settlements: a station for shipyard access +
    // a city for early harvest. Mirrors the server's seed step that drops
    // a single city + city HP. Worker uses one auto-deployed city; we
    // give the player both because SP lacks the "deploy freighter" UX
    // step that MP has via the lobby starter freighter.
    if (capital.type === 'terrestrial' || capital.type === 'moon' || capital.type === 'dwarf') {
      settlements.push(createCity(capital, f.id, 0, `${capital.name} City`));
    }
    settlements.push(createStation(capital, f.id, 0, bodies, `${capital.name} Yards`));

    // Starter fleet — 3 ships per capital. Class HP comes from
    // SHIP_CLASSES so we don't hardcode it here. Spread out in low
    // orbit, alternating direction so they don't all stack.
    STARTER_FLEET.forEach((spec, i) => {
      const altitude = 10 + i * 4;
      const initialAngle = (i * 2 * Math.PI) / STARTER_FLEET.length;
      const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const ship: Ship = {
        id: `ship-${f.id}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.id === 'player' ? spec.baseName : `${spec.baseName}-${f.name.slice(0, 3).toUpperCase()}`,
        class: spec.shipClass,
        ownedBy: f.id,
        fuel: 100,
        orbit: circularOrbitAt(capital.id, altitude, initialAngle, dir, bodies),
        orders: [],
      };
      ships.push(ship);
    });
  }

  return {
    currentTick: 0,
    bodies,
    ships,
    fleets: [],
    factions,
    settlements,
    orders: [],
    buildOrders: [],
    resources,
    factionTech,
    combatLog: [],
    lastHarvestTick: 0,
    aiActivityLog: [],
    status: 'active',
    totalTickTarget: config.totalTickTarget,
  };
}

// === Victory check ===========================================

/**
 * Compute the winner at game end. Mirrors worker/room.js alarm() victory
 * logic: most owned bodies → most wealth → lowest slot.
 */
export function computeWinner(state: GameState): {
  factionId: string;
  victoryType: 'hegemony' | 'wealth' | 'tiebreak';
} | null {
  if (state.factions.length === 0) return null;

  // 1. Count owned bodies per faction (via settlement ownership)
  const bodyOwnership = new Map<string, Set<string>>(); // factionId → bodyIds
  for (const f of state.factions) bodyOwnership.set(f.id, new Set());
  for (const s of state.settlements) {
    bodyOwnership.get(s.ownedBy)?.add(s.bodyId);
  }

  const bodyCounts = state.factions.map(f => ({
    factionId: f.id,
    count: bodyOwnership.get(f.id)?.size ?? 0,
  }));

  // Find max
  const maxBodies = Math.max(...bodyCounts.map(b => b.count));
  const topByBodies = bodyCounts.filter(b => b.count === maxBodies);

  if (topByBodies.length === 1 && maxBodies > 0) {
    return { factionId: topByBodies[0].factionId, victoryType: 'hegemony' };
  }

  // 2. Tiebreaker — most total wealth
  const wealthOf = (fid: string): number => {
    const r = state.resources[fid];
    if (!r) return 0;
    return r.fuel + r.ore + r.credits + r.science;
  };
  const tied = topByBodies.length > 1 ? topByBodies : bodyCounts;
  const wealths = tied.map(b => ({ factionId: b.factionId, wealth: wealthOf(b.factionId) }));
  const maxWealth = Math.max(...wealths.map(w => w.wealth));
  const topByWealth = wealths.filter(w => w.wealth === maxWealth);

  if (topByWealth.length === 1) {
    return { factionId: topByWealth[0].factionId, victoryType: 'wealth' };
  }

  // 3. Final tiebreak — first faction in the list (slot 0)
  return { factionId: topByWealth[0].factionId, victoryType: 'tiebreak' };
}
