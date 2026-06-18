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
    yield: { metal: 5, fuel: 0, gold: 2, science: 1 } },
  { id: 'venus', name: 'Venus', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 43, mu: 150,
    orbit_radius: 134, orbit_period: 126, angle0: 3.18,
    color: '#e8cda0',
    yield: { metal: 3, fuel: 1, gold: 1, science: 4 } },
  { id: 'earth', name: 'Earth', type: 'terrestrial', parent: 'sol',
    radius: 3, soi: 54, mu: 100,
    orbit_radius: 186, orbit_period: 205, angle0: 1.75,
    color: '#4a90d9',
    yield: { metal: 3, fuel: 3, gold: 2, science: 5 } },
  { id: 'luna', name: 'Luna', type: 'moon', parent: 'earth',
    radius: 1.5, soi: 8, mu: 5,
    orbit_radius: 20, orbit_period: TWO_PI * Math.sqrt(8000 / 100), angle0: 0,
    color: '#c0c0c0',
    yield: { metal: 2, fuel: 0, gold: 0, science: 2 } },
  { id: 'mars', name: 'Mars', type: 'terrestrial', parent: 'sol',
    radius: 2.5, soi: 43, mu: 80,
    orbit_radius: 283, orbit_period: 386, angle0: 6.20,
    color: '#c1440e',
    yield: { metal: 6, fuel: 1, gold: 1, science: 3 } },

  // ---- asteroid belt ----
  // Five bodies share the 310-radius orbit, 72° apart (Ceres at 1.20 rad,
  // each subsequent body adds ~1.257 rad / 72°). Players can hop between
  // them for resource extraction without crossing the gap to Mars/Jupiter.
  { id: 'ceres', name: 'Ceres', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 0.5,
    orbit_radius: 360, orbit_period: 555, angle0: 1.20,
    color: '#6b6b6b',
    yield: { metal: 5, fuel: 1, gold: 3, science: 1 } },
  { id: 'vesta', name: 'Vesta', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.3,
    orbit_radius: 360, orbit_period: 555, angle0: 2.46,
    color: '#a89888',
    yield: { metal: 6, fuel: 0, gold: 2, science: 1 } },
  { id: 'pallas', name: 'Pallas', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.25,
    orbit_radius: 360, orbit_period: 555, angle0: 3.71,
    color: '#80706a',
    yield: { metal: 5, fuel: 0, gold: 1, science: 2 } },
  { id: 'hygiea', name: 'Hygiea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2,
    orbit_radius: 360, orbit_period: 555, angle0: 4.97,
    color: '#75655a',
    yield: { metal: 5, fuel: 1, gold: 1, science: 1 } },
  { id: 'juno', name: 'Juno', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 5, mu: 0.2,
    orbit_radius: 360, orbit_period: 555, angle0: 6.23,
    color: '#aa9070',
    yield: { metal: 4, fuel: 0, gold: 3, science: 1 } },

  // ---- rogue asteroids (settable; can host Trajectory Control Thrusters) ----
  // Three belt-class entries interspersed with the existing dwarfs, plus
  // three Kuiper-class with long elliptical paths. Rich in metal + credits
  // to reward the early grab; sparse on fuel/science so they don't strictly
  // dominate planet/moon real estate.
  { id: 'midas', name: 'Midas', type: 'asteroid', parent: 'sol',
    radius: 0.6, soi: 2, mu: 0.04,
    orbit_radius: 345, orbit_period: 525, angle0: 0.4,
    color: '#c8a872',
    yield: { metal: 8, fuel: 0, gold: 6, science: 0 } },
  { id: 'styx_rock', name: 'Styx', type: 'asteroid', parent: 'sol',
    radius: 0.6, soi: 2, mu: 0.04,
    orbit_radius: 370, orbit_period: 584, angle0: 3.0,
    color: '#7a6858',
    yield: { metal: 9, fuel: 0, gold: 5, science: 0 } },
  { id: 'iron_anna', name: 'Iron Anna', type: 'asteroid', parent: 'sol',
    radius: 0.7, soi: 2, mu: 0.05,
    orbit_radius: 390, orbit_period: 632, angle0: 5.1,
    color: '#9a7a5a',
    yield: { metal: 10, fuel: 0, gold: 4, science: 1 } },
  // Kuiper-class — eccentric. rp brings them through inner system on
  // perihelion; ra puts them way past Pluto. Inserter must populate
  // game_bodies.orbit_rp/ra/omega/m0 so bodyPosition uses Kepler.
  { id: 'black_sky', name: 'Black Sky', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03,
    orbit_radius: 1100, orbit_period: 2960, angle0: 0,
    orbit_rp: 200, orbit_ra: 2000, orbit_omega: 0.4, orbit_m0: 1.2,
    color: '#3a3030',
    yield: { metal: 9, fuel: 0, gold: 7, science: 0 } },
  { id: 'vagrant', name: 'Vagrant', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03,
    orbit_radius: 1450, orbit_period: 4470, angle0: 0,
    orbit_rp: 250, orbit_ra: 2650, orbit_omega: 2.1, orbit_m0: 4.7,
    color: '#5a4838',
    yield: { metal: 8, fuel: 0, gold: 8, science: 1 } },
  { id: 'augustin', name: 'Augustín', type: 'asteroid', parent: 'sol',
    radius: 0.5, soi: 2, mu: 0.03,
    orbit_radius: 1900, orbit_period: 6660, angle0: 0,
    orbit_rp: 300, orbit_ra: 3500, orbit_omega: 4.6, orbit_m0: 3.1,
    color: '#6a5040',
    yield: { metal: 7, fuel: 0, gold: 9, science: 1 } },

  // ---- gas giants ----
  { id: 'jupiter', name: 'Jupiter', type: 'gas-giant', parent: 'sol',
    radius: 8, soi: 160, mu: 1000,
    orbit_radius: 460, orbit_period: 800, angle0: 0.60,
    color: '#d4a574',
    yield: { metal: 1, fuel: 6, gold: 1, science: 2 } },
  { id: 'io', name: 'Io', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5,
    orbit_radius: 22, orbit_period: TWO_PI * Math.sqrt(10648 / 1000), angle0: 0,
    color: '#e8d44d',
    yield: { metal: 3, fuel: 2, gold: 1, science: 2 } },
  { id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter',
    radius: 1.5, soi: 5, mu: 5,
    orbit_radius: 34, orbit_period: TWO_PI * Math.sqrt(39304 / 1000), angle0: 1.57,
    color: '#b8c8d8',
    yield: { metal: 1, fuel: 1, gold: 0, science: 6 } },
  { id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 8,
    orbit_radius: 50, orbit_period: TWO_PI * Math.sqrt(125000 / 1000), angle0: 3.14,
    color: '#8a7e72',
    yield: { metal: 4, fuel: 1, gold: 2, science: 3 } },
  { id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter',
    radius: 2, soi: 6, mu: 6,
    orbit_radius: 75, orbit_period: TWO_PI * Math.sqrt(421875 / 1000), angle0: 4.71,
    color: '#5a5a5a',
    yield: { metal: 3, fuel: 0, gold: 3, science: 2 } },

  { id: 'saturn', name: 'Saturn', type: 'gas-giant', parent: 'sol',
    radius: 7, soi: 140, mu: 600,
    orbit_radius: 843.2, orbit_period: 1987, angle0: 0.87,
    color: '#e8d5a3',
    yield: { metal: 1, fuel: 5, gold: 2, science: 3 } },
  { id: 'enceladus', name: 'Enceladus', type: 'moon', parent: 'saturn',
    radius: 1, soi: 3, mu: 2,
    orbit_radius: 20, orbit_period: TWO_PI * Math.sqrt(8000 / 600), angle0: 0,
    color: '#f0f0f0',
    yield: { metal: 1, fuel: 3, gold: 0, science: 6 } },
  { id: 'rhea', name: 'Rhea', type: 'moon', parent: 'saturn',
    radius: 1.5, soi: 4, mu: 4,
    orbit_radius: 37, orbit_period: TWO_PI * Math.sqrt(50653 / 600), angle0: 2.09,
    color: '#a0a0a0',
    yield: { metal: 3, fuel: 1, gold: 1, science: 2 } },
  { id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn',
    radius: 2, soi: 7, mu: 10,
    orbit_radius: 65, orbit_period: TWO_PI * Math.sqrt(274625 / 600), angle0: 4.19,
    color: '#cc9944',
    yield: { metal: 2, fuel: 5, gold: 1, science: 5 } },

  // ---- ice giants ----
  // Outer system compressed ~35-45% so 200-tick matches can reach them.
  { id: 'uranus', name: 'Uranus', type: 'ice-giant', parent: 'sol',
    radius: 5, soi: 110, mu: 200,
    orbit_radius: 1100, orbit_period: 2960, angle0: 5.47,
    color: '#73c2d6',
    yield: { metal: 2, fuel: 4, gold: 1, science: 4 } },
  // Uranus has a five-moon system: Miranda, Ariel, Umbriel (new minor
  // moons close in), then Titania and Oberon further out.
  { id: 'miranda', name: 'Miranda', type: 'moon', parent: 'uranus',
    radius: 1, soi: 3, mu: 1.5,
    orbit_radius: 12, orbit_period: TWO_PI * Math.sqrt(1728 / 200), angle0: 0.78,
    color: '#a8a8a8',
    yield: { metal: 3, fuel: 0, gold: 1, science: 2 } },
  { id: 'ariel', name: 'Ariel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 2.5,
    orbit_radius: 18, orbit_period: TWO_PI * Math.sqrt(5832 / 200), angle0: 2.10,
    color: '#b0a898',
    yield: { metal: 3, fuel: 0, gold: 2, science: 2 } },
  { id: 'umbriel', name: 'Umbriel', type: 'moon', parent: 'uranus',
    radius: 1, soi: 4, mu: 3,
    orbit_radius: 26, orbit_period: TWO_PI * Math.sqrt(17576 / 200), angle0: 4.60,
    color: '#6a655e',
    yield: { metal: 4, fuel: 0, gold: 1, science: 1 } },
  { id: 'titania', name: 'Titania', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4,
    orbit_radius: 35, orbit_period: TWO_PI * Math.sqrt(42875 / 200), angle0: 0,
    color: '#909090',
    yield: { metal: 4, fuel: 0, gold: 2, science: 2 } },
  { id: 'oberon', name: 'Oberon', type: 'moon', parent: 'uranus',
    radius: 1.5, soi: 5, mu: 4,
    orbit_radius: 50, orbit_period: TWO_PI * Math.sqrt(125000 / 200), angle0: 3.14,
    color: '#888070',
    yield: { metal: 3, fuel: 0, gold: 3, science: 2 } },

  { id: 'neptune', name: 'Neptune', type: 'ice-giant', parent: 'sol',
    radius: 5, soi: 120, mu: 250,
    orbit_radius: 1500, orbit_period: 4710, angle0: 5.32,
    color: '#3366cc',
    yield: { metal: 1, fuel: 4, gold: 2, science: 5 } },
  // Neptune's three-moon system: Proteus inner, Triton mid, Nereid outer.
  { id: 'proteus', name: 'Proteus', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 3,
    orbit_radius: 28, orbit_period: TWO_PI * Math.sqrt(21952 / 250), angle0: 1.20,
    color: '#7a7a7a',
    yield: { metal: 3, fuel: 1, gold: 1, science: 2 } },
  { id: 'triton', name: 'Triton', type: 'moon', parent: 'neptune',
    radius: 1.5, soi: 5, mu: 5,
    orbit_radius: 45, orbit_period: TWO_PI * Math.sqrt(91125 / 250), angle0: 0,
    color: '#b8d0e0',
    yield: { metal: 2, fuel: 2, gold: 1, science: 5 } },
  { id: 'nereid', name: 'Nereid', type: 'moon', parent: 'neptune',
    radius: 1, soi: 4, mu: 2,
    orbit_radius: 78, orbit_period: TWO_PI * Math.sqrt(474552 / 250), angle0: 3.95,
    color: '#aab8c4',
    yield: { metal: 2, fuel: 1, gold: 2, science: 3 } },

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
    yield: { metal: 6, fuel: 0, gold: 1, science: 2 } },
  { id: 'haumea', name: 'Haumea', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8,
    orbit_radius: 2050, orbit_period: 7520, angle0: 0.95,
    color: '#d8d0c0',
    yield: { metal: 6, fuel: 0, gold: 2, science: 2 } },
  { id: 'makemake', name: 'Makemake', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 7, mu: 0.8,
    orbit_radius: 2200, orbit_period: 8360, angle0: 3.30,
    color: '#c89868',
    yield: { metal: 5, fuel: 0, gold: 3, science: 2 } },
  { id: 'quaoar', name: 'Quaoar', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 6, mu: 0.6,
    orbit_radius: 2100, orbit_period: 7800, angle0: 5.10,
    color: '#a09080',
    yield: { metal: 6, fuel: 0, gold: 2, science: 1 } },
  { id: 'eris', name: 'Eris', type: 'dwarf', parent: 'sol',
    radius: 1.5, soi: 9, mu: 1,
    orbit_radius: 2400, orbit_period: 9560, angle0: 1.80,
    color: '#e0e0e0',
    yield: { metal: 1, fuel: 0, gold: 5, science: 4 } },
  { id: 'sedna', name: 'Sedna', type: 'dwarf', parent: 'sol',
    radius: 1, soi: 8, mu: 0.7,
    orbit_radius: 3500, orbit_period: 16800, angle0: 2.55,
    color: '#b06040',
    yield: { metal: 7, fuel: 0, gold: 3, science: 3 } },
];

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

// Subset of BODY_CATALOG that players may pick as their starting capital
// in the lobby. Sticking to terrestrials + larger named moons keeps the
// menu manageable and avoids highly-asymmetric starts on tiny asteroids.
export const STARTING_BODY_OPTIONS = BODY_CATALOG
  .filter(b => b.type === 'terrestrial' || b.type === 'moon')
  .map(b => ({
    id: b.id,
    name: b.name,
    type: b.type,
    parent: b.parent,
    yield: b.yield,
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

const STARTING_RESOURCES = { metal: 100, fuel: 200, gold: 50, science: 0 };
const HOME_DEVELOPMENT_LEVEL = 3;       // capital
const SECONDARY_DEVELOPMENT_LEVEL = 2;  // unused now that WORLDS_PER_PLAYER = 1
// One world per faction (the capital). Each capital gets the starter
// fleet + an auto-deployed city so the body is immediately owned and
// visible from tick 0.
const WORLDS_PER_PLAYER = 1;
const COMBAT_SHIPS_PER_WORLD = 2;
const CARGO_SHIPS_PER_WORLD = 1;
const STARTER_CITY_HP = 100;

// Starter fleet template. ship_class is a free-form TEXT column in the
// schema; the canonical class names are corvette/frigate/destroyer/
// freighter — same set used by every server-side gate (no_presence
// deploy check, trade-route auto-pilot, harvest loop). Names are
// templates; suffixed per body so each ship gets a unique label.
//
// Combat stats by ship class. Mirrors src/game/shipClasses.ts on the
// client side. Used both by seedGameWorld (starter fleet) and by the
// Room DO tick resolver (build completions + combat resolution).
export const SHIP_COMBAT_STATS = {
  corvette:  { hp: 40,  damage_per_tick: 5 },
  frigate:   { hp: 80,  damage_per_tick: 10 },
  destroyer: { hp: 200, damage_per_tick: 18 },
  freighter: { hp: 30,  damage_per_tick: 0 },
};

const STARTER_FLEET = [
  { class: 'frigate',   baseName: 'Vanguard', fuelMax: 800 },
  { class: 'frigate',   baseName: 'Sentinel', fuelMax: 800 },
  // Hauler used to be inserted as ship_class='cargo' but every server
  // gate checks for 'freighter' literally — meaning starter Haulers
  // could never deploy cities, never pick up trade-route cargo, and
  // never appear in harvest yields. Now stored consistently as
  // 'freighter'. Migration 0023 backfills existing rows.
  { class: 'freighter', baseName: 'Hauler',   fuelMax: 1500 },
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
  free_collector:   ['moon-outer', 'moon-inner'],
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

function normalizeHex(s) {
  if (typeof s !== 'string') return null;
  if (!HEX6.test(s)) return null;
  return s.startsWith('#') ? s.toLowerCase() : '#' + s.toLowerCase();
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
      `SELECT user_id, joined_at, empire_name, bio, chosen_starting_body
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
  const claimable = BODY_CATALOG.filter(b => b.type !== 'star');
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

  // Factions: empire_name override (from lobby) wins over the default rotation.
  const factionRows = memberRows.map((m, slot) => {
    const empire = (typeof m.empire_name === 'string' ? m.empire_name.trim() : '') || null;
    return {
      id: `${gameId}:f${slot}`,
      slot,
      user_id: m.user_id,
      name: empire || FACTION_NAMES[slot % FACTION_NAMES.length],
      color: FACTION_COLORS[slot % FACTION_COLORS.length],
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
  // Second pass: anyone without a choice gets the first un-claimed shuffled body.
  const fallbackPool = shuffled.filter(b => !claimed.has(b.id));
  let fallbackIdx = 0;
  factionRows.forEach(f => {
    if (!f.capital_template_id) {
      const pick = fallbackPool[fallbackIdx++];
      f.capital_template_id = pick.id;
      claimed.add(pick.id);
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
          (id, game_id, user_id, slot, name, color, status, bio,
           capital_body_id, reputation, senate_weight,
           metal, fuel, gold, science,
           research_tech_id, research_progress, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?,
                 ?, 0, 1,
                 ?, ?, ?, ?,
                 NULL, 0, ?)`,
      ).bind(
        f.id, gameId, f.user_id, f.slot, f.name, f.color, f.bio,
        f.capital_body_id,
        STARTING_RESOURCES.metal, STARTING_RESOURCES.fuel,
        STARTING_RESOURCES.gold, STARTING_RESOURCES.science,
        now,
      ),
    );
  }

  // Pre-compute secret placements. Deterministic from rand (which is
  // seeded from map_seed) so two players entering the same lobby see
  // the same layout. Only un-owned bodies get secrets.
  const secretPlacements = pickSecretPlacements(rand, ownership);

  // 2) game_bodies — catalog order preserved so parents land before children.
  for (const b of BODY_CATALOG) {
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
           orbit_rp, orbit_ra, orbit_omega, orbit_m0)
         VALUES (?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?,
                 ?, 0, NULL, NULL,
                 ?, ?, ?, ?)`,
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
      ),
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

  // 4) flip game status to active.
  stmts.push(
    env.DB.prepare(
      `UPDATE games
         SET status = 'active',
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
    .prepare('SELECT template_id FROM game_bodies WHERE game_id = ?')
    .bind(gameId).all();
  const have = new Set((existing.results ?? []).map(r => r.template_id));

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
        b.radius, b.soi, b.mu, b.orbit_radius, b.orbit_period, b.angle0, b.color,
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
      `SELECT id, user_id, slot, name, color, status, capital_body_id,
              senate_weight, reputation
         FROM game_factions
        WHERE game_id = ?
        ORDER BY slot ASC`,
    )
    .bind(gameId)
    .all();

  return jsonResponse({ factions: rows.results ?? [] });
}

async function handleMyFaction(_req, env, ctx) {
  const { session, params } = ctx;
  const gameId = params.gameId;
  if (!GAME_ID_RE.test(gameId)) return errResponse(400, 'bad_request', 'invalid game id');

  const row = await env.DB
    .prepare(
      `SELECT id, game_id, user_id, slot, name, color, status,
              capital_body_id, reputation, senate_weight,
              metal, fuel, gold, science,
              research_tech_id, research_progress
         FROM game_factions
        WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, session.user_id)
    .first();

  if (!row) return errResponse(404, 'not_found', 'no faction for this user in this game');
  return jsonResponse({ faction: row });
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
    updates.push('color = ?');
    binds.push(hex);
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
      `SELECT id, name, color, slot, capital_body_id
         FROM game_factions
        WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, session.user_id)
    .first();

  return jsonResponse({ faction: fresh });
}

// ---------- routes ----------

export const routes = [
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
