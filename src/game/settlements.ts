// ============================================================
// Settlement System — Cities (on bodies) and Stations (in orbit)
// Extract body resources to a local stockpile that freighters carry away.
// ============================================================

import { Body, Settlement, SettlementType, Ship, BuildingKind, SettlementBuildOrder } from '../types';
import { createCircularOrbit, bodyPosition, localPositionAt } from '../physics/orbitalMechanics';
import { bodyProductionRates } from './economy';

/**
 * World position of a settlement at a given tick.
 * Cities sit on the surface of their host body (radius + surfaceAngle).
 * Stations follow their orbit around the host.
 */
export function settlementWorldPosition(
  settlement: Settlement,
  tick: number,
  bodies: Body[],
): { x: number; y: number } | null {
  const body = bodies.find(b => b.id === settlement.bodyId);
  if (!body) return null;
  const bodyPos = bodyPosition(body, tick, bodies);
  if (settlement.type === 'city') {
    const angle = settlement.surfaceAngle ?? 0;
    return {
      x: bodyPos.x + Math.cos(angle) * body.radius,
      y: bodyPos.y + Math.sin(angle) * body.radius,
    };
  }
  // Station
  if (!settlement.orbit) return bodyPos;
  const local = localPositionAt(settlement.orbit, tick);
  return { x: bodyPos.x + local.x, y: bodyPos.y + local.y };
}

// === Balance constants ===

/** Ticks between population growth (each adds +10% yield) */
export const GROWTH_INTERVAL = 100;

/** Multiplier added to base yield per population point */
export const YIELD_MULT_PER_POP = 0.1;

/** Ticks between resource extractions */
export const SETTLEMENT_HARVEST_INTERVAL = 10;

/** Default station orbit altitude (above body surface) */
export const STATION_ALTITUDE = 6;

/** Ticks between automatic collector drains. Every interval, each
 *  settlement bleeds a portion of its stockpile into the empire pool
 *  — IF the empire owns at least one collector somewhere. Without a
 *  collector the stockpile just keeps growing locally with nowhere to
 *  go. Default 25 ticks ≈ 3 game-hours at the standard 7.5-min cadence. */
export const COLLECTOR_AUTO_INTERVAL = 25;

/** Fraction of each settlement's stockpile that the collector network
 *  pulls into the empire pool every COLLECTOR_AUTO_INTERVAL. 0.5 = half
 *  the stockpile flows per cycle; freighter trade routes (future
 *  feature) layer a multiplier on top. */
export const COLLECTOR_BASE_DRAIN_FRACTION = 0.5;

/** Cost to build a collector at an existing settlement. Intentionally
 *  high — the strategic depth is "where do I plant my next collector
 *  to widen my income funnel?" */
export const COLLECTOR_COST = { fuel: 0, ore: 150, credits: 100 };

// === Settlement upgrade buildings ============================
//
// Each settlement can host buildings that compound its native output.
// Levels stack additively (`yield × (1 + level × perLevel)`), costs
// compound multiplicatively (`baseCost × scaling^level`), build times
// compound mildly. Soft-cap is natural — by L8 a Forge costs ~671c
// per level and takes ~9 real hours at the default 7.5-min cadence.
//
// City-only: forge / mint / lab (surface industry)
// Station-only: weapons / shipyard (orbital platforms)
//
// One in-flight upgrade per settlement. Forces the player to spread
// or specialize — pick a focus per colony rather than parallel-
// stacking the entire empire at once.

export interface BuildingDef {
  displayName: string;
  hostType: SettlementType;
  baseCost: { fuel: number; ore: number; credits: number };
  costScaling: number;     // cost = baseCost × costScaling^currentLevel
  baseBuildTicks: number;
  buildTimeScaling: number; // ticks = baseBuildTicks × buildTimeScaling^currentLevel
  description: string;
  // Effect descriptors — consumed by yield / combat / shipyard hooks.
  yieldBoost?: { resource: 'ore' | 'credits' | 'science'; perLevel: number };
  combatBoost?: { damagePerLevel: number };
  shipyardBoost?: { slotsPerLevel: number };
}

export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  forge: {
    displayName: 'Forge',
    hostType: 'city',
    baseCost: { fuel: 0, ore: 0, credits: 40 },
    costScaling: 1.6,
    baseBuildTicks: 20,
    buildTimeScaling: 1.3,
    description: '+25% ore output per level. Spends credits to compound this city\'s metal yield.',
    yieldBoost: { resource: 'ore', perLevel: 0.25 },
  },
  mint: {
    displayName: 'Mint',
    hostType: 'city',
    baseCost: { fuel: 0, ore: 40, credits: 0 },
    costScaling: 1.6,
    baseBuildTicks: 20,
    buildTimeScaling: 1.3,
    description: '+25% credits output per level. Spends ore to compound this city\'s coinage yield.',
    yieldBoost: { resource: 'credits', perLevel: 0.25 },
  },
  lab: {
    displayName: 'Lab',
    hostType: 'city',
    baseCost: { fuel: 0, ore: 30, credits: 30 },
    costScaling: 1.6,
    baseBuildTicks: 25,
    buildTimeScaling: 1.3,
    description: '+20% science output per level. Costs both raw stock and capital.',
    yieldBoost: { resource: 'science', perLevel: 0.20 },
  },
  weapons: {
    displayName: 'Weapons',
    hostType: 'station',
    baseCost: { fuel: 0, ore: 30, credits: 20 },
    costScaling: 1.6,
    baseBuildTicks: 30,
    buildTimeScaling: 1.3,
    description: '+4 damage/tick to hostile ships in range, per level.',
    combatBoost: { damagePerLevel: 4 },
  },
  shipyard: {
    displayName: 'Shipyard',
    hostType: 'station',
    baseCost: { fuel: 0, ore: 50, credits: 30 },
    costScaling: 1.7,
    baseBuildTicks: 40,
    buildTimeScaling: 1.3,
    description: '+1 simultaneous ship-build slot at this body, per level.',
    shipyardBoost: { slotsPerLevel: 1 },
  },
};

/** Returns the current level (or 0) of a building at this settlement. */
export function buildingLevel(s: Settlement, kind: BuildingKind): number {
  return s.buildings?.[kind] ?? 0;
}

/** Resource cost to advance a building from its current level to level+1. */
export function buildingCostForNextLevel(
  kind: BuildingKind, currentLevel: number,
): { fuel: number; ore: number; credits: number } {
  const def = BUILDING_DEFS[kind];
  const k = Math.pow(def.costScaling, currentLevel);
  return {
    fuel:    Math.ceil(def.baseCost.fuel    * k),
    ore:     Math.ceil(def.baseCost.ore     * k),
    credits: Math.ceil(def.baseCost.credits * k),
  };
}

/** Ticks required to construct the next level. */
export function buildingTimeForNextLevel(
  kind: BuildingKind, currentLevel: number,
): number {
  const def = BUILDING_DEFS[kind];
  return Math.ceil(def.baseBuildTicks * Math.pow(def.buildTimeScaling, currentLevel));
}

/** Aggregate shipyard slot count at a body from all owner stations. */
export function shipyardSlotsAtBody(
  bodyId: string,
  ownerId: string,
  settlements: Settlement[],
): number {
  let bonus = 0;
  for (const s of settlements) {
    if (s.bodyId !== bodyId) continue;
    if (s.ownedBy !== ownerId) continue;
    if (s.type !== 'station') continue;
    bonus += buildingLevel(s, 'shipyard');
  }
  // Base 1 slot — every body can build at least 1 ship at a time
  // even without a shipyard. Stations add `slotsPerLevel`/level.
  return 1 + bonus * (BUILDING_DEFS.shipyard.shipyardBoost?.slotsPerLevel ?? 1);
}

/** Per-settlement-type defaults */
export const SETTLEMENT_DEFS: Record<SettlementType, {
  maxHp: number;
  cost: { fuel: number; ore: number; credits: number };
  displayName: string;
  // Combat (defensive — settlements don't initiate, but fire on engagers in range)
  range: number;          // engagement range in world units
  damagePerTick: number;  // damage dealt to an attacker each COMBAT_DAMAGE_INTERVAL
  pdcRating: number;      // 0-1, reduces incoming damage
}> = {
  city: {
    maxHp: 200,
    cost: { fuel: 30, ore: 50, credits: 40 },
    displayName: 'City',
    range: 8,        // ground-based PDC, short range
    damagePerTick: 6,
    pdcRating: 0.3,
  },
  station: {
    maxHp: 100,
    cost: { fuel: 50, ore: 30, credits: 60 },
    displayName: 'Station',
    range: 12,       // orbital weapons platform, medium range
    damagePerTick: 8,
    pdcRating: 0.5,
  },
};

// === Body type rules ===

/** Cities can only be built on solid surfaces */
export function canHostCity(body: Body): boolean {
  return body.type === 'terrestrial' || body.type === 'moon' || body.type === 'dwarf';
}

/** Stations can orbit anything that isn't a star */
export function canHostStation(body: Body): boolean {
  return body.type !== 'star';
}

// === Factory functions ===

let _nameCounter = 0;
function nextSettlementName(type: SettlementType, body: Body): string {
  _nameCounter += 1;
  const prefix = type === 'city' ? body.name : `${body.name} Stn`;
  return `${prefix}-${_nameCounter}`;
}

export function createCity(
  body: Body,
  ownerId: string,
  tick: number,
  name?: string,
): Settlement {
  const def = SETTLEMENT_DEFS.city;
  return {
    id: `settlement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'city',
    name: name?.trim() || nextSettlementName('city', body),
    bodyId: body.id,
    ownedBy: ownerId,
    hp: def.maxHp,
    maxHp: def.maxHp,
    population: 1,
    lastGrowthTick: tick,
    surfaceAngle: Math.random() * Math.PI * 2,
    stockpile: { fuel: 0, ore: 0, credits: 0, science: 0 },
    lastHarvestTick: tick,
  };
}

export function createStation(
  body: Body,
  ownerId: string,
  tick: number,
  bodies: Body[],
  name?: string,
): Settlement {
  const def = SETTLEMENT_DEFS.station;
  const altitude = body.radius + STATION_ALTITUDE;
  return {
    id: `settlement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'station',
    name: name?.trim() || nextSettlementName('station', body),
    bodyId: body.id,
    ownedBy: ownerId,
    hp: def.maxHp,
    maxHp: def.maxHp,
    population: 1,
    lastGrowthTick: tick,
    orbit: createCircularOrbit(body.id, altitude, tick, bodies),
    stockpile: { fuel: 0, ore: 0, credits: 0, science: 0 },
    lastHarvestTick: tick,
  };
}

/**
 * Suggest a default name for a new settlement based on body and existing count.
 */
export function suggestSettlementName(
  body: Body,
  type: SettlementType,
  existing: Settlement[],
): string {
  const countAtBody = existing.filter(s => s.bodyId === body.id && s.type === type).length;
  const suffix = type === 'city' ? 'City' : 'Station';
  if (countAtBody === 0) return `${body.name} ${suffix}`;
  return `${body.name} ${suffix} ${countAtBody + 1}`;
}

// === Yield ===

/**
 * Per-tick resource generation for a settlement at its body, factoring in
 * population multiplier and harvest interval scaling.
 */
export function settlementYield(
  settlement: Settlement,
  body: Body,
): { fuel: number; ore: number; credits: number; science: number } {
  if (body.id !== settlement.bodyId) return { fuel: 0, ore: 0, credits: 0, science: 0 };
  const base = bodyProductionRates(body);
  const mult = 1 + YIELD_MULT_PER_POP * (settlement.population - 1);
  // Stations boost science (orbital research platforms), cities boost ore.
  const typeMult = settlement.type === 'city'
    ? { fuel: 1.0, ore: 1.2, credits: 1.0, science: 0.8 }
    : { fuel: 1.1, ore: 0.8, credits: 1.0, science: 1.4 };

  // Building multipliers — city Forge/Mint/Lab compound the matching
  // resource. Stations don't host yield buildings, so these are 0 there.
  const forgeMul   = 1 + buildingLevel(settlement, 'forge') * (BUILDING_DEFS.forge.yieldBoost?.perLevel ?? 0);
  const mintMul    = 1 + buildingLevel(settlement, 'mint')  * (BUILDING_DEFS.mint.yieldBoost?.perLevel  ?? 0);
  const labMul     = 1 + buildingLevel(settlement, 'lab')   * (BUILDING_DEFS.lab.yieldBoost?.perLevel   ?? 0);

  return {
    fuel:    base.fuel    * mult * typeMult.fuel,
    ore:     base.ore     * mult * typeMult.ore     * forgeMul,
    credits: base.credits * mult * typeMult.credits * mintMul,
    science: base.science * mult * typeMult.science * labMul,
  };
}

// === Tick logic ===

/**
 * Advance settlement state for one tick step.
 * - Grows population every GROWTH_INTERVAL ticks
 * - Extracts resources into local stockpile every SETTLEMENT_HARVEST_INTERVAL ticks
 * - Offloads stockpile to faction pool when freighters are at the body
 *
 * Returns updated settlements list. Mutates passed `factionPools` reference
 * to add offloaded resources.
 */
export function tickSettlements(
  settlements: Settlement[],
  bodies: Body[],
  ships: Ship[],
  tick: number,
  factionPools: Record<string, { fuel: number; ore: number; credits: number; science: number }>,
  /** Optional per-faction settlement-yield multiplier (Industry tech). Default 1.0. */
  yieldMul: Record<string, number> = {},
): { settlements: Settlement[]; changed: boolean } {
  let changed = false;
  const yieldMulOf = (fid: string) => yieldMul[fid] ?? 1;

  // Pre-compute "does this faction have any active collector?" so we
  // don't re-scan the settlements list inside the per-settlement loop
  // below. Capitals start with a free collector (see singlePlayerSetup);
  // every other one has to be built explicitly via buildCollector.
  const hasCollectorByFaction: Record<string, boolean> = {};
  for (const s of settlements) {
    if (s.hasCollector) hasCollectorByFaction[s.ownedBy] = true;
  }

  const updated = settlements.map(s => {
    let pop = s.population;
    let lastGrowth = s.lastGrowthTick;
    let stockpile = s.stockpile;
    let lastHarvest = s.lastHarvestTick;
    let dirty = false;

    // Growth
    if (tick - lastGrowth >= GROWTH_INTERVAL) {
      pop = pop + 1;
      lastGrowth = tick;
      dirty = true;
    }

    // Extraction
    if (tick - lastHarvest >= SETTLEMENT_HARVEST_INTERVAL) {
      const body = bodies.find(b => b.id === s.bodyId);
      if (body) {
        const y = settlementYield({ ...s, population: pop }, body);
        const m = yieldMulOf(s.ownedBy);
        stockpile = {
          fuel: stockpile.fuel + y.fuel * m,
          ore: stockpile.ore + y.ore * m,
          credits: stockpile.credits + y.credits * m,
          science: stockpile.science + y.science * m,
        };
        lastHarvest = tick;
        dirty = true;
      }
    }

    // Collector-network drain. Stockpile flows to the empire pool only
    // if the owning faction has at least one collector somewhere — the
    // capital starts with one, every other has to be built. Without a
    // collector, the stockpile keeps building locally with nowhere to
    // go. This is the strategic depth lever: each new collector
    // widens your logistics funnel.
    //
    // Drain cadence is COLLECTOR_AUTO_INTERVAL ticks; per cycle we
    // pull COLLECTOR_BASE_DRAIN_FRACTION of whatever's sitting in
    // stockpile. The remaining fraction stays put — so a stockpile
    // smoothly bleeds toward the pool over multiple cycles, which
    // reads as "trickle in" on the HUD's per-tick income meter rather
    // than "everything teleports the moment you build the collector."
    //
    // Future hook (next turn): a freighter on an active TradeRoute from
    // this settlement → a collector multiplies the drain fraction by
    // (1 + flight_tech_bonus). For now the rate is uniform.
    const hasStock = stockpile.fuel > 0 || stockpile.ore > 0 || stockpile.credits > 0 || stockpile.science > 0;
    if (hasStock && hasCollectorByFaction[s.ownedBy]) {
      // Per-tick drain step = base fraction / interval. Over the full
      // interval this delivers ~50% of the current stockpile to the
      // pool; spread across every tick instead of bursting once per
      // cycle so the income meter feels live.
      const perTickFraction = COLLECTOR_BASE_DRAIN_FRACTION / COLLECTOR_AUTO_INTERVAL;
      const move = {
        fuel:    stockpile.fuel    * perTickFraction,
        ore:     stockpile.ore     * perTickFraction,
        credits: stockpile.credits * perTickFraction,
        science: stockpile.science * perTickFraction,
      };
      if (!factionPools[s.ownedBy]) {
        factionPools[s.ownedBy] = { fuel: 0, ore: 0, credits: 0, science: 0 };
      }
      const pool = factionPools[s.ownedBy];
      pool.fuel    += move.fuel;
      pool.ore     += move.ore;
      pool.credits += move.credits;
      pool.science += move.science;
      stockpile = {
        fuel:    stockpile.fuel    - move.fuel,
        ore:     stockpile.ore     - move.ore,
        credits: stockpile.credits - move.credits,
        science: stockpile.science - move.science,
      };
      dirty = true;
    }

    if (dirty) {
      changed = true;
      return {
        ...s,
        population: pop,
        lastGrowthTick: lastGrowth,
        stockpile,
        lastHarvestTick: lastHarvest,
      };
    }
    return s;
  });

  return { settlements: updated, changed };
}

/**
 * Apply damage to a settlement. Returns updated settlement or null if destroyed.
 */
export function damageSettlement(s: Settlement, dmg: number): Settlement | null {
  const newHp = s.hp - dmg;
  if (newHp <= 0) return null;
  return { ...s, hp: newHp };
}

// === Income summary (HUD) ===

/**
 * Per-tick income summary for a faction.
 *
 * Yield falls into one of two buckets:
 *   - delivered: settlements whose stockpile drains to the pool (the
 *     faction owns at least one collector somewhere)
 *   - stranded:  yield that's piling up at settlements with no
 *     collector network to receive it. Surfaces as a warning so
 *     players know they need to build a collector — high-cost, but
 *     they're losing all this throughput until they do.
 *
 * settlementYield returns the full-cycle output and harvest fires once
 * per SETTLEMENT_HARVEST_INTERVAL ticks, so we divide by that to get a
 * smooth per-tick number for the HUD.
 */
export interface IncomePerTick {
  delivered: { fuel: number; ore: number; credits: number; science: number };
  stranded:  { fuel: number; ore: number; credits: number; science: number };
  /** Aggregate of stockpile sitting at the player's settlements right
   *  now — surfaced when stranded > 0 so the HUD can hint "you have
   *  X credits waiting; build a collector to claim them." */
  waiting:   { fuel: number; ore: number; credits: number; science: number };
  settlementCount: number;
  collectorCount: number;
  /** True if the faction has at least one collector. When false the
   *  HUD switches into "build a collector" warning mode. */
  hasCollector: boolean;
}

export function computeIncomePerTick(
  factionId: string,
  settlements: Settlement[],
  bodies: Body[],
  // ships parameter retained for signature stability (older callers and
  // future use cases like ship-maintenance drain). Currently unused.
  _ships: Ship[],
  yieldMul: number = 1,
): IncomePerTick {
  const zero = () => ({ fuel: 0, ore: 0, credits: 0, science: 0 });
  const out: IncomePerTick = {
    delivered: zero(), stranded: zero(), waiting: zero(),
    settlementCount: 0, collectorCount: 0, hasCollector: false,
  };
  const mine = settlements.filter(s => s.ownedBy === factionId);
  out.hasCollector = mine.some(s => s.hasCollector);
  for (const s of mine) {
    out.settlementCount += 1;
    if (s.hasCollector) out.collectorCount += 1;
    const body = bodies.find(b => b.id === s.bodyId);
    if (!body) continue;
    const y = settlementYield(s, body);
    const perTick = {
      fuel:    (y.fuel    * yieldMul) / SETTLEMENT_HARVEST_INTERVAL,
      ore:     (y.ore     * yieldMul) / SETTLEMENT_HARVEST_INTERVAL,
      credits: (y.credits * yieldMul) / SETTLEMENT_HARVEST_INTERVAL,
      science: (y.science * yieldMul) / SETTLEMENT_HARVEST_INTERVAL,
    };
    const bucket = out.hasCollector ? out.delivered : out.stranded;
    bucket.fuel    += perTick.fuel;
    bucket.ore     += perTick.ore;
    bucket.credits += perTick.credits;
    bucket.science += perTick.science;
    out.waiting.fuel    += s.stockpile.fuel;
    out.waiting.ore     += s.stockpile.ore;
    out.waiting.credits += s.stockpile.credits;
    out.waiting.science += s.stockpile.science;
  }
  return out;
}
