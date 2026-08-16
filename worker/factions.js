import { summarizeSystems } from './systems.js';
import { DEFAULT_LOADOUTS } from './shipDesigns.js';
import { gatingEnabled, factionTechLevels, hasFeature } from './researchUnlocks.js';
import { isEmblemId, defaultEmblemFor } from './emblems.js';
// ============================================================================
// Faction agent module.
//
// Exports:
//   - routes:          feature-route table consumed by worker.js dispatcher.
//   - seedGameWorld:   called by the Lobby agent once a game has been created
//                      with status='setup'. Seeds bodies, factions, capitals,
//                      flips status to 'active', and writes a chronicle entry.
//
// All gameplay rows key off `game_factions.id` (not user_id), per the schema
// header in migrations/0003_game_state.sql.
// ============================================================================

import { verifyPassword } from './auth.js';

// ---------- static catalog ----------
//
// Mirror of src/state/mockGameState.ts SHARED_BODIES — the actual real
// solar system bodies the client renderer expects (and that match what
// players see in single-player). Server-side `type` uses kebab-case;
// MultiplayerGameProvider.mapBodyType converts to the client's
// underscore form.
//
// Catalog order matters: parents must come before their children since
// the batch insert relies on the parent body row already existing for FK.
const TWO_PI = 2 * Math.PI;
const BODY_CATALOG = [
  // ---- system primary ----
  { id: 'sol', name: 'Sol', type: 'star', parent: null,
    radius: 10, soi: null, mu: 0,
    orbit_radius: 0, orbit_period: 0, angle0: 0,
    color: '#ffd180',
    yield: { metal: 0, fuel: 0, gold: 0, science: 0 } },

  // ---- inner terrestrials ----
  // Scaled up ~1.4x on orbit and ~1.8x on SOI to give ships room to
  // orbit without overlapping moons. Periods recomputed per Kepler.
  { id: 'mercury', name: 'Mercury', type: 'terrestrial', parent: 'sol',
    radius: 2, soi: 22, mu: 50,
    orbit_radius: 72, orbit_period: 49, angle0: 4.40,
    color: '#8c8680',
    yield: { metal: 2, fuel: 0, gold: 4, science: 1 } },
  { id: 'venus', name: 'Venus', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 43, mu: 150,
    orbit_radius: 134, orbit_period: 126, angle0: 3.18,
    color: '#e8cda0',
    yield: { metal: 1, fuel: 0, gold: 3, science: 4 } },
  { id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 54, mu: 100,
    orbit_radius: 186, orbit_period: 205, angle0: 1.75,
    color: '#4a90d9',
    yield: { metal: 2, fuel: 0, gold: 6, science: 3 } },
  { id: 'luna', name: 'Luna', type: 'moon', parent: 'earth',
    radius: 1.5, soi: 8, mu: 5,
    orbit_radius: 20, orbit_period: TWO_PI * Math.sqrt(8000 / 100), angle0: 0,
    color: '#c0c0c0',
    yield: { metal: 2, fuel: 0, gold: 2, science: 2 } },
  { id: 'mars', name: 'Mars', type: 'terrestrial', parent: 'sol',
    radius: 2.5, soi: 43, mu: 80,
    orbit_radius: 283, orbit_period: 386, angle0: 6.20,
    color: '#c1440e',
    yield: { metal: 4, fuel: 0, gold: 2, science: 2 } },
  // Mars's two captured rocks. Orbits keep the real ~2.4:1 spacing and
  // both sit clear of the ship-orbit envelope (ships park at 1.5-2.0x
  // body radius = 5 here) and well inside Mars's SOI of 43 — the same
  // two constraints that pushed Luna out to 20.
  //
  // Yields stay deliberately small: they're a few km of rubble, and the
  // inner region's identity in the yield table is credits-with-a-metal-
  // deficit, so two new metal sources here would blunt exactly the
  // scarcity that makes inner players trade for Belt ore.
  { id: 'phobos', name: 'Phobos', type: 'moon', parent: 'mars',
    radius: 0.8, soi: 2, mu: 0.5,
    orbit_radius: 8, orbit_period: TWO_PI * Math.sqrt(512 / 80), angle0: 0.5,
    color: '#6e6259',
    yield: { metal: 1, fuel: 0, gold: 2, science: 1 } },
  { id: 'deimos', name: 'Deimos', type: 'moon', parent: 'mars',
    radius: 0.7, soi: 2, mu: 0.5,
    orbit_radius: 19, orbit_period: TWO_PI * Math.sqrt(6859 / 80), angle0: 3.9,
    color: '#7a6d62',
    yield: { metal: 1, fuel: 0, gold: 1, science: 2 } },

  // ---- asteroid belt ----
  // Five bodies share the 310-radius orbit, 72° apart (Ceres at 1.20 rad,
  // each subsequent body adds ~1.257 rad / 72°). Players can hop between
  // them for resource extraction without crossing the gap to Mars/Jupiter.
  { id: 'ceres', name: 'Ceres', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 0.5,
    orbit_radius: 360, orbit_period: 555, angle0: 1.20,
    color: '#6b6b6b',
    yield: { metal: 6, fuel: 0, gold: 3, science: 0 } },
  { id: 'vesta', name: 'Vesta', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.3,
    orbit_radius: 360, orbit_period: 555, angle0: 2.46,
    color: '#a89888',
    yield: { metal: 7, fuel: 0, gold: 1, science: 0 } },
  { id: 'pallas', name: 'Pallas', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.25,
    orbit_radius: 360, orbit_period: 555, angle0: 3.71,
    color: '#80706a',
    yield: { metal: 6, fuel: 0, gold: 2, science: 0 } },
  { id: 'hygiea', name: 'Hygiea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2,
    orbit_radius: 360, orbit_period: 555, angle0: 4.97,
    color: '#75655a',
    yield: { metal: 6, fuel: 0, gold: 1, science: 0 } },
  { id: 'juno', name: 'Juno', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2,
    orbit_radius: 360, orbit_period: 555, angle0: 6.23,
    color: '#aa9070',
    yield: { metal: 5, fuel: 0, gold: 3, science: 0 } },

  // ---- rogue asteroids (settable; can host Trajectory Control Thrusters) ----
  //
  // ROGUE = FAST. Every period below is HALF the Kepler-consistent value
  // for its orbit radius, so these rocks sweep past at 2x the speed of a
  // planet at the same distance (Lorne). Motion is driven purely by
  // orbit_period — client bodyPosition, the server's intercept solver
  // (room.js), and the Kepler path for the eccentric Kuiper trio all read
  // the same field — so halving it is the whole change. It also makes
  // them genuinely hard to catch, which is the point of a body you have
  // to chase down and claim.
  // Three belt-class entries interspersed with the existing dwarfs, plus
  // three Kuiper-class with long elliptical paths. Rich in metal + credits
  // to reward the early grab; sparse on fuel/science so they don't strictly
  // dominate planet/moon real estate.
  { id: 'midas', name: 'Midas', type: 'asteroid', parent: 'sol',
    radius: 0.6, soi: 2, mu: 0.04,
    orbit_radius: 345, orbit_period: 262.5, angle0: 0.4,
    color: '#c8a872',
    yield: { metal: 7, fuel: 0, gold: 5, science: 0 } },
  { id: 'styx_rock', name: 'Styx', type: 'asteroid', parent: 'sol',
    radius: 0.6, soi: 2, mu: 0.04,
    orbit_radius: 370, orbit_period: 292, angle0: 3.0,
    color: '#7a6858',
    yield: { metal: 8, fuel: 0, gold: 3, science: 0 } },
  { id: 'iron_anna', name: 'Iron Anna', type: 'asteroid', parent: 'sol',
    radius: 0.7, soi: 2, mu: 0.05,
    orbit_radius: 390, orbit_period: 316, angle0: 5.1,
    color: '#9a7a5a',
    yield: { metal: 9, fuel: 0, gold: 2, science: 0 } },
  // Kuiper-class — eccentric. rp brings them through inner system on
  // perihelion; ra puts them way past Pluto. Inserter must populate
  // game_bodies.orbit_rp/ra/omega/m0 so bodyPosition uses Kepler.
  { id: 'black_sky', name: 'Black Sky', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03,
    orbit_radius: 1100, orbit_period: 1480, angle0: 0,
    orbit_rp: 200, orbit_ra: 2000, orbit_omega: 0.4, orbit_m0: 1.2,
    color: '#3a3030',
    yield: { metal: 3, fuel: 0, gold: 6, science: 1 } },
  { id: 'vagrant', name: 'Vagrant', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03,
    orbit_radius: 1450, orbit_period: 2235, angle0: 0,
    orbit_rp: 250, orbit_ra: 2650, orbit_omega: 2.1, orbit_m0: 4.7,
    color: '#5a4838',
    yield: { metal: 2, fuel: 0, gold: 7, science: 1 } },
  { id: 'augustin', name: 'Augustín', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03,
    orbit_radius: 1900, orbit_period: 3330, angle0: 0,
    orbit_rp: 300, orbit_ra: 3500, orbit_omega: 4.6, orbit_m0: 3.1,
    color: '#6a5040',
    yield: { metal: 2, fuel: 0, gold: 6, science: 2 } },

  // ---- gas giants ----
  { id: 'jupiter', name: 'Jupiter', type: 'gas-giant', parent: 'sol',
    radius: 8, soi: 160, mu: 1000,
    orbit_radius: 460, orbit_period: 800, angle0: 0.60,
    color: '#d4a574',
    yield: { metal: 1, fuel: 0, gold: 9, science: 2 } },
  { id: 'io', name: 'Io', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5,
    orbit_radius: 22, orbit_period: TWO_PI * Math.sqrt(10648 / 1000), angle0: 0,
    color: '#e8d44d',
    yield: { metal: 2, fuel: 0, gold: 5, science: 1 } },
  { id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5,
    orbit_radius: 34, orbit_period: TWO_PI * Math.sqrt(39304 / 1000), angle0: 1.57,
    color: '#b8c8d8',
    yield: { metal: 1, fuel: 0, gold: 4, science: 3 } },
  { id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 8,
    orbit_radius: 50, orbit_period: TWO_PI * Math.sqrt(125000 / 1000), angle0: 3.14,
    color: '#8a7e72',
    yield: { metal: 2, fuel: 0, gold: 5, science: 2 } },
  { id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 6,
    orbit_radius: 75, orbit_period: TWO_PI * Math.sqrt(421875 / 1000), angle0: 4.71,
    color: '#5a5a5a',
    yield: { metal: 3, fuel: 0, gold: 4, science: 1 } },

  { id: 'saturn', name: 'Saturn', type: 'gas-giant', parent: 'sol',
    radius: 7, soi: 140, mu: 600,
    orbit_radius: 843.2, orbit_period: 1987, angle0: 0.87,
    color: '#e8d5a3',
    yield: { metal: 9, fuel: 0, gold: 1, science: 2 } },
  { id: 'enceladus', name: 'Enceladus', type: 'moon', parent: 'saturn',
    radius: 1, soi: 3, mu: 2,
    orbit_radius: 20, orbit_period: TWO_PI * Math.sqrt(8000 / 600), angle0: 0,
    color: '#f0f0f0',
    yield: { metal: 5, fuel: 0, gold: 0, science: 3 } },
  { id: 'rhea', name: 'Rhea', type: 'moon', parent: 'saturn',
    radius: 1.5, soi: 4, mu: 4,
    orbit_radius: 37, orbit_period: TWO_PI * Math.sqrt(50653 / 600), angle0: 2.09,
    color: '#a0a0a0',
    yield: { metal: 6, fuel: 0, gold: 1, science: 1 } },
  { id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn',
    radius: 2, soi: 7, mu: 10,
    orbit_radius: 65, orbit_period: TWO_PI * Math.sqrt(274625 / 600), angle0: 4.19,
    color: '#cc9944',
    yield: { metal: 7, fuel: 0, gold: 1, science: 2 } },

  // ---- ice giants ----
  // Outer system compressed ~35-45% so 200-tick matches can reach them.
  { id: 'uranus', name: 'Uranus', type: 'ice-giant', parent: 'sol',
    radius: 5, soi: 110, mu: 200,
    orbit_radius: 1100, orbit_period: 2960, angle0: 5.47,
    color: '#73c2d6',
    yield: { metal: 2, fuel: 0, gold: 1, science: 6 } },
  // Uranus has a five-moon system: Miranda, Ariel, Umbriel (new minor
  // moons close in), then Titania and Oberon further out.
  { id: 'miranda', name: 'Miranda', type: 'moon', parent: 'uranus',
    radius: 1, soi: 3, mu: 1.5,
    orbit_radius: 12, orbit_period: TWO_PI * Math.sqrt(1728 / 200), angle0: 0.78,
    color: '#a8a8a8',
    yield: { metal: 4, fuel: 0, gold: 0, science: 3 } },
  { id: 'ariel', name: 'Ariel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 2.5,
    orbit_radius: 18, orbit_period: TWO_PI * Math.sqrt(5832 / 200), angle0: 2.10,
    color: '#b0a898',
    yield: { metal: 3, fuel: 0, gold: 0, science: 5 } },
  { id: 'umbriel', name: 'Umbriel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 3,
    orbit_radius: 26, orbit_period: TWO_PI * Math.sqrt(17576 / 200), angle0: 4.60,
    color: '#6a655e',
    yield: { metal: 3, fuel: 0, gold: 1, science: 4 } },
  { id: 'titania', name: 'Titania', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4,
    orbit_radius: 35, orbit_period: TWO_PI * Math.sqrt(42875 / 200), angle0: 0,
    color: '#909090',
    yield: { metal: 4, fuel: 0, gold: 0, science: 4 } },
  { id: 'oberon', name: 'Oberon', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4,
    orbit_radius: 50, orbit_period: TWO_PI * Math.sqrt(125000 / 200), angle0: 3.14,
    color: '#888070',
    yield: { metal: 4, fuel: 0, gold: 1, science: 4 } },

  { id: 'neptune', name: 'Neptune', type: 'ice-giant', parent: 'sol',
    radius: 5, soi: 120, mu: 250,
    orbit_radius: 1500, orbit_period: 4710, angle0: 5.32,
    color: '#3366cc',
    yield: { metal: 0, fuel: 0, gold: 2, science: 9 } },
  // Neptune's three-moon system: Proteus inner, Triton mid, Nereid outer.
  { id: 'proteus', name: 'Proteus', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 3,
    orbit_radius: 28, orbit_period: TWO_PI * Math.sqrt(21952 / 250), angle0: 1.20,
    color: '#7a7a7a',
    yield: { metal: 1, fuel: 0, gold: 1, science: 5 } },
  { id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune',
    radius: 1.5, soi: 5, mu: 5,
    orbit_radius: 45, orbit_period: TWO_PI * Math.sqrt(91125 / 250), angle0: 0,
    color: '#b8d0e0',
    yield: { metal: 1, fuel: 0, gold: 2, science: 6 } },
  { id: 'nereid', name: 'Nereid', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 2,
    orbit_radius: 78, orbit_period: TWO_PI * Math.sqrt(474552 / 250), angle0: 3.95,
    color: '#aab8c4',
    yield: { metal: 0, fuel: 0, gold: 1, science: 5 } },

  // ---- outer dwarf planets / Kuiper belt ----
  // Compressed in proportion with the ice giants so the Kuiper region
  // is still distinct from Neptune but reachable. These bodies skew
  // metal-rich — late-game industrial frontier.
  { id: 'pluto', name: 'Pluto', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 12, mu: 2,
    orbit_radius: 1900, orbit_period: 6720, angle0: 4.17,
    color: '#c8b898',
    yield: { metal: 2, fuel: 0, gold: 4, science: 3 } },
  { id: 'charon', name: 'Charon', type: 'moon', parent: 'pluto',
    radius: 1, soi: 3, mu: 1,
    orbit_radius: 6, orbit_period: TWO_PI * Math.sqrt(216 / 2), angle0: 0,
    color: '#9a8c7c',
    yield: { metal: 1, fuel: 0, gold: 5, science: 2 } },
  { id: 'haumea', name: 'Haumea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8,
    orbit_radius: 2050, orbit_period: 7520, angle0: 0.95,
    color: '#d8d0c0',
    yield: { metal: 2, fuel: 0, gold: 3, science: 3 } },
  { id: 'makemake', name: 'Makemake', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8,
    orbit_radius: 2200, orbit_period: 8360, angle0: 3.30,
    color: '#c89868',
    yield: { metal: 1, fuel: 0, gold: 4, science: 3 } },
  { id: 'quaoar', name: 'Quaoar', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.6,
    orbit_radius: 2100, orbit_period: 7800, angle0: 5.10,
    color: '#a09080',
    yield: { metal: 2, fuel: 0, gold: 3, science: 3 } },
  { id: 'eris', name: 'Eris', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 1,
    orbit_radius: 2400, orbit_period: 9560, angle0: 1.80,
    color: '#e0e0e0',
    yield: { metal: 0, fuel: 0, gold: 5, science: 4 } },
  { id: 'sedna', name: 'Sedna', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 8, mu: 0.7,
    orbit_radius: 3500, orbit_period: 16800, angle0: 2.55,
    color: '#b06040',
    yield: { metal: 1, fuel: 0, gold: 4, science: 4 } },
];

// ============================================================
// SYSTEM SCALE — how spread out the Sol system is.
//
// Applied as a transform over the catalog above rather than baked into
// 25 hand-edited numbers, so the whole map can be re-tuned (or reverted)
// by changing one constant.
//
// Scope: HELIOCENTRIC orbits only (parent === 'sol'). Moon orbits are
// measured from their own planet, so scaling them would fling moons off
// their parents instead of spreading the system.
//
// Periods scale by SCALE^1.5 (Kepler's third law): a genuinely bigger
// system, not the same system with planets whipping around at double
// linear speed. Consequence to know: orbital geometry now evolves ~2.8×
// slower, so launch windows are more forgiving and long hauls feel
// deliberate. Set ORBIT_PERIOD_SCALE = 1 instead if you want the old
// orbital rhythm on the bigger board.
//
// Travel time is NOT doubled — the brachistochrone solver is
// T = 2·sqrt(d/a), so 2× distance is ~1.41× flight time.
//
// ONLY AFFECTS NEW GAMES. Bodies are copied into game_bodies at seed
// time, so games already in progress keep the scale they were born with.
// ============================================================
const SYSTEM_SCALE = 2;
const ORBIT_PERIOD_SCALE = Math.pow(SYSTEM_SCALE, 1.5);

for (const b of BODY_CATALOG) {
  if (b.parent !== 'sol') continue;
  // Keep the pre-scale value. backfillMissingBodies inserts catalog
  // bodies into games that are ALREADY RUNNING, and those games were
  // seeded at whatever scale was current when they started. Inserting
  // at today's scale would drop a double-distance intruder into an
  // old-scale system. The base lets backfill re-derive the target
  // game's own scale and match it.
  b.base_orbit_radius = b.orbit_radius;
  b.orbit_radius = Math.round(b.orbit_radius * SYSTEM_SCALE);
  b.orbit_period = Math.round(b.orbit_period * ORBIT_PERIOD_SCALE);
  // Eccentric Kuiper elements travel with the orbit they describe.
  if (b.orbit_rp != null) b.orbit_rp = Math.round(b.orbit_rp * SYSTEM_SCALE);
  if (b.orbit_ra != null) b.orbit_ra = Math.round(b.orbit_ra * SYSTEM_SCALE);
}

/**
 * Work out the SYSTEM_SCALE a running game was seeded at, by comparing a
 * heliocentric body it already has against that body's pre-scale radius.
 * Returns 1 for games born before scaling, 2 for current ones, and falls
 * back to today's SYSTEM_SCALE when nothing can be matched.
 */
function inferGameSystemScale(existingRows) {
  for (const row of existingRows) {
    const tpl = BODY_CATALOG.find(b => b.id === row.template_id);
    if (!tpl || tpl.parent !== 'sol' || !tpl.base_orbit_radius) continue;
    const r = Number(row.orbit_radius);
    if (!Number.isFinite(r) || r <= 0) continue;
    return r / tpl.base_orbit_radius;
  }
  return SYSTEM_SCALE;
}

// Eligible worlds for ownership = everything that isn't the star (16 worlds).
// 2 worlds/player × 8 players = 16. Caps at 8 players × 2 worlds for v1.

// Body ownership tracks settlements: the faction with the most active
// settlements at a body owns it.
//   - Ties between two living factions → leave the current owner alone
//     (your claim isn't surrendered just because someone matched your
//     numbers; you have to be outnumbered to lose it).
//   - Zero settlements remain (all destroyed) → reset to NULL. The body
//     becomes unclaimed again. Previously this case also "left things
//     alone," which left phantom ownership attached to bodies the
//     player had been pushed out of. The body card kept showing the
//     old owner with no presence on the body to back it up.
// Call this after any settlement deploy/destroy that touches `bodyId`.
//
// Returns the new owner_faction_id (or null if no change was applied
// OR if ownership was cleared to neutral).
export async function recomputeBodyOwnership(db, gameId, bodyId) {
  const rows = await db
    .prepare(
      `SELECT owner_faction_id AS fid, COUNT(*) AS n
         FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NULL
        GROUP BY owner_faction_id
        ORDER BY n DESC`,
    )
    .bind(gameId, bodyId)
    .all();
  const tally = rows.results ?? [];
  if (tally.length === 0) {
    // No active settlements anywhere on the body. Clear ownership so
    // the body shows as unclaimed in the inspector and unlocks
    // settlement re-deployment by anyone who lands a freighter.
    await db
      .prepare('UPDATE game_bodies SET owner_faction_id = NULL WHERE id = ? AND game_id = ? AND owner_faction_id IS NOT NULL')
      .bind(bodyId, gameId)
      .run();
    return null;
  }
  if (tally.length >= 2 && tally[0].n === tally[1].n) return null; // contested tie → no change
  const newOwner = tally[0].fid;
  await db
    .prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ? AND game_id = ?')
    .bind(newOwner, bodyId, gameId)
    .run();
  return newOwner;
}

/**
 * Smallest body anyone may call home: planets and BIG moons only.
 *
 * The old rule was "terrestrial or moon", which reads as reasonable and
 * is not. It let capitals land on 1.0-radius moons — Nereid, Proteus,
 * Charon, Deimos — and 100 simulated games (sim/) put the resulting
 * economic spread at 9.4x between the best capital and the worst:
 *
 *     titan   9870        umbriel  4820
 *     mars    6636        charon   2184
 *     earth   6530        deimos   1712
 *     ...                 nereid   1049
 *
 * Every body below this floor sat in the bottom half. That is not a
 * difficulty setting, it is a different game handed out at random before
 * anyone has made a decision.
 *
 * 1.5 is where the catalog has a natural gap: Luna, Europa, Titania,
 * Oberon and Triton sit at exactly 1.5, and the next size down is 1.0.
 * Gas and ice giants are excluded automatically — they are neither
 * 'terrestrial' nor 'moon', and a city cannot be founded on one anyway.
 */
const MIN_CAPITAL_RADIUS = 1.5;

/** Planets and big moons. The one definition of "somewhere you can
 *  reasonably be asked to start", used by the lobby menu AND by the
 *  fallback assignment so the two can never disagree. */
function isCapitalWorthy(b, floor = MIN_CAPITAL_RADIUS) {
  return (b.type === 'terrestrial' || b.type === 'moon')
    && (b.radius ?? 0) >= floor;
}

// Subset of BODY_CATALOG that players may pick as their starting capital
// in the lobby. A lobby pick IS a spawn, so it obeys the same floor as
// the automatic assignment — otherwise the guarantee leaks through the
// one path a player controls.
export const STARTING_BODY_OPTIONS = BODY_CATALOG
  // NOT .filter(isCapitalWorthy): filter passes (element, INDEX) and the
  // index lands in isCapitalWorthy's `floor` parameter, silently raising
  // the radius bar per position — which shrank the lobby menu to
  // Mercury/Venus/Earth and hid the rest of the system.
  .filter(b => isCapitalWorthy(b))
  .map(b => ({
    id: b.id,
    name: b.name,
    type: b.type,
    parent: b.parent,
    yield: b.yield,
  }));

/**
 * The shipped solar system, flattened for the map editor.
 *
 * Exported rather than re-declared client-side so the editor draws the
 * SAME catalogue the seeder builds from. A second copy in TypeScript
 * would drift the first time a body was retuned, and the editor would
 * quietly be editing a map that no longer exists.
 */
export const CATALOG_FOR_EDITOR = BODY_CATALOG.map(b => ({
  id: b.id, name: b.name, type: b.type, parent: b.parent,
  orbit_radius: b.orbit_radius, radius: b.radius, soi: b.soi,
  yield_metal: b.yield.metal, yield_gold: b.yield.gold,
  yield_science: b.yield.science, yield_fuel: b.yield.fuel,
}));

const STARTING_BODY_IDS = new Set(STARTING_BODY_OPTIONS.map(b => b.id));
export function isValidStartingBody(id) {
  return typeof id === 'string' && STARTING_BODY_IDS.has(id);
}

// Body-agnostic defaults so they keep working as the catalog evolves.
// Players almost always override with their own empire_name in the lobby.
const FACTION_NAMES = [
  'Solar Directorate',
  'Outer Alliance',
  'Mars Combine',
  'Belt Syndicate',
  'Jovian Hegemony',
  'Aurora League',
  'Helix Compact',
  'Ember Syndicate',
];

const FACTION_COLORS = [
  '#ff7043', // ember
  '#42a5f5', // azure
  '#66bb6a', // verdant
  '#ab47bc', // violet
  '#ffca28', // amber
  '#26c6da', // cyan
  '#ec407a', // rose
  '#8d6e63', // ferrous
];

// Fuel is dead (economy rework §1.1) — column kept at 0 for schema compat.
// 100/100 (was 100/50): credits are structurally the tighter currency
// — per-hull upkeep, the energy/armor side of the parts split, and now
// the terraform payload all draw on them. An uneven purse made every
// opening a credit queue.
const STARTING_RESOURCES = { metal: 100, fuel: 0, gold: 100, science: 0 };
const HOME_DEVELOPMENT_LEVEL = 3;       // capital
const SECONDARY_DEVELOPMENT_LEVEL = 2;  // unused now that WORLDS_PER_PLAYER = 1
// One world per faction (the capital). Each capital gets the starter
// fleet + an auto-deployed city so the body is immediately owned and
// visible from tick 0.
const WORLDS_PER_PLAYER = 1;
const COMBAT_SHIPS_PER_WORLD = 2;
const CARGO_SHIPS_PER_WORLD = 1;
/** Fallback only. seedGameWorld resolves this from the game's config
 *  (city_base_hp) so a capital and a founded city always agree; this
 *  value is what a lookup failure falls back to. Tripled from 100. */
const STARTER_CITY_HP = 300;

// Starter fleet template. ship_class is a free-form TEXT column in the
// schema; the canonical class names are corvette/frigate/destroyer/
// freighter — same set used by every server-side gate (no_presence
// deploy check, trade-route auto-pilot, harvest loop). Names are
// templates; suffixed per body so each ship gets a unique label.
//
// Combat stats by ship class. Mirrors src/game/shipClasses.ts on the
// client side. Used both by seedGameWorld (starter fleet) and by the
// Room DO tick resolver (build completions + combat resolution).
// HP must match src/game/shipClasses.ts — the client renders the HP bar
// against ITS own per-class hp value, so any mismatch shows up as a
// permanently-half-empty bar from frame one (the "why are my ships
// damaged with zero combat" bug). Frigate 80 -> 100 and freighter 30 ->
// 60 to match client. See migrations/0033_align_ship_hp_with_client.sql
// for the existing-fleet heal + cap bump.
//
// COMBAT V2 (DESIGN-combat-v2.md). `speed` is a 0-1 mobility stat and it is
// the SAME number for two jobs: hit chance is
//   p = atkSpeed^2 / (atkSpeed^2 + defSpeed^2)
// and travel acceleration scales with (speed / FRIGATE_SPEED)^2 — squared
// because trip time is brachistochrone T = 2*sqrt(d/a), so a linear speed
// ratio needs a squared accel ratio. Engines raise speed x1/0.85 each,
// capped at SPEED_CAP for both jobs.
/**
 * Where a ship parks when it arrives at (or is built at) a body.
 *
 * Was `radius + 2`, and an ADDITIVE term on a map whose bodies span radius
 * 0.6 (Midas) to 20 (Sol) is wildly out of proportion at the small end: the
 * same +2 is 1.1x the radius at Sol and 4.3x at Midas. Player report — "for
 * such a small planet, ships are suppppper far out from the low orbit".
 *
 * Proportional-dominant instead, so "low orbit" means the same thing
 * everywhere:
 *   - 1.45x radius is the shape of it
 *   - a +0.35 floor keeps a visible gap over a pebble
 *   - a +4 ceiling stops the biggest bodies drifting: it binds only above
 *     radius ~8.9, i.e. Sol alone, which lands at 24 instead of today's 22
 *     rather than being flung out to 29.3. Framing that already reads well
 *     is left alone; only the small end is fixed.
 *
 * KEEP IN SYNC with the client mirror in src/physics/orbitalMechanics.ts —
 * the client parks optimistically on launch and the server confirms on
 * arrival, so a mismatch makes every ship visibly jump when it lands.
 */
export function parkOrbitRadius(bodyRadius) {
  const r = Number(bodyRadius) > 0 ? Number(bodyRadius) : 4;
  return Math.min(Math.max(r * 1.45 + 0.3, r + 0.35), r + 4);
}

export const SHIP_COMBAT_STATS = {
  // 3.75 -> 7 (Lorne). Live telemetry put the corvette at 0.70 combat
  // power per credit against the destroyer's 9.44, needing ~79 hulls to
  // trade evenly with one. See migration 0071.
  corvette:  { hp: 40,  damage_per_tick: 7,     speed: 0.85 },
  frigate:   { hp: 100, damage_per_tick: 20.25, speed: 0.50 },
  destroyer: { hp: 400, damage_per_tick: 45,    speed: 0.30 },
  freighter: { hp: 60,  damage_per_tick: 0,     speed: 0.55 },
  colony:    { hp: 60,  damage_per_tick: 0,     speed: 0.55 },
};

/** Reference hull. Travel time is normalised on the frigate, so a frigate's
 *  trip is unchanged by the v2 rework and every other hull moves relative
 *  to it. */
export const FRIGATE_SPEED = 0.50;

/** One engine's speed multiplier (the reciprocal of the -15% travel time
 *  the part already shipped with, so engine behaviour is preserved). */
export const ENGINE_SPEED_MUL = 1 / 0.85;

/** Ceiling on speed, for BOTH the hit roll and travel.
 *
 *  Written as 1/0.85 rather than 1.176 ON PURPOSE. A fully-engined corvette
 *  is 0.85 x (1/0.85)^2 = 1.176471, so a literal 1.176 clipped it and made
 *  the second engine look like a wasted slot. It is not: 0.85 -> 1.000 ->
 *  1.176 and every engine earns its place. */
export const SPEED_CAP = 1 / 0.85;

/** Settlements are not ships but they are shot at, so they need a speed.
 *  Matched to the destroyer (0.30): a station is mechanically a destroyer
 *  that cannot move — it rolls to hit and is rolled against on the same
 *  terms. See DESIGN-combat-v2.md R2. */
export const SETTLEMENT_SPEED = 0.30;

// Starting kit for research-gated games: ONE corvette and ONE colony
// ship. Everything else — frigates, destroyers, freighters, stations,
// every building, trade, diplomacy — is behind a research level (see
// src/game/researchUnlocks.ts). The tree is the tutorial, so the opening
// has to be small enough that the first unlock actually feels like an
// event.
//
// This is a deliberate, large tempo change from the old 2-frigates +
// 1-freighter opening: the first several ticks are one armed scout and
// one settler, and your first research (~15 science, ~turn 5) is the
// first real decision of the game.
//
// The freighter is NOT here — it is Propulsion 1, which is what makes
// "do I open economy or military?" a genuine choice.
const STARTER_FLEET = [
  { class: 'corvette', baseName: 'Vanguard', fuelMax: 600 },
  { class: 'colony',   baseName: 'Pioneer',  fuelMax: 1200 },
];

// Deterministic PRNG so map_seed actually produces a reproducible world.
// Hash the seed string with xfnv1a-style mix, then drive a mulberry32 stream.
function makeRand(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------- body secrets seeding ----------
//
// Mirror of src/game/secrets.ts SECRET_DEFS. Each secret kind only
// attaches to bodies in compatible categories so the layout always
// feels reasonable (no Mercury portals, no asteroid databanks).
const SECRET_HOST_CATEGORIES = {
  portal_to_sun:    ['outer', 'moon-outer'],
  ancient_city:     ['belt'],
  // pre_terraformed replaced free_collector (terraforming rework): one
  // world per game the ancients already prepped — terraform status
  // only, NO free settlement (a beachhead, not a gift). Outer-system
  // placement keeps it far from every spawn, so reaching it first is
  // an actual expedition.
  pre_terraformed:  ['outer', 'moon-outer'],
  derelict_warship: ['belt', 'outer'],
  resource_cache:   ['inner', 'belt'],
  ancient_databank: ['moon-inner', 'moon-outer'],
};

const SECRET_KINDS = Object.keys(SECRET_HOST_CATEGORIES);

/** Classify a BODY_CATALOG entry into the same category buckets the
 *  client's secrets.ts uses, so the host filter agrees with SP. */
function categorizeBodyForSecret(b) {
  if (b.type === 'star') return null;
  if (b.type === 'moon') {
    const parent = BODY_CATALOG.find(x => x.id === b.parent);
    if (parent && (parent.type === 'gas-giant' || parent.type === 'ice-giant')) return 'moon-outer';
    return 'moon-inner';
  }
  if (b.type === 'asteroid' || b.type === 'dwarf') return 'belt';
  // Terrestrial / gas / ice bucketed by orbital radius. Inner ≤ 250.
  if (b.orbit_radius < 250) return 'inner';
  return 'outer';
}

/** Deterministic secret placements keyed by body template id.
 *  Skips bodies that are already claimed by a faction (capitals +
 *  secondary worlds). Returns a Map<templateId, kind>. */
function pickSecretPlacements(rand, ownership) {
  const pool = { 'inner': [], 'belt': [], 'outer': [], 'moon-inner': [], 'moon-outer': [] };
  // Shipped catalogue, deliberately: secret placement only needs body
  // identity and category, and this helper has no game in scope to look
  // an edited catalogue up from.
  for (const b of BODY_CATALOG) {
    if (ownership.has(b.id)) continue;
    const cat = categorizeBodyForSecret(b);
    if (cat) pool[cat].push(b);
  }
  const claimed = new Set();
  const placements = new Map();
  for (const kind of SECRET_KINDS) {
    const cats = SECRET_HOST_CATEGORIES[kind];
    const candidates = [];
    for (const cat of cats) {
      for (const b of pool[cat]) {
        if (!claimed.has(b.id)) candidates.push(b);
      }
    }
    if (candidates.length === 0) continue;
    const pick = candidates[Math.floor(rand() * candidates.length)];
    claimed.add(pick.id);
    placements.set(pick.id, kind);
  }
  return placements;
}

// ---------- helpers ----------

function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function errResponse(status, code, message) {
  return jsonResponse({ error: { code, message } }, { status });
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

const HEX6 = /^#?[0-9a-fA-F]{6}$/;
const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

// The 90-unit threshold that used to gate PICKS is gone: primary
// uniqueness is exact-match only now, so every RULE in this file is a
// string comparison on the normalised hex. Nothing has to be "kept in
// sync" across three files any more, which removes the failure mode
// where the lobby accepted a pick that seeding then treated as a clash.
//
// Distance survives in exactly one place, as a soft preference: when
// handing out a DEFAULT colour we'd rather not park an auto-assigned
// empire right on top of somebody's deliberate choice. Never blocks
// anything — see defaultColorFor.
const DEFAULT_COLOR_COMFORT = 60;

function normalizeHex(s) {
  if (typeof s !== 'string') return null;
  if (!HEX6.test(s)) return null;
  return s.startsWith('#') ? s.toLowerCase() : '#' + s.toLowerCase();
}

/**
 * Derive a secondary (trim) color from a primary: lighten dark colors,
 * darken light ones, by ~35%. Two-tone factions (§5): the secondary is
 * decoration only — meaning must stay in the primary. Mirror of
 * deriveSecondary in src/game/colorUtils.ts — keep the two in sync so
 * server-derived and client-derived fallbacks agree.
 */
export function deriveSecondary(hex) {
  const norm = normalizeHex(hex);
  if (!norm) return '#888888';
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const f = 0.35;
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  if (lum > 0.5) {
    return `#${clamp(r * (1 - f))}${clamp(g * (1 - f))}${clamp(b * (1 - f))}`;
  }
  return `#${clamp(r + (255 - r) * f)}${clamp(g + (255 - g) * f)}${clamp(b + (255 - b) * f)}`;
}

function newEntryId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function isRoomMember(env, gameId, userId) {
  const row = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .first();
  return !!row;
}

// ---------- seedGameWorld ----------

/**
 * Seed the world for a game whose `games` row already exists with status='setup'.
 * Idempotent: if status is already 'active' or 'completed', returns immediately.
 *
 * @param {*} env  Cloudflare env (must include `DB`).
 * @param {string} gameId
 * @returns {Promise<{ok: true, alreadySeeded?: boolean, factions?: number}>}
 */
export async function seedGameWorld(env, gameId) {
  const game = await env.DB
    .prepare('SELECT id, status, tick_interval_ms, created_at, started_at, map_seed FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) throw new Error(`seedGameWorld: game ${gameId} not found`);
  if (game.status !== 'setup') {
    return { ok: true, alreadySeeded: true };
  }

  // Pull lobby identity (empire_name, bio, chosen capital) alongside roster.
  const members = await env.DB
    .prepare(
      `SELECT user_id, joined_at, empire_name, bio, chosen_starting_body,
              color, color2, emblem
         FROM room_members
        WHERE room_id = ?
        ORDER BY joined_at ASC, user_id ASC`,
    )
    .bind(gameId)
    .all();
  const memberRows = members.results ?? [];
  if (memberRows.length === 0) {
    throw new Error(`seedGameWorld: game ${gameId} has no members`);
  }

  // Eligible worlds = everything but the star.
  // Map edits from the admin Editor. A config may move a world, resize
  // it, or retune its yields; those overrides are applied to a COPY of
  // the catalogue so the module-level constant stays the shipped truth
  // and one game's edits can never leak into another's.
  let CATALOG = BODY_CATALOG;
  let spawnFloorRadius = MIN_CAPITAL_RADIUS;
  let capitalCityHp = STARTER_CITY_HP;
  let spawnFloorScience = 2;
  // The opening purse. Config-driven since the terraforming balance pass —
  // STARTING_RESOURCES stays as the fallback so a config failure still
  // deals the shipped hand.
  let startMetal = STARTING_RESOURCES.metal;
  let startGold = STARTING_RESOURCES.gold;
  try {
    const gc = await import('./gameConfig.js');
    const conf = await gc.cfg(env, gameId);
    spawnFloorRadius = conf.min_capital_radius ?? MIN_CAPITAL_RADIUS;
    capitalCityHp = conf.city_base_hp ?? STARTER_CITY_HP;
    spawnFloorScience = conf.min_capital_science ?? 2;
    startMetal = conf.starting_metal ?? STARTING_RESOURCES.metal;
    startGold = conf.starting_credits ?? STARTING_RESOURCES.gold;
    const bodyEdits = conf.bodies ?? {};
    // Global multipliers. ORDER MATTERS: per-body edits are expressed in
    // the shipped coordinate space, then the global scales multiply
    // everything uniformly. So "drag Earth to 900" and "spread the system
    // by 2" compose to 1800 rather than fighting each other, and the
    // scales keep meaning the same thing however much hand-editing has
    // happened.
    const sysScale = conf.system_scale ?? 1;
    const bodyScale = conf.body_scale ?? 1;
    const anyEdit = Object.keys(bodyEdits).length > 0 || sysScale !== 1 || bodyScale !== 1;

    if (anyEdit) {
      CATALOG = BODY_CATALOG.map((body) => {
        const e = bodyEdits[body.id] ?? {};
        const orbit = e.orbit_radius ?? body.orbit_radius;
        return {
          ...body,
          // System scale spreads PLANETS only. A moon's orbit_radius is
          // measured from its planet, so stretching it too would walk
          // moons out of their parent's sphere of influence and strand
          // them — the map would look fine and the game would not work.
          orbit_radius: (body.parent && body.parent !== 'sol')
            ? orbit
            : (orbit == null ? orbit : orbit * sysScale),
          // Size and capture radius scale together, so a bigger world
          // still holds ships at a proportional distance.
          radius: (e.radius ?? body.radius) * bodyScale,
          soi: (e.soi ?? body.soi) == null ? body.soi : (e.soi ?? body.soi) * bodyScale,
          yield: {
            metal:   e.yield_metal   ?? body.yield.metal,
            gold:    e.yield_gold    ?? body.yield.gold,
            science: e.yield_science ?? body.yield.science,
            fuel:    e.yield_fuel    ?? body.yield.fuel,
          },
        };
      });
    }
  } catch (e) {
    // Shipped catalogue is always a correct answer.
    console.error('body overrides failed, using shipped catalogue', e);
  }

  const claimable = CATALOG.filter(b => b.type !== 'star');
  const needed = memberRows.length * WORLDS_PER_PLAYER;
  if (claimable.length < needed) {
    throw new Error(
      `seedGameWorld: catalog has ${claimable.length} claimable worlds, ` +
      `need ${needed} (${memberRows.length} players × ${WORLDS_PER_PLAYER} worlds)`,
    );
  }

  const now = Date.now();
  const startedAt = game.started_at || now;
  const nextTickAt = startedAt + (game.tick_interval_ms || 86400000);
  const bodyRowIdFor = (tplId) => `${gameId}:${tplId}`;

  // Deterministic shuffle from the map seed so the world is reproducible.
  const rand = makeRand(String(game.map_seed || gameId));
  const shuffled = [...claimable];
  shuffleInPlace(shuffled, rand);

  // Colours are assigned in TWO passes so a default can never collide
  // with an explicit pick.
  //
  // The bug this prevents: a member who never opened the swatch grid used
  // to fall through to FACTION_COLORS[slot], which is the SAME palette
  // the grid offers. Player A picks rose (#ec407a), player B never picks
  // and lands on slot 6, and slot 6 IS rose: two identical factions, no
  // rule broken. That shipped — a live game ran with two #ec407a empires.
  //
  // Pass 1 reserves every explicit pick. Pass 2 walks the palette from
  // the slot's traditional colour and takes the first one nobody holds,
  // so defaults dodge picks AND each other.
  //
  // This got markedly simpler when the rule became exact-match-only. The
  // old 90-unit version needed a degrade path, because the palette is
  // curated for looks and three of its own pairs sit closer than 90
  // (azure/cyan 51, verdant/ferrous 87, ember/rose 75) — so a later slot
  // could find EVERY entry "too close" and fall through to a duplicate.
  // Exact uniqueness over 8 palette entries with at most 8 seats is
  // always satisfiable, so the walk can't fail and there is nothing to
  // degrade to.
  // SLOT-INDEXED: index === slot, null where that member hasn't picked.
  // Deliberately NOT compacted with .filter(Boolean) — the loop below
  // writes each seat's final colour back at its own index, and a
  // compacted array would put a picker's colour at the wrong position
  // and make the "did an earlier seat take this?" prefix check lie.
  const takenColors = memberRows.map(m => normalizeHex(m.color) || null);
  const isFree = (hex) => !takenColors.includes(hex);
  /** sRGB gap to the nearest colour already spoken for. */
  const gapFromTaken = (hex) => takenColors.reduce((min, t) => {
    if (!t) return min;
    const d = Math.hypot(
      parseInt(hex.slice(1, 3), 16) - parseInt(t.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16) - parseInt(t.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16) - parseInt(t.slice(5, 7), 16),
    );
    return Math.min(min, d);
  }, Infinity);

  const defaultColorFor = (slot) => {
    // Pass 1: walk from the slot's traditional colour and take the first
    // free one that ALSO isn't a near-twin of something already taken.
    //
    // This is a PREFERENCE, not the rule. Loosening picks to exact-match
    // shouldn't make auto-assignment sloppy: without this the sim showed
    // a player's custom pink (#ee4480) sitting 7 units from a default
    // (#ec407a) — two empires nobody could tell apart, one of whom never
    // chose anything. Starting the walk at the slot position keeps the
    // familiar rotation whenever it's available.
    for (let i = 0; i < FACTION_COLORS.length; i++) {
      const c = FACTION_COLORS[(slot + i) % FACTION_COLORS.length];
      if (isFree(c) && gapFromTaken(c) >= DEFAULT_COLOR_COMFORT) return c;
    }
    // Pass 2: comfort is unsatisfiable (a crowded lobby, or picks spread
    // across the palette) — any free colour will do. Uniqueness is the
    // rule and it still holds here.
    for (let i = 0; i < FACTION_COLORS.length; i++) {
      const c = FACTION_COLORS[(slot + i) % FACTION_COLORS.length];
      if (isFree(c)) return c;
    }
    // Unreachable while FACTION_COLORS.length >= max_players, but a
    // duplicate beats a crash during game start.
    return FACTION_COLORS[slot % FACTION_COLORS.length];
  };

  // Emblems — the same two-pass shape as colour, and for the same
  // reason: the collision that shipped came from a DEFAULT landing on
  // somebody's explicit pick, not from two picks colliding. Reserve
  // every pick first, then hand out defaults from what's left.
  //
  // Simpler than colour in one respect: 24 emblems against a cap of 8
  // seats means a free one always exists, so this never has to degrade.
  const takenEmblems = memberRows
    .map(m => (isEmblemId(m.emblem) ? m.emblem : null))
    .filter(Boolean);

  // Factions: empire_name override (from lobby) wins over the default rotation.
  const factionRows = memberRows.map((m, slot) => {
    const empire = (typeof m.empire_name === 'string' ? m.empire_name.trim() : '') || null;
    // Two-tone (§5): member-chosen primary wins over the default
    // rotation; secondary = member pick, else derived from primary.
    // Secondary is decoration only — meaning must stay in primary.
    const picked = normalizeHex(m.color);
    let color;
    // A pick is honoured UNLESS an earlier seat already holds that exact
    // colour. The lobby prevents two members picking the same primary,
    // but it can't cover a legacy row written before the rule, a race
    // between two PATCHes, or a host editing the DB — and the one rule
    // left standing is "no two factions share a colour", so a duplicate
    // pick has to resolve rather than sail through. Earlier join order
    // keeps its choice; the later seat rotates to a free colour.
    if (picked && !takenColors.slice(0, slot).includes(picked)) {
      color = picked;
    } else {
      color = defaultColorFor(slot);
    }
    // Record what THIS seat ended up with, at its own index, so later
    // seats see it. Positional (not push) because takenColors starts as
    // the full list of picks — pushing would leave a picker's own colour
    // sitting at the wrong index and make the prefix check above lie.
    takenColors[slot] = color;
    const color2 = normalizeHex(m.color2) || deriveSecondary(color);
    let emblem;
    if (isEmblemId(m.emblem)) {
      emblem = m.emblem;
    } else {
      emblem = defaultEmblemFor(slot, takenEmblems);
      takenEmblems.push(emblem);   // reserve against the next no-picker
    }
    return {
      id: `${gameId}:f${slot}`,
      slot,
      user_id: m.user_id,
      name: empire || FACTION_NAMES[slot % FACTION_NAMES.length],
      color,
      color2,
      emblem,
      bio: (typeof m.bio === 'string' && m.bio.trim()) ? m.bio.trim() : null,
    };
  });

  // World assignment. Players who chose a starting body in the lobby get
  // that body as their capital; everyone else falls back to the deterministic
  // shuffle. Then each player gets (WORLDS_PER_PLAYER - 1) extra worlds
  // drawn from whatever's left in shuffled order.
  const claimed = new Set();
  // First pass: validate + reserve chosen capitals.
  factionRows.forEach((f, idx) => {
    const choice = memberRows[idx].chosen_starting_body;
    if (choice && STARTING_BODY_IDS.has(choice) && !claimed.has(choice)) {
      f.capital_template_id = choice;
      claimed.add(choice);
    }
  });
  // Second pass: anyone without a choice gets a FAIR fallback capital
  // (spawn-fairness rules, DESIGN-identity-economy.md §1.5):
  //   1. Planets and big moons only (isCapitalWorthy) — no asteroid and
  //      no small-moon capitals. A playtest game once handed a faction
  //      "Vagrant", a 0.5-radius eccentric rogue asteroid, as its
  //      homeworld; 100 simulated games later showed the 1.0-radius moons
  //      were nearly as bad, so the floor moved up to 1.5.
  //   2. science >= 2 — with specialized yields a science-dead start
  //      can never climb the tech tree.
  //   3. Prefer a region (top-level parent grouping) no other capital
  //      occupies, so two players don't spawn as next-door moons.
  const regionOf = (tplId) => {
    let cur = CATALOG.find(b => b.id === tplId);
    while (cur && cur.parent && cur.parent !== 'sol') {
      cur = CATALOG.find(b => b.id === cur.parent);
    }
    return cur ? cur.id : tplId;
  };
  const usedRegions = new Set([...claimed].map(regionOf));
  const fairPool = shuffled.filter(b =>
    !claimed.has(b.id) && isCapitalWorthy(b, spawnFloorRadius)
      && (b.yield.science ?? 0) >= spawnFloorScience,
  );
  factionRows.forEach(f => {
    if (!f.capital_template_id) {
      const pick =
        fairPool.find(b => !claimed.has(b.id) && !usedRegions.has(regionOf(b.id))) ||
        fairPool.find(b => !claimed.has(b.id)) ||
        // Last resort relaxes the science floor but NEVER the size floor.
        // Ten bodies clear radius>=1.5 AND science>=2, and fourteen clear
        // the size floor alone, against a hard cap of 8 players — so this
        // has headroom. Dropping to a small moon to seat a ninth player
        // would hand that player a materially worse game, which is the
        // whole thing this rule exists to prevent. Better to fail loudly
        // below than to seat someone on a rock.
        shuffled.find(b => !claimed.has(b.id) && isCapitalWorthy(b, spawnFloorRadius));
      // Defensive: STARTING_BODY_OPTIONS is far larger than max_players
      // (8), so this can only trip if the catalog is edited down.
      if (!pick) {
        throw new Error(
          `seedGameWorld: ran out of valid starting bodies for ${factionRows.length} players`,
        );
      }
      f.capital_template_id = pick.id;
      claimed.add(pick.id);
      usedRegions.add(regionOf(pick.id));
    }
  });
  // Build the ownership map: capital first, then fill remaining worlds.
  const ownership = new Map();
  const remainingPool = shuffled.filter(b => !claimed.has(b.id));
  let remIdx = 0;
  factionRows.forEach(f => {
    const myWorlds = [f.capital_template_id];
    while (myWorlds.length < WORLDS_PER_PLAYER) {
      myWorlds.push(remainingPool[remIdx++].id);
    }
    f.worlds = myWorlds;
    f.capital_body_id = bodyRowIdFor(f.capital_template_id);
    myWorlds.forEach((tplId, wIdx) => {
      ownership.set(tplId, { factionId: f.id, isCapital: wIdx === 0 });
    });
  });

  const stmts = [];

  // ORDERING NOTE: foreign keys are enforced per-statement (D1 default).
  // - game_bodies.owner_faction_id REFERENCES game_factions(id)
  // - game_bodies.parent_body_id   REFERENCES game_bodies(id)  (self)
  // - game_factions.capital_body_id has NO FK declared (intentional, to
  //   break the circular dependency).
  // So we must insert factions BEFORE bodies (which carry owner ids), and
  // catalog order must preserve parent-before-child within bodies.

  // 1) game_factions — carries empire bio. capital_body_id is a free string
  //    here; the body it points to is inserted in step 2 below.
  for (const f of factionRows) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO game_factions
          (id, game_id, user_id, slot, name, color, color2, emblem, status, bio,
           capital_body_id, reputation, senate_weight,
           metal, fuel, gold, science,
           research_tech_id, research_progress, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?,
                 ?, 0, 1,
                 ?, ?, ?, ?,
                 NULL, 0, ?)`,
      ).bind(
        f.id, gameId, f.user_id, f.slot, f.name, f.color, f.color2, f.emblem, f.bio,
        f.capital_body_id,
        startMetal, STARTING_RESOURCES.fuel,
        startGold, STARTING_RESOURCES.science,
        now,
      ),
    );
  }

  // 1b) Standard-issue "Default" design per faction per class, marked
  //      ACTIVE so builds come fitted out of the box instead of as bare
  //      hulls. Seeded as a real design (rather than an invisible
  //      build-time fallback) so it shows in the designer library and a
  //      player who wants the cheap hull can simply UNSET it — the
  //      choice stays with the player.
  for (const f of factionRows) {
    for (const [cls, parts] of Object.entries(DEFAULT_LOADOUTS)) {
      if (!parts || parts.length === 0) continue; // colony has no slots
      stmts.push(
        env.DB.prepare(
          `INSERT INTO game_ship_designs
            (id, game_id, faction_id, ship_class, name, parts_json, icon_variant, is_active, created_at_ms)
           VALUES (?, ?, ?, ?, 'Default', ?, NULL, 1, ?)`,
        ).bind(
          `${gameId}:dsg_${f.slot}_${cls}`, gameId, f.id, cls,
          JSON.stringify(parts), now,
        ),
      );
    }
  }

  // Pre-compute secret placements. Deterministic from rand (which is
  // seeded from map_seed) so two players entering the same lobby see
  // the same layout. Only un-owned bodies get secrets.
  const secretPlacements = pickSecretPlacements(rand, ownership);

  // METEOROIDS — appended AFTER the editor's edits and the global
  // scales, deliberately. An L3 rock is pinned to its host's orbit
  // radius, period and phase, so it must be generated from the FINAL
  // numbers: pairing against the shipped catalogue and then scaling the
  // system by 2 would leave every rock orbiting somewhere its planet no
  // longer is. Drawing from the same seeded `rand` keeps a given
  // map_seed producing a given world.
  try {
    const { generateMeteoroids } = await import('./meteoroids.js');
    const sunOrbiting = CATALOG.filter(b => b.parent === 'sol');
    CATALOG = CATALOG.concat(generateMeteoroids(rand, sunOrbiting));
  } catch (e) {
    // A worldgen extra must never cost a player their game: without
    // rocks the system is the one that shipped for three games.
    console.error('meteoroid generation failed — seeding without them', e);
  }

  // 2) game_bodies — catalog order preserved so parents land before
  //    children. CATALOG, not BODY_CATALOG: this is where the Editor's
  //    map edits become the actual solar system for this game.
  for (const b of CATALOG) {
    const own = ownership.get(b.id);
    const isCapital = own ? own.isCapital : false;
    const devLevel = own ? (isCapital ? HOME_DEVELOPMENT_LEVEL : SECONDARY_DEVELOPMENT_LEVEL) : 0;
    const yard = isCapital ? 1 : 0;
    const secretKind = secretPlacements.get(b.id) ?? null;
    // Eccentric Kepler elements — present only on Kuiper-class rogue
    // asteroids. Null elsewhere so bodyPosition uses the legacy
    // circular shortcut.
    const orbitRp    = b.orbit_rp    ?? null;
    const orbitRa    = b.orbit_ra    ?? null;
    const orbitOmega = b.orbit_omega ?? null;
    const orbitM0    = b.orbit_m0    ?? null;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO game_bodies
          (id, game_id, template_id, name, type, parent_body_id,
           radius, soi, mu, orbit_radius, orbit_period, angle0, color,
           yield_metal, yield_fuel, yield_gold, yield_science,
           owner_faction_id, development_level, fortification_level, shipyard_level,
           claimed_at_tick, developed_at_tick,
           secret_kind, secret_revealed, secret_discovered_by_faction_id, secret_discovered_at_tick,
           orbit_rp, orbit_ra, orbit_omega, orbit_m0,
           terraformed_at_tick)
         VALUES (?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?,
                 ?, 0, NULL, NULL,
                 ?, ?, ?, ?,
                 ?)`,
      ).bind(
        bodyRowIdFor(b.id), gameId, b.id, b.name, b.type,
        b.parent ? bodyRowIdFor(b.parent) : null,
        b.radius, b.soi, b.mu, b.orbit_radius, b.orbit_period, b.angle0, b.color,
        b.yield.metal, b.yield.fuel, b.yield.gold, b.yield.science,
        own ? own.factionId : null,
        devLevel,
        0, yard,
        own ? 0 : null,
        own ? 0 : null,
        secretKind,
        orbitRp, orbitRa, orbitOmega, orbitM0,
        // Capitals start terraformed, and so does EARTH — deliberately.
        // Earth is an unowned, permanently terraformed inner-system prize
        // that anyone may colonise from tick 0, skipping the payload, the
        // freighter and the 24-tick wait. It is NOT the `pre_terraformed`
        // discovery: that one is outer-system and secret on purpose (see
        // SECRET_HOST_CATEGORIES), and the two coexist by design.
        //
        // Flagged as a bug during a live-game audit precisely because it
        // contradicts that neighbouring comment and carried no note of
        // its own. Confirmed intended 2026-08-11 — leave it.
        (own || b.id === 'earth') ? 0 : null,
      ),
    );
  }

  // 2b) Mineral loads for the meteoroids.
  //
  // A separate UPDATE rather than four more columns on the body INSERT
  // above: that statement is shared by every body in the game and is
  // edited by several people, and widening it for a property only 30
  // rows have is how a positional bind list drifts out of alignment.
  // `remaining` starts equal to `initial` so "how worked is this rock"
  // is always a comparison of two stored numbers rather than a guess.
  for (const b of CATALOG) {
    if (!(b.mineral_initial > 0)) continue;
    stmts.push(
      env.DB.prepare(
        `UPDATE game_bodies
            SET mineral_kind = ?, mineral_initial = ?, mineral_remaining = ?
          WHERE id = ? AND game_id = ?`,
      ).bind(b.mineral_kind, b.mineral_initial, b.mineral_initial,
             bodyRowIdFor(b.id), gameId),
    );
  }

  // 3) game_ships — 2 combat + 1 cargo at each assigned world.
  for (const f of factionRows) {
    for (const tplId of f.worlds) {
      const bodyTpl = BODY_CATALOG.find(b => b.id === tplId);
      const parentBodyId = bodyRowIdFor(tplId);
      STARTER_FLEET.forEach((ship, i) => {
        const id = `${gameId}:s${f.slot}_${tplId}_${i}`;
        const rp = bodyTpl.radius * 1.5;
        const ra = bodyTpl.radius * 2.0;
        const omega = rand() * Math.PI * 2;
        const m0 = rand() * Math.PI * 2;
        const name = `${ship.baseName} of ${bodyTpl.name}`;
        const stats = SHIP_COMBAT_STATS[ship.class] ?? { hp: 50, damage_per_tick: 0 };
        stmts.push(
          env.DB.prepare(
            `INSERT INTO game_ships
              (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
               orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
               fuel, fuel_max, status, built_at_tick,
               hp, hp_max, damage_per_tick)
             VALUES (?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, 0, 1,
                     ?, ?, 'active', 0,
                     ?, ?, ?)`,
          ).bind(
            id, gameId, f.id, name, ship.class, parentBodyId,
            rp, ra, omega, m0,
            ship.fuelMax, ship.fuelMax,
            stats.hp, stats.hp, stats.damage_per_tick,
          ),
        );
      });
    }
  }

  // 3b) game_settlements — auto-deploy a city at each faction's capital
  //     so the body is owned + visible from tick 0 and players don't
  //     have to manually plant a flag before harvest starts. The
  //     starter city has pop 1; growth + harvest passes pick up from
  //     there normally.
  for (const f of factionRows) {
    const capTpl = f.capital_template_id;
    const bodyTpl = BODY_CATALOG.find(b => b.id === capTpl);
    if (!bodyTpl) continue;
    const cityId = `${gameId}:c${f.slot}_${capTpl}`;
    // Surface angle is random per faction so cities don't all stack at 0.
    const surfaceAngle = rand() * Math.PI * 2;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO game_settlements
          (id, game_id, body_id, owner_faction_id, type, name,
           hp, hp_max, population,
           surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
           created_at_tick, last_growth_tick, last_harvest_tick,
           has_collector, collector_built_tick)
         VALUES (?, ?, ?, ?, 'city', ?,
                 ?, ?, 1,
                 ?, NULL, NULL, NULL, NULL, NULL,
                 0, 0, 0,
                 1, NULL)`,
      ).bind(
        cityId, gameId, bodyRowIdFor(capTpl), f.id,
        `${f.name} Capital`,
        STARTER_CITY_HP, STARTER_CITY_HP,
        surfaceAngle,
      ),
    );
  }

  // 4) flip game status to active, and turn research gating ON.
  //
  // gating_enabled is set EXPLICITLY here rather than via the column
  // default (migration 0040 defaults it to 0). That inversion is the
  // point: games that already existed when the migration ran keep every
  // feature unlocked forever, and only worlds seeded by this function —
  // i.e. genuinely new games — gate on research.
  stmts.push(
    env.DB.prepare(
      `UPDATE games
         SET status = 'active',
             gating_enabled = 1,
             started_at = COALESCE(started_at, ?),
             next_tick_at = ?
       WHERE id = ? AND status = 'setup'`,
    ).bind(startedAt, nextTickAt, gameId),
  );

  // 5) chronicle 'game_started' — record world + fleet allocation.
  const payload = {
    factions: factionRows.map(f => ({
      id: f.id,
      name: f.name,
      color: f.color,
      capital_body_id: f.capital_body_id,
      worlds: f.worlds.map(t => bodyRowIdFor(t)),
    })),
    starter_fleet: {
      combat_ships_per_world: COMBAT_SHIPS_PER_WORLD,
      cargo_ships_per_world: CARGO_SHIPS_PER_WORLD,
      worlds_per_player: WORLDS_PER_PLAYER,
    },
  };
  stmts.push(
    env.DB.prepare(
      `INSERT INTO chronicle_entries
         (id, game_id, tick_number, kind, payload, visibility, created_at_ms)
       VALUES (?, ?, 0, 'game_started', ?, 'public', ?)`,
    ).bind(newEntryId(), gameId, JSON.stringify(payload), now),
  );

  await env.DB.batch(stmts);
  return {
    ok: true,
    factions: factionRows.length,
    worlds_per_player: WORLDS_PER_PLAYER,
    ships_per_world: COMBAT_SHIPS_PER_WORLD + CARGO_SHIPS_PER_WORLD,
  };
}

// ---------- backfill helper ----------

/**
 * Insert any BODY_CATALOG entries that aren't yet in `game_bodies` for
 * this game. Used when the catalog gains new bodies (asteroid belt,
 * Kuiper objects, minor moons) after a game has already been seeded —
 * `seedGameWorld` runs only once per game, so existing games stay
 * frozen at whatever catalog version was current at start. This
 * helper is idempotent: bodies that already exist are skipped, so
 * it's safe to call repeatedly.
 *
 * Returns the number of inserted bodies.
 */
export async function backfillMissingBodies(env, gameId) {
  const existing = await env.DB
    .prepare('SELECT template_id, orbit_radius FROM game_bodies WHERE game_id = ?')
    .bind(gameId).all();
  const existingRows = existing.results ?? [];
  const have = new Set(existingRows.map(r => r.template_id));

  // Match the scale this game was BORN at, not today's catalog scale —
  // otherwise adding a body to the catalog would drop a double-distance
  // intruder into every game seeded before SYSTEM_SCALE changed.
  const gameScale = inferGameSystemScale(existingRows);
  const scaleRatio = SYSTEM_SCALE === 0 ? 1 : gameScale / SYSTEM_SCALE;
  const periodRatio = Math.pow(scaleRatio, 1.5);
  /** Re-scale a heliocentric catalog value into this game's scale.
   *  Moons are parent-relative and never scaled. */
  const fitR = (b, v) =>
    (v == null || b.parent !== 'sol') ? v : Math.round(v * scaleRatio);
  const fitPeriod = (b, v) =>
    (v == null || b.parent !== 'sol') ? v : Math.round(v * periodRatio);

  const bodyRowIdFor = (tplId) => `${gameId}:${tplId}`;
  const stmts = [];
  let inserted = 0;
  for (const b of BODY_CATALOG) {
    if (have.has(b.id)) continue;
    // Eccentric Kepler elements for Kuiper-class rogue asteroids
    // (migration 0024). Plain circular bodies have all four NULL and
    // fall through to the legacy `bodyPosition` shortcut. Without
    // these here, a pre-0024 game backfilled later would have its
    // Kuiper asteroids stuck on a wrong-orbit-radius circle.
    const orbitRp    = fitR(b, b.orbit_rp ?? null);
    const orbitRa    = fitR(b, b.orbit_ra ?? null);
    const orbitOmega = b.orbit_omega ?? null;
    const orbitM0    = b.orbit_m0    ?? null;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO game_bodies
          (id, game_id, template_id, name, type, parent_body_id,
           radius, soi, mu, orbit_radius, orbit_period, angle0, color,
           yield_metal, yield_fuel, yield_gold, yield_science,
           owner_faction_id, development_level, fortification_level, shipyard_level,
           claimed_at_tick, developed_at_tick,
           orbit_rp, orbit_ra, orbit_omega, orbit_m0)
         VALUES (?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 NULL, 0, 0, 0,
                 NULL, NULL,
                 ?, ?, ?, ?)`,
      ).bind(
        bodyRowIdFor(b.id), gameId, b.id, b.name, b.type,
        b.parent ? bodyRowIdFor(b.parent) : null,
        b.radius, b.soi, b.mu,
        fitR(b, b.orbit_radius), fitPeriod(b, b.orbit_period),
        b.angle0, b.color,
        b.yield.metal, b.yield.fuel, b.yield.gold, b.yield.science,
        orbitRp, orbitRa, orbitOmega, orbitM0,
      ),
    );
    inserted += 1;
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  return inserted;
}

// ---------- route handlers ----------

async function handleListFactions(_req, env, ctx) {
  const { session, params } = ctx;
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return errResponse(400, 'bad_request', 'invalid game id');

  if (!(await isRoomMember(env, gameId, session.user_id))) {
    return errResponse(403, 'not_member', 'not a member of this game');
  }

  const rows = await env.DB
    .prepare(
      `SELECT id, user_id, slot, name, color, color2, emblem, status, capital_body_id,
              senate_weight, reputation,
              -- Stockpiles ride along so the standings ledger can show
              -- them; they are STRIPPED below for any faction the caller
              -- lacks Economic Intel on, exactly like income.
              metal, gold, science
         FROM game_factions
        WHERE game_id = ?
        ORDER BY slot ASC`,
    )
    .bind(gameId)
    .all();
  const factions = rows.results ?? [];

  // Scoreboard extras, now GATED by the caller's Sensors research (was a
  // "full open scoreboard"; Lorne reversed that so the Sensors track
  // actually buys intel). A rival's ship count needs Fleet Census
  // (sensors 3); their income needs Economic Intel (sensors 4); their
  // tech levels need Research Intel (sensors 6). You always see your OWN.
  // A gated-out field is sent as null so the client shows a lock chip
  // (distinct from a real 0). Ungated games keep everything open.
  const [income, shipCounts, bodyCounts, systemCounts] = await Promise.all([
    computePoolIncomePerFaction(env, gameId),
    countActiveShipsPerFaction(env, gameId),
    countOwnedBodiesPerFaction(env, gameId),
    countSystemsPerFaction(env, gameId),
  ]);
  const meRow = await env.DB
    .prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, session.user_id)
    .first();
  const myId = meRow?.id ?? null;
  const gated = await gatingEnabled(env, gameId);
  const myLevels = myId ? await factionTechLevels(env, gameId, myId) : {};
  const canSee = (feat) => !gated || hasFeature(feat, myLevels, true);
  const seeCensus = canSee('intel.fleetCensus');
  const seeEconomy = canSee('intel.economy');
  const seeResearch = canSee('intel.research');

  // Tech levels, grouped by faction. Loaded unconditionally: the caller
  // ALWAYS sees their own levels (they're yours — there is nothing to
  // gate), and the drawer showing Income/Tech/Status for rivals but
  // Income/Status for you made your own row look like a duplicate of the
  // stockpile columns. Rivals' levels still hide behind Research Intel
  // at attach time below.
  const trows = (await env.DB
    .prepare('SELECT faction_id, tech_id, level FROM faction_techs WHERE game_id = ?')
    .bind(gameId).all()).results ?? [];
  const techByFaction = new Map();
  for (const r of trows) {
    if (!techByFaction.has(r.faction_id)) techByFaction.set(r.faction_id, {});
    techByFaction.get(r.faction_id)[r.tech_id] = r.level;
  }

  for (const f of factions) {
    const mine = f.id === myId;
    const fullIncome = income.get(f.id) ?? { metal: 0, fuel: 0, gold: 0, science: 0 };
    const fullCount = shipCounts.get(f.id) ?? 0;
    f.income = (mine || seeEconomy) ? fullIncome : null;
    // Stockpiles are the same class of secret as income — one Sensors
    // gate covers both, so a rival is either an open book economically
    // or a closed one, never half.
    if (!mine && !seeEconomy) { f.metal = null; f.gold = null; f.science = null; }
    f.ship_count = (mine || seeCensus) ? fullCount : null;
    // Worlds held. NOT intel-gated, unlike fleet census and economy:
    // political borders are already public (the map paints them for
    // everyone via settlement_claims), and this is a WIN CONDITION —
    // hiding how close a rival is to domination would make the race
    // unreadable. Sourced from the same game_bodies.owner_faction_id the
    // victory check counts, so the panel can never disagree with it.
    f.bodies_owned = bodyCounts.owned.get(f.id) ?? 0;
    f.bodies_total = bodyCounts.total;
    // Systems drive SENATE vote weight (1 seat + 1 per system), which is
    // the chancellor win condition — public for the same reason worlds
    // are. systems_open is what is still unclaimed or deadlocked, so a
    // player can see how much of the chamber is still winnable.
    f.systems_owned = systemCounts.held.get(f.id) ?? 0;
    f.systems_total = systemCounts.total;
    f.systems_open = systemCounts.unowned + systemCounts.contested;
    // Weight computed HERE, not on the client: the "a dead empire holds
    // no seat" rule lives in voteWeightFor (worker/senate.js) and a
    // second copy in the UI would be the thing that drifts.
    f.vote_weight = f.status === 'active' ? f.systems_owned + 1 : 0;
    // Own tech is never gated; rivals' needs Research Intel (Sensors 6).
    f.tech_levels = (mine || seeResearch) ? (techByFaction.get(f.id) ?? {}) : null;
  }

  // Dyson Sphere progress rides along so the FACTION panel can show all
  // THREE victory paths in one place. It is public by the same argument
  // as territory: a megaproject that ends the match outright must not be
  // something you only discover by flying to Sol. Best-effort — a
  // pre-Phase-B game has no columns and simply omits the track.
  let dyson = null;
  try {
    const d = await env.DB
      .prepare(`SELECT dyson_controller_faction_id AS controller,
                       dyson_hp AS hp, dyson_max_hp AS max_hp
                  FROM games WHERE id = ?`)
      .bind(gameId)
      .first();
    if (d && (d.max_hp ?? 0) > 0) {
      dyson = { controller: d.controller ?? null, hp: d.hp ?? 0, max_hp: d.max_hp };
    }
  } catch { /* column absent on legacy games — omit the track */ }

  return jsonResponse({ factions, dyson });
}

/**
 * Bodies held per faction, plus the map total.
 *
 * Mirrors the domination victory check in worker/room.js EXACTLY — every
 * non-destroyed body, keyed on game_bodies.owner_faction_id, which is the
 * claim recomputeBodyOwnership maintains. Any other definition (counting
 * settlements, or bodies with a city) would produce a number that looks
 * authoritative and quietly fails to predict the win.
 */
async function countOwnedBodiesPerFaction(env, gameId) {
  const rows = (await env.DB
    .prepare(
      `SELECT owner_faction_id AS fid, COUNT(*) AS n
         FROM game_bodies
        WHERE game_id = ? AND destroyed_at_tick IS NULL
        GROUP BY owner_faction_id`,
    )
    .bind(gameId)
    .all()).results ?? [];
  const owned = new Map();
  let total = 0;
  for (const r of rows) {
    total += Number(r.n ?? 0);
    if (r.fid) owned.set(r.fid, Number(r.n ?? 0));
  }
  return { owned, total };
}

/**
 * SYSTEMS controlled per faction, plus how many exist and how many are
 * up for grabs.
 *
 * Uses summarizeSystems() from systems.js — the SAME grouping and
 * plurality rule the senate uses to compute vote weight — so the number
 * on the faction card is literally the number that decides the chamber.
 * You control a system by owning strictly more of its bodies than anyone
 * else; a tie leaves it contested and worth nothing to anyone.
 *
 * This is why the card carries systems alongside worlds: five worlds
 * scattered across five systems you don't lead is worth ZERO votes,
 * while five worlds concentrated in one is worth one. Territory alone
 * doesn't tell a player which of those they have.
 */
async function countSystemsPerFaction(env, gameId) {
  const bodies = (await env.DB
    .prepare(
      // Same column set as the senate's bodiesForWeight: orbit geometry
      // feeds the belt clustering, without which every rock is a system.
      `SELECT id, template_id, name, type, parent_body_id,
              orbit_period, orbit_radius, orbit_rp, orbit_ra,
              owner_faction_id
         FROM game_bodies
        WHERE game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId)
    .all()).results ?? [];
  const systems = summarizeSystems(bodies);
  const held = new Map();
  let contested = 0;
  let unowned = 0;
  for (const sys of systems) {
    if (sys.contested) { contested++; continue; }
    if (!sys.controller) { unowned++; continue; }
    held.set(sys.controller, (held.get(sys.controller) ?? 0) + 1);
  }
  return { held, total: systems.length, contested, unowned };
}

/** Active (undestroyed) ship count per faction. */
async function countActiveShipsPerFaction(env, gameId) {
  const rows = (await env.DB
    .prepare(
      `SELECT owner_faction_id AS fid, COUNT(*) AS n
         FROM game_ships
        WHERE game_id = ? AND status = 'active'
        GROUP BY owner_faction_id`,
    )
    .bind(gameId)
    .all()).results ?? [];
  const m = new Map();
  for (const r of rows) m.set(r.fid, Number(r.n ?? 0));
  return m;
}

/**
 * Per-faction POOL income per tick — the resources that flow to the
 * spendable faction pool each harvest, NOT the local-stockpile share.
 *
 * Mirrors the pool half of the harvest pass in worker/room.js resolveTick
 * (§ "Yield distribution"): yieldFull × the body's pool fraction, where a
 * TERRAFORMED world pays 100% to pool and a raw one trickles
 * no_collector_pool_fraction (10% default). KEEP IN SYNC with that pass.
 *
 * This used to key on has_collector while the harvest keyed on
 * terraformed_at_tick — so every world terraformed after migration 0080
 * (and every city-body the backfill terraformed without a collector)
 * displayed a tenth of the income it actually paid. Eight bodies in the
 * live game were already understating when this was caught. The two
 * calculations must read the SAME column, which is why the fraction now
 * comes off the body join rather than a settlement flag.
 *
 * Deterministic multipliers (population, city/station type, forge/mint/
 * lab, Industry tech) are included. Transient senate modifiers
 * (production_sanction, fuel-yield slider) are intentionally OMITTED —
 * this is steady-state income, so a scoreboard number doesn't flicker
 * with a temporary law. Documented so the two never silently diverge.
 */
async function computePoolIncomePerFaction(env, gameId) {
  const YIELD_MULT_PER_POP = 0.1;
  const FORGE_PER_LEVEL = 0.25;
  const MINT_PER_LEVEL  = 0.25;
  const LAB_PER_LEVEL   = 0.25;
  const TYPE_MUL_CITY    = { fuel: 1.0, metal: 1.2, gold: 1.0, science: 0.8 };
  const TYPE_MUL_STATION = { fuel: 1.1, metal: 0.8, gold: 1.0, science: 1.4 };
  const NO_COLLECTOR_POOL_FRACTION = 0.10;

  const settlements = (await env.DB
    .prepare(
      `SELECT s.owner_faction_id AS fid, s.body_id, s.type, s.population,
              s.buildings_json,
              b.terraformed_at_tick,
              b.yield_metal, b.yield_fuel, b.yield_gold, b.yield_science
         FROM game_settlements s
         JOIN game_bodies b ON b.id = s.body_id
        WHERE s.game_id = ? AND s.destroyed_at_tick IS NULL`,
    )
    .bind(gameId)
    .all()).results ?? [];

  // Industry tech (+10%/level to all yields) per faction — one query.
  const techRows = (await env.DB
    .prepare("SELECT faction_id, level FROM faction_techs WHERE game_id = ? AND tech_id = 'industry'")
    .bind(gameId)
    .all()).results ?? [];
  const industryMulOf = new Map();
  for (const r of techRows) industryMulOf.set(r.faction_id, 1 + 0.10 * Number(r.level ?? 0));

  const perFaction = new Map();
  for (const s of settlements) {
    const tm = s.type === 'city' ? TYPE_MUL_CITY : TYPE_MUL_STATION;
    const popMul = 1 + YIELD_MULT_PER_POP * Math.max(0, Number(s.population ?? 1) - 1);
    let bld = {};
    if (s.buildings_json) { try { bld = JSON.parse(s.buildings_json) ?? {}; } catch { bld = {}; } }
    const forgeMul = 1 + Number(bld.forge ?? 0) * FORGE_PER_LEVEL;
    const mintMul  = 1 + Number(bld.mint  ?? 0) * MINT_PER_LEVEL;
    const labMul   = 1 + Number(bld.lab   ?? 0) * LAB_PER_LEVEL;
    const indMul   = industryMulOf.get(s.fid) ?? 1;
    // Same column the harvest pass reads (room.js: `bodyTerraformed`).
    const poolFraction = s.terraformed_at_tick != null ? 1.0 : NO_COLLECTOR_POOL_FRACTION;

    const agg = perFaction.get(s.fid) ?? { metal: 0, fuel: 0, gold: 0, science: 0 };
    agg.metal   += Number(s.yield_metal   ?? 0) * popMul * tm.metal   * forgeMul * indMul * poolFraction;
    agg.fuel    += Number(s.yield_fuel    ?? 0) * popMul * tm.fuel              * indMul * poolFraction;
    agg.gold    += Number(s.yield_gold    ?? 0) * popMul * tm.gold    * mintMul  * indMul * poolFraction;
    agg.science += Number(s.yield_science ?? 0) * popMul * tm.science * labMul   * indMul * poolFraction;
    perFaction.set(s.fid, agg);
  }
  // Round for display (income is shown as +N/t).
  for (const [, agg] of perFaction) {
    agg.metal = Math.round(agg.metal * 10) / 10;
    agg.fuel = Math.round(agg.fuel * 10) / 10;
    agg.gold = Math.round(agg.gold * 10) / 10;
    agg.science = Math.round(agg.science * 10) / 10;
  }
  return perFaction;
}

async function handleMyFaction(_req, env, ctx) {
  const { session, params } = ctx;
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return errResponse(400, 'bad_request', 'invalid game id');

  const row = await env.DB
    .prepare(
      `SELECT id, game_id, user_id, slot, name, color, color2, emblem, status,
              capital_body_id, reputation, senate_weight,
              metal, fuel, gold, science,
              research_tech_id, research_progress
         FROM game_factions
        WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, session.user_id)
    .first();

  if (!row) return errResponse(404, 'not_found', 'no faction for this user in this game');

  // Research context for standalone panels (TradesPanel lives OUTSIDE
  // GameContextProvider, so it can't read tech levels from game state —
  // it asks /me instead). Additive fields; older clients ignore them.
  const [techRows, game] = await Promise.all([
    env.DB
      .prepare('SELECT tech_id, level FROM faction_techs WHERE game_id = ? AND faction_id = ?')
      .bind(gameId, row.id)
      .all(),
    env.DB.prepare('SELECT gating_enabled FROM games WHERE id = ?').bind(gameId).first(),
  ]);
  const tech_levels = Object.fromEntries((techRows.results ?? []).map(r => [r.tech_id, r.level]));
  // HOW MANY FREIGHTERS A ROUTE MAY HOLD, resolved by the SAME function
  // the /state payload and the add-ship endpoint use. Sent rather than
  // re-derived from tech_levels on the client: the cap is a three-step
  // ladder plus an ungated escape hatch, and a second copy of that rule
  // in a panel is precisely the drift this codebase keeps paying for.
  let carrier_cap = 1;
  try {
    const { carrierCapFor } = await import('./tradeRoutesV2.js');
    carrier_cap = await carrierCapFor(env, gameId, row.id);
  } catch { /* leave the conservative 1 — the server still enforces */ }
  return jsonResponse({
    faction: { ...row, tech_levels, gating_enabled: game?.gating_enabled ?? 0, carrier_cap },
  });
}

async function handlePatchMyFaction(req, env, ctx) {
  const { session, params } = ctx;
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return errResponse(400, 'bad_request', 'invalid game id');

  const game = await env.DB
    .prepare('SELECT status FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) return errResponse(404, 'not_found', 'game not found');
  if (game.status !== 'setup') {
    return errResponse(409, 'game_locked', 'faction edits only allowed during setup');
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return errResponse(400, 'bad_request', 'invalid body');

  const updates = [];
  const binds = [];

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return errResponse(400, 'bad_request', 'name must be a string');
    const trimmed = body.name.trim();
    if (trimmed.length < 1 || trimmed.length > 40) {
      return errResponse(400, 'bad_request', 'name must be 1-40 characters');
    }
    updates.push('name = ?');
    binds.push(trimmed);
  }

  if (body.color !== undefined) {
    const hex = normalizeHex(body.color);
    if (!hex) return errResponse(400, 'bad_request', 'color must be a 6-digit hex');
    // Same rule as the lobby: not the SAME colour as a living rival.
    // This endpoint was the one door with no check at all — which is how
    // two live factions ended up flying identical rose (#ec407a) and the
    // seat map, legend, territory bar and chat all lost an identity at
    // once.
    // Excluded by user_id, not faction id: this handler only ever knows
    // the caller (every other query in it is `game_id = ? AND user_id = ?`).
    // It used to bind an undefined `factionId`, so the guard threw a
    // ReferenceError instead of guarding anything.
    const others = (await env.DB
      .prepare('SELECT color FROM game_factions WHERE game_id = ? AND user_id != ? AND color IS NOT NULL')
      .bind(gameId, session.user_id)
      .all()).results ?? [];
    for (const o of others) {
      if (normalizeHex(o.color) === hex) {
        return errResponse(409, 'color_taken', 'another faction already flies that color');
      }
    }
    updates.push('color = ?');
    binds.push(hex);
  }

  // Two-tone (§5): secondary trim color — decoration only, meaning must
  // stay in the primary. Nullable (falls back to a derived secondary).
  if (body.color2 !== undefined) {
    if (body.color2 === null || body.color2 === '') {
      updates.push('color2 = NULL');
    } else {
      const hex2 = normalizeHex(body.color2);
      if (!hex2) return errResponse(400, 'bad_request', 'color2 must be a 6-digit hex');
      updates.push('color2 = ?');
      binds.push(hex2);
    }
  }

  if (updates.length === 0) return errResponse(400, 'bad_request', 'nothing to update');

  binds.push(gameId, session.user_id);
  const res = await env.DB
    .prepare(`UPDATE game_factions SET ${updates.join(', ')} WHERE game_id = ? AND user_id = ?`)
    .bind(...binds)
    .run();

  if (!res.success || (res.meta && res.meta.changes === 0)) {
    return errResponse(404, 'not_found', 'no faction for this user in this game');
  }

  const fresh = await env.DB
    .prepare(
      `SELECT id, name, color, color2, slot, capital_body_id
         FROM game_factions
        WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, session.user_id)
    .first();

  return jsonResponse({ faction: fresh });
}

// ---------- routes ----------

// ---------- late join (join an already-started game) ----------

/**
 * Seed a SINGLE faction into an already-active game. Mirrors the
 * relevant slices of seedGameWorld but operates on the existing world:
 * the bodies are already there, so we UPDATE the chosen body to claim
 * it rather than re-inserting the catalog. The newcomer gets the same
 * starter package as the original players (capital city + 2 frigates +
 * 1 freighter + STARTING_RESOURCES) so they're only behind on tech and
 * map position, not raw fleet.
 *
 * Caller must already be a room member; this is enforced by the route
 * handler. Returns { ok, faction_id } or throws on a precondition
 * failure (the handler maps thrown messages to 4xx).
 *
 * @param {*} env
 * @param {string} gameId
 * @param {string} userId
 * @param {string} chosenTemplateId   body template id, e.g. 'mars'
 * @param {{ empireName?: string, bio?: string }} identity
 */
export async function seedLateFaction(env, gameId, userId, chosenTemplateId, identity = {}) {
  const game = await env.DB
    .prepare('SELECT id, status, current_tick FROM games WHERE id = ?')
    .bind(gameId).first();
  if (!game) throw new Error('not_found:game not found');
  if (game.status !== 'active') throw new Error('not_active:game is not active');

  // No double-seeding: UNIQUE(game_id,user_id) would reject anyway, but
  // surface a clean message.
  const existing = await env.DB
    .prepare('SELECT 1 AS x FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId).first();
  if (existing) throw new Error('already_joined:you already have a faction in this game');

  // The chosen body must be capital-eligible AND currently unclaimed.
  if (!isValidStartingBody(chosenTemplateId)) {
    throw new Error('bad_body:that world cannot host a capital');
  }
  const bodyRowId = `${gameId}:${chosenTemplateId}`;
  const body = await env.DB
    .prepare('SELECT id, template_id, name, type, radius, owner_faction_id FROM game_bodies WHERE id = ? AND game_id = ?')
    .bind(bodyRowId, gameId).first();
  if (!body) throw new Error('bad_body:no such world in this game');
  if (body.owner_faction_id != null) throw new Error('body_taken:that world is already claimed');

  // Next slot = max existing + 1. Slot drives faction id, color, and a
  // default name when the player didn't supply an empire name.
  const slotRow = await env.DB
    .prepare('SELECT COALESCE(MAX(slot), -1) AS maxSlot FROM game_factions WHERE game_id = ?')
    .bind(gameId).first();
  const slot = Number(slotRow?.maxSlot ?? -1) + 1;
  const factionId = `${gameId}:f${slot}`;
  const tick = Number(game.current_tick ?? 0);
  const now = Date.now();

  const empire = (typeof identity.empireName === 'string' ? identity.empireName.trim() : '') || null;
  const bio = (typeof identity.bio === 'string' && identity.bio.trim()) ? identity.bio.trim() : null;
  const name = empire || FACTION_NAMES[slot % FACTION_NAMES.length];
  // Two-tone (§5): honor lobby color prefs when the latecomer set them
  // (room id == game id); else rotation primary + derived secondary.
  const prefRow = await env.DB
    .prepare('SELECT color, color2, emblem FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(gameId, userId).first();
  // Late joiner: the newcomer must not arrive wearing somebody else's
  // flag. Checked against what is actually ON THE BOARD, not against the
  // lobby — same reasoning as the emblem block below. The lobby only
  // compares room_members to each other, and factions that took a
  // DEFAULT colour at seed time never wrote it back there, so a
  // perfectly legal lobby pick can still be flying in the game already.
  const usedColors = ((await env.DB
    .prepare('SELECT color FROM game_factions WHERE game_id = ? AND color IS NOT NULL')
    .bind(gameId)
    .all()).results ?? []).map(r => normalizeHex(r.color)).filter(Boolean);
  const prefColor = normalizeHex(prefRow?.color);
  let color = (prefColor && !usedColors.includes(prefColor)) ? prefColor : null;
  if (!color) {
    color = FACTION_COLORS[slot % FACTION_COLORS.length];
    for (let i = 0; i < FACTION_COLORS.length; i++) {
      const c = FACTION_COLORS[(slot + i) % FACTION_COLORS.length];
      if (!usedColors.includes(c)) { color = c; break; }
    }
  }
  const color2 = normalizeHex(prefRow?.color2) || deriveSecondary(color);

  // Emblem for the latecomer. Unlike colour, a PICK can lose here: the
  // lobby's uniqueness check only compares room_members against each
  // other, and factions that took a DEFAULT emblem at seed time never
  // wrote one back to room_members. So a latecomer's perfectly legal
  // lobby pick can still be flying on the board already — check against
  // what's actually in the game, not what's in the lobby.
  const usedEmblems = ((await env.DB
    .prepare('SELECT emblem FROM game_factions WHERE game_id = ? AND emblem IS NOT NULL')
    .bind(gameId)
    .all()).results ?? []).map(r => r.emblem);
  const prefEmblem = isEmblemId(prefRow?.emblem) ? prefRow.emblem : null;
  const emblem = (prefEmblem && !usedEmblems.includes(prefEmblem))
    ? prefEmblem
    : defaultEmblemFor(slot, usedEmblems);

  // Capital city HP. This read used to be missing entirely: the INSERT
  // below bound `capitalCityHp`, which is a LOCAL of seedGameWorld and
  // simply does not exist in this function — every late join threw
  // ReferenceError before touching the database.
  //
  // esbuild cannot see it (a free identifier is legal until it runs) and
  // no test exercised this path, so it sat there. sim/emblemClash.mjs
  // found it by accident on its first late-join scenario.
  let capitalCityHp = STARTER_CITY_HP;
  try {
    const gc = await import('./gameConfig.js');
    const conf = await gc.cfg(env, gameId);
    capitalCityHp = conf.city_base_hp ?? STARTER_CITY_HP;
  } catch {
    // Same tolerance seedGameWorld shows: an unreadable config must not
    // block a player from being seated.
  }

  const stmts = [];

  // 1) faction row — same starting resources as the founders.
  stmts.push(
    env.DB.prepare(
      `INSERT INTO game_factions
        (id, game_id, user_id, slot, name, color, color2, emblem, status, bio,
         capital_body_id, reputation, senate_weight,
         metal, fuel, gold, science,
         research_tech_id, research_progress, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?,
               ?, 0, 1,
               ?, ?, ?, ?,
               NULL, 0, ?)`,
    ).bind(
      factionId, gameId, userId, slot, name, color, color2, emblem, bio,
      bodyRowId,
      STARTING_RESOURCES.metal, STARTING_RESOURCES.fuel,
      STARTING_RESOURCES.gold, STARTING_RESOURCES.science,
      now,
    ),
  );

  // 2) claim the chosen body — develop it like a capital.
  stmts.push(
    env.DB.prepare(
      `UPDATE game_bodies
          SET owner_faction_id = ?, development_level = ?, shipyard_level = 1,
              claimed_at_tick = ?, developed_at_tick = ?
        WHERE id = ? AND game_id = ? AND owner_faction_id IS NULL`,
    ).bind(factionId, HOME_DEVELOPMENT_LEVEL, tick, tick, bodyRowId, gameId),
  );

  // 3) starter fleet — 2 frigates + 1 freighter parked at the capital.
  STARTER_FLEET.forEach((ship, i) => {
    const id = `${gameId}:s${slot}_${chosenTemplateId}_${i}`;
    const rp = (body.radius ?? 10) * 1.5;
    const ra = (body.radius ?? 10) * 2.0;
    // Spread ships around the body without needing the seed RNG.
    const omega = (i / STARTER_FLEET.length) * Math.PI * 2;
    const m0 = ((i + 1) / (STARTER_FLEET.length + 1)) * Math.PI * 2;
    const stats = SHIP_COMBAT_STATS[ship.class] ?? { hp: 50, damage_per_tick: 0 };
    stmts.push(
      env.DB.prepare(
        `INSERT INTO game_ships
          (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
           orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
           fuel, fuel_max, status, built_at_tick,
           hp, hp_max, damage_per_tick)
         VALUES (?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, 1,
                 ?, ?, 'active', ?,
                 ?, ?, ?)`,
      ).bind(
        id, gameId, factionId, `${ship.baseName} of ${body.name}`, ship.class, bodyRowId,
        rp, ra, omega, m0, tick,
        ship.fuelMax, ship.fuelMax, tick,
        stats.hp, stats.hp, stats.damage_per_tick,
      ),
    );
  });

  // 4) capital city — pop 1, auto-collector, so harvest starts immediately.
  const cityId = `${gameId}:c${slot}_${chosenTemplateId}`;
  stmts.push(
    env.DB.prepare(
      `INSERT INTO game_settlements
        (id, game_id, body_id, owner_faction_id, type, name,
         hp, hp_max, population,
         surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
         created_at_tick, last_growth_tick, last_harvest_tick,
         has_collector, collector_built_tick)
       VALUES (?, ?, ?, ?, 'city', ?,
               ?, ?, 1,
               ?, NULL, NULL, NULL, NULL, NULL,
               ?, ?, ?,
               1, ?)`,
    ).bind(
      cityId, gameId, bodyRowId, factionId, `${name} Capital`,
      capitalCityHp, capitalCityHp,
      0, tick, tick, tick, tick,
    ),
  );

  // 5) chronicle — public so everyone sees the new arrival.
  const payload = { faction_id: factionId, name, color, slot, capital_body_id: bodyRowId, capital_name: body.name };
  stmts.push(
    env.DB.prepare(
      `INSERT INTO chronicle_entries
         (id, game_id, tick_number, kind, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'faction_joined', ?, 'public', ?)`,
    ).bind(newEntryId(), gameId, tick, JSON.stringify(payload), now),
  );

  await env.DB.batch(stmts);
  return { ok: true, faction_id: factionId, slot, name };
}

/**
 * GET /api/games/:gameId/joinable-bodies
 * Lists capital-eligible worlds that are still unclaimed, for the
 * late-join world picker. Auth required + room membership (the invite
 * link funnels the newcomer through join-by-code first, which inserts
 * the room_members row). Also reports whether the caller already has a
 * faction (so the client can route them straight into the game).
 */
async function handleJoinableBodies(_req, env, ctx) {
  const { session, params } = ctx;
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return errResponse(400, 'bad_request', 'invalid game id');

  const game = await env.DB
    .prepare('SELECT status FROM games WHERE id = ?')
    .bind(gameId).first();
  if (!game) return errResponse(404, 'not_found', 'game not found');

  const mine = await env.DB
    .prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, session.user_id).first();

  // Defensive self-heal: if the caller already owns a faction here but
  // their room_members row is missing (the orphaned-membership bug —
  // see worker/index.js handleListMyRooms for the long story), put the
  // row back. Without this an invite-link revisit reports
  // already_joined=true but the lobby UI still shows nothing under My
  // Games because that filter keys off room_members. INSERT OR IGNORE
  // is a no-op when the row is already there.
  if (mine) {
    try {
      await env.DB
        .prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
        .bind(gameId, session.user_id, Date.now())
        .run();
    } catch (e) {
      console.warn('handleJoinableBodies: self-heal insert failed', e);
    }
  }

  // Unclaimed, capital-eligible worlds. We intersect STARTING_BODY_IDS
  // (terrestrial + moon) with the live owner_faction_id IS NULL set.
  const rows = (await env.DB
    .prepare(
      `SELECT template_id, name, type, yield_metal, yield_fuel, yield_gold, yield_science
         FROM game_bodies
        WHERE game_id = ? AND owner_faction_id IS NULL
        ORDER BY name ASC`,
    )
    .bind(gameId).all()).results ?? [];
  const joinable = rows
    .filter(r => isValidStartingBody(r.template_id))
    .map(r => ({
      id: r.template_id,
      name: r.name,
      type: r.type,
      yield: { metal: r.yield_metal, fuel: r.yield_fuel, gold: r.yield_gold, science: r.yield_science },
    }));

  return jsonResponse({
    game_status: game.status,
    already_joined: !!mine,
    faction_id: mine?.id ?? null,
    bodies: joinable,
  });
}

/**
 * POST /api/games/:gameId/late-join   { chosen_body, empire_name?, bio? }
 * Seeds a faction for a room member into an active game. The invite
 * link is the authorization (matches the pre-start join model): anyone
 * who is a room member and has no faction yet may claim an unclaimed
 * world. Self-heals room membership so an explicit invite isn't blocked
 * by the room's max_players cap.
 */
async function handleLateJoin(req, env, ctx) {
  const { session, params } = ctx;
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return errResponse(400, 'bad_request', 'invalid game id');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return errResponse(400, 'bad_request', 'invalid body');
  const chosen = body.chosen_body;
  if (typeof chosen !== 'string' || !chosen) {
    return errResponse(400, 'bad_request', 'chosen_body required');
  }

  // SECURITY: enforce the room password for genuine newcomers, mirroring
  // handleJoinRoom. Previously late-join gated only on room membership and
  // then inserted the membership itself, so a brand-new user who knew any
  // active game's id (trivially enumerable via GET /api/rooms) could claim
  // a free faction + fleet + starting resources in a password-protected
  // game they were never invited to. A returning player (already has a
  // game_factions row — membership just vanished) skips the gate, exactly
  // as handleJoinRoom does, since they already passed it on first join.
  const alreadyMember = await isRoomMember(env, gameId, session.user_id);
  if (!alreadyMember) {
    const room = await env.DB
      .prepare('SELECT password_hash FROM rooms WHERE id = ?')
      .bind(gameId)
      .first();
    const returningPlayer = !!(await env.DB
      .prepare('SELECT 1 AS x FROM game_factions WHERE game_id = ? AND user_id = ?')
      .bind(gameId, session.user_id)
      .first());
    if (!returningPlayer && room?.password_hash) {
      const supplied = typeof body.password === 'string' ? body.password : '';
      if (!supplied) return errResponse(401, 'password_required', 'room is password-protected');
      const ok = await verifyPassword(supplied, room.password_hash);
      if (!ok) return errResponse(403, 'bad_password', 'incorrect password');
    }
    // Explicit late-join intentionally bypasses the max_players cap — the
    // host chose to bring this person in; the real constraint is unclaimed
    // worlds (enforced in seedLateFaction).
    await env.DB
      .prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .bind(gameId, session.user_id, Date.now())
      .run();
  }

  let result;
  try {
    result = await seedLateFaction(env, gameId, session.user_id, chosen, {
      empireName: body.empire_name,
      bio: body.bio,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const [code, ...rest] = msg.split(':');
    const message = rest.join(':') || msg;
    const statusByCode = {
      not_found: 404, not_active: 409, already_joined: 409,
      bad_body: 400, body_taken: 409,
    };
    return errResponse(statusByCode[code] ?? 500, code || 'error', message);
  }

  // Mirror the new member into the Room DO so presence/WS stays in sync,
  // and broadcast so other clients refresh their faction roster.
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(gameId));
    await stub.fetch('https://room/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'faction_joined', faction_id: result.faction_id, name: result.name }),
    });
  } catch { /* best-effort */ }

  return jsonResponse(result);
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/joinable-bodies$/,
    auth: 'required',
    handle: handleJoinableBodies,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/late-join$/,
    auth: 'required',
    handle: handleLateJoin,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/factions$/,
    auth: 'required',
    handle: handleListFactions,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/me$/,
    auth: 'required',
    handle: handleMyFaction,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/factions\/me$/,
    auth: 'required',
    handle: handlePatchMyFaction,
  },
];
