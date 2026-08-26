import { hasFeature } from './researchUnlocks.js';
import { parseNamePools } from '../src/game/namePools.js';
import { getActiveSliders, activeSanctions, activeLawsFor } from './senate.js';
import { buildCostFactors } from './buildCost.js';
import { SETTLEMENT_COST, COLONIST_FOUND_MULT } from './actions.js';
import { carrierCapFor } from './tradeRoutesV2.js';
import { MEGASTRUCTURES, MEGA_BREACH_HP } from './megastructures.js';
import { upkeepSplit, parsePartsJson } from './shipDesigns.js';
import { voteWeights } from './systems.js';
import { cfg as loadGameConfig } from './gameConfig.js';
import { orbitAngle, burnProgress } from './orbitPos.js';

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
export const SHIP_SENSOR_RANGE = {
  corvette: 150 * SENSOR_SCALE, frigate: 200 * SENSOR_SCALE,
  destroyer: 175 * SENSOR_SCALE, freighter: 100 * SENSOR_SCALE,
  colony: 75 * SENSOR_SCALE,
};
export const SETTLEMENT_SENSOR_RANGE = { city: 250 * SENSOR_SCALE, station: 400 * SENSOR_SCALE };
export const DEFAULT_SHIP_SENSOR_RANGE = 25;
export const DEFAULT_SETTLEMENT_SENSOR_RANGE = 40;

/** Extra sensor reach per Deep Survey Telescope level.
 *
 *  MODEST ON PURPOSE. Settlements already sense at 500/800 and the map
 *  spans ~7000 out to Sedna, so a generous per-level boost would have a
 *  handful of telescopes revealing most of the inner system and make
 *  the survey game trivial. 400/level means one telescope roughly
 *  doubles a city's reach and three are a genuine investment. */
export const TELESCOPE_SENSOR_BONUS = 400;

/** A settlement's sensor reach INCLUDING its telescope. The one place
 *  that answer is computed — /state's fog pass and the tick's meteoroid
 *  discovery pass both call this, because two copies of a range rule is
 *  precisely how a rock becomes visible on the map and un-minable at the
 *  same time. */
export function settlementSensorRange(type, buildingsJson) {
  const base = SETTLEMENT_SENSOR_RANGE[type] ?? DEFAULT_SETTLEMENT_SENSOR_RANGE;
  let lvl = 0;
  try {
    const b = JSON.parse(buildingsJson || '{}');
    lvl = Math.max(0, Number(b?.telescope ?? 0));
  } catch { lvl = 0; }
  return base + lvl * TELESCOPE_SENSOR_BONUS;
}
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
/**
 * @param sensorScale  Multiplies every range. Sensor reach is written in
 *   ABSOLUTE map units, so spreading the map shrinks coverage without
 *   anyone touching a sensor number: at system_scale 4 a station that
 *   used to see its neighbouring world sees a quarter of the way there,
 *   and the map goes dark between planets. Scaling with the spread keeps
 *   a sensor covering the same FRACTION of the system, which is what the
 *   ranges were tuned as. The constants here already carry a hand-applied
 *   SENSOR_SCALE = 2 from the last time the map grew — the same fix,
 *   done by hand, which is exactly why it did not survive the next one.
 */
function buildFriendlySensors(
  bodies, friendlyShips, settlements, tick, sensorScale = 1,
  /** Every complete megastructure, joined to its body's owner. Two
   *  kinds matter here and they pull in opposite directions: a Deep
   *  Space Array you own ADDS a bubble, and a rival's Null Field
   *  SUBTRACTS whatever falls inside it. */
  megas = [],
  /** Faction ids counted as yours — you plus your allies. */
  friendlyFactionIds = [],
) {
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
      const angle = orbitAngle(b.angle0, period, tick);
      p = { x: pp.x + Math.cos(angle) * r, y: pp.y + Math.sin(angle) * r };
    }
    posCache.set(b.id, p);
    return p;
  }
  // Flip-and-burn distance profile. Ships here are NOT coasting: they
  // boost at constant acceleration to the midpoint, flip, and brake the
  // rest of the way (src/physics/torchTransfer.ts). Under constant accel
  // distance goes as t², so the fraction of the LEG covered at time
  // fraction f is 2f² on the way out and its mirror on the way in — not f.
  //
  // This matters because it is not a rounding difference. At quarter
  // flight the true ship has covered 12.5% of the leg while a linear lerp
  // says 25% — the server placed the ship TWICE as far along as it was,
  // and then decided what to reveal from there. The client punches its
  // fog hole at the real torch position (ship.transit.pos, see
  // src/game/visibility.ts), so the lit circle and the revealed contents
  // were computed at two different points: a clear disc with nothing in it.
  function shipPos(s) {
    if (s.target_body_id != null && s.arrival_at_tick != null && s.arrival_at_tick > s.scheduled_t) {
      const origin = bodyPos(byId.get(s.parent_body_id));
      const target = bodyPos(byId.get(s.target_body_id));
      const f = Math.max(0, Math.min(1, (tick - s.scheduled_t) / (s.arrival_at_tick - s.scheduled_t)));
      const frac = burnProgress(f);
      return { x: origin.x + (target.x - origin.x) * frac, y: origin.y + (target.y - origin.y) * frac };
    }
    return bodyPos(byId.get(s.parent_body_id));
  }

  // WHICH SYSTEM a body sits in: the star-orbiting ancestor. Sol's own
  // children are each their own system (Earth and its moons, Mars and
  // its moons); anything deeper resolves to the planet it belongs to.
  // Same walk analytics.js uses to group battles into neighbourhoods.
  const sysCache = new Map();
  function systemOf(bodyId) {
    if (!bodyId) return null;
    if (sysCache.has(bodyId)) return sysCache.get(bodyId);
    let cur = byId.get(bodyId);
    let out = cur ? cur.id : null;
    for (let hops = 0; hops < 8 && cur; hops++) {
      const parent = cur.parent_body_id ? byId.get(cur.parent_body_id) : null;
      if (!parent || parent.type === 'star') { out = cur.id; break; }
      cur = parent;
      out = parent.id;
    }
    sysCache.set(bodyId, out);
    return out;
  }

  const sensors = [];
  for (const s of friendlyShips) {
    let range = (SHIP_SENSOR_RANGE[s.ship_class] ?? DEFAULT_SHIP_SENSOR_RANGE) * sensorScale;
    // Pathfinder captain (DESIGN-captains §3): +15% sensor range.
    if (typeof s.captain_traits === 'string' && s.captain_traits.includes('pathfinder')) {
      range *= 1.15;
    }
    // A HULL ON THE SPOT SEES THROUGH A JAMMER. Not because the jammer
    // is weak, but because it is a jammer: it beats telescopes and
    // arrays reading the system from outside, and it does not beat a
    // destroyer parked in the next orbit. `system` is what earns that —
    // sensors that carry one pierce Null Fields in THAT system and no
    // other. A ship mid-burn is credited to the system it launched
    // from, which is where its parent_body_id still points.
    sensors.push({ pos: shipPos(s), r2: range * range, system: systemOf(s.parent_body_id) });
  }
  for (const st of settlements) {
    // Telescopes count here as well as in the discovery pass. If they
    // did not, a rock could be minable (the tick found it) and invisible
    // (the fog did not), which is the worst of both.
    const range = settlementSensorRange(st.type, st.buildings_json) * sensorScale;
    sensors.push({ pos: bodyPos(byId.get(st.body_id)), r2: range * range });
  }

  // DEEP SPACE ARRAY. Vision you built rather than vision that came with
  // ground you hold — the only way to watch a place you have no reason
  // to settle. Scaled like every other range, so a spread map does not
  // quietly shrink what it covers.
  const friendly = new Set(friendlyFactionIds);
  for (const m of megas) {
    if (m.kind !== 'deep_array' || m.status !== 'complete') continue;
    if (!m.owner_faction_id || !friendly.has(m.owner_faction_id)) continue;
    const eff = MEGASTRUCTURES[m.kind]?.effect ?? {};
    const range = (eff.sensorRange ?? 0) * sensorScale;
    if (range <= 0) continue;
    sensors.push({ pos: bodyPos(byId.get(m.body_id)), r2: range * range });
  }

  // NULL FIELD. A rival's, never your own: standing inside your own
  // jammer and going blind would make it a weapon against its owner.
  // Collected rather than applied here, because it has to cut BODIES and
  // SHIPS alike and those are decided in two different passes.
  const blinds = [];
  for (const m of megas) {
    if (m.kind !== 'null_field' || m.status !== 'complete') continue;
    if (m.owner_faction_id && friendly.has(m.owner_faction_id)) continue;
    const eff = MEGASTRUCTURES[m.kind]?.effect ?? {};
    const range = (eff.blindRange ?? 0) * sensorScale;
    if (range <= 0) continue;
    blinds.push({ pos: bodyPos(byId.get(m.body_id)), r2: range * range, system: systemOf(m.body_id) });
  }

  return { sensors, blinds, bodyPos, shipPos };
}

/** Rival Null Fields covering this point. Empty is the common case. */
function blindsOver(pos, blinds) {
  let out = null;
  for (const b of blinds) {
    const dx = pos.x - b.pos.x;
    const dy = pos.y - b.pos.y;
    if (dx * dx + dy * dy <= b.r2) (out ??= []).push(b);
  }
  return out;
}

/**
 * Can anything of ours actually SEE this point?
 *
 * Reach alone is not enough: a Null Field beats coverage, which is the
 * whole reason the structure exists — otherwise it is a speed bump for
 * the one player it was built against.
 *
 * THE ONE EXCEPTION IS A HULL IN THE SAME SYSTEM. A jammer hides you
 * from telescopes and Deep Space Arrays reading the system from
 * outside; it does not hide you from a destroyer in the next orbit. So
 * a sensor pierces a field only when it carries that field's system,
 * which only ship sensors do — settlements and Arrays never set one and
 * are blinded without exception, as are ships in other systems.
 *
 * Overlapping fields stack: a sensor has to pierce EVERY field over the
 * point, so parking one hull in a system does not open a hole through a
 * second jammer that also happens to cover it.
 */
function revealedBy(pos, sensors, blinds) {
  const over = blinds && blinds.length ? blindsOver(pos, blinds) : null;
  for (const sen of sensors) {
    const dx = pos.x - sen.pos.x;
    const dy = pos.y - sen.pos.y;
    if (dx * dx + dy * dy > sen.r2) continue;
    if (!over) return true;
    if (sen.system && over.every(b => b.system === sen.system)) return true;
  }
  return false;
}

/** Body ids that fall within any friendly sensor radius. */
function computeSensorVisibleBodyIds(bodies, sensors, bodyPos, blinds = []) {
  if (sensors.length === 0) return [];
  const visible = [];
  for (const b of bodies) {
    const bp = bodyPos(b);
    // The FIELD ITSELF stays visible, and so does every other structure.
    // A hole in the map that hides its own cause would read as a
    // rendering fault, and knowing something is being hidden from you is
    // the intelligence the counter is supposed to leave you with.
    if (b.type === 'megastructure') {
      for (const sen of sensors) {
        const dx = bp.x - sen.pos.x;
        const dy = bp.y - sen.pos.y;
        if (dx * dx + dy * dy <= sen.r2) { visible.push(b.id); break; }
      }
      continue;
    }
    if (revealedBy(bp, sensors, blinds)) visible.push(b.id);
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
function computeSensorVisibleShipIds(candidateShips, sensors, shipPos, blinds = []) {
  if (sensors.length === 0 || candidateShips.length === 0) return [];
  const visible = [];
  for (const s of candidateShips) {
    // Blinds apply to HULLS as well as worlds. They did not, so a Null
    // Field hid the terrain and left the fleet standing in the open —
    // which is backwards: hiding what you are DOING is the point, and a
    // rival could read every ship inside the bubble while losing the
    // rocks they flew past.
    if (revealedBy(shipPos(s), sensors, blinds)) visible.push(s.id);
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

  // WAVE 1: the game row and the caller's faction row together.
  // Both bind only (gameId, user_id) — neither has ever needed the
  // other — but they ran as two sequential awaits, so every /state paid
  // two D1 round-trips before assembly could even begin.
  const meP = env.DB
    .prepare(
      `SELECT id, slot, name, color, color2, emblem, status,
              capital_body_id, metal, fuel, gold, science,
              research_tech_id, research_progress, research_queue, reputation, senate_weight,
              build_list_json, arrears_gold, arrears_metal, name_pools
         FROM game_factions
        WHERE game_id = ? AND user_id = ?`,
    )
    .bind(gameId, ctx.session.user_id)
    .first();

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
  const me = await meP;

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
  // Senate sliders: needs only (gameId, current_tick, me.id), all known
  // here, yet it was awaited near the very END of assembly — a whole
  // trailing round-trip after every other wave had finished.
  const activeSlidersP = getActiveSliders(env, gameId, game.current_tick ?? 0, me.id)
    .catch(() => ({}));
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
      `SELECT id, slot, name, color, color2, emblem, status, capital_body_id, senate_weight, reputation
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
// Construction partners — factions the caller may fund megastructures
// with, and pair gates to. Deliberately a SEPARATE list from allies:
// this pact grants no vision, no ceasefire and no defence, so folding
// it into allyIds would quietly hand a co-builder your sensor net.
const buildPartnerRowsP = env.DB
    .prepare(
      `SELECT DISTINCT ts2.faction_id AS partner_id
         FROM treaties t
         JOIN treaty_signatories ts1
           ON ts1.treaty_id = t.id AND ts1.faction_id = ?2 AND ts1.signed_at_tick IS NOT NULL
         JOIN treaty_signatories ts2
           ON ts2.treaty_id = t.id AND ts2.faction_id != ?2 AND ts2.signed_at_tick IS NOT NULL
        WHERE t.game_id = ?1
          AND t.status = 'active'
          AND t.broken_at_tick IS NULL
          AND t.kind = 'construction_pact'
          AND (t.expires_at_tick IS NULL OR t.expires_at_tick > ?3)`,
    )
    .bind(gameId, me.id, game.current_tick)
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
  const constructionPartnerIds = ((await buildPartnerRowsP).results ?? [])
    .map(r => r.partner_id);
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
      `SELECT body_id, type, buildings_json FROM game_settlements
        WHERE game_id = ?1
          AND owner_faction_id IN (SELECT value FROM json_each(?2))
          AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, presenceFactionIds)
    .all();
  // Enemy-ship candidates ride this wave rather than forming their own.
  // Issued UNCONDITIONALLY: the old `sensors.length > 0` guard could only
  // be evaluated after the sensor awaits below, which is precisely what
  // made it a separate round-trip. A player with zero sensors now pays one
  // wasted read; every other player saves a full wave.
  const candidateEnemyShipsP = env.DB
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
    .all();

  // Megastructure sites. The BODY rows already arrive in `bodies` —
  // a site is one — so this is only the side-table state a body
  // cannot express: what is being built and how far along it is.
  // A charging Mega Destroyer is PUBLIC. The whole point of 48 ticks
  // is that the target can see it winding up, so this is not gated on
  // ownership or sensors — a world-killer announcing itself is the
  // counterplay.
  const megastructures = ((await env.DB
    .prepare(
      `SELECT body_id, kind, status, acc_metal, acc_credits,
              cost_metal, cost_credits, partner_body_id, settings_json, hp,
              last_combat_tick, last_target_id, abandoned_at_tick, variant,
              founded_by_faction_id, founded_at_tick, completed_at_tick
         FROM game_megastructures WHERE game_id = ?`,
    )
    .bind(gameId).all()).results ?? []);

  const sensorBodies = (await sensorBodiesP).results ?? [];
  const sensorShips = (await sensorShipsP).results ?? [];
  const sensorSettlements = (await sensorSettlementsP).results ?? [];
  // Sensor reach follows the map's spread — see buildFriendlySensors.
  // cfg is memoised per game, so this is a cache read, not a query.
  // system_scale keeps reach proportional to the map; sensor_scale is
  // the free hand on top, for when proportional still reads too tight.
  // The PRODUCT is what both sides must use — the client had its own
  // hard-coded x2 and no idea the map had grown, so it culled at 800
  // while the server revealed to 3200 and the tighter number won.
  let sensorScale = 1;
  try {
    const sconf = await loadGameConfig(env, gameId);
    const sys = Number(sconf?.system_scale) > 0 ? Number(sconf.system_scale) : 1;
    const own = Number(sconf?.sensor_scale) > 0 ? Number(sconf.sensor_scale) : 1;
    sensorScale = sys * own;
  } catch { sensorScale = 1; }
  // Structures that change what anyone can see, with the owner attached.
  // Read from the body rather than founded_by_faction_id: a captured
  // Array works for whoever holds it now, not whoever paid for it.
  const sensorMegas = (await env.DB
    .prepare(
      `SELECT m.body_id, m.kind, m.status, b.owner_faction_id
         FROM game_megastructures m
         JOIN game_bodies b ON b.id = m.body_id
        WHERE m.game_id = ? AND m.status = 'complete'
          AND b.destroyed_at_tick IS NULL
          AND m.hp > ?
          AND m.kind IN ('deep_array', 'null_field')`,
    )
    // A structure shot below 20% is offline until it repairs. Without
    // this a breached Array keeps watching and a breached Null Field
    // keeps blinding, so the hull bar would be decoration on exactly
    // the two structures whose whole value is what they let you see.
    .bind(gameId, MEGA_BREACH_HP).all()).results ?? [];

  const { sensors, blinds, bodyPos, shipPos } = buildFriendlySensors(
    sensorBodies, sensorShips, sensorSettlements, game.current_tick, sensorScale,
    sensorMegas, [me.id, ...allyIds],
  );
  const sensorVisibleBodyIds = JSON.stringify(
    computeSensorVisibleBodyIds(sensorBodies, sensors, bodyPos, blinds),
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
  // Started up in the sensor wave — it binds only presenceFactionIds, so it
  // never needed the sensor RESULTS, only the same inputs they had.
  const candidateEnemyShips = sensors.length > 0
    ? ((await candidateEnemyShipsP).results ?? [])
    : [];
  const sensorVisibleShipIds = JSON.stringify(
    computeSensorVisibleShipIds(candidateEnemyShips, sensors, shipPos, blinds),
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
              terraformed_at_tick, sterilised_at_tick,
              terraform_acc_metal, terraform_acc_gold,
              terraform_completes_at_tick,
              owner_faction_id, development_level, fortification_level, shipyard_level,
              secret_kind, secret_revealed,
              secret_discovered_by_faction_id, secret_discovered_at_tick,
              orbit_rp, orbit_ra, orbit_omega, orbit_m0,
              ram_target_body_id, ram_start_tick, ram_flip_tick, ram_arrive_tick,
              ram_acceleration, ram_start_pos_x, ram_start_pos_y,
              ram_start_vel_x, ram_start_vel_y,
              ram_intercept_pos_x, ram_intercept_pos_y,
              ram_total_dv, ram_owned_by_faction_id,
              mineral_kind, mineral_remaining, mineral_initial, exhausted_at_tick,
              -- A rock you have SURVEYED. Distinct from visible_to_me,
              -- which is "in sensor range this instant": discovery is
              -- permanent and per faction, so a meteoroid you found last
              -- month stays on your map after it drifts away.
              (SELECT 1 FROM game_body_discoveries d
                WHERE d.game_id = game_bodies.game_id
                  AND d.body_id = game_bodies.id
                  AND d.faction_id = ?4) AS discovered_by_me,
              (id IN (SELECT bid FROM visible_bodies)) AS visible_to_me
         FROM game_bodies
        WHERE game_id = ?1
          AND destroyed_at_tick IS NULL
          -- UNDISCOVERED ROCKS ARE NOT SENT AT ALL. Filtering them on
          -- the client would ship every rock's position to every player
          -- and make the survey game a matter of reading the network
          -- tab. Ordinary bodies are unaffected: they have no mineral
          -- kind, so the first branch keeps them.
          AND (mineral_kind IS NULL
               OR EXISTS (SELECT 1 FROM game_body_discoveries d2
                           WHERE d2.game_id = game_bodies.game_id
                             AND d2.body_id = game_bodies.id
                             AND d2.faction_id = ?4))`,
    )
    .bind(gameId, presenceFactionIds, sensorVisibleBodyIds, me.id)
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
              -- Ship-level hold (migration 0088): cargo that persists
              -- until delivered. Everyone sees it — a laden freighter
              -- is worth pirating, and hiding the load would remove
              -- exactly the incentive the piracy rule creates.
              s.cargo_fuel, s.cargo_metal, s.cargo_gold, s.cargo_science,
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
              s.strike_target_body_id, s.strike_ready_tick,
              -- Refit propagation (§2): non-null means this hull refits
              -- to that design (and pays the fee) at its next friendly
              -- yard. The client shows a "Refit pending" badge.
              s.refit_pending_design_id,
              s.stance, s.retreat_hp_pct, s.detonate_hp_pct, s.target_priority,
              -- ARMED ORDERS. These were set server-side and fired
              -- correctly, but were never SELECTED, and the ships array
              -- is returned as raw rows -- so the client saw no
              -- arrival_action and
              -- resolved it to null on every poll -- the panel forgot a
              -- strike was armed the moment state refreshed. Scheduled
              -- demolition (0110) would have had the same hole, so both
              -- pairs are read back here.
              s.arrival_action, s.arrival_guard, s.fleet_detached,
              s.detonate_at_tick, s.detonate_at_guard, s.detonate_on_hostile, s.detonate_mine_mode,
              s.captain_id, s.fleet_id, c.name AS captain_name, c.avatar_id AS captain_avatar,
              c.traits_json AS captain_traits,
              -- MANUAL MINING: the rock this hull is working by hand
              -- (NULL = idle). Drives the card's start/stop button.
              s.mining_body_id
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
      `SELECT f.id, f.faction_id, f.name, f.flag_captain_id, f.created_at_tick, f.retreat_hp_pct,
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
              buildings_json, building_order_json, building_backlog_json
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
              -- PINNED BY A GRAVITY SINK. Sent because a fleet arriving
              -- eight ticks late with nothing on screen to explain it is
              -- the single most confusing thing the structures can do to
              -- somebody. The client draws a tether from the sink to the
              -- held hull; without these two columns it cannot know a
              -- hull is held at all, only that it is slow.
              n.sink_body_id, n.sink_held_until_tick,
              n.dv_prograde, n.dv_normal, n.dv_radial, n.fuel_cost,
              -- Launch plan (migration 0088). Sent so the client renders
              -- the SERVER's arc rather than re-deriving its own: one
              -- derivation of where a ship is, permanently. NULL on
              -- pre-flag nodes, which keep the legacy client-side plan.
              n.launch_x, n.launch_y, n.launch_vx, n.launch_vy,
              n.accel, n.flip_tick,
              -- Rendezvous arc (migration 0090). NULL on an ordinary
              -- flip-and-burn, which is nearly every node.
              n.rv_ax, n.rv_ay, n.rv_bx, n.rv_by,
              n.rv_meet_tick, n.rv_follow_ship_id,
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
      `SELECT id, body_id, ship_class, ship_name, queued_at_tick, completes_at_tick,
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
      // counterparty_faction_id marks a STANDING TRADE ROUTE to another
      // player: the destination is THEIR world, so the client must not
      // judge it by "do I hold that body" the way a self-haul route is
      // judged. Without this the situation report cried "Trade route
      // broken — No holding at <partner's world>" for every healthy
      // cross-player deal.
      `SELECT id, owner_faction_id, ship_id, origin_body_id, dest_body_id, status, kind,
              cargo_fuel, cargo_metal, cargo_gold, cargo_science,
              created_at_tick, counterparty_faction_id, agreement_id,
              per_run_metal, per_run_fuel, per_run_gold, per_run_science,
              loops_completed,
              name, loop_mode, loops_remaining, stalled_since_tick, consolidated,
              -- Parked because the loading side cannot pay. Invisible
              -- until now: the lane looked healthy right up to the
              -- tick the agreement died.
              starved_since_tick, starve_short_json,
              -- The consolidation handshake rides along so the Trade tab
              -- can offer "run this on one freighter" on the lane it
              -- applies to, rather than making the player find the deal
              -- in another panel to act on a route in front of them.
              (SELECT ta.consolidate_offered_by FROM trade_agreements ta
                WHERE ta.id = game_trade_routes.agreement_id) AS consolidate_offered_by,
              (SELECT ta.consolidate_offer_ship_id FROM trade_agreements ta
                WHERE ta.id = game_trade_routes.agreement_id) AS consolidate_offer_ship_id
         FROM game_trade_routes
        WHERE game_id = ? AND (owner_faction_id = ? OR counterparty_faction_id = ?)
          AND cancelled_at_tick IS NULL`,
    )
    .bind(gameId, me.id, me.id)
    .all();
  // TRADE V2: the itinerary and the crew ride along with every route —
  // the Trade tab, the composer, and the map all read them. Fetched for
  // MY routes plus lanes where I'm the counterparty (a shared
  // consolidated lane is as much mine as my partner's).
  const routeStopsP = env.DB
    .prepare(
      `SELECT s.route_id, s.sequence, s.body_id, s.action,
              s.take_metal, s.take_gold, s.take_science
         FROM game_trade_route_stops s
         JOIN game_trade_routes r ON r.id = s.route_id
        WHERE s.game_id = ? AND r.cancelled_at_tick IS NULL
          AND (r.owner_faction_id = ? OR r.counterparty_faction_id = ?)
        ORDER BY s.route_id, s.sequence`,
    )
    .bind(gameId, me.id, me.id)
    .all();
  const routeShipsP = env.DB
    .prepare(
      `SELECT c.route_id, c.ship_id, c.role, c.follow_ship_id, c.next_stop_seq,
              c.cargo_fuel, c.cargo_metal, c.cargo_gold, c.cargo_science,
              sh.owner_faction_id AS ship_owner, sh.name AS ship_name,
              sh.ship_class, sh.icon_variant, sh.parent_body_id AS ship_body_id,
              -- WHERE IS IT AND WHEN DOES IT LAND. A crew row that carries
              -- only a name leaves the card saying nothing about the run
              -- itself, and for a partner's hull the client has no other
              -- source. Correlated subqueries rather than a JOIN: a ship
              -- with two in-transit nodes would otherwise duplicate the
              -- whole crew row and put the same freighter on the lane twice.
              (SELECT n.target_body_id FROM game_ship_nodes n
                WHERE n.ship_id = c.ship_id AND n.status = 'in_transit'
                ORDER BY n.arrival_at_tick LIMIT 1) AS ship_dest_body_id,
              (SELECT n.arrival_at_tick FROM game_ship_nodes n
                WHERE n.ship_id = c.ship_id AND n.status = 'in_transit'
                ORDER BY n.arrival_at_tick LIMIT 1) AS ship_arrival_tick
         FROM game_trade_route_ships c
         JOIN game_trade_routes r ON r.id = c.route_id
         LEFT JOIN game_ships sh ON sh.id = c.ship_id
        WHERE c.game_id = ? AND r.cancelled_at_tick IS NULL
          AND (r.owner_faction_id = ? OR r.counterparty_faction_id = ?)`,
    )
    .bind(gameId, me.id, me.id)
    .all();
  // ---- Senate laws in force ON ME, as numbers the client can apply ----
  //
  // The client had NO knowledge of slider laws — zero references anywhere
  // in src/ — so TopBar's per-tick income was computed from settlements
  // and industry tech alone. The server duly credited a doubled science
  // yield while the pill kept quoting the un-doubled rate, which made a
  // passed law look like it did nothing ("is it really halving our
  // science costs? doesn't look like it"). Resolved FOR ME, because a law
  // can target one faction.
  let activeSliders = null;
  try {
    const s = await activeSlidersP;
    const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
    activeSliders = {
      metal_yield_multiplier: num(s.metal_yield_multiplier, 1),
      gold_yield_multiplier: num(s.gold_yield_multiplier, 1),
      science_yield_multiplier: num(s.science_yield_multiplier, 1),
      ship_build_cost_multiplier: num(s.ship_build_cost_multiplier, 1),
      fleet_upkeep_multiplier: num(s.fleet_upkeep_multiplier, 1),
      combat_damage_multiplier: num(s.combat_damage_multiplier, 1),
      rush_cost_multiplier: num(s.rush_cost_multiplier, 1),
      trade_tariff_pct: num(s.trade_tariff_pct, 0),
    };
  } catch { /* leave null — client falls back to neutral 1x */ }

  // The same laws, in plain words, for the top-bar readout. Rendered
  // server-side through describeSlider: that is the ONE place the wording
  // lives, and its own comment warns that a client-side mirror is the
  // pattern which has drifted twice here already.
  let activeLaws = [];
  try {
    activeLaws = await activeLawsFor(env, gameId, game.current_tick ?? 0, me.id);
  } catch { /* readout just stays empty */ }

  // ---- Accepted trade deals still waiting on MY freighter -------------
  //
  // Accepting a deal does NOT move goods: each side has to put a hauler
  // on it, and until you do, nothing happens and nothing said so. The
  // agreements themselves live behind /trades/agreements, which the
  // situation report never reads, so an accepted deal was completely
  // invisible from the main screen — the reported "I had no way to know".
  // Surface just enough for a nudge: who it's with and what my side owes
  // per run. `status='active'` and no un-cancelled route of mine against
  // the agreement == waiting on me.
  const awaitingShipP = env.DB
    .prepare(
      `SELECT a.id AS agreement_id,
              CASE WHEN a.faction_a_id = ? THEN a.faction_b_id ELSE a.faction_a_id END AS partner_faction_id,
              CASE WHEN a.faction_a_id = ? THEN a.a_metal   ELSE a.b_metal   END AS my_metal,
              CASE WHEN a.faction_a_id = ? THEN a.a_fuel    ELSE a.b_fuel    END AS my_fuel,
              CASE WHEN a.faction_a_id = ? THEN a.a_gold    ELSE a.b_gold    END AS my_gold,
              CASE WHEN a.faction_a_id = ? THEN a.a_science ELSE a.b_science END AS my_science,
              a.created_at_tick
         FROM trade_agreements a
        WHERE a.game_id = ? AND a.status = 'active'
          AND (a.faction_a_id = ? OR a.faction_b_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM game_trade_routes r
             WHERE r.agreement_id = a.id
               AND r.owner_faction_id = ?
               AND r.cancelled_at_tick IS NULL
          )
          -- A FOLDED LANE HAULS FOR BOTH SIDES, so "I own no route on
          -- this deal" stops meaning "my goods aren't moving". The lane
          -- belongs to whichever side leads it; the partner owns nothing
          -- and was therefore told to commission a freighter for cargo
          -- already riding the other player's hull.
          --
          -- TradesPanel and the shell badge were both taught this when
          -- consolidation shipped. This query is the THIRD derivation of
          -- the same question and was missed, so the Situation Report
          -- kept nagging while the trade card said, correctly, "you need
          -- not commission one" — the two sitting on screen together is
          -- exactly what a player reported.
          AND NOT EXISTS (
            SELECT 1 FROM game_trade_routes r
             WHERE r.agreement_id = a.id
               AND r.consolidated = 1
               AND r.cancelled_at_tick IS NULL
          )
        ORDER BY a.created_at_tick DESC`,
    )
    .bind(me.id, me.id, me.id, me.id, me.id, gameId, me.id, me.id, me.id)
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

  // ASSET DEALS you are party to. Both sides see the same row: a buyer
  // needs the meter to know what is still owed, and a seller needs it to
  // know whether the payment is actually coming. Deals you are not in
  // are none of your business — unlike a treaty, a sale is private until
  // it completes, and the completion is what gets chronicled.
  const asset_deals = ((await env.DB
    .prepare(
      `SELECT id, seller_faction_id, buyer_faction_id, asset_kind, asset_id,
              delivery_body_id, price_metal, price_credits,
              paid_metal, paid_credits, status, ended_reason, created_at_tick
         FROM trade_asset_deals
        WHERE game_id = ?
          AND (seller_faction_id = ? OR buyer_faction_id = ?)
          AND status IN ('offered', 'active')`,
    )
    .bind(gameId, me.id, me.id).all()).results ?? []);

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
  //
  // Striking a deal belongs on that reserve list for exactly the reason
  // senate_vote does: it happens once, it is the whole point of the
  // Trades panel, and it competes for the window against every ship
  // built and every tech finished. Player report: an offer was accepted
  // and "not even in the event log" — the row was there, thirty
  // higher-volume events deep.
  const NOTABLE_KINDS = [
    'senate_vote', 'senate_passed', 'senate_failed', 'chancellor_elected',
    'treaty_signed', 'treaty_broken', 'victory',
    'asteroid_launched', 'asteroid_impact',
    'trade_accepted', 'trade_agreement_ended', 'trade_lane_consolidated',
    // A survey result is rare and easily buried; a rock running out
    // ends a supply line. Both are worth a reserved slot.
    'meteoroid_found', 'meteoroid_exhausted',
  ];
  const notablePlaceholders = NOTABLE_KINDS.map(() => '?').join(',');
  const EVENT_COLS = `id, tick_number, kind, actor_faction_id, target_faction_id,
              body_id, ship_id, payload, created_at_ms,
              flavor_override, flavor_edited_by, flavor_edited_at_ms`;
  const [recentRows, notableRows, partyRows] = await Promise.all([
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
    // EVENTS ADDRESSED TO ME. Both queries above ask only for
    // visibility = 'public', so every entry written with a party-scoped
    // audience — a JSON array of the faction ids allowed to see it —
    // was delivered to NOBODY. That is every loop a standing route
    // completes, every route that finishes its last run, every lane
    // folded: written to D1 on schedule and never fetched by anything.
    // The client even carries a renderer for trade_route_run whose
    // comment reasons "server-side visibility already scopes this to
    // the two parties" — true, and the reason it never appeared.
    env.DB
      .prepare(
        `SELECT ${EVENT_COLS}
           FROM chronicle_entries
          WHERE game_id = ? AND visibility LIKE '[%' AND json_valid(visibility)
            AND EXISTS (
              SELECT 1 FROM json_each(chronicle_entries.visibility) WHERE value = ?
            )
          ORDER BY tick_number DESC, created_at_ms DESC
          LIMIT 20`,
      )
      .bind(gameId, me.id)
      .all(),
  ]);
  const eventById = new Map();
  for (const r of [...(recentRows.results ?? []), ...(notableRows.results ?? []),
                   ...(partyRows.results ?? [])]) {
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
  let terraform = { cost_metal: 124, cost_credits: 124, duration_ticks: 24 };
  // Hoisted out of the try below: the payload reads it too, and a const
  // scoped to that block is not in scope down there (no-undef caught it).
  let transitCombatEnabled = 0;
  // Mirrored to the client so the range rings it draws use the SAME cut the
  // tick applies. Hardcoding 0.5 there meant the picture stayed right only
  // while nobody touched this slider.
  let transitRangeInSystemMul = 0.5;
  try {
    // Rates come from the game's CONFIG, not a literal. room.js bills the
    // fleet from the same source; a hardcoded copy here meant the Editor
    // could change a rate and leave the UI quoting the old price while
    // the tick charged the new one — the player sees a number that is
    // simply wrong about their own economy.
    const ucfg = await loadGameConfig(env, gameId);
    transitCombatEnabled = Number(ucfg.transit_combat_enabled ?? 0) === 1 ? 1 : 0;
    transitRangeInSystemMul = Math.max(0.05, Math.min(1,
      Number(ucfg.transit_range_in_system_mul ?? 0.5) || 0.5));
    const UPKEEP = {
      corvette:  { gold: ucfg.upkeep_corvette_gold,  metal: 0 },
      frigate:   { gold: ucfg.upkeep_frigate_gold,   metal: ucfg.upkeep_frigate_metal },
      destroyer: { gold: ucfg.upkeep_destroyer_gold, metal: ucfg.upkeep_destroyer_metal },
      freighter: { gold: ucfg.upkeep_freighter_gold, metal: 0 },
      colony:    { gold: 0, metal: 0 },
    };
    // PER HULL, not per class: upkeep currency follows each ship's own
    // loadout now (upkeepSplit), so the quote has to walk the fleet the
    // same way room.js bills it. Still aggregated into per-class rows
    // below — the panel shows classes, but each class's mix is the sum
    // of its hulls' individual splits, not one class-wide rate.
    const fleetRows = (await env.DB
      .prepare(
        `SELECT ship_class, parts_json FROM game_ships
          WHERE game_id = ? AND owner_faction_id = ? AND status = 'active'`,
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
    const acc = new Map();   // class -> { count, gold, metal }
    for (const row of fleetRows) {
      const totals = UPKEEP[row.ship_class];
      if (!totals) continue;
      const u = upkeepSplit(row.ship_class, parsePartsJson(row.ship_class, row.parts_json), totals);
      g += u.gold;
      m += u.metal;
      const cur = acc.get(row.ship_class) ?? { count: 0, gold: 0, metal: 0 };
      cur.count += 1;
      cur.gold  += u.gold;
      cur.metal += u.metal;
      acc.set(row.ship_class, cur);
    }
    const byClass = [];
    for (const [ship_class, cur] of acc) {
      byClass.push({
        ship_class,
        count: cur.count,
        // "each" is now the class AVERAGE — hulls of one class can
        // differ by loadout, so a single rate would be a lie for any
        // mixed fleet. Total is what the tick actually charges.
        gold_each: round3(cur.gold / cur.count),
        metal_each: round3(cur.metal / cur.count),
        gold: round3(cur.gold * mult),
        metal: round3(cur.metal * mult),
      });
    }
    byClass.sort((x, y) => (y.gold + y.metal) - (x.gold + x.metal));
    upkeep = {
      gold: round3(g * mult), metal: round3(m * mult), multiplier: mult,
      by_class: byClass,
      arrears_damage_mult: ucfg.arrears_damage_mult,
    };
    // Terraform targets ride the same config load — the world-menu meter
    // quotes X/COST, and a hardcoded 124 client-side would lie the moment
    // a host tunes the lobby setting (same drift bug as upkeep above).
    terraform = {
      cost_metal:     Number(ucfg.terraform_cost_metal ?? 124),
      cost_credits:   Number(ucfg.terraform_cost_credits ?? 124),
      duration_ticks: Number(ucfg.terraform_duration_ticks ?? 24),
    };
  } catch { /* leave zeros */ }

  // Senate sanctions in force this tick. Cheap (one indexed read) and
  // internally non-throwing, so it rides the normal /state poll rather
  // than needing its own fetch.
  const sanctions = await activeSanctions(env, gameId, game.current_tick ?? 0);

  // What a hull actually costs the caller right now. The build menu used
  // to render the base price out of src/game/shipClasses.ts and nothing
  // else, so a passed ship_build_cost_multiplier law halved the charge
  // while every price on screen stayed put — the senate's economic lever
  // looked broken to the people who voted for it. Same helper actions.js
  // charges from, so the quote cannot drift from the bill.
  const buildCost = await buildCostFactors(env, gameId, me.id, game.current_tick ?? 0);

  // Ship designs — the caller's design library (ship designer §2).
  // Small table (≤12 per class), so shipping it with every /state poll
  // keeps the designer + BuildPanel in sync without a separate fetch.
  const shipDesigns = (await shipDesignsP).results ?? [];

  // Active trade routes for the caller's faction. The auto-pilot loop
  // in worker/room.js resolveTick mutates these; the client deserializer
  // converts server's metal/gold column names back to client's ore/credits.
  const tradeRoutes = (await tradeRoutesP).results ?? [];
  // Stitch itinerary + crew onto each route row (TRADE V2).
  {
    const stopsByRoute = new Map();
    for (const s of (await routeStopsP).results ?? []) {
      if (!stopsByRoute.has(s.route_id)) stopsByRoute.set(s.route_id, []);
      stopsByRoute.get(s.route_id).push({
        sequence: s.sequence, body_id: s.body_id, action: s.action,
        take_metal: s.take_metal, take_gold: s.take_gold, take_science: s.take_science,
      });
    }
    const shipsByRoute = new Map();
    for (const c of (await routeShipsP).results ?? []) {
      if (!shipsByRoute.has(c.route_id)) shipsByRoute.set(c.route_id, []);
      shipsByRoute.get(c.route_id).push({
        ship_id: c.ship_id, role: c.role, follow_ship_id: c.follow_ship_id,
        next_stop_seq: c.next_stop_seq, ship_owner_faction_id: c.ship_owner,
        // Carried explicitly: a partner's freighter on a folded lane sits
        // outside your fog of war, so the client cannot look its name up
        // in its own fleet. Drop this and the card prints a raw ship id.
        ship_name: c.ship_name ?? null,
        ship_class: c.ship_class ?? null,
        icon_variant: c.icon_variant ?? null,
        ship_body_id: c.ship_body_id ?? null,
        ship_dest_body_id: c.ship_dest_body_id ?? null,
        ship_arrival_tick: c.ship_arrival_tick ?? null,
        cargo_fuel: c.cargo_fuel, cargo_metal: c.cargo_metal,
        cargo_gold: c.cargo_gold, cargo_science: c.cargo_science,
      });
    }
    for (const r of tradeRoutes) {
      r.stops = stopsByRoute.get(r.id) ?? [];
      // LEGACY KINDS NEVER GET CREW ROWS, BY DESIGN. terraform, dyson and
      // pre-cutover agreement legs keep their hull on the route row's
      // ship_id — the same split room.js's loot pass documents: walker
      // kinds (self-haul logistics + consolidated lanes) own cargo on the
      // CREW ROW, legacy kinds own it on the ROUTE ROW.
      //
      // Emitting a bare [] for those told the client "nobody is aboard",
      // and routeShips' legacy fallback could never correct it because
      // `if (route.ships)` is TRUE for an empty array. So a terraform lane
      // with a freighter on it rendered "no freighter" in the world menu
      // while the Trades panel, reading ship_id, said it was running — the
      // exact contradiction a player reported on 2026-08-15.
      //
      // Synthesising the carrier HERE keeps one authority (the server) and
      // preserves the distinction routeSelectors.ts depends on: [] now
      // means the server looked and this lane is genuinely unmanned.
      // ...BUT ONLY FOR THE KINDS WHERE ship_id IS THE AUTHORITY.
      //
      // The first cut of this synthesised a carrier for ANY crewless
      // route, which invented one on WALKER routes (self-haul logistics
      // and consolidated lanes). There the crew table is the truth and
      // ship_id is only a display mirror of the primary carrier, so a
      // lane whose last freighter was removed keeps a STALE ship_id —
      // and the panel then showed "Runs it · <ship>" directly above the
      // server's own "No freighter, cancels in N ticks". The server was
      // right; the card was inventing the crew.
      //
      // Same walker test room.js's loot pass uses, deliberately worded
      // identically: logistics AND (self-haul OR consolidated).
      const walkerKind = r.kind === 'logistics'
        && (!r.counterparty_faction_id || r.consolidated === 1);
      const crew = shipsByRoute.get(r.id);
      r.ships = crew ?? ((r.ship_id && !walkerKind)
        ? [{
          ship_id: r.ship_id, role: 'carrier', follow_ship_id: null,
          next_stop_seq: 0,
          ship_owner_faction_id: r.owner_faction_id ?? null,
          // Left null deliberately: a legacy route's hull is always the
          // viewer's own, so the client resolves the name from its own
          // fleet. Only a PARTNER's freighter (folded lanes) needs the
          // name carried explicitly, and those always have crew rows.
          ship_name: null, ship_class: null, icon_variant: null,
          ship_body_id: null, ship_dest_body_id: null, ship_arrival_tick: null,
          cargo_fuel: r.cargo_fuel ?? 0, cargo_metal: r.cargo_metal ?? 0,
          cargo_gold: r.cargo_gold ?? 0, cargo_science: r.cargo_science ?? 0,
        }]
        : []);
    }
  }

  // Dyson Sphere megaproject — populated only when a foundation has
  // been laid. Null until the first `initiate` POST per match. See
  // migration 0018 + worker/room.js tickDysonSphere for the per-tick
  // delivery + damage logic.
  const dysonSphere = (game.dyson_controller_faction_id || (game.dyson_max_hp ?? 0) > 0) ? {
    controllerFactionId: game.dyson_controller_faction_id ?? null,
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
      // Transit combat is a RULE OF THIS MATCH, so the client has to know
      // it the same way it knows research gating. Without it the HUD
      // warns about intercepting courses in every game — including the
      // overwhelming majority where ships in flight cannot be touched at
      // all, which is a false alarm on the one item the design added
      // specifically to stop players being blindsided.
      // The TOTAL sensor multiplier the server just used. Sent rather
      // than recomputed so the client cannot arrive at a different
      // product; src/game/visibility.ts applies exactly this.
      sensor_scale: sensorScale,
      transit_combat_enabled: transitCombatEnabled,
      transit_range_in_system_mul: transitRangeInSystemMul,
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
      // Flag emblem. Null on legacy factions seeded before 0074 — the
      // client resolves those to a deterministic fallback rather than
      // drawing nothing.
      emblem: me.emblem ?? null,
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
      // Terraform payload targets from game config — the client meter
      // quotes delivered/target from here, never a hardcoded copy.
      terraform,
      arrears: {
        gold: Number(me.arrears_gold ?? 0),
        metal: Number(me.arrears_metal ?? 0),
      },
      // Senate sanctions in force RIGHT NOW, game-wide, each with the
      // ticks remaining. The client needs the whole list (not just the
      // caller's) so it can say both "2x damage against YOU for 6 more
      // ticks" and "the embargo you voted on has 3 ticks left".
      sanctions,
      // Every dial scaling ship prices for the caller, broken out so the
      // build menu can show the discount AND name its cause.
      build_cost: buildCost,
      // What founding a settlement costs on ground you ALREADY hold —
      // the colony-ship path pays nothing (the ship was the price). Sent
      // rather than hardcoded because the world-menu button carried
      // `30`/`20` as literals in three places, including the
      // affordability gate: with a Colonist captain the server charges
      // 20% less, so that gate DISABLED a build the server would have
      // accepted. `colonist_mult` lets the client apply the same
      // discount it will actually be charged.
      settlement_cost: {
        metal: SETTLEMENT_COST.metal,
        gold: SETTLEMENT_COST.gold,
        colonist_mult: COLONIST_FOUND_MULT,
      },
      // TRADE V2: carriers-per-route cap by my Society research, so the
      // composer can gate the "+ Freighter" button with the real number
      // instead of hardcoding the ladder.
      carrier_cap: await carrierCapFor(env, gameId, me.id),
      // CUSTOM NAME POOLS (migration 0114). Ships, stations and cities
      // are named CLIENT-side — the browser sends the name and the
      // server only supplies a fallback — so the client needs the pool
      // in order to use it. Captains are minted server-side and read
      // the column directly; this is the same data, for the other three.
      name_pools: parseNamePools(me.name_pools ?? null),
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
    construction_partners: constructionPartnerIds,
    asset_deals,
    factions,
    bodies,
    ships,
    fleets,
    settlements,
    settlement_claims,
    megastructures,
    nodes,
    events,
    build_queue: buildQueue,
    // Slider laws in force on the caller, so the client can quote rates
    // that match what the tick will actually credit.
    active_sliders: activeSliders,
    // Non-default laws in force on the caller, pre-worded, soonest to
    // lapse first.
    active_laws: activeLaws,
    trade_routes: tradeRoutes,
    // Accepted deals with no hauler of mine on them yet. Only the goods
    // *I* owe per run — the panel owns the full ledger.
    trades_awaiting_ship: ((await awaitingShipP).results ?? []).map(r => ({
      agreement_id: r.agreement_id,
      partner_faction_id: r.partner_faction_id,
      my_metal: r.my_metal ?? 0,
      my_fuel: r.my_fuel ?? 0,
      my_gold: r.my_gold ?? 0,
      my_science: r.my_science ?? 0,
      created_at_tick: r.created_at_tick,
    })),
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


// ============================================================
// GET /api/games/:gameId/ships/:shipId/log
// ------------------------------------------------------------
// One tick-ordered account of everything a hull has done: shots it fired
// (and whether they landed), shots it took, burns it executed, and its
// own chronicle beats.
//
// NO NEW RECORDING. Every source already existed — battle_shots,
// game_transit_shots, executed game_ship_nodes, chronicle_entries — this
// only reads them. Checked before building rather than assumed.
//
// FOG (option 2). Your own hull returns its whole career. Someone else's
// returns only the engagements YOU were a party to, so a log cannot be
// used to read a rival's movements or hitting power for free. That keeps
// rival intel behind Sensors research where it belongs, while still
// letting you review a fight you were actually in.
//
// Bounded at 200 rows, newest first. A hull's real volume is single or
// low double digits, so the cap only ever trims a pathological case.
// ============================================================
async function handleShipLog(req, env, ctx) {
  const gameId = ctx.params.gameId;
  const shipId = decodeURIComponent(ctx.params.shipId ?? '');
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!shipId) return err(400, 'bad_request', 'missing ship id');

  const me = await env.DB
    .prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, ctx.session.user_id)
    .first();
  if (!me) return err(403, 'not_member', 'not in this game');

  const ship = await env.DB
    .prepare('SELECT id, name, ship_class, owner_faction_id FROM game_ships WHERE game_id = ? AND id = ?')
    .bind(gameId, shipId)
    .first();
  if (!ship) return err(404, 'not_found', 'no such ship');

  const mine = ship.owner_faction_id === me.id;
  // For a rival hull every query is additionally constrained to rows where
  // this player's faction is the counterparty.
  const counter = mine ? null : me.id;

  // One wave. These are independent and the endpoint should not repeat
  // /state's mistake of paying a round-trip per source.
  const [orbital, transit, burns, chron] = await Promise.all([
    env.DB.prepare(
      `SELECT tick_number, attacker_ship_id, attacker_faction_id, attacker_class,
              target_ship_id, target_faction_id, target_class, hit, damage, killed
         FROM battle_shots
        WHERE (attacker_ship_id = ?1 OR target_ship_id = ?1)
          AND (?2 IS NULL OR attacker_faction_id = ?2 OR target_faction_id = ?2)
        ORDER BY tick_number DESC LIMIT 200`).bind(shipId, counter).all(),
    env.DB.prepare(
      // Transit shots record GEOMETRY, not damage: `landed` rather than
      // `hit`, and no damage/killed columns at all. Verified against the
      // live table rather than assumed to match battle_shots — which is
      // exactly what it did not do. d_min (closest approach), dv (relative
      // velocity) and p_hit are carried through because they are the most
      // interesting thing about a shot taken at speed.
      `SELECT tick_number, attacker_ship_id, attacker_faction_id, attacker_class,
              defender_ship_id, defender_faction_id, defender_class,
              attacker_in_transit, defender_in_transit,
              landed, p_hit, d_min, dv
         FROM game_transit_shots
        WHERE game_id = ?1 AND (attacker_ship_id = ?2 OR defender_ship_id = ?2)
          AND (?3 IS NULL OR attacker_faction_id = ?3 OR defender_faction_id = ?3)
        ORDER BY tick_number DESC LIMIT 200`).bind(gameId, shipId, counter).all(),
    // Burns are movement, not an engagement, so a rival's are never shown:
    // that is exactly the "where has their fleet been" leak option 2 closes.
    mine
      ? env.DB.prepare(
          `SELECT n.scheduled_t AS tick_number, n.target_body_id, b.name AS target_body_name
             FROM game_ship_nodes n
             LEFT JOIN game_bodies b ON b.id = n.target_body_id
            WHERE n.game_id = ? AND n.ship_id = ? AND n.status = 'executed'
            ORDER BY n.scheduled_t DESC LIMIT 200`).bind(gameId, shipId).all()
      : Promise.resolve({ results: [] }),
    mine
      ? env.DB.prepare(
          `SELECT tick_number, kind, payload
             FROM chronicle_entries
            WHERE game_id = ? AND ship_id = ?
            ORDER BY tick_number DESC LIMIT 200`).bind(gameId, shipId).all()
      : Promise.resolve({ results: [] }),
  ]);

  const rows = [];
  const shotRow = (r, isTransit) => {
    const iAmAttacker = r.attacker_ship_id === shipId;
    const otherId = iAmAttacker ? (isTransit ? r.defender_ship_id : r.target_ship_id) : r.attacker_ship_id;
    const otherClass = iAmAttacker ? (isTransit ? r.defender_class : r.target_class) : r.attacker_class;
    const otherFaction = iAmAttacker ? (isTransit ? r.defender_faction_id : r.target_faction_id) : r.attacker_faction_id;
    return {
      tick: r.tick_number,
      kind: iAmAttacker ? 'fired' : 'took_fire',
      inTransit: isTransit
        ? !!(iAmAttacker ? r.attacker_in_transit : r.defender_in_transit)
        : false,
      otherShipId: otherId,
      otherClass,
      otherFactionId: otherFaction,
      // battle_shots has hit/damage/killed; transit shots have landed and no
      // damage figure. Normalised to one shape so the client renders one list.
      hit: isTransit ? !!r.landed : !!r.hit,
      damage: isTransit ? null : (Number(r.damage) || 0),
      killed: isTransit ? false : !!r.killed,
      // Transit-only colour: how close it got, how fast, and the odds.
      closestApproach: isTransit && r.d_min != null ? Number(r.d_min) : null,
      relativeVelocity: isTransit && r.dv != null ? Number(r.dv) : null,
      hitChance: isTransit && r.p_hit != null ? Number(r.p_hit) : null,
    };
  };
  for (const r of orbital.results ?? []) rows.push(shotRow(r, false));
  for (const r of transit.results ?? []) rows.push(shotRow(r, true));
  for (const r of burns.results ?? []) {
    rows.push({
      tick: r.tick_number,
      kind: 'burn',
      targetBodyId: r.target_body_id,
      targetBodyName: r.target_body_name ?? null,
    });
  }
  for (const r of chron.results ?? []) {
    let p = null;
    try { p = r.payload ? JSON.parse(r.payload) : null; } catch { /* keep null */ }
    rows.push({ tick: r.tick_number, kind: 'event', event: r.kind, payload: p });
  }

  rows.sort((a, b) => b.tick - a.tick);
  return json({
    ship: { id: ship.id, name: ship.name, shipClass: ship.ship_class, mine },
    // So the client can say WHY a rival's log is thin rather than looking broken.
    scope: mine ? 'full' : 'shared_engagements',
    rows: rows.slice(0, 200),
  });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/state$/,
    auth: 'required',
    handle: handleGetState,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/log$/,
    auth: 'required',
    handle: handleShipLog,
  },
];
