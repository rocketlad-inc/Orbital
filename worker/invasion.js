// ============================================================
// THE THREE BODY EVENT — a neighbour that does not want to be one.
//
// Lorne, 2026-10-28, four phases (phase 1 rewritten the same evening):
//   1. EMITTER. A structure with 10,000 hull points starts in orbit of an
//      outer planet on the right-hand side of the system, hidden. Once any
//      empire's sensors find it, it switches on: everyone's science drops
//      25% and the drop deepens a point a tick, until the emitter is
//      destroyed. Nothing in the log explains the drop; the reports show
//      it under the label "???". (scienceBlightMult.)
//   2. LAUNCH. 24 ticks after the emitter switches on, a fleet leaves
//      Verdant, in the Alpha Centauri system, from an enemy that lives
//      there. It burns harder than any player hull: the trip takes 75% of
//      the time a player's ship needs for it. Everyone is told. It flies
//      to a random point on the right-hand side of the solar system.
//   3. GATE. Where it stops it lays a gate on the rim of Centauri facing
//      Sol, wired to a twin. The gate is OWNED, so unlike the sun gates it
//      can be shot down, and the invaders only raise reinforcements while
//      it stands.
//   4. CONQUEST. The fleet takes the settled world nearest the gate (a
//      moon counts), digs in and raises hulls for 40 ticks, then takes
//      Earth. Holding Earth, it raises destroyers and takes the home
//      worlds one at a time.
//
// Taking a world here is what it already is for a player: the fleet
// shoots the settlement to ruins (ordinary combat, the invaders being a
// 'monster' faction at war with everyone) and a colony ship rebuilds on
// them. The event only DECIDES; it never fires a shot itself.
//
// It is an event, not an ending (Lorne's call): a player whose home falls
// is out the way any destroyed empire is, and the invaders never win. If
// their fleet is wiped out, or they lose every world they hold, they are
// repelled and it stops.
//
// WHAT IT IS, MECHANICALLY. Hulls owned by a faction row with status
// 'monster' (kaiju.js's trick): every "active empires" query leaves it
// out, wars.js pairs it with everyone, diplomacy refuses it. Movement is
// planLegForShip, handed in as a hook. Reinforcements are raised by
// script at a fixed cadence, not paid for: the host's dials set the
// pace. Every id is fixed per game and every write is INSERT OR IGNORE
// or guarded, so a retried tick changes nothing. One read per tick in a
// game that has the event; none in a game that does not.
// ============================================================

import { SHIP_COMBAT_STATS } from './factions.js';
import { makeRouteMath } from './routeMath.js';
import { legTicks, SHIP_ENGINE_ACCEL } from './burn.js';
import { commitSettlement } from './actions.js';
import { MEGA_MU, MEGA_MAX_HP, MEGASTRUCTURES, periodForRadius } from './megastructures.js';
import {
  seededRand, chronicleOnce, tellEveryone, angle0For, templateOf, mainSystemSql,
  pickBearing, FAR_GATE_RADIUS_MUL,
  SUN_GATE_TEMPLATE, SUN_GATE_SITE_TEMPLATE, SUN_GATE_TRANSIT_FRACTION, SUN_GATE_SIZE_MUL,
} from './sunGates.js';
import { tr } from './i18n.js';
import { isWorld } from './systems.js';

export const invasionFactionId = (g) => `${g}:invaders_f`;
export const invasionSiteId = (g) => `${g}:invasion_site`;
export const invasionGateId = (g) => `${g}:invasion_gate`;
export const invasionTwinId = (g) => `${g}:invasion_gate_far`;
const shipId = (g, n) => `${g}:inv_${n}`;

/** Placeholder names: Lorne names things. */
export const INVADER_FACTION_NAME = 'Verdant Armada';
export const INVADER_COLOR = '#6dffb0';
const FEED_COLOR = 0x6dffb0;
/** A faction slot no player seat can ever take (the Leviathan has 900). */
const INVADER_SLOT = 901;

const TWO_PI = Math.PI * 2;

/** Host dials (configSchema.js), repaired. */
export function invasionDials(conf) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const start = Math.max(1, Math.round(num(conf?.invasion_start, 120)));
  return {
    on: Number(conf?.invasion) === 1 && Number(conf?.far_systems) === 1,
    start,
    end: Math.max(start, Math.round(num(conf?.invasion_end, 220))),
    // The blight: 25% down the tick the emitter switches on, 1 more point
    // every tick it stays on, up to a ceiling (it runs until the emitter
    // is destroyed, so it needs one).
    debuff: Math.min(0.95, Math.max(0, num(conf?.invasion_debuff_pct, 25) / 100)),
    growth: Math.max(0, num(conf?.invasion_debuff_growth_pct, 1) / 100),
    maxCut: Math.min(0.95, Math.max(0, num(conf?.invasion_debuff_max_pct, 65) / 100)),
    // The emitter: hull points, ticks from switching on to the fleet
    // leaving, and a backstop that switches it on by itself if no
    // empire's sensors ever find it (else a game with no scouts stalls).
    emitterHp: Math.max(100, Math.round(num(conf?.invasion_emitter_hp, 10000))),
    launchDelay: Math.max(0, Math.round(num(conf?.invasion_launch_delay, 24))),
    revealAfter: Math.max(1, Math.round(num(conf?.invasion_reveal_after, 120))),
    // Their trip time as a share of a player hull's.
    speed: Math.min(1, Math.max(0.1, num(conf?.invasion_speed, 0.75))),
    frigates: Math.max(0, Math.round(num(conf?.invasion_frigates, 8))),
    destroyers: Math.max(0, Math.round(num(conf?.invasion_destroyers, 4))),
    colony: Math.max(1, Math.round(num(conf?.invasion_colony, 2))),
    hunker: Math.max(0, Math.round(num(conf?.invasion_hunker_ticks, 40))),
    buildEvery: Math.max(1, Math.round(num(conf?.invasion_build_every, 4))),
    destroyerEvery: Math.max(1, Math.round(num(conf?.invasion_destroyer_every, 3))),
    // Reinforcements stop at this many live hulls, so a long war cannot
    // grow the fleet (and the tick) without limit.
    fleetCap: Math.max(10, Math.round(num(conf?.invasion_fleet_cap, 80))),
  };
}

// ---- phase 1: the emitter and its blight -------------------------------------

export const invasionEmitterId = (g) => `${g}:blight_emitter`;
export const EMITTER_KIND = 'blight_emitter';
/** Stands in for "until the emitter is destroyed" where a lapse tick is wanted. */
export const BLIGHT_NO_END = 1e9;

/** The seeded tick the emitter appears. */
export function rollStartTick(gameId, d) {
  return d.start + Math.floor(seededRand(`${gameId}|invasion|start`)() * (d.end - d.start + 1));
}

/**
 * Science multiplier for one tick. PURE: it reads only when the emitter
 * switched on and when it was destroyed, so it does not matter whether the
 * harvest pass runs before or after advanceInvasion in the tick. 1 before
 * it is on and after it is gone.
 */
export function blightMult(activatedTick, destroyedTick, tick, d) {
  if (activatedTick == null) return 1;
  const k = tick - Number(activatedTick);
  if (k < 0) return 1;
  if (destroyedTick != null && tick >= Number(destroyedTick)) return 1;
  return 1 - Math.min(d.maxCut, d.debuff + d.growth * k);
}

/**
 * What every faction's science is multiplied by this tick (room.js,
 * beside the senate's science slider). One primary-key read.
 */
export async function scienceBlightMult(DB, gameId, tick, conf) {
  const d = invasionDials(conf);
  if (!d.on) return 1;
  const row = await DB
    .prepare('SELECT activated_tick, emitter_destroyed_tick FROM game_invasion WHERE game_id = ?')
    .bind(gameId).first();
  if (!row) return 1;
  return blightMult(row.activated_tick, row.emitter_destroyed_tick, tick, d);
}

/**
 * The blight as the player is allowed to see it (state.js): a number, under
 * a label the game does not explain ("???"). Null when it is not on. The
 * cause is never in this payload.
 */
export async function blightFor(DB, gameId, tick, conf) {
  const mult = await scienceBlightMult(DB, gameId, tick, conf);
  if (!(mult < 1)) return null;
  return { multiplier: mult, until_tick: BLIGHT_NO_END };
}

// ---- movement -----------------------------------------------------------------

/** Ticks for an invader hull to cover `d`: a share of a player hull's. */
export function invaderTicks(d, speed) {
  return Math.max(1, Math.ceil(speed * legTicks(Math.max(1, d), SHIP_ENGINE_ACCEL)));
}

/** Ticks from `fromId` (now) to `toId` (where it will be on arrival). */
async function flightTo(rm, fromId, toId, tick, speed) {
  const a = await rm.bodyPosAt(fromId, tick);
  let T = invaderTicks(1, speed);
  for (let i = 0; i < 3; i++) {
    const b = await rm.bodyPosAt(toId, tick + T);
    T = invaderTicks(Math.hypot(b.x - a.x, b.y - a.y), speed);
  }
  return T;
}

// ---- reads --------------------------------------------------------------------

const loadRow = (DB, gameId) => DB.prepare('SELECT * FROM game_invasion WHERE game_id = ?').bind(gameId).first();

const parseTaken = (r) => { try { const a = JSON.parse(r.taken_json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

/** The invaders' live hulls. */
async function fleetOf(DB, gameId, fid) {
  return (await DB
    .prepare(`SELECT id, ship_class, parent_body_id, name FROM game_ships
               WHERE game_id = ? AND owner_faction_id = ? AND status = 'active'`)
    .bind(gameId, fid).all()).results ?? [];
}

async function flying(DB, ids) {
  return (await flyingSet(DB, ids)).size > 0;
}

/** Which of these hulls are in flight right now. */
async function flyingSet(DB, ids) {
  const out = new Set();
  // 100 bound parameters a query (D1): in chunks.
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const rows = (await DB
      .prepare(`SELECT DISTINCT ship_id FROM game_ship_nodes
                 WHERE ship_id IN (${part.map(() => '?').join(',')})
                   AND status IN ('planned', 'committed', 'in_transit')`)
      .bind(...part).all()).results ?? [];
    for (const r of rows) out.add(r.ship_id);
  }
  return out;
}

/** Live settlements on a body owned by a real (non-monster) empire. */
async function enemySettlements(DB, gameId, bodyId) {
  return (await DB
    .prepare(`SELECT s.id, s.type, s.name, s.owner_faction_id FROM game_settlements s
                JOIN game_factions f ON f.id = s.owner_faction_id
               WHERE s.game_id = ? AND s.body_id = ? AND s.destroyed_at_tick IS NULL
                 AND f.status <> 'monster'`)
    .bind(gameId, bodyId).all()).results ?? [];
}

async function ownSettlements(DB, gameId, fid) {
  return (await DB
    .prepare(`SELECT s.id, s.body_id FROM game_settlements s
               WHERE s.game_id = ? AND s.owner_faction_id = ? AND s.destroyed_at_tick IS NULL`)
    .bind(gameId, fid).all()).results ?? [];
}

/** Is the invaders' gate still standing? Their reinforcements need it. */
export async function gateStands(DB, gameId) {
  // Destroyed (seizing it in 'destroy' mode deletes the structure), or
  // captured by an empire (a capture changes the BODY's owner, not
  // founded_by): either way it is no longer theirs to send ships through.
  const g = await DB
    .prepare(`SELECT m.hp, m.status, b.owner_faction_id, b.destroyed_at_tick FROM game_megastructures m
                JOIN game_bodies b ON b.id = m.body_id
               WHERE m.body_id = ? AND m.game_id = ?`)
    .bind(invasionGateId(gameId), gameId).first();
  return !!g && g.status === 'complete' && Number(g.hp) > 0 && g.destroyed_at_tick == null
    && g.owner_faction_id === invasionFactionId(gameId);
}

// ---- writes -------------------------------------------------------------------

/** One invader hull, parked at `bodyId`. */
function hullStmt(DB, gameId, fid, n, cls, bodyId, tick) {
  const st = SHIP_COMBAT_STATS[cls];
  return DB.prepare(
    `INSERT OR IGNORE INTO game_ships
       (id, game_id, owner_faction_id, name, ship_class,
        parent_body_id, orbit_rp, orbit_ra, orbit_omega,
        orbit_m0, orbit_epoch, orbit_direction,
        fuel, fuel_max, status, built_at_tick,
        hp, hp_max, damage_per_tick, stance)
     VALUES (?, ?, ?, ?, ?, ?, 6, 6, ?, 0, ?, 1, 0, 0, 'active', ?, ?, ?, ?, 'attack')`,
  ).bind(shipId(gameId, n), gameId, fid, `${cls[0].toUpperCase()}${cls.slice(1)} ${n}`, cls,
    bodyId, (n * 0.7) % TWO_PI, tick, tick, st.hp, st.hp, st.damage_per_tick);
}

async function setPhase(DB, gameId, phase, tick, extra = {}) {
  const cols = Object.keys(extra);
  await DB.prepare(
    `UPDATE game_invasion SET phase = ?, phase_tick = ?${cols.map(c => `, ${c} = ?`).join('')} WHERE game_id = ?`,
  ).bind(phase, tick, ...cols.map(c => extra[c]), gameId).run();
}

// ---- the tick -----------------------------------------------------------------

/**
 * Advance the event for one game at one tick. Safe to call every tick.
 * `hooks.planLeg(shipId, factionId, fromBodyId, toBodyId, arriveTick)`
 * is the room's own planner.
 */
export async function advanceInvasion(env, gameId, tick, conf, hooks) {
  const d = invasionDials(conf);
  if (!d.on) return { phase: 'off' };
  const DB = env.DB;

  let row = await loadRow(DB, gameId);
  if (!row) {
    // Needs the far system on this board; else the event is not for this game.
    const verdant = await DB.prepare('SELECT 1 AS x FROM game_bodies WHERE id = ?').bind(`${gameId}:verdant`).first();
    if (!verdant) return { phase: 'no_verdant' };
    // A game already past its rolled tick starts 12 ticks from now.
    const rolled = rollStartTick(gameId, d);
    const start = Math.max(rolled, tick + (tick > rolled ? 12 : 0));
    await DB.prepare(
      `INSERT OR IGNORE INTO game_invasion (game_id, start_tick, phase, phase_tick) VALUES (?, ?, 'pending', ?)`,
    ).bind(gameId, start, tick).run();
    row = await loadRow(DB, gameId);
  }

  // The emitter has its own life, whatever the fleet is doing: it can be
  // shot down in any phase, and that is what switches the blight off.
  if (row.emitter_body_id && row.emitter_destroyed_tick == null) {
    if (await checkEmitter(env, gameId, tick, row)) row.emitter_destroyed_tick = tick;
  }

  const phase = row.phase;
  if (phase === 'repelled' || phase === 'done') return { phase };

  // The emitter is placed, silent and unseen.
  if (phase === 'pending') {
    if (tick < Number(row.start_tick)) return { phase: 'pending' };
    const placed = await placeEmitter(env, gameId, tick, d, conf);
    if (!placed) return { phase: 'pending', waiting: 'no_host' };
    await setPhase(DB, gameId, 'hidden', tick, { emitter_body_id: placed.id, faction_id: invasionFactionId(gameId) });
    return { phase: 'hidden' };
  }
  // Waiting to be found: the first empire whose sensors cover it switches
  // it on, or the backstop does.
  if (phase === 'hidden') {
    const finder = await findEmitter(env, gameId, tick, conf, row.emitter_body_id);
    if (!finder && tick < Number(row.phase_tick) + d.revealAfter) return { phase: 'hidden' };
    await activateEmitter(env, gameId, tick, row, finder);
    return { phase: 'blight', finder };
  }
  // On, and the fleet leaves `launchDelay` ticks after it came on.
  if (phase === 'blight') {
    if (tick < Number(row.activated_tick) + d.launchDelay) return { phase: 'blight' };
    return launch(env, gameId, tick, d, hooks, row);
  }

  const fid = row.faction_id;
  const fleet = await fleetOf(DB, gameId, fid);
  const warships = fleet.filter(s => s.ship_class !== 'colony');
  if (warships.length === 0 && phase !== 'transit') {
    return repel(env, gameId, tick, row, 'fleet_destroyed');
  }
  if (phase === 'transit') return arrive(env, gameId, tick, d, hooks, row, fleet);

  // Lost every world they held: the invasion is over.
  if (phase === 'build' || phase === 'earth' || phase === 'conquest') {
    const holds = await ownSettlements(DB, gameId, fid);
    if (holds.length === 0) return repel(env, gameId, tick, row, 'worlds_lost');
  }
  if (phase === 'siege') return assault(env, gameId, tick, d, hooks, row, fleet, 'siege');
  if (phase === 'build') return hunker(env, gameId, tick, d, hooks, row, fleet);
  if (phase === 'earth') return assault(env, gameId, tick, d, hooks, row, fleet, 'earth');
  if (phase === 'conquest') return conquer(env, gameId, tick, d, hooks, row, fleet);
  return { phase };
}

// ---- the emitter --------------------------------------------------------------

/**
 * Stand the emitter up in orbit of an outer planet on the right-hand side
 * of the system (+x): a gas or ice giant, picked at random among those
 * there; if none is on the right, the one furthest right. Hidden like any
 * other structure nobody has found: it has no discovery rows. It belongs
 * to the invaders' faction, which is what lets ships siege it. Returns
 * { id, host } or null when the board has no giant to put it at.
 */
async function placeEmitter(env, gameId, tick, d, conf) {
  const DB = env.DB;
  const fid = invasionFactionId(gameId);
  const main = mainSystemSql('template_id');
  const bodies = (await DB
    .prepare(`SELECT id, template_id, name, type, parent_body_id, mu, soi, radius,
                     orbit_radius, orbit_period, angle0
                FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL AND obliterated_at_tick IS NULL`)
    .bind(gameId).all()).results ?? [];
  const mainIds = new Set((await DB
    .prepare(`SELECT id FROM game_bodies WHERE game_id = ? AND ${main.sql}`)
    .bind(gameId, ...main.binds).all()).results?.map(r => r.id) ?? []);
  const giants = bodies.filter(b => mainIds.has(b.id) && (b.type === 'gas-giant' || b.type === 'ice-giant'));
  if (giants.length === 0) return null;
  const rm = makeRouteMath(DB, gameId);
  const placed = [];
  for (const g of giants) placed.push({ g, x: (await rm.bodyPosAt(g.id, tick)).x });
  const right = placed.filter(p => p.x > 0);
  const pool = right.length > 0 ? right : [placed.slice().sort((a, b) => b.x - a.x)[0]];
  const host = pool[Math.floor(seededRand(`${gameId}|invasion|emitter`)() * pool.length)].g;

  const bodyScale = Number(conf?.body_scale) > 0 ? Number(conf.body_scale) : 1;
  // The gate rule: clear of the surface, inside the sphere of influence.
  const soi = Number(host.soi) || 0;
  const rad = Number(host.radius) || 1;
  const r = soi > 0 ? Math.min(Math.max(rad * 2.5, soi * 0.35), soi * 0.8) : rad * 4;
  const period = periodForRadius(host, r, bodies);
  const angle0 = angle0For(seededRand(`${gameId}|invasion|emitter|angle`)() * TWO_PI, period, tick);
  const id = invasionEmitterId(gameId);
  await DB.batch([
    // Faction first: the structure is its.
    DB.prepare(
      `INSERT OR IGNORE INTO game_factions
         (id, game_id, user_id, slot, name, color, status, joined_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'monster', ?)`,
    ).bind(fid, gameId, INVADER_SLOT, INVADER_FACTION_NAME, INVADER_COLOR, Date.now()),
    DB.prepare(
      `INSERT OR IGNORE INTO game_bodies
         (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
          orbit_radius, orbit_period, angle0, color, owner_faction_id)
       VALUES (?, ?, 'blight_emitter', ?, 'megastructure', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, gameId, `${host.name} Emitter`, host.id, 2.2 * bodyScale, MEGA_MU,
      r, period, angle0, INVADER_COLOR, fid),
    // Full health EXPLICITLY, as every structure here (the column default
    // is a small number).
    DB.prepare(
      `INSERT OR IGNORE INTO game_megastructures
         (body_id, game_id, kind, status, acc_metal, acc_credits,
          cost_metal, cost_credits, founded_by_faction_id,
          founded_at_tick, completed_at_tick, hp)
       VALUES (?, ?, ?, 'complete', 0, 0, 0, 0, ?, ?, ?, ?)`,
    ).bind(id, gameId, EMITTER_KIND, fid, tick, tick, d.emitterHp),
  ]);
  return { id, host: host.name };
}

/**
 * Has any empire's sensors found the emitter? The same sensor circles the
 * map's fog and the meteoroid survey use (meteoroidTick.sensorBubbles), so
 * "discovered" means what it means everywhere else: you can see it. Returns
 * the finding faction's id, or null.
 */
async function findEmitter(env, gameId, tick, conf, emitterId) {
  const DB = env.DB;
  const rm = makeRouteMath(DB, gameId);
  const ids = new Set([emitterId]);
  for (const r of (await DB.prepare(
    `SELECT DISTINCT parent_body_id AS b FROM game_ships WHERE game_id = ? AND status = 'active' AND parent_body_id IS NOT NULL`,
  ).bind(gameId).all()).results ?? []) ids.add(r.b);
  for (const r of (await DB.prepare(
    `SELECT DISTINCT body_id AS b FROM game_settlements WHERE game_id = ? AND destroyed_at_tick IS NULL`,
  ).bind(gameId).all()).results ?? []) ids.add(r.b);
  const pos = new Map();
  for (const id of ids) pos.set(id, await rm.bodyPosAt(id, tick));
  const monsters = new Set((await DB
    .prepare(`SELECT id FROM game_factions WHERE game_id = ? AND status = 'monster'`).bind(gameId).all())
    .results?.map(r => r.id) ?? []);
  const mt = await import('./meteoroidTick.js');
  const scale = Number(conf?.system_scale) > 0 ? Number(conf.system_scale) : 1;
  const bubbles = await mt.sensorBubbles(env, gameId, tick, (id) => pos.get(id), scale);
  const e = pos.get(emitterId);
  for (const [fid, list] of bubbles) {
    if (monsters.has(fid)) continue;
    for (const b of list) {
      const dx = e.x - b.x, dy = e.y - b.y;
      if (dx * dx + dy * dy <= b.r2) return fid;
    }
  }
  return null;
}

/** Switch it on. Tells whoever found it, and only them. */
async function activateEmitter(env, gameId, tick, row, finderFid) {
  const DB = env.DB;
  await setPhase(DB, gameId, 'blight', tick, { activated_tick: tick, found_by_faction_id: finderFid ?? null });
  row.activated_tick = tick;
  if (!finderFid) return;
  const body = await DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(row.emitter_body_id).first();
  await DB.batch([
    DB.prepare(
      `INSERT OR IGNORE INTO game_body_discoveries (game_id, body_id, faction_id, discovered_at_tick, method)
       VALUES (?, ?, ?, ?, 'sensor')`,
    ).bind(gameId, row.emitter_body_id, finderFid, tick),
    DB.prepare(
      `INSERT OR IGNORE INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, 'invasion_emitter_found', ?, ?, ?, ?, ?)`,
    ).bind(`${gameId}:invasion:emitter_found`, gameId, tick, finderFid, row.emitter_body_id,
      JSON.stringify({ name: body?.name ?? null }), JSON.stringify([finderFid]), Date.now()),
  ]);
  const users = (await DB
    .prepare('SELECT user_id FROM game_factions WHERE id = ? AND user_id IS NOT NULL').bind(finderFid).all())
    .results?.map(r => r.user_id) ?? [];
  if (users.length > 0) {
    await tellEveryone(env, gameId, tick, 'invasion:emitter', (L) => ({
      title: tr(L, 'feed.invasion.emitterFoundTitle'),
      lines: [tr(L, 'feed.invasion.emitterFoundBody', { where: body?.name ?? '' })],
    }), { color: FEED_COLOR, only: users, feed: false });
  }
}

/**
 * Is the emitter gone? A ship siege wears its hull down (the room's
 * megastructure siege, which the invaders' ownership makes apply), and a
 * boarding party can destroy it outright; either way it is finished here:
 * the structure goes, the blight ends, and everyone is told. Captured it
 * cannot be (actions.js refuses): nobody gets to own this.
 */
async function checkEmitter(env, gameId, tick, row) {
  const DB = env.DB;
  const m = await DB.prepare('SELECT hp FROM game_megastructures WHERE body_id = ?').bind(row.emitter_body_id).first();
  if (m && Number(m.hp) > 0) return false;
  await DB.batch([
    DB.prepare('DELETE FROM game_megastructures WHERE body_id = ?').bind(row.emitter_body_id),
    DB.prepare('UPDATE game_bodies SET destroyed_at_tick = COALESCE(destroyed_at_tick, ?) WHERE id = ?').bind(tick, row.emitter_body_id),
    DB.prepare('UPDATE game_invasion SET emitter_destroyed_tick = ? WHERE game_id = ? AND emitter_destroyed_tick IS NULL').bind(tick, gameId),
  ]);
  if (row.activated_tick != null && await chronicleOnce(DB, `${gameId}:invasion:emitter_down`, gameId, tick,
    'invasion_emitter_destroyed', row.emitter_body_id, { after: tick - Number(row.activated_tick) })) {
    await tellEveryone(env, gameId, tick, 'invasion:emitter_down', (L) => ({
      title: tr(L, 'feed.invasion.emitterDownTitle'),
      lines: [tr(L, 'feed.invasion.emitterDownBody')],
    }), { color: FEED_COLOR });
  }
  return true;
}

// ---- phase 2: the launch ------------------------------------------------------

async function launch(env, gameId, tick, d, hooks, row) {
  const DB = env.DB;
  const fid = invasionFactionId(gameId);
  const rm = makeRouteMath(DB, gameId);
  const bodies = (await DB
    .prepare(`SELECT id, template_id, parent_body_id, type, radius, orbit_radius, orbit_period, angle0
                FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`)
    .bind(gameId).all()).results ?? [];
  const sol = bodies.find(b => templateOf(b) === 'sol') ?? bodies.find(b => !b.parent_body_id);
  if (!sol) return { phase: 'blight' };
  const orbitOf = (tpl, fallback) => Number(bodies.find(b => templateOf(b) === tpl)?.orbit_radius) || fallback;

  // A random point on the RIGHT side of the system (+x), between Mars's
  // orbit and Uranus's, seeded so a retried tick agrees with itself.
  const rand = seededRand(`${gameId}|invasion|site`);
  const rInner = orbitOf('mars', 200), rOuter = Math.max(rInner + 1, orbitOf('uranus', 1500));
  const r = rInner + rand() * (rOuter - rInner);
  const bearing = (rand() * 2 - 1) * (70 * Math.PI / 180);

  const from = `${gameId}:verdant`;
  const here = await rm.bodyPosAt(from, tick);
  const there = { x: Math.cos(bearing) * r, y: Math.sin(bearing) * r };
  const T = invaderTicks(Math.hypot(there.x - here.x, there.y - here.y), d.speed);
  const arrival = tick + T;

  const orbitPeers = bodies.filter(b => !(Number(b.orbit_period) >= 1e9) && b.type !== 'star' && b.type !== 'black_hole');
  const period = periodForRadius(sol, r, orbitPeers);
  const angle0 = angle0For(bearing, period, arrival);
  const gateR = (MEGASTRUCTURES.warp_gate?.radius ?? 1.9) * SUN_GATE_SIZE_MUL;
  const site = invasionSiteId(gameId);

  // The invaders' faction, the landing site, and the fleet, together.
  const stmts = [
    DB.prepare(
      `INSERT OR IGNORE INTO game_factions
         (id, game_id, user_id, slot, name, color, status, joined_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'monster', ?)`,
    ).bind(fid, gameId, INVADER_SLOT, INVADER_FACTION_NAME, INVADER_COLOR, Date.now()),
    DB.prepare(
      `INSERT OR IGNORE INTO game_bodies
         (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
          orbit_radius, orbit_period, angle0, color, owner_faction_id,
          emerge_from_tick, emerge_until_tick)
       VALUES (?, ?, ?, 'Gate landing site', 'lagrange', ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    ).bind(site, gameId, SUN_GATE_SITE_TEMPLATE, sol.id, gateR, MEGA_MU, r, period, angle0, INVADER_COLOR, tick),
  ];
  let n = 0;
  for (let i = 0; i < d.frigates; i++) stmts.push(hullStmt(DB, gameId, fid, ++n, 'frigate', from, tick));
  for (let i = 0; i < d.destroyers; i++) stmts.push(hullStmt(DB, gameId, fid, ++n, 'destroyer', from, tick));
  for (let i = 0; i < d.colony; i++) stmts.push(hullStmt(DB, gameId, fid, ++n, 'colony', from, tick));
  await DB.batch(stmts);

  // Everyone can see where it is going.
  const factions = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? [];
  if (factions.length > 0) {
    await DB.batch(factions.map(f => DB.prepare(
      `INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick) VALUES (?, ?, ?, ?)`,
    ).bind(gameId, f.id, site, tick)));
  }

  // Their legs, once. A retried launch finds them planned.
  for (const s of await fleetOf(DB, gameId, fid)) {
    if (await flying(DB, [s.id])) continue;
    await hooks.planLeg(s.id, fid, from, site, arrival);
  }
  // THE ROW GOES LAST, so a tick that sees 'transit' sees a fleet in flight.
  await setPhase(DB, gameId, 'transit', tick, { faction_id: fid, site_body_id: site, arrive_tick: arrival });

  if (await chronicleOnce(DB, `${gameId}:invasion:launched`, gameId, tick, 'invasion_launched', site,
    { arrive_tick: arrival, ships: n, from: 'Verdant' })) {
    await tellEveryone(env, gameId, tick, 'invasion:launched', (L) => ({
      title: tr(L, 'feed.invasion.launchedTitle'),
      lines: [tr(L, 'feed.invasion.launchedBody', { n, tick: arrival })],
    }), { color: FEED_COLOR });
  }
  return { phase: 'transit', arrival };
}

// ---- phase 3: the gate --------------------------------------------------------

async function arrive(env, gameId, tick, d, hooks, row, fleet) {
  const DB = env.DB;
  if (tick < Number(row.arrive_tick)) return { phase: 'transit' };
  const site = row.site_body_id;
  const ids = fleet.map(s => s.id);
  if (await flying(DB, ids)) return { phase: 'transit', flying: true };
  if (fleet.length === 0) return repel(env, gameId, tick, row, 'fleet_destroyed');

  const bodies = (await DB
    .prepare(`SELECT id, template_id, parent_body_id, type, radius, orbit_radius, orbit_ra, orbit_period, angle0
                FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`)
    .bind(gameId).all()).results ?? [];
  const siteRow = bodies.find(b => b.id === site);
  const verdant = bodies.find(b => b.id === `${gameId}:verdant`);
  const sol = bodies.find(b => templateOf(b) === 'sol') ?? bodies.find(b => !b.parent_body_id);
  const bary = bodies.find(b => templateOf(b) === 'binary_barycenter');
  if (!siteRow || !verdant || !sol || !bary) return repel(env, gameId, tick, row, 'no_board');

  const gate = invasionGateId(gameId), twin = invasionTwinId(gameId), fid = row.faction_id;
  const gateR = Number(siteRow.radius) || 2.85;
  // THE TWIN SITS ON THE RIM FACING SOL (Lorne, 2026-10-28: "like with the
  // squid gate"): just past the outermost world of the Centauri system,
  // within 45 degrees either side of the line to the Sun, and clear of the
  // sun gate's own far end if that one is already there.
  const orbitPeers = bodies.filter(b => !(Number(b.orbit_period) >= 1e9) && b.type !== 'star' && b.type !== 'black_hole');
  const farWorlds = bodies.filter(b => b.parent_body_id === bary.id && isWorld(b) && b.type !== 'star' && b.type !== 'black_hole');
  const outermost = Math.max(100, ...farWorlds.map(b => Number(b.orbit_ra ?? b.orbit_radius) || 0));
  const twinR = outermost * FAR_GATE_RADIUS_MUL;
  const twinPeriod = periodForRadius(bary, twinR, orbitPeers);
  const rm = makeRouteMath(DB, gameId);
  const solAt = await rm.bodyPosAt(sol.id, tick);
  const baryAt = await rm.bodyPosAt(bary.id, tick);
  const avoid = [];
  if (bodies.some(b => b.id === `${gameId}:sungate_centauri_far`)) {
    const q = await rm.bodyPosAt(`${gameId}:sungate_centauri_far`, tick);
    avoid.push({ x: q.x - baryAt.x, y: q.y - baryAt.y });
  }
  const towardSol = Math.atan2(solAt.y - baryAt.y, solAt.x - baryAt.x);
  const twinBearing = pickBearing(seededRand(`${gameId}|invasion|twin`), twinR, avoid, towardSol, twinR * 0.15);
  const twinAngle = angle0For(twinBearing, twinPeriod, tick);

  const insBody = (id, name, parentId, orbitR, orbitP, ang0) => DB.prepare(
    `INSERT OR IGNORE INTO game_bodies
       (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
        orbit_radius, orbit_period, angle0, color, owner_faction_id,
        emerge_from_tick, emerge_until_tick)
     VALUES (?, ?, ?, ?, 'megastructure', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    // OWNED by the invaders: the room's siege only wears down a structure
    // whose body has an owner at war with the besiegers, so an ownerless
    // gate (the sun gates) could never be shot down.
  ).bind(id, gameId, SUN_GATE_TEMPLATE, name, parentId, gateR, MEGA_MU, orbitR, orbitP, ang0, INVADER_COLOR, fid, tick);
  const insMega = (id, partner) => DB.prepare(
    `INSERT OR IGNORE INTO game_megastructures
       (body_id, game_id, kind, status, acc_metal, acc_credits,
        cost_metal, cost_credits, founded_by_faction_id,
        founded_at_tick, completed_at_tick, hp, partner_body_id, transit_fraction)
     VALUES (?, ?, 'warp_gate', 'complete', 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, gameId, fid, tick, tick, MEGA_MAX_HP, partner, SUN_GATE_TRANSIT_FRACTION);
  await DB.batch([
    insBody(gate, 'Verdant Gate', siteRow.parent_body_id, Number(siteRow.orbit_radius),
      Number(siteRow.orbit_period), Number(siteRow.angle0)),
    insBody(twin, 'Armada Gate', bary.id, twinR, twinPeriod, twinAngle),
    insMega(gate, twin),
    insMega(twin, gate),
  ]);
  const factions = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ?').bind(gameId).all()).results ?? [];
  if (factions.length > 0) {
    await DB.batch(factions.flatMap(f => [gate, twin].map(b => DB.prepare(
      `INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick) VALUES (?, ?, ?, ?)`,
    ).bind(gameId, f.id, b, tick))));
  }

  const near = await nearestWorld(DB, gameId, tick, siteRow);
  if (await chronicleOnce(DB, `${gameId}:invasion:gate`, gameId, tick, 'invasion_gate', gate,
    { near: near?.name ?? null })) {
    await tellEveryone(env, gameId, tick, 'invasion:gate', (L) => ({
      title: tr(L, 'feed.invasion.gateTitle'),
      lines: [tr(L, near ? 'feed.invasion.gateNear' : 'feed.invasion.gateBody', { near: near?.name ?? '' })],
    }), { color: FEED_COLOR });
  }
  await setPhase(DB, gameId, 'siege', tick, { gate_body_id: gate, twin_body_id: twin });
  return { phase: 'siege' };
}

/** The Sol world nearest a point, for the news. */
async function nearestWorld(DB, gameId, tick, point) {
  const rm = makeRouteMath(DB, gameId);
  const p = await rm.bodyPosAt(point.id, tick);
  const main = mainSystemSql('template_id');
  const worlds = (await DB
    .prepare(`SELECT id, name FROM game_bodies
               WHERE game_id = ? AND destroyed_at_tick IS NULL AND obliterated_at_tick IS NULL
                 AND type IN ('terrestrial', 'dwarf', 'moon', 'gas-giant', 'ice-giant')
                 AND (emerge_from_tick IS NULL OR emerge_from_tick <= ?)
                 AND ${main.sql}`)
    .bind(gameId, tick, ...main.binds).all()).results ?? [];
  let best = null;
  for (const w of worlds) {
    const q = await rm.bodyPosAt(w.id, tick);
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    if (!best || dist < best.dist) best = { ...w, dist };
  }
  return best;
}

// ---- phases 4a/4c: an assault -------------------------------------------------

/** The settled world nearest `point` that a real empire holds. A moon
 *  counts, so "the nearest world, or its moon if necessary" is just the
 *  nearest settled body; a raw world is the fallback. */
async function pickTarget(DB, gameId, tick, point) {
  const rm = makeRouteMath(DB, gameId);
  const p = await rm.bodyPosAt(point, tick);
  const main = mainSystemSql('b.template_id');
  const rows = (await DB
    .prepare(`SELECT b.id, b.name, b.type,
                     EXISTS (SELECT 1 FROM game_settlements s
                              JOIN game_factions f ON f.id = s.owner_faction_id
                              WHERE s.game_id = b.game_id AND s.body_id = b.id
                                AND s.destroyed_at_tick IS NULL AND f.status <> 'monster') AS held
                FROM game_bodies b
               WHERE b.game_id = ? AND b.destroyed_at_tick IS NULL AND b.obliterated_at_tick IS NULL
                 AND b.type IN ('terrestrial', 'dwarf', 'moon')
                 AND (b.emerge_from_tick IS NULL OR b.emerge_from_tick <= ?)
                 AND ${main.sql}`)
    .bind(gameId, tick, ...main.binds).all()).results ?? [];
  let best = null;
  for (const b of rows) {
    const q = await rm.bodyPosAt(b.id, tick);
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    const key = [Number(b.held) === 1 ? 0 : 1, dist];
    if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { ...b, key };
  }
  return best;
}

/**
 * Send the whole fleet to `target`; once it is there and no empire's
 * settlement stands, found the invaders' own on the ruins. Returns the
 * body name when a world has just been taken.
 */
async function assaultStep(env, gameId, tick, d, hooks, row, fleet, targetId) {
  const DB = env.DB;
  const fid = row.faction_id;
  const rm = makeRouteMath(DB, gameId);
  const inFlight = await flyingSet(DB, fleet.map(s => s.id));
  const idle = fleet.filter(s => !inFlight.has(s.id));

  // Every idle hull that is not at the target goes there, each from where
  // it stands: reinforcements raised at the base follow the main body
  // instead of holding the founding up.
  let arrive = null;
  const away = idle.filter(s => s.parent_body_id !== targetId);
  if (away.length > 0) {
    const times = new Map();
    for (const s of away) {
      if (!times.has(s.parent_body_id)) times.set(s.parent_body_id, await flightTo(rm, s.parent_body_id, targetId, tick, d.speed));
      const T = times.get(s.parent_body_id);
      await hooks.planLeg(s.id, fid, s.parent_body_id, targetId, tick + T);
      arrive = Math.max(arrive ?? 0, tick + T);
    }
  }

  // Founding needs warships standing at the target.
  const here = idle.filter(s => s.parent_body_id === targetId && s.ship_class !== 'colony');
  if (here.length === 0) return { moving: true, arrive };

  // While an empire's settlement stands, combat does the work.
  const defenders = await enemySettlements(DB, gameId, targetId);
  if (defenders.length > 0) return { besieging: true, arrive };

  const body = await DB.prepare('SELECT name, type, radius FROM game_bodies WHERE id = ?').bind(targetId).first();
  const mine = (await ownSettlements(DB, gameId, fid)).filter(s => s.body_id === targetId);
  if (mine.length > 0) return { taken: true, name: body?.name ?? targetId, already: true };

  // Ruins (or a raw world): a colony ship rebuilds. None here? Settlers
  // come with the fleet; the event never stalls for want of one.
  let colony = idle.find(s => s.parent_body_id === targetId && s.ship_class === 'colony');
  if (!colony) {
    const n = 1000 + tick;
    await DB.batch([hullStmt(DB, gameId, fid, n, 'colony', targetId, tick)]);
    colony = { id: shipId(gameId, n) };
  }
  const ruins = await DB
    .prepare(`SELECT type FROM game_settlements WHERE game_id = ? AND body_id = ? AND wrecked_at_tick IS NOT NULL
               ORDER BY destroyed_at_tick DESC LIMIT 1`)
    .bind(gameId, targetId).first();
  const type = ruins?.type ?? (body?.type === 'terrestrial' || body?.type === 'dwarf' ? 'city' : 'station');
  const made = await commitSettlement(env, {
    gameId, bodyId: targetId, factionId: fid, type, name: body?.name, tick,
    bodyRadius: Number(body?.radius ?? 1), bodyName: body?.name, quiet: true,
    consumedShip: { id: colony.id },
  });
  if (!made?.ok) return { blocked: made?.code ?? 'refused', arrive };
  return { taken: true, name: body?.name ?? targetId };
}

async function assault(env, gameId, tick, d, hooks, row, fleet, which) {
  const DB = env.DB;
  const rm = makeRouteMath(DB, gameId);

  let targetId = row.target_body_id;
  if (!targetId) {
    if (which === 'earth') {
      targetId = `${gameId}:earth`;
    } else {
      const t = await pickTarget(DB, gameId, tick, row.site_body_id);
      if (!t) return repel(env, gameId, tick, row, 'nothing_to_take');
      targetId = t.id;
    }
    await DB.prepare('UPDATE game_invasion SET target_body_id = ? WHERE game_id = ?').bind(targetId, gameId).run();
    row.target_body_id = targetId;
  }
  const tb = await DB.prepare('SELECT id, name, obliterated_at_tick, destroyed_at_tick FROM game_bodies WHERE id = ?')
    .bind(targetId).first();
  if (!tb || tb.obliterated_at_tick != null || tb.destroyed_at_tick != null) {
    // The world is gone: choose again next tick.
    await DB.prepare('UPDATE game_invasion SET target_body_id = NULL WHERE game_id = ?').bind(gameId).run();
    return { phase: row.phase, retarget: true };
  }

  const res = await assaultStep(env, gameId, tick, d, hooks, row, fleet, targetId);
  if (res.moving && res.arrive && await chronicleOnce(DB, `${gameId}:invasion:assault:${targetId}`, gameId, tick,
    'invasion_assault', targetId, { world: tb.name, arrive_tick: res.arrive, earth: which === 'earth' })) {
    await tellEveryone(env, gameId, tick, `invasion:assault:${targetId}`, (L) => ({
      title: tr(L, which === 'earth' ? 'feed.invasion.earthTitle' : 'feed.invasion.assaultTitle', { world: tb.name }),
      lines: [tr(L, which === 'earth' ? 'feed.invasion.earthBody' : 'feed.invasion.assaultBody',
        { world: tb.name, tick: res.arrive })],
    }), { color: FEED_COLOR });
  }
  if (!res.taken) return { phase: row.phase, ...res };

  // A world taken.
  const taken = [...parseTaken(row), res.name];
  const next = which === 'siege' ? 'build' : 'conquest';
  await setPhase(DB, gameId, next, tick, {
    taken_json: JSON.stringify(taken), target_body_id: null,
    ...(which === 'siege' ? { held_body_id: targetId } : {}),
  });
  if (await chronicleOnce(DB, `${gameId}:invasion:taken:${targetId}`, gameId, tick,
    which === 'earth' ? 'invasion_earth_taken' : 'invasion_world_taken', targetId, { world: res.name, nth: taken.length })) {
    await tellEveryone(env, gameId, tick, `invasion:taken:${targetId}`, (L) => ({
      title: tr(L, which === 'earth' ? 'feed.invasion.earthTakenTitle' : 'feed.invasion.takenTitle', { world: res.name }),
      lines: [tr(L, which === 'earth' ? 'feed.invasion.earthTakenBody' : 'feed.invasion.takenBody',
        { world: res.name, n: d.hunker })],
    }), { color: FEED_COLOR });
  }
  return { phase: next, taken: res.name };
}

// ---- phase 4b: dig in ---------------------------------------------------------

async function hunker(env, gameId, tick, d, hooks, row, fleet) {
  const DB = env.DB;
  const fid = row.faction_id;
  await raise(DB, gameId, fid, row, tick, d, 'frigate', d.buildEvery, row.held_body_id);
  if (tick < Number(row.phase_tick) + d.hunker) return { phase: 'build' };
  await setPhase(DB, gameId, 'earth', tick, { target_body_id: null });
  return { phase: 'earth' };
}

/** Raise one hull at the base every `every` ticks, while the gate stands. */
async function raise(DB, gameId, fid, row, tick, d, cls, every, bodyId) {
  if (!bodyId) return false;
  const since = tick - Number(row.phase_tick);
  if (since <= 0 || since % every !== 0) return false;
  if (!(await gateStands(DB, gameId))) return false;
  const live = await DB.prepare(`SELECT COUNT(*) AS n FROM game_ships WHERE game_id = ? AND owner_faction_id = ? AND status = 'active'`)
    .bind(gameId, fid).first();
  if (Number(live?.n) >= d.fleetCap) return false;
  const n = 2000 + Number(row.built) + 1;
  await DB.batch([
    hullStmt(DB, gameId, fid, n, cls, bodyId, tick),
    DB.prepare('UPDATE game_invasion SET built = built + 1 WHERE game_id = ?').bind(gameId),
  ]);
  row.built = Number(row.built) + 1;
  return true;
}

// ---- phase 4d: the home worlds ------------------------------------------------

async function conquer(env, gameId, tick, d, hooks, row, fleet) {
  const DB = env.DB;
  const fid = row.faction_id;
  await raise(DB, gameId, fid, row, tick, d, 'destroyer', d.destroyerEvery, `${gameId}:earth`);

  // Next home world: the nearest one a live empire still holds.
  let targetId = row.target_body_id;
  if (!targetId) {
    const caps = (await DB
      .prepare(`SELECT f.capital_body_id AS id, f.user_id FROM game_factions f
                 WHERE f.game_id = ? AND f.status NOT IN ('monster', 'observer', 'eliminated')
                   AND f.capital_body_id IS NOT NULL`)
      .bind(gameId).all()).results ?? [];
    const rm = makeRouteMath(DB, gameId);
    const from = await rm.bodyPosAt(`${gameId}:earth`, tick);
    let best = null;
    for (const c of caps) {
      if (c.id === `${gameId}:earth`) continue;
      const alive = await enemySettlements(DB, gameId, c.id);
      if (alive.length === 0) continue;
      const q = await rm.bodyPosAt(c.id, tick);
      const dist = Math.hypot(q.x - from.x, q.y - from.y);
      if (!best || dist < best.dist) best = { id: c.id, dist };
    }
    if (!best) {
      await setPhase(DB, gameId, 'done', tick, { target_body_id: null });
      if (await chronicleOnce(DB, `${gameId}:invasion:done`, gameId, tick, 'invasion_done', null,
        { held: parseTaken(row) })) {
        await tellEveryone(env, gameId, tick, 'invasion:done', (L) => ({
          title: tr(L, 'feed.invasion.doneTitle'),
          lines: [tr(L, 'feed.invasion.doneBody')],
        }), { color: FEED_COLOR });
      }
      return { phase: 'done' };
    }
    targetId = best.id;
    await DB.prepare('UPDATE game_invasion SET target_body_id = ? WHERE game_id = ?').bind(targetId, gameId).run();
    row.target_body_id = targetId;
  }

  const tb = await DB.prepare('SELECT id, name, obliterated_at_tick FROM game_bodies WHERE id = ?').bind(targetId).first();
  if (!tb || tb.obliterated_at_tick != null) {
    await DB.prepare('UPDATE game_invasion SET target_body_id = NULL WHERE game_id = ?').bind(gameId).run();
    return { phase: 'conquest', retarget: true };
  }
  const res = await assaultStep(env, gameId, tick, d, hooks, row, fleet, targetId);
  if (res.moving && res.arrive && await chronicleOnce(DB, `${gameId}:invasion:assault:${targetId}`, gameId, tick,
    'invasion_assault', targetId, { world: tb.name, arrive_tick: res.arrive, home: true })) {
    await tellEveryone(env, gameId, tick, `invasion:assault:${targetId}`, (L) => ({
      title: tr(L, 'feed.invasion.homeTitle', { world: tb.name }),
      lines: [tr(L, 'feed.invasion.homeBody', { world: tb.name, tick: res.arrive })],
    }), { color: FEED_COLOR });
  }
  if (res.taken) {
    const taken = [...parseTaken(row), res.name];
    await DB.prepare('UPDATE game_invasion SET taken_json = ?, target_body_id = NULL WHERE game_id = ?')
      .bind(JSON.stringify(taken), gameId).run();
    if (await chronicleOnce(DB, `${gameId}:invasion:taken:${targetId}`, gameId, tick,
      'invasion_world_taken', targetId, { world: res.name, nth: taken.length, home: true })) {
      await tellEveryone(env, gameId, tick, `invasion:taken:${targetId}`, (L) => ({
        title: tr(L, 'feed.invasion.homeFallsTitle', { world: res.name }),
        lines: [tr(L, 'feed.invasion.homeFallsBody', { world: res.name })],
      }), { color: FEED_COLOR });
    }
  }
  return { phase: 'conquest', ...res };
}

// ---- the end ------------------------------------------------------------------

async function repel(env, gameId, tick, row, why) {
  const DB = env.DB;
  await setPhase(DB, gameId, 'repelled', tick, { target_body_id: null });
  // Whatever is left of them stands down: they were the event's, not a faction's.
  if (row.faction_id) {
    await DB.prepare(`UPDATE game_ships SET status = 'departed' WHERE game_id = ? AND owner_faction_id = ? AND status = 'active'`)
      .bind(gameId, row.faction_id).run();
  }
  if (await chronicleOnce(DB, `${gameId}:invasion:repelled`, gameId, tick, 'invasion_repelled', null,
    { why, held: parseTaken(row) })) {
    await tellEveryone(env, gameId, tick, 'invasion:repelled', (L) => ({
      title: tr(L, 'feed.invasion.repelledTitle'),
      lines: [tr(L, why === 'worlds_lost' ? 'feed.invasion.repelledWorlds' : 'feed.invasion.repelledFleet')],
    }), { color: FEED_COLOR });
  }
  return { phase: 'repelled', why };
}
