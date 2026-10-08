// ============================================================
// THE LEVIATHAN — the second sun gate, carried in on a monster.
//
// Lorne, 2026-10-07: "Everyone was very excited and thought they were
// going to get to fight a kaiju, and there's some disappointment it was
// just a gate. So... what if the next gate IS a Kaiju squid?"
//
//   - It launches from the far system that is not yet connected and
//     burns for Sol at 2g, announced in the log. (sunGates.js decides
//     when and where; this file is the beast.)
//   - Where it stops it leaves the gate.
//   - Then it hunts terrestrial worlds, dwarfs and moons one at a time,
//     always further in than it is, chosen at random (pickPrey): it
//     starts in the outer system and works down the well. Each one it
//     double-taps like a Mega Destroyer: a living world is stripped,
//     then broken; a raw one is broken. Every strike winds up for the
//     Mega Destroyer's whole charge, and it has to sit there to fire.
//   - NEVER A HOMEWORLD (Lorne's pick): it cannot wipe out an empire.
//   - It leaves after it has eaten its fill (kaiju_appetite worlds),
//     back to its gate and through it.
//   - "Something absurd like 20,000 HP and 50 damage at frigate level
//     speeds, despite being visibly huge" -- SHIP_COMBAT_STATS.kaiju. The
//     HP is SCALED to the game at launch (Lorne's pick): every armed hull
//     in the game, hitting at its real odds, kills it in kaiju_hp_ticks
//     (one wind-up). Floor and cap from the host's dials; 20,000 at most.
//   - Killed, it leaves its carcass where it died: a salvage field any
//     freighter with a mining rig can work (a meteoroid body).
//
// WHAT IT IS, MECHANICALLY. An ordinary hull (class 'kaiju') owned by an
// ordinary faction row with status 'monster'. Every "active empires"
// query already leaves that status out (victory, the senate, elimination,
// research, standings), wars.js pairs it with every faction as at war,
// and diplomacy refuses it. Combat, transit combat, station guns, rams
// and detonators all just work on it, because it is a hull.
//
// Its movement is planLegForShip (room.js), the same planner trade
// routes use, handed in as a hook; its strikes are resolveMegaStrikes,
// which fires any hull carrying a charge. So this file only DECIDES.
// One read per tick in a game that has one, none in a game that does not.
// ============================================================

import { SHIP_COMBAT_STATS } from './factions.js';
import { shipSpeed, hitChance } from './shipDesigns.js';
import { MEGA_STRIKE_CHARGE_TICKS } from './actions.js';
import { makeRouteMath } from './routeMath.js';
import { legTicks, SHIP_ENGINE_ACCEL, MAX_ENGINE_G } from './burn.js';
import {
  emergeFlightTicks, solGateId, chronicleOnce, tellEveryone, mainSystemSql, SUN_GATE_SYSTEMS, seededRand,
} from './sunGates.js';
import { tr } from './i18n.js';

/** The beast and its owner. One per game. */
export const kaijuShipId = (gameId) => `${gameId}:leviathan`;
export const kaijuFactionId = (gameId) => `${gameId}:leviathan_f`;
export const kaijuCarcassId = (gameId) => `${gameId}:leviathan_carcass`;
export const KAIJU_NAME = 'Leviathan';
export const KAIJU_FACTION_NAME = 'The Leviathan';
/** Its colour on the map and in the log: deep-sea violet, nobody's. */
export const KAIJU_COLOR = '#b44dff';
const FEED_COLOR = 0xb44dff;
/** A faction slot no player seat can ever take. */
const KAIJU_SLOT = 900;

/** What it eats, and what it never touches. */
export const KAIJU_PREY_TYPES = new Set(['terrestrial', 'dwarf', 'moon']);

/** Host dials (configSchema.js), repaired. */
export function kaijuDials(conf) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const cap = Math.max(100, num(conf?.kaiju_hp_max, SHIP_COMBAT_STATS.kaiju.hp));
  return {
    on: Number(conf?.kaiju) === 1,
    appetite: Math.max(1, Math.round(num(conf?.kaiju_appetite, 5))),
    hpTicks: Math.max(1, num(conf?.kaiju_hp_ticks, 24)),
    hpMin: Math.min(cap, Math.max(100, num(conf?.kaiju_hp_min, 2000))),
    hpMax: cap,
    damage: Math.max(0, num(conf?.kaiju_damage, SHIP_COMBAT_STATS.kaiju.damage_per_tick)),
    // Top push between worlds, in g (huntTicks).
    huntG: Math.min(5, Math.max(0.05, num(conf?.kaiju_hunt_g, 0.5))),
  };
}

/**
 * THE HP ROLL. Every armed hull in the game, all empires at once, each
 * hitting at its real odds against the beast's speed: the damage they
 * would land in a tick, times `hpTicks`, clamped to the host's floor and
 * cap and rounded to the hundred. A ship list in, a number out, so the
 * sim can hold it to the table Lorne picked from.
 */
export function kaijuHp(ships, dials) {
  const def = SHIP_COMBAT_STATS.kaiju.speed;
  let perTick = 0;
  for (const s of ships) {
    const dmg = Number(s.damage_per_tick) || 0;
    if (!(dmg > 0)) continue;
    let parts = [];
    try { parts = s.parts_json ? JSON.parse(s.parts_json) : []; } catch { parts = []; }
    perTick += dmg * hitChance(shipSpeed(s.ship_class, parts), def);
  }
  const raw = Math.round((perTick * dials.hpTicks) / 100) * 100;
  return { hp: Math.max(dials.hpMin, Math.min(dials.hpMax, raw)), perTick };
}

/**
 * WHAT IT GOES FOR NEXT. Pure, so the order is testable.
 *
 * Lorne, 2026-10-08: "try and eat 5 worlds, starting in the outer system
 * and then choosing worlds down the well at random."
 *
 * `worlds`: candidate rows with { id, r } already filtered to living
 * prey in the main system that is nobody's homeworld, `r` being its
 * distance from the Sun now. `fromR`: the beast's own distance. `left`:
 * meals still to go. `rand`: a seeded 0..1.
 *
 * Only worlds further in than it is now: it always goes down the well.
 * Of those, the outermost 1/left of them, and one of THOSE at random. So
 * the first of five comes from the outer fifth of the map, and the
 * descent is spread across the whole appetite instead of diving for the
 * Sun on the first meal; the last meal can be anywhere further in.
 */
export function pickPrey(worlds, fromR, left, rand) {
  const inward = worlds.filter(w => w.r < fromR).sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : 1));
  if (inward.length === 0) return null;
  const band = inward.slice(0, Math.max(1, Math.ceil(inward.length / Math.max(1, left))));
  return band[Math.min(band.length - 1, Math.floor(rand() * band.length))];
}

/** Bodies a carcass can orbit. Anything else (the gate, a landing site,
 *  deep space) and it drifts around the Sun at that distance instead. */
const CARCASS_HOSTS = new Set(['terrestrial', 'dwarf', 'moon', 'gas-giant', 'ice-giant', 'asteroid']);

/** The rows in game_kaiju, or null. */
async function loadKaiju(DB, gameId) {
  return DB.prepare('SELECT * FROM game_kaiju WHERE game_id = ?').bind(gameId).first();
}

/** Users who hold a seat in the game (for owner-only alerts). */
async function ownersOf(DB, gameId, factionIds) {
  const ids = [...new Set(factionIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = (await DB
    .prepare(`SELECT user_id FROM game_factions
               WHERE game_id = ? AND user_id IS NOT NULL
                 AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(gameId, ...ids).all()).results ?? [];
  return rows.map(r => r.user_id);
}

/**
 * LAUNCH. Called by sunGates.js on the tick the second gate would have
 * left the Sun. Makes the owner, the hull and its leg to the landing
 * site, and writes the game_kaiju row. Idempotent: every id is fixed per
 * game, and a retried tick finds the row and does nothing.
 */
export async function launchKaiju(env, gameId, tick, { sys, arrival, fromBodyId, landedNear, targetId = null }, conf, hooks) {
  const DB = env.DB;
  if (await loadKaiju(DB, gameId)) return null;
  const dials = kaijuDials(conf);

  const ships = (await DB
    .prepare(`SELECT s.ship_class, s.damage_per_tick, s.parts_json
                FROM game_ships s
                JOIN game_factions f ON f.id = s.owner_faction_id
               WHERE s.game_id = ? AND s.status = 'active' AND s.damage_per_tick > 0
                 AND f.status <> 'monster'`)
    .bind(gameId).all()).results ?? [];
  const { hp, perTick } = kaijuHp(ships, dials);

  const fid = kaijuFactionId(gameId), sid = kaijuShipId(gameId);
  // Where it is going: the landing site of the gate it carries, or (a
  // launch into a game whose gates are already open) that gate itself.
  const site = targetId ?? `${gameId}:sungate_${sys.key}_site`;
  const carried = !targetId;
  await DB.batch([
    // user_id NULL, status 'monster': no seat, no vote, no victory, no
    // research, and every "active empires" query passes it by.
    DB.prepare(
      `INSERT OR IGNORE INTO game_factions
         (id, game_id, user_id, slot, name, color, status, joined_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'monster', ?)`,
    ).bind(fid, gameId, KAIJU_SLOT, KAIJU_FACTION_NAME, KAIJU_COLOR, Date.now()),
    DB.prepare(
      `INSERT OR IGNORE INTO game_ships
         (id, game_id, owner_faction_id, name, ship_class,
          parent_body_id, orbit_rp, orbit_ra, orbit_omega,
          orbit_m0, orbit_epoch, orbit_direction,
          fuel, fuel_max, status, built_at_tick,
          hp, hp_max, damage_per_tick, stance)
       VALUES (?, ?, ?, ?, 'kaiju', ?, 6, 6, 0, 0, ?, 1, 0, 0, 'active', ?, ?, ?, ?, 'attack')`,
    ).bind(sid, gameId, fid, KAIJU_NAME, fromBodyId, tick, tick, hp, hp, dials.damage),
  ]);
  // Its leg, once: a retried launch finds the one already planned.
  const planned = await DB
    .prepare(`SELECT 1 AS x FROM game_ship_nodes
               WHERE ship_id = ? AND status IN ('planned', 'committed', 'in_transit') LIMIT 1`)
    .bind(sid).first();
  if (!planned) await hooks.planLeg(sid, fid, fromBodyId, site, arrival);
  // THE ROW GOES IN LAST. It is what makes the tick start steering the
  // beast (advanceKaiju), and a beast it can see with no leg yet is one it
  // "relaunches": a launch from outside the tick (scripts/launch-kaiju.mjs,
  // seconds between writes) raced the live tick exactly that way on
  // staging and flew with two legs.
  await DB.prepare(
    `INSERT OR IGNORE INTO game_kaiju
       (game_id, ship_id, faction_id, sys_key, launched_at_tick, arrive_tick,
        hp_max, appetite, phase, target_body_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inbound', ?)`,
  ).bind(gameId, sid, fid, sys.key, tick, arrival, hp, dials.appetite, site).run();

  if (await chronicleOnce(DB, `${gameId}:kaiju:launched`, gameId, tick, 'kaiju_launched', site,
    { system: sys.label, arrive_tick: arrival, near: landedNear ?? null, hp,
      fleet_per_tick: Math.round(perTick), appetite: dials.appetite, carried })) {
    await tellEveryone(env, gameId, tick, 'kaiju:launched', (L) => ({
      title: tr(L, 'feed.kaiju.launchedTitle', { system: sys.label }),
      lines: [
        landedNear
          ? tr(L, 'feed.kaiju.launchedNear', { near: landedNear, tick: arrival })
          : tr(L, 'feed.kaiju.launchedAt', { tick: arrival }),
        tr(L, carried ? 'feed.kaiju.launchedHunt' : 'feed.kaiju.launchedHuntGate',
          { hp: hp.toLocaleString('en-US'), n: dials.appetite }),
      ],
    }), { color: FEED_COLOR });
  }
  return { hp, arrival };
}

/**
 * LAUNCH IT NOW, into a game whose sun gates are already open (a host
 * tool: scripts/launch-kaiju.mjs). Nothing to carry, so it burns at 2g
 * from its far system straight for that system's Sol gate, and hunts
 * from there. `sysKey` picks the system; otherwise the first with an
 * open gate. Refuses a game that has already had one.
 */
export async function launchKaijuNow(env, gameId, tick, conf, hooks, { sysKey = null } = {}) {
  const DB = env.DB;
  if (await loadKaiju(DB, gameId)) return { error: 'already_had_one' };
  for (const sys of SUN_GATE_SYSTEMS.filter(s => !sysKey || s.key === sysKey)) {
    const gate = await DB
      .prepare(`SELECT b.id, b.name FROM game_bodies b
                  JOIN game_megastructures m ON m.body_id = b.id
                 WHERE b.id = ? AND b.destroyed_at_tick IS NULL AND m.status = 'complete'
                   AND (b.emerge_until_tick IS NULL OR b.emerge_until_tick <= ?)`)
      .bind(solGateId(gameId, sys), tick).first();
    if (!gate) continue;
    const fromBodyId = `${gameId}:${sys.barycenter}`;
    const T = await flightTo(makeRouteMath(DB, gameId), fromBodyId, gate.id, tick);
    const made = await launchKaiju(env, gameId, tick,
      { sys, arrival: tick + T, fromBodyId, landedNear: null, targetId: gate.id }, conf, hooks);
    return made ? { ...made, system: sys.label, gate: gate.name } : { error: 'already_had_one' };
  }
  return { error: 'no_open_gate' };
}

/** Its omen, SUN_GATE_WARNING_TICKS before launch (sunGates.js). */
export async function kaijuOmen(env, gameId, tick, sys, wait) {
  if (await chronicleOnce(env.DB, `${gameId}:kaiju:omen`, gameId, tick, 'kaiju_omen', null,
    { system: sys.label, launch_in: wait })) {
    await tellEveryone(env, gameId, tick, 'kaiju:omen', (L) => ({
      title: tr(L, 'feed.kaiju.omenTitle', { system: sys.label }),
      lines: [tr(L, 'feed.kaiju.omenBody', { system: sys.label, n: wait })],
    }), { color: FEED_COLOR });
  }
}

/**
 * Every live prey world in the main system, with where it is now.
 * Never a capital, never rubble, never a far-system world.
 */
async function preyWorlds(DB, gameId, tick, rm) {
  const main = mainSystemSql('b.template_id');
  const rows = (await DB
    .prepare(
      `SELECT b.id, b.name, b.type, b.parent_body_id, b.owner_faction_id,
              b.terraformed_at_tick,
              EXISTS (SELECT 1 FROM game_settlements st
                       WHERE st.game_id = b.game_id AND st.body_id = b.id
                         AND st.destroyed_at_tick IS NULL) AS settled
         FROM game_bodies b
        WHERE b.game_id = ? AND b.destroyed_at_tick IS NULL
          AND b.obliterated_at_tick IS NULL
          AND b.type IN ('terrestrial', 'dwarf', 'moon')
          AND (b.emerge_from_tick IS NULL OR b.emerge_from_tick <= ?)
          AND ${main.sql}
          AND NOT EXISTS (SELECT 1 FROM game_factions f
                           WHERE f.game_id = b.game_id AND f.capital_body_id = b.id
                             AND f.status <> 'monster')`,
    )
    .bind(gameId, tick, ...main.binds).all()).results ?? [];
  const out = [];
  for (const r of rows) {
    const p = await rm.bodyPosAt(r.id, tick);
    out.push({ ...r, settled: Number(r.settled) === 1, x: p.x, y: p.y, r: Math.hypot(p.x, p.y) });
  }
  return out;
}

/** Ticks for the beast to fly from `fromId` (now) to `toId`, at 2g. */
async function flightTo(rm, fromId, toId, tick, huntG = null) {
  const a = await rm.bodyPosAt(fromId, tick);
  const ticksFor = (d) => (huntG ? huntTicks(d, huntG) : emergeFlightTicks(d));
  let T = ticksFor(1);
  for (let i = 0; i < 3; i++) {
    const b = await rm.bodyPosAt(toId, tick + T);
    T = ticksFor(Math.hypot(b.x - a.x, b.y - a.y));
  }
  return T;
}

/**
 * IN THE SYSTEM IT IS CATCHABLE (Lorne, 2026-10-08: "It can get up to 2g
 * on the way to Sol, but we should cap its acceleration at probably .5g
 * in system so it's POSSIBLE to intercept it"). Between worlds it flies
 * the ships' own burn (burn.js: a build that grows from launch, a 9x
 * brake), every acceleration scaled so the push tops out at `g` instead
 * of a hull's MAX_ENGINE_G. Scaling every acceleration by s is the same
 * trip as a hull flying d/s, so: the hull's ticks over d * MAX / g. At
 * 0.5g that is a bit over half a warship's time on any hop; the planner
 * (planLegForShip -> shapeForArrival) then draws exactly that shape.
 * The crossing from its own star stays the 2g even burn.
 */
export function huntTicks(d, g) {
  return Math.max(1, Math.ceil(legTicks(Math.max(1, d) * (MAX_ENGINE_G / g), SHIP_ENGINE_ACCEL)));
}

/**
 * Advance the beast for one tick. Runs after the strikes resolve
 * (room.js 2d-ter), so a world it just broke is already rubble here.
 */
export async function advanceKaiju(env, gameId, tick, conf, hooks) {
  const dials = kaijuDials(conf);
  const DB = env.DB;
  const k = await loadKaiju(DB, gameId);
  if (!k || k.phase === 'dead' || k.phase === 'gone') return { phase: k?.phase ?? 'none' };

  const ship = await DB
    .prepare(`SELECT id, status, parent_body_id, hp, strike_ready_tick, strike_target_body_id
                FROM game_ships WHERE id = ?`)
    .bind(k.ship_id).first();
  if (!ship) return { phase: 'missing' };

  // ---- dead ---------------------------------------------------------
  if (ship.status !== 'active') {
    if (ship.status === 'destroyed') return die(env, gameId, tick, k, ship);
    return { phase: k.phase };
  }

  const flying = await DB
    .prepare(`SELECT 1 AS x FROM game_ship_nodes
               WHERE ship_id = ? AND status IN ('planned', 'committed', 'in_transit') LIMIT 1`)
    .bind(ship.id).first();
  if (flying) return { phase: k.phase, flying: true };

  const sys = { key: k.sys_key };
  const gateId = solGateId(gameId, sys);

  // ---- gone ---------------------------------------------------------
  if (k.phase === 'leaving') {
    if (ship.parent_body_id !== gateId) {
      // Knocked off its course somehow; head for the gate again.
      const rm = makeRouteMath(DB, gameId);
      await hooks.planLeg(ship.id, k.faction_id, ship.parent_body_id, gateId,
        tick + await flightTo(rm, ship.parent_body_id, gateId, tick, dials.huntG));
      return { phase: 'leaving' };
    }
    // Through it. 'departed' is not 'active', so every live query lets
    // it go; the row stays, so the record of it does.
    await DB.batch([
      DB.prepare(`UPDATE game_ships SET status = 'departed', strike_target_body_id = NULL,
                         strike_ready_tick = NULL, strike_mode = NULL WHERE id = ?`).bind(ship.id),
      DB.prepare(`UPDATE game_kaiju SET phase = 'gone', gone_at_tick = ?, target_body_id = NULL
                   WHERE game_id = ?`).bind(tick, gameId),
    ]);
    const eaten = parseEaten(k);
    const gate = await DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(gateId).first();
    if (await chronicleOnce(DB, `${gameId}:kaiju:gone`, gameId, tick, 'kaiju_gone', gateId,
      { gate: gate?.name ?? null, eaten })) {
      await tellEveryone(env, gameId, tick, 'kaiju:gone', (L) => ({
        title: tr(L, 'feed.kaiju.goneTitle'),
        lines: [tr(L, 'feed.kaiju.goneBody', { gate: gate?.name ?? '' })],
      }), { color: FEED_COLOR });
    }
    return { phase: 'gone' };
  }

  // ---- arrived ------------------------------------------------------
  if (k.phase === 'inbound') {
    const site = `${gameId}:sungate_${k.sys_key}_site`;
    if (ship.parent_body_id !== site && ship.parent_body_id !== gateId) {
      // Not flying and not at the door: the launch leg never went in.
      // Fly now, landing no earlier than the gate does.
      const rm = makeRouteMath(DB, gameId);
      const to = tick < Number(k.arrive_tick) ? site : gateId;
      const T = await flightTo(rm, ship.parent_body_id, to, tick);
      await hooks.planLeg(ship.id, k.faction_id, ship.parent_body_id, to,
        Math.max(Number(k.arrive_tick), tick + T));
      return { phase: 'inbound', relaunched: true };
    }
    if (tick < Number(k.arrive_tick)) return { phase: 'inbound' };
    await DB.prepare(`UPDATE game_kaiju SET phase = 'hunting', target_body_id = NULL WHERE game_id = ?`)
      .bind(gameId).run();
    k.phase = 'hunting';
    k.target_body_id = null;
    k._arrived = true;
  }

  // ---- hunting ------------------------------------------------------
  if (ship.strike_ready_tick != null) return { phase: 'hunting', charging: true };

  const rm = makeRouteMath(DB, gameId);
  const here = ship.parent_body_id;

  // Did the last strike finish a world? Counted when it is rubble.
  if (k.target_body_id && k.target_body_id === here) {
    const t = await DB
      .prepare(`SELECT id, name, terraformed_at_tick, obliterated_at_tick, owner_faction_id
                  FROM game_bodies WHERE id = ? AND destroyed_at_tick IS NULL`)
      .bind(here).first();
    if (t && t.obliterated_at_tick != null) {
      const eaten = [...parseEaten(k), t.name];
      await DB.prepare(`UPDATE game_kaiju SET eaten = ?, eaten_json = ?, target_body_id = NULL
                         WHERE game_id = ?`)
        .bind(eaten.length, JSON.stringify(eaten), gameId).run();
      k.eaten = eaten.length; k.eaten_json = JSON.stringify(eaten); k.target_body_id = null;
    } else if (t) {
      // Still standing at the target: wind up (again, for a world it has
      // just stripped -- the second barrel of the double tap).
      const capital = await DB
        .prepare(`SELECT 1 AS x FROM game_factions WHERE game_id = ? AND capital_body_id = ?
                    AND status <> 'monster' LIMIT 1`)
        .bind(gameId, here).first();
      if (!capital) return arm(env, gameId, tick, k, ship, t);
      // It became someone's capital while the beast flew: let it be.
      await DB.prepare('UPDATE game_kaiju SET target_body_id = NULL WHERE game_id = ?').bind(gameId).run();
      k.target_body_id = null;
    }
  }

  // Full: go home.
  if (Number(k.eaten) >= Number(k.appetite)) return leave(env, gameId, tick, k, ship, rm, gateId, 'full', hooks, dials.huntG);

  // Next.
  const worlds = await preyWorlds(DB, gameId, tick, rm);
  const from = await rm.bodyPosAt(here, tick);
  // Seeded on the game and the meal, so a retried tick picks the same.
  const prey = pickPrey(worlds, Math.hypot(from.x, from.y),
    Number(k.appetite) - Number(k.eaten), seededRand(`${gameId}|kaiju|meal|${Number(k.eaten)}`));
  if (!prey) return leave(env, gameId, tick, k, ship, rm, gateId, 'nothing_left', hooks, dials.huntG);

  if (prey.id === here) {
    await DB.prepare('UPDATE game_kaiju SET target_body_id = ? WHERE game_id = ?').bind(prey.id, gameId).run();
    k.target_body_id = prey.id;
    return arm(env, gameId, tick, k, ship, prey);
  }
  const T = await flightTo(rm, here, prey.id, tick, dials.huntG);
  await hooks.planLeg(ship.id, k.faction_id, here, prey.id, tick + T);
  await DB.prepare('UPDATE game_kaiju SET target_body_id = ? WHERE game_id = ?').bind(prey.id, gameId).run();

  const owners = await ownersOf(DB, gameId, [prey.owner_faction_id,
    ...((await DB.prepare(`SELECT DISTINCT owner_faction_id AS f FROM game_settlements
                            WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NULL`)
      .bind(gameId, prey.id).all()).results ?? []).map(r => r.f)]);
  const n = Number(k.eaten) + 1;
  const gate = k._arrived
    ? await DB.prepare('SELECT name, emerge_from_tick FROM game_bodies WHERE id = ?').bind(gateId).first() : null;
  // It carried the gate in if the gate appeared the tick it landed.
  const carried = !!gate && Number(gate.emerge_from_tick) === Number(k.arrive_tick);
  if (await chronicleOnce(DB, `${gameId}:kaiju:hunt:${prey.id}`, gameId, tick, 'kaiju_hunting', prey.id,
    { world: prey.name, body_name: prey.name, arrive_tick: tick + T, settled: prey.settled,
      first: !!k._arrived, nth: n,
      ...(k._arrived ? {
        gate: gate?.name ?? null, carried,
        system: SUN_GATE_SYSTEMS.find(x => x.key === k.sys_key)?.label ?? null,
      } : {}) })) {
    if (k._arrived) {
      // The arrival: the gate is down and the hunt begins, to everyone.
      await tellEveryone(env, gameId, tick, 'kaiju:arrived', (L) => ({
        title: tr(L, 'feed.kaiju.arrivedTitle'),
        lines: [
          tr(L, carried ? 'feed.kaiju.arrivedGate' : 'feed.kaiju.arrivedPast', { gate: gate?.name ?? '' }),
          tr(L, 'feed.kaiju.arrivedPrey', { world: prey.name, tick: tick + T }),
        ],
      }), { color: FEED_COLOR });
    } else if (owners.length > 0) {
      // Later hunts: the people about to lose a world, by name.
      await tellEveryone(env, gameId, tick, `kaiju:hunt:${prey.id}`, (L) => ({
        title: tr(L, 'feed.kaiju.huntTitle', { world: prey.name }),
        lines: [tr(L, 'feed.kaiju.huntBody', { world: prey.name, tick: tick + T })],
      }), { color: FEED_COLOR, only: owners, feed: false });
    }
  }
  return { phase: 'hunting', target: prey.id, arrive: tick + T };
}

function parseEaten(k) {
  try { const a = JSON.parse(k.eaten_json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** Wind up over the world it is sitting on (resolveMegaStrikes fires it). */
async function arm(env, gameId, tick, k, ship, world) {
  const DB = env.DB;
  // TWO STRIKES, EVERY WORLD (Lorne, 2026-10-08: "The first fire should
  // wipe out terraforming, the second fire should destroy it ... two days
  // to murder a planet fully"). The first scorches it: terraforming gone,
  // every settlement gone, living or raw. The second, once it has scorched
  // this world on this visit, breaks it.
  const now = await DB.prepare('SELECT terraformed_at_tick, sterilised_at_tick FROM game_bodies WHERE id = ?')
    .bind(world.id).first();
  const scorched = now?.terraformed_at_tick == null && now?.sterilised_at_tick != null
    && Number(now.sterilised_at_tick) >= Number(k.launched_at_tick);
  const mode = scorched ? 'obliterate' : 'sterilise';
  const raw = now?.terraformed_at_tick == null;
  const fires = tick + MEGA_STRIKE_CHARGE_TICKS;
  await DB.prepare(`UPDATE game_ships SET strike_target_body_id = ?, strike_ready_tick = ?, strike_mode = ?
                     WHERE id = ?`)
    .bind(world.id, fires, mode, ship.id).run();
  const owners = await ownersOf(DB, gameId, [world.owner_faction_id,
    ...((await DB.prepare(`SELECT DISTINCT owner_faction_id AS f FROM game_settlements
                            WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NULL`)
      .bind(gameId, world.id).all()).results ?? []).map(r => r.f)]);
  if (await chronicleOnce(DB, `${gameId}:kaiju:charge:${world.id}:${mode}`, gameId, tick, 'kaiju_charging',
    world.id, { world: world.name, body_name: world.name, fires_at_tick: fires, mode,
      ...(mode === 'sterilise' && raw ? { raw: true } : {}) })) {
    if (owners.length > 0) {
      await tellEveryone(env, gameId, tick, `kaiju:charge:${world.id}:${mode}`, (L) => ({
        title: tr(L, 'feed.kaiju.chargeTitle', { world: world.name }),
        lines: [tr(L, mode === 'obliterate' ? 'feed.kaiju.chargeObliterate'
          : raw ? 'feed.kaiju.chargeScour' : 'feed.kaiju.chargeSterilise',
          { world: world.name, tick: fires })],
      }), { color: FEED_COLOR, only: owners, feed: false });
    }
  }
  return { phase: 'hunting', charging: true, mode, fires };
}

/** Full, or nothing left it may eat: back to the gate. */
async function leave(env, gameId, tick, k, ship, rm, gateId, why, hooks, huntG) {
  const DB = env.DB;
  await DB.prepare(`UPDATE game_kaiju SET phase = 'leaving', target_body_id = ? WHERE game_id = ?`)
    .bind(gateId, gameId).run();
  if (ship.parent_body_id !== gateId) {
    const T = await flightTo(rm, ship.parent_body_id, gateId, tick, huntG);
    await hooks.planLeg(ship.id, k.faction_id, ship.parent_body_id, gateId, tick + T);
  }
  const eaten = parseEaten(k);
  const gate = await DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(gateId).first();
  if (await chronicleOnce(DB, `${gameId}:kaiju:leaving`, gameId, tick, 'kaiju_leaving', gateId,
    { gate: gate?.name ?? null, eaten, why })) {
    await tellEveryone(env, gameId, tick, 'kaiju:leaving', (L) => ({
      title: tr(L, why === 'full' ? 'feed.kaiju.fullTitle' : 'feed.kaiju.starvedTitle'),
      lines: [tr(L, 'feed.kaiju.leavingBody', {
        n: eaten.length, worlds: eaten.join(', ') || '—', gate: gate?.name ?? '',
      })],
    }), { color: FEED_COLOR });
  }
  return { phase: 'leaving', why };
}

/**
 * DEAD. The carcass stays where it died as a salvage field: a meteoroid
 * body around that world (or around the Sun, where it died out in the
 * open), metal enough to be worth a fleet's time -- half its HP in tons.
 */
async function die(env, gameId, tick, k, ship) {
  const DB = env.DB;
  const where = await DB
    .prepare(`SELECT id, name, type, parent_body_id, radius, mu, orbit_radius
                FROM game_bodies WHERE id = ?`)
    .bind(ship.parent_body_id).first();
  const killedBy = await DB
    .prepare(`SELECT payload FROM chronicle_entries
               WHERE game_id = ? AND kind = 'ship_destroyed' AND ship_id = ?
               ORDER BY tick_number DESC LIMIT 1`)
    .bind(gameId, ship.id).first();
  let killer = {};
  try { killer = JSON.parse(killedBy?.payload || '{}'); } catch { killer = {}; }

  const tons = Math.max(500, Math.round((Number(k.hp_max) * 0.5) / 25) * 25);
  const world = !!where && CARCASS_HOSTS.has(where.type);
  const parentId = world ? where.id : `${gameId}:sol`;
  const parentRow = world ? where : await DB
    .prepare('SELECT id, radius, mu FROM game_bodies WHERE id = ?').bind(parentId).first();
  // Around a world: a tight orbit just outside its park ring. In the open
  // (the gate, the landing site): the Sun, at that distance.
  const pr = Number(parentRow?.radius) || 4;
  const orbitR = world ? Math.max(pr * 3, pr + 6) : Math.max(1000, Number(where?.orbit_radius) || 1000);
  const mu = Number(parentRow?.mu) > 0 ? Number(parentRow.mu) : 6003;
  const period = 2 * Math.PI * Math.sqrt(Math.pow(orbitR, 3) / mu);
  const angle0 = (tick * 2.399963) % (2 * Math.PI);
  const cid = kaijuCarcassId(gameId);

  await DB.batch([
    DB.prepare(
      `INSERT OR IGNORE INTO game_bodies
         (id, game_id, template_id, name, type, parent_body_id,
          radius, soi, mu, orbit_radius, orbit_period, angle0, color,
          yield_metal, yield_fuel, yield_gold, yield_science,
          owner_faction_id, development_level, fortification_level, shipyard_level,
          mineral_kind, mineral_initial, mineral_remaining)
       VALUES (?, ?, 'leviathan_carcass', ?, 'meteoroid', ?,
               0.6, 0, 0, ?, ?, ?, '#7a4a8c',
               0, 0, 0, 0,
               NULL, 0, 0, 0,
               'metal', ?, ?)`,
    ).bind(cid, gameId, 'Leviathan Carcass', parentId, orbitR, period, angle0, tons, tons),
    DB.prepare(`UPDATE game_kaiju SET phase = 'dead', died_at_tick = ?, died_at_body_id = ?,
                       carcass_body_id = ?, target_body_id = NULL WHERE game_id = ?`)
      .bind(tick, where?.id ?? null, cid, gameId),
  ]);
  // Everyone knows where it fell.
  const factions = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id = ? AND status <> 'monster'`)
    .bind(gameId).all()).results ?? [];
  if (factions.length > 0) {
    await DB.batch(factions.map(f => DB.prepare(
      `INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick)
       VALUES (?, ?, ?, ?)`,
    ).bind(gameId, f.id, cid, tick)));
  }

  const eaten = parseEaten(k);
  if (await chronicleOnce(DB, `${gameId}:kaiju:dead`, gameId, tick, 'kaiju_dead', where?.id ?? null,
    { world: where?.name ?? null, body_name: where?.name ?? null, tons, eaten,
      killer_faction_name: killer.killer_faction_name ?? null,
      killer_ship_name: killer.killer_ship_name ?? null,
      killer_captain_name: killer.killer_captain_name ?? null,
      hp_max: Number(k.hp_max) })) {
    await tellEveryone(env, gameId, tick, 'kaiju:dead', (L) => ({
      title: tr(L, 'feed.kaiju.deadTitle'),
      lines: [
        tr(L, 'feed.kaiju.deadAt', { world: where?.name ?? tr(L, 'feed.kaiju.deepSpace'), tick }),
        ...(killer.killer_faction_name
          ? [tr(L, killer.killer_ship_name ? 'feed.kaiju.deadKillerShip' : 'feed.kaiju.deadKiller',
            { faction: killer.killer_faction_name, ship: killer.killer_ship_name ?? '' })]
          : []),
        tr(L, 'feed.kaiju.carcass', { tons: tons.toLocaleString('en-US') }),
      ],
    }), { color: FEED_COLOR });
  }
  return { phase: 'dead', tons };
}
