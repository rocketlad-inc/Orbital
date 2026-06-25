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

// ============================================================
// Sensor-range reveal (server mirror of src/game/visibility.ts).
//
// The server's CTE fog is presence-based: you see a body's occupants only
// if you have a ship parked there / own it / are at an adjacent body. The
// CLIENT, however, reveals anything inside a friendly sensor radius — which
// is why a player can see Mars + its yields but not the enemy fleet there.
// This closes that gap: we compute which bodies fall inside any friendly
// sensor radius (same ranges + circular-orbit positions the client uses)
// and feed that set into visible_bodies so enemy ships/stations there are
// sent. Occlusion is intentionally NOT replicated — the server reveals a
// superset and the client's line-of-sight model does the final hiding, so
// we never WITHHOLD something the client would draw.
//
// KEEP IN SYNC with SHIP_SENSOR_RANGE / SETTLEMENT_SENSOR_RANGE and
// ORBITAL_SPEED_SCALE in the client. Positions use the cheap circular
// shortcut (bodyPosition's common path); eccentric Kuiper orbits and ram
// trajectories are approximated as circular, which is fine for a generous
// coverage radius.
const SHIP_SENSOR_RANGE = { corvette: 150, frigate: 200, destroyer: 175, freighter: 100 };
const SETTLEMENT_SENSOR_RANGE = { city: 250, station: 400 };
const DEFAULT_SHIP_SENSOR_RANGE = 25;
const DEFAULT_SETTLEMENT_SENSOR_RANGE = 40;
const ORBITAL_SPEED_SCALE = 0.5;
const TWO_PI = Math.PI * 2;

/**
 * Body ids that fall within any friendly (caller + ally) sensor radius.
 * @param bodies     rows: { id, parent_body_id, orbit_radius, orbit_period, angle0 }
 * @param ships      friendly active ships: { ship_class, parent_body_id,
 *                   target_body_id, scheduled_t, arrival_at_tick }  (transit
 *                   fields null when parked)
 * @param settlements friendly settlements: { body_id, type }
 * @param tick       current game tick
 */
function computeSensorVisibleBodyIds(bodies, ships, settlements, tick) {
  const byId = new Map(bodies.map(b => [b.id, b]));
  const posCache = new Map();
  function bodyPos(b) {
    if (!b) return { x: 0, y: 0 };
    const cached = posCache.get(b.id);
    if (cached) return cached;
    let p;
    if (!b.parent_body_id) {
      p = { x: 0, y: 0 };
    } else {
      const pp = bodyPos(byId.get(b.parent_body_id));
      const r = b.orbit_radius ?? 0;
      const period = b.orbit_period ?? 0;
      const angle = (b.angle0 ?? 0) + (period > 0 ? (TWO_PI * tick * ORBITAL_SPEED_SCALE / period) : 0);
      p = { x: pp.x + Math.cos(angle) * r, y: pp.y + Math.sin(angle) * r };
    }
    posCache.set(b.id, p);
    return p;
  }

  const sensors = [];
  for (const s of ships) {
    const range = SHIP_SENSOR_RANGE[s.ship_class] ?? DEFAULT_SHIP_SENSOR_RANGE;
    let pos;
    if (s.target_body_id != null && s.arrival_at_tick != null && s.arrival_at_tick > s.scheduled_t) {
      // In transit: the server doesn't track the live torch position, so
      // approximate it as a straight-line lerp between origin and target by
      // flight progress. Good enough for a 100–200u coverage radius.
      const origin = bodyPos(byId.get(s.parent_body_id));
      const target = bodyPos(byId.get(s.target_body_id));
      const frac = Math.max(0, Math.min(1, (tick - s.scheduled_t) / (s.arrival_at_tick - s.scheduled_t)));
      pos = { x: origin.x + (target.x - origin.x) * frac, y: origin.y + (target.y - origin.y) * frac };
    } else {
      pos = bodyPos(byId.get(s.parent_body_id));
    }
    sensors.push({ pos, r2: range * range });
  }
  for (const st of settlements) {
    const range = SETTLEMENT_SENSOR_RANGE[st.type] ?? DEFAULT_SETTLEMENT_SENSOR_RANGE;
    sensors.push({ pos: bodyPos(byId.get(st.body_id)), r2: range * range });
  }
  if (sensors.length === 0) return [];

  const visible = [];
  for (const b of bodies) {
    const bp = bodyPos(b);
    for (const sen of sensors) {
      const dx = bp.x - sen.pos.x;
      const dy = bp.y - sen.pos.y;
      if (dx * dx + dy * dy <= sen.r2) { visible.push(b.id); break; }
    }
  }
  return visible;
}

async function handleGetState(req, env, ctx) {
  const gameId = ctx.params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const game = await env.DB
    .prepare(
      `SELECT id, status, current_tick, tick_interval_ms,
              next_tick_at, started_at, completed_at, map_seed,
              winner_faction_id, victory_type,
              dyson_controller_faction_id, dyson_foundation_settlement_id,
              dyson_started_at_tick,
              dyson_acc_fuel, dyson_acc_ore, dyson_acc_credits, dyson_acc_science,
              dyson_target_fuel, dyson_target_ore, dyson_target_credits, dyson_target_science,
              dyson_hp, dyson_max_hp
         FROM games WHERE id = ?`,
    )
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'game not found');

  // Self-heal: Cloudflare DO alarms have been observed to occasionally
  // not fire on time (game frozen for 2h with no ticks during testing).
  // Two cases we nudge for:
  //   (a) next_tick_at is in the past — the DO never woke. Fire
  //       /tick-now so the alarm runs catch-up.
  //   (b) next_tick_at is NULL on an active non-TBM game — DO storage
  //       drifted (recycled before /game-started landed, host edited
  //       interval before alarm armed, etc.). /tick-now's orphan
  //       branch will set next_tick_at = now + interval and arm the
  //       alarm. Without (b) an orphaned game stalls forever — the
  //       state.js self-heal was bypassing this since the previous
  //       guard required next_tick_at != null.
  // Fire-and-forget — we don't await it so /state stays snappy.
  const isActive = game.status === 'active';
  const isOverdue = game.next_tick_at != null && Date.now() > game.next_tick_at + 1000;
  const isOrphaned = game.next_tick_at == null;
  if (isActive && (isOverdue || isOrphaned)) {
    const stub = env.ROOM.get(env.ROOM.idFromName(game.id));
    stub.fetch('https://room/tick-now', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: false, gameId: game.id }),
    }).catch(() => { /* swallow — best-effort */ });
  }

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

  // Caller's tech levels, keyed by tech_id.
  const techRows = (await env.DB
    .prepare('SELECT tech_id, level FROM faction_techs WHERE game_id = ? AND faction_id = ?')
    .bind(gameId, me.id)
    .all()).results ?? [];
  const tech_levels = Object.fromEntries(techRows.map(r => [r.tech_id, r.level]));

  const factions = (await env.DB
    .prepare(
      `SELECT id, slot, name, color, status, capital_body_id, senate_weight, reputation
         FROM game_factions
        WHERE game_id = ?
        ORDER BY slot ASC`,
    )
    .bind(gameId)
    .all()).results ?? [];

  // Allies — factions the caller co-signs an ACTIVE defense-pact or
  // intel-share treaty with. They share sensor vision: the fog CTEs
  // below expand "my presence" to include allied presence, so anything
  // an ally can see, the caller sees too. (NAP is peace-only, not an
  // alliance, so it's deliberately excluded.) Both signatories must
  // have signed and the treaty must be live (not broken / expired).
  const allyRows = (await env.DB
    .prepare(
      `SELECT DISTINCT ts2.faction_id AS ally_id
         FROM treaties t
         JOIN treaty_signatories ts1
           ON ts1.treaty_id = t.id AND ts1.faction_id = ?2 AND ts1.signed_at_tick IS NOT NULL
         JOIN treaty_signatories ts2
           ON ts2.treaty_id = t.id AND ts2.faction_id != ?2 AND ts2.signed_at_tick IS NOT NULL
        WHERE t.game_id = ?1
          AND t.status = 'active'
          AND t.broken_at_tick IS NULL
          AND t.kind IN ('defense_pact', 'intel_share')
          AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?3)`,
    )
    .bind(gameId, me.id, game.current_tick)
    .all()).results ?? [];
  const allyIds = allyRows.map(r => r.ally_id);

  // Peace partners — superset of allies that also includes NAP-only
  // partners. Used by client threat detection so an inbound ship from
  // anyone we have an active peace treaty with (any kind) doesn't get
  // painted as a threat. NAPs are NOT included in alliedFactionIds (no
  // shared vision), so we run a separate query. Player report: MCRN
  // ships were flagged as a threat after Confederacy signed NAP +
  // Intel-Share with them, because threats.ts had no peace check at all.
  const peaceRows = (await env.DB
    .prepare(
      `SELECT DISTINCT ts2.faction_id AS peace_id
         FROM treaties t
         JOIN treaty_signatories ts1
           ON ts1.treaty_id = t.id AND ts1.faction_id = ?2 AND ts1.signed_at_tick IS NOT NULL
         JOIN treaty_signatories ts2
           ON ts2.treaty_id = t.id AND ts2.faction_id != ?2 AND ts2.signed_at_tick IS NOT NULL
        WHERE t.game_id = ?1
          AND t.status = 'active'
          AND t.broken_at_tick IS NULL
          AND t.kind IN ('nap', 'defense_pact', 'intel_share')
          AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?3)`,
    )
    .bind(gameId, me.id, game.current_tick)
    .all()).results ?? [];
  const peaceIds = peaceRows.map(r => r.peace_id);

  // Faction ids whose presence illuminates the map for the caller:
  // the caller plus every ally. Passed to the fog CTEs as a JSON array
  // (json_each) so the IN-list works for any number of allies without
  // a variable placeholder count.
  const presenceFactionIds = JSON.stringify([me.id, ...allyIds]);

  // Sensor-range reveal. Load orbital params for every body (positions
  // aren't secret) plus the caller's + allies' active ships and
  // settlements, compute which bodies sit inside a friendly sensor radius,
  // and feed that id set into each visible_bodies CTE below as ?3. This is
  // what lets you see an enemy fleet/station at a body your sensors reach
  // without having to physically park there. See computeSensorVisibleBodyIds.
  const sensorBodies = (await env.DB
    .prepare(
      `SELECT id, parent_body_id, orbit_radius, orbit_period, angle0
         FROM game_bodies WHERE game_id = ?1 AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId)
    .all()).results ?? [];
  const sensorShips = (await env.DB
    .prepare(
      `SELECT s.ship_class, s.parent_body_id,
              n.target_body_id, n.scheduled_t, n.arrival_at_tick
         FROM game_ships s
         LEFT JOIN game_ship_nodes n
           ON n.ship_id = s.id AND n.status = 'in_transit'
        WHERE s.game_id = ?1
          AND s.owner_faction_id IN (SELECT value FROM json_each(?2))
          AND s.status = 'active'`,
    )
    .bind(gameId, presenceFactionIds)
    .all()).results ?? [];
  const sensorSettlements = (await env.DB
    .prepare(
      `SELECT body_id, type FROM game_settlements
        WHERE game_id = ?1
          AND owner_faction_id IN (SELECT value FROM json_each(?2))
          AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, presenceFactionIds)
    .all()).results ?? [];
  const sensorVisibleBodyIds = JSON.stringify(
    computeSensorVisibleBodyIds(sensorBodies, sensorShips, sensorSettlements, game.current_tick),
  );

  // Sensor-radius fog. The caller "sees" a body if any of the following:
  //   (1) presence — they own it OR a ship of theirs is orbiting it
  //   (2) sibling-by-parent — it's a moon of a body in (1), so a ship at
  //       Jupiter naturally sees the Galilean moons
  //   (3) parent-by-child — it's the parent of a body in (1), so a ship
  //       at Luna can see Earth. We exclude Sol from this expansion (a
  //       ship at any planet shouldn't auto-illuminate the whole system).
  const bodiesRaw = (await env.DB
    .prepare(
      `WITH my_presence AS (
         SELECT DISTINCT parent_body_id AS bid
           FROM game_ships
          WHERE game_id = ?1 AND owner_faction_id IN (SELECT value FROM json_each(?2)) AND status = 'active'
         UNION
         SELECT id AS bid FROM game_bodies
          WHERE game_id = ?1 AND owner_faction_id IN (SELECT value FROM json_each(?2))
            AND destroyed_at_tick IS NULL
       ),
       -- Parents of presence bodies, only if those parents are
       -- themselves non-stars (their parent_body_id IS NOT NULL).
       -- Extracted into its own CTE so visible_bodies can reuse it
       -- for both the "parent" rule and the "sibling moons" rule
       -- without re-running the same subquery twice.
       my_parents_visible AS (
         SELECT p.id FROM game_bodies p
          WHERE p.game_id = ?1
            AND p.destroyed_at_tick IS NULL
            AND p.parent_body_id IS NOT NULL
            AND p.id IN (
              SELECT parent_body_id FROM game_bodies
               WHERE game_id = ?1
                 AND destroyed_at_tick IS NULL
                 AND id IN (SELECT bid FROM my_presence)
                 AND parent_body_id IS NOT NULL
            )
       ),
       visible_bodies AS (
         -- (1) presence
         SELECT bid FROM my_presence
         UNION
         -- (2) moons of presence bodies
         SELECT id FROM game_bodies
          WHERE game_id = ?1
            AND destroyed_at_tick IS NULL
            AND parent_body_id IN (SELECT bid FROM my_presence)
         UNION
         -- (3) parent of presence body, only if that parent is itself
         --     a non-star (parent_body_id IS NOT NULL on the parent)
         SELECT id FROM my_parents_visible
         UNION
         -- (4) sibling moons — other children of my_parents_visible.
         --     This is the rule that lets a ship at Enceladus see
         --     Titan and Rhea (all sibling moons of Saturn), not just
         --     Saturn itself. Without this, parking at any moon hid
         --     the rest of the system from the player. Restricted to
         --     my_parents_visible (non-star parents only), so a ship
         --     at Saturn does NOT pull in every other planet as a
         --     "sibling of Sol" — that'd reveal the whole map.
         SELECT id FROM game_bodies
          WHERE game_id = ?1
            AND destroyed_at_tick IS NULL
            AND parent_body_id IN (SELECT id FROM my_parents_visible)
         UNION
         -- (5) sensor range — bodies inside a friendly sensor radius,
         --     computed in JS (computeSensorVisibleBodyIds) and passed in
         --     as ?3. Matches the client's sensor model so you see enemy
         --     units your scopes can reach without parking there.
         SELECT value FROM json_each(?3)
       )
       SELECT id, template_id, name, type, parent_body_id, radius, soi, mu,
              orbit_radius, orbit_period, angle0, color,
              yield_metal, yield_fuel, yield_gold, yield_science,
              owner_faction_id, development_level, fortification_level, shipyard_level,
              secret_kind, secret_revealed,
              secret_discovered_by_faction_id, secret_discovered_at_tick,
              orbit_rp, orbit_ra, orbit_omega, orbit_m0,
              ram_target_body_id, ram_start_tick, ram_flip_tick, ram_arrive_tick,
              ram_acceleration, ram_start_pos_x, ram_start_pos_y,
              ram_start_vel_x, ram_start_vel_y,
              ram_intercept_pos_x, ram_intercept_pos_y,
              ram_total_dv, ram_owned_by_faction_id,
              (id IN (SELECT bid FROM visible_bodies)) AS visible_to_me
         FROM game_bodies
        WHERE game_id = ?1
          AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, presenceFactionIds, sensorVisibleBodyIds)
    .all()).results ?? [];

  // Body geometry is physical reality, always visible. But who owns a
  // world is intel — mask owner_faction_id (and the development levels
  // that follow from it) on bodies the caller hasn't actually scouted.
  // The caller's own worlds are always 'visible_to_me=1' via the CTE.
  //
  // Secrets are also intel: unrevealed secret_kind never leaks to the
  // client. After reveal, the secret IS public (it's a chronicle event
  // — every player sees the announcement) so we ship it to everyone.
  const bodies = bodiesRaw.map(b => {
    const isRevealed = b.secret_revealed === 1;
    // Strip unrevealed secret_kind so clients can't sniff what's buried
    // on bodies they haven't visited. After reveal it's broadcast.
    const secretFields = isRevealed
      ? {
          secret_kind: b.secret_kind,
          secret_revealed: 1,
          secret_discovered_by_faction_id: b.secret_discovered_by_faction_id,
          secret_discovered_at_tick: b.secret_discovered_at_tick,
        }
      : {
          secret_kind: null,
          secret_revealed: 0,
          secret_discovered_by_faction_id: null,
          secret_discovered_at_tick: null,
        };
    if (b.visible_to_me) {
      const {
        visible_to_me,
        secret_kind, secret_revealed,
        secret_discovered_by_faction_id, secret_discovered_at_tick,
        ...rest
      } = b;
      return { ...rest, ...secretFields };
    }
    const {
      visible_to_me, owner_faction_id, development_level, fortification_level, shipyard_level,
      secret_kind, secret_revealed,
      secret_discovered_by_faction_id, secret_discovered_at_tick,
      ...rest
    } = b;
    return {
      ...rest,
      owner_faction_id: null,
      development_level: 0,
      fortification_level: 0,
      shipyard_level: 0,
      ...secretFields,
    };
  });

  // Ship fog — same visibility set as the body select above (presence +
  // moons-of-presence + planet-of-moon-presence). Caller's own ships are
  // always visible regardless.
  const ships = (await env.DB
    .prepare(
      `WITH my_presence AS (
         SELECT DISTINCT parent_body_id AS bid
           FROM game_ships
          WHERE game_id = ?1 AND owner_faction_id IN (SELECT value FROM json_each(?2)) AND status = 'active'
         UNION
         SELECT id AS bid FROM game_bodies
          WHERE game_id = ?1 AND owner_faction_id IN (SELECT value FROM json_each(?2))
            AND destroyed_at_tick IS NULL
       ),
       -- Non-star parents of presence bodies. See the long-form CTE
       -- in the bodies query above for the why.
       my_parents_visible AS (
         SELECT p.id FROM game_bodies p
          WHERE p.game_id = ?1 AND p.destroyed_at_tick IS NULL
            AND p.parent_body_id IS NOT NULL
            AND p.id IN (
              SELECT parent_body_id FROM game_bodies
               WHERE game_id = ?1 AND destroyed_at_tick IS NULL
                 AND id IN (SELECT bid FROM my_presence)
                 AND parent_body_id IS NOT NULL
            )
       ),
       visible_bodies AS (
         SELECT bid FROM my_presence
         UNION
         SELECT id FROM game_bodies
          WHERE game_id = ?1 AND destroyed_at_tick IS NULL
            AND parent_body_id IN (SELECT bid FROM my_presence)
         UNION
         SELECT id FROM my_parents_visible
         UNION
         -- Sibling moons — see the bodies-query comment for the why.
         SELECT id FROM game_bodies
          WHERE game_id = ?1 AND destroyed_at_tick IS NULL
            AND parent_body_id IN (SELECT id FROM my_parents_visible)
         UNION
         -- Sensor range — bodies inside a friendly sensor radius (?3,
         -- computed in JS). Reveals enemy units your scopes can reach.
         SELECT value FROM json_each(?3)
       )
       SELECT id, name, ship_class, owner_faction_id, parent_body_id,
              orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
              fuel, fuel_max, hp, hp_max, damage_per_tick,
              rank, combat_history, trades_completed,
              status, built_at_tick,
              icon_variant
         FROM game_ships
        WHERE game_id = ?1
          AND status = 'active'
          AND (owner_faction_id IN (SELECT value FROM json_each(?2))
               OR parent_body_id IN (SELECT bid FROM visible_bodies))`,
    )
    .bind(gameId, presenceFactionIds, sensorVisibleBodyIds)
    .all()).results ?? [];

  // Settlements: same visibility set as ships/bodies above.
  const settlements = (await env.DB
    .prepare(
      `WITH my_presence AS (
         SELECT DISTINCT parent_body_id AS bid
           FROM game_ships
          WHERE game_id = ?1 AND owner_faction_id IN (SELECT value FROM json_each(?2)) AND status = 'active'
         UNION
         SELECT id AS bid FROM game_bodies
          WHERE game_id = ?1 AND owner_faction_id IN (SELECT value FROM json_each(?2))
            AND destroyed_at_tick IS NULL
       ),
       -- Non-star parents of presence bodies. See the long-form CTE
       -- in the bodies query above for the why.
       my_parents_visible AS (
         SELECT p.id FROM game_bodies p
          WHERE p.game_id = ?1 AND p.destroyed_at_tick IS NULL
            AND p.parent_body_id IS NOT NULL
            AND p.id IN (
              SELECT parent_body_id FROM game_bodies
               WHERE game_id = ?1 AND destroyed_at_tick IS NULL
                 AND id IN (SELECT bid FROM my_presence)
                 AND parent_body_id IS NOT NULL
            )
       ),
       visible_bodies AS (
         SELECT bid FROM my_presence
         UNION
         SELECT id FROM game_bodies
          WHERE game_id = ?1 AND destroyed_at_tick IS NULL
            AND parent_body_id IN (SELECT bid FROM my_presence)
         UNION
         SELECT id FROM my_parents_visible
         UNION
         -- Sibling moons — see the bodies-query comment for the why.
         SELECT id FROM game_bodies
          WHERE game_id = ?1 AND destroyed_at_tick IS NULL
            AND parent_body_id IN (SELECT id FROM my_parents_visible)
         UNION
         -- Sensor range — bodies inside a friendly sensor radius (?3,
         -- computed in JS). Reveals enemy units your scopes can reach.
         SELECT value FROM json_each(?3)
       )
       SELECT id, body_id, owner_faction_id, type, name,
              hp, hp_max, population,
              surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
              stockpile_metal, stockpile_fuel, stockpile_gold, stockpile_science,
              created_at_tick, last_growth_tick, last_harvest_tick,
              has_collector, collector_built_tick,
              buildings_json, building_order_json
         FROM game_settlements
        WHERE game_id = ?1
          AND destroyed_at_tick IS NULL
          AND (owner_faction_id IN (SELECT value FROM json_each(?2))
               OR body_id IN (SELECT bid FROM visible_bodies))`,
    )
    .bind(gameId, presenceFactionIds, sensorVisibleBodyIds)
    .all()).results ?? [];

  // Host flag for the EventLog flavor-edit gate. game.id === room.id.
  const hostRow = await env.DB
    .prepare('SELECT host_id FROM rooms WHERE id = ?')
    .bind(gameId).first();
  const isHost = !!hostRow && hostRow.host_id === ctx.session.user_id;

  // Recent public chronicle entries — combat results, key events. Surfaced
  // as a combat log on the canvas. Capped at 30 so the snapshot stays
  // small as the game ages.
  const events = (await env.DB
    .prepare(
      `SELECT id, tick_number, kind, actor_faction_id, target_faction_id,
              body_id, ship_id, payload, created_at_ms,
              flavor_override, flavor_edited_by, flavor_edited_at_ms
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
  // Share allies' committed/in_transit burns so the caller's client
  // can reconstruct ship.transit for them (without this, ally ships
  // visibly freeze at their last parked orbit while their own client
  // shows them mid-flight — same fog-of-war contract as bodies/ships
  // taught in commit fea4a42). 'planned' nodes are pre-commit previews
  // and stay private to the owning faction; only the burn-already-
  // started states leak across the ally line, which matches the
  // physical observability rule (a torch is visible to anyone with a
  // sensor on the segment).
  const nodes = (await env.DB
    .prepare(
      `SELECT n.id, n.ship_id, n.sequence, n.anchor_kind, n.anchor_body_id, n.target_body_id,
              n.scheduled_t, n.arrival_at_tick,
              n.dv_prograde, n.dv_normal, n.dv_radial, n.fuel_cost,
              n.status, n.committed_at_tick,
              s.parent_body_id AS departure_body_id
         FROM game_ship_nodes n
         JOIN game_ships s ON s.id = n.ship_id
        WHERE n.game_id = ?1
          AND s.owner_faction_id IN (SELECT value FROM json_each(?2))
          AND (
            s.owner_faction_id = ?3
            OR n.status IN ('committed','in_transit')
          )
          AND n.status IN ('planned','committed','in_transit')
        ORDER BY n.ship_id, n.sequence`,
    )
    .bind(gameId, presenceFactionIds, me.id)
    .all()).results ?? [];

  // In-flight ship builds for the caller's faction. The tick alarm
  // processes these via game_body_build_queue → spawning the ship into
  // game_ships when completes_at_tick is reached. Without surfacing
  // them in /state, the client BuildPanel had no way to render the
  // "BUILDING" progress strip — local optimistic state survived ~1.5s
  // until the next poll wiped MultiplayerGameProvider's buildOrders,
  // so players saw their money vanish with nothing in queue.
  const buildQueue = (await env.DB
    .prepare(
      `SELECT id, body_id, ship_class, queued_at_tick, completes_at_tick,
              icon_variant
         FROM game_body_build_queue
        WHERE game_id = ? AND faction_id = ?
          AND cancelled_at_tick IS NULL`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];

  // Active trade routes for the caller's faction. The auto-pilot loop
  // in worker/room.js resolveTick mutates these; the client deserializer
  // converts server's metal/gold column names back to client's ore/credits.
  const tradeRoutes = (await env.DB
    .prepare(
      `SELECT id, ship_id, origin_body_id, dest_body_id, status,
              cargo_fuel, cargo_metal, cargo_gold, cargo_science,
              created_at_tick
         FROM game_trade_routes
        WHERE game_id = ? AND owner_faction_id = ?
          AND cancelled_at_tick IS NULL`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];

  // Dyson Sphere megaproject — populated only when a foundation has
  // been laid. Null until the first `initiate` POST per match. See
  // migration 0018 + worker/room.js tickDysonSphere for the per-tick
  // delivery + damage logic.
  const dysonSphere = game.dyson_controller_faction_id ? {
    controllerFactionId: game.dyson_controller_faction_id,
    foundationSettlementId: game.dyson_foundation_settlement_id,
    startedAtTick: game.dyson_started_at_tick,
    accumulated: {
      fuel:    game.dyson_acc_fuel    ?? 0,
      ore:     game.dyson_acc_ore     ?? 0,
      credits: game.dyson_acc_credits ?? 0,
      science: game.dyson_acc_science ?? 0,
    },
    target: {
      fuel:    game.dyson_target_fuel    ?? 0,
      ore:     game.dyson_target_ore     ?? 0,
      credits: game.dyson_target_credits ?? 0,
      science: game.dyson_target_science ?? 0,
    },
    hp:    game.dyson_hp     ?? 0,
    maxHp: game.dyson_max_hp ?? 0,
  } : null;

  return json({
    game: {
      id: game.id,
      status: game.status,
      current_tick: game.current_tick,
      tick_interval_ms: game.tick_interval_ms,
      next_tick_at: game.next_tick_at,
      started_at: game.started_at,
      completed_at: game.completed_at,
      map_seed: game.map_seed,
      winner_faction_id: game.winner_faction_id,
      victory_type: game.victory_type,
      dyson_sphere: dysonSphere,
    },
    me: {
      faction_id: me.id,
      slot: me.slot,
      name: me.name,
      color: me.color,
      status: me.status,
      // Host flag — the game id IS the room id, so a single lookup
      // tells the client whether this player can edit any event's
      // flavor (host) vs only events they were a party to. Resolved
      // just above the return.
      is_host: isHost,
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
      tech_levels,
      reputation: me.reputation,
      senate_weight: me.senate_weight,
      // Allies (active defense-pact / intel-share). The client treats
      // these faction ids as friendly for fog of war — shared vision.
      ally_faction_ids: allyIds,
      // Peace partners (active nap / defense-pact / intel-share). Superset
      // of ally_faction_ids — adds NAP-only partners. Used by client
      // threat detection so an inbound ship from a peace partner doesn't
      // get painted as a threat. Sensors / fog are still gated on the
      // narrower ally set.
      peace_faction_ids: peaceIds,
    },
    factions,
    bodies,
    ships,
    settlements,
    nodes,
    events,
    build_queue: buildQueue,
    trade_routes: tradeRoutes,
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
