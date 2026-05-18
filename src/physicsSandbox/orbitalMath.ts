// ============================================================
// PHYSICS SANDBOX — Orbital math (Kepler propagation + state vectors)
// ============================================================
// Pure functions, no React, no rendering. Ported from the HTML
// prototype on `claude/trusting-mahavira-ec8e91` after the patched-
// conics architecture had been hardened there.
//
// Storage convention for an Orbit:
//   rp        periapsis radius (relative to parent)
//   ra        apoapsis radius
//   omega     argument of periapsis (radians, world frame)
//   M0        true anomaly at epoch (stored in true-anomaly form,
//             converted to mean-anomaly form during propagation)
//   epoch     tick at which M0 is valid
//   direction +1 = prograde, -1 = retrograde
//   period    cached orbital period (ticks). For escape orbits this
//             is a fake "very large" number; numerical propagation
//             takes over (see propagateEscape).
//   parentBodyId
//
// For escape trajectories we also stash:
//   escapeEnergy   v²/μ - 2/r at burn time, > 0 ⇒ hyperbolic
//   escapeState    { rx, ry, vx, vy, t } in PARENT-local frame at
//                  the burn instant, used for Verlet integration
//                  in propagateEscape.

import { Body, BY_ID, muOf } from './bodies';

const TWO_PI = Math.PI * 2;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Orbit {
  rp: number;
  ra: number;
  omega: number;
  M0: number;
  epoch: number;
  direction: 1 | -1;
  period: number;
  parentBodyId: string;
  escapeEnergy?: number;
  escapeState?: { rx: number; ry: number; vx: number; vy: number; t: number };
}

// ----- elements -----

export function semiMajor(o: Orbit): number {
  return (o.rp + o.ra) / 2;
}

export function eccentricity(o: Orbit): number {
  return (o.ra - o.rp) / (o.ra + o.rp);
}

// ----- body positions -----

export function bodyPosition(body: Body, t: number): Vec2 {
  if (!body.parent) return { x: 0, y: 0 };
  const parent = BY_ID[body.parent];
  const pp = bodyPosition(parent, t);
  const angle = body.angle0 + (TWO_PI * t) / body.orbitPeriod;
  return {
    x: pp.x + Math.cos(angle) * body.orbitRadius,
    y: pp.y + Math.sin(angle) * body.orbitRadius,
  };
}

export function bodyWorldVelocity(body: Body, t: number): Vec2 {
  const dt = 0.01;
  const p1 = bodyPosition(body, t);
  const p2 = bodyPosition(body, t + dt);
  return { x: (p2.x - p1.x) / dt, y: (p2.y - p1.y) / dt };
}

// ----- Kepler propagation -----

/**
 * True anomaly at time t. Solves Kepler's equation via Newton-Raphson.
 * For near-circular orbits (e < 1e-9) degenerates cleanly to uniform motion.
 */
export function trueAnomalyAt(o: Orbit, t: number): number {
  const e = eccentricity(o);

  // Convert stored M0 (which we record as TRUE anomaly at epoch) into
  // mean anomaly so we can advance via uniform motion in M.
  let M0_mean: number;
  if (e < 1e-9) {
    M0_mean = o.M0;
  } else {
    const theta0 = o.M0;
    const E0 = 2 * Math.atan2(
      Math.sqrt(1 - e) * Math.sin(theta0 / 2),
      Math.sqrt(1 + e) * Math.cos(theta0 / 2),
    );
    M0_mean = E0 - e * Math.sin(E0);
  }

  let M = M0_mean + (TWO_PI * (t - o.epoch)) / o.period;
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;

  let E = M;
  for (let i = 0; i < 20; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }

  if (e < 1e-9) return E;
  let theta = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
  if (theta < 0) theta += TWO_PI;
  return theta;
}

export function radiusAt(o: Orbit, theta: number): number {
  const a = semiMajor(o);
  const e = eccentricity(o);
  const p = a * (1 - e * e);
  return p / (1 + e * Math.cos(theta));
}

export function localPositionAt(o: Orbit, t: number): {
  x: number; y: number; theta: number; r: number; phi: number;
} {
  const theta = trueAnomalyAt(o, t);
  const r = radiusAt(o, theta);
  const phi = o.omega + o.direction * theta;
  return { x: r * Math.cos(phi), y: r * Math.sin(phi), theta, r, phi };
}

export function velocityVectorsAt(o: Orbit, t: number): {
  prograde: Vec2; radialOut: Vec2; r: number; theta: number; phi: number;
} {
  const { theta, r, phi } = localPositionAt(o, t);
  const a = semiMajor(o);
  const e = eccentricity(o);
  const p = a * (1 - e * e);
  const drdtheta = (p * e * Math.sin(theta)) / Math.pow(1 + e * Math.cos(theta), 2);
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dxdt = drdtheta * cosPhi - r * sinPhi * o.direction;
  const dydt = drdtheta * sinPhi + r * cosPhi * o.direction;
  const tanLen = Math.sqrt(dxdt * dxdt + dydt * dydt) || 1;
  return {
    prograde: { x: dxdt / tanLen, y: dydt / tanLen },
    radialOut: { x: cosPhi, y: sinPhi },
    r, theta, phi,
  };
}

// World-frame position / velocity on an orbit (parent + local).

export function orbitWorldPos(orbit: Orbit, t: number): Vec2 {
  const parent = BY_ID[orbit.parentBodyId];
  const pp = bodyPosition(parent, t);
  const local = localPositionAt(orbit, t);
  return { x: pp.x + local.x, y: pp.y + local.y };
}

export function orbitWorldVelocity(orbit: Orbit, t: number): Vec2 {
  const dt = 0.01;
  const p1 = orbitWorldPos(orbit, t);
  const p2 = orbitWorldPos(orbit, t + dt);
  return { x: (p2.x - p1.x) / dt, y: (p2.y - p1.y) / dt };
}

// ----- state vector → orbit (the dragon-y part) -----

/**
 * Given a world-frame position/velocity and a desired new parent body,
 * compute the orbital elements relative to that parent. Used for SOI
 * transitions and for projecting trajectories after a burn.
 *
 * Returns null if the state vector is degenerate (zero r or v).
 */
export function orbitFromWorldState(
  worldX: number, worldY: number,
  worldVx: number, worldVy: number,
  parentBodyId: string,
  t: number,
): Orbit | null {
  const parent = BY_ID[parentBodyId];
  const pPos = bodyPosition(parent, t);
  const pVel = bodyWorldVelocity(parent, t);
  const rx = worldX - pPos.x;
  const ry = worldY - pPos.y;
  const vx = worldVx - pVel.x;
  const vy = worldVy - pVel.y;
  return orbitFromLocalState(rx, ry, vx, vy, parentBodyId, t);
}

/**
 * Same as orbitFromWorldState but the inputs are already in parent-local
 * frame. Used immediately after a maneuver burn (where local-frame state
 * is what we have on hand) to avoid double-subtracting parent velocity.
 */
export function orbitFromLocalState(
  rx: number, ry: number,
  vx: number, vy: number,
  parentBodyId: string,
  t: number,
): Orbit | null {
  const parent = BY_ID[parentBodyId];
  const r = Math.sqrt(rx * rx + ry * ry);
  const vMag = Math.sqrt(vx * vx + vy * vy);
  if (vMag < 1e-9 || r < 1e-9) return null;

  const cross = rx * vy - ry * vx;
  const direction: 1 | -1 = cross >= 0 ? 1 : -1;
  const radialX = rx / r, radialY = ry / r;
  const tangentX = -radialY * direction, tangentY = radialX * direction;
  const vxu = vx / vMag, vyu = vy / vMag;
  const sinGamma = vxu * radialX + vyu * radialY;
  const cosGamma = vxu * tangentX + vyu * tangentY;
  const gamma = Math.atan2(sinGamma, cosGamma);

  const mu = muOf(parentBodyId);

  // Vis-viva: v² = μ·(2/r - 1/a) ⇒ a = 1 / (2/r - v²/μ)
  const energyTerm = 2 / r - (vMag * vMag) / mu;
  let newA: number;
  let isEscape = false;
  if (energyTerm <= 0.0001) {
    isEscape = true;
    const soiR = parent && parent.soi !== Infinity ? parent.soi : r * 50;
    newA = soiR * 50;
  } else {
    newA = Math.max(1, 1 / energyTerm);
  }

  // Polynomial in q = 1 - e²:
  //   (k·q - 1)² + tan²γ · k²·q² = 1 - q,   k = a/r
  // We want the highest-q root in (0, 1].
  const tanG = Math.tan(gamma);
  const k = newA / r;
  const f = (q: number) => {
    const a1 = k * q - 1;
    return a1 * a1 + tanG * tanG * k * k * q * q - (1 - q);
  };

  let q: number;
  if (f(1) <= 0) {
    q = 1;
  } else {
    let qHigh = 1, qLow = 1;
    const STEPS = 200;
    let prev = f(1);
    for (let i = 1; i <= STEPS; i++) {
      const qi = 1 - i / STEPS;
      const fi = f(qi);
      if (fi <= 0 && prev > 0) {
        qLow = qi;
        qHigh = 1 - (i - 1) / STEPS;
        break;
      }
      prev = fi;
    }
    for (let i = 0; i < 80; i++) {
      const qm = (qLow + qHigh) / 2;
      if (f(qm) > 0) qHigh = qm; else qLow = qm;
      if (qHigh - qLow < 1e-12) break;
    }
    q = (qLow + qHigh) / 2;
  }
  const eSq = Math.max(0, Math.min(1, 1 - q));
  const e = Math.sqrt(eSq);
  const u = k * q - 1;
  const w = tanG * k * q;
  const theta = Math.atan2(w, u);
  const rp = newA * (1 - e);
  const ra = newA * (1 + e);
  const phi = Math.atan2(ry, rx);
  let omega = phi - direction * theta;
  while (omega < 0) omega += TWO_PI;
  while (omega >= TWO_PI) omega -= TWO_PI;

  const period = TWO_PI * Math.sqrt((newA * newA * newA) / mu);

  const result: Orbit = {
    rp, ra, omega,
    M0: theta,
    epoch: t,
    direction,
    period,
    parentBodyId,
  };
  if (isEscape) {
    result.escapeEnergy = (vMag * vMag) / mu - 2 / r;
    result.escapeState = { rx, ry, vx, vy, t };
  }
  return result;
}

// ----- maneuver application -----

export interface ManeuverDv {
  prograde: number;  // m/s-ish (game units)
  radial: number;
}

export function maneuverMagnitude(dv: ManeuverDv): number {
  return Math.sqrt(dv.prograde * dv.prograde + dv.radial * dv.radial);
}

/**
 * Apply a Δv at time `t` on `orbit`, producing the new orbit immediately
 * after the burn. Two code paths:
 *
 * - For BOUND orbits, vis-viva on the stored elements gives the exact
 *   speed and `prograde` is the velocity direction — clean math.
 *
 * - For ESCAPE orbits, the stored elements are the "fake 50·SOI ellipse"
 *   sentinel; their vis-viva and prograde-from-Kepler are both wrong.
 *   We Verlet-integrate the stored `escapeState` forward to `t` to
 *   recover the true state vector, then apply Δv to that. This keeps
 *   burns at SOI entry sized against the real hyperbolic excess
 *   velocity rather than the fictional fake-ellipse one.
 */
export function applyNodeToOrbit(orbit: Orbit, t: number, dv: ManeuverDv): Orbit {
  if (orbit.escapeState) {
    return applyNodeToEscapeOrbit(orbit, t, dv);
  }
  const { prograde, radialOut } = velocityVectorsAt(orbit, t);
  const local = localPositionAt(orbit, t);
  const a = semiMajor(orbit);
  const r = Math.sqrt(local.x * local.x + local.y * local.y);
  const mu = muOf(orbit.parentBodyId);
  const visVivaIn = 2 / r - 1 / a;
  const speed = visVivaIn > 0 ? Math.sqrt(mu * visVivaIn) : 0;
  const oldVx = prograde.x * speed;
  const oldVy = prograde.y * speed;
  const dvx = prograde.x * dv.prograde + radialOut.x * dv.radial;
  const dvy = prograde.y * dv.prograde + radialOut.y * dv.radial;
  const newVx = oldVx + dvx;
  const newVy = oldVy + dvy;
  const next = orbitFromLocalState(local.x, local.y, newVx, newVy, orbit.parentBodyId, t);
  return next ?? orbit;
}

/**
 * State-vector-based burn application for escape orbits. Verlet-integrates
 * `escapeState` to burn time, applies Δv along the actual prograde and
 * radial-out directions in the parent-local frame, then reconstructs
 * orbital elements via orbitFromLocalState.
 */
function applyNodeToEscapeOrbit(orbit: Orbit, t: number, dv: ManeuverDv): Orbit {
  const es = orbit.escapeState!;
  const mu = muOf(orbit.parentBodyId);
  // Integrate forward from escapeState.t to t. Uses a small fixed step
  // for accuracy over the typical 0.1-tick burn-after-entry window.
  let rx = es.rx, ry = es.ry, vx = es.vx, vy = es.vy;
  let curT = es.t;
  const h = 0.05;
  let safety = 0;
  while (curT < t - 1e-9 && safety++ < 5000) {
    const dt = Math.min(h, t - curT);
    const r = Math.sqrt(rx * rx + ry * ry);
    if (r < 0.1) break;
    const acc = -mu / (r * r * r);
    const ax = acc * rx, ay = acc * ry;
    rx += vx * dt + 0.5 * ax * dt * dt;
    ry += vy * dt + 0.5 * ay * dt * dt;
    const r2 = Math.sqrt(rx * rx + ry * ry);
    const acc2 = -mu / (r2 * r2 * r2);
    vx += 0.5 * (ax + acc2 * rx) * dt;
    vy += 0.5 * (ay + acc2 * ry) * dt;
    curT += dt;
  }
  // Build prograde / radial-out from the actual state vector at burn time.
  const r = Math.sqrt(rx * rx + ry * ry) || 1;
  const speed = Math.sqrt(vx * vx + vy * vy) || 1;
  const progradeX = vx / speed;
  const progradeY = vy / speed;
  const radialOutX = rx / r;
  const radialOutY = ry / r;
  const newVx = vx + progradeX * dv.prograde + radialOutX * dv.radial;
  const newVy = vy + progradeY * dv.prograde + radialOutY * dv.radial;
  const next = orbitFromLocalState(rx, ry, newVx, newVy, orbit.parentBodyId, t);
  return next ?? orbit;
}

// ----- escape-orbit numerical propagation -----

/**
 * Velocity-Verlet integrate an escape state forward in parent-local frame.
 * Stops when the ship crosses the parent's SOI boundary or enters a
 * sibling body's SOI, returning the world-frame state at the event so the
 * caller can re-anchor to a new parent.
 *
 * For ellipses (escapeEnergy unset) callers should use Kepler propagation
 * instead; this routine is only meaningful for hyperbolic trajectories
 * where the "fake" period-cached ellipse would mispredict position.
 */
export function propagateEscape(
  orbit: Orbit,
  fromTick: number,
  maxTicks: number,
): {
  exited: boolean; entered: boolean; t: number;
  worldX: number; worldY: number; worldVx: number; worldVy: number;
  bodyId?: string;
} | null {
  const es = orbit.escapeState;
  if (!es) return null;
  const parent = BY_ID[orbit.parentBodyId];
  if (!parent) return null;
  const mu = muOf(orbit.parentBodyId);

  let rx = es.rx, ry = es.ry, vx = es.vx, vy = es.vy;
  const startT = es.t;
  const h = 0.25;
  const steps = Math.ceil((fromTick + maxTicks - startT) / h);
  for (let i = 1; i <= steps; i++) {
    const t = startT + i * h;
    const r = Math.sqrt(rx * rx + ry * ry);
    if (r < 0.1) break;
    const acc = -mu / (r * r * r);
    const ax = acc * rx, ay = acc * ry;
    rx += vx * h + 0.5 * ax * h * h;
    ry += vy * h + 0.5 * ay * h * h;
    const r2 = Math.sqrt(rx * rx + ry * ry);
    const acc2 = -mu / (r2 * r2 * r2);
    vx += 0.5 * (ax + acc2 * rx) * h;
    vy += 0.5 * (ay + acc2 * ry) * h;

    if (parent.soi !== Infinity && r2 > parent.soi) {
      const pPos = bodyPosition(parent, t);
      const pVel = bodyWorldVelocity(parent, t);
      return {
        exited: true, entered: false, t,
        worldX: pPos.x + rx, worldY: pPos.y + ry,
        worldVx: pVel.x + vx, worldVy: pVel.y + vy,
      };
    }
  }
  return null;
}
