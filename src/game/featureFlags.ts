// Gameplay feature flags. Keep this file tiny — one boolean per flag,
// no logic. Importers should pull only the flags they need so TS can
// dead-code-eliminate the disabled branches.

/**
 * When true, ship orders + builds consume fuel (and AI factions plan
 * around it). When false, fuel costs are ignored.
 *
 * FALSE since the Identity & Economy rework (§1.1): fuel left the
 * economy — yields zeroed, all costs 0, no UI surface shows it. Every
 * check this flag guards is vacuous anyway (cost.fuel === 0
 * everywhere); false documents the intent. Do not flip back without
 * restoring fuel yields + costs + UI.
 */
export const FUEL_ENABLED = false;


/**
 * When true, the renderer draws a single straight line from start
 * to end for each transit instead of the integrated torch curve.
 * Playtester feedback: the bendy curves were unreadable at zoom.
 * Set to false to restore the physics-accurate curve.
 */
export const STRAIGHT_LINE_TRAJECTORIES = true;
