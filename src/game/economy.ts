// ============================================================
// Economy System — Resource harvesting and production
// ============================================================

import { Body } from '../types';

export const HARVEST_INTERVAL = 10;  // ticks between harvests
export const PRODUCTION_MULTIPLIER = 1;  // can tune later

export interface ProductionBundle {
  fuel: number;
  ore: number;
  credits: number;
  science: number;
}

/**
 * Map body resource values to the 4-resource economy system.
 * Body raw resources (fuel, metal, gold, science) → player resources
 * (fuel, ore, credits, science). Note: science is its own resource now,
 * powering the tech tree.
 */
export function bodyProductionRates(body: Body): ProductionBundle {
  const res = body.resources;
  if (!res) return { fuel: 0, ore: 0, credits: 0, science: 0 };
  return {
    fuel: (res.fuel || 0) * PRODUCTION_MULTIPLIER,
    ore: (res.metal || 0) * PRODUCTION_MULTIPLIER,
    credits: (res.gold || 0) * PRODUCTION_MULTIPLIER,
    science: (res.science || 0) * PRODUCTION_MULTIPLIER,
  };
}
