// ============================================================
// factionAI — Utility-based AI for non-player factions.
//
// Pure function: runFactionAI(state, factionId, tick) → AIDecision.
// No side effects. The caller (gameContext tick loop) applies the
// returned intents through the existing action handlers (buildShip,
// deploySettlement, launchTorchTransfer, startResearch).
// The AI never mutates state directly.
//
// Architecture: utility AI. For every possible action this faction
// could take this tick, score it; pick the top N within an action
// budget. Robust + tunable + easy to debug — every decision comes
// with a reason string for the activity feed.
// ============================================================

import {
  GameState, Ship, Settlement, FactionResources, BuildingKind,
} from '../types';
import { ShipClassName, SHIP_CLASSES, BUILDABLE_CLASSES } from './shipClasses';
import {
  SETTLEMENT_DEFS, canHostCity, canHostStation,
  COLLECTOR_COST,
  // BUILDING_DEFS pending settlement-upgrade AI candidate generator.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  BUILDING_DEFS, buildingLevel, buildingCostForNextLevel,
} from './settlements';
import { TechId, TECH_DEFS, TECH_MAX_LEVEL, ALL_TECH_IDS } from './techs';
// DYSON_PER_FREIGHTER_PER_TICK pending engineering-phase scoring of Sol freighters.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { SOL_BODY_ID, DYSON_PER_FREIGHTER_PER_TICK } from './dysonSphere';
import { FUEL_ENABLED } from './featureFlags';
import {
  BINARY_SYSTEM_BODY_IDS,
  BLACK_HOLE_SYSTEM_BODY_IDS,
} from '../state/mockGameState';

// Bodies that require inter-system warp travel. The AI has no concept of
// warp gates so it must never attempt to colonize, deploy, or attack bodies
// in remote star systems — ships sent there simply disappear.
const REMOTE_SYSTEM_BODY_IDS: ReadonlySet<string> = new Set([
  ...BINARY_SYSTEM_BODY_IDS,
  ...BLACK_HOLE_SYSTEM_BODY_IDS,
]);

// === Constants ===============================================

/** Ticks between AI decision cycles per faction. ~50 means a 24h-per-tick
 *  game gets one AI decision every 50 days, which feels right. */
export const AI_DECISION_INTERVAL = 50;

/** Max intents executed per decision cycle. Prevents the AI from firing
 *  every action at once and looking absurd. */
const ACTION_BUDGET = 2;

/** Minimum utility score for an intent to be considered worth taking. */
const SCORE_THRESHOLD = 0.5;

/** Soft target for fleet size. Above this, building more is deprioritized. */
const TARGET_FLEET_SIZE = 5;

// === Strategic phase model ===================================
//
// The AI moves through phases based on its current footprint, threats,
// and proximity to a victory condition. Each phase applies different
// weight multipliers to the utility-scored candidate actions, so the
// same brain naturally shifts focus:
//
//   EXPANSION   → bias build/deploy/transfer-freighter, suppress combat
//   DEFENSE     → bias combat-ship builds + transfers to own bodies,
//                 suppress expansion and offensive transfers
//   AGGRESSION  → bias destroyer builds + transfers to enemy bodies
//   ENGINEERING → AI controls the Dyson Sphere foundation slot or
//                 already started it. Crank freighter builds + Sol
//                 transfers; keep combat alive to defend the foundation
//   SCIENCE     → AI has researched > SCIENCE_PHASE_LEVEL_FLOOR total
//                 tech levels (close to maxing all tracks). Lab spam,
//                 science-yield buildings, no offensive expansion
//
// Phase is recomputed each cycle from raw state, so the AI can fall
// back from AGGRESSION to DEFENSE if a colony comes under attack, or
// back to EXPANSION if its colonies are wiped out.

export type AIPhase = 'expansion' | 'defense' | 'aggression' | 'engineering' | 'science';

/** Minimum colonies (distinct settled bodies) before the AI even
 *  considers leaving expansion phase. First goal is more colonies. */
const EXPANSION_TARGET_COLONIES = 2;

/** Minimum combat ships parked at each owned body before defense
 *  phase considers itself "complete" and graduates to aggression. */
const DEFENSE_SHIPS_PER_BODY = 1;

/** Total tech-level threshold (across all tracks) at which the AI
 *  shifts into SCIENCE phase. 7 tracks × TECH_MAX_LEVEL=10 = 70
 *  total possible, so this triggers when the AI has researched
 *  ~50% of all available levels. */
const SCIENCE_PHASE_LEVEL_FLOOR = 35;

/** Soft target for the AI's freighter pre-staging at Sol during the
 *  ENGINEERING phase. Each parked freighter pumps
 *  DYSON_PER_FREIGHTER_PER_TICK into the sphere every tick, so the
 *  AI keeps ferrying idle freighters to Sol until this many are
 *  parked. Past this floor, the dysonFreighter weight stops biasing
 *  new transfers and the AI can return to other priorities. */
const ENGINEERING_FREIGHTER_TARGET = 5;

interface PhaseWeights {
  // Build category multipliers — applied to per-class build scores
  freighterBuild: number;
  combatShipBuild: number;
  destroyerBuild: number;    // separate so aggression can prefer heavies
  // Deploy multiplier
  settlementDeploy: number;
  // Transfer multipliers
  freighterTransfer: number;     // sending a freighter to colonize
  transferToOwn: number;         // sending a combat ship to defend my body
  transferToEnemy: number;       // sending a combat ship to attack an enemy body
  // Logistics / upgrades / megaproject multipliers
  collectorBuild: number;        // building a logistics endpoint
  yieldBuilding: number;         // forge / mint
  scienceBuilding: number;       // lab + 'science'-type research
  weaponsBuilding: number;       // station combat upgrades
  shipyardBuilding: number;      // parallel build slots
  dysonInitiate: number;         // lay the foundation
  dysonFreighter: number;        // send freighter to Sol
  research: number;              // overall science-spend
}

const PHASE_WEIGHTS: Record<AIPhase, PhaseWeights> = {
  // Phase 1: grow the empire. Freighters and settlements dominate.
  // Building combat ships is allowed but de-prioritized so the resource
  // pool funnels into colonization first.
  expansion: {
    freighterBuild: 2.0,
    combatShipBuild: 0.4,
    destroyerBuild: 0.2,
    settlementDeploy: 1.8,
    freighterTransfer: 2.5,
    transferToOwn: 0.3,
    transferToEnemy: 0.1,    // never attack while expanding
    collectorBuild: 1.5,     // every new settlement needs collector links
    yieldBuilding: 1.2,
    scienceBuilding: 1.0,
    weaponsBuilding: 0.3,
    shipyardBuilding: 0.5,
    dysonInitiate: 0.1,      // not a priority while still growing
    dysonFreighter: 0.0,
    research: 1.0,
  },
  // Phase 2: hold what we've got. Combat-ship pump on, sending them
  // out to defend colonies. Settlement deploys throttled — we're not
  // grabbing more ground until what we have is secure.
  defense: {
    freighterBuild: 0.5,
    combatShipBuild: 1.8,
    destroyerBuild: 1.2,
    settlementDeploy: 0.3,
    freighterTransfer: 0.4,
    transferToOwn: 2.5,      // defending my bodies is the goal
    transferToEnemy: 0.3,    // not yet
    collectorBuild: 1.0,
    yieldBuilding: 0.7,
    scienceBuilding: 0.5,
    weaponsBuilding: 2.5,    // station guns are gold during defense
    shipyardBuilding: 1.0,
    dysonInitiate: 0.0,
    dysonFreighter: 0.0,
    research: 0.6,
  },
  // Phase 3: take the fight outward. Heavy hitters preferred, plus
  // a freighter chain for resupply. Offensive transfers dominate.
  aggression: {
    freighterBuild: 1.0,     // keep the supply line alive
    combatShipBuild: 1.5,
    destroyerBuild: 1.8,
    settlementDeploy: 0.6,
    freighterTransfer: 0.8,
    transferToOwn: 0.5,      // defenders stay put, the rest go forward
    transferToEnemy: 2.5,    // hunt
    collectorBuild: 0.6,
    yieldBuilding: 0.5,
    scienceBuilding: 0.3,
    weaponsBuilding: 1.0,
    shipyardBuilding: 1.5,   // need throughput to keep cranking ships
    dysonInitiate: 0.0,
    dysonFreighter: 0.0,
    research: 0.4,
  },
  // Phase 4: pursue Engineering Victory. AI has either laid the
  // foundation or has the means to (Sol station + freighter chain).
  // Everything bends toward keeping freighters parked at Sol AND
  // defending the foundation station.
  engineering: {
    freighterBuild: 3.0,     // need a delivery fleet
    combatShipBuild: 1.0,
    destroyerBuild: 1.2,     // defend the foundation
    settlementDeploy: 0.5,
    freighterTransfer: 0.5,  // no time for colonization runs
    transferToOwn: 1.5,      // hold Sol and supply lines
    transferToEnemy: 0.4,
    collectorBuild: 1.0,
    yieldBuilding: 1.5,      // mints + forges fuel the drain
    scienceBuilding: 0.5,
    weaponsBuilding: 2.5,    // defend the Sol station
    shipyardBuilding: 1.5,
    dysonInitiate: 5.0,      // top priority if slot is open
    dysonFreighter: 4.0,     // ferry every spare freighter to Sol
    research: 0.4,
  },
  // Phase 5: pursue Science Victory. AI is well past halfway through
  // the tech tree; pour science into the remaining levels.
  science: {
    freighterBuild: 1.0,
    combatShipBuild: 0.5,
    destroyerBuild: 0.3,
    settlementDeploy: 0.8,   // more cities → more science
    freighterTransfer: 0.8,
    transferToOwn: 1.0,
    transferToEnemy: 0.1,    // don't pick fights, just research
    collectorBuild: 1.0,
    yieldBuilding: 1.0,
    scienceBuilding: 3.0,    // every spare credit into labs
    weaponsBuilding: 1.0,    // defend what we have
    shipyardBuilding: 0.5,
    dysonInitiate: 0.0,
    dysonFreighter: 0.0,
    research: 3.0,           // everything we can afford
  },
};

// === Public API ==============================================

export type AIActionIntent =
  | { kind: 'build_ship'; bodyId: string; shipClass: ShipClassName; name: string; score: number; reason: string }
  | { kind: 'deploy_settlement'; bodyId: string; settlementType: 'city' | 'station'; name: string; score: number; reason: string }
  | { kind: 'transfer'; shipId: string; targetBodyId: string; score: number; reason: string }
  | { kind: 'research'; techId: TechId; score: number; reason: string }
  | { kind: 'build_collector'; settlementId: string; score: number; reason: string }
  | { kind: 'queue_building'; settlementId: string; buildingKind: BuildingKind; score: number; reason: string }
  | { kind: 'initiate_dyson'; settlementId: string; score: number; reason: string }
  | { kind: 'idle'; score: 0; reason: string };

export interface AIDecision {
  /** Intents the AI wants the caller to execute, ordered by score desc. */
  intents: AIActionIntent[];
  /** Human-readable summary of each decision for the activity feed. */
  notes: string[];
}

/**
 * Run one decision cycle for a faction. Pure function — does not mutate
 * gameState. The caller applies the returned intents.
 */
export function runFactionAI(
  gameState: GameState,
  factionId: string,
  tick: number,
): AIDecision {
  const ctx = buildContext(gameState, factionId, tick);
  if (!ctx) return { intents: [], notes: [] };

  const candidates: AIActionIntent[] = [
    ...generateBuildCandidates(ctx),
    ...generateDeployCandidates(ctx),
    ...generateTransferCandidates(ctx),
    ...generateResearchCandidates(ctx),
    ...generateCollectorCandidates(ctx),
    ...generateBuildingCandidates(ctx),
    ...generateDysonCandidates(ctx),
  ];

  candidates.sort((a, b) => b.score - a.score);

  const top = candidates
    .filter(c => c.kind !== 'idle' && c.score >= SCORE_THRESHOLD)
    .slice(0, ACTION_BUDGET);

  const notes = top.length === 0
    ? [`[${phaseTag(ctx.phase)}] ${ctx.faction.name}: standing by`]
    : top.map(intent => describeIntent(intent, ctx));

  return { intents: top, notes };
}

// === Context =================================================

interface AIContext {
  factionId: string;
  faction: { name: string; color: string };
  state: GameState;
  tick: number;
  resources: FactionResources;
  techLevels: Record<string, number>;
  totalTechLevels: number;            // sum across all tracks — used by phase detection
  alreadyResearching: boolean;        // skip queuing duplicate research

  // Faction's stuff
  myShips: Ship[];                    // all ships I own
  myShipsIdle: Ship[];                // not in transfer or pending
  myFreightersIdle: Ship[];           // for settlement deploys
  myCombatShipsIdle: Ship[];          // corvettes/frigates/destroyers not busy
  mySettlements: Settlement[];
  myStations: Settlement[];           // shipyards
  myCities: Settlement[];             // forge/mint/lab hosts
  mySolStations: Settlement[];        // Dyson-eligible foundations
  myFreightersAtSol: number;          // counts for sphere delivery
  myActiveBuildBodyIds: Set<string>;  // bodies currently constructing a ship
  hasAnyCollector: boolean;           // empire-wide collector gate

  // World
  ownedBodyIds: Set<string>;          // bodies I have a settlement on
  hostileShips: Ship[];               // any ship not owned by me
  bodyIdToHostileShips: Map<string, Ship[]>;  // for threat assessment
  dyson: GameState['dysonSphere'];    // current sphere snapshot (or undefined)
  iControlDyson: boolean;             // I'm the controller faction

  // Strategic phase + the weight table to apply this cycle
  phase: AIPhase;
  weights: PhaseWeights;
}

/**
 * Decide which phase a faction is currently in. Pure function of its
 * own state — colonies held, combat ships, and whether any of its
 * settlements have hostiles bearing down on them.
 */
function determinePhase(
  mySettlements: Settlement[],
  myShips: Ship[],
  bodyIdToHostileShips: Map<string, Ship[]>,
  totalTechLevels: number,
  iControlDyson: boolean,
  mySolStationCount: number,
  dysonExists: boolean,
): AIPhase {
  // EXPANSION → not enough colonies yet AND nothing's on fire.
  // If a colony is being attacked, jump straight to defense even if
  // we're still expanding by colony count.
  const underAttack = mySettlements.some(s => {
    const hostiles = bodyIdToHostileShips.get(s.bodyId)?.length ?? 0;
    return hostiles > 0;
  });
  const distinctColonyBodies = new Set(mySettlements.map(s => s.bodyId)).size;
  if (distinctColonyBodies < EXPANSION_TARGET_COLONIES && !underAttack) {
    return 'expansion';
  }

  // ENGINEERING → I control the sphere OR I have the means to grab it
  // (a Sol station, no rival sphere yet). This trumps everything else
  // once the AI has positioned for the megaproject — it's the most
  // committed strategic pivot. Falls back to defense the moment a
  // colony's under attack so the AI doesn't fiddle while Rome burns.
  if (iControlDyson) {
    if (underAttack) return 'defense';
    return 'engineering';
  }
  if (!dysonExists && mySolStationCount > 0) {
    if (underAttack) return 'defense';
    return 'engineering';
  }

  // SCIENCE → past the 50% tech-tree threshold. We're closer to the
  // Science Victory than to anything else; lean into research. Still
  // falls back to defense on attack — the AI isn't blind to the map.
  if (totalTechLevels >= SCIENCE_PHASE_LEVEL_FLOOR && !underAttack) {
    return 'science';
  }

  // DEFENSE → each colony body needs at least DEFENSE_SHIPS_PER_BODY combat
  // ships parked at it. Once that floor is met everywhere, graduate.
  const combatShipsAtBody = new Map<string, number>();
  for (const ship of myShips) {
    // Skip ships in transit — they don't count as defenders at any
    // body until they park.
    if (ship.transit || ship.class === 'freighter') continue;
    const bodyId = ship.orbit.parentBodyId;
    combatShipsAtBody.set(bodyId, (combatShipsAtBody.get(bodyId) ?? 0) + 1);
  }
  const undefended = mySettlements.filter(s =>
    (combatShipsAtBody.get(s.bodyId) ?? 0) < DEFENSE_SHIPS_PER_BODY
  );
  if (undefended.length > 0) {
    return 'defense';
  }

  // AGGRESSION → all colonies defended, time to go forward.
  return 'aggression';
}

function buildContext(state: GameState, factionId: string, tick: number): AIContext | null {
  const faction = state.factions.find(f => f.id === factionId);
  if (!faction) return null;

  const resources = state.resources[factionId];
  if (!resources) return null;

  const tech = state.factionTech?.[factionId];
  const techLevels: Record<string, number> = tech?.levels ?? {};
  const totalTechLevels = ALL_TECH_IDS.reduce((sum, id) => sum + (techLevels[id] ?? 0), 0);
  const alreadyResearching = !!tech?.researching;

  const myShips = state.ships.filter(s => s.ownedBy === factionId);
  const myShipsIdle = myShips.filter(s => !s.transit && !s.plannedTransit);
  const myFreightersIdle = myShipsIdle.filter(s => s.class === 'freighter');
  const myCombatShipsIdle = myShipsIdle.filter(s => s.class !== 'freighter');

  const mySettlements = state.settlements.filter(s => s.ownedBy === factionId);
  const myStations = mySettlements.filter(s => s.type === 'station');
  const myCities = mySettlements.filter(s => s.type === 'city');
  const mySolStations = myStations.filter(s => s.bodyId === SOL_BODY_ID);
  const myFreightersAtSol = myShips.filter(s =>
    s.class === 'freighter' && !s.transit && s.orbit.parentBodyId === SOL_BODY_ID,
  ).length;
  const hasAnyCollector = mySettlements.some(s => s.hasCollector);

  const myActiveBuildBodyIds = new Set(
    state.buildOrders.filter(b => b.ownedBy === factionId).map(b => b.bodyId)
  );

  const ownedBodyIds = new Set(mySettlements.map(s => s.bodyId));

  const hostileShips = state.ships.filter(s => s.ownedBy !== factionId);
  const bodyIdToHostileShips = new Map<string, Ship[]>();
  for (const ship of hostileShips) {
    // Skip ships in transit — they don't threaten any body until they arrive.
    if (ship.transit) continue;
    const bodyId = ship.orbit.parentBodyId;
    if (!bodyIdToHostileShips.has(bodyId)) bodyIdToHostileShips.set(bodyId, []);
    bodyIdToHostileShips.get(bodyId)!.push(ship);
  }

  const dyson = state.dysonSphere;
  const iControlDyson = dyson?.controllerFactionId === factionId;
  const dysonExists = !!dyson;

  const phase = determinePhase(
    mySettlements, myShips, bodyIdToHostileShips,
    totalTechLevels, iControlDyson, mySolStations.length, dysonExists,
  );

  return {
    factionId,
    faction: { name: faction.name, color: faction.color },
    state,
    tick,
    resources,
    techLevels,
    totalTechLevels,
    alreadyResearching,
    myShips,
    myShipsIdle,
    myFreightersIdle,
    myCombatShipsIdle,
    mySettlements,
    myStations,
    myCities,
    mySolStations,
    myFreightersAtSol,
    myActiveBuildBodyIds,
    hasAnyCollector,
    ownedBodyIds,
    hostileShips,
    bodyIdToHostileShips,
    dyson,
    iControlDyson,
    phase,
    weights: PHASE_WEIGHTS[phase],
  };
}

// === Affordability helpers ===================================

function canAffordShip(ctx: AIContext, cls: ShipClassName): boolean {
  const cost = SHIP_CLASSES[cls].cost;
  if (FUEL_ENABLED && ctx.resources.fuel < cost.fuel) return false;
  return ctx.resources.ore >= cost.ore && ctx.resources.credits >= cost.credits;
}

function canAffordSettlement(ctx: AIContext, type: 'city' | 'station'): boolean {
  const cost = SETTLEMENT_DEFS[type].cost;
  if (FUEL_ENABLED && ctx.resources.fuel < cost.fuel) return false;
  return ctx.resources.ore >= cost.ore && ctx.resources.credits >= cost.credits;
}

function techCost(techId: TechId, currentLevel: number): number {
  const def = TECH_DEFS[techId];
  return Math.ceil(def.baseCost * Math.pow(currentLevel + 1, def.costScaling));
}

function canAffordTech(ctx: AIContext, techId: TechId): boolean {
  const level = ctx.techLevels[techId] ?? 0;
  const cost = techCost(techId, level);
  return ctx.resources.science >= cost;
}

// === Action generators =======================================

function generateBuildCandidates(ctx: AIContext): AIActionIntent[] {
  const out: AIActionIntent[] = [];
  if (ctx.myStations.length === 0) return out;  // no shipyards, can't build

  const fleetSize = ctx.myShips.length;
  const freighterCount = ctx.myShips.filter(s => s.class === 'freighter').length;
  const combatShipCount = fleetSize - freighterCount;
  const fleetGap = Math.max(0, TARGET_FLEET_SIZE - combatShipCount);

  for (const station of ctx.myStations) {
    // Don't queue multiple builds at the same body — wastes ore.
    if (ctx.myActiveBuildBodyIds.has(station.bodyId)) continue;

    for (const cls of BUILDABLE_CLASSES) {
      if (!canAffordShip(ctx, cls)) continue;

      let score = 0;
      let reason = '';

      if (cls === 'freighter') {
        // Want at least 1 freighter for settlement deploys + economy.
        if (freighterCount === 0) { score += 5; reason = 'first freighter'; }
        else if (freighterCount < 2 && fleetSize > 3) { score += 1.5; reason = 'second freighter'; }
        else { score += 0.2; reason = 'extra freighter'; }
        score *= ctx.weights.freighterBuild;
      } else if (cls === 'corvette') {
        score += fleetGap * 1.2;
        reason = combatShipCount === 0 ? 'no combat ships' : 'expand light fleet';
        score *= ctx.weights.combatShipBuild;
      } else if (cls === 'frigate') {
        score += fleetGap * 1.5;
        if (combatShipCount >= 2) score += 1;  // upgrade past corvette spam
        reason = 'mainline warship';
        score *= ctx.weights.combatShipBuild;
      } else if (cls === 'destroyer') {
        score += fleetGap * 1.0;
        if (combatShipCount >= 3) score += 1.5;  // late-game heavy hitter
        reason = 'heavy hitter';
        score *= ctx.weights.destroyerBuild;
      }

      // Cost penalty: avoid emptying the treasury. Applied after phase
      // multipliers so the AI still respects its bank even when a phase
      // strongly favors a class.
      const cost = SHIP_CLASSES[cls].cost;
      const oreShare = cost.ore / Math.max(1, ctx.resources.ore);
      score -= oreShare * 2;

      if (score <= 0) continue;

      out.push({
        kind: 'build_ship',
        bodyId: station.bodyId,
        shipClass: cls,
        name: generateShipName(cls, ctx),
        score,
        reason,
      });
    }
  }
  return out;
}

function generateDeployCandidates(ctx: AIContext): AIActionIntent[] {
  const out: AIActionIntent[] = [];
  if (ctx.myFreightersIdle.length === 0) return out;

  // Group freighters by current body — only need to evaluate each body once.
  const freighterBodies = new Set(ctx.myFreightersIdle.map(f => f.orbit.parentBodyId));

  for (const bodyId of freighterBodies) {
    const body = ctx.state.bodies.find(b => b.id === bodyId);
    if (!body) continue;
    if (body.type === 'star') continue;

    // Remote star-system bodies require warp gates — the AI can't reach them.
    if (REMOTE_SYSTEM_BODY_IDS.has(bodyId)) continue;

    // Already have a settlement here? Skip — one is enough for v1.
    if (ctx.mySettlements.some(s => s.bodyId === bodyId)) continue;

    // Pick best type: station if shipyards needed and allowed, else city if rocky body.
    const stationOk = canHostStation(body);
    const cityOk = canHostCity(body);
    if (!stationOk && !cityOk) continue;

    // Prefer station if we have zero of them (we need shipyards desperately)
    const wantStation = stationOk && ctx.myStations.length === 0;
    const type: 'city' | 'station' = wantStation && stationOk
      ? 'station'
      : (cityOk ? 'city' : 'station');

    if (!canAffordSettlement(ctx, type)) continue;

    let score = 0;
    let reason = '';

    if (wantStation) {
      score += 6;
      reason = 'first shipyard';
    } else {
      score += 2;  // baseline expansion
      reason = `expand to ${body.name}`;
    }

    // Higher score for higher-yield bodies
    const totalYield = (body.resources?.metal ?? 0)
                      + (body.resources?.fuel ?? 0)
                      + (body.resources?.gold ?? 0)
                      + (body.resources?.science ?? 0);
    score += totalYield * 0.15;

    // Phase weight — expansion favors deploys, defense/aggression throttle them
    score *= ctx.weights.settlementDeploy;

    // Penalize contested bodies (hostile ships present)
    const hostiles = ctx.bodyIdToHostileShips.get(bodyId)?.length ?? 0;
    score -= hostiles * 2;

    // Cost penalty
    const cost = SETTLEMENT_DEFS[type].cost;
    score -= (cost.ore / Math.max(1, ctx.resources.ore)) * 1.5;

    if (score <= 0) continue;

    out.push({
      kind: 'deploy_settlement',
      bodyId,
      settlementType: type,
      name: generateSettlementName(type, body.name),
      score,
      reason,
    });
  }
  return out;
}

function generateTransferCandidates(ctx: AIContext): AIActionIntent[] {
  const out: AIActionIntent[] = [];
  if (ctx.myCombatShipsIdle.length === 0 && ctx.myFreightersIdle.length === 0) return out;

  // === 0. ENGINEERING: ferry freighters to Sol for sphere delivery ===
  // When the AI is pushing the megaproject, idle freighters parked
  // anywhere except Sol are dead weight. Each freighter at Sol drains
  // DYSON_PER_FREIGHTER_PER_TICK from the empire pool into the sphere,
  // so the bottleneck is "how many freighters can I park at Sol". This
  // emits one transfer-to-Sol per idle freighter not already there,
  // up to ENGINEERING_FREIGHTER_TARGET total parked.
  if (ctx.phase === 'engineering' && ctx.myFreightersAtSol < ENGINEERING_FREIGHTER_TARGET) {
    const freightersNotAtSol = ctx.myFreightersIdle.filter(
      f => f.orbit.parentBodyId !== SOL_BODY_ID,
    );
    // Cap at 2 per cycle so the AI doesn't fire every freighter in one
    // tick — staggered launches look more natural in the activity feed.
    for (const freighter of freightersNotAtSol.slice(0, 2)) {
      out.push({
        kind: 'transfer',
        shipId: freighter.id,
        targetBodyId: SOL_BODY_ID,
        // High base score — ENGINEERING weight (4.0) pushes this above
        // almost everything else when phase is active. Each delivered
        // freighter pumps DYSON_PER_FREIGHTER_PER_TICK = 30 into the
        // sphere every tick, so the gain compounds.
        score: 3.0 * ctx.weights.dysonFreighter,
        reason: `[${ctx.phase}] freighter → Sol for Dyson delivery (+${DYSON_PER_FREIGHTER_PER_TICK}/tick)`,
      });
    }
  }

  // === 1. Freighter colonization runs ===
  // Send freighters to high-yield bodies we don't already settle. Phase
  // weight here is the difference between aggressive colonization
  // (expansion) and merely topping up a supply chain (aggression).
  for (const freighter of ctx.myFreightersIdle.slice(0, 1)) {
    const candidates = ctx.state.bodies.filter(b => {
      if (b.type === 'star') return false;
      if (b.id === freighter.orbit.parentBodyId) return false;
      if (ctx.ownedBodyIds.has(b.id)) return false;
      // Remote systems require warp gates — unreachable for the AI.
      if (REMOTE_SYSTEM_BODY_IDS.has(b.id)) return false;
      return canHostCity(b) || canHostStation(b);
    });

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const yA = (a.resources?.metal ?? 0) + (a.resources?.fuel ?? 0) + (a.resources?.gold ?? 0) + (a.resources?.science ?? 0);
      const yB = (b.resources?.metal ?? 0) + (b.resources?.fuel ?? 0) + (b.resources?.gold ?? 0) + (b.resources?.science ?? 0);
      return yB - yA;
    });

    const target = candidates[0];
    out.push({
      kind: 'transfer',
      shipId: freighter.id,
      targetBodyId: target.id,
      score: 2.5 * ctx.weights.freighterTransfer,
      reason: `[${ctx.phase}] send freighter to colonize ${target.name}`,
    });
  }

  // === 2. Combat-ship redeployment ===
  // Two flavors: defending an owned body, or attacking an enemy concentration.
  // Each is scored separately and gets its own phase multiplier — so in
  // DEFENSE the AI sends ships home, in AGGRESSION it sends them to enemies,
  // and in EXPANSION both are heavily suppressed (the AI hoards its fleet).
  for (const ship of ctx.myCombatShipsIdle.slice(0, 2)) {
    // Best defensive target: an owned body with hostiles, that the ship
    // isn't already at.
    let bestDef: { bodyId: string; bodyName: string; threat: number } | null = null;
    // Best offensive target: an enemy concentration NOT on one of my bodies.
    let bestAtk: { bodyId: string; bodyName: string; threat: number } | null = null;

    for (const [bodyId, hostiles] of ctx.bodyIdToHostileShips) {
      if (bodyId === ship.orbit.parentBodyId) continue;
      // Remote systems are unreachable — ignore threats there.
      if (REMOTE_SYSTEM_BODY_IDS.has(bodyId)) continue;
      const body = ctx.state.bodies.find(b => b.id === bodyId);
      if (!body) continue;
      const threat = hostiles.length;
      const isMine = ctx.ownedBodyIds.has(bodyId);

      if (isMine) {
        if (!bestDef || threat > bestDef.threat) {
          bestDef = { bodyId, bodyName: body.name, threat };
        }
      } else {
        if (!bestAtk || threat > bestAtk.threat) {
          bestAtk = { bodyId, bodyName: body.name, threat };
        }
      }
    }

    // Emit each candidate independently with its own phase weight applied.
    // The overall scoring pass picks the winner.
    if (bestDef) {
      out.push({
        kind: 'transfer',
        shipId: ship.id,
        targetBodyId: bestDef.bodyId,
        score: (1.5 + bestDef.threat * 0.6) * ctx.weights.transferToOwn,
        reason: `[${ctx.phase}] defend ${bestDef.bodyName}`,
      });
    }
    if (bestAtk) {
      out.push({
        kind: 'transfer',
        shipId: ship.id,
        targetBodyId: bestAtk.bodyId,
        score: (1.5 + bestAtk.threat * 0.4) * ctx.weights.transferToEnemy,
        reason: `[${ctx.phase}] attack ${bestAtk.bodyName}`,
      });
    }
  }

  return out;
}

function generateResearchCandidates(ctx: AIContext): AIActionIntent[] {
  const out: AIActionIntent[] = [];

  // Already researching something? Skip — the per-tick drain in
  // advanceToTick handles incremental progress. We only push a new
  // 'research' intent when there's nothing in flight.
  if (ctx.alreadyResearching) return out;

  // Min science threshold. In SCIENCE phase we research the moment we
  // can afford any level; in other phases we hold a small buffer so
  // the early-game pool isn't drained by lab spam.
  const minScience = ctx.phase === 'science' ? 0 : 30;
  if (ctx.resources.science < minScience) return out;

  const priorities: Array<{ techId: TechId; baseScore: number }> = [
    { techId: 'weapons', baseScore: 2.0 },
    { techId: 'industry', baseScore: 1.8 },
    { techId: 'armor', baseScore: 1.5 },
    { techId: 'construction', baseScore: 1.2 },
    { techId: 'sensors', baseScore: 1.0 },
    { techId: 'flight', baseScore: 0.8 },
    { techId: 'propulsion', baseScore: FUEL_ENABLED ? 0.8 : 0.2 },
  ];

  for (const p of priorities) {
    // Hard skip — cap reached. Wastes scoring effort and breaks the
    // Science Victory path if we let the AI keep picking maxed tracks.
    const level = ctx.techLevels[p.techId] ?? 0;
    if (level >= TECH_MAX_LEVEL) continue;
    if (!canAffordTech(ctx, p.techId)) continue;
    // Diminishing returns: each level past 3 is half as valuable.
    // SCIENCE phase undoes the diminishing return because the goal IS
    // to complete every track regardless of marginal effect.
    const levelMod = ctx.phase === 'science'
      ? 1
      : (level < 3 ? 1 : (0.5 / (level - 2)));
    const cost = techCost(p.techId, level);
    const costShare = cost / Math.max(1, ctx.resources.science);
    let score = p.baseScore * levelMod - costShare * 1.5;
    // SCIENCE phase: bias toward whichever track is FURTHEST from max,
    // so the AI sweeps the whole tree instead of doubling down on one.
    if (ctx.phase === 'science') {
      const distanceFromMax = TECH_MAX_LEVEL - level;
      score += distanceFromMax * 0.2;
    }
    score *= ctx.weights.research;
    if (score <= 0) continue;
    out.push({
      kind: 'research',
      techId: p.techId,
      score,
      reason: `level ${level + 1} ${TECH_DEFS[p.techId].name}`,
    });
  }
  return out;
}

// === Collector network =======================================
//
// Without at least one collector, every settlement's stockpile is
// stranded — the empire pool never grows from harvests. AI's first
// settlement gets the free starting collector via singlePlayerSetup,
// but every subsequent settlement is a new logistics gap. This
// generator proposes collector builds at any owned settlement that
// doesn't have one, prioritizing settlements with stockpile sitting
// idle (high signal: we're losing income to lack of logistics).

function generateCollectorCandidates(ctx: AIContext): AIActionIntent[] {
  const out: AIActionIntent[] = [];
  // Affordability gate — costs are global per-build, not per-settlement.
  if (
    ctx.resources.ore < COLLECTOR_COST.ore ||
    ctx.resources.credits < COLLECTOR_COST.credits
  ) {
    return out;
  }
  for (const s of ctx.mySettlements) {
    if (s.hasCollector) continue;
    let score = 0;
    let reason = '';
    if (!ctx.hasAnyCollector) {
      // EMERGENCY: empire-wide stockpile is going nowhere. Top priority.
      score = 6;
      reason = `first collector — empire has no logistics yet`;
    } else {
      // Stockpile-driven: every settlement that's accumulating but
      // can't ship is a problem. Score scales with sitting stock.
      const stock = s.stockpile.fuel + s.stockpile.ore + s.stockpile.credits + s.stockpile.science;
      if (stock < 20) {
        // Negligible stockpile, low priority — keep the action queue
        // free for higher-value moves.
        continue;
      }
      score = 1 + Math.min(stock / 80, 3);
      reason = `unlock ${Math.round(stock)} stranded stock at ${s.name}`;
    }
    score *= ctx.weights.collectorBuild;
    // Cost penalty — collectors are pricey (150O + 100C).
    score -= (COLLECTOR_COST.ore / Math.max(1, ctx.resources.ore)) * 1.0;
    score -= (COLLECTOR_COST.credits / Math.max(1, ctx.resources.credits)) * 1.0;
    if (score <= SCORE_THRESHOLD) continue;
    out.push({ kind: 'build_collector', settlementId: s.id, score, reason });
  }
  return out;
}

// === Settlement upgrade buildings ============================
//
// Forge / Mint / Lab on cities; Weapons / Shipyard on stations.
// One in-flight upgrade per settlement (server + client both
// enforce). AI picks the best candidate per settlement and
// proposes upgrading to the next level, scored by:
//   - phase weight for that building category
//   - inverse cost share (cheaper upgrades preferred)
//   - existing level (diminishing returns past L3)

function generateBuildingCandidates(ctx: AIContext): AIActionIntent[] {
  const out: AIActionIntent[] = [];

  for (const s of ctx.mySettlements) {
    // Slot busy — server only accepts one upgrade at a time per settlement.
    if (s.buildingQueue) continue;

    const allowed: BuildingKind[] = s.type === 'city'
      ? ['forge', 'mint', 'lab']
      : ['weapons', 'shipyard'];

    for (const kind of allowed) {
      const level = buildingLevel(s, kind);
      const cost = buildingCostForNextLevel(kind, level);
      // Affordability
      if (
        ctx.resources.ore < cost.ore ||
        ctx.resources.credits < cost.credits
      ) continue;

      // Pick the phase weight that matches the building category.
      let weight = 1;
      let baseScore = 1;
      let reason = '';
      switch (kind) {
        case 'forge':
          weight = ctx.weights.yieldBuilding;
          baseScore = 1.5;
          reason = `forge L${level + 1} (+ore yield)`;
          break;
        case 'mint':
          weight = ctx.weights.yieldBuilding;
          baseScore = 1.5;
          reason = `mint L${level + 1} (+credits yield)`;
          break;
        case 'lab':
          weight = ctx.weights.scienceBuilding;
          baseScore = 1.4;
          reason = `lab L${level + 1} (+science yield)`;
          break;
        case 'weapons':
          weight = ctx.weights.weaponsBuilding;
          baseScore = 1.6;
          reason = `weapons L${level + 1} (+station damage)`;
          break;
        case 'shipyard':
          weight = ctx.weights.shipyardBuilding;
          baseScore = 1.4;
          reason = `shipyard L${level + 1} (+build slots)`;
          break;
      }

      // Diminishing returns past L3 so the AI doesn't keep dumping
      // ore into one forge forever.
      const levelMod = level < 3 ? 1 : (0.6 / (level - 2));

      // Cost share penalty
      const orePool = Math.max(1, ctx.resources.ore);
      const credPool = Math.max(1, ctx.resources.credits);
      const costShare = (cost.ore / orePool) + (cost.credits / credPool);

      let score = baseScore * levelMod * weight - costShare * 1.0;
      if (score <= SCORE_THRESHOLD) continue;

      out.push({
        kind: 'queue_building',
        settlementId: s.id,
        buildingKind: kind,
        score,
        reason: `${s.name}: ${reason}`,
      });
    }
  }
  return out;
}

// === Dyson Sphere ============================================
//
// One-shot per game. AI initiates if (a) it has a Sol station, (b) no
// sphere exists yet, and (c) the AI is in ENGINEERING phase (which
// triggers when the above two are true and no attack is in progress).
// The buildContext sets `mySolStations` and `dyson` for cheap lookups.

function generateDysonCandidates(ctx: AIContext): AIActionIntent[] {
  // Already controls the sphere — nothing to initiate.
  if (ctx.iControlDyson) return [];
  // A rival owns the slot — can't initiate.
  if (ctx.dyson) return [];
  // No Sol station — can't initiate either.
  if (ctx.mySolStations.length === 0) return [];

  // Pick the first eligible station as the foundation. Score reflects
  // the sphere being a long-game commitment — only fires meaningfully
  // in ENGINEERING phase where weights.dysonInitiate ≈ 5.
  const station = ctx.mySolStations[0];
  const score = 3.0 * ctx.weights.dysonInitiate;
  if (score <= SCORE_THRESHOLD) return [];
  return [{
    kind: 'initiate_dyson',
    settlementId: station.id,
    score,
    reason: `lay Dyson foundation at ${station.name}`,
  }];
}

// === Naming helpers ==========================================

const SHIP_NAME_POOLS: Record<ShipClassName, string[]> = {
  corvette: ['Lance', 'Sting', 'Razor', 'Falcon', 'Spear', 'Knife', 'Hawk', 'Dart', 'Talon'],
  frigate: ['Resolute', 'Vanguard', 'Hammer', 'Stalwart', 'Sentinel', 'Bulwark', 'Aegis', 'Defiant'],
  destroyer: ['Tyrant', 'Ironclad', 'Vengeance', 'Wrath', 'Citadel', 'Behemoth', 'Conqueror', 'Dreadnought'],
  freighter: ['Carryall', 'Caravan', 'Pioneer', 'Voyager', 'Drifter', 'Trader', 'Ferry', 'Skipper'],
};

function generateShipName(cls: ShipClassName, ctx: AIContext): string {
  const pool = SHIP_NAME_POOLS[cls];
  const existing = new Set(ctx.state.ships.map(s => s.name));
  const available = pool.filter(n => !existing.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  return `${pool[0]}-${Math.floor(Math.random() * 100)}`;
}

function generateSettlementName(type: 'city' | 'station', bodyName: string): string {
  const suffix = type === 'city' ? 'Outpost' : 'Yards';
  return `${bodyName} ${suffix}`;
}

// === Activity-feed messages ==================================

/** Compact 3-letter phase tag for the activity feed. */
function phaseTag(phase: AIPhase): string {
  switch (phase) {
    case 'expansion':   return 'EXP';
    case 'defense':     return 'DEF';
    case 'aggression':  return 'AGR';
    case 'engineering': return 'ENG';
    case 'science':     return 'SCI';
  }
}

function describeIntent(intent: AIActionIntent, ctx: AIContext): string {
  const tag = `[${phaseTag(ctx.phase)}]`;
  switch (intent.kind) {
    case 'build_ship': {
      const body = ctx.state.bodies.find(b => b.id === intent.bodyId);
      return `${tag} ${ctx.faction.name}: building ${intent.shipClass} "${intent.name}" at ${body?.name ?? intent.bodyId} (${intent.reason})`;
    }
    case 'deploy_settlement': {
      const body = ctx.state.bodies.find(b => b.id === intent.bodyId);
      const glyph = intent.settlementType === 'city' ? '■' : '◆';
      return `${tag} ${ctx.faction.name}: deploying ${glyph} "${intent.name}" on ${body?.name ?? intent.bodyId} (${intent.reason})`;
    }
    case 'transfer': {
      const ship = ctx.state.ships.find(s => s.id === intent.shipId);
      const target = ctx.state.bodies.find(b => b.id === intent.targetBodyId);
      // Transfer reason already includes the phase tag (see generator);
      // strip the duplicate so the message doesn't double up.
      const reason = intent.reason.replace(/^\[(EXP|DEF|AGR|ENG|SCI|expansion|defense|aggression|engineering|science)\]\s*/, '');
      return `${tag} ${ctx.faction.name}: ${ship?.name ?? 'ship'} → ${target?.name ?? intent.targetBodyId} — ${reason}`;
    }
    case 'research': {
      return `${tag} ${ctx.faction.name}: researching ${intent.reason}`;
    }
    case 'build_collector': {
      const settlement = ctx.state.settlements.find(s => s.id === intent.settlementId);
      return `${tag} ${ctx.faction.name}: building collector at ${settlement?.name ?? intent.settlementId} (${intent.reason})`;
    }
    case 'queue_building': {
      const settlement = ctx.state.settlements.find(s => s.id === intent.settlementId);
      return `${tag} ${ctx.faction.name}: upgrading ${intent.buildingKind} at ${settlement?.name ?? intent.settlementId} (${intent.reason})`;
    }
    case 'initiate_dyson': {
      const settlement = ctx.state.settlements.find(s => s.id === intent.settlementId);
      return `${tag} ${ctx.faction.name}: laying Dyson foundation at ${settlement?.name ?? intent.settlementId} (${intent.reason})`;
    }
    case 'idle':
      return `${tag} ${ctx.faction.name}: ${intent.reason}`;
  }
}

/**
 * Should this faction's AI run this tick?
 * Throttled to AI_DECISION_INTERVAL ticks past the last run.
 */
export function shouldRunAI(lastDecisionTick: number | undefined, currentTick: number): boolean {
  if (lastDecisionTick === undefined) return true;
  return currentTick - lastDecisionTick >= AI_DECISION_INTERVAL;
}
