// ============================================================
// MISSILES — a city building that builds, stores and fires them.
//
// Lorne, 2026-10-19: "I want to move away from detonator laden ships as
// missiles, and instead have this building that is capable of building
// single use missiles. Missiles deal 10 damage 1 time to all targets in
// orbit and stack damage. Missile buildings can store an amount of
// missiles matching their rank, 5 at level 1, 10 at level 2, etc.
// Missiles can either be launched at a target or be set to auto launch to
// intercept incoming hostile targets (including missiles). Players pay to
// build missiles, which take 12 hours to build."
//
// His picks (2026-10-19): a missile hits EVERYTHING in orbit, friend or
// foe, like a detonator; it FLIES, and only within its own star system;
// 40 metal + 40 credits each; detonators stay as they are.
//
// THE SILO is a city building ('missile_silo' in BUILDING_DEFS, levelled
// like any other). Its stock and its own build queue live in their own
// columns on the settlement (0177) — never in buildings_json, whose every
// key is read as a level.
//
// A LAUNCHED SALVO is one game_ships row of class 'missile' carrying
// missile_count, flying one server-planned leg at MISSILE_ACCEL_G. Being a
// ship row, it gets flight, the map's arcs, fog of war and the inbound
// warnings for free; it is kept out of combat, captains, sensors and the
// gate autopilot, and it is never "destroyed" (no ship_destroyed noise):
// it lands, or is shot down, and is marked 'expended'.
//
// Each tick, right after arrivals and before anything else in orbit
// (resolveMissiles, called from room.js):
//   1. AUTO-DEFENCE: a silo set to MISSILES (or + FLEETS) shoots down
//      salvos landing on its world, one missile for one, keeping its
//      reserve. Not its owner's or a pact partner's salvos.
//   2. IMPACT: what is left of every salvo landing on a world deals
//      MISSILE_DAMAGE per missile to every ship in that orbit, stacking.
//   3. + FLEETS: a silo whose world just received hostile ships (at war)
//      fires everything above its reserve into that orbit — but only when
//      none of its owner's or pact partners' ships are there, since the
//      blast spares nobody.
// ============================================================

import { makeRouteMath } from './routeMath.js';
import { legTicks, shapeForArrival, fromG } from './burn.js';
import { parkOrbitRadius } from './factions.js';
import { hostilePairs, pairKey } from './wars.js';
import { resolveCaptainOnDeath } from './captains.js';

export const MISSILE_DAMAGE = 10;
export const MISSILE_COST = { metal: 40, gold: 40 };
export const MISSILE_BUILD_TICKS = 12;
export const MISSILES_PER_LEVEL = 5;
/** A missile's push: 15x a ship's launch push, so Earth to Mars is about
 *  6 ticks against a ship's 18. */
export const MISSILE_ACCEL_G = 0.3;
export const MISSILE_ACCEL = fromG(MISSILE_ACCEL_G);
export const AUTO_MODES = ['off', 'missiles', 'fleets'];
export const MISSILE_CLASS = 'missile';

export const siloCapacity = (level) => MISSILES_PER_LEVEL * Math.max(0, Math.floor(Number(level) || 0));

export function parseOrders(json) {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter(o => o && typeof o === 'object') : [];
  } catch { return []; }
}

export function siloLevelOf(row) {
  try { return Math.max(0, Number(JSON.parse(row?.buildings_json ?? '{}')?.missile_silo) || 0); } catch { return 0; }
}

/** The far systems hang off barycentres; every other world is Sol's (or
 *  a custom map's one star). Two worlds are in the same star system when
 *  this names the same body. */
const SYSTEM_ROOT_TEMPLATES = new Set(['binary_barycenter', 'bh_barycenter']);
export function starSystemOf(bodyId, byId) {
  let cur = byId.get(bodyId);
  for (let hops = 0; hops < 16 && cur; hops++) {
    if (SYSTEM_ROOT_TEMPLATES.has(cur.template_id)) return cur.id;
    if (!cur.parent_body_id) return cur.id;
    cur = byId.get(cur.parent_body_id);
  }
  return cur?.id ?? null;
}

// ---------------------------------------------------------------- http

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const err = (status, code, message) => json({ error: { code, message } }, { status });
async function readJson(req) { try { return await req.json(); } catch { return null; } }

/** The caller's live faction, the game's tick, and their silo city. */
async function loadSilo(env, ctx) {
  const { gameId, settlementId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return { error: err(400, 'bad_request', 'invalid game id') };
  const me = await env.DB
    .prepare('SELECT id, status, metal, gold FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, ctx.session.user_id).first();
  if (!me) return { error: err(403, 'not_member', 'not in this game') };
  if (me.status !== 'active') return { error: err(409, 'eliminated', 'your empire is gone') };
  const game = await env.DB.prepare('SELECT current_tick, status FROM games WHERE id = ?').bind(gameId).first();
  if (!game || game.status !== 'active') return { error: err(409, 'not_active', 'this game is not running') };
  const s = await env.DB
    .prepare(
      `SELECT id, body_id, owner_faction_id, type, buildings_json, destroyed_at_tick,
              missile_stock, missile_orders_json, missile_auto, missile_reserve
         FROM game_settlements WHERE id = ? AND game_id = ?`,
    )
    .bind(decodeURIComponent(settlementId), gameId).first();
  if (!s || s.destroyed_at_tick != null) return { error: err(404, 'not_found', 'no such city') };
  if (s.owner_faction_id !== me.id) return { error: err(403, 'not_owner', 'not your city') };
  const level = siloLevelOf(s);
  if (s.type !== 'city' || level < 1) return { error: err(409, 'no_silo', 'this city has no missile silo') };
  return { me, game, tick: Number(game.current_tick ?? 0), s, level, gameId };
}

// POST /api/games/:gameId/settlements/:settlementId/missiles   { count }
// Order missiles. Paid now, from the empire's pool; one builds at a time.
async function handleOrder(req, env, ctx) {
  const L = await loadSilo(env, ctx);
  if (L.error) return L.error;
  // No research check here: a silo exists only once its (gated) building
  // was built, and loadSilo refused anything without one.
  const body = await readJson(req);
  const count = Math.max(1, Math.min(50, Math.floor(Number(body?.count) || 1)));
  const orders = parseOrders(L.s.missile_orders_json);
  const room = siloCapacity(L.level) - Number(L.s.missile_stock || 0) - orders.length;
  if (count > room) return err(409, 'silo_full', room > 0 ? `room for ${room} more` : 'the silo is full');
  const metal = MISSILE_COST.metal * count;
  const gold = MISSILE_COST.gold * count;
  const paid = await env.DB
    .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ? AND metal >= ? AND gold >= ?')
    .bind(metal, gold, L.me.id, metal, gold).run();
  if (!paid.meta?.changes) return err(409, 'insufficient_resources', 'not enough metal and credits');
  const next = [...orders];
  for (let i = 0; i < count; i++) {
    const building = next.length === 0;
    next.push({
      id: `m${L.tick}_${Math.random().toString(36).slice(2, 8)}`,
      ticks: MISSILE_BUILD_TICKS,
      start_tick: building ? L.tick : null,
      complete_tick: building ? L.tick + MISSILE_BUILD_TICKS : null,
      cost: { ...MISSILE_COST },
    });
  }
  // Guarded on the queue we read: a double tap loses the race and is
  // refunded, never queued twice.
  const wrote = await env.DB
    .prepare(
      `UPDATE game_settlements SET missile_orders_json = ?
        WHERE id = ? AND COALESCE(missile_orders_json, '[]') = COALESCE(?, '[]')`,
    )
    .bind(JSON.stringify(next), L.s.id, L.s.missile_orders_json ?? '[]').run();
  if (!wrote.meta?.changes) {
    await env.DB.prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
      .bind(metal, gold, L.me.id).run();
    return err(409, 'busy', 'the silo changed; try again');
  }
  await env.DB.prepare(
    `INSERT INTO spend_events (game_id, faction_id, category, metal, gold, created_at_ms)
     VALUES (?, ?, 'missiles', ?, ?, ?)`,
  ).bind(L.gameId, L.me.id, metal, gold, Date.now()).run().catch(() => { /* ledger is decoration */ });
  return json({ ok: true, orders: next });
}

// DELETE /api/games/:gameId/settlements/:settlementId/missiles?order_id=
// Cancel one order: refunded in full; the next one starts if it was first.
async function handleCancel(req, env, ctx) {
  const L = await loadSilo(env, ctx);
  if (L.error) return L.error;
  const id = ctx.url?.searchParams?.get('order_id') ?? new URL(req.url).searchParams.get('order_id');
  const orders = parseOrders(L.s.missile_orders_json);
  const i = orders.findIndex(o => o.id === id);
  if (i < 0) return err(404, 'not_found', 'no such order');
  const [gone] = orders.splice(i, 1);
  if (i === 0 && orders[0]) {
    orders[0] = { ...orders[0], start_tick: L.tick, complete_tick: L.tick + Number(orders[0].ticks || MISSILE_BUILD_TICKS) };
  }
  const wrote = await env.DB
    .prepare(`UPDATE game_settlements SET missile_orders_json = ? WHERE id = ? AND COALESCE(missile_orders_json, '[]') = ?`)
    .bind(JSON.stringify(orders), L.s.id, L.s.missile_orders_json ?? '[]').run();
  if (!wrote.meta?.changes) return err(409, 'busy', 'the silo changed; try again');
  await env.DB.prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
    .bind(Number(gone.cost?.metal ?? MISSILE_COST.metal), Number(gone.cost?.gold ?? MISSILE_COST.gold), L.me.id).run();
  return json({ ok: true, orders });
}

// PATCH /api/games/:gameId/settlements/:settlementId/missiles   { auto?, reserve? }
async function handleSettings(req, env, ctx) {
  const L = await loadSilo(env, ctx);
  if (L.error) return L.error;
  const body = await readJson(req);
  const auto = body?.auto != null ? String(body.auto) : L.s.missile_auto;
  if (!AUTO_MODES.includes(auto)) return err(400, 'bad_request', 'auto must be off, missiles or fleets');
  const reserve = body?.reserve != null
    ? Math.max(0, Math.min(siloCapacity(L.level), Math.floor(Number(body.reserve) || 0)))
    : Number(L.s.missile_reserve || 0);
  await env.DB.prepare('UPDATE game_settlements SET missile_auto = ?, missile_reserve = ? WHERE id = ?')
    .bind(auto, reserve, L.s.id).run();
  return json({ ok: true, auto, reserve });
}

/** How long a salvo from `fromId` takes to reach `toId` launched at
 *  `tick`, and the burn that lands it then. Two passes: the target moves
 *  while the missile flies. */
export async function missileLeg(DB, gameId, fromId, toId, tick) {
  const { bodyPosAt } = makeRouteMath(DB, gameId);
  const from = await bodyPosAt(fromId, tick);
  let to = await bodyPosAt(toId, tick);
  let T = Math.max(1, Math.ceil(legTicks(Math.hypot(to.x - from.x, to.y - from.y), MISSILE_ACCEL)));
  to = await bodyPosAt(toId, tick + T);
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  T = Math.max(1, Math.ceil(legTicks(d, MISSILE_ACCEL)));
  to = await bodyPosAt(toId, tick + T);
  const dFinal = Math.hypot(to.x - from.x, to.y - from.y);
  const fromNext = await bodyPosAt(fromId, tick + 0.01);
  const shape = dFinal > 0 ? shapeForArrival(dFinal, T, MISSILE_ACCEL) : null;
  return {
    ticks: T,
    arrive: tick + T,
    plan: shape ? {
      lx: from.x, ly: from.y,
      lvx: (fromNext.x - from.x) / 0.01, lvy: (fromNext.y - from.y) / 0.01,
      acc: shape.accel, flip: tick + shape.t1, brk: shape.brake,
      rmp: shape.ramp > 0 ? shape.ramp : null, amax: shape.max, atau: shape.tau > 0 ? shape.tau : null,
    } : null,
  };
}

// POST /api/games/:gameId/settlements/:settlementId/missiles/launch
//   { target_body_id, count }
async function handleLaunch(req, env, ctx) {
  const L = await loadSilo(env, ctx);
  if (L.error) return L.error;
  const body = await readJson(req);
  const targetId = String(body?.target_body_id ?? '');
  const count = Math.floor(Number(body?.count) || 0);
  if (!targetId.startsWith(`${L.gameId}:`)) return err(400, 'bad_request', 'invalid target');
  if (targetId === L.s.body_id) return err(400, 'same_world', 'a silo cannot fire at its own world');
  if (!(count >= 1)) return err(400, 'bad_request', 'launch at least one missile');
  if (count > Number(L.s.missile_stock || 0)) return err(409, 'not_enough', 'not that many missiles ready');
  const rows = (await env.DB
    .prepare('SELECT id, name, template_id, parent_body_id, radius, type, destroyed_at_tick FROM game_bodies WHERE game_id = ?')
    .bind(L.gameId).all()).results ?? [];
  const byId = new Map(rows.map(r => [r.id, r]));
  const target = byId.get(targetId);
  const home = byId.get(L.s.body_id);
  if (!target || target.destroyed_at_tick != null) return err(404, 'not_found', 'no such world');
  if (starSystemOf(targetId, byId) !== starSystemOf(L.s.body_id, byId)) {
    return err(409, 'out_of_range', 'missiles only reach worlds in their own star system');
  }
  const leg = await missileLeg(env.DB, L.gameId, L.s.body_id, targetId, L.tick);
  // Take the missiles first (guarded): two taps cannot fire one magazine twice.
  const took = await env.DB
    .prepare('UPDATE game_settlements SET missile_stock = missile_stock - ? WHERE id = ? AND missile_stock >= ?')
    .bind(count, L.s.id, count).run();
  if (!took.meta?.changes) return err(409, 'not_enough', 'not that many missiles ready');
  const shipId = `${L.gameId}:msl_${L.tick}_${Math.random().toString(36).slice(2, 8)}`;
  const rp = parkOrbitRadius(Number(home?.radius) || 0);
  const p = leg.plan ?? {};
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO game_ships
         (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
          orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
          fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick,
          home_body_id, missile_count, missile_from_settlement_id)
       VALUES (?, ?, ?, ?, 'missile', ?, ?, ?, 0, 0, ?, 1, 0, 0, 'active', ?, 1, 1, 0, ?, ?, ?)`,
    ).bind(shipId, L.gameId, L.me.id, `Missiles x${count}`, L.s.body_id, rp, rp, L.tick, L.tick,
      L.s.body_id, count, L.s.id),
    env.DB.prepare(
      `INSERT INTO game_ship_nodes
         (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
          scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
          launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick, brake_accel,
          accel_ramp, accel_max, accel_tau, status, committed_at_tick)
       VALUES (?, ?, ?, 0, 'absolute', ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
    ).bind(`${shipId}:tr${L.tick}:n0`, L.gameId, shipId, targetId, L.tick, leg.arrive,
      p.lx ?? null, p.ly ?? null, p.lvx ?? null, p.lvy ?? null, p.acc ?? null, p.flip ?? null, p.brk ?? null,
      p.rmp ?? null, p.amax ?? null, p.atau ?? null, L.tick),
    env.DB.prepare(
      `INSERT INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'missile_launch', ?, ?, ?, ?, ?, ?)`,
    ).bind(`mlaunch_${Math.random().toString(36).slice(2, 10)}`, L.gameId, L.tick, L.me.id, targetId, shipId,
      JSON.stringify({ count, from_name: home?.name ?? '', body_name: target.name, arrive_tick: leg.arrive }),
      JSON.stringify([L.me.id]), Date.now()),
  ]);
  return json({ ok: true, ship_id: shipId, arrive_tick: leg.arrive, ticks: leg.ticks });
}

// GET /api/games/:gameId/missiles/eta?from=&to=  — the launch picker's ETA.
async function handleEta(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await env.DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, ctx.session.user_id).first();
  if (!me) return err(403, 'not_member', 'not in this game');
  const url = new URL(req.url);
  const from = url.searchParams.get('from') ?? '';
  const to = (url.searchParams.get('to') ?? '').split(',').filter(Boolean).slice(0, 40);
  if (!from.startsWith(`${gameId}:`) || to.some(t => !t.startsWith(`${gameId}:`))) return err(400, 'bad_request', 'invalid world');
  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = Number(game?.current_tick ?? 0);
  const out = {};
  for (const t of to) {
    try { out[t] = (await missileLeg(env.DB, gameId, from, t, tick)).ticks; } catch { /* unknown world */ }
  }
  return json({ eta: out });
}

export const routes = [
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles\/launch$/, auth: 'required', handle: handleLaunch },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles$/, auth: 'required', handle: handleOrder },
  { method: 'DELETE', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles$/, auth: 'required', handle: handleCancel },
  { method: 'PATCH', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles$/, auth: 'required', handle: handleSettings },
  { method: 'GET', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/missiles\/eta$/, auth: 'required', handle: handleEta },
];

// ---------------------------------------------------------------- tick

/** Step 0.5-bis: finished missiles join the magazine; the next starts.
 *  A silo that lost levels (seized ruins) keeps no more than it holds. */
export async function advanceMissileBuilds(env, gameId, tick) {
  const rows = (await env.DB
    .prepare(
      `SELECT id, buildings_json, missile_stock, missile_orders_json FROM game_settlements
        WHERE game_id = ? AND destroyed_at_tick IS NULL
          AND missile_orders_json IS NOT NULL AND missile_orders_json <> '[]'`,
    )
    .bind(gameId).all()).results ?? [];
  const stmts = [];
  for (const r of rows) {
    const orders = parseOrders(r.missile_orders_json);
    let stock = Number(r.missile_stock || 0);
    const cap = siloCapacity(siloLevelOf(r));
    let changed = false;
    while (orders[0] && orders[0].complete_tick != null && Number(orders[0].complete_tick) <= tick) {
      orders.shift();
      if (stock < cap) stock += 1;
      changed = true;
      if (orders[0]) {
        orders[0] = { ...orders[0], start_tick: tick, complete_tick: tick + Number(orders[0].ticks || MISSILE_BUILD_TICKS) };
      }
    }
    if (orders[0] && orders[0].start_tick == null) {
      orders[0] = { ...orders[0], start_tick: tick, complete_tick: tick + Number(orders[0].ticks || MISSILE_BUILD_TICKS) };
      changed = true;
    }
    if (changed) {
      stmts.push(env.DB.prepare('UPDATE game_settlements SET missile_stock = ?, missile_orders_json = ? WHERE id = ?')
        .bind(stock, JSON.stringify(orders), r.id));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

/** Every ship in `bodyId`'s orbit takes `damage`, friend or foe: the same
 *  "in orbit" a detonation uses (active, parked, not mid-leg). Returns the
 *  victims for the chronicle. */
async function blastOrbit(env, gameId, tick, bodyId, damage, factionNames) {
  const victims = (await env.DB
    .prepare(
      `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.hp
         FROM game_ships s
        WHERE s.game_id = ? AND s.parent_body_id = ? AND s.status = 'active' AND s.ship_class <> 'missile'
          AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status = 'in_transit')`,
    )
    .bind(gameId, bodyId).all()).results ?? [];
  const stmts = [];
  const out = [];
  const dead = [];
  for (const v of victims) {
    const left = Number(v.hp) - damage;
    if (left <= 0) {
      stmts.push(env.DB.prepare(`UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ? AND status = 'active'`)
        .bind(tick, v.id));
      dead.push(v.id);
    } else {
      stmts.push(env.DB.prepare('UPDATE game_ships SET hp = MAX(1, hp - ?), last_damaged_tick = ? WHERE id = ?')
        .bind(damage, tick, v.id));
    }
    out.push({
      ship_id: v.id, ship_name: v.name, ship_class: v.ship_class, owner_faction_id: v.owner_faction_id,
      owner_faction_name: factionNames.get(v.owner_faction_id) ?? null, destroyed: left <= 0,
    });
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  for (const id of dead) {
    try { await resolveCaptainOnDeath(env.DB, gameId, tick, id); } catch (e) { console.error('missile: captain fate failed', id, e); }
  }
  return out;
}

/**
 * The missile pass (room.js, right after arrivals). `peace` is the room's
 * pact set (pairKey form): a silo never shoots down a partner's salvo.
 */
export async function resolveMissiles(env, gameId, tick, { peace = new Set() } = {}) {
  // Salvos that have landed: a missile row away from its launch world,
  // not mid-leg. (One waiting to leave sits on its launch world.)
  const landed = (await env.DB
    .prepare(
      `SELECT s.id, s.owner_faction_id, s.parent_body_id, s.missile_count
         FROM game_ships s
        WHERE s.game_id = ? AND s.ship_class = 'missile' AND s.status = 'active'
          AND s.parent_body_id <> s.home_body_id
          AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status IN ('in_transit', 'committed'))`,
    )
    .bind(gameId).all()).results ?? [];
  // Hostile ships that landed this tick (for + FLEETS).
  const arrivedHere = (await env.DB
    .prepare(
      `SELECT s.parent_body_id AS body_id, s.owner_faction_id
         FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
        WHERE n.game_id = ? AND n.status = 'executed' AND n.arrival_at_tick = ?
          AND s.status = 'active' AND s.ship_class <> 'missile' AND s.parent_body_id = n.target_body_id`,
    )
    .bind(gameId, tick).all()).results ?? [];
  const bodies = new Set([...landed.map(m => m.parent_body_id), ...arrivedHere.map(a => a.body_id)]);
  if (bodies.size === 0) return 0;

  const silos = (await env.DB
    .prepare(
      `SELECT id, body_id, owner_faction_id, buildings_json, missile_stock, missile_auto, missile_reserve
         FROM game_settlements
        WHERE game_id = ? AND type = 'city' AND destroyed_at_tick IS NULL
          AND missile_auto IN ('missiles', 'fleets') AND missile_stock > 0`,
    )
    .bind(gameId).all()).results ?? [];
  const factionNames = new Map(((await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? [])
    .map(f => [f.id, f.name]));
  const bodyNames = new Map(((await env.DB
    .prepare(`SELECT id, name FROM game_bodies WHERE game_id = ? AND id IN (${[...bodies].map(() => '?').join(',')})`)
    .bind(gameId, ...bodies).all()).results ?? []).map(b => [b.id, b.name]));
  const war = await hostilePairs(env, gameId);
  const friendly = (a, b) => a === b || peace.has(pairKey(a, b));

  let events = 0;
  for (const bodyId of bodies) {
    const here = landed.filter(m => m.parent_body_id === bodyId).map(m => ({ ...m, left: Number(m.missile_count || 0) }));
    const defenders = silos.filter(s => s.body_id === bodyId);
    const writes = [];
    const intercepted = [];

    // 1. AUTO-DEFENCE: one missile for one, above the reserve.
    for (const silo of defenders) {
      let free = Math.max(0, Number(silo.missile_stock) - Number(silo.missile_reserve || 0));
      let used = 0;
      for (const m of here) {
        if (free <= 0) break;
        if (m.left <= 0 || friendly(silo.owner_faction_id, m.owner_faction_id)) continue;
        const k = Math.min(free, m.left);
        m.left -= k; free -= k; used += k;
        intercepted.push({ by: silo.owner_faction_id, from: m.owner_faction_id, count: k });
      }
      if (used > 0) {
        silo.missile_stock = Number(silo.missile_stock) - used;
        writes.push(env.DB.prepare('UPDATE game_settlements SET missile_stock = MAX(0, missile_stock - ?) WHERE id = ?').bind(used, silo.id));
      }
    }
    for (const m of here) {
      writes.push(env.DB.prepare(`UPDATE game_ships SET status = 'expended', destroyed_at_tick = ? WHERE id = ?`).bind(tick, m.id));
    }
    if (writes.length) await env.DB.batch(writes);

    // 2. IMPACT: what got through, stacking.
    const through = here.filter(m => m.left > 0);
    const missiles = through.reduce((n, m) => n + m.left, 0);
    if (intercepted.length) {
      events += 1;
      await env.DB.prepare(
        `INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'missile_intercepted', ?, ?, ?, 'public', ?)`,
      ).bind(`mintc_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, intercepted[0].by, bodyId,
        JSON.stringify({
          body_name: bodyNames.get(bodyId) ?? '',
          count: intercepted.reduce((n, x) => n + x.count, 0),
          by_name: factionNames.get(intercepted[0].by) ?? null,
          from_names: [...new Set(intercepted.map(x => factionNames.get(x.from)).filter(Boolean))],
          got_through: missiles,
        }), Date.now()).run();
    }
    if (missiles > 0) {
      const damage = MISSILE_DAMAGE * missiles;
      const victims = await blastOrbit(env, gameId, tick, bodyId, damage, factionNames);
      events += 1;
      const launchers = [...new Set(through.map(m => m.owner_faction_id))];
      await env.DB.prepare(
        `INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'missile_strike', ?, ?, ?, 'public', ?)`,
      ).bind(`mstrk_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, launchers[0], bodyId,
        JSON.stringify({
          body_name: bodyNames.get(bodyId) ?? '', missiles, damage,
          launcher_names: launchers.map(f => factionNames.get(f)).filter(Boolean),
          victims, destroyed_count: victims.filter(v => v.destroyed).length,
        }), Date.now()).run();
    }

    // 3. + FLEETS: hostile ships just arrived, and none of ours are here.
    for (const silo of defenders) {
      if (silo.missile_auto !== 'fleets') continue;
      const hostileArrived = arrivedHere.some(a => a.body_id === bodyId && war.has(pairKey(silo.owner_faction_id, a.owner_faction_id)));
      if (!hostileArrived) continue;
      const free = Math.max(0, Number(silo.missile_stock) - Number(silo.missile_reserve || 0));
      if (free <= 0) continue;
      const ours = await env.DB.prepare(
        `SELECT owner_faction_id FROM game_ships s
          WHERE s.game_id = ? AND s.parent_body_id = ? AND s.status = 'active' AND s.ship_class <> 'missile'
            AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status = 'in_transit')`,
      ).bind(gameId, bodyId).all();
      if ((ours.results ?? []).some(r => friendly(silo.owner_faction_id, r.owner_faction_id))) continue;
      const took = await env.DB.prepare('UPDATE game_settlements SET missile_stock = missile_stock - ? WHERE id = ? AND missile_stock >= ?')
        .bind(free, silo.id, free).run();
      if (!took.meta?.changes) continue;
      silo.missile_stock = Number(silo.missile_stock) - free;
      const damage = MISSILE_DAMAGE * free;
      const victims = await blastOrbit(env, gameId, tick, bodyId, damage, factionNames);
      events += 1;
      await env.DB.prepare(
        `INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'missile_strike', ?, ?, ?, 'public', ?)`,
      ).bind(`mstrk_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, silo.owner_faction_id, bodyId,
        JSON.stringify({
          body_name: bodyNames.get(bodyId) ?? '', missiles: free, damage, auto: true,
          launcher_names: [factionNames.get(silo.owner_faction_id)].filter(Boolean),
          victims, destroyed_count: victims.filter(v => v.destroyed).length,
        }), Date.now()).run();
    }
  }
  return events;
}
