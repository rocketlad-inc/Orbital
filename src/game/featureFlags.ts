// Gameplay feature flags. Keep this file tiny — one boolean per flag,
// no logic. Importers should pull only the flags they need so TS can
// dead-code-eliminate the disabled branches.

/**
 * When true, ship orders + builds consume fuel (and AI factions plan
 * around it). When false, fuel costs are ignored — useful for tests
 * and for early playtesting where the fuel economy isn't tuned yet.
 *
 * Production default: true. Matches what resource pills, refueling,
 * and the maintenance loop all assume.
 */
export const FUEL_ENABLED = true;
