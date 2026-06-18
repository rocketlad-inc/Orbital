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


/**
 * When true, the renderer draws a single straight line from start
 * to end for each transit instead of the integrated torch curve.
 * Playtester feedback: the bendy curves were unreadable at zoom.
 * Set to false to restore the physics-accurate curve.
 */
export const STRAIGHT_LINE_TRAJECTORIES = true;
