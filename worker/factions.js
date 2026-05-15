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
// Mirror of public/index.html `BODIES[]` for the alpha map. The renderer
// expects these exact ids. `parent` is a template id; seedGameWorld rewrites
// these into per-game body ids.

// Catalog order matters: parents must come before their children since the
// batch insert relies on the parent body row already existing for the FK.
const BODY_CATALOG = [
  // ---- system primary ----
  { id: 'sol',       name: 'Sol',       type: 'star',         parent: null,
    radius: 28, soi: null,    mu: 0,
    orbit_radius: 0,   orbit_period: 0,    angle0: 0,
    color: '#ffd180',
    yield: { metal: 0, fuel: 0, gold: 0, science: 0 } },

  // ---- inner system terrestrials ----
  { id: 'mercurius', name: 'Mercurius', type: 'terrestrial',  parent: 'sol',
    radius: 4,  soi: 28,     mu: 100,
    orbit_radius: 80,  orbit_period: 56,   angle0: 0.9,
    color: '#9c8a78',
    yield: { metal: 5, fuel: 0, gold: 5, science: 1 } },
  { id: 'inara',     name: 'Inara',     type: 'terrestrial',  parent: 'sol',
    radius: 6,  soi: 40,     mu: 100,
    orbit_radius: 130, orbit_period: 88,   angle0: 0.3,
    color: '#a89878',
    yield: { metal: 4, fuel: 1, gold: 3, science: 2 } },
  { id: 'verda',     name: 'Verda',     type: 'terrestrial',  parent: 'sol',
    radius: 7,  soi: 50,     mu: 100,
    orbit_radius: 210, orbit_period: 168,  angle0: 1.7,
    color: '#5fb079',
    yield: { metal: 3, fuel: 2, gold: 4, science: 5 } },

  // ---- asteroid belt ----
  { id: 'ceres',     name: 'Ceres',     type: 'asteroid',     parent: 'sol',
    radius: 2,  soi: 14,     mu: 50,
    orbit_radius: 255, orbit_period: 220,  angle0: 2.2,
    color: '#888070',
    yield: { metal: 7, fuel: 0, gold: 1, science: 2 } },
  { id: 'pallas',    name: 'Pallas',    type: 'asteroid',     parent: 'sol',
    radius: 2,  soi: 14,     mu: 50,
    orbit_radius: 270, orbit_period: 240,  angle0: 4.0,
    color: '#7a6f60',
    yield: { metal: 8, fuel: 0, gold: 2, science: 1 } },

  // ---- mid system ----
  { id: 'rust',      name: 'Rust',      type: 'terrestrial',  parent: 'sol',
    radius: 6,  soi: 60,     mu: 100,
    orbit_radius: 320, orbit_period: 320,  angle0: 3.4,
    color: '#c0664a',
    yield: { metal: 6, fuel: 1, gold: 2, science: 3 } },
  { id: 'meridian',  name: 'Meridian',  type: 'terrestrial',  parent: 'sol',
    radius: 5,  soi: 45,     mu: 100,
    orbit_radius: 380, orbit_period: 480,  angle0: 0.6,
    color: '#7e9cb3',
    yield: { metal: 2, fuel: 3, gold: 3, science: 6 } },

  // ---- outer system: Jove and moons ----
  { id: 'jove',      name: 'Jove',      type: 'gas-giant',    parent: 'sol',
    radius: 14, soi: 100,    mu: 100,
    orbit_radius: 460, orbit_period: 800,  angle0: 5.2,
    color: '#d4a574',
    yield: { metal: 1, fuel: 6, gold: 2, science: 1 } },
  { id: 'io',        name: 'Io',        type: 'moon',         parent: 'jove',
    radius: 2,  soi: 8,      mu: 50,
    orbit_radius: 22,  orbit_period: 6,    angle0: 0.0,
    color: '#d8c074',
    yield: { metal: 2, fuel: 4, gold: 1, science: 2 } },
  { id: 'europa',    name: 'Europa',    type: 'moon',         parent: 'jove',
    radius: 2,  soi: 9,      mu: 50,
    orbit_radius: 30,  orbit_period: 10,   angle0: 1.4,
    color: '#cfd2c8',
    yield: { metal: 1, fuel: 3, gold: 2, science: 5 } },
  { id: 'ganymede',  name: 'Ganymede',  type: 'moon',         parent: 'jove',
    radius: 3,  soi: 11,     mu: 50,
    orbit_radius: 40,  orbit_period: 14,   angle0: 2.8,
    color: '#8d8478',
    yield: { metal: 3, fuel: 2, gold: 2, science: 3 } },
  { id: 'callisto',  name: 'Callisto',  type: 'moon',         parent: 'jove',
    radius: 3,  soi: 12,     mu: 50,
    orbit_radius: 52,  orbit_period: 22,   angle0: 4.4,
    color: '#5a5048',
    yield: { metal: 4, fuel: 2, gold: 1, science: 2 } },

  // ---- outer system: Korath and moons ----
  { id: 'korath',    name: 'Korath',    type: 'gas-giant',    parent: 'sol',
    radius: 12, soi: 92,     mu: 100,
    orbit_radius: 620, orbit_period: 1240, angle0: 2.6,
    color: '#b48ad9',
    yield: { metal: 0, fuel: 7, gold: 1, science: 2 } },
  { id: 'nyx',       name: 'Nyx',       type: 'moon',         parent: 'korath',
    radius: 2,  soi: 8,      mu: 50,
    orbit_radius: 20,  orbit_period: 8,    angle0: 0.5,
    color: '#3e3a52',
    yield: { metal: 2, fuel: 3, gold: 3, science: 1 } },
  { id: 'arden',     name: 'Arden',     type: 'moon',         parent: 'korath',
    radius: 2,  soi: 9,      mu: 50,
    orbit_radius: 30,  orbit_period: 14,   angle0: 2.3,
    color: '#7e6aa0',
    yield: { metal: 1, fuel: 4, gold: 2, science: 2 } },
  { id: 'vesper',    name: 'Vesper',    type: 'moon',         parent: 'korath',
    radius: 3,  soi: 11,     mu: 50,
    orbit_radius: 44,  orbit_period: 24,   angle0: 4.7,
    color: '#a08fb8',
    yield: { metal: 2, fuel: 3, gold: 3, science: 4 } },
];

// Eligible worlds for ownership = everything that isn't the star (16 worlds).
// 2 worlds/player × 8 players = 16. Caps at 8 players × 2 worlds for v1.

const FACTION_NAMES = [
  'Inaran Republic',
  'Verdan Concord',
  'Rust Combine',
  'Jovian Hegemony',
  'Solar Directorate',
  'Helix Compact',
  'Ember Syndicate',
  'Aurora League',
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
const SECONDARY_DEVELOPMENT_LEVEL = 2;  // second assigned world (outpost)
const WORLDS_PER_PLAYER = 2;
const COMBAT_SHIPS_PER_WORLD = 2;
const CARGO_SHIPS_PER_WORLD = 1;

// Starter fleet template. ship_class is a free-form TEXT column in the
// schema; 'frigate' = combat, 'cargo' = freight. Names are templates;
// suffixed per body so each ship gets a unique label.
const STARTER_FLEET = [
  { class: 'frigate', baseName: 'Vanguard', fuelMax: 800 },
  { class: 'frigate', baseName: 'Sentinel', fuelMax: 800 },
  { class: 'cargo',   baseName: 'Hauler',   fuelMax: 1500 },
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

  // Pull lobby identity (empire_name, bio) alongside the member roster.
  const members = await env.DB
    .prepare(
      `SELECT user_id, joined_at, empire_name, bio
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

  // World assignment: first WORLDS_PER_PLAYER slots from the shuffled list
  // for each faction in slot order. First assigned world = capital.
  // ownership map: body_template_id -> { factionId, isCapital }
  const ownership = new Map();
  factionRows.forEach((f, idx) => {
    const start = idx * WORLDS_PER_PLAYER;
    const myWorlds = shuffled.slice(start, start + WORLDS_PER_PLAYER);
    f.worlds = myWorlds.map(b => b.id);
    f.capital_template_id = myWorlds[0].id;
    f.capital_body_id = bodyRowIdFor(myWorlds[0].id);
    myWorlds.forEach((b, wIdx) => {
      ownership.set(b.id, { factionId: f.id, isCapital: wIdx === 0 });
    });
  });

  const stmts = [];

  // 1) game_bodies — catalog order preserved so parents land before children.
  for (const b of BODY_CATALOG) {
    const own = ownership.get(b.id);
    const isCapital = own ? own.isCapital : false;
    const devLevel = own ? (isCapital ? HOME_DEVELOPMENT_LEVEL : SECONDARY_DEVELOPMENT_LEVEL) : 0;
    const yard = isCapital ? 1 : 0;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO game_bodies
          (id, game_id, template_id, name, type, parent_body_id,
           radius, soi, mu, orbit_radius, orbit_period, angle0, color,
           yield_metal, yield_fuel, yield_gold, yield_science,
           owner_faction_id, development_level, fortification_level, shipyard_level,
           claimed_at_tick, developed_at_tick)
         VALUES (?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?)`,
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
      ),
    );
  }

  // 2) game_factions — carries empire bio.
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
        stmts.push(
          env.DB.prepare(
            `INSERT INTO game_ships
              (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
               orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
               fuel, fuel_max, status, built_at_tick)
             VALUES (?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, 0, 1,
                     ?, ?, 'active', 0)`,
          ).bind(
            id, gameId, f.id, name, ship.class, parentBodyId,
            rp, ra, omega, m0,
            ship.fuelMax, ship.fuelMax,
          ),
        );
      });
    }
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
