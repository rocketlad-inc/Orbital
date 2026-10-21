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
// columns on the settlement (0178) — never in buildings_json, whose every
// key is read as a level.
//
// A LAUNCHED SALVO is one game_ships row of class 'missile' carrying
// missile_count, flying one server-planned leg (missileTicks: half a
// two-engine hull's trip, pushing the whole way, no brake). Being a
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
//      fires its salvo size into that orbit — but only when none of its
//      owner's or pact partners' ships are there, since the blast spares
//      nobody.
//
// INTERCEPTS IN FLIGHT (Lorne, 2026-10-19: "I want missiles to be able to
// intercept incoming ships, and allow auto intercept of incoming ships").
// His picks: a salvo that meets ships in flight hits EVERYTHING within
// MISSILE_BLAST_RADIUS (40) of the meeting, friend or foe, 10 per missile;
// auto-intercept sends the silo's own salvo size (missile_salvo, 0179) at
// each hostile group bound for ITS world, as soon as a meeting exists.
//   - The salvo flies ONE straight push at the first whole tick the
//     target group's lead hull is somewhere it can reach in time, and
//     bursts there: no second burn to match speed (Lorne, 2026-10-20:
//     "explode on contact NOT follow or orbit"). Stored in the rv_*
//     columns of its node with B = 0, which the client already draws.
//     Its node's arrival is the target's.
//   - 0. DETONATE: on the tick its meeting comes up, the salvo bursts
//     where its arc puts it. The target may have turned away since; the
//     missiles do not chase, they burst where it was going to be.
//   - 4. AUTO-INTERCEPT: a silo on + FLEETS launches at each hostile
//     group inbound to its world that its empire is not already chasing,
//     the meeting at least a tick before they land.
// ============================================================

import { makeRouteMath } from './routeMath.js';
import { legTicks, fromG, SHIP_ENGINE_ACCEL } from './burn.js';
import { parkOrbitRadius } from './factions.js';
import { hostilePairs, pairKey } from './wars.js';
import { resolveCaptainOnDeath } from './captains.js';
import { loadFlights, groupFlights, loadSky } from './flightState.js';
import { rendezvousStateAt } from '../src/physics/rendezvous.js';

export const MISSILE_DAMAGE = 10;
export const MISSILE_COST = { metal: 40, gold: 40 };
export const MISSILE_BUILD_TICKS = 12;
export const MISSILES_PER_LEVEL = 5;
/** HOW FAST A MISSILE FLIES (Lorne, 2026-10-20, "2x the speed of a ship
 *  with two engines. They also should not need to brake, since their
 *  point is to explode on contact NOT follow or orbit"; his pick from the
 *  table: half the trip time). A salvo takes HALF the ticks a two-engine
 *  hull (no Propulsion research) would on the same trip, and pushes the
 *  whole way: no flip, no brake. Earth-Mars 7 T, Pluto-Makemake 17.
 *  Tied to the ship burn, so retuning ships moves missiles with them. */
export const MISSILE_REF_ENGINES = 2;
export const MISSILE_SPEED_MUL = 2;
/** The reference hull's launch push: each engine cuts travel time 15%
 *  (shipParts.ts engineTravelMultiplier), and push goes as 1/time^2. */
export const MISSILE_REF_ACCEL = SHIP_ENGINE_ACCEL / Math.pow(0.85, 2 * MISSILE_REF_ENGINES);
/** Ticks (unrounded) a salvo needs to cover `d`. */
export const missileTicks = (d) => legTicks(d, MISSILE_REF_ACCEL) / MISSILE_SPEED_MUL;
/** Legs launched before 2026-10-20 flew a flat 0.3g; a fallback for a
 *  row whose push is missing. */
export const MISSILE_ACCEL = fromG(0.3);
export const AUTO_MODES = ['off', 'missiles', 'fleets'];
/** A salvo bursting in open space hits every hull this close to it. */
export const MISSILE_BLAST_RADIUS = 40;
/** What auto-defence sends at each hostile group until the player says. */
export const DEFAULT_AUTO_SALVO = 2;
export const MISSILE_CLASS = 'missile';

export const siloCapacity = (level) => MISSILES_PER_LEVEL * Math.max(0, Math.floor(Number(level) || 0));

export function parseOrders(json) {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter(o => o && typeof o === 'object') : [];
  } catch { return []; }
}

/** BUILD LINES (Lorne, 2026-10-20: "one line per silo level"). A silo
 *  builds as many missiles at once as its level, MISSILE_BUILD_TICKS each:
 *  waiting orders start, in the order they were placed, until every line
 *  is busy. Pure: the orders with the ones that start now stamped. */
export function fillLines(orders, lines, tick) {
  let busy = orders.filter(o => o.start_tick != null).length;
  return orders.map(o => {
    if (o.start_tick != null || busy >= lines) return o;
    busy += 1;
    return { ...o, start_tick: tick, complete_tick: tick + Number(o.ticks || MISSILE_BUILD_TICKS) };
  });
}
export const siloLines = (level) => Math.max(1, Math.floor(Number(level) || 0));

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
/** 409 when a write names a missile salvo: in the path (/ships/:id) or as
 *  a ship id anywhere the ship endpoints take one in a body. Null to go on.
 *  A body that is not JSON names nothing. A salvo is a ship row (so it can
 *  fly and be seen), which makes it look orderable to every ship endpoint;
 *  index.js's feature dispatch and wearOrders.callGame both ask this. */
export async function refuseMissileOrders(req, params) {
  const ids = new Set();
  if (params.shipId) ids.add(params.shipId);
  const type = req.headers.get('content-type') ?? '';
  if (req.body && (type.includes('json') || type === '')) {
    try {
      const body = await req.clone().json();
      const take = (v) => { if (typeof v === 'string' && v.includes(':')) ids.add(v); };
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        take(o.ship_id); take(o.shipId); take(o.flagship_id);
        for (const k of ['ship_ids', 'shipIds', 'ships']) if (Array.isArray(o[k])) o[k].forEach(x => (typeof x === 'string' ? take(x) : walk(x)));
        if (Array.isArray(o.orders)) o.orders.forEach(walk);
        if (o.kind === 'ship') take(o.asset_id);
      };
      walk(body);
    } catch { /* not JSON */ }
  }
  // Every salvo's id is `<game>:msl_...` (salvoStatements), so the id
  // alone says it: no read on the hot path of every ship order.
  return [...ids].some(id => id.includes(':msl_')) ? err(409, 'missile', 'a missile salvo takes no orders') : null;
}
/** A malformed %-sequence in the URL is a bad id (no match), not a 500. */
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return ''; } }

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
              missile_stock, missile_orders_json, missile_auto, missile_reserve, missile_salvo
         FROM game_settlements WHERE id = ? AND game_id = ?`,
    )
    .bind(safeDecode(settlementId), gameId).first();
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
  const placed = [...orders];
  for (let i = 0; i < count; i++) {
    placed.push({
      id: `m${L.tick}_${Math.random().toString(36).slice(2, 8)}`,
      ticks: MISSILE_BUILD_TICKS, start_tick: null, complete_tick: null,
      // Who paid: a cancel refunds THEM, even after the city changed hands
      // (a sold city's queue goes with it; its price does not).
      cost: { ...MISSILE_COST }, paid_by: L.me.id,
    });
  }
  const next = fillLines(placed, siloLines(L.level), L.tick);
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
  // A freed line takes the next order waiting.
  const next = fillLines(orders, siloLines(L.level), L.tick);
  const wrote = await env.DB
    .prepare(`UPDATE game_settlements SET missile_orders_json = ? WHERE id = ? AND COALESCE(missile_orders_json, '[]') = ?`)
    .bind(JSON.stringify(next), L.s.id, L.s.missile_orders_json ?? '[]').run();
  if (!wrote.meta?.changes) return err(409, 'busy', 'the silo changed; try again');
  await env.DB.prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
    .bind(Number(gone.cost?.metal ?? MISSILE_COST.metal), Number(gone.cost?.gold ?? MISSILE_COST.gold), gone.paid_by ?? L.me.id).run();
  return json({ ok: true, orders: next });
}

// PATCH /api/games/:gameId/settlements/:settlementId/missiles   { auto?, reserve?, salvo? }
async function handleSettings(req, env, ctx) {
  const L = await loadSilo(env, ctx);
  if (L.error) return L.error;
  const body = await readJson(req);
  const auto = body?.auto != null ? String(body.auto) : L.s.missile_auto;
  if (!AUTO_MODES.includes(auto)) return err(400, 'bad_request', 'auto must be off, missiles or fleets');
  const reserve = body?.reserve != null
    ? Math.max(0, Math.min(siloCapacity(L.level), Math.floor(Number(body.reserve) || 0)))
    : Number(L.s.missile_reserve || 0);
  const salvo = body?.salvo != null
    ? Math.max(1, Math.min(Math.max(1, siloCapacity(L.level)), Math.floor(Number(body.salvo) || 1)))
    : Number(L.s.missile_salvo ?? DEFAULT_AUTO_SALVO);
  await env.DB.prepare('UPDATE game_settlements SET missile_auto = ?, missile_reserve = ?, missile_salvo = ? WHERE id = ?')
    .bind(auto, reserve, salvo, L.s.id).run();
  return json({ ok: true, auto, reserve, salvo });
}

/** How long a salvo from `fromId` takes to reach `toId` launched at
 *  `tick`, and the burn that lands it then. Two passes: the target moves
 *  while the missile flies. */
export async function missileLeg(DB, gameId, fromId, toId, tick, { posAt = null, homeRadius = 0 } = {}) {
  // Positions: an in-memory sky when the caller has one (the ETA list asks
  // for many worlds at once), else the route math's own queries.
  const at = posAt ?? (await (async () => { const { bodyPosAt } = makeRouteMath(DB, gameId); return bodyPosAt; })());
  const pos = async (id, t) => at(id, t);
  const centre = await pos(fromId, tick);
  let to = await pos(toId, tick);
  let T = Math.max(1, Math.ceil(missileTicks(Math.hypot(to.x - centre.x, to.y - centre.y))));
  to = await pos(toId, tick + T);
  const d = Math.hypot(to.x - centre.x, to.y - centre.y);
  T = Math.max(1, Math.ceil(missileTicks(d)));
  to = await pos(toId, tick + T);
  // IT LEAVES FROM ORBIT, ON THE SIDE FACING ITS TARGET (Lorne, 2026-10-20:
  // a salvo that started at the world's centre sat on the planet, reading
  // as a ship in orbit, until its push carried it clear).
  const away = Math.hypot(to.x - centre.x, to.y - centre.y) || 1;
  const rp = parkOrbitRadius(Number(homeRadius) || 0);
  const from = { x: centre.x + ((to.x - centre.x) / away) * rp, y: centre.y + ((to.y - centre.y) / away) * rp };
  const dFinal = Math.hypot(to.x - from.x, to.y - from.y);
  const centreNext = await pos(fromId, tick + 0.01);
  // ONE STEADY PUSH, THE WHOLE WAY, like an intercept: covers dFinal in
  // exactly T from its launch, the flip at the arrival so it never brakes.
  // (A ship's slowly building push left a salvo hanging at its world for
  // most of its first tick.) brake_accel must be positive to read as the
  // leg's own; it is never reached.
  const acc = dFinal > 0 ? (2 * dFinal) / (T * T) : 0;
  return {
    ticks: T,
    arrive: tick + T,
    plan: acc > 0 ? {
      lx: from.x, ly: from.y,
      lvx: (centreNext.x - centre.x) / 0.01, lvy: (centreNext.y - centre.y) / 0.01,
      acc, flip: tick + T, brk: acc, rmp: null, amax: null, atau: null,
    } : null,
  };
}

/**
 * The burn that puts a salvo from `fromBodyId` (leaving at `tick`) on the
 * hull `targetId` while it is still in flight: a rendezvous against its
 * stored plan, meeting no later than a tick before it lands (it lands in
 * the arrivals step, which runs before the missile pass). Null when no
 * such meeting exists. `F` is loadFlights().
 */
export function planIntercept(F, fromBodyId, tick, targetId, { missiles = false } = {}) {
  const f = F.flights.get(targetId);
  // A hostile SALVO is a target only for auto-defence shooting it down.
  if (!f || (f.cls === MISSILE_CLASS && !missiles)) return null;
  const latest = Math.floor(f.plan.arriveTick) - 1;
  if (!(latest > tick)) return null;
  let p0 = F.sky.bodyPos(fromBodyId, tick);
  const v0 = F.sky.bodyVel(fromBodyId, tick);
  // The first whole tick the target is somewhere a salvo can reach in
  // time (missileTicks: half a two-engine hull's trip to that spot).
  let meet = null, at = null;
  for (let t = tick + 1; t <= latest; t++) {
    const s = F.stateAt(targetId, t);
    if (!s) break;
    if (missileTicks(Math.hypot(s.pos.x - p0.x, s.pos.y - p0.y)) <= t - tick) { meet = t; at = s.pos; break; }
  }
  if (meet == null) return null;
  // It leaves from orbit, on the side facing the meeting, not the world's
  // centre (where a salvo sat on the planet reading as parked).
  {
    const rp = parkOrbitRadius(Number(F.sky.byId.get(fromBodyId)?.radius) || 0);
    const away = Math.hypot(at.x - p0.x, at.y - p0.y) || 1;
    p0 = { x: p0.x + ((at.x - p0.x) / away) * rp, y: p0.y + ((at.y - p0.y) / away) * rp };
  }
  // ONE straight push, the whole way, that puts the salvo on that spot at
  // that tick with the launch world's motion folded in: no second burn to
  // match the target's speed, it bursts there (the rendezvous columns
  // with B = 0; rendezvousStateAt flies it as arc 1 for the whole trip).
  const T = meet - tick;
  const A = {
    x: (2 * (at.x - p0.x - v0.x * T)) / T,
    y: (2 * (at.y - p0.y - v0.y * T)) / T,
  };
  const acc = Math.hypot(A.x, A.y) / T;
  if (!(acc > 0)) return null;
  return {
    meetTick: meet,
    detonateTick: meet,
    arrive: Math.round(f.plan.arriveTick),
    dest: f.plan.targetBodyId,
    plan: {
      lx: p0.x, ly: p0.y, lvx: v0.x, lvy: v0.y, acc,
      flip: meet,
      A, B: { x: 0, y: 0 },
    },
  };
}

/** Where an intercept's burst happens: its single push, at the meeting. */
export function meetPoint(plan, startTick, meetTick) {
  return rendezvousStateAt({
    p0: { x: plan.lx, y: plan.ly }, v0: { x: plan.lvx, y: plan.lvy }, accel: plan.acc,
    A: plan.A, B: plan.B, startTick, meetTick,
  }, meetTick, null).pos;
}

/** Hulls sitting in orbit (not mid-leg, not missiles): a burst within the
 *  blast radius of their world's centre catches them (a park orbit is
 *  6-10 units; the radius is 40). */
export async function loadParked(DB, gameId) {
  return (await DB
    .prepare(
      `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.hp, s.parent_body_id
         FROM game_ships s
        WHERE s.game_id = ? AND s.status = 'active' AND s.ship_class <> 'missile'
          AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status = 'in_transit')`,
    )
    .bind(gameId).all()).results ?? [];
}

/** Every hull a burst at `at` on tick `meet` catches: flying ones where
 *  their plans put them, parked ones at their world. `hit` carries hit
 *  points already spent this tick (ship id -> hp left). */
export function blastVictims(F, parked, at, meet, hit = new Map()) {
  const R2 = MISSILE_BLAST_RADIUS * MISSILE_BLAST_RADIUS;
  const near = (p) => p && ((p.x - at.x) ** 2 + (p.y - at.y) ** 2) <= R2;
  const victims = [];
  for (const [id, f] of F.flights) {
    if (f.cls === MISSILE_CLASS || (hit.get(id) ?? 1) <= 0) continue;
    if (near(F.stateAt(id, meet)?.pos)) {
      victims.push({ id, name: f.name, ship_class: f.cls, owner_faction_id: f.owner, hp: hit.get(id) ?? f.hp, parked_at: null });
    }
  }
  for (const s of parked) {
    if ((hit.get(s.id) ?? 1) <= 0) continue;
    if (near(F.sky.bodyPos(s.parent_body_id, meet))) victims.push({ ...s, hp: hit.get(s.id) ?? s.hp, parked_at: s.parent_body_id });
  }
  return victims;
}

/** The rows of one salvo leaving `silo`: the missile hull, its leg, the
 *  launcher's private log line. `leg` is a missileLeg (at a world) or a
 *  planIntercept (at a hull, with its rendezvous). `warn`, for a salvo at
 *  ships in flight: the line their owner gets (Lorne, 2026-10-20: the
 *  raider is told missiles will meet them). */
function salvoStatements(env, { gameId, tick, ownerId, silo, homeRadius, count, targetBodyId, arrive, plan, rv, payload, warn }) {
  const shipId = `${gameId}:msl_${tick}_${Math.random().toString(36).slice(2, 8)}`;
  const rp = parkOrbitRadius(Number(homeRadius) || 0);
  const p = plan ?? {};
  return {
    shipId,
    stmts: [
      env.DB.prepare(
        `INSERT INTO game_ships
           (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
            orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
            fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick,
            home_body_id, missile_count, missile_from_settlement_id)
         VALUES (?, ?, ?, ?, 'missile', ?, ?, ?, 0, 0, ?, 1, 0, 0, 'active', ?, 1, 1, 0, ?, ?, ?)`,
      ).bind(shipId, gameId, ownerId, `Missiles x${count}`, silo.body_id, rp, rp, tick, tick,
        silo.body_id, count, silo.id),
      env.DB.prepare(
        `INSERT INTO game_ship_nodes
           (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
            scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
            launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick, brake_accel,
            accel_ramp, accel_max, accel_tau, rv_ax, rv_ay, rv_bx, rv_by, rv_meet_tick, rv_follow_ship_id,
            status, committed_at_tick)
         VALUES (?, ?, ?, 0, 'absolute', ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
      ).bind(`${shipId}:tr${tick}:n0`, gameId, shipId, targetBodyId, tick, arrive,
        p.lx ?? null, p.ly ?? null, p.lvx ?? null, p.lvy ?? null, p.acc ?? null, p.flip ?? null, p.brk ?? null,
        p.rmp ?? null, p.amax ?? null, p.atau ?? null,
        rv?.A.x ?? null, rv?.A.y ?? null, rv?.B.x ?? null, rv?.B.y ?? null, rv?.meetTick ?? null, rv?.follow ?? null,
        tick),
      env.DB.prepare(
        `INSERT INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'missile_launch', ?, ?, ?, ?, ?, ?)`,
      ).bind(`mlaunch_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, ownerId, targetBodyId, shipId,
        JSON.stringify({ count, ...payload }), JSON.stringify([ownerId]), Date.now()),
      ...(warn ? [env.DB.prepare(
        `INSERT INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'missile_inbound', ?, ?, ?, ?, ?, ?)`,
      ).bind(`minbd_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, ownerId, targetBodyId, warn.shipId,
        JSON.stringify({ count, ...warn.payload }), JSON.stringify([warn.ownerId]), Date.now())] : []),
    ],
  };
}

/** Names for an intercept's log line and picker: whose hulls, how many. */
function groupLabel(F, factionNames, leadId) {
  const lead = F.flights.get(leadId);
  if (!lead) return {};
  const group = groupFlights(F.flights, { exclude: (_id, f) => f.cls === MISSILE_CLASS })
    .find(g => g.members.includes(leadId));
  return { target_owner_name: factionNames.get(lead.owner) ?? null, target_hulls: group?.members.length ?? 1 };
}

// POST /api/games/:gameId/settlements/:settlementId/missiles/launch
//   { target_body_id, count }   at a world: lands in its orbit
//   { target_ship_id, count }   at a hull in flight: meets it on the way
async function handleLaunch(req, env, ctx) {
  const L = await loadSilo(env, ctx);
  if (L.error) return L.error;
  const body = await readJson(req);
  if (body?.target_ship_id != null) return launchAtShip(env, L, body);
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
  // WAR TO FIRE (Lorne, 2026-10-20): a strike needs someone you are at war
  // with in that orbit. What lands still hits everything there.
  const war = await hostilePairs(env, L.gameId);
  const inOrbit = (await env.DB
    .prepare(
      `SELECT DISTINCT s.owner_faction_id FROM game_ships s
        WHERE s.game_id = ? AND s.parent_body_id = ? AND s.status = 'active' AND s.ship_class <> 'missile'
          AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status = 'in_transit')`,
    )
    .bind(L.gameId, targetId).all()).results ?? [];
  if (!inOrbit.some(r => r.owner_faction_id !== L.me.id && war.has(pairKey(L.me.id, r.owner_faction_id)))) {
    return err(409, 'not_at_war', 'nobody you are at war with is in that orbit');
  }
  const sky = await loadSky(env.DB, L.gameId);
  const leg = await missileLeg(env.DB, L.gameId, L.s.body_id, targetId, L.tick, { posAt: sky.bodyPos, homeRadius: home?.radius });
  // Take the missiles first (guarded): two taps cannot fire one magazine twice.
  const took = await env.DB
    .prepare('UPDATE game_settlements SET missile_stock = missile_stock - ? WHERE id = ? AND missile_stock >= ?')
    .bind(count, L.s.id, count).run();
  if (!took.meta?.changes) return err(409, 'not_enough', 'not that many missiles ready');
  const { shipId, stmts } = salvoStatements(env, {
    gameId: L.gameId, tick: L.tick, ownerId: L.me.id, silo: L.s, homeRadius: home?.radius, count,
    targetBodyId: targetId, arrive: leg.arrive, plan: leg.plan, rv: null,
    payload: { from_name: home?.name ?? '', body_name: target.name, arrive_tick: leg.arrive },
  });
  await env.DB.batch(stmts);
  return json({ ok: true, ship_id: shipId, arrive_tick: leg.arrive, ticks: leg.ticks });
}

/** The launch handler's other half: a salvo at a hull in flight. */
async function launchAtShip(env, L, body) {
  const targetId = String(body.target_ship_id ?? '');
  const count = Math.floor(Number(body?.count) || 0);
  if (!targetId.startsWith(`${L.gameId}:`) || targetId.includes(':msl_')) return err(400, 'bad_request', 'invalid target');
  if (!(count >= 1)) return err(400, 'bad_request', 'launch at least one missile');
  if (count > Number(L.s.missile_stock || 0)) return err(409, 'not_enough', 'not that many missiles ready');
  const F = await loadFlights(env.DB, L.gameId);
  const f = F.flights.get(targetId);
  if (!f || f.cls === MISSILE_CLASS) return err(404, 'not_in_flight', 'that ship is not in flight');
  if (f.owner === L.me.id) return err(400, 'own_ship', 'that is one of your own ships');
  // WAR TO FIRE (Lorne, 2026-10-20): only at an empire you are at war with.
  const war = await hostilePairs(env, L.gameId);
  if (!war.has(pairKey(L.me.id, f.owner))) return err(409, 'not_at_war', 'you are not at war with that empire');
  const rows = (await env.DB
    .prepare('SELECT id, name, template_id, parent_body_id, radius, type, destroyed_at_tick FROM game_bodies WHERE game_id = ?')
    .bind(L.gameId).all()).results ?? [];
  const byId = new Map(rows.map(r => [r.id, r]));
  if (starSystemOf(f.plan.targetBodyId, byId) !== starSystemOf(L.s.body_id, byId)) {
    return err(409, 'out_of_range', 'missiles only reach ships bound for worlds in their own star system');
  }
  const icp = planIntercept(F, L.s.body_id, L.tick, targetId);
  if (!icp) return err(409, 'cant_catch', 'missiles cannot catch that group before it lands');
  const took = await env.DB
    .prepare('UPDATE game_settlements SET missile_stock = missile_stock - ? WHERE id = ? AND missile_stock >= ?')
    .bind(count, L.s.id, count).run();
  if (!took.meta?.changes) return err(409, 'not_enough', 'not that many missiles ready');
  const factionNames = new Map(((await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?').bind(L.gameId).all()).results ?? [])
    .map(x => [x.id, x.name]));
  const home = byId.get(L.s.body_id);
  const { shipId, stmts } = salvoStatements(env, {
    gameId: L.gameId, tick: L.tick, ownerId: L.me.id, silo: L.s, homeRadius: home?.radius, count,
    targetBodyId: icp.dest, arrive: icp.arrive, plan: icp.plan,
    rv: { A: icp.plan.A, B: icp.plan.B, meetTick: icp.meetTick, follow: targetId },
    payload: {
      from_name: home?.name ?? '', body_name: byId.get(icp.dest)?.name ?? '', in_flight: true,
      meet_tick: icp.detonateTick, ...groupLabel(F, factionNames, targetId),
    },
    warn: {
      ownerId: f.owner, shipId: targetId,
      payload: {
        launcher_name: factionNames.get(L.me.id) ?? null, from_name: home?.name ?? '',
        body_name: byId.get(icp.dest)?.name ?? '', meet_tick: icp.detonateTick,
        target_hulls: groupLabel(F, factionNames, targetId).target_hulls ?? 1,
      },
    },
  });
  await env.DB.batch(stmts);
  return json({ ok: true, ship_id: shipId, meet_tick: icp.detonateTick, ticks: icp.detonateTick - L.tick });
}

/** Of a burst at an intercept's meeting, the hulls `me` would rather it
 *  spared: its own, other than the group it is aimed at. What the launch
 *  picker warns about before a late launch catches your own fleet parked
 *  at the world the raid is closing on. */
function ownHullsInBlast(F, parked, icp, tick, targetId, me) {
  const group = groupFlights(F.flights, { exclude: (_id, f) => f.cls === MISSILE_CLASS })
    .find(g => g.members.includes(targetId));
  const skip = new Set(group?.members ?? [targetId]);
  const at = meetPoint(icp.plan, tick, icp.meetTick);
  const mine = blastVictims(F, parked, at, icp.meetTick).filter(v => v.owner_faction_id === me && !skip.has(v.id));
  const world = mine.find(v => v.parked_at)?.parked_at ?? null;
  return { n: mine.length, world: world ? F.sky.byId.get(world)?.name ?? null : null };
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
  // One positions load for the whole list (it was a few queries a world:
  // ~0.9s for eight).
  const sky = await loadSky(env.DB, gameId);
  const out = {};
  for (const t of to) {
    if (!sky.byId.has(t)) continue;
    try { out[t] = (await missileLeg(env.DB, gameId, from, t, tick, { posAt: sky.bodyPos })).ticks; } catch { /* unknown world */ }
  }
  return json({ eta: out });
}

// GET /api/games/:gameId/missiles/intercepts?from=<world>&ships=a,b
// For each hull named (the picker sends one lead per group it can see):
// the tick a salvo leaving `from` now would meet it, or null.
async function handleIntercepts(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await env.DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, ctx.session.user_id).first();
  if (!me) return err(403, 'not_member', 'not in this game');
  const url = new URL(req.url);
  const from = url.searchParams.get('from') ?? '';
  const ships = (url.searchParams.get('ships') ?? '').split(',').filter(Boolean).slice(0, 40);
  if (!from.startsWith(`${gameId}:`) || ships.some(s => !s.startsWith(`${gameId}:`))) return err(400, 'bad_request', 'invalid id');
  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = Number(game?.current_tick ?? 0);
  const F = await loadFlights(env.DB, gameId);
  const parked = await loadParked(env.DB, gameId);
  const out = {};
  for (const id of ships) {
    const icp = planIntercept(F, from, tick, id);
    // own_hits: your own hulls the burst would catch (a late meeting
    // close to a world your fleet is parked at), for the picker to warn.
    out[id] = icp
      ? { meet_tick: icp.detonateTick, ticks: icp.detonateTick - tick, own_hits: ownHullsInBlast(F, parked, icp, tick, id, me.id) }
      : null;
  }
  return json({ meet: out });
}

export const routes = [
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles\/launch$/, auth: 'required', handle: handleLaunch },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles$/, auth: 'required', handle: handleOrder },
  { method: 'DELETE', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles$/, auth: 'required', handle: handleCancel },
  { method: 'PATCH', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/missiles$/, auth: 'required', handle: handleSettings },
  { method: 'GET', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/missiles\/eta$/, auth: 'required', handle: handleEta },
  { method: 'GET', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/missiles\/intercepts$/, auth: 'required', handle: handleIntercepts },
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
    const level = siloLevelOf(r);
    let orders = parseOrders(r.missile_orders_json);
    const cap = siloCapacity(level);
    // Every line that finished lands its missile (the magazine capped at
    // the silo's capacity, in the write below); freed lines take the next
    // orders waiting, in the order they were placed.
    const done = orders.filter(o => o.complete_tick != null && Number(o.complete_tick) <= tick).length;
    let changed = done > 0;
    if (done) orders = orders.filter(o => !(o.complete_tick != null && Number(o.complete_tick) <= tick));
    const filled = fillLines(orders, siloLines(level), tick);
    if (filled.some((o, i) => o !== orders[i])) changed = true;
    orders = filled;
    // Written RELATIVE to the stock and GUARDED on the orders read: a
    // launch, order or cancel landing between the read and this write
    // would otherwise be overwritten (missiles back after firing, a paid
    // order lost, a refunded one still built). Lost the race: next tick.
    if (changed) {
      stmts.push(env.DB.prepare(
        `UPDATE game_settlements SET missile_stock = MIN(?, missile_stock + ?), missile_orders_json = ?
          WHERE id = ? AND missile_orders_json = ?`,
      ).bind(cap, done, JSON.stringify(orders), r.id, r.missile_orders_json));
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
  return damageShips(env, gameId, tick, victims, damage, factionNames);
}

/** `damage` to each of `victims` ({id, name, ship_class, owner_faction_id,
 *  hp}); the dead are destroyed and their captains' fates resolved. */
async function damageShips(env, gameId, tick, victims, damage, factionNames) {
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
  // NOTHING TO DO IN MOST GAMES: no salvo in the air and no silo on
  // auto-defence with missiles to spend. One read, and a game without
  // silos pays nothing more per tick (pre-prod review, 2026-10-20).
  const live = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM game_ships WHERE game_id = ? AND ship_class = 'missile' AND status = 'active') AS salvos,
            EXISTS (SELECT 1 FROM game_settlements WHERE game_id = ? AND type = 'city' AND destroyed_at_tick IS NULL
                      AND missile_auto IN ('missiles', 'fleets') AND missile_stock > 0) AS guards`,
  ).bind(gameId, gameId).first();
  if (!Number(live?.salvos) && !Number(live?.guards)) return 0;
  // WAR TO FIRE (Lorne, 2026-10-20): the automatic modes act only against
  // empires their owner is at war with, and anyone else (you, a partner,
  // a neutral) is someone a burst must not catch. The blast itself still
  // spares nobody; this decides only when a silo pulls the trigger.
  const war = await hostilePairs(env, gameId);
  const atWar = (a, b) => a !== b && war.has(pairKey(a, b)) && !peace.has(pairKey(a, b));
  await retargetSalvos(env, gameId, tick);
  let events = await detonateInFlight(env, gameId, tick);
  events += await landedMissiles(env, gameId, tick, atWar);
  events += await autoShootDown(env, gameId, tick, atWar);
  events += await autoIntercept(env, gameId, tick, atWar);
  await sweepStranded(env, gameId, tick);
  return events;
}

/**
 * A SALVO WITH NOWHERE LEFT TO GO. Every salvo bursts at its meeting or
 * lands somewhere else; one whose leg ended back at its own world without
 * bursting (an intercept fired before the meeting step existed, on
 * staging 2026-10-19) sat in orbit for good, looking like a parked ship
 * (Lorne, 2026-10-20: "it's parked in orbit"). It is spent, quietly: it
 * never hit anything. One statement; nothing to do in a game without one.
 */
async function sweepStranded(env, gameId, tick) {
  const r = await env.DB.prepare(
    `UPDATE game_ships SET status = 'expended', destroyed_at_tick = ?
      WHERE game_id = ? AND ship_class = 'missile' AND status = 'active'
        AND parent_body_id = home_body_id AND built_at_tick < ?
        AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n
                         WHERE n.ship_id = game_ships.id AND n.status IN ('in_transit', 'committed'))`,
  ).bind(tick, gameId, tick).run();
  return r.meta?.changes ?? 0;
}

/**
 * RE-AIM A SALVO WHOSE TARGET WAS RE-TIMED. A ship in flight takes no
 * orders, so a meeting is certain, with one exception: a Gravity Sink
 * holding a hull pushes its arrival back, which moves the end of its
 * course. A salvo still aimed at the old course would burst on nothing.
 * Each tick, before anything bursts: a salvo whose target is no longer
 * where it was going to be at the meeting is re-aimed, from where it is
 * now, at the first whole tick it can reach the target's new course.
 * Found nothing to reach: it flies on to the old spot.
 */
async function retargetSalvos(env, gameId, tick) {
  const rows = (await env.DB
    .prepare(
      `SELECT n.id, n.scheduled_t, n.launch_x, n.launch_y, n.launch_vx, n.launch_vy, n.accel,
              n.rv_ax, n.rv_ay, n.rv_bx, n.rv_by, n.rv_meet_tick, n.rv_follow_ship_id
         FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
        WHERE n.game_id = ? AND s.ship_class = 'missile' AND s.status = 'active'
          AND n.status IN ('in_transit', 'committed') AND n.rv_meet_tick IS NOT NULL AND n.rv_meet_tick > ?`,
    )
    .bind(gameId, tick).all()).results ?? [];
  if (rows.length === 0) return 0;
  const F = await loadFlights(env.DB, gameId);
  let moved = 0;
  for (const n of rows) {
    const target = F.flights.get(n.rv_follow_ship_id);
    if (!target) continue;
    const plan = {
      p0: { x: Number(n.launch_x), y: Number(n.launch_y) }, v0: { x: Number(n.launch_vx), y: Number(n.launch_vy) },
      accel: Number(n.accel) || MISSILE_ACCEL,
      A: { x: Number(n.rv_ax), y: Number(n.rv_ay) }, B: { x: Number(n.rv_bx), y: Number(n.rv_by) },
      startTick: Number(n.scheduled_t), meetTick: Number(n.rv_meet_tick),
    };
    const aim = rendezvousStateAt(plan, plan.meetTick, null).pos;
    const there = F.stateAt(n.rv_follow_ship_id, plan.meetTick)?.pos;
    if (!there || Math.hypot(there.x - aim.x, there.y - aim.y) <= MISSILE_BLAST_RADIUS / 2) continue;
    const now = rendezvousStateAt(plan, tick, null);
    const latest = Math.floor(target.plan.arriveTick) - 1;
    for (let t = tick + 1; t <= latest; t++) {
      const s = F.stateAt(n.rv_follow_ship_id, t);
      if (!s) break;
      if (missileTicks(Math.hypot(s.pos.x - now.pos.x, s.pos.y - now.pos.y)) > t - tick) continue;
      const T = t - tick;
      const A = {
        x: (2 * (s.pos.x - now.pos.x - now.vel.x * T)) / T,
        y: (2 * (s.pos.y - now.pos.y - now.vel.y * T)) / T,
      };
      const acc = Math.hypot(A.x, A.y) / T;
      if (!(acc > 0)) break;
      // The leg's end moves with the meeting: left at the old arrival, a
      // meeting re-timed past it ended the leg first and the salvo struck
      // the target's destination instead (pre-prod review, 2026-10-20).
      await env.DB.prepare(
        `UPDATE game_ship_nodes
            SET scheduled_t = ?, launch_x = ?, launch_y = ?, launch_vx = ?, launch_vy = ?, accel = ?, flip_tick = ?,
                rv_ax = ?, rv_ay = ?, rv_bx = 0, rv_by = 0, rv_meet_tick = ?,
                arrival_at_tick = MAX(arrival_at_tick, ?)
          WHERE id = ?`,
      ).bind(tick, now.pos.x, now.pos.y, now.vel.x, now.vel.y, acc, t, A.x, A.y, t, t + 1, n.id).run();
      moved += 1;
      break;
    }
  }
  return moved;
}

/**
 * SHOOTING SALVOS DOWN IN FLIGHT (Lorne, 2026-10-20). Now that missiles
 * are fast and burst on contact, a silo on MISSILES or + FLEETS meets a
 * hostile salvo on its way in, not only as it lands: one interceptor per
 * incoming missile, above the reserve, at each salvo bound for its world
 * it can catch. The landing shoot-down (landedMissiles) stays for the
 * ones it cannot, such as a short hop from a moon.
 */
async function autoShootDown(env, gameId, tick, atWar) {
  const silos = (await env.DB
    .prepare(
      `SELECT id, body_id, owner_faction_id, missile_stock, missile_reserve
         FROM game_settlements
        WHERE game_id = ? AND type = 'city' AND destroyed_at_tick IS NULL
          AND missile_auto IN ('missiles', 'fleets') AND missile_stock > missile_reserve`,
    )
    .bind(gameId).all()).results ?? [];
  if (silos.length === 0) return 0;
  const F = await loadFlights(env.DB, gameId);
  const salvos = [...F.flights].filter(([, f]) => f.cls === MISSILE_CLASS && !f.plan.rv);
  if (salvos.length === 0) return 0;
  const parked = await loadParked(env.DB, gameId);
  const rows = (await env.DB
    .prepare(`SELECT id, owner_faction_id, missile_count FROM game_ships WHERE game_id = ? AND ship_class = 'missile' AND status = 'active'`)
    .bind(gameId).all()).results ?? [];
  const countOf = new Map(rows.map(r => [r.id, Number(r.missile_count || 0)]));
  // Interceptors each empire already has on each salvo (in the air, or
  // launched this tick and not yet flying).
  const sent = new Map();
  const note = (owner, id, k) => {
    if (!sent.has(owner)) sent.set(owner, new Map());
    sent.get(owner).set(id, (sent.get(owner).get(id) ?? 0) + k);
  };
  const aimed = (await env.DB
    .prepare(
      `SELECT s.owner_faction_id, s.missile_count, n.rv_follow_ship_id FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
        WHERE n.game_id = ? AND s.ship_class = 'missile' AND s.status = 'active'
          AND n.status IN ('in_transit', 'committed') AND n.rv_follow_ship_id IS NOT NULL`,
    )
    .bind(gameId).all()).results ?? [];
  for (const a of aimed) note(a.owner_faction_id, a.rv_follow_ship_id, Number(a.missile_count || 0));
  // The whole game's bodies (a handful of hundred rows): an IN-list of
  // silo worlds could pass D1's 100-parameter limit.
  const bodyRows = new Map(((await env.DB
    .prepare('SELECT id, name, radius FROM game_bodies WHERE game_id = ?')
    .bind(gameId).all()).results ?? []).map(b => [b.id, b]));
  const factionNames = new Map(((await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? [])
    .map(f => [f.id, f.name]));
  let events = 0;
  for (const silo of silos) {
    for (const [id, f] of salvos) {
      const free = Number(silo.missile_stock) - Number(silo.missile_reserve || 0);
      if (free <= 0) break;
      if (f.plan.targetBodyId !== silo.body_id || !atWar(silo.owner_faction_id, f.owner)) continue;
      const need = (countOf.get(id) ?? 0) - (sent.get(silo.owner_faction_id)?.get(id) ?? 0);
      if (need <= 0) continue;
      const icp = planIntercept(F, silo.body_id, tick, id, { missiles: true });
      if (!icp) continue;   // not catchable: the landing shoot-down has it
      // The interceptors burst too: never where it would catch a hull of
      // anyone the silo's owner is not at war with (its own included).
      // The landing shoot-down still has that salvo.
      const at = meetPoint(icp.plan, tick, icp.meetTick);
      if (blastVictims(F, parked, at, icp.meetTick)
        .some(v => !atWar(silo.owner_faction_id, v.owner_faction_id))) continue;
      const k = Math.min(need, free);
      const took = await env.DB
        .prepare('UPDATE game_settlements SET missile_stock = missile_stock - ? WHERE id = ? AND missile_stock >= ?')
        .bind(k, silo.id, k).run();
      if (!took.meta?.changes) break;
      silo.missile_stock = Number(silo.missile_stock) - k;
      const home = bodyRows.get(silo.body_id);
      const { stmts } = salvoStatements(env, {
        gameId, tick, ownerId: silo.owner_faction_id, silo, homeRadius: home?.radius, count: k,
        targetBodyId: icp.dest, arrive: icp.arrive, plan: icp.plan,
        rv: { A: icp.plan.A, B: icp.plan.B, meetTick: icp.meetTick, follow: id },
        payload: {
          from_name: home?.name ?? '', body_name: home?.name ?? '', in_flight: true, auto: true, at_missiles: true,
          meet_tick: icp.detonateTick, target_owner_name: factionNames.get(f.owner) ?? null, target_missiles: countOf.get(id) ?? 0,
        },
      });
      await env.DB.batch(stmts);
      note(silo.owner_faction_id, id, k);
      events += 1;
    }
  }
  return events;
}

/** 0. Salvos whose meeting has come up burst where their arc has them:
 *  every hull within MISSILE_BLAST_RADIUS, in flight or parked, takes
 *  MISSILE_DAMAGE per missile. */
async function detonateInFlight(env, gameId, tick) {
  const due = (await env.DB
    .prepare(
      `SELECT s.id, s.owner_faction_id, s.missile_count, n.id AS node_id, n.target_body_id,
              n.scheduled_t, n.launch_x, n.launch_y, n.launch_vx, n.launch_vy, n.accel,
              n.rv_ax, n.rv_ay, n.rv_bx, n.rv_by, n.rv_meet_tick, n.rv_follow_ship_id
         FROM game_ships s JOIN game_ship_nodes n ON n.ship_id = s.id
        WHERE s.game_id = ? AND s.ship_class = 'missile' AND s.status = 'active'
          AND n.status IN ('in_transit', 'committed') AND n.rv_meet_tick IS NOT NULL AND n.rv_meet_tick <= ?`,
    )
    .bind(gameId, tick).all()).results ?? [];
  if (due.length === 0) return 0;
  const F = await loadFlights(env.DB, gameId);
  const factionNames = new Map(((await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? [])
    .map(f => [f.id, f.name]));
  const parked = await loadParked(env.DB, gameId);
  let events = 0;
  const hit = new Map();   // ship id -> hp left, across bursts this tick
  for (const m of due) {
    const meet = Number(m.rv_meet_tick);
    const at = rendezvousStateAt({
      p0: { x: Number(m.launch_x), y: Number(m.launch_y) }, v0: { x: Number(m.launch_vx), y: Number(m.launch_vy) },
      accel: Number(m.accel) || MISSILE_ACCEL,
      A: { x: Number(m.rv_ax), y: Number(m.rv_ay) }, B: { x: Number(m.rv_bx), y: Number(m.rv_by) },
      startTick: Number(m.scheduled_t), meetTick: meet,
    }, meet, null).pos;
    const victims = blastVictims(F, parked, at, meet, hit);
    const count = Number(m.missile_count || 0);
    const damage = MISSILE_DAMAGE * count;
    await env.DB.batch([
      env.DB.prepare(`UPDATE game_ship_nodes SET status = 'executed', executed_at_tick = ? WHERE id = ?`).bind(tick, m.node_id),
      env.DB.prepare(`UPDATE game_ships SET status = 'expended', destroyed_at_tick = ? WHERE id = ?`).bind(tick, m.id),
    ]);
    const out = victims.length ? await damageShips(env, gameId, tick, victims, damage, factionNames) : [];
    for (const v of victims) hit.set(v.id, Number(v.hp) - damage);
    const dest = F.sky.byId.get(m.target_body_id);
    events += 1;

    // AN INTERCEPTOR: aimed at an enemy SALVO (auto-defence, MISSILES or
    // + FLEETS), it shoots that salvo's missiles down one for one. What is
    // left flies on and lands as it would have.
    const prey = F.flights.get(m.rv_follow_ship_id);
    if (prey?.cls === MISSILE_CLASS) {
      const row = await env.DB.prepare(`SELECT missile_count, status FROM game_ships WHERE id = ?`).bind(m.rv_follow_ship_id).first();
      const had = Number(row?.missile_count ?? 0);
      const killed = row?.status === 'active' ? Math.min(had, count) : 0;
      if (killed > 0) {
        const left = had - killed;
        await env.DB.batch(left > 0
          ? [env.DB.prepare('UPDATE game_ships SET missile_count = ?, name = ? WHERE id = ?').bind(left, `Missiles x${left}`, m.rv_follow_ship_id)]
          : [
            env.DB.prepare(`UPDATE game_ships SET missile_count = 0, status = 'expended', destroyed_at_tick = ? WHERE id = ?`).bind(tick, m.rv_follow_ship_id),
            env.DB.prepare(`UPDATE game_ship_nodes SET status = 'executed', executed_at_tick = ? WHERE ship_id = ? AND status IN ('in_transit', 'committed')`).bind(tick, m.rv_follow_ship_id),
          ]);
        await env.DB.prepare(
          `INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'missile_intercepted', ?, ?, ?, 'public', ?)`,
        ).bind(`mintc_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, m.owner_faction_id, prey.plan.targetBodyId,
          JSON.stringify({
            body_name: F.sky.byId.get(prey.plan.targetBodyId)?.name ?? '', count: killed, in_flight: true,
            by_name: factionNames.get(m.owner_faction_id) ?? null,
            from_names: [factionNames.get(prey.owner)].filter(Boolean),
            got_through: left, x: at.x, y: at.y,
          }), Date.now()).run();
      }
      if (!out.length) continue;   // nothing else in the blast: no strike line
    }

    const targetOwner = F.flights.get(m.rv_follow_ship_id)?.owner ?? out.find(v => v.ship_id === m.rv_follow_ship_id)?.owner_faction_id;
    // ship_id names the hull it was aimed at, so the map plays the blast
    // where that hull is DRAWN (on its course line); x, y is the true
    // meeting, for a hull the client never saw.
    await env.DB.prepare(
      `INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'missile_strike', ?, ?, ?, ?, 'public', ?)`,
    ).bind(`mstrk_${Math.random().toString(36).slice(2, 10)}`, gameId, tick, m.owner_faction_id, m.target_body_id,
      prey?.cls === MISSILE_CLASS ? null : m.rv_follow_ship_id,
      JSON.stringify({
        body_name: dest?.name ?? '', missiles: count, damage, in_flight: true, x: at.x, y: at.y,
        target_owner_name: targetOwner ? factionNames.get(targetOwner) ?? null : null,
        launcher_names: [factionNames.get(m.owner_faction_id)].filter(Boolean),
        victims: out, destroyed_count: out.filter(v => v.destroyed).length,
      }), Date.now()).run();
  }
  return events;
}

/** 4. Silos on + FLEETS launch at hostile groups bound for their world. */
async function autoIntercept(env, gameId, tick, atWar) {
  const silos = (await env.DB
    .prepare(
      `SELECT id, body_id, owner_faction_id, missile_stock, missile_reserve, missile_salvo
         FROM game_settlements
        WHERE game_id = ? AND type = 'city' AND destroyed_at_tick IS NULL
          AND missile_auto = 'fleets' AND missile_stock > missile_reserve`,
    )
    .bind(gameId).all()).results ?? [];
  if (silos.length === 0) return 0;
  const worlds = new Set(silos.map(s => s.body_id));
  const F = await loadFlights(env.DB, gameId);
  const groups = groupFlights(F.flights, { exclude: (_id, f) => f.cls === MISSILE_CLASS })
    .filter(g => worlds.has(g.dest));
  if (groups.length === 0) return 0;
  const parked = await loadParked(env.DB, gameId);
  // Hulls each empire has EVER sent a salvo after, flying, waiting to
  // leave or already burst: auto-intercept is one salvo per raid (Lorne's
  // pick), not a fresh one every tick at whatever survived the first.
  const chased = new Map();
  const aimedAt = (await env.DB
    .prepare(
      `SELECT s.owner_faction_id, n.rv_follow_ship_id FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
        WHERE n.game_id = ? AND s.ship_class = 'missile' AND n.rv_follow_ship_id IS NOT NULL`,
    )
    .bind(gameId).all()).results ?? [];
  for (const r of aimedAt) {
    if (!chased.has(r.owner_faction_id)) chased.set(r.owner_faction_id, new Set());
    chased.get(r.owner_faction_id).add(r.rv_follow_ship_id);
  }
  // The whole game's bodies: an IN-list of silo worlds could pass D1's
  // 100-parameter limit.
  const bodyRows = new Map(((await env.DB
    .prepare('SELECT id, name, radius FROM game_bodies WHERE game_id = ?')
    .bind(gameId).all()).results ?? []).map(b => [b.id, b]));
  const factionNames = new Map(((await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? [])
    .map(f => [f.id, f.name]));
  let events = 0;
  for (const silo of silos) {
    const mine = chased.get(silo.owner_faction_id) ?? new Set();
    chased.set(silo.owner_faction_id, mine);
    for (const g of groups) {
      const free = Number(silo.missile_stock) - Number(silo.missile_reserve || 0);
      if (free <= 0) break;
      if (g.dest !== silo.body_id || !atWar(silo.owner_faction_id, g.owner)) continue;
      if (g.members.some(id => mine.has(id))) continue;
      const icp = planIntercept(F, silo.body_id, tick, g.lead);
      if (!icp) continue;   // not catchable yet; asked again next tick
      // NEVER INTO ANYONE YOU ARE NOT AT WAR WITH, the rule the + FLEETS
      // orbit strike keeps: a meeting whose blast would catch your own,
      // a partner's or a neutral's hulls (a raid met close to a world a
      // fleet is parked at) is not fired.
      const at = meetPoint(icp.plan, tick, icp.meetTick);
      if (blastVictims(F, parked, at, icp.meetTick)
        .some(v => !atWar(silo.owner_faction_id, v.owner_faction_id))) continue;
      const count = Math.max(1, Math.min(Number(silo.missile_salvo ?? DEFAULT_AUTO_SALVO), free));
      const took = await env.DB
        .prepare('UPDATE game_settlements SET missile_stock = missile_stock - ? WHERE id = ? AND missile_stock >= ?')
        .bind(count, silo.id, count).run();
      if (!took.meta?.changes) break;
      silo.missile_stock = Number(silo.missile_stock) - count;
      const home = bodyRows.get(silo.body_id);
      const { stmts } = salvoStatements(env, {
        gameId, tick, ownerId: silo.owner_faction_id, silo, homeRadius: home?.radius, count,
        targetBodyId: icp.dest, arrive: icp.arrive, plan: icp.plan,
        rv: { A: icp.plan.A, B: icp.plan.B, meetTick: icp.meetTick, follow: g.lead },
        payload: {
          from_name: home?.name ?? '', body_name: home?.name ?? '', in_flight: true, auto: true,
          meet_tick: icp.detonateTick, target_owner_name: factionNames.get(g.owner) ?? null, target_hulls: g.members.length,
        },
        warn: {
          ownerId: g.owner, shipId: g.lead,
          payload: {
            launcher_name: factionNames.get(silo.owner_faction_id) ?? null, from_name: home?.name ?? '',
            body_name: home?.name ?? '', meet_tick: icp.detonateTick, target_hulls: g.members.length,
          },
        },
      });
      await env.DB.batch(stmts);
      g.members.forEach(id => mine.add(id));
      events += 1;
    }
  }
  return events;
}

/** 1-3: salvos landing on worlds, and + FLEETS at hulls landing uncaught. */
async function landedMissiles(env, gameId, tick, atWar) {
  // Salvos that have landed: a missile row away from its launch world,
  // not mid-leg. (One waiting to leave sits on its launch world.)
  const arrived = (await env.DB
    .prepare(
      `SELECT s.id, s.owner_faction_id, s.parent_body_id, s.missile_count,
              EXISTS (SELECT 1 FROM game_ship_nodes r WHERE r.ship_id = s.id AND r.rv_follow_ship_id IS NOT NULL) AS aimed
         FROM game_ships s
        WHERE s.game_id = ? AND s.ship_class = 'missile' AND s.status = 'active'
          AND s.parent_body_id <> s.home_body_id
          AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status IN ('in_transit', 'committed'))`,
    )
    .bind(gameId).all()).results ?? [];
  // A salvo aimed at SHIPS that reached its leg's end without bursting (its
  // target re-timed past it) is spent where it is: it was never fired at
  // that world, so it must not strike it.
  const strays = arrived.filter(m => Number(m.aimed));
  if (strays.length) {
    await env.DB.batch(strays.map(m => env.DB
      .prepare(`UPDATE game_ships SET status = 'expended', destroyed_at_tick = ? WHERE id = ? AND status = 'active'`)
      .bind(tick, m.id)));
  }
  const landed = arrived.filter(m => !Number(m.aimed));
  // Ships that landed this tick at a world with a + FLEETS silo. Read
  // from the hulls in those orbits, not from every leg the game has ever
  // finished.
  const arrivedHere = (await env.DB
    .prepare(
      `SELECT s.parent_body_id AS body_id, s.owner_faction_id
         FROM game_ships s
        WHERE s.game_id = ? AND s.status = 'active' AND s.ship_class <> 'missile'
          AND s.parent_body_id IN (SELECT body_id FROM game_settlements
                                    WHERE game_id = ? AND type = 'city' AND destroyed_at_tick IS NULL
                                      AND missile_auto = 'fleets' AND missile_stock > 0)
          AND EXISTS (SELECT 1 FROM game_ship_nodes n
                       WHERE n.ship_id = s.id AND n.status = 'executed' AND n.arrival_at_tick = ?
                         AND n.target_body_id = s.parent_body_id)`,
    )
    .bind(gameId, gameId, tick).all()).results ?? [];
  const bodies = new Set([...landed.map(m => m.parent_body_id), ...arrivedHere.map(a => a.body_id)]);
  if (bodies.size === 0) return 0;

  const silos = (await env.DB
    .prepare(
      `SELECT id, body_id, owner_faction_id, buildings_json, missile_stock, missile_auto, missile_reserve, missile_salvo
         FROM game_settlements
        WHERE game_id = ? AND type = 'city' AND destroyed_at_tick IS NULL
          AND missile_auto IN ('missiles', 'fleets') AND missile_stock > 0`,
    )
    .bind(gameId).all()).results ?? [];
  const factionNames = new Map(((await env.DB
    .prepare('SELECT id, name FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? [])
    .map(f => [f.id, f.name]));
  // The whole game's bodies: an IN-list of every world that saw an
  // arrival could pass D1's 100-parameter limit.
  const bodyNames = new Map(((await env.DB
    .prepare('SELECT id, name FROM game_bodies WHERE game_id = ?')
    .bind(gameId).all()).results ?? []).map(b => [b.id, b.name]));

  let events = 0;
  for (const bodyId of bodies) {
    const here = landed.filter(m => m.parent_body_id === bodyId).map(m => ({ ...m, left: Number(m.missile_count || 0) }));
    const defenders = silos.filter(s => s.body_id === bodyId);
    const writes = [];
    const intercepted = [];

    // 1. AUTO-DEFENCE: one missile for one, above the reserve, at salvos
    // of empires at war with the silo's owner. The stock is taken first,
    // guarded, so a launch made since the read cannot be spent twice.
    for (const silo of defenders) {
      const free = Math.max(0, Number(silo.missile_stock) - Number(silo.missile_reserve || 0));
      const plan = [];
      let want = 0;
      for (const m of here) {
        if (want >= free) break;
        if (m.left <= 0 || !atWar(silo.owner_faction_id, m.owner_faction_id)) continue;
        const k = Math.min(free - want, m.left);
        plan.push({ m, k });
        want += k;
      }
      if (want <= 0) continue;
      const took = await env.DB
        .prepare('UPDATE game_settlements SET missile_stock = missile_stock - ? WHERE id = ? AND missile_stock - ? >= COALESCE(missile_reserve, 0)')
        .bind(want, silo.id, want).run();
      if (!took.meta?.changes) continue;
      silo.missile_stock = Number(silo.missile_stock) - want;
      for (const { m, k } of plan) {
        m.left -= k;
        intercepted.push({ by: silo.owner_faction_id, from: m.owner_faction_id, count: k });
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

    // 3. + FLEETS: hostile ships just arrived, and nobody the silo's owner
    // is not at war with is here (its own, a partner's, a neutral's).
    for (const silo of defenders) {
      if (silo.missile_auto !== 'fleets') continue;
      const hostileArrived = arrivedHere.some(a => a.body_id === bodyId && atWar(silo.owner_faction_id, a.owner_faction_id));
      if (!hostileArrived) continue;
      const free = Math.min(Number(silo.missile_salvo ?? DEFAULT_AUTO_SALVO),
        Math.max(0, Number(silo.missile_stock) - Number(silo.missile_reserve || 0)));
      if (free <= 0) continue;
      const ours = await env.DB.prepare(
        `SELECT owner_faction_id FROM game_ships s
          WHERE s.game_id = ? AND s.parent_body_id = ? AND s.status = 'active' AND s.ship_class <> 'missile'
            AND NOT EXISTS (SELECT 1 FROM game_ship_nodes n WHERE n.ship_id = s.id AND n.status = 'in_transit')`,
      ).bind(gameId, bodyId).all();
      if ((ours.results ?? []).some(r => !atWar(silo.owner_faction_id, r.owner_faction_id))) continue;
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
