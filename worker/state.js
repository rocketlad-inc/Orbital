// GET /api/games/:gameId/state — full renderer snapshot.
//
// Returns everything the client map canvas needs to draw a frame:
//   game     — id, status, ticks, schedule
//   me       — caller's faction (resources, tech, capital)
//   factions — public info on every faction (id, name, color, slot)
//   bodies   — all bodies in this game (orbit elements + ownership + yields)
//   ships    — all ships (clipped to caller's faction + opponents in caller's SOIs
//              once fog-of-war is wired through here; v1 returns ALL ships so
//              the renderer can paint a complete picture)
//   nodes    — planned/committed maneuvers for caller's ships only
//
// Polled by the client (~once per second when in a game). When we move the
// renderer to be server-authoritative this is the source of truth; the
// client never persists game state, only intent.

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}

async function handleGetState(req, env, ctx) {
  const gameId = ctx.params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const game = await env.DB
    .prepare(
      `SELECT id, status, current_tick, total_tick_target, tick_interval_ms,
              next_tick_at, started_at, completed_at, map_seed,
              winner_faction_id, victory_type
         FROM games WHERE id = ?`,
    )
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'game not found');

  // Caller must be a member of the game.
  const me = await env.DB
    .prepare(
      `SELECT id, slot, name, color, status,
              capital_body_id, metal, fuel, gold, science,
              research_tech_id, research_progress, reputation, senate_weight
         FROM game_factions
        WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, ctx.session.user_id)
    .first();
  if (!me) return err(403, 'not_member', 'not in this game');

  const factions = (await env.DB
    .prepare(
      `SELECT id, slot, name, color, status, capital_body_id, senate_weight, reputation
         FROM game_factions
        WHERE game_id = ?
        ORDER BY slot ASC`,
    )
    .bind(gameId)
    .all()).results ?? [];

  const bodiesRaw = (await env.DB
    .prepare(
      `WITH my_presence AS (
         SELECT DISTINCT parent_body_id AS bid
           FROM game_ships
          WHERE game_id = ?1 AND owner_faction_id = ?2 AND status = 'active'
         UNION
         SELECT id AS bid FROM game_bodies
          WHERE game_id = ?1 AND owner_faction_id = ?2
       )
       SELECT id, template_id, name, type, parent_body_id, radius, soi, mu,
              orbit_radius, orbit_period, angle0, color,
              yield_metal, yield_fuel, yield_gold, yield_science,
              owner_faction_id, development_level, fortification_level, shipyard_level,
              (id IN (SELECT bid FROM my_presence)) AS visible_to_me
         FROM game_bodies
        WHERE game_id = ?1`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];

  // Body geometry is physical reality, always visible. But who owns a
  // world is intel — mask owner_faction_id (and the development levels
  // that follow from it) on bodies the caller hasn't actually scouted.
  // The caller's own worlds are always 'visible_to_me=1' via the CTE.
  const bodies = bodiesRaw.map(b => {
    if (b.visible_to_me) {
      const { visible_to_me, ...rest } = b;
      return rest;
    }
    const { visible_to_me, owner_faction_id, development_level, fortification_level, shipyard_level, ...rest } = b;
    return {
      ...rest,
      owner_faction_id: null,
      development_level: 0,
      fortification_level: 0,
      shipyard_level: 0,
    };
  });

  // Fog of war: caller sees all their own ships unconditionally, plus
  // any opponent ship whose parent_body_id is a body where the caller
  // either owns the body or has at least one of their own ships
  // orbiting. Everything else is invisible. This is the minimum-viable
  // "you can only see what your assets observe" rule — a sensor_coverage
  // pass on tick can later widen this radius.
  const ships = (await env.DB
    .prepare(
      `WITH my_presence AS (
         SELECT DISTINCT parent_body_id AS bid
           FROM game_ships
          WHERE game_id = ?1 AND owner_faction_id = ?2 AND status = 'active'
         UNION
         SELECT id AS bid FROM game_bodies
          WHERE game_id = ?1 AND owner_faction_id = ?2
       )
       SELECT id, name, ship_class, owner_faction_id, parent_body_id,
              orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
              fuel, fuel_max, hp, hp_max, damage_per_tick,
              status, built_at_tick
         FROM game_ships
        WHERE game_id = ?1
          AND status = 'active'
          AND (owner_faction_id = ?2
               OR parent_body_id IN (SELECT bid FROM my_presence))`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];

  // Settlements: caller sees their own + any at a body where they have
  // presence (same fog rule as ships).
  const settlements = (await env.DB
    .prepare(
      `WITH my_presence AS (
         SELECT DISTINCT parent_body_id AS bid
           FROM game_ships
          WHERE game_id = ?1 AND owner_faction_id = ?2 AND status = 'active'
         UNION
         SELECT id AS bid FROM game_bodies
          WHERE game_id = ?1 AND owner_faction_id = ?2
       )
       SELECT id, body_id, owner_faction_id, type, name,
              hp, hp_max, population,
              surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
              stockpile_metal, stockpile_fuel, stockpile_gold, stockpile_science,
              created_at_tick, last_growth_tick, last_harvest_tick
         FROM game_settlements
        WHERE game_id = ?1
          AND destroyed_at_tick IS NULL
          AND (owner_faction_id = ?2
               OR body_id IN (SELECT bid FROM my_presence))`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];

  // Recent public chronicle entries — combat results, key events. Surfaced
  // as a combat log on the canvas. Capped at 30 so the snapshot stays
  // small as the game ages.
  const events = (await env.DB
    .prepare(
      `SELECT id, tick_number, kind, actor_faction_id, target_faction_id,
              body_id, ship_id, payload, created_at_ms
         FROM chronicle_entries
        WHERE game_id = ?
          AND visibility = 'public'
        ORDER BY tick_number DESC, created_at_ms DESC
        LIMIT 30`,
    )
    .bind(gameId)
    .all()).results ?? [];

  // Only the caller's planned maneuvers are returned — opponents' burn
  // plans are private.
  const nodes = (await env.DB
    .prepare(
      `SELECT n.id, n.ship_id, n.sequence, n.anchor_kind, n.anchor_body_id, n.target_body_id,
              n.scheduled_t, n.arrival_at_tick,
              n.dv_prograde, n.dv_normal, n.dv_radial, n.fuel_cost,
              n.status, n.committed_at_tick,
              s.parent_body_id AS departure_body_id
         FROM game_ship_nodes n
         JOIN game_ships s ON s.id = n.ship_id
        WHERE n.game_id = ?
          AND s.owner_faction_id = ?
          AND n.status IN ('planned','committed','in_transit')
        ORDER BY n.ship_id, n.sequence`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];

  return json({
    game: {
      id: game.id,
      status: game.status,
      current_tick: game.current_tick,
      total_tick_target: game.total_tick_target,
      tick_interval_ms: game.tick_interval_ms,
      next_tick_at: game.next_tick_at,
      started_at: game.started_at,
      completed_at: game.completed_at,
      map_seed: game.map_seed,
      winner_faction_id: game.winner_faction_id,
      victory_type: game.victory_type,
    },
    me: {
      faction_id: me.id,
      slot: me.slot,
      name: me.name,
      color: me.color,
      status: me.status,
      capital_body_id: me.capital_body_id,
      resources: {
        metal: me.metal,
        fuel: me.fuel,
        gold: me.gold,
        science: me.science,
      },
      research: {
        tech_id: me.research_tech_id,
        progress: me.research_progress,
      },
      reputation: me.reputation,
      senate_weight: me.senate_weight,
    },
    factions,
    bodies,
    ships,
    settlements,
    nodes,
    events,
  });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/state$/,
    auth: 'required',
    handle: handleGetState,
  },
];
