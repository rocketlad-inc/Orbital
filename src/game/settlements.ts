// ============================================================
// Settlement System — Cities (on bodies) and Stations (in orbit)
// Extract body resources to a local stockpile that freighters carry away.
// ============================================================

import { Body, Settlement, SettlementType, Ship } from '../types';
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
  return {
    fuel: base.fuel * mult * typeMult.fuel,
    ore: base.ore * mult * typeMult.ore,
    credits: base.credits * mult * typeMult.credits,
    science: base.science * mult * typeMult.science,
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

    // Freighter offload: any of owner's freighters in orbit at this body
    // siphons stockpile into the global faction pool (per-tick, fast).
    const ownerFreighters = ships.filter(sh =>
      sh.ownedBy === s.ownedBy &&
      sh.class === 'freighter' &&
      !sh.transfer &&
      sh.orbit.parentBodyId === s.bodyId
    );

    if (ownerFreighters.length > 0 && (stockpile.fuel > 0 || stockpile.ore > 0 || stockpile.credits > 0 || stockpile.science > 0)) {
      // Lazily create a pool for owners we haven't seen yet (e.g. captured
      // settlements whose new owner has no entry in gameState.resources).
      if (!factionPools[s.ownedBy]) {
        factionPools[s.ownedBy] = { fuel: 0, ore: 0, credits: 0, science: 0 };
      }
      const pool = factionPools[s.ownedBy];
      // Each freighter carries up to 5 of each per tick
      const capacity = ownerFreighters.length * 5;
      const moveFuel = Math.min(stockpile.fuel, capacity);
      const moveOre = Math.min(stockpile.ore, capacity);
      const moveCredits = Math.min(stockpile.credits, capacity);
      const moveScience = Math.min(stockpile.science, capacity);

      pool.fuel += moveFuel;
      pool.ore += moveOre;
      pool.credits += moveCredits;
      pool.science += moveScience;

      stockpile = {
        fuel: stockpile.fuel - moveFuel,
        ore: stockpile.ore - moveOre,
        credits: stockpile.credits - moveCredits,
        science: stockpile.science - moveScience,
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
