// ============================================================
// Trade v2 endpoints (DESIGN-trade-v2) — the composer, the crew
// roster, the hold projection, and agreement consolidation.
//
//   POST   /api/games/:gameId/trade-routes/full            create with N stops
//   POST   /api/games/:gameId/trade-routes/project         hold gauge (same code as the tick)
//   PATCH  /api/games/:gameId/trade-routes/:routeId/stops  replace the itinerary
//   POST   /api/games/:gameId/trade-routes/:routeId/ships  add carrier or guard (ship or fleet)
//   DELETE /api/games/:gameId/trade-routes/:routeId/ships/:shipId
//   POST   /api/games/:gameId/trade-agreements/:agreementId/consolidate    fold both legs into one lane
//
// The old two-stop create (actions.js) stays untouched as the fast
// path — it now writes a two-stop route under the hood, which is what
// lets the same route grow here later.
// ============================================================

import { projectRoute, holdCapFor, CARGO_CAP } from './routeMath.js';
import { factionTechLevels, gatingEnabled, hasFeature } from './researchUnlocks.js';

const GAME_ID_RE  = /^[A-Za-z0-9_-]{6,32}$/;
const ROUTE_ID_RE = /^[A-Za-z0-9_:.-]{6,80}$/;
const SHIP_ID_RE  = /^[A-Za-z0-9_:.-]{6,64}$/;
const BODY_ID_RE  = /^[A-Za-z0-9_:.-]{1,64}$/;
const AG_ID_RE    = /^[A-Za-z0-9_-]{6,64}$/;

const MAX_STOPS = 6;
const NAME_MAX = 60;
// Guards are warships. Freighters haul, colony ships settle — neither
// has any business in an escort slot.
const GUARDABLE = new Set(['corvette', 'frigate', 'destroyer']);

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}
async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function callerFaction(env, gameId, userId) {
  return env.DB
    .prepare('SELECT id, game_id, user_id, name, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .first();
}
async function currentTick(env, gameId) {
  const g = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  return g?.current_tick ?? 0;
}
// Best-effort immediate dispatch — same contract as the two-stop create:
// a failure here costs responsiveness, never the route itself.
async function dispatchRoute(env, gameId, routeId) {
  try {
    const res = await env.ROOM.get(env.ROOM.idFromName(gameId))
      .fetch('https://room/dispatch-route', {
        method: 'POST',
        body: JSON.stringify({ gameId, routeId }),
      });
    return res.ok;
  } catch (e) {
    console.error('route dispatch failed', e, { routeId });
    return false;
  }
}

/** Carriers per route, by the OWNER's Society research. 1 by default;
 *  Convoy Logistics (industry 7) raises it to 2, Trade Armadas
 *  (industry 8) to 4. Gating off = the full 4. */
export async function carrierCapFor(env, gameId, factionId) {
  const gated = await gatingEnabled(env, gameId);
  if (!gated) return 4;
  const levels = await factionTechLevels(env, gameId, factionId);
  if (hasFeature('trade.convoy4', levels, true)) return 4;
  if (hasFeature('trade.convoy2', levels, true)) return 2;
  return 1;
}

/**
 * Validate a composer stop list for a DOMESTIC logistics run. Returns
 * { stops } cleaned, or { error } as a Response. The rules the map and
 * the picker teach silently, re-checked here because the server is the
 * source of truth:
 *   - 2..6 stops, at least one pickup and one dropoff
 *   - no body twice in a row (a zero-length leg is a wasted stop)
 *   - never Sol (dyson runs have their own path and their own rules)
 *   - every PICKUP body hosts a living settlement of yours
 *   - every DROPOFF body is a terraformed world you live on — the same
 *     loading-dock rule the two-stop create enforces for its dest
 */
async function validateStops(env, gameId, factionId, raw) {
  if (!Array.isArray(raw) || raw.length < 2) {
    return { error: err(400, 'bad_request', 'a route needs at least two stops') };
  }
  if (raw.length > MAX_STOPS) {
    return { error: err(400, 'too_many_stops', `at most ${MAX_STOPS} stops — long loops are unflyable`) };
  }
  const stops = [];
  // Set when any stop is a mine stop: the carrier check below needs to
  // know whether a rig is required before it accepts a hull.
  let needsRig = false;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] ?? {};
    const bodyId = String(s.body_id ?? '');
    const action = s.action === 'dropoff' ? 'dropoff'
      : s.action === 'mine' ? 'mine' : 'pickup';
    if (!BODY_ID_RE.test(bodyId)) return { error: err(400, 'bad_request', `invalid body id at stop ${i + 1}`) };
    if (bodyId === `${gameId}:sol`) {
      return { error: err(409, 'sol_is_dyson', 'Sol is the Dyson supply line — lay that route from the sphere panel') };
    }
    if (i > 0 && stops[i - 1].body_id === bodyId) {
      return { error: err(400, 'duplicate_stop', `stops ${i} and ${i + 1} are the same body`) };
    }
    stops.push({
      body_id: bodyId,
      action,
      take_metal:   s.take_metal   === 0 || s.take_metal   === false ? 0 : 1,
      take_gold:    s.take_gold    === 0 || s.take_gold    === false ? 0 : 1,
      take_science: s.take_science === 0 || s.take_science === false ? 0 : 1,
    });
  }
  // A MINE STOP IS A SOURCE. Without this a rock-to-home run is
  // rejected for having no pickup, which is exactly the route the whole
  // feature exists to fly.
  if (!stops.some(s => s.action === 'pickup' || s.action === 'mine')) {
    return { error: err(400, 'no_pickup', 'nothing is loaded anywhere on this route') };
  }
  if (!stops.some(s => s.action === 'dropoff')) {
    return { error: err(400, 'no_dropoff', 'nothing is dropped off anywhere on this route') };
  }
  for (const s of stops) {
    if (s.action === 'mine') {
      // The rock has to exist, still hold something, and — crucially —
      // be one THIS faction has found. Without the discovery check a
      // player could mine a rock they have never seen by typing its id,
      // which would make the whole survey game optional.
      const rock = await env.DB
        .prepare(
          `SELECT b.mineral_remaining,
                  (SELECT 1 FROM game_body_discoveries d
                    WHERE d.game_id = b.game_id AND d.body_id = b.id
                      AND d.faction_id = ?) AS known
             FROM game_bodies b
            WHERE b.id = ? AND b.game_id = ? AND b.destroyed_at_tick IS NULL`,
        )
        .bind(factionId, s.body_id, gameId).first();
      if (!rock || !(Number(rock.mineral_remaining ?? 0) > 0)) {
        return { error: err(409, 'not_minable', 'that body has nothing left to mine') };
      }
      if (!rock.known) {
        return { error: err(409, 'undiscovered', 'you have not surveyed that rock yet') };
      }
      needsRig = true;
      continue;
    }
    if (s.action === 'pickup') {
      const ok = await env.DB
        .prepare(
          `SELECT 1 AS x FROM game_settlements
            WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
              AND destroyed_at_tick IS NULL LIMIT 1`,
        )
        .bind(gameId, s.body_id, factionId).first();
      if (!ok) return { error: err(409, 'no_pickup_settlement', `no settlement of yours at ${s.body_id.split(':').pop()} to pick up from`) };
    } else {
      const ok = await env.DB
        .prepare(
          `SELECT 1 AS x FROM game_settlements st
             JOIN game_bodies b ON b.id = st.body_id AND b.game_id = st.game_id
            WHERE st.game_id = ? AND st.body_id = ? AND st.owner_faction_id = ?
              AND b.terraformed_at_tick IS NOT NULL
              AND st.destroyed_at_tick IS NULL AND b.destroyed_at_tick IS NULL LIMIT 1`,
        )
        .bind(gameId, s.body_id, factionId).first();
      if (!ok) return { error: err(409, 'dropoff_not_dock', `${s.body_id.split(':').pop()} is not a terraformed world you live on — cargo has nowhere to land`) };
    }
  }
  return { stops, needsRig };
}

/** One employed hull is one job (unique index idx_route_ships_ship).
 *  Pre-checked so the 409 can say WHICH job, not just "constraint". */
/** Does this hull carry a Mining Rig? Rocks refuse anything else.
 *
 *  Checked at route creation AND in the tick: creation so the refusal
 *  lands where the player made the choice, the tick because a hull can
 *  be refitted out of its rig afterwards and would otherwise keep
 *  producing ore from equipment it no longer has. */
async function hasMiningRig(env, shipId) {
  const row = await env.DB
    .prepare('SELECT parts_json FROM game_ships WHERE id = ?')
    .bind(shipId).first();
  try {
    const parts = JSON.parse(row?.parts_json ?? '[]');
    return Array.isArray(parts) && parts.includes('mining');
  } catch { return false; }
}

async function shipEmployment(env, shipId) {
  const crew = await env.DB
    .prepare(
      `SELECT c.route_id, c.role, r.name FROM game_trade_route_ships c
         JOIN game_trade_routes r ON r.id = c.route_id
        WHERE c.ship_id = ? LIMIT 1`,
    )
    .bind(shipId).first();
  if (crew) return { kind: crew.role === 'guard' ? 'guarding' : 'running', routeId: crew.route_id, name: crew.name };
  const delivery = await env.DB
    .prepare(`SELECT 1 AS x FROM trade_deliveries WHERE ship_id = ? AND resolved_at_tick IS NULL LIMIT 1`)
    .bind(shipId).first();
  if (delivery) return { kind: 'delivery' };
  return null;
}

const busyMessage = (job) =>
  job.kind === 'delivery'
    ? 'this freighter is hauling a trade shipment — wait for delivery'
    : `this ship is already ${job.kind === 'guarding' ? 'guarding' : 'running'} ${job.name ? `"${job.name}"` : 'another route'}`;

// ------------------------------------------------------------------
// POST /api/games/:gameId/trade-routes/full
// body: { name?, stops: [{body_id, action, take_*}...], loop_mode?,
//         loop_count?, carrier_ship_ids: [id...], guard_ship_ids?,
//         guard_fleet_id? }
// ------------------------------------------------------------------
async function handleCreateFull(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  const name = body.name == null ? null : String(body.name).slice(0, NAME_MAX).trim() || null;
  const v = await validateStops(env, gameId, me.id, body.stops);
  if (v.error) return v.error;
  const stops = v.stops;

  const loopMode = body.loop_mode === 'count' ? 'count' : 'forever';
  let loopsRemaining = null;
  if (loopMode === 'count') {
    loopsRemaining = Math.floor(Number(body.loop_count));
    if (!(loopsRemaining >= 1 && loopsRemaining <= 999)) {
      return err(400, 'bad_request', 'loop_count must be 1-999');
    }
  }

  const carrierIds = Array.isArray(body.carrier_ship_ids) ? body.carrier_ship_ids.map(String) : [];
  if (carrierIds.length < 1) return err(400, 'no_carrier', 'name a freighter to run the route');
  const cap = await carrierCapFor(env, gameId, me.id);
  if (carrierIds.length > cap) {
    return err(409, 'carrier_cap', cap === 1
      ? 'one freighter per route — Convoy Logistics (Society 7) raises the cap'
      : `at most ${cap} freighters per route at your research`);
  }
  // A MINING RUN NEEDS FITTED HULLS. Refused here so the player learns
  // it while choosing the freighter, rather than watching a route sit on
  // a rock doing nothing.
  if (v.needsRig) {
    for (const sid of carrierIds) {
      if (!(await hasMiningRig(env, sid))) {
        return err(409, 'no_mining_rig',
          'that freighter has no Mining Rig — refit one before working a rock');
      }
    }
  }
  if (new Set(carrierIds).size !== carrierIds.length) {
    return err(400, 'bad_request', 'duplicate carrier');
  }

  const carriers = [];
  for (const id of carrierIds) {
    if (!SHIP_ID_RE.test(id)) return err(400, 'bad_request', 'invalid carrier ship id');
    const s = await env.DB
      .prepare(`SELECT id, owner_faction_id, ship_class, status, parent_body_id,
                       cargo_fuel, cargo_metal, cargo_gold, cargo_science
                  FROM game_ships WHERE id = ? AND game_id = ?`)
      .bind(id, gameId).first();
    if (!s || s.status !== 'active') return err(404, 'not_found', 'carrier not found');
    if (s.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your freighter');
    if (s.ship_class !== 'freighter') return err(409, 'wrong_class', 'only freighters can run trade routes');
    const job = await shipEmployment(env, s.id);
    if (job) return err(409, 'ship_busy', busyMessage(job));
    carriers.push(s);
  }

  // Guards: loose ships and/or a whole fleet, all warships, all mine.
  const guardIds = new Set();
  for (const id of (Array.isArray(body.guard_ship_ids) ? body.guard_ship_ids : []).map(String)) {
    if (!SHIP_ID_RE.test(id)) return err(400, 'bad_request', 'invalid guard ship id');
    guardIds.add(id);
  }
  if (body.guard_fleet_id != null) {
    const members = (await env.DB
      .prepare(`SELECT id FROM game_ships
                 WHERE game_id = ? AND fleet_id = ? AND owner_faction_id = ?
                   AND status = 'active'`)
      .bind(gameId, String(body.guard_fleet_id), me.id)
      .all()).results ?? [];
    if (members.length === 0) return err(404, 'not_found', 'that fleet has no ships of yours');
    for (const m of members) guardIds.add(m.id);
  }
  const guards = [];
  for (const id of guardIds) {
    const s = await env.DB
      .prepare(`SELECT id, owner_faction_id, ship_class, status, parent_body_id
                  FROM game_ships WHERE id = ? AND game_id = ?`)
      .bind(id, gameId).first();
    if (!s || s.status !== 'active') return err(404, 'not_found', 'guard ship not found');
    if (s.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your ship');
    if (!GUARDABLE.has(s.ship_class)) {
      return err(409, 'wrong_class', `a ${s.ship_class} cannot guard — escorts are warships`);
    }
    const job = await shipEmployment(env, s.id);
    if (job) return err(409, 'ship_busy', busyMessage(job));
    guards.push(s);
  }

  const tick = await currentTick(env, gameId);
  const routeId = `tr:${carriers[0].id}:${tick}:${newId().slice(0, 6)}`;
  const lastDrop = [...stops].reverse().find(s => s.action === 'dropoff');

  const stmts = [
    env.DB.prepare(
      `INSERT INTO game_trade_routes
         (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
          status, kind, name, loop_mode, loops_remaining,
          cargo_fuel, cargo_metal, cargo_gold, cargo_science, created_at_tick)
       VALUES (?, ?, ?, ?, ?, ?, 'returning', 'logistics', ?, ?, ?, 0, 0, 0, 0, ?)`,
    ).bind(routeId, gameId, me.id, carriers[0].id, stops[0].body_id, lastDrop.body_id,
           name, loopMode, loopsRemaining, tick),
  ];
  stops.forEach((s, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO game_trade_route_stops
         (id, game_id, route_id, sequence, body_id, action, take_metal, take_gold, take_science)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`${routeId}:s${i}`, gameId, routeId, i, s.body_id, s.action,
           s.take_metal, s.take_gold, s.take_science));
  });
  carriers.forEach((c, i) => {
    // Fold each carrier's leftover hold into its opening load — laying a
    // route IS how orphaned freight gets delivered (same rule as the
    // two-stop create).
    const hf = Number(c.cargo_fuel ?? 0), hm = Number(c.cargo_metal ?? 0);
    const hg = Number(c.cargo_gold ?? 0), hs = Number(c.cargo_science ?? 0);
    stmts.push(env.DB.prepare(
      `INSERT INTO game_trade_route_ships
         (id, game_id, route_id, ship_id, role, next_stop_seq,
          cargo_fuel, cargo_metal, cargo_gold, cargo_science, added_at_tick)
       VALUES (?, ?, ?, ?, 'carrier', 0, ?, ?, ?, ?, ?)`,
    ).bind(`${routeId}:c${i}`, gameId, routeId, c.id, hf, hm, hg, hs, tick));
    if (hf + hm + hg + hs > 0) {
      stmts.push(env.DB.prepare(
        'UPDATE game_ships SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?',
      ).bind(c.id));
    }
  });
  guards.forEach((g, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO game_trade_route_ships
         (id, game_id, route_id, ship_id, role, follow_ship_id, next_stop_seq, added_at_tick)
       VALUES (?, ?, ?, ?, 'guard', ?, 0, ?)`,
    ).bind(`${routeId}:g${i}`, gameId, routeId, g.id, carriers[0].id, tick));
    // Defend stance ON ASSIGNMENT, not on arrival — visible immediately,
    // and the event log says why so it never reads as the game
    // overriding the player's own stance choice.
    stmts.push(env.DB.prepare(
      "UPDATE game_ships SET stance = 'defensive' WHERE id = ?",
    ).bind(g.id));
  });
  await env.DB.batch(stmts);

  const dispatched = await dispatchRoute(env, gameId, routeId);
  return json({
    ok: true, dispatched,
    route: {
      id: routeId, name, kind: 'logistics', loop_mode: loopMode,
      stops: stops.map((s, i) => ({ sequence: i, ...s })),
      carriers: carriers.map(c => c.id), guards: guards.map(g => g.id),
    },
  });
}

// ------------------------------------------------------------------
// POST /api/games/:gameId/trade-routes/project
// body: { stops: [...], ship_id? }  →  the hold gauge, computed by the
// SAME routeMath the tick runs. ship_id refines the cap by captain.
// ------------------------------------------------------------------
async function handleProject(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const v = await validateStops(env, gameId, me.id, body.stops);
  if (v.error) return v.error;

  let hold = CARGO_CAP;
  if (body.ship_id != null && SHIP_ID_RE.test(String(body.ship_id))) {
    const cap = await env.DB
      .prepare(`SELECT c.traits_json FROM game_ships s
                  LEFT JOIN game_captains c ON c.id = s.captain_id
                 WHERE s.id = ? AND s.game_id = ? AND s.owner_faction_id = ?`)
      .bind(String(body.ship_id), gameId, me.id).first();
    if (cap) hold = holdCapFor(cap.traits_json);
  }
  const tick = await currentTick(env, gameId);
  const projection = await projectRoute(env.DB, gameId, me.id, v.stops, { hold, tick });
  return json({ ok: true, projection });
}

// ------------------------------------------------------------------
// PATCH /api/games/:gameId/trade-routes/:routeId/stops
// Replace the itinerary. Walker kinds only — terraform and dyson runs
// are metered sinks with their own legality rules, and agreement lanes
// carry a partner's consent; none of them take freeform stop edits.
// Every carrier's cursor resets to stop 1 (the route restarts).
// ------------------------------------------------------------------
async function handleUpdateStops(req, env, { session, params }) {
  const { gameId, routeId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!ROUTE_ID_RE.test(routeId)) return err(400, 'bad_request', 'invalid route id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const route = await env.DB
    .prepare(`SELECT * FROM game_trade_routes WHERE id = ? AND game_id = ?`)
    .bind(routeId, gameId).first();
  if (!route || route.cancelled_at_tick != null) return err(404, 'not_found', 'route not found');
  if (route.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your route');
  if (route.kind !== 'logistics' || route.counterparty_faction_id || route.consolidated) {
    return err(409, 'not_editable', 'only your own logistics runs take stop edits');
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const v = await validateStops(env, gameId, me.id, body.stops);
  if (v.error) return v.error;
  const stops = v.stops;
  const name = body.name === undefined ? undefined
    : (body.name == null ? null : String(body.name).slice(0, NAME_MAX).trim() || null);

  const lastDrop = [...stops].reverse().find(s => s.action === 'dropoff');
  const stmts = [
    env.DB.prepare('DELETE FROM game_trade_route_stops WHERE route_id = ?').bind(routeId),
  ];
  stops.forEach((s, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO game_trade_route_stops
         (id, game_id, route_id, sequence, body_id, action, take_metal, take_gold, take_science)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`${routeId}:s${i}:${newId().slice(0, 4)}`, gameId, routeId, i, s.body_id, s.action,
           s.take_metal, s.take_gold, s.take_science));
  });
  stmts.push(env.DB.prepare(
    `UPDATE game_trade_routes SET origin_body_id = ?, dest_body_id = ?${name !== undefined ? ', name = ?' : ''} WHERE id = ?`,
  ).bind(...(name !== undefined
    ? [stops[0].body_id, lastDrop.body_id, name, routeId]
    : [stops[0].body_id, lastDrop.body_id, routeId])));
  // The route restarts from stop 1 — a cursor pointing into a list that
  // no longer exists is how freighters teleport.
  stmts.push(env.DB.prepare(
    'UPDATE game_trade_route_ships SET next_stop_seq = 0 WHERE route_id = ?',
  ).bind(routeId));
  await env.DB.batch(stmts);

  const dispatched = await dispatchRoute(env, gameId, routeId);
  return json({ ok: true, dispatched, stops: stops.map((s, i) => ({ sequence: i, ...s })) });
}

// ------------------------------------------------------------------
// POST /api/games/:gameId/trade-routes/:routeId/ships
// body: { role: 'carrier'|'guard', ship_id? , fleet_id? }
// Adding a carrier is also how a STALLED route gets rescued — it
// clears the clock. On a shared consolidated lane EITHER party may
// add hulls (that is the no-haulage-fee remedy: contribution).
// ------------------------------------------------------------------
async function handleAddShip(req, env, { session, params }) {
  const { gameId, routeId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!ROUTE_ID_RE.test(routeId)) return err(400, 'bad_request', 'invalid route id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const route = await env.DB
    .prepare('SELECT * FROM game_trade_routes WHERE id = ? AND game_id = ?')
    .bind(routeId, gameId).first();
  if (!route || route.cancelled_at_tick != null) return err(404, 'not_found', 'route not found');
  const isParty = route.owner_faction_id === me.id || route.counterparty_faction_id === me.id;
  if (!isParty) return err(403, 'not_party', 'not your route');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const role = body.role === 'guard' ? 'guard' : 'carrier';
  const walkerKind = route.kind === 'logistics' && (!route.counterparty_faction_id || route.consolidated === 1);
  const tick = await currentTick(env, gameId);

  // Collect candidate ships: one ship, or a whole fleet for guards.
  const ids = new Set();
  if (body.ship_id != null) {
    if (!SHIP_ID_RE.test(String(body.ship_id))) return err(400, 'bad_request', 'invalid ship id');
    ids.add(String(body.ship_id));
  }
  if (role === 'guard' && body.fleet_id != null) {
    const members = (await env.DB
      .prepare(`SELECT id FROM game_ships
                 WHERE game_id = ? AND fleet_id = ? AND owner_faction_id = ? AND status = 'active'`)
      .bind(gameId, String(body.fleet_id), me.id)
      .all()).results ?? [];
    for (const m of members) ids.add(m.id);
  }
  if (ids.size === 0) return err(400, 'bad_request', 'name a ship or a fleet');

  const crew = (await env.DB
    .prepare(`SELECT c.ship_id, c.role, s.status AS ship_status, s.ship_class
                FROM game_trade_route_ships c LEFT JOIN game_ships s ON s.id = c.ship_id
               WHERE c.route_id = ?`)
    .bind(routeId).all()).results ?? [];
  const liveCarriers = crew.filter(c => c.role === 'carrier' && c.ship_status === 'active' && c.ship_class === 'freighter');

  if (role === 'carrier') {
    if (ids.size > 1) return err(400, 'bad_request', 'carriers are added one at a time');
    if (!walkerKind && liveCarriers.length >= 1) {
      return err(409, 'single_carrier', 'this kind of route flies one freighter — replace it by laying the route again');
    }
    const cap = await carrierCapFor(env, gameId, route.owner_faction_id);
    if (liveCarriers.length >= cap) {
      return err(409, 'carrier_cap', cap === 1
        ? 'one freighter per route — Convoy Logistics (Society 7) raises the cap'
        : `this route is at its ${cap}-freighter cap`);
    }
  }

  const added = [];
  for (const id of ids) {
    const s = await env.DB
      .prepare(`SELECT id, owner_faction_id, ship_class, status,
                       cargo_fuel, cargo_metal, cargo_gold, cargo_science
                  FROM game_ships WHERE id = ? AND game_id = ?`)
      .bind(id, gameId).first();
    if (!s || s.status !== 'active') return err(404, 'not_found', 'ship not found');
    if (s.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your ship');
    if (role === 'carrier' && s.ship_class !== 'freighter') {
      return err(409, 'wrong_class', 'only freighters can run trade routes');
    }
    if (role === 'guard' && !GUARDABLE.has(s.ship_class)) {
      return err(409, 'wrong_class', `a ${s.ship_class} cannot guard — escorts are warships`);
    }
    const job = await shipEmployment(env, s.id);
    if (job) return err(409, 'ship_busy', busyMessage(job));
    added.push(s);
  }

  const stmts = [];
  const followTarget = liveCarriers[0]?.ship_id ?? route.ship_id;
  for (const s of added) {
    if (role === 'carrier') {
      const hf = Number(s.cargo_fuel ?? 0), hm = Number(s.cargo_metal ?? 0);
      const hg = Number(s.cargo_gold ?? 0), hs = Number(s.cargo_science ?? 0);
      stmts.push(env.DB.prepare(
        `INSERT INTO game_trade_route_ships
           (id, game_id, route_id, ship_id, role, next_stop_seq,
            cargo_fuel, cargo_metal, cargo_gold, cargo_science, added_at_tick)
         VALUES (?, ?, ?, ?, 'carrier', 0, ?, ?, ?, ?, ?)`,
      ).bind(`${routeId}:c:${newId().slice(0, 6)}`, gameId, routeId, s.id, hf, hm, hg, hs, tick));
      if (hf + hm + hg + hs > 0) {
        stmts.push(env.DB.prepare(
          'UPDATE game_ships SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?',
        ).bind(s.id));
      }
    } else {
      stmts.push(env.DB.prepare(
        `INSERT INTO game_trade_route_ships
           (id, game_id, route_id, ship_id, role, follow_ship_id, next_stop_seq, added_at_tick)
         VALUES (?, ?, ?, ?, 'guard', ?, 0, ?)`,
      ).bind(`${routeId}:g:${newId().slice(0, 6)}`, gameId, routeId, s.id, followTarget, tick));
      stmts.push(env.DB.prepare(
        "UPDATE game_ships SET stance = 'defensive' WHERE id = ?",
      ).bind(s.id));
    }
  }

  // A rescued route: new carrier becomes primary if the old one is gone,
  // and the stall clock stops the moment a freighter signs on.
  if (role === 'carrier') {
    const primaryAlive = liveCarriers.some(c => c.ship_id === route.ship_id);
    if (!primaryAlive) {
      stmts.push(env.DB.prepare(
        `UPDATE game_trade_routes
            SET ship_id = ?, status = 'returning', stalled_since_tick = NULL,
                cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
          WHERE id = ?`,
      ).bind(added[0].id, routeId));
    } else if (route.stalled_since_tick != null) {
      stmts.push(env.DB.prepare(
        `UPDATE game_trade_routes SET stalled_since_tick = NULL,
                status = CASE WHEN status = 'stalled' THEN 'returning' ELSE status END
          WHERE id = ?`,
      ).bind(routeId));
    }
  }
  await env.DB.batch(stmts);

  const dispatched = await dispatchRoute(env, gameId, routeId);
  return json({ ok: true, dispatched, added: added.map(s => s.id), role });
}

// ------------------------------------------------------------------
// DELETE /api/games/:gameId/trade-routes/:routeId/ships/:shipId
// Your own hull you can always pull; the route's owner can remove any.
// Pulling the last carrier stalls the route on the spot — honestly,
// with the clock, not silently.
// ------------------------------------------------------------------
async function handleRemoveShip(req, env, { session, params }) {
  const { gameId, routeId, shipId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!ROUTE_ID_RE.test(routeId)) return err(400, 'bad_request', 'invalid route id');
  if (!SHIP_ID_RE.test(shipId)) return err(400, 'bad_request', 'invalid ship id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const route = await env.DB
    .prepare('SELECT * FROM game_trade_routes WHERE id = ? AND game_id = ?')
    .bind(routeId, gameId).first();
  if (!route || route.cancelled_at_tick != null) return err(404, 'not_found', 'route not found');

  const crewRow = await env.DB
    .prepare(`SELECT c.*, s.owner_faction_id AS ship_owner
                FROM game_trade_route_ships c LEFT JOIN game_ships s ON s.id = c.ship_id
               WHERE c.route_id = ? AND c.ship_id = ?`)
    .bind(routeId, shipId).first();
  if (!crewRow) return err(404, 'not_found', 'that ship is not on this route');
  const mayRemove = crewRow.ship_owner === me.id || route.owner_faction_id === me.id;
  if (!mayRemove) return err(403, 'not_owner', 'not your ship and not your route');

  const walkerKind = route.kind === 'logistics' && (!route.counterparty_faction_id || route.consolidated === 1);
  if (crewRow.role === 'carrier' && !walkerKind) {
    return err(409, 'not_removable', 'this kind of route flies one pinned freighter — cancel the route instead');
  }

  const tick = await currentTick(env, gameId);
  const stmts = [
    env.DB.prepare('DELETE FROM game_trade_route_ships WHERE id = ?').bind(crewRow.id),
  ];
  if (crewRow.role === 'carrier') {
    // The hull keeps what it was hauling — cargo stays aboard until
    // delivered, the same rule cancel follows.
    const cf = Number(crewRow.cargo_fuel ?? 0), cm = Number(crewRow.cargo_metal ?? 0);
    const cg = Number(crewRow.cargo_gold ?? 0), cs = Number(crewRow.cargo_science ?? 0);
    if (cf + cm + cg + cs > 0) {
      stmts.push(env.DB.prepare(
        `UPDATE game_ships SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ? WHERE id = ?`,
      ).bind(cf, cm, cg, cs, shipId));
    }
    const survivors = (await env.DB
      .prepare(`SELECT c.ship_id FROM game_trade_route_ships c
                  JOIN game_ships s ON s.id = c.ship_id
                 WHERE c.route_id = ? AND c.role = 'carrier' AND c.ship_id != ?
                   AND s.status = 'active' AND s.ship_class = 'freighter'`)
      .bind(routeId, shipId).all()).results ?? [];
    if (route.ship_id === shipId) {
      if (survivors.length > 0) {
        stmts.push(env.DB.prepare(
          `UPDATE game_trade_routes SET ship_id = ?, cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?`,
        ).bind(survivors[0].ship_id, routeId));
      } else {
        stmts.push(env.DB.prepare(
          `UPDATE game_trade_routes SET status = 'stalled', stalled_since_tick = ?,
                  cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?`,
        ).bind(tick, routeId));
      }
    }
  }
  await env.DB.batch(stmts);
  return json({ ok: true, removed: shipId, role: crewRow.role });
}

// ------------------------------------------------------------------
// CONSOLIDATION (§8): one freighter serving both directions. An OFFER
// through the same two-party consent the agreement itself used — never
// a migration. On accept, both legs cancel, the surplus freighter goes
// home to its owner, and the offered hull starts walking the loop.
// ------------------------------------------------------------------
async function loadAgreementForParty(env, gameId, agreementId, factionId) {
  if (!AG_ID_RE.test(agreementId)) return { error: err(400, 'bad_request', 'invalid agreement id') };
  const ag = await env.DB
    .prepare('SELECT * FROM trade_agreements WHERE id = ? AND game_id = ?')
    .bind(agreementId, gameId).first();
  if (!ag) return { error: err(404, 'not_found', 'agreement not found') };
  if (ag.faction_a_id !== factionId && ag.faction_b_id !== factionId) {
    return { error: err(403, 'not_a_party', 'you are not party to that agreement') };
  }
  if (ag.status !== 'active') return { error: err(409, 'ended', 'that agreement has ended') };
  return { ag };
}

/** A side's loading dock: where its commissioned leg loads, else the
 *  offered ship's location if it qualifies, else capital-preferred
 *  terraformed world. NULL = that side has no dock at all. */
async function dockFor(env, gameId, factionId, legs, preferBodyId) {
  const myLeg = legs.find(l => l.owner_faction_id === factionId);
  if (myLeg) return myLeg.origin_body_id;
  if (preferBodyId) {
    const ok = await env.DB
      .prepare(`SELECT 1 AS x FROM game_settlements s
                  JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
                 WHERE s.game_id = ? AND s.body_id = ? AND s.owner_faction_id = ?
                   AND b.terraformed_at_tick IS NOT NULL
                   AND s.destroyed_at_tick IS NULL AND b.destroyed_at_tick IS NULL LIMIT 1`)
      .bind(gameId, preferBodyId, factionId).first();
    if (ok) return preferBodyId;
  }
  const f = await env.DB
    .prepare('SELECT capital_body_id FROM game_factions WHERE id = ?')
    .bind(factionId).first();
  const dock = await env.DB
    .prepare(`SELECT s.body_id, CASE WHEN s.body_id = ? THEN 0 ELSE 1 END AS pref
                FROM game_settlements s
                JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
               WHERE s.game_id = ? AND s.owner_faction_id = ?
                 AND b.terraformed_at_tick IS NOT NULL
                 AND s.destroyed_at_tick IS NULL AND b.destroyed_at_tick IS NULL
               ORDER BY pref LIMIT 1`)
    .bind(f?.capital_body_id ?? '', gameId, factionId).first();
  return dock?.body_id ?? null;
}

/**
 * OPEN A CONSOLIDATED LANE for an agreement: one freighter serving both
 * directions, stop 0 at the hull owner's dock and stop 1 at the
 * partner's. Exported because two very different flows arrive here —
 * the consolidate handshake on an existing two-leg deal, and a fresh
 * offer whose proposer pinned a freighter up front — and a second copy
 * of the dock resolution would be a second set of rules about where
 * cargo may load.
 *
 * Returns { routeId } or { error } with a player-readable reason.
 */
export async function openConsolidatedLane(env, gameId, ag, ships, ownerFactionId, tick) {
  // ships: one hull, or every hull already working the deal. Keeping
  // them ALL is what makes folding a two-leg agreement free — nobody
  // gives up a freighter, both just stop flying home empty, and the
  // lane moves a full contracted run per hull instead of half of one.
  const fleet = Array.isArray(ships) ? ships : [ships];
  const ship = fleet[0];
  const partnerId = ag.faction_a_id === ownerFactionId ? ag.faction_b_id : ag.faction_a_id;
  const legs = (await env.DB
    .prepare('SELECT * FROM game_trade_routes WHERE agreement_id = ? AND cancelled_at_tick IS NULL')
    .bind(ag.id).all()).results ?? [];

  const ownerDock = await dockFor(env, gameId, ownerFactionId, legs, ship.parent_body_id);
  const partnerDock = await dockFor(env, gameId, partnerId, legs,
    legs.find(l => l.owner_faction_id === ownerFactionId)?.dest_body_id ?? null);
  if (!ownerDock) {
    return { error: err(409, 'no_dock', 'the freighter\'s owner has no terraformed world to load from') };
  }
  if (!partnerDock) {
    return { error: err(409, 'no_dock', 'the other side has no terraformed world to load from') };
  }

  const stmts = [];
  // Guards already escorting either leg come across to the new lane —
  // they were assigned to protect this trade, and the trade continues.
  const keptGuards = [];
  // Retire any existing legs. Freighters are RELEASED, not consumed:
  // cargo stays aboard each hull, and outstanding flights are recalled
  // so nobody keeps flying a run for an arrangement that just changed.
  for (const leg of legs) {
    const crewRows = (await env.DB
      .prepare('SELECT * FROM game_trade_route_ships WHERE route_id = ?')
      .bind(leg.id).all()).results ?? [];
    for (const c of crewRows) {
      if (c.role === 'guard') keptGuards.push(c.ship_id);
      const cf = Number(c.cargo_fuel ?? 0), cm = Number(c.cargo_metal ?? 0);
      const cg = Number(c.cargo_gold ?? 0), cs = Number(c.cargo_science ?? 0);
      if (cf + cm + cg + cs > 0) {
        stmts.push(env.DB.prepare(
          `UPDATE game_ships SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                  cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ? WHERE id = ?`,
        ).bind(cf, cm, cg, cs, c.ship_id));
      }
    }
    const lf = Number(leg.cargo_fuel ?? 0), lm = Number(leg.cargo_metal ?? 0);
    const lg = Number(leg.cargo_gold ?? 0), ls = Number(leg.cargo_science ?? 0);
    if (lf + lm + lg + ls > 0 && crewRows.length === 0) {
      stmts.push(env.DB.prepare(
        `UPDATE game_ships SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?,
                cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ? WHERE id = ?`,
      ).bind(lf, lm, lg, ls, leg.ship_id));
    }
    stmts.push(env.DB.prepare(
      `UPDATE game_trade_routes SET cancelled_at_tick = ?,
              cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?`,
    ).bind(tick, leg.id));
    stmts.push(env.DB.prepare('DELETE FROM game_trade_route_ships WHERE route_id = ?').bind(leg.id));
    stmts.push(env.DB.prepare(
      `UPDATE game_ship_nodes SET status = 'cancelled'
        WHERE ship_id = ? AND status IN ('committed','in_transit')`,
    ).bind(leg.ship_id));
  }
  // Every hull joining the lane drops its old flight plan too, so none
  // of them is still flying the leg that just stopped existing.
  for (const f of fleet) {
    stmts.push(env.DB.prepare(
      `UPDATE game_ship_nodes SET status = 'cancelled'
        WHERE ship_id = ? AND status IN ('committed','in_transit')`,
    ).bind(f.id));
  }

  const routeId = `tr:${ship.id}:${tick}:${newId().slice(0, 6)}`;
  stmts.push(env.DB.prepare(
    `INSERT INTO game_trade_routes
       (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
        status, kind, counterparty_faction_id, agreement_id, consolidated,
        tariff_pct, created_at_tick)
     VALUES (?, ?, ?, ?, ?, ?, 'returning', 'logistics', ?, ?, 1, 0, ?)`,
  ).bind(routeId, gameId, ownerFactionId, ship.id, ownerDock, partnerDock, partnerId, ag.id, tick));
  stmts.push(env.DB.prepare(
    `INSERT INTO game_trade_route_stops (id, game_id, route_id, sequence, body_id, action)
     VALUES (?, ?, ?, 0, ?, 'pickup')`,
  ).bind(`${routeId}:s0`, gameId, routeId, ownerDock));
  stmts.push(env.DB.prepare(
    `INSERT INTO game_trade_route_stops (id, game_id, route_id, sequence, body_id, action)
     VALUES (?, ?, ?, 1, ?, 'pickup')`,
  ).bind(`${routeId}:s1`, gameId, routeId, partnerDock));
  // EVERY hull becomes a carrier, each with its own cursor. They start
  // half a loop apart so the lane is served continuously rather than
  // both hulls sitting at the same dock on the same tick.
  fleet.forEach((f, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO game_trade_route_ships
         (id, game_id, route_id, ship_id, role, next_stop_seq, added_at_tick)
       VALUES (?, ?, ?, ?, 'carrier', ?, ?)`,
    ).bind(`${routeId}:c${i}`, gameId, routeId, f.id, i % 2, tick));
  });
  keptGuards.forEach((gid, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO game_trade_route_ships
         (id, game_id, route_id, ship_id, role, follow_ship_id, next_stop_seq, added_at_tick)
       VALUES (?, ?, ?, ?, 'guard', ?, 0, ?)`,
    ).bind(`${routeId}:g${i}`, gameId, routeId, gid, ship.id, tick));
  });
  stmts.push(env.DB.prepare(
    `UPDATE trade_agreements
        SET consolidate_offer_ship_id = NULL, consolidate_offered_by = NULL,
            consolidate_offered_at_tick = NULL
      WHERE id = ?`,
  ).bind(ag.id));
  await env.DB.batch(stmts);

  await dispatchRoute(env, gameId, routeId);
  return { routeId, ownerDock, partnerDock };
}

// ------------------------------------------------------------------
// FOLD THE DEAL ONTO ONE LANE — immediately, no handshake.
//
// This was an offer the partner had to accept, on the reasoning that
// consolidating took one side's freighter off the board. It doesn't any
// more: every hull already working the agreement comes across as a
// CARRIER on the new lane. Nobody gives up a ship, both sides' hulls
// stop flying home empty, and each one now moves a full contracted run
// in BOTH directions instead of half of one — so a two-freighter deal
// does twice the trade it did before, for the same fleet.
//
// With nothing taken from anyone there is nothing to ask permission
// for, which is why either party can just do it (Lorne).
// ------------------------------------------------------------------
async function handleConsolidate(req, env, { session, params }) {
  const { gameId, agreementId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');
  const got = await loadAgreementForParty(env, gameId, agreementId, me.id);
  if (got.error) return got.error;
  const ag = got.ag;

  const tick = await currentTick(env, gameId);
  const legs = (await env.DB
    .prepare('SELECT * FROM game_trade_routes WHERE agreement_id = ? AND cancelled_at_tick IS NULL')
    .bind(ag.id).all()).results ?? [];
  // ALREADY FOLDED — but is it folded ALONE? A partner who commissioned
  // after the fold used to open a rival one-way leg beside the circuit
  // (fixed at the source in handleCommissionLeg). Refusing outright left
  // every game that hit it stuck with a lane and a leg serving one deal
  // and no way back, so this repairs the split instead: absorb the
  // strays' hulls into the folded lane and retire them.
  const lane = legs.find(l => l.consolidated === 1);
  if (lane) {
    const strays = legs.filter(l => l.id !== lane.id);
    if (strays.length === 0) {
      return err(409, 'already_consolidated', 'this deal already runs on one lane');
    }
    const moved = [];
    for (const stray of strays) {
      const ids = (await env.DB
        .prepare("SELECT ship_id FROM game_trade_route_ships WHERE route_id = ? AND role = 'carrier'")
        .bind(stray.id).all()).results?.map(r => r.ship_id) ?? [];
      if (stray.ship_id) ids.push(stray.ship_id);
      // Retire the stray FIRST: joining is blocked while a hull still
      // holds a job, and these hulls hold this one.
      await env.DB.prepare(
        'UPDATE game_trade_routes SET cancelled_at_tick = ? WHERE id = ?',
      ).bind(tick, stray.id).run();
      await env.DB.prepare(
        'DELETE FROM game_trade_route_ships WHERE route_id = ?').bind(stray.id).run();
      for (const id of [...new Set(ids)]) {
        if (!id) continue;
        const ok = await env.DB
          .prepare("SELECT id FROM game_ships WHERE id = ? AND game_id = ? AND status = 'active' AND ship_class = 'freighter'")
          .bind(id, gameId).first();
        if (!ok) continue;
        const joined = await joinConsolidatedLane(env, gameId, lane.id, id, tick);
        if (!joined.error) moved.push(id);
      }
    }
    return json({
      ok: true, route_id: lane.id, repaired: true, absorbed: moved,
      carriers: moved,
    });
  }

  // EVERY hull already flying the deal, from both sides. Crew rows are
  // the roster for walker kinds; legacy legs pin their freighter on the
  // route row itself, so both are collected.
  const fleet = [];
  const seen = new Set();
  for (const leg of legs) {
    const ids = (await env.DB
      .prepare(
        `SELECT c.ship_id FROM game_trade_route_ships c
          WHERE c.route_id = ? AND c.role = 'carrier'`,
      )
      .bind(leg.id).all()).results?.map(r => r.ship_id) ?? [];
    if (leg.ship_id) ids.push(leg.ship_id);
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ship = await env.DB
        .prepare(
          `SELECT id, owner_faction_id, ship_class, status, parent_body_id
             FROM game_ships WHERE id = ? AND game_id = ?`,
        )
        .bind(id, gameId).first();
      if (ship && ship.status === 'active' && ship.ship_class === 'freighter') fleet.push(ship);
    }
  }
  if (fleet.length === 0) {
    return err(409, 'no_freighter', 'neither side has a freighter on this deal yet');
  }

  // The lane belongs to whoever owns the hull that leads it, so stop 0
  // is that side's dock. Prefer the CALLER's own freighter when they
  // have one — the player folding the deal should see their end first.
  const lead = fleet.find(f => f.owner_faction_id === me.id) ?? fleet[0];
  const ordered = [lead, ...fleet.filter(f => f.id !== lead.id)];
  // NOTE: the carrier cap is deliberately not applied here. It governs
  // how many freighters you may ADD to a lane; these were already
  // working this very deal, and refusing to carry them over would mean
  // folding a deal costs you a ship.
  const opened = await openConsolidatedLane(
    env, gameId, ag, ordered, lead.owner_faction_id, tick);
  if (opened.error) return opened.error;

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'trade_lane_consolidated', ?, ?, ?, ?)`,
    ).bind(`c_tlc_${ag.id.slice(-10)}_${tick}`, gameId, tick, me.id,
           JSON.stringify({ agreement_id: ag.id, route_id: opened.routeId,
                            ships: ordered.map(f => f.id) }),
           JSON.stringify([ag.faction_a_id, ag.faction_b_id]), Date.now()).run();
  } catch (e) { console.error('consolidation chronicle failed', e); }
  try {
    const notify = await import('./notify.js');
    const rows = (await env.DB
      .prepare('SELECT id, user_id FROM game_factions WHERE id IN (?, ?)')
      .bind(ag.faction_a_id, ag.faction_b_id).all()).results ?? [];
    for (const f of rows) {
      if (!f.user_id) continue;
      await notify.sendDm(env, {
        userId: f.user_id, gameId, category: 'economy',
        dedupeKey: `consolidated:${ag.id}`,
        embed: {
          title: '🚚 Lane folded into one circuit',
          description: `Your standing trade now runs as **one lane with ${ordered.length} `
            + `freighter${ordered.length === 1 ? '' : 's'}** — every hull collects and delivers at `
            + 'BOTH ends instead of flying home empty. Same ships, twice the trade.',
          color: 0x4ecdc4,
          footer: { text: `Orbital · T+${tick}` },
        },
      });
    }
  } catch (e) { console.error('consolidation DM failed', e); }

  return json({
    ok: true, route_id: opened.routeId, carriers: ordered.map(f => f.id),
    origin_body_id: opened.ownerDock, dest_body_id: opened.partnerDock,
  });
}

/**
 * GET /api/games/:gameId/free-freighters
 *
 * My freighters that hold no job, with where they are. Exists because
 * the trade-offer composer lives in the DOCK, which is mounted OUTSIDE
 * the game-state provider — it has a gameId and an API client and no
 * gameState at all. Reading the fleet from React context there is a
 * hard crash, which is exactly what shipped.
 *
 * The other two freighter listings both hang off a trade or an
 * agreement that already exists; proposing a NEW standing offer has
 * neither, so this is the one that answers "which hulls could fly a
 * lane I have not created yet".
 */
/**
 * PUT A HULL ON AN EXISTING FOLDED LANE, rather than beside it.
 *
 * A consolidated lane is owned by ONE side — whoever's freighter leads
 * it — so a partner commissioning "their leg" of the same agreement
 * passes every check for a leg of their own and opens a second,
 * one-way route running alongside the folded one. That is what a player
 * saw as "why is Moose's freighter not picking up and dropping off as
 * well": their hull was never on the lane that does both, it was on a
 * plain out-and-back next to it, and the deal was being served one and
 * a half times.
 *
 * The new hull takes the stop the current crew is thinnest at, which on
 * the usual two-stop lane means it starts from the OTHER end — so two
 * freighters work opposite halves of the circuit instead of flying in
 * convoy.
 */
export async function joinConsolidatedLane(env, gameId, laneId, shipId, tick) {
  const ship = await env.DB
    .prepare(
      `SELECT id, cargo_fuel, cargo_metal, cargo_gold, cargo_science
         FROM game_ships WHERE id = ? AND game_id = ?`,
    ).bind(shipId, gameId).first();
  if (!ship) return { error: err(404, 'not_found', 'ship not found') };

  const crew = (await env.DB
    .prepare("SELECT next_stop_seq FROM game_trade_route_ships WHERE route_id = ? AND role = 'carrier'")
    .bind(laneId).all()).results ?? [];
  const stopCount = Number((await env.DB
    .prepare('SELECT COUNT(*) AS n FROM game_trade_route_stops WHERE route_id = ?')
    .bind(laneId).first())?.n ?? 0) || 2;
  const perStop = new Array(stopCount).fill(0);
  for (const c of crew) perStop[Number(c.next_stop_seq ?? 0) % stopCount] += 1;
  const seq = perStop.indexOf(Math.min(...perStop));

  const hf = Number(ship.cargo_fuel ?? 0), hm = Number(ship.cargo_metal ?? 0);
  const hg = Number(ship.cargo_gold ?? 0), hs = Number(ship.cargo_science ?? 0);
  const stmts = [env.DB.prepare(
    `INSERT INTO game_trade_route_ships
       (id, game_id, route_id, ship_id, role, next_stop_seq,
        cargo_fuel, cargo_metal, cargo_gold, cargo_science, added_at_tick)
     VALUES (?, ?, ?, ?, 'carrier', ?, ?, ?, ?, ?, ?)`,
  ).bind(`${laneId}:c:${newId().slice(0, 6)}`, gameId, laneId, ship.id, seq, hf, hm, hg, hs, tick)];
  if (hf + hm + hg + hs > 0) {
    stmts.push(env.DB.prepare(
      'UPDATE game_ships SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?',
    ).bind(ship.id));
  }
  // A hull signing on ends a stall, the same as it does on any lane.
  stmts.push(env.DB.prepare(
    `UPDATE game_trade_routes SET stalled_since_tick = NULL,
            status = CASE WHEN status = 'stalled' THEN 'returning' ELSE status END
      WHERE id = ?`,
  ).bind(laneId));
  await env.DB.batch(stmts);
  const dispatched = await dispatchRoute(env, gameId, laneId);
  return { routeId: laneId, seq, dispatched };
}

async function handleFreeFreighters(_req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const rows = (await env.DB
    .prepare(
      `SELECT s.id, s.name, b.name AS body_name,
              EXISTS (SELECT 1 FROM game_ship_nodes n
                       WHERE n.ship_id = s.id AND n.status IN ('committed','in_transit')) AS flying
         FROM game_ships s
         LEFT JOIN game_bodies b ON b.id = s.parent_body_id
        WHERE s.game_id = ? AND s.owner_faction_id = ?
          AND s.ship_class = 'freighter' AND s.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM game_trade_route_ships c WHERE c.ship_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM trade_deliveries d
                           WHERE d.ship_id = s.id AND d.resolved_at_tick IS NULL)
        ORDER BY s.name`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];

  return json({
    ok: true,
    freighters: rows.map(r => ({
      id: r.id,
      name: r.name,
      where: r.flying ? 'in transit' : (r.body_name ?? 'deep space'),
    })),
  });
}

// ------------------------------------------------------------------
// POST /api/games/:gameId/bodies/:bodyId/rename
//
// THE DISCOVERER NAMES IT. Catalogue numbers (MTR-07) are unambiguous
// and completely forgettable; letting the finder rename the rock turns
// the map into a record of who found what, and gives the Herald
// something to say that procedural naming never could.
//
// One name for everyone who can see it — stored on the body, not per
// faction — so a rival who surveys it later inherits your name for it.
// That is the point: the name is a claim of a kind.
// ------------------------------------------------------------------
async function handleRenameBody(req, env, { session, params }) {
  const { gameId, bodyId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!BODY_ID_RE.test(bodyId)) return err(400, 'bad_request', 'invalid body id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  const raw = String(body?.name ?? '').trim();
  if (!raw) return err(400, 'bad_request', 'a name is required');
  const name = raw.slice(0, 24);

  const rock = await env.DB
    .prepare(
      `SELECT b.mineral_kind, b.named_by_faction_id,
              (SELECT MIN(d.discovered_at_tick) FROM game_body_discoveries d
                WHERE d.game_id = b.game_id AND d.body_id = b.id
                  AND d.faction_id = ?) AS my_find,
              (SELECT MIN(d2.discovered_at_tick) FROM game_body_discoveries d2
                WHERE d2.game_id = b.game_id AND d2.body_id = b.id) AS first_find
         FROM game_bodies b
        WHERE b.id = ? AND b.game_id = ? AND b.destroyed_at_tick IS NULL`,
    )
    .bind(me.id, bodyId, gameId).first();

  if (!rock || !rock.mineral_kind) {
    return err(409, 'not_a_rock', 'only meteoroids can be renamed');
  }
  if (rock.my_find == null) {
    return err(403, 'undiscovered', 'you have not surveyed that rock');
  }
  // FIRST FINDER ONLY, and only once. Otherwise the last player to
  // survey a rock could rename it out from under the one who found it,
  // and the name would stop meaning anything.
  if (rock.my_find !== rock.first_find) {
    return err(403, 'not_the_finder', 'the empire that found it names it');
  }
  if (rock.named_by_faction_id) {
    return err(409, 'already_named', 'it has already been named');
  }

  await env.DB
    .prepare('UPDATE game_bodies SET name = ?, named_by_faction_id = ? WHERE id = ? AND game_id = ?')
    .bind(name, me.id, bodyId, gameId).run();

  return json({ ok: true, name });
}

export const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/bodies\/(?<bodyId>[^/]+)\/rename$/,
    auth: 'required',
    handle: handleRenameBody,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/free-freighters$/,
    auth: 'required',
    handle: handleFreeFreighters,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-routes\/full$/,
    auth: 'required',
    handle: handleCreateFull,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-routes\/project$/,
    auth: 'required',
    handle: handleProject,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-routes\/(?<routeId>[^/]+)\/stops$/,
    auth: 'required',
    handle: handleUpdateStops,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-routes\/(?<routeId>[^/]+)\/ships$/,
    auth: 'required',
    handle: handleAddShip,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-routes\/(?<routeId>[^/]+)\/ships\/(?<shipId>[^/]+)$/,
    auth: 'required',
    handle: handleRemoveShip,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-agreements\/(?<agreementId>[^/]+)\/consolidate$/,
    auth: 'required',
    handle: handleConsolidate,
  },
];
