// ============================================================
// flightState.js — where every world and every hull in flight is, at any
// tick, synchronously. For the missile pass (missiles.js): planning an
// intercept and finding what a blast in open space catches.
//
// The tick's transit-combat pass (room.js, "launch plans for hulls in
// flight") builds the same thing inline; this mirrors it rule for rule:
// the body precedence of bodyPosition (ram > eccentric > circular), the
// launch-plan columns of game_ship_nodes, and a rendezvous leg that IS the
// ship it joined after the meeting. Change one, change both.
// ============================================================

import { orbitAngle, ORBITAL_SPEED_SCALE } from './orbitPos.js';
import {
  torchStateAt, isRamming, ramPlanOf, isEccentric, eccentricLocalPosition,
} from './transitCombat.js';
import { rendezvousStateAt } from '../src/physics/rendezvous.js';

const BODY_COLS = `id, name, parent_body_id, orbit_radius, orbit_period, angle0, radius, soi, mu, type,
  orbit_rp, orbit_ra, orbit_omega, orbit_m0,
  ram_target_body_id, ram_start_tick, ram_flip_tick, ram_arrive_tick,
  ram_acceleration, ram_start_pos_x, ram_start_pos_y,
  ram_start_vel_x, ram_start_vel_y, ram_intercept_pos_x, ram_intercept_pos_y`;

/** Synchronous body position and velocity from game_bodies rows. */
export function makeSky(bodyRows) {
  const byId = new Map(bodyRows.map(b => [b.id, b]));
  const memo = new Map();
  const bodyVel = (id, t) => {
    const p1 = bodyPos(id, t);
    const p2 = bodyPos(id, t + 0.01);
    return { x: (p2.x - p1.x) / 0.01, y: (p2.y - p1.y) / 0.01 };
  };
  function bodyPos(id, t) {
    const key = `${id}@${t}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const b = byId.get(id);
    if (!b || b.parent_body_id == null) return { x: 0, y: 0 };
    let out;
    if (isRamming(b, t)) {
      out = torchStateAt(ramPlanOf(b), bodyVel, t).pos;
    } else {
      const parent = bodyPos(b.parent_body_id, t);
      if (isEccentric(b)) {
        const local = eccentricLocalPosition(b, t, ORBITAL_SPEED_SCALE);
        out = { x: parent.x + local.x, y: parent.y + local.y };
      } else {
        const angle = orbitAngle(b.angle0, b.orbit_period, t);
        out = { x: parent.x + Math.cos(angle) * (b.orbit_radius ?? 0), y: parent.y + Math.sin(angle) * (b.orbit_radius ?? 0) };
      }
    }
    memo.set(key, out);
    return out;
  }
  return { byId, bodyPos, bodyVel };
}

/** A game_ship_nodes row (with its launch plan) as torchStateAt's plan. */
export function planOfNode(r, sky) {
  const ip = sky.bodyPos(r.target_body_id, Number(r.arrival_at_tick));
  return {
    launchX: Number(r.launch_x), launchY: Number(r.launch_y),
    launchVx: Number(r.launch_vx), launchVy: Number(r.launch_vy),
    accel: Number(r.accel), flipTick: Number(r.flip_tick),
    brakeAccel: r.brake_accel != null ? Number(r.brake_accel) : null,
    accelRamp: r.accel_ramp != null ? Number(r.accel_ramp) : null,
    accelMax: r.accel_max != null ? Number(r.accel_max) : null,
    accelTau: r.accel_tau != null ? Number(r.accel_tau) : null,
    startTick: Number(r.scheduled_t), arriveTick: Number(r.arrival_at_tick),
    interceptX: ip.x, interceptY: ip.y, targetBodyId: r.target_body_id,
    rv: (r.rv_ax != null && r.rv_meet_tick != null && r.rv_follow_ship_id) ? {
      A: { x: Number(r.rv_ax), y: Number(r.rv_ay) },
      B: { x: Number(r.rv_bx), y: Number(r.rv_by) },
      meetTick: Number(r.rv_meet_tick),
      follow: r.rv_follow_ship_id,
    } : null,
  };
}

/**
 * Every world, and every active hull flying a planned leg, of one game.
 * `flights` maps ship id -> { plan, owner, cls, fleetId, hp, hpMax, name }.
 * stateAt(id, t) is that hull's {pos, vel}, or null if it is not flying.
 */
export async function loadFlights(DB, gameId) {
  const bodyRows = (await DB.prepare(`SELECT ${BODY_COLS} FROM game_bodies WHERE game_id = ?`).bind(gameId).all()).results ?? [];
  const sky = makeSky(bodyRows);
  const rows = (await DB
    .prepare(
      `SELECT n.ship_id, n.target_body_id, n.scheduled_t, n.arrival_at_tick,
              n.launch_x, n.launch_y, n.launch_vx, n.launch_vy, n.accel, n.flip_tick,
              n.brake_accel, n.accel_ramp, n.accel_max, n.accel_tau,
              n.rv_ax, n.rv_ay, n.rv_bx, n.rv_by, n.rv_meet_tick, n.rv_follow_ship_id,
              s.owner_faction_id, s.ship_class, s.fleet_id, s.hp, s.hp_max, s.name
         FROM game_ship_nodes n
         JOIN game_ships s ON s.id = n.ship_id
        WHERE s.game_id = ? AND s.status = 'active' AND n.status = 'in_transit'
          AND n.launch_x IS NOT NULL AND n.accel IS NOT NULL
          AND n.target_body_id IS NOT NULL AND n.arrival_at_tick IS NOT NULL`,
    )
    .bind(gameId).all()).results ?? [];
  const flights = new Map();
  for (const r of rows) {
    flights.set(r.ship_id, {
      plan: planOfNode(r, sky), owner: r.owner_faction_id, cls: r.ship_class, fleetId: r.fleet_id ?? null,
      hp: Number(r.hp), hpMax: Number(r.hp_max), name: r.name,
    });
  }
  const stateAt = (id, t, depth = 0) => {
    const f = flights.get(id);
    if (!f) return null;
    const plan = f.plan;
    if (!plan.rv) return torchStateAt(plan, sky.bodyVel, t);
    const followed = depth < 2 && flights.has(plan.rv.follow) ? (x) => stateAt(plan.rv.follow, x, depth + 1) : null;
    return rendezvousStateAt({
      p0: { x: plan.launchX, y: plan.launchY }, v0: { x: plan.launchVx, y: plan.launchVy },
      accel: plan.accel, A: plan.rv.A, B: plan.rv.B, startTick: plan.startTick, meetTick: plan.rv.meetTick,
    }, t, followed);
  };
  return { sky, flights, stateAt };
}

/** Hulls that fly as one: a fleet, or one empire's loose hulls bound for
 *  the same world on the same tick. Mirrors groupFlights in
 *  src/game/interceptPicker.ts. The lead is the toughest hull. */
export function groupFlights(flights, { exclude = () => false } = {}) {
  const groups = new Map();
  for (const [id, f] of flights) {
    if (exclude(id, f)) continue;
    const key = f.fleetId ? `fleet:${f.fleetId}` : `loose:${f.owner}|${f.plan.targetBodyId}|${Math.round(f.plan.arriveTick)}`;
    const g = groups.get(key) ?? { key, owner: f.owner, dest: f.plan.targetBodyId, arrive: f.plan.arriveTick, members: [] };
    g.members.push(id);
    g.arrive = Math.max(g.arrive, f.plan.arriveTick);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.members.sort();
    g.lead = g.members.reduce((best, id) => (flights.get(id).hpMax > flights.get(best).hpMax ? id : best), g.members[0]);
  }
  return [...groups.values()];
}
