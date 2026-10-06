// ============================================================
// THE DANCE — where Centauri's two suns are in their cycle.
//
// A and B ride matching ellipses about the barycenter (factions.js), so
// how close they are is one number from A's own orbit: 1 at periastron
// (2520 apart, live), 0 at apastron (3780). It drives the station bonus for the
// worlds that orbit one sun (systems.js stationTypeMul): x1.5 when the
// suns are furthest apart, rising to x3 as they swing in.
//
// Computed from the star's ROW with the same Kepler solve that places it
// on the map (transitCombat.eccentricLocalPosition), so the bonus and the
// picture can never disagree. Client copy: src/game/farSystems.ts
// binaryClosenessFrom, held to this by farSystems.test.
// ============================================================

import { eccentricLocalPosition, isEccentric } from './transitCombat.js';
import { ORBITAL_SPEED_SCALE } from './orbitPos.js';

/** 0 (suns furthest apart) .. 1 (closest), from Centauri A's orbit row.
 *  A sun on a circle (an old game, or the dance turned off) is 0.5. */
export function binaryCloseness(starRow, tick) {
  if (!starRow || !isEccentric(starRow)) return 0.5;
  const rp = Number(starRow.orbit_rp), ra = Number(starRow.orbit_ra);
  const p = eccentricLocalPosition(starRow, tick, ORBITAL_SPEED_SCALE);
  const r = Math.hypot(p.x, p.y);
  return Math.max(0, Math.min(1, (ra - r) / (ra - rp)));
}

/** Centauri A's orbit row for a game, or null. One indexed read. */
export async function binaryStarRow(env, gameId) {
  return env.DB
    .prepare(`SELECT orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_period
                FROM game_bodies
               WHERE game_id = ? AND template_id = 'centauri_a' AND destroyed_at_tick IS NULL`)
    .bind(gameId).first();
}
