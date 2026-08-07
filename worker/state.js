import { hasFeature } from './researchUnlocks.js';
import { getActiveSliders, activeSanctions } from './senate.js';
import { voteWeights } from './systems.js';
import { cfg as loadGameConfig } from './gameConfig.js';

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
//   nodes    — caller's own maneuvers (all states) + allies' & sensor-
//              detected hostiles' in-transit legs, so incoming ships render
//              in flight instead of popping in on arrival
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
// Scaled alongside SYSTEM_SCALE in worker/factions.js — the system was
// spread 2x, so absolute sensor ranges had to grow with it or the fog
// would have silently doubled. KEEP IN SYNC with src/game/visibility.ts.
const SENSOR_SCALE = 2;
const SHIP_SENSOR_RANGE = {
  corvette: 150 * SENSOR_SCALE, frigate: 200 * SENSOR_SCALE,
  destroyer: 175 * SENSOR_SCALE, freighter: 100 * SENSOR_SCALE,
  colony: 75 * SENSOR_SCALE,
};
const SETTLEMENT_SENSOR_RANGE = { city: 250 * SENSOR_SCALE, station: 400 * SENSOR_SCALE };
const DEFAULT_SHIP_SENSOR_RANGE = 25;
const DEFAULT_SETTLEMENT_SENSOR_RANGE = 40;
// KEEP IN SYNC with ORBITAL_SPEED_SCALE in src/physics/orbitalMechanics.ts
// (0.7 since 2026-08, was 0.5). A mismatch means the server computes fog
// of war against planet positions the client never draws.
const ORBITAL_SPEED_SCALE = 0.7;
const TWO_PI = Math.PI * 2;

/**
 * Build the friendly sensor list + shared position helpers used by both
 * the body-visibility pass and the ship-visibility pass.
 *
 * Returns { sensors, bodyPos, shipPos }:
 *   sensors  — Array<{ pos: {x,y}, r2: number }>
 *   bodyPos  — function(body) -> { x, y }   (orbit position at `tick`,
 *                                            recursively over parents)
 *   shipPos  — function(ship) -> { x, y }   (transit lerp if in flight,
 *                                            else parent body position)
 *
 * Ship-class / settlement-type sensor ranges + the circular-orbit shortcut
 * mirror the client (src/game/visibility.ts). In-transit position is a
 * straight-line lerp between origin and target by flight progress — the
 * server doesn't track the live torch state, but for a 100-200u sensor
 * radius the lerp error is well inside the noise.
 *
 * @param bodies         all undestroyed bodies (rows: id, parent_body_id,
 *                       orbit_radius, orbit_period, angle0)
 * @param friendlyShips  ships whose sensors illuminate the map for the
 *                       caller (caller + allies)
 * @param settlements    same for friendly settlements
 * @param tick           current game tick
 */
function buildFriendlySensors(bodies, friendlyShips, settlements, tick) {
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
  function shipPos(s) {
    if (s.target_body_id != null && s.arrival_at_tick != null && s.arrival_at_tick > s.scheduled_t) {
      const origin = bodyPos(byId.get(s.parent_body_id));
      const target = bodyPos(byId.get(s.target_body_id));
      const frac = Math.max(0, Math.min(1, (tick - s.scheduled_t) / (s.arrival_at_tick - s.scheduled_t)));
      return { x: origin.x + (target.x - origin.x) * frac, y: origin.y + (target.y - origin.y) * frac };
    }
    return bodyPos(byId.get(s.parent_body_id));
  }

  const sensors = [];
  for (const s of friendlyShips) {
    let range = SHIP_SENSOR_RANGE[s.ship_class] ?? DEFAULT_SHIP_SENSOR_RANGE;
    // Pathfinder captain (DESIGN-captains §3): +15% sensor range.
    if (typeof s.captain_traits === 'string' && s.captain_traits.includes('pathfinder')) {
      range *= 1.15;
    }
    sensors.push({ pos: shipPos(s), r2: range * range });
  }
  for (const st of settlements) {
    const range = SETTLEMENT_SENSOR_RANGE[st.type] ?? DEFAULT_SETTLEMENT_SENSOR_RANGE;
    sensors.push({ pos: bodyPos(byId.get(st.body_id)), r2: range * range });
  }
  return { sensors, bodyPos, shipPos };
}

/** Body ids that fall within any friendly sensor radius. */
function computeSensorVisibleBodyIds(bodies, sensors, bodyPos) {
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

/**
 * Ship ids whose CURRENT WORLD POSITION falls within any friendly sensor
 * radius. This is the rule the player intuitively expects: a hostile ship
 * flying right through your fleet's sensor cone should appear, regardless
 * of whether either its origin or destination body is in your visibility
 * set. Closes the long-standing gap where an enemy ship in transit between
 * two bodies you couldn't see was invisible even when it was physically
 * inside one of your sensor radii. Mirror of the body-visibility check
 * above; cost is O(ships × sensors) per state poll.
 *
 * @param candidateShips ships to test — typically every non-friendly active
 *                       ship in the game (own/allied ships are already
 *                       visible via the presence rule).
 */
function computeSensorVisibleShipIds(candidateShips, sensors, shipPos) {
  if (sensors.length === 0 || candidateShips.length === 0) return [];
  const visible = [];
  for (const s of candidateShips) {
    const sp = shipPos(s);
    for (const sen of sensors) {
      const dx = sp.x - sen.pos.x;
      const dy = sp.y - sen.pos.y;
      if (dx * dx + dy * dy <= sen.r2) { visible.push(s.id); break; }
    }
  }
  return visible;
}

async function handleGetState(req, env, ctx) {
  const gameId = ctx.params.gameId;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  // Section timing - logged when assembly is slow so `wrangler tail`
  // shows WHERE the time goes instead of us guessing at it.
  const __t0 = Date.now();
  const __marks = [];
  const __mark = (label) => __marks.push(`${label}:${Date.now() - __t0}`);

  const game = await env.DB
    .prepare(
      `SELECT id, status, current_tick, tick_interval_ms, state_version,
              next_tick_at, started_at, completed_at, map_seed,
              winner_faction_id, victory_type, gating_enabled,
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
      `SELECT id, slot, name, color, color2, status,
              capital_body_id, metal, fuel, gold, science,
              research_tech_id, research_progress, research_queue, reputation, senate_weight,
              build_list_json, arrears_gold, arrears_metal
         FROM game_factions
        WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, ctx.session.user_id)
    .first();

  // ---- Versioned state cache ------------------------------------------
  // Assembly below costs ~500ms in a large game (~15 D1 trips that
  // barely overlap). Between mutations the payload is byte-identical
  // (verified live), so: cache per (game, faction, state_version,
  // current_tick). Actions bump state_version at the dispatch choke
  // point BEFORE their handler runs; ticks change current_tick. Either
  // rolls the key, so a hit can never serve pre-action state to the
  // player who just acted. caches.default is per-colo - a miss just
  // pays the old full assembly.
  const __cacheKey = new Request(
    `https://state-cache.orbital.internal/${gameId}/${me ? me.id : 'spec'}/v${game.state_version ?? 0}/t${game.current_tick}`);
  try {
    const cached = await caches.default.match(__cacheKey);
    if (cached) {
      // CRITICAL: strip the stored max-age before returning. The stored
      // copy carries cache-control so the EDGE cache API accepts it -
      // but served as-is, the BROWSER also honored it and served /state
      // from disk for 120s. Result: a player's own action looked like it
      // did nothing until the browser cache expired ("pressing build
      // does nothing" - six duplicate frigates queued by retry-clicks).
      const fresh = new Response(cached.body, { status: cached.status });
      fresh.headers.set('content-type', 'application/json');
      fresh.headers.set('cache-control', 'no-store');
      return fresh;
    }
  } catch { /* cache API unavailable - assemble normally */ }

  if (!me) return err(403, 'not_member', 'not in this game');

  // Caller's tech levels, keyed by tech_id.
  // PERF WAVE (caller tech + trade legs + factions + diplomacy): these queries are independent of one
  // another, but ran as sequential awaits - a D1 round-trip each.
  // 27 serial queries at ~20ms is where /state took its ~550ms
  // (measured: fetch p50 434-650ms; it is the floor under every
  // click). Start them together, await at the original sites so
  // all derived code keeps its exact order and shape.
__mark('pre-wave2');
  const techRowsP = env.DB
    .prepare('SELECT tech_id, level FROM faction_techs WHERE game_id = ? AND faction_id = ?')
    .bind(gameId, me.id)
    .all();
const trade_deliveriesP = env.DB
    .prepare(
      `SELECT id, trade_id, sender_faction_id, recipient_faction_id,
              ship_id, status, pickup_body_id, dest_body_id,
              metal, fuel, gold, science, loaded
         FROM trade_deliveries
        WHERE game_id = ? AND resolved_at_tick IS NULL
          AND (sender_faction_id = ? OR recipient_faction_id = ?)`,
    )
    .bind(gameId, me.id, me.id)
    .all();
const factionsP = env.DB
    .prepare(
      `SELECT id, slot, name, color, color2, status, capital_body_id, senate_weight, reputation
         FROM game_factions
        WHERE game_id = ?
        ORDER BY slot ASC`,
    )
    .bind(gameId)
    .all();
const pactPairRowsP = env.DB
    .prepare(
      `SELECT t.id, ts.faction_id
         FROM treaties t
         JOIN treaty_signatories ts ON ts.treaty_id = t.id
        WHERE t.game_id = ?1
          AND t.status = 'active'
          AND t.broken_at_tick IS NULL
          AND ts.signed_at_tick IS NOT NULL
          AND t.kind IN ('nap', 'defense_pact')
          AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?2)`,
    )
    .bind(gameId, game.current_tick)
    .all();
const allyRowsP = env.DB
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
    .all();
const peaceRowsP = env.DB
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
    .all();
  const techRows = (await techRowsP).results ?? [];
  const tech_levels = Object.fromEntries(techRows.map(r => [r.tech_id, r.level]));

  // Sensor-intel gates (project_intel_gating): what of RIVALS this caller
  // gets to see, keyed off their own Sensors research. hasFeature returns
  // true for everything when the game is ungated (grandfathered).
  const intelGated = (game.gating_enabled ?? 0) === 1;
  const intel = (feat) => hasFeature(feat, tech_levels, intelGated);
  const seeCapitals = intel('intel.capitals');           // sensors 1
  const seeLoadouts = intel('intel.loadouts');           // sensors 5 (Deep Scan)
  const seeAllSettlements = intel('intel.allSettlements'); // sensors 9 (Strategic Array)
  const seeAllShips = intel('intel.allShips');           // sensors 10 (Total Awareness)

  // Active trade-delivery legs involving the caller (either direction).
  // ShipPanel badges hauling freighters with this; the Trades panel
  // reads richer per-trade legs from the trades list endpoint instead.
  const trade_deliveries = (await trade_deliveriesP).results ?? [];

  const factions = (await factionsP).results ?? [];

  // Every active at-peace pair in the game - not just the caller's.
  // The combat-FX layer needs pairwise knowledge ("are THESE two at
  // peace?") to never draw two allied fleets shooting each other when
  // they share an orbit with a real enemy. Kinds mirror room.js's
  // combat suppression exactly (nap + defense_pact): the visual must
  // match what the server will actually never do.
  const pactPairRows = (await pactPairRowsP).results ?? [];
  const pactTreaties = new Map();
  for (const r of pactPairRows) {
    if (!pactTreaties.has(r.id)) pactTreaties.set(r.id, []);
    pactTreaties.get(r.id).push(r.faction_id);
  }
  const pactPairSet = new Set();
  for (const sigs of pactTreaties.values()) {
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const [a, b] = sigs[i] < sigs[j] ? [sigs[i], sigs[j]] : [sigs[j], sigs[i]];
        pactPairSet.add(`${a}|${b}`);
      }
    }
  }
  const pact_pairs = [...pactPairSet];

  // Allies — factions the caller co-signs an ACTIVE defense-pact or
  // intel-share treaty with. They share sensor vision: the fog CTEs
  // below expand "my presence" to include allied presence, so anything
  // an ally can see, the caller sees too. (NAP is peace-only, not an
  // alliance, so it's deliberately excluded.) Both signatories must
  // have signed and the treaty must be live (not broken / expired).
  const allyRows = (await allyRowsP).results ?? [];
  const allyIds = allyRows.map(r => r.ally_id);

  // Peace partners — superset of allies that also includes NAP-only
  // partners. Used by client threat detection so an inbound ship from
  // anyone we have an active peace treaty with (any kind) doesn't get
  // painted as a threat. NAPs are NOT included in alliedFactionIds (no
  // shared vision), so we run a separate query. Player report: MCRN
  // ships were flagged as a threat after Confederacy signed NAP +
  // Intel-Share with them, because threats.ts had no peace check at all.
  const peaceRows = (await peaceRowsP).results ?? [];
  const peaceIds = peaceRows.map(r => r.peace_id);

  // Faction ids whose presence illuminates the map for the caller:
  // the caller plus every ally. Passed to the fog CTEs as a JSON array
  // (json_each) so the IN-list works for any number of allies without
  // a variable placeholder count.
  const presenceFactionIds = JSON.stringify([me.id, ...allyIds]);
  const friendlySet = new Set([me.id, ...allyIds]);

  // Capital Ping (sensors 1): rivals' capital pins are earned, not free.
  // Own + allied capitals stay visible (allies share vision). Only the
  // "this is their CAPITAL" marker is hidden — the body itself renders
  // per normal fog.
  if (!seeCapitals) {
    for (const f of factions) {
      if (!friendlySet.has(f.id)) f.capital_body_id = null;
    }
  }

  // Sensor-range reveal. Load orbital params for every body (positions
  // aren't secret) plus the caller's + allies' active ships and
  // settlements, compute which bodies sit inside a friendly sensor radius,
  // and feed that id set into each visible_bodies CTE below as ?3. This is
  // what lets you see an enemy fleet/station at a body your sensors reach
  // without having to physically park there. See computeSensorVisibleBodyIds.
  // PERF WAVE (sensor presence): these queries are independent of one
  // another, but ran as sequential awaits - a D1 round-trip each.
  // 27 serial queries at ~20ms is where /state took its ~550ms
  // (measured: fetch p50 434-650ms; it is the floor under every
  // click). Start them together, await at the original sites so
  // all derived code keeps its exact order and shape.
__mark('wave2-done');
  const sensorBodiesP = env.DB
    .prepare(
      // template_id/type/name/owner_faction_id ride along for the senate
      // weight roll-up below: this is already the "every undestroyed body,
      // unmasked" read, and the chamber counts the real map rather than
      // the caller's fog. Reusing it keeps /state at the same query count.
      `SELECT id, template_id, name, type, parent_body_id,
              orbit_radius, orbit_period, angle0, orbit_rp, orbit_ra,
              owner_faction_id
         FROM game_bodies WHERE game_id = ?1 AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId)
    .all();
const sensorShipsP = env.DB
    .prepare(
      `SELECT s.ship_class, s.parent_body_id,
              c.traits_json AS captain_traits,
              n.target_body_id, n.scheduled_t, n.arrival_at_tick
         FROM game_ships s
         LEFT JOIN game_captains c ON c.id = s.captain_id
         LEFT JOIN game_ship_nodes n
           ON n.ship_id = s.id AND n.status = 'in_transit'
        WHERE s.game_id = ?1
          AND s.owner_faction_id IN (SELECT value FROM json_each(?2))
          AND s.status = 'active'`,
    )
    .bind(gameId, presenceFactionIds)
    .all();
const sensorSettlementsP = env.DB
    .prepare(
      `SELECT body_id, type FROM game_settlements
        WHERE game_id = ?1
          AND owner_faction_id IN (SELECT value FROM json_each(?2))
          AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, presenceFactionIds)
    .all();
  const sensorBodies = (await sensorBodiesP).results ?? [];
  const sensorShips = (await sensorShipsP).results ?? [];
  const sensorSettlements = (await sensorSettlementsP).results ?? [];
  const { sensors, bodyPos, shipPos } = buildFriendlySensors(
    sensorBodies, sensorShips, sensorSettlements, game.current_tick,
  );
  const sensorVisibleBodyIds = JSON.stringify(
    computeSensorVisibleBodyIds(sensorBodies, sensors, bodyPos),
  );

  // Senate weight for every faction, derived here rather than trusted
  // from the game_factions.senate_weight column. That column was seeded
  // at 1 and never written, so the scoreboard's ★ read "1" for an empire
  // holding half the map. Computing it from bodies we've already loaded
  // costs no extra query and can't go stale.
  // Only ACTIVE factions get the base 1 — it's a seat in the chamber, and
  // an eliminated empire doesn't hold one (mirrors voteWeightFor).
  const senateWeights = voteWeights(
    sensorBodies, factions.filter(f => f.status === 'active').map(f => f.id),
  );
  for (const f of factions) f.senate_weight = senateWeights.get(f.id) ?? 0;

  // Non-friendly ship candidates for the sensor-on-ship visibility pass.
  // An enemy ship parked at a body in visible_bodies is already covered by
  // the parent_body_id rule below; this pass adds the IN-FLIGHT case where
  // a hostile is crossing a friendly sensor cone between two bodies you
  // can't see. Load all non-presence active ships with the same in-transit
  // fields used for friendly sensor positioning so shipPos() can lerp.
  const candidateEnemyShips = sensors.length > 0 ? ((await env.DB
    .prepare(
      `SELECT s.id, s.ship_class, s.parent_body_id,
              n.target_body_id, n.scheduled_t, n.arrival_at_tick
         FROM game_ships s
         LEFT JOIN game_ship_nodes n
           ON n.ship_id = s.id AND n.status = 'in_transit'
        WHERE s.game_id = ?1
          AND s.status = 'active'
          AND s.owner_faction_id NOT IN (SELECT value FROM json_each(?2))`,
    )
    .bind(gameId, presenceFactionIds)
    .all()).results ?? []) : [];
  const sensorVisibleShipIds = JSON.stringify(
    computeSensorVisibleShipIds(candidateEnemyShips, sensors, shipPos),
  );

  // Sensor-radius fog. The caller "sees" a body if any of the following:
  //   (1) presence — they own it OR a ship of theirs is orbiting it
  //   (2) sibling-by-parent — it's a moon of a body in (1), so a ship at
  //       Jupiter naturally sees the Galilean moons
  //   (3) parent-by-child — it's the parent of a body in (1), so a ship
  //       at Luna can see Earth. We exclude Sol from this expansion (a
  //       ship at any planet shouldn't auto-illuminate the whole system).
  // PERF WAVE (world bodies + fleet): these queries are independent of one
  // another, but ran as sequential awaits - a D1 round-trip each.
  // 27 serial queries at ~20ms is where /state took its ~550ms
  // (measured: fetch p50 434-650ms; it is the floor under every
  // click). Start them together, await at the original sites so
  // all derived code keeps its exact order and shape.
__mark('sensors-done');
  const bodiesRawP = env.DB
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
    .all();
const shipsP = env.DB
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
       SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.parent_body_id,
              s.orbit_rp, s.orbit_ra, s.orbit_omega, s.orbit_m0, s.orbit_epoch, s.orbit_direction,
              s.fuel, s.fuel_max, s.hp, s.hp_max, s.damage_per_tick,
              -- Rank belongs to the captain now (spec §2); COALESCE keeps
              -- the field name so older clients keep working unchanged.
              -- Veterancy is CAPTAIN-ONLY (no hull-carried record), so
              -- an uncrewed hull reports rank 0 and an empty history
              -- rather than falling back to its legacy columns.
              COALESCE(c.rank, 0) AS rank,
              CASE WHEN s.captain_id IS NULL THEN NULL ELSE c.combat_history END AS combat_history,
              s.trades_completed,
              s.status, s.built_at_tick, s.last_combat_tick, s.last_damaged_tick,
              -- Who this ship engaged on its last volley (round-robin
              -- single-target combat) — the client aims its combat
              -- animation at this id.
              s.last_target_id,
              s.icon_variant, s.parts_json,
              -- Refit propagation (§2): non-null means this hull refits
              -- to that design (and pays the fee) at its next friendly
              -- yard. The client shows a "Refit pending" badge.
              s.refit_pending_design_id,
              s.stance, s.retreat_hp_pct, s.detonate_hp_pct, s.target_priority,
              s.captain_id, s.fleet_id, c.name AS captain_name, c.avatar_id AS captain_avatar,
              c.traits_json AS captain_traits
         FROM game_ships s
         LEFT JOIN game_captains c ON c.id = s.captain_id
        WHERE s.game_id = ?1
          AND s.status = 'active'
          AND (s.owner_faction_id IN (SELECT value FROM json_each(?2))
               OR s.parent_body_id IN (SELECT bid FROM visible_bodies)
               -- Sensor-on-SHIP reveal: a hostile whose current world
               -- position falls inside a friendly sensor radius shows
               -- up, even if neither its origin nor destination body is
               -- visible. ?4 = JSON array of ship ids computed in JS via
               -- computeSensorVisibleShipIds against the same sensor list
               -- used for body visibility.
               OR s.id IN (SELECT value FROM json_each(?4))
               -- Total Awareness (sensors 10): every enemy ship, fog or
               -- no fog. ?5 = 1 only when the caller has intel.allShips.
               OR 1 = ?5)`,
    )
    .bind(gameId, presenceFactionIds, sensorVisibleBodyIds, sensorVisibleShipIds, seeAllShips ? 1 : 0)
    .all();
  const bodiesRaw = (await bodiesRawP).results ?? [];

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
  const ships = (await shipsP).results ?? [];

  // Exactly the ships this observer is receiving. Any of them that's
  // in-transit needs its node sent too, or the client can't place it on
  // its arc and falls back to the ship's origin body — rendering a
  // moving ship as parked (player report: a colony that had left Deimos
  // for Umbriel still showed parked at Deimos for the body's owner,
  // because the ship reached them via the visible-body path, which the
  // narrower sensor-only node gate missed). Gating the node on THIS set
  // guarantees node visibility exactly tracks ship visibility.
  const sentShipIds = JSON.stringify(ships.map(s => s.id));

  // Fleets (DESIGN-fleets.md). Visible when yours OR any member ship is
  // in the ships payload above — a named enemy fleet you can see is
  // intel; one entirely outside your sensors stays unknown.
  // PERF WAVE (tail entities): these queries are independent of one
  // another, but ran as sequential awaits - a D1 round-trip each.
  // 27 serial queries at ~20ms is where /state took its ~550ms
  // (measured: fetch p50 434-650ms; it is the floor under every
  // click). Start them together, await at the original sites so
  // all derived code keeps its exact order and shape.
__mark('world-done');
  const fleetsP = env.DB
    .prepare(
      `SELECT f.id, f.faction_id, f.name, f.flag_captain_id, f.created_at_tick,
              fc.name AS flag_captain_name, fc.rank AS flag_captain_rank,
              fc.traits_json AS flag_captain_traits,
              (SELECT s2.id FROM game_ships s2
                WHERE s2.fleet_id = f.id AND s2.captain_id = f.flag_captain_id
                LIMIT 1) AS flagship_id
         FROM game_fleets f
         LEFT JOIN game_captains fc ON fc.id = f.flag_captain_id
        WHERE f.game_id = ?1
          AND (f.faction_id = ?2
               OR EXISTS (SELECT 1 FROM game_ships ms
                           WHERE ms.fleet_id = f.id
                             AND ms.id IN (SELECT value FROM json_each(?3))))`,
    )
    .bind(gameId, me.id, sentShipIds)
    .all();
const captainsP = env.DB
    .prepare(
      `SELECT id, name, avatar_id, bio, rank, combat_history, traits_json,
              ship_id, status, created_at_tick, lost_at_tick, benched_at_tick
         FROM game_captains
        WHERE game_id = ? AND faction_id = ?
        ORDER BY created_at_tick ASC`,
    )
    .bind(gameId, me.id)
    .all();
const settlementsP = env.DB
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
              -- Orbital shields: a second, REGENERATING bar in front of
              -- structure. Shipped raw so the client can draw the pool
              -- and its fraction without knowing the per-level maths.
              shield_hp, shield_hp_max,
              surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
              stockpile_metal, stockpile_fuel, stockpile_gold, stockpile_science,
              created_at_tick, last_growth_tick, last_harvest_tick,
              -- Stamped when the settlement RETURNS FIRE (it also gates the
              -- return-fire cadence — see resolveTick, so do NOT also stamp
              -- it on taking damage or bombarded settlements stop shooting
              -- back). Surfaced so the Situation Report can keep a
              -- settlement listed for a beat after the last shot; the
              -- "is a hostile parked here" half of that check is what
              -- catches an ungunned city, which never stamps this at all.
              last_combat_tick,
              -- Stamped when the settlement TAKES damage (room.js damage
              -- resolution) — drives the client's persistent battle-damage
              -- fire/smoke for a tick after a hit.
              last_damaged_tick,
              -- The ship this station engaged on its last return-fire
              -- volley (round-robin single-target).
              last_target_id,
              has_collector, collector_built_tick,
              buildings_json, building_order_json
         FROM game_settlements
        WHERE game_id = ?1
          AND destroyed_at_tick IS NULL
          AND (owner_faction_id IN (SELECT value FROM json_each(?2))
               OR body_id IN (SELECT bid FROM visible_bodies)
               -- Strategic Array (sensors 9): every enemy settlement,
               -- fog or no fog. ?4 = 1 only with intel.allSettlements.
               OR 1 = ?4)`,
    )
    .bind(gameId, presenceFactionIds, sensorVisibleBodyIds, seeAllSettlements ? 1 : 0)
    .all();
const settlement_claimsP = env.DB
    .prepare(
      `SELECT DISTINCT body_id, owner_faction_id
         FROM game_settlements
        WHERE game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId)
    .all();
const hostRowP = env.DB
    .prepare('SELECT host_id FROM rooms WHERE id = ?')
    .bind(gameId).first();
const nodesP = env.DB
    .prepare(
      `SELECT n.id, n.ship_id, n.sequence, n.anchor_kind, n.anchor_body_id, n.target_body_id,
              n.scheduled_t, n.arrival_at_tick,
              n.dv_prograde, n.dv_normal, n.dv_radial, n.fuel_cost,
              n.status, n.committed_at_tick,
              s.parent_body_id AS departure_body_id
         FROM game_ship_nodes n
         JOIN game_ships s ON s.id = n.ship_id
        WHERE n.game_id = ?1
          AND n.status IN ('planned','committed','in_transit')
          AND (
            -- Caller: every planned/committed/in_transit leg of own ships.
            s.owner_faction_id = ?3
            -- Allies: their committed/in_transit legs (started moves leak
            -- across the ally line).
            OR (s.owner_faction_id IN (SELECT value FROM json_each(?2))
                AND n.status IN ('committed','in_transit'))
            -- ANY in-transit ship the observer is actually RECEIVING this
            -- poll (?4 = the ids in the ships payload above — friendly,
            -- at-a-visible-body, sensor-detected, or total-awareness).
            -- Node visibility must track ship visibility exactly: a ship
            -- sent WITHOUT its node has no arc, so the client places it at
            -- its origin body and renders a moving ship as parked (player
            -- report: a colony that left Deimos for Umbriel still showed
            -- parked at Deimos for Deimos's owner, who saw the ship via the
            -- visible-body path the old sensor-only gate missed).
            OR (n.status = 'in_transit'
                AND n.ship_id IN (SELECT value FROM json_each(?4)))
          )
        ORDER BY n.ship_id, n.sequence`,
    )
    .bind(gameId, presenceFactionIds, me.id, sentShipIds)
    .all();
const buildQueueP = env.DB
    .prepare(
      `SELECT id, body_id, ship_class, queued_at_tick, completes_at_tick,
              icon_variant, parts_json, status, started_at_tick, build_ticks,
              rush_count, botched
         FROM game_body_build_queue
        WHERE game_id = ? AND faction_id = ?
          AND cancelled_at_tick IS NULL
        ORDER BY queued_at_tick ASC, id ASC`,
    )
    .bind(gameId, me.id)
    .all();
const shipDesignsP = env.DB
    .prepare(
      `SELECT id, ship_class, name, parts_json, icon_variant, is_active, created_at_ms
         FROM game_ship_designs
        WHERE game_id = ? AND faction_id = ?
        ORDER BY created_at_ms ASC`,
    )
    .bind(gameId, me.id)
    .all();
const tradeRoutesP = env.DB
    .prepare(
      `SELECT id, ship_id, origin_body_id, dest_body_id, status,
              cargo_fuel, cargo_metal, cargo_gold, cargo_science,
              created_at_tick
         FROM game_trade_routes
        WHERE game_id = ? AND owner_faction_id = ?
          AND cancelled_at_tick IS NULL`,
    )
    .bind(gameId, me.id)
    .all();
  const fleets = (await fleetsP).results ?? [];

  // --- Effective HP ceiling, computed SERVER-SIDE per ship -----------
  //
  // The client cannot derive this. `hp_max` is the build-time base; the
  // live ceiling is base x rank x armor tech x Bulwark captain x fleet
  // aura — and the client only ever receives its OWN faction's tech, so
  // for a RIVAL's hull it silently dropped the armor multiplier and
  // rendered nonsense like "307/204" (playtest: "what hacks are this
  // health?"). Sending the number the server already enforces makes the
  // client's job pure display. Mirrors worker/room.js: the maintenance
  // pass's effectiveMaxHp and the fleet-aura AXES table.
  try {
    const techRows = (await env.DB
      .prepare('SELECT faction_id, tech_id, level FROM faction_techs WHERE game_id = ?')
      .bind(gameId).all()).results ?? [];
    const lvl = new Map(); // fid -> { armor, shields }
    for (const r of techRows) {
      let m = lvl.get(r.faction_id);
      if (!m) { m = {}; lvl.set(r.faction_id, m); }
      m[r.tech_id] = r.level;
    }
    const armorMulOf = (fid) =>
      1 + 0.08 * Math.max(lvl.get(fid)?.armor ?? 0, lvl.get(fid)?.shields ?? 0);

    // Fleet Bulwark aura — halved, flagship excluded (DESIGN-fleets P2).
    // Queried UNFILTERED (not the visibility-scoped `fleets` above): a
    // ceiling that ignores an aura it can't see would under-report the
    // cap and reproduce the very bug this fixes.
    const auraHp = new Map(); // shipId -> hpMul
    const led = (await env.DB
      .prepare(
        `SELECT f.id, fc.ship_id AS flagship_id, fc.traits_json
           FROM game_fleets f
           JOIN game_captains fc ON fc.id = f.flag_captain_id
          WHERE f.game_id = ? AND f.flag_captain_id IS NOT NULL`)
      .bind(gameId).all()).results ?? [];
    if (led.length > 0) {
      const memberRows = (await env.DB
        .prepare("SELECT id, fleet_id FROM game_ships WHERE game_id = ? AND fleet_id IS NOT NULL AND status = 'active'")
        .bind(gameId).all()).results ?? [];
      for (const f of led) {
        let traits = [];
        try { traits = JSON.parse(f.traits_json || '[]'); } catch { /* bad blob = no aura */ }
        if (!traits.includes('bulwark')) continue;
        const halved = 1 + (1.10 - 1) / 2;
        for (const m of memberRows) {
          if (m.fleet_id === f.id && m.id !== f.flagship_id) auraHp.set(m.id, halved);
        }
      }
    }

    for (const sh of ships) {
      let capHp = 1;
      if (sh.captain_traits) {
        try {
          if (JSON.parse(sh.captain_traits).includes('bulwark')) capHp = 1.10;
        } catch { /* bad blob = no bonus */ }
      }
      sh.hp_max_effective = Math.round(
        (sh.hp_max ?? 0)
        * (1 + 0.01 * Math.max(0, sh.rank ?? 0))
        * armorMulOf(sh.owner_faction_id)
        * capHp
        * (auraHp.get(sh.id) ?? 1),
      );
    }
  } catch (e) {
    // Display-only enrichment: never fail /state over it. The client
    // falls back to its own (own-faction-correct) estimate.
    console.error('hp_max_effective enrichment failed', e);
  }

  // Deep Scan (sensors 5): a rival ship's fitted parts are intel. Without
  // it, non-friendly loadouts are redacted — parts_json is nulled and a
  // flag marks WHY, so the client can show "loadout unknown" instead of
  // mistaking a fitted warship for a bare hull.
  if (!seeLoadouts) {
    for (const s of ships) {
      if (!friendlySet.has(s.owner_faction_id) && s.parts_json) {
        s.parts_json = null;
        s.parts_redacted = 1;
      }
    }
  }
  // Rival CAPTAIN identity is the same class of secret as a fitted
  // loadout (spec §5.2): without Deep Scan a rival row keeps tier+kills
  // (rank stays — it was already public via ships) but loses the person.
  if (!seeLoadouts) {
    for (const s of ships) {
      if (!friendlySet.has(s.owner_faction_id)) {
        s.captain_name = null;
        s.captain_avatar = null;
        s.captain_traits = null;
      }
    }
  }

  // The caller's captain roster — bank + assigned + memorial (spec §5.3).
  const captains = (await captainsP).results ?? [];

  // Settlements: same visibility set as ships/bodies above.
  const settlements = (await settlementsP).results ?? [];

  // Fog-FREE political summary: which bodies carry whose settlements.
  // Deliberately unfiltered, unlike the settlements list above — the
  // political map is common knowledge, the way national borders are.
  // Without this, any system outside your sensor range read UNCLAIMED
  // on the map even when a rival visibly runs seven colonies there
  // (playtest report 2026-07-19). Ownership is the ONLY thing leaked:
  // no hp, population, buildings, stockpiles, or orbits ride along —
  // scouting those still requires actual sensor coverage.
  const settlement_claims = (await settlement_claimsP).results ?? [];

  // Host flag for the EventLog flavor-edit gate. game.id === room.id.
  const hostRow = await hostRowP;
  const isHost = !!hostRow && hostRow.host_id === ctx.session.user_id;

  // Recent public chronicle entries — combat results, key events. Surfaced
  // as a combat log on the canvas. Capped at 30 so the snapshot stays
  // small as the game ages.
  // Two-part feed. A flat "last 30 by recency" let HIGH-VOLUME kinds
  // (tech_advanced, ship_built, building_completed — hundreds of rows
  // each) flood the window, so RARE governance/diplomacy events fell out
  // within a tick or two of happening and never reached the log at all
  // (player report: "the console log doesn't show Senate information" —
  // the senate_vote rows existed in D1 the whole time).
  //
  // So: the recency window PLUS a guaranteed reserve for notable-but-rare
  // kinds. Union'd and de-duped by id, then re-sorted newest-first.
  const NOTABLE_KINDS = [
    'senate_vote', 'senate_passed', 'senate_failed', 'chancellor_elected',
    'treaty_signed', 'treaty_broken', 'victory',
    'asteroid_launched', 'asteroid_impact',
  ];
  const notablePlaceholders = NOTABLE_KINDS.map(() => '?').join(',');
  const EVENT_COLS = `id, tick_number, kind, actor_faction_id, target_faction_id,
              body_id, ship_id, payload, created_at_ms,
              flavor_override, flavor_edited_by, flavor_edited_at_ms`;
  const [recentRows, notableRows] = await Promise.all([
    env.DB
      .prepare(
        `SELECT ${EVENT_COLS}
           FROM chronicle_entries
          WHERE game_id = ? AND visibility = 'public'
          ORDER BY tick_number DESC, created_at_ms DESC
          LIMIT 30`,
      )
      .bind(gameId)
      .all(),
    env.DB
      .prepare(
        `SELECT ${EVENT_COLS}
           FROM chronicle_entries
          WHERE game_id = ? AND visibility = 'public'
            AND kind IN (${notablePlaceholders})
          ORDER BY tick_number DESC, created_at_ms DESC
          LIMIT 15`,
      )
      .bind(gameId, ...NOTABLE_KINDS)
      .all(),
  ]);
  const eventById = new Map();
  for (const r of [...(recentRows.results ?? []), ...(notableRows.results ?? [])]) {
    eventById.set(r.id, r);
  }
  const events = [...eventById.values()].sort(
    (a, b) => (b.tick_number - a.tick_number) || (b.created_at_ms - a.created_at_ms),
  );

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
  const nodes = (await nodesP).results ?? [];

  // In-flight ship builds for the caller's faction. The tick alarm
  // processes these via game_body_build_queue → spawning the ship into
  // game_ships when completes_at_tick is reached. Without surfacing
  // them in /state, the client BuildPanel had no way to render the
  // "BUILDING" progress strip — local optimistic state survived ~1.5s
  // until the next poll wiped MultiplayerGameProvider's buildOrders,
  // so players saw their money vanish with nothing in queue.
  const buildQueue = (await buildQueueP).results ?? [];

  // Fleet upkeep (DESIGN-fleet-economy §1) — server-authoritative per-tick
  // bill for the caller's fleet, WITH the senate multiplier folded in, so
  // the TopBar can show NET income and the designer can quote real upkeep
  // without duplicating the slider lookup client-side. KEEP the class
  // table IN SYNC with worker/room.js upkeep pass + src/game/shipClasses.ts.
  let upkeep = { gold: 0, metal: 0, multiplier: 1 };
  try {
    // Rates come from the game's CONFIG, not a literal. room.js bills the
    // fleet from the same source; a hardcoded copy here meant the Editor
    // could change a rate and leave the UI quoting the old price while
    // the tick charged the new one — the player sees a number that is
    // simply wrong about their own economy.
    const ucfg = await loadGameConfig(env, gameId);
    const UPKEEP = {
      corvette:  { gold: ucfg.upkeep_corvette_gold,  metal: 0 },
      frigate:   { gold: ucfg.upkeep_frigate_gold,   metal: ucfg.upkeep_frigate_metal },
      destroyer: { gold: ucfg.upkeep_destroyer_gold, metal: ucfg.upkeep_destroyer_metal },
      freighter: { gold: ucfg.upkeep_freighter_gold, metal: 0 },
      colony:    { gold: 0, metal: 0 },
    };
    const counts = (await env.DB
      .prepare(
        `SELECT ship_class, COUNT(*) AS n FROM game_ships
          WHERE game_id = ? AND owner_faction_id = ? AND status = 'active'
          GROUP BY ship_class`,
      )
      .bind(gameId, me.id)
      .all()).results ?? [];
    let mult = 1;
    try {
      // me.id: an upkeep law aimed at this player is the bill THEY pay,
      // so the quoted number must resolve for them, not for the floor.
      const sliders = await getActiveSliders(env, gameId, game.current_tick ?? 0, me.id);
      const v = Number(sliders.fleet_upkeep_multiplier);
      if (Number.isFinite(v) && v >= 0) mult = v;
    } catch { /* default */ }
    let g = 0, m = 0;
    const round3 = (n) => Math.round(n * 1000) / 1000;
    // Per-class breakdown, so the fleet panel can show WHERE the bill
    // comes from rather than only its total. Sent from here rather than
    // mirrored client-side for the same reason the rates are: a fourth
    // copy of this table would be a fourth thing to drift.
    const byClass = [];
    for (const row of counts) {
      const u = UPKEEP[row.ship_class];
      if (!u) continue;
      g += u.gold * row.n;
      m += u.metal * row.n;
      byClass.push({
        ship_class: row.ship_class,
        count: row.n,
        gold_each: u.gold,
        metal_each: u.metal,
        gold: round3(u.gold * row.n * mult),
        metal: round3(u.metal * row.n * mult),
      });
    }
    byClass.sort((x, y) => (y.gold + y.metal) - (x.gold + x.metal));
    upkeep = {
      gold: round3(g * mult), metal: round3(m * mult), multiplier: mult,
      by_class: byClass,
      arrears_damage_mult: ucfg.arrears_damage_mult,
    };
  } catch { /* leave zeros */ }

  // Senate sanctions in force this tick. Cheap (one indexed read) and
  // internally non-throwing, so it rides the normal /state poll rather
  // than needing its own fetch.
  const sanctions = await activeSanctions(env, gameId, game.current_tick ?? 0);

  // Ship designs — the caller's design library (ship designer §2).
  // Small table (≤12 per class), so shipping it with every /state poll
  // keeps the designer + BuildPanel in sync without a separate fetch.
  const shipDesigns = (await shipDesignsP).results ?? [];

  // Active trade routes for the caller's faction. The auto-pilot loop
  // in worker/room.js resolveTick mutates these; the client deserializer
  // converts server's metal/gold column names back to client's ore/credits.
  const tradeRoutes = (await tradeRoutesP).results ?? [];

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

  __mark('assembled');
  const __total = Date.now() - __t0;
  if (__total > 250) {
    console.log(`STATE-TIMING ${gameId} total=${__total}ms ${__marks.join(' ')}`);
  }
  const __resp = json({
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
      // Research gating. 0 for games that predate migration 0040 — they
      // grandfather every feature unlocked, so the client must not grey
      // anything out for them. The client mirrors the same flag through
      // hasFeature() that the server gates on.
      gating_enabled: game.gating_enabled ?? 0,
      dyson_sphere: dysonSphere,
    },
    me: {
      faction_id: me.id,
      slot: me.slot,
      name: me.name,
      color: me.color,
      // Two-tone (§5): secondary trim color. Decoration only — meaning
      // must stay in the primary. Null for legacy games (client derives).
      color2: me.color2 ?? null,
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
      // Fleet upkeep (§1): the caller's per-tick maintenance bill (senate
      // multiplier included) and any standing debt. arrears > 0 means the
      // whole fleet is fighting at −25% damage until income clears it.
      upkeep,
      arrears: {
        gold: Number(me.arrears_gold ?? 0),
        metal: Number(me.arrears_metal ?? 0),
      },
      // Senate sanctions in force RIGHT NOW, game-wide, each with the
      // ticks remaining. The client needs the whole list (not just the
      // caller's) so it can say both "2x damage against YOU for 6 more
      // ticks" and "the embargo you voted on has 3 ticks left".
      sanctions,
      research: {
        tech_id: me.research_tech_id,
        progress: me.research_progress,
        queue: (() => { try { return JSON.parse(me.research_queue ?? '[]'); } catch { return []; } })(),
      },
      tech_levels,
      trade_deliveries,
      reputation: me.reputation,
      // Live, not the stale column — see the senateWeights roll-up above.
      senate_weight: senateWeights.get(me.id) ?? 1,
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
    pact_pairs,
    factions,
    bodies,
    ships,
    fleets,
    settlements,
    settlement_claims,
    nodes,
    events,
    build_queue: buildQueue,
    trade_routes: tradeRoutes,
    ship_designs: shipDesigns,
    // Captains (spec): the caller's full roster, bank + memorial.
    captains,
    // Curated build list (migration 0045): the caller's ordered loadout
    // entries. NULL column = never curated → empty array; the client
    // falls back to a sensible default (unlocked bare hulls + active
    // designs) until the player saves an explicit list.
    build_list: (() => {
      try {
        const arr = JSON.parse(me.build_list_json ?? '[]');
        return Array.isArray(arr) ? arr : [];
      } catch { return []; }
    })(),
  });
  // Store for the next identical poll. TTL is a backstop only - the
  // version/tick key is what actually invalidates. Failures are
  // swallowed: caching is an optimization, never a dependency.
  __resp.headers.set('cache-control', 'no-store');
  try {
    const __copy = new Response(__resp.clone().body, {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=120',
      },
    });
    await caches.default.put(__cacheKey, __copy);
  } catch { /* no cache - fine */ }
  return __resp;
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/state$/,
    auth: 'required',
    handle: handleGetState,
  },
];
