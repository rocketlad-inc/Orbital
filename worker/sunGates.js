// ============================================================
// THE SUN GATES — the way in to the far systems.
//
// Lorne, 2026-10-06: somewhere between tick 250 and 300 every player is
// told that "something strange is emerging from the sun". Six ticks later
// a gate comes out of it, does a hard burn at 2g for the outer system and
// stops at a random place in the Far Reach. Forty ticks after that, the
// second. There are two far systems, so there are two gates, and which
// opens first is random. Each Sol gate is wired to a twin just past the
// outermost world of its far system.
//
// The rest of the brief, as decided:
//   - The far systems are on the map from tick 1, and flying there the
//     long way is allowed. The gates are a shortcut, not a lock.
//   - A gate does not teleport. It flings a hull at a TENTH of the burn
//     the crossing would otherwise take (a warp gate is a quarter), so
//     the ship is really in flight and can be intercepted like any other.
//   - Neutral and indestructible: no owner, no founder, not ancient, so
//     siege never touches them (resolveMegastructureSiege), they can
//     never be seized (isAbandoned), strikes refuse structures, and a
//     ram does not destroy its target.
//   - A game already past its rolled tick when this ships starts the
//     event twelve ticks later.
//
// The gates ride on the warp-gate machinery that already exists: a
// 'warp_gate' megastructure row with a partner, which the route planner
// (planGateAwareHop) and the LAUNCH button (handleGateTransit) already
// understand. What is new is the schedule, the flight out of the Sun
// (game_bodies.emerge_*), the transit fraction, and the announcements.
//
// Everything that decides WHERE and WHEN is pure and seeded from the
// game id, so it is testable without a DB and a retried tick can never
// roll a second answer. The writes are INSERT OR IGNORE on deterministic
// ids for the same reason. sim/sunGates.mjs drives it end to end.
// ============================================================

import { orbitAngle, ORBITAL_SPEED_SCALE } from './orbitPos.js';
import {
  FAR_REACH_TEMPLATES, isWorld,
  FAR_SYSTEM_TEMPLATE_IDS, FAR_GATE_TEMPLATE, templateOf, isFarSystemBody, mainSystemSql,
} from './systems.js';

export { FAR_SYSTEM_TEMPLATE_IDS, FAR_GATE_TEMPLATE, templateOf, isFarSystemBody, mainSystemSql };
import { MEGA_MU, MEGA_MAX_HP, MEGASTRUCTURES, periodForRadius } from './megastructures.js';
import { makeRouteMath } from './routeMath.js';

const TWO_PI = Math.PI * 2;

/** The omen window and the gap between gates, when the host says nothing. */
export const SUN_GATE_DEFAULTS = { start: 250, end: 300, interval: 40 };
/** Ticks between "something strange" and the first gate leaving the Sun. */
export const SUN_GATE_WARNING_TICKS = 6;
/** A game already past its rolled omen tick when this ships starts here. */
export const SUN_GATE_LATE_START_TICKS = 12;
/** The gate's own burn out of the Sun, in g. */
export const SUN_GATE_G = 2;
/** 1g in game units / tick^2: the push that carries a ship Sol -> Earth
 *  (132.6 catalogue units) in one tick on an even burn. The gate's burn
 *  is its own, an even push-flip-brake, and deliberately does not read
 *  the ships' engine constants, which are tuned and retuned for ships. */
export const SUN_GATE_G_ANCHOR = 4 * 132.6;
/** A sun-gate crossing's share of the ordinary burn: ten times faster. */
export const SUN_GATE_TRANSIT_FRACTION = 0.1;
/** The far-side twin sits this far past its system's outermost world. */
export const FAR_GATE_RADIUS_MUL = 1.25;
/** Drawn a little larger than a warp gate: it is the map's landmark. */
export const SUN_GATE_SIZE_MUL = 1.5;
/** Body template ids, one per end, so the client can tell them apart. */
export const SUN_GATE_TEMPLATE = 'sun_gate';

/** The two far systems, in catalogue terms. `key` names the gate ids. */
export const SUN_GATE_SYSTEMS = [
  { key: 'centauri', label: 'Centauri', barycenter: 'binary_barycenter',
    solGate: 'Centauri Gate', farGate: 'Sol Gate' },
  { key: 'cygnus', label: 'Cygnus X-1', barycenter: 'bh_barycenter',
    solGate: 'Cygnus Gate', farGate: 'Sol Gate' },
];

// ---- seeded randomness --------------------------------------------------

/** The same generator seedGameWorld uses, keyed by a string. */
export function seededRand(seed) {
  const s = String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
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

// ---- the schedule ---------------------------------------------------------

/** The window and interval for this game, host dials over the defaults,
 *  repaired so a bad edit can never produce an empty or inverted window. */
export function sunGateWindow(conf) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : d);
  const start = Math.max(1, num(conf?.sun_gate_start, SUN_GATE_DEFAULTS.start));
  const end = Math.max(start, num(conf?.sun_gate_end, SUN_GATE_DEFAULTS.end));
  const interval = Math.max(1, num(conf?.sun_gate_interval, SUN_GATE_DEFAULTS.interval));
  return { start, end, interval };
}

/** The omen tick this game rolls, inclusive of both ends of the window. */
export function rollOmenTick(gameId, conf) {
  const { start, end } = sunGateWindow(conf);
  const r = seededRand(`${gameId}|sungate|omen`)();
  return start + Math.floor(r * (end - start + 1));
}

/**
 * The omen tick to STORE, decided the first time a tick looks.
 *
 * A game that has not reached its roll keeps it. One that is already past
 * it — every long-running game on the day this ships — starts twelve
 * ticks from now rather than all at once and without warning.
 */
export function settleOmenTick(gameId, conf, tick) {
  const rolled = rollOmenTick(gameId, conf);
  return rolled >= tick ? rolled : tick + SUN_GATE_LATE_START_TICKS;
}

/** Which far system each gate leads to, in opening order. Random per game. */
export function gateOrder(gameId) {
  const flip = seededRand(`${gameId}|sungate|order`)() < 0.5;
  return flip ? [SUN_GATE_SYSTEMS[1], SUN_GATE_SYSTEMS[0]] : [...SUN_GATE_SYSTEMS];
}

/** Every gate's system and the tick it leaves the Sun. */
export function sunGatePlan(gameId, omenTick, conf) {
  const { interval } = sunGateWindow(conf);
  return gateOrder(gameId).map((sys, i) => ({
    index: i,
    sys,
    emergeTick: omenTick + SUN_GATE_WARNING_TICKS + i * interval,
  }));
}

// ---- the flight and where it stops ----------------------------------------

/** Ticks a gate takes to cover `distance` on an even 2g burn:
 *  T = 2 sqrt(d / a). About ten ticks from the Sun to the Far Reach on a
 *  live map. The client draws the same even burn (bodyPosition). */
export function emergeFlightTicks(distance) {
  const d = Math.max(1, Number(distance) || 0);
  return Math.max(1, Math.ceil(2 * Math.sqrt(d / (SUN_GATE_G * SUN_GATE_G_ANCHOR))));
}

/** The Far Reach on THIS board: from the innermost perihelion to the
 *  outermost aphelion of the worlds filed there. A map with none (an
 *  edited one) falls back to just past its farthest Sol world. */
export function farReachBand(bodies) {
  const sol = bodies.find(b => templateOf(b) === 'sol') ?? bodies.find(b => !b.parent_body_id);
  const members = bodies.filter(b =>
    FAR_REACH_TEMPLATES.has(templateOf(b)) && b.parent_body_id === sol?.id);
  if (members.length > 0) {
    const inner = Math.min(...members.map(b => Number(b.orbit_rp ?? b.orbit_radius) || 0));
    const outer = Math.max(...members.map(b => Number(b.orbit_ra ?? b.orbit_radius) || 0));
    if (outer > inner && inner > 0) return { inner, outer };
  }
  const solWorlds = bodies.filter(b => b.parent_body_id === sol?.id
    && !isFarSystemBody(b) && b.type !== 'megastructure');
  const far = Math.max(1000, ...solWorlds.map(b => Number(b.orbit_ra ?? b.orbit_radius) || 0));
  return { inner: far * 1.05, outer: far * 1.25 };
}

/**
 * The bearing a gate stops on, at radius `r`.
 *
 * Clear of every point in `avoid` by at least `minSep` when it can be,
 * else the bearing that gets furthest from them. With `oppositeOf` set
 * (the first gate's bearing at the moment this one lands) it stays in
 * the half of the sky across from it, give or take thirty degrees, so
 * whoever happened to be near the first gate is far from the second.
 */
export function pickBearing(rand, r, avoid, oppositeOf = null, minSep = 0) {
  let best = null;
  for (let i = 0; i < 48; i++) {
    const a = oppositeOf == null
      ? rand() * TWO_PI
      : oppositeOf + Math.PI + (rand() - 0.5) * (Math.PI / 3);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    let clear = Infinity;
    for (const p of avoid) clear = Math.min(clear, Math.hypot(p.x - x, p.y - y));
    if (clear >= minSep) return norm(a);
    if (!best || clear > best.clear) best = { a, clear };
  }
  return norm(best.a);
}

const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** angle0 that puts a circular orbit of `period` at `angle` on `tick`. */
export function angle0For(angle, period, tick) {
  const p = Number(period) || 0;
  return norm(angle - (p > 0 ? TWO_PI * tick * ORBITAL_SPEED_SCALE / p : 0));
}

// ---- the writes -------------------------------------------------------------

const BODY_COLS = `id, template_id, name, type, parent_body_id, radius, soi, mu,
  orbit_radius, orbit_period, angle0, orbit_rp, orbit_ra, orbit_omega, orbit_m0,
  obliterated_at_tick, emerge_from_tick, emerge_until_tick`;

export const solGateId = (gameId, sys) => `${gameId}:sungate_${sys.key}`;
export const farGateId = (gameId, sys) => `${gameId}:sungate_${sys.key}_far`;

/**
 * Stand up one gate pair. Idempotent: every row is INSERT OR IGNORE on an
 * id built from the game and the system, so a retried tick finds the pair
 * already there and changes nothing.
 *
 * Returns { arrival, landedNear } or null when the far system is not on
 * this board (far_systems was off when it was seeded).
 */
export async function spawnSunGatePair(env, gameId, sys, emergeTick, conf, otherGate = null) {
  const DB = env.DB;
  const bodies = (await DB
    .prepare(`SELECT ${BODY_COLS} FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`)
    .bind(gameId).all()).results ?? [];
  const sol = bodies.find(b => templateOf(b) === 'sol') ?? bodies.find(b => !b.parent_body_id);
  const bary = bodies.find(b => templateOf(b) === sys.barycenter);
  if (!sol || !bary) return null;

  const rand = seededRand(`${gameId}|sungate|${sys.key}`);
  const band = farReachBand(bodies);
  const r = band.inner + rand() * (band.outer - band.inner);
  const solR = Number(sol.radius) || 50;
  const arrival = emergeTick + emergeFlightTicks(r - solR);

  // Where everything else will be when it stops.
  const rm = makeRouteMath(DB, gameId);
  rm.preloadBodies(bodies);
  const solWorlds = bodies.filter(b => b.parent_body_id === sol.id
    && b.type !== 'megastructure' && !isFarSystemBody(b));
  const avoid = [];
  for (const b of solWorlds) avoid.push(await rm.bodyPosAt(b.id, arrival));
  let oppositeOf = null;
  if (otherGate && Number(otherGate.orbit_radius) > 0) {
    oppositeOf = orbitAngle(otherGate.angle0, otherGate.orbit_period, arrival);
    avoid.push({
      x: Math.cos(oppositeOf) * otherGate.orbit_radius,
      y: Math.sin(oppositeOf) * otherGate.orbit_radius,
    });
  }
  const bearing = pickBearing(rand, r, avoid, oppositeOf, r * 0.05);
  // A gate's year comes from the WORLDS around its parent. The barycenters
  // orbit Sol on a placeholder period of ~1e12 and the far suns on their
  // own tight binary, and averaged in they gave the first staging gates a
  // year of six hundred million ticks: a gate that never moved.
  const orbitPeers = bodies.filter(b => !(Number(b.orbit_period) >= 1e9)
    && b.type !== 'star' && b.type !== 'black_hole');
  const period = periodForRadius(sol, r, orbitPeers);
  const landed = { x: Math.cos(bearing) * r, y: Math.sin(bearing) * r };

  // The Sol world it stops nearest, for "out past Eris" in the news.
  let landedNear = null, nearD = Infinity;
  solWorlds.forEach((b, i) => {
    if (!isWorld(b) || b.type === 'star') return;
    const d = Math.hypot(avoid[i].x - landed.x, avoid[i].y - landed.y);
    if (d < nearD) { nearD = d; landedNear = b.name; }
  });

  // The far end: just past the outermost world of its system.
  // Worlds, not rocks: an eccentric meteoroid swinging out to twice the
  // last world's orbit would push the gate out with it.
  const farWorlds = bodies.filter(b => b.parent_body_id === bary.id
    && isWorld(b) && b.type !== 'star' && b.type !== 'black_hole');
  const outermost = Math.max(100, ...farWorlds.map(b => Number(b.orbit_ra ?? b.orbit_radius) || 0));
  const farR = outermost * FAR_GATE_RADIUS_MUL;
  const farPeriod = periodForRadius(bary, farR, orbitPeers);
  const farBearing = rand() * TWO_PI;

  const bodyScale = Number(conf?.body_scale) > 0 ? Number(conf.body_scale) : 1;
  const gateR = (MEGASTRUCTURES.warp_gate?.radius ?? 1.9) * bodyScale * SUN_GATE_SIZE_MUL;
  const a = solGateId(gameId, sys), b = farGateId(gameId, sys);

  const insBody = (id, tpl, name, parentId, orbitR, orbitP, ang0, color, from, until) => DB.prepare(
    `INSERT OR IGNORE INTO game_bodies
       (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
        orbit_radius, orbit_period, angle0, color, owner_faction_id,
        emerge_from_tick, emerge_until_tick)
     VALUES (?, ?, ?, ?, 'megastructure', ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(id, gameId, tpl, name, parentId, gateR, MEGA_MU, orbitR, orbitP, ang0, color, from, until);

  // hp explicit and full, for the reason spawnDiscoveredGatePair gives:
  // the column default is a fraction of MEGA_MAX_HP. Nothing ever damages
  // an ownerless, non-ancient structure, so this is where it stays.
  // completed_at_tick is the ARRIVAL: the gate is not open while it flies.
  const insMega = (id, partner) => DB.prepare(
    `INSERT OR IGNORE INTO game_megastructures
       (body_id, game_id, kind, status, acc_metal, acc_credits,
        cost_metal, cost_credits, founded_by_faction_id,
        founded_at_tick, completed_at_tick, hp, partner_body_id, transit_fraction)
     VALUES (?, ?, 'warp_gate', 'complete', 0, 0, 0, 0, NULL, ?, ?, ?, ?, ?)`,
  ).bind(id, gameId, emergeTick, arrival, MEGA_MAX_HP, partner, SUN_GATE_TRANSIT_FRACTION);

  await DB.batch([
    insBody(a, SUN_GATE_TEMPLATE, sys.solGate, sol.id, r, period,
      angle0For(bearing, period, arrival), '#ffc86b', emergeTick, arrival),
    // The far end appears when its partner lands: nobody is out there to
    // watch it arrive, and a door with no other side is no door.
    insBody(b, FAR_GATE_TEMPLATE, sys.farGate, bary.id, farR, farPeriod,
      farBearing, '#ffc86b', arrival, arrival),
    insMega(a, b),
    insMega(b, a),
  ]);

  // Everyone sees it, the rule ancient gates set: a structure that belongs
  // to nobody is a public landmark, not a sensor contact.
  const factions = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ?')
    .bind(gameId).all()).results ?? [];
  if (factions.length > 0) {
    await DB.batch(factions.flatMap(f => [a, b].map(gid => DB.prepare(
      `INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick)
       VALUES (?, ?, ?, ?)`,
    ).bind(gameId, f.id, gid, emergeTick))));
  }

  return { arrival, landedNear };
}

/** One public chronicle row, once. Returns true if THIS call wrote it. */
async function chronicleOnce(DB, id, gameId, tick, kind, bodyId, payload) {
  const res = await DB.prepare(
    `INSERT OR IGNORE INTO chronicle_entries
       (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'public', ?)`,
  ).bind(id, gameId, tick, kind, bodyId, JSON.stringify(payload), Date.now()).run();
  return Number(res?.meta?.changes ?? 0) > 0;
}

/** Tell every player in the game: phone, watch and Discord, one call each
 *  (notify.sendDm fans out), deduped on the event. */
async function tellEveryone(env, gameId, tick, dedupeKey, title, lines) {
  try {
    const notify = await import('./notify.js');
    const room = await env.DB.prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first();
    const users = (await env.DB.prepare(
      `SELECT DISTINCT user_id FROM game_factions WHERE game_id = ? AND user_id IS NOT NULL`,
    ).bind(gameId).all()).results ?? [];
    for (const u of users) {
      await notify.sendDm(env, {
        userId: u.user_id,
        gameId,
        category: 'galactic',
        dedupeKey: `sungate:${gameId}:${dedupeKey}`,
        embed: {
          title,
          description: lines.join('\n'),
          color: 0xffc86b,
          footer: { text: `Orbital · ${room?.name ?? gameId} · T+${tick}` },
        },
      });
    }
  } catch (e) {
    console.error('sun gate notification failed', e);
  }
}

/**
 * Advance the event for one game at one tick. Safe to call every tick.
 *
 * Costs one read per tick before the omen and after the last gate is
 * open; a handful while the event is running.
 */
export async function advanceSunGates(env, gameId, tick, conf) {
  if (Number(conf?.far_systems) !== 1) return { stage: 'off' };
  const DB = env.DB;

  const g = await DB.prepare('SELECT sun_gate_tick FROM games WHERE id = ?').bind(gameId).first();
  if (!g) return { stage: 'no_game' };
  let omen = g.sun_gate_tick == null ? null : Number(g.sun_gate_tick);
  if (omen == null) {
    await DB.prepare('UPDATE games SET sun_gate_tick = ? WHERE id = ? AND sun_gate_tick IS NULL')
      .bind(settleOmenTick(gameId, conf, tick), gameId).run();
    const again = await DB.prepare('SELECT sun_gate_tick FROM games WHERE id = ?').bind(gameId).first();
    omen = Number(again?.sun_gate_tick);
  }
  if (!Number.isFinite(omen) || tick < omen) return { stage: 'waiting', omen };

  const plan = sunGatePlan(gameId, omen, conf);
  const last = plan[plan.length - 1];
  // Done for good once the last gate could only have landed long ago.
  if (tick > last.emergeTick + 200) return { stage: 'done', omen };

  const solId = `${gameId}:sol`;
  if (await chronicleOnce(DB, `${gameId}:sungate:omen`, gameId, tick, 'sun_gate_omen', solId,
    { gate_in: SUN_GATE_WARNING_TICKS })) {
    await tellEveryone(env, gameId, tick, 'omen',
      '☀ Something strange is emerging from the Sun',
      [`Every observatory in the system has turned to the Sun. Whatever it is, it will be out in **${SUN_GATE_WARNING_TICKS} ticks**.`]);
  }

  let prior = null;
  for (const step of plan) {
    if (tick < step.emergeTick) break;
    const id = solGateId(gameId, step.sys);
    let row = await DB.prepare(
      `SELECT id, name, orbit_radius, orbit_period, angle0, emerge_until_tick
         FROM game_bodies WHERE id = ?`,
    ).bind(id).first();
    if (!row) {
      const made = await spawnSunGatePair(env, gameId, step.sys, step.emergeTick, conf, prior);
      if (!made) return { stage: 'no_far_systems', omen };
      row = await DB.prepare(
        `SELECT id, name, orbit_radius, orbit_period, angle0, emerge_until_tick
           FROM game_bodies WHERE id = ?`,
      ).bind(id).first();
      if (await chronicleOnce(DB, `${gameId}:sungate:emerged:${step.sys.key}`, gameId, tick,
        'sun_gate_emerged', id,
        { gate: step.sys.solGate, system: step.sys.label, arrive_tick: made.arrival,
          near: made.landedNear, index: step.index })) {
        await tellEveryone(env, gameId, tick, `emerged:${step.sys.key}`,
          step.index === 0 ? '◎ A gate has come out of the Sun' : '◎ Another gate has come out of the Sun',
          [`It is burning hard for the Far Reach and will stop${made.landedNear ? ` out past **${made.landedNear}**` : ''} at tick **${made.arrival}**.`,
            `It leads to **${step.sys.label}**.`]);
      }
    }
    const arrival = Number(row?.emerge_until_tick);
    if (Number.isFinite(arrival) && tick >= arrival) {
      if (await chronicleOnce(DB, `${gameId}:sungate:open:${step.sys.key}`, gameId, tick,
        'sun_gate_opened', id,
        { gate: step.sys.solGate, system: step.sys.label, index: step.index })) {
        await tellEveryone(env, gameId, tick, `open:${step.sys.key}`,
          `◎ The ${step.sys.solGate} is open`,
          [`It has stopped in the Far Reach. Park a ship on it and launch to **${step.sys.label}** at a tenth of the normal burn.`]);
      }
    }
    prior = row;
  }
  return { stage: 'running', omen };
}
