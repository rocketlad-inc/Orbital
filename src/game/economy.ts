// ============================================================
// Economy System — Resource harvesting and production
// ============================================================

import { Body } from '../types';

export const HARVEST_INTERVAL = 10;  // ticks between harvests
export const PRODUCTION_MULTIPLIER = 1;  // can tune later

/**
 * Map body resource values to the 3-resource economy system.
 * Body resources (fuel, metal, gold, science) → player resources (fuel, ore, credits).
 */
export function bodyProductionRates(body: Body): { fuel: number; ore: number; credits: number } {
  const res = body.resources;
  if (!res) return { fuel: 0, ore: 0, credits: 0 };
  return {
    fuel: (res.fuel || 0) * PRODUCTION_MULTIPLIER,
    ore: (res.metal || 0) * PRODUCTION_MULTIPLIER,
    credits: ((res.gold || 0) + (res.science || 0)) * PRODUCTION_MULTIPLIER,
  };
}
