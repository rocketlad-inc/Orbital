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
  GameState, Ship, Settlement, FactionResources,
} from '../types';
import { ShipClassName, SHIP_CLASSES, BUILDABLE_CLASSES } from './shipClasses';
import { SETTLEMENT_DEFS, canHostCity, canHostStation } from './settlements';
import { TechId, TECH_DEFS } from './techs';
import { FUEL_ENABLED } from './featureFlags';

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
// The AI moves through three phases based on its current footprint
// and threats. Each phase applies different weight multipliers to
// the utility-scored candidate actions, so the same brain naturally
// shifts focus:
//
//   EXPANSION → bias build/deploy/transfer-freighter, suppress combat
//   DEFENSE   → bias combat-ship builds + transfers to own bodies,
//               suppress expansion and offensive transfers
//   AGGRESSION → bias destroyer builds + transfers to enemy bodies
//
// Phase is recomputed each cycle from raw state, so the AI can fall
// back from AGGRESSION to DEFENSE if a colony comes under attack, or
// back to EXPANSION if its colonies are wiped out.

export type AIPhase = 'expansion' | 'defense' | 'aggression';

/** Minimum colonies (distinct settled bodies) before the AI even
 *  considers leaving expansion phase. First goal is more colonies. */
const EXPANSION_TARGET_COLONIES = 2;

/** Minimum combat ships parked at each owned body before defense
 *  phase considers itself "complete" and graduates to aggression. */
const DEFENSE_SHIPS_PER_BODY = 1;

interface PhaseWeights {
  // Build category multipliers — applied to per-class build scores
  freighterBuild: number;
  combatShipBuild: number;
  destroyerBuild: number;    // separate so aggression can prefer heavies
  // Deploy multiplier
  settlementDeploy: number;
  // Transfer multipliers
  freighterTransfer: number; // sending a freighter to colonize
  transferToOwn: number;     // sending a combat ship to defend my body
  transferToEnemy: number;   // sending a combat ship to attack an enemy body
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
  },
};

// === Public API ==============================================

export type AIActionIntent =
  | { kind: 'build_ship'; bodyId: string; shipClass: ShipClassName; name: string; score: number; reason: string }
  | { kind: 'deploy_settlement'; bodyId: string; settlementType: 'city' | 'station'; name: string; score: number; reason: string }
  | { kind: 'transfer'; shipId: string; targetBodyId: string; score: number; reason: string }
  | { kind: 'research'; techId: TechId; score: number; reason: string }
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

  // Faction's stuff
  myShips: Ship[];                    // all ships I own
  myShipsIdle: Ship[];                // not in transfer or pending
  myFreightersIdle: Ship[];           // for settlement deploys
  myCombatShipsIdle: Ship[];          // corvettes/frigates/destroyers not busy
  mySettlements: Settlement[];
  myStations: Settlement[];           // shipyards
  myActiveBuildBodyIds: Set<string>;  // bodies currently constructing a ship

  // World
  ownedBodyIds: Set<string>;          // bodies I have a settlement on
  hostileShips: Ship[];               // any ship not owned by me
  bodyIdToHostileShips: Map<string, Ship[]>;  // for threat assessment

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

  const myShips = state.ships.filter(s => s.ownedBy === factionId);
  const myShipsIdle = myShips.filter(s => !s.transit && !s.plannedTransit);
  const myFreightersIdle = myShipsIdle.filter(s => s.class === 'freighter');
  const myCombatShipsIdle = myShipsIdle.filter(s => s.class !== 'freighter');

  const mySettlements = state.settlements.filter(s => s.ownedBy === factionId);
  const myStations = mySettlements.filter(s => s.type === 'station');

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

  const phase = determinePhase(mySettlements, myShips, bodyIdToHostileShips);

  return {
    factionId,
    faction: { name: faction.name, color: faction.color },
    state,
    tick,
    resources,
    techLevels,
    myShips,
    myShipsIdle,
    myFreightersIdle,
    myCombatShipsIdle,
    mySettlements,
    myStations,
    myActiveBuildBodyIds,
    ownedBodyIds,
    hostileShips,
    bodyIdToHostileShips,
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

  // === 1. Freighter colonization runs ===
  // Send freighters to high-yield bodies we don't already settle. Phase
  // weight here is the difference between aggressive colonization
  // (expansion) and merely topping up a supply chain (aggression).
  for (const freighter of ctx.myFreightersIdle.slice(0, 1)) {
    const candidates = ctx.state.bodies.filter(b => {
      if (b.type === 'star') return false;
      if (b.id === freighter.orbit.parentBodyId) return false;
      if (ctx.ownedBodyIds.has(b.id)) return false;
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

  // Don't research if we have nothing else going on — keep science for later.
  if (ctx.resources.science < 30) return out;

  // Already researching something? Skip — single track at a time for v1.
  const tech = ctx.state.factionTech?.[ctx.factionId];
  if (tech?.researching) return out;

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
    if (!canAffordTech(ctx, p.techId)) continue;
    const level = ctx.techLevels[p.techId] ?? 0;
    // Diminishing returns: each level past 3 is half as valuable
    const levelMod = level < 3 ? 1 : (0.5 / (level - 2));
    const cost = techCost(p.techId, level);
    const costShare = cost / Math.max(1, ctx.resources.science);
    const score = p.baseScore * levelMod - costShare * 1.5;
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

// === Naming helpers ==========================================

const SHIP_NAME_POOLS: Record<ShipClassName, string[]> = {
  corvette: ['Lance', 'Sting', 'Razor', 'Falcon', 'Spear', 'Knife', 'Hawk', 'Dart', 'Talon'],
  frigate: ['Resolute', 'Vanguard', 'Hammer', 'Stalwart', 'Sentinel', 'Bulwark', 'Aegis', 'Defiant'],
  destroyer: ['Tyrant', 'Ironclad', 'Vengeance', 'Wrath', 'Citadel', 'Behemoth', 'Conqueror', 'Dreadnought'],
  freighter: ['Carryall', 'Hauler', 'Caravan', 'Pioneer', 'Voyager', 'Drifter', 'Trader', 'Ferry'],
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
    case 'expansion':  return 'EXP';
    case 'defense':    return 'DEF';
    case 'aggression': return 'AGR';
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
      const reason = intent.reason.replace(/^\[(EXP|DEF|AGR|expansion|defense|aggression)\]\s*/, '');
      return `${tag} ${ctx.faction.name}: ${ship?.name ?? 'ship'} → ${target?.name ?? intent.targetBodyId} — ${reason}`;
    }
    case 'research': {
      return `${tag} ${ctx.faction.name}: researching ${intent.reason}`;
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
