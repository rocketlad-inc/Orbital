// ============================================================
// Orders from the watch.
//
//   POST /wear/<token>/order          one order: { verb, ...args }
//   GET  /wear/<token>/command.json   what the order screens need
//
// Lorne's list: retreat, detonate, stance and the auto-retreat /
// auto-detonate thresholds, target priority, send ships to a world,
// every diplomacy answer (trade and pact offers, ceasefire, messages),
// and ordering ships at a shipyard with their build status.
//
// NOT ONE RULE OF THE GAME IS WRITTEN HERE. Every order goes through the
// SAME route handler the game's own buttons call -- the standing-orders
// PATCH, the transfer POST, the trade accept, the ceasefire, the message
// send, the shipyard build -- found in those modules' own `routes`
// tables and called with the token's user as the session. So a watch
// order is validated, owned, priced and refused exactly as a click is,
// and cannot drift from it. What the index.js choke point does around a
// game action (bump state_version so the /state cache cannot serve the
// pre-order state, log the analytics event) is done here too, and every
// order is additionally logged as `wear_<verb>` -- the audit trail.
//
// TWO ORDERS THE GAME HAS NO BUTTON FOR, built from ones it has:
//   retreat  "run now": the auto-retreat pass's own port choice (the
//            chosen port, else home, each with a living station of
//            yours; else the nearest shipyard; else the nearest station)
//            and a transfer there, replacing any leg in flight.
//   send     a transfer to a world, timed with the server's own leg
//            maths (routeMath.computeLegTicks), as the auto-retreat and
//            trade routes time theirs. Plan-less, as theirs are: a ship
//            sent from the watch does not fight in transit.
//
// GATED: 'wear_orders' tokens only (authorizeWearOrders), which a watch
// gets solely by re-pairing through a consent prompt on the player's
// phone. A small per-token rate limit stops a stuck button from becoming
// a hundred transfers.
// ============================================================

import * as actions from './actions.js';
import * as fleets from './fleets.js';
import * as trades from './trades.js';
import * as wars from './wars.js';
import * as messages from './messages.js';
import * as analytics from './analytics.js';
import * as state from './state.js';
import * as factionsMod from './factions.js';
import { authorizeWear, authorizeWearOrders, factionIdFor } from './wear.js';
import { widgetSnapshot } from './widget.js';
import { makeRouteMath } from './routeMath.js';
import { buildCostFactors } from './buildCost.js';
import { HULL_COST, parsePartsJson } from './shipDesigns.js';

export const WEAR_ORDER_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/order$/;
export const WEAR_COMMAND_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/command\.json$/;

// factions is here for READS only (the roster the Territory screen
// draws): its own handler applies the Sensors gating, so the watch can
// never show a rival's fleet or stockpile the game would hide.
const GAME_MODULES = [actions, fleets, trades, wars, messages, state, factionsMod];

/** Target priority, as the watch offers it: a handful of presets rather
 *  than the six-way ranking editor. Each is a full permutation of
 *  TARGET_PRIORITY_KEYS, settlements last as the server requires. */
const PRIORITY_PRESETS = {
  auto: null,
  small: ['corvette', 'frigate', 'destroyer', 'capital', 'civilian', 'settlement'],
  big: ['capital', 'destroyer', 'frigate', 'corvette', 'civilian', 'settlement'],
  civilian: ['civilian', 'corvette', 'frigate', 'destroyer', 'capital', 'settlement'],
};

const BUILDABLE = ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
function fail(status, code, message) {
  return json({ error: { code, message } }, status);
}

// ---- the dispatcher ---------------------------------------------------

function matchPattern(pattern, pathname) {
  if (typeof pattern === 'string') return pattern === pathname ? {} : null;
  const m = pathname.match(pattern);
  if (!m) return null;
  const out = {};
  for (const [k, v] of Object.entries(m.groups ?? {})) {
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/**
 * Call the game's own route for (method, path) as `userId`, with the
 * state_version bump and analytics the index.js choke point would add.
 * Returns { status, body } with the body parsed when it is JSON.
 */
export async function callGame(env, ctx, userId, method, path, body) {
  const url = new URL(`https://orbital.internal${path}`);
  const gm = path.match(/^\/api\/games\/([^/]+)\//);
  const gameId = gm ? decodeURIComponent(gm[1]) : null;
  if (method !== 'GET' && gameId) {
    try {
      await env.DB.prepare('UPDATE games SET state_version = state_version + 1 WHERE id = ?').bind(gameId).run();
    } catch (e) { console.error('wear order: state_version bump failed', e); }
    const kind = analytics.eventKindFromPath(method, url.pathname);
    if (kind) {
      const ev = analytics.logEvent(env, { gameId, userId, kind }).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(ev);
    }
  }
  for (const mod of GAME_MODULES) {
    for (const r of mod.routes ?? []) {
      if (r.method !== method) continue;
      const params = matchPattern(r.pattern, url.pathname);
      if (params === null) continue;
      const req = new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body == null || method === 'GET' ? undefined : JSON.stringify(body),
      });
      const res = await r.handle(req, env, { url, session: { user_id: userId }, params });
      const text = res.status === 204 ? '' : await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    }
  }
  return { status: 404, body: { error: { code: 'no_route', message: `no game route for ${method} ${url.pathname}` } } };
}

// ---- rate limit ---------------------------------------------------------

const recent = new Map();   // token -> [ms, ...] in this isolate
function limited(token) {
  const now = Date.now();
  const list = (recent.get(token) ?? []).filter(t => now - t < 60_000);
  if (list.length >= 30) return true;
  list.push(now);
  recent.set(token, list);
  return false;
}

// ---- orders -------------------------------------------------------------

export async function handleWearOrder(req, env, { params, ctx }) {
  const auth = await authorizeWearOrders(env, params.token);
  if (auth.error) return auth.error;
  if (limited(params.token)) return fail(429, 'slow_down', 'too many orders from this watch; wait a moment');

  let b = {};
  try { b = await req.json(); } catch { return fail(400, 'bad_request', 'invalid json'); }
  const snap = await widgetSnapshot(env, auth.userId);
  if (!snap || snap.state !== 'live') return fail(409, 'not_live', 'no live game to order in');
  const gameId = snap.gameId;
  const tick = snap.tick;
  const me = await factionIdFor(env, gameId, auth.userId);
  if (!me) return fail(403, 'forbidden', 'no faction in this game');
  const G = `/api/games/${encodeURIComponent(gameId)}`;
  const q = (id) => typeof id === 'string' && id.startsWith(`${gameId}:`);
  const shipIds = Array.isArray(b.ship_ids) ? b.ship_ids.filter(q).slice(0, 200) : [];
  const verb = String(b.verb ?? '');
  const call = (method, path, body) => callGame(env, ctx, auth.userId, method, `${G}${path}`, body);

  let results;
  switch (verb) {
    case 'orders': {
      if (!shipIds.length) return fail(400, 'bad_request', 'ship_ids required');
      const patch = { ship_ids: shipIds };
      if ('stance' in b) patch.stance = b.stance;
      if ('retreat_hp_pct' in b) patch.retreat_hp_pct = b.retreat_hp_pct;
      if ('detonate_hp_pct' in b) patch.detonate_hp_pct = b.detonate_hp_pct;
      if ('priority' in b) {
        if (!(b.priority in PRIORITY_PRESETS)) return fail(400, 'bad_request', 'unknown priority preset');
        patch.target_priority = PRIORITY_PRESETS[b.priority];
      }
      results = [await call('PATCH', '/ships/orders', patch)];
      break;
    }
    case 'detonate': {
      // ARMED FOR THE NEXT TICK, not fired now: the window between is the
      // watch's CANCEL. The server's own scheduled detonation.
      if (!shipIds.length) return fail(400, 'bad_request', 'ship_ids required');
      results = [await call('PATCH', '/ships/orders', { ship_ids: shipIds, detonate_at_tick: tick + 1 })];
      break;
    }
    case 'cancel_detonate': {
      if (!shipIds.length) return fail(400, 'bad_request', 'ship_ids required');
      results = [await call('PATCH', '/ships/orders', {
        ship_ids: shipIds, detonate_at_tick: null, detonate_at_guard: null,
      })];
      break;
    }
    case 'retreat': {
      if (!shipIds.length) return fail(400, 'bad_request', 'ship_ids required');
      results = await retreat(env, call, gameId, me, tick, shipIds);
      break;
    }
    case 'send': {
      if (!shipIds.length || !q(b.body_id)) return fail(400, 'bad_request', 'ship_ids and body_id required');
      results = await send(env, call, gameId, me, tick, shipIds, b.body_id);
      break;
    }
    case 'trade_accept':
    case 'trade_decline': {
      if (!q(b.trade_id)) return fail(400, 'bad_request', 'trade_id required');
      const act = verb === 'trade_accept' ? 'accept' : 'decline';
      results = [await call('POST', `/trades/${encodeURIComponent(b.trade_id)}/${act}`, null)];
      break;
    }
    case 'ceasefire':
    case 'ceasefire_withdraw': {
      if (!q(b.faction_id)) return fail(400, 'bad_request', 'faction_id required');
      results = [await call('POST', verb === 'ceasefire' ? '/wars/end' : '/wars/end/undo', { target_faction_id: b.faction_id })];
      break;
    }
    case 'message': {
      const text = String(b.body ?? '').trim();
      if (!q(b.faction_id) || !text) return fail(400, 'bad_request', 'faction_id and body required');
      results = [await call('POST', '/messages', { scope: 'dm', recipient_faction_ids: [b.faction_id], body: text.slice(0, 4000) })];
      break;
    }
    case 'read': {
      if (typeof b.message_id !== 'string' || !b.message_id) return fail(400, 'bad_request', 'message_id required');
      results = [await call('POST', `/messages/${encodeURIComponent(b.message_id)}/read`, null)];
      break;
    }
    case 'build': {
      if (!q(b.body_id) || !BUILDABLE.includes(b.ship_class)) return fail(400, 'bad_request', 'body_id and ship_class required');
      results = [await call('POST', `/bodies/${encodeURIComponent(b.body_id)}/build`, { ship_class: b.ship_class })];
      break;
    }
    case 'rush': {
      if (typeof b.order_id !== 'string' || !b.order_id) return fail(400, 'bad_request', 'order_id required');
      results = [await call('POST', `/builds/${encodeURIComponent(b.order_id)}/rush`, null)];
      break;
    }
    default:
      return fail(400, 'bad_request', `unknown order '${verb}'`);
  }

  const ev = analytics.logEvent(env, {
    gameId, userId: auth.userId, kind: `wear_${verb}`,
    payload: { ships: shipIds.length, ok: results.every(r => r.status < 400) },
  }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(ev);

  const failed = results.find(r => r.status >= 400);
  return json({
    ok: !failed,
    // The game's own refusal, verbatim, so the watch can say WHY.
    error: failed?.body?.error ?? null,
    results: results.map(r => ({ status: r.status, error: r.body?.error ?? null })),
  }, failed && results.length === 1 ? failed.status : 200);
}

/** Your living stations and which of them are shipyards, as the
 *  auto-retreat pass builds them. */
async function portsOf(env, gameId, me) {
  const rows = (await env.DB.prepare(
    `SELECT body_id, buildings_json FROM game_settlements
      WHERE game_id = ? AND owner_faction_id = ? AND type = 'station' AND destroyed_at_tick IS NULL`,
  ).bind(gameId, me).all()).results ?? [];
  const ports = new Set();
  const yards = new Set();
  for (const r of rows) {
    ports.add(r.body_id);
    let lvl = 0;
    try { lvl = Number((JSON.parse(r.buildings_json || '{}') ?? {}).shipyard ?? 0) || 0; } catch { /* malformed */ }
    if (lvl >= 1) yards.add(r.body_id);
  }
  return { ports, yards };
}

async function shipsFor(env, gameId, me, shipIds) {
  const out = [];
  for (let i = 0; i < shipIds.length; i += 80) {
    const chunk = shipIds.slice(i, i + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = (await env.DB.prepare(
      `SELECT id, parent_body_id, retreat_body_id, home_body_id FROM game_ships
        WHERE game_id = ? AND owner_faction_id = ? AND status = 'active' AND id IN (${marks})`,
    ).bind(gameId, me, ...chunk).all()).results ?? [];
    out.push(...rows);
  }
  return out;
}

/**
 * Retreat, for a caller that has no wear token: the notification
 * buttons (worker/notifyActions.js). Same port choice, same transfers.
 */
export async function retreatShipsFor(env, ctx, userId, gameId, me, tick, shipIds) {
  const G = `/api/games/${encodeURIComponent(gameId)}`;
  const call = (method, path, body) => callGame(env, ctx, userId, method, `${G}${path}`, body);
  return retreat(env, call, gameId, me, tick, shipIds);
}

async function retreat(env, call, gameId, me, tick, shipIds) {
  const { ports, yards } = await portsOf(env, gameId, me);
  if (ports.size === 0) return [{ status: 409, body: { error: { code: 'no_port', message: 'you have no station to retreat to' } } }];
  const rm = makeRouteMath(env.DB, gameId);
  const havens = yards.size > 0 ? yards : ports;
  const results = [];
  for (const ship of await shipsFor(env, gameId, me, shipIds)) {
    let dest = null;
    if (ship.retreat_body_id && ports.has(ship.retreat_body_id)) dest = ship.retreat_body_id;
    else if (ship.home_body_id && ports.has(ship.home_body_id)) dest = ship.home_body_id;
    else {
      const here = await rm.bodyPosAt(ship.parent_body_id, tick);
      let best = Infinity;
      for (const h of havens) {
        const p = await rm.bodyPosAt(h, tick);
        const d = (p.x - here.x) ** 2 + (p.y - here.y) ** 2;
        if (d < best) { best = d; dest = h; }
      }
    }
    if (!dest || dest === ship.parent_body_id) { results.push({ status: 200, body: null }); continue; }
    const legs = await rm.computeLegTicks(me, ship.parent_body_id, dest, tick);
    results.push(await call('POST', `/ships/${encodeURIComponent(ship.id)}/transfer`, {
      target_body_id: dest, scheduled_t: tick, arrival_t: tick + legs, replace: true,
    }));
  }
  return results;
}

async function send(env, call, gameId, me, tick, shipIds, bodyId) {
  const rm = makeRouteMath(env.DB, gameId);
  const results = [];
  for (const ship of await shipsFor(env, gameId, me, shipIds)) {
    if (ship.parent_body_id === bodyId) { results.push({ status: 200, body: null }); continue; }
    const legs = await rm.computeLegTicks(me, ship.parent_body_id, bodyId, tick);
    results.push(await call('POST', `/ships/${encodeURIComponent(ship.id)}/transfer`, {
      target_body_id: bodyId, scheduled_t: tick, arrival_t: tick + legs, replace: true,
    }));
  }
  return results;
}

// ---- what the order screens show --------------------------------------

export async function handleWearCommand(_req, env, { params, ctx }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;
  const snap = await widgetSnapshot(env, auth.userId);
  if (!snap || snap.state !== 'live') return json({ ok: true, state: snap?.state ?? 'none', orders: !!auth.orders });
  const gameId = snap.gameId;
  const tick = snap.tick;
  const me = await factionIdFor(env, gameId, auth.userId);
  if (!me) return json({ ok: true, state: 'none', orders: !!auth.orders });
  const G = `/api/games/${encodeURIComponent(gameId)}`;
  const get = (path) => callGame(env, ctx, auth.userId, 'GET', `${G}${path}`, null);

  const [shipRows, factionRows, tradeRes, warRes, msgRes, yardRows, queueRows, costF] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id, s.name, s.ship_class, s.parent_body_id, s.fleet_id, s.fleet_detached,
              s.stance, s.retreat_hp_pct, s.detonate_hp_pct, s.target_priority, s.detonate_at_tick,
              s.parts_json,
              EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status = 'in_transit') AS moving
         FROM game_ships s
        WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.status = 'active' AND s.hp > 0`,
    ).bind(gameId, me).all(),
    env.DB.prepare('SELECT id, name, color FROM game_factions WHERE game_id = ?').bind(gameId).all(),
    get('/trades?status=open&limit=20').catch(() => null),
    get('/wars').catch(() => null),
    get('/messages?limit=15').catch(() => null),
    env.DB.prepare(
      `SELECT st.body_id, st.buildings_json, b.name
         FROM game_settlements st JOIN game_bodies b ON b.id = st.body_id
        WHERE st.game_id = ? AND st.owner_faction_id = ? AND st.type = 'station' AND st.destroyed_at_tick IS NULL`,
    ).bind(gameId, me).all(),
    env.DB.prepare(
      `SELECT q.id, q.body_id, q.ship_class, q.ship_name, q.status, q.started_at_tick,
              q.completes_at_tick, q.build_ticks, q.rush_count
         FROM game_body_build_queue q
        WHERE q.game_id = ? AND q.faction_id = ? AND q.cancelled_at_tick IS NULL
        ORDER BY q.body_id, q.queued_at_tick`,
    ).bind(gameId, me).all().catch(() => ({ results: [] })),
    buildCostFactors(env, gameId, me, tick).catch(() => ({ mult: 1 })),
  ]);

  const factions = {};
  for (const f of factionRows.results ?? []) factions[f.id] = { name: f.name, color: f.color };

  const ships = (shipRows.results ?? []).map(s => {
    let det = false;
    try { det = parsePartsJson(s.ship_class, s.parts_json).includes('detonator'); } catch { det = false; }
    let prio = 'auto';
    try {
      const tp = s.target_priority ? JSON.stringify(JSON.parse(s.target_priority)) : null;
      prio = Object.keys(PRIORITY_PRESETS).find(k => JSON.stringify(PRIORITY_PRESETS[k]) === tp) ?? (tp ? 'custom' : 'auto');
    } catch { prio = 'custom'; }
    return {
      id: s.id,
      n: s.name,
      cls: s.ship_class,
      at: s.parent_body_id,
      fl: s.fleet_id && !s.fleet_detached ? s.fleet_id : null,
      moving: !!s.moving,
      stance: s.stance ?? 'attack',
      rt: s.retreat_hp_pct ?? null,
      dt: s.detonate_hp_pct ?? null,
      prio,
      det,
      boom: s.detonate_at_tick ?? null,
    };
  });

  const tradeList = tradeRes?.status === 200 ? (tradeRes.body?.trades ?? tradeRes.body?.offers ?? []) : [];
  const offers = tradeList
    .filter(t => t.responder_faction_id === me && (t.status ?? 'open') === 'open')
    .map(t => ({
      id: t.id,
      from: t.proposer_faction_id,
      offer: t.offer ?? null,
      request: t.request ?? null,
      pacts: [...(t.offer_pacts ?? []), ...(t.request_pacts ?? [])],
      note: t.note ?? null,
    }));

  const warList = warRes?.status === 200 ? (warRes.body?.wars ?? []) : [];
  const warsOut = warList
    .filter(w => w.open && (w.factions ?? []).includes(me))
    .map(w => ({
      with: (w.factions ?? []).find(f => f !== me) ?? null,
      since: w.declared_at_tick,
      // Who has offered to end it: them (answer it) or you (withdraw it).
      ceasefire: w.ceasefire_by ? (w.ceasefire_by === me ? 'mine' : 'theirs') : null,
    }));

  const msgList = msgRes?.status === 200 ? (msgRes.body?.messages ?? []) : [];
  const inbox = msgList
    .filter(m => m.claimed_sender_faction_id && m.claimed_sender_faction_id !== me)
    .slice(0, 10)
    .map(m => ({
      id: m.id,
      from: m.claimed_sender_faction_id,
      body: String(m.body ?? '').slice(0, 280),
      at: m.sent_at_tick,
      read: !!m.read_by_caller,
    }));

  const yards = [];
  for (const y of yardRows.results ?? []) {
    let lvl = 0;
    try { lvl = Number((JSON.parse(y.buildings_json || '{}') ?? {}).shipyard ?? 0) || 0; } catch { /* malformed */ }
    if (lvl < 1) continue;
    yards.push({
      body: y.body_id,
      name: y.name,
      level: lvl,
      queue: (queueRows.results ?? []).filter(qr => qr.body_id === y.body_id).map(qr => ({
        id: qr.id,
        cls: qr.ship_class,
        n: qr.ship_name,
        status: qr.status ?? 'building',
        left: qr.status === 'waiting' ? null : Math.max(0, Number(qr.completes_at_tick ?? tick) - tick),
        of: Number(qr.build_ticks ?? 0) || null,
        rushed: Number(qr.rush_count ?? 0),
      })),
    });
  }
  const mult = Number(costF?.mult) || 1;
  const prices = {};
  for (const cls of BUILDABLE) {
    const h = HULL_COST[cls];
    if (h) prices[cls] = { metal: Math.ceil(h.metal * mult), credits: Math.ceil(h.gold * mult) };
  }

  return json({
    ok: true,
    state: 'live',
    orders: !!auth.orders,
    tick,
    me,
    factions,
    ships,
    offers,
    wars: warsOut,
    inbox,
    yards,
    prices,
    priorities: Object.keys(PRIORITY_PRESETS),
  });
}
