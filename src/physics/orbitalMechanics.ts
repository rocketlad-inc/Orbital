// ============================================================
// Orbital Mechanics - Physics calculations
// Extracted from the prototype and refactored for reuse
// ============================================================

import { OrbitElements, Body, TrajectoryArc, ManeuverNode } from '../types';

const TWO_PI = Math.PI * 2;

// Gravitational parameters — derived from Jupiter's orbit to match HTML prototype
export const GRAVITATIONAL_PARAMS = {
  SOL: 4 * Math.PI * Math.PI * Math.pow(460, 3) / Math.pow(800, 2),
} as const;

/**
 * Get gravitational parameter μ for a body.
 * Uses per-body mu field when available, falls back to type-based defaults.
 */
export function muOf(bodyId: string, bodies: Body[]): number {
  if (bodyId === 'sol') return GRAVITATIONAL_PARAMS.SOL;
  const body = bodies.find(b => b.id === bodyId);
  if (!body) return 100;
  if (body.mu != null && body.mu > 0) return body.mu;
  if (body.type === 'gas_giant') return 1000;
  if (body.type === 'ice_giant') return 200;
  if (body.type === 'moon') return 5;
  if (body.type === 'dwarf') return 1;
  return 100;
}

/**
 * Helper functions for orbital elements
 */
export function semiMajor(orbit: OrbitElements): number {
  return (orbit.rp + orbit.ra) / 2;
}

export function eccentricity(orbit: OrbitElements): number {
  return (orbit.ra - orbit.rp) / (orbit.ra + orbit.rp);
}

/**
 * Solve Kepler's equation: M = E - e·sin(E) for eccentric anomaly E
 * Given mean anomaly M, eccentricity e
 * Returns true anomaly θ
 */
export function solveKepler(M: number, e: number): number {
  // Clamp eccentricity to elliptical range — we use fake large ellipses
  // for escape trajectories instead of hyperbolic orbits
  const eClamp = Math.min(e, 0.9999);

  // Elliptical Kepler equation: M = E - e·sin(E)
  let E = M;
  for (let i = 0; i < 20; i++) {
    const f = E - eClamp * Math.sin(E) - M;
    const fp = 1 - eClamp * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }

  let theta: number;
  if (eClamp < 1e-9) {
    theta = E;
  } else {
    theta = 2 * Math.atan2(
      Math.sqrt(1 + eClamp) * Math.sin(E / 2),
      Math.sqrt(1 - eClamp) * Math.cos(E / 2)
    );
    if (theta < 0) theta += TWO_PI;
  }
  return theta;
}

/**
 * Get true anomaly at a given time
 */
export function trueAnomalyAt(orbit: OrbitElements, t: number): number {
  // Clamp eccentricity to valid elliptical range (fake large ellipses cap at ~1.0)
  const e = Math.min(eccentricity(orbit), 0.9999);

  // Elliptical: convert stored M0 (true anomaly at epoch) to mean anomaly form
  let M0_mean: number;
  if (e < 1e-9) {
    M0_mean = orbit.M0;
  } else {
    const theta0 = orbit.M0;
    const E0 = 2 * Math.atan2(
      Math.sqrt(1 - e) * Math.sin(theta0 / 2),
      Math.sqrt(1 + e) * Math.cos(theta0 / 2)
    );
    M0_mean = E0 - e * Math.sin(E0);
  }

  let M = M0_mean + TWO_PI * (t - orbit.epoch) / orbit.period;
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;

  return solveKepler(M, e);
}

/**
 * Get radius at a given true anomaly
 * r = a(1-e²) / (1 + e·cos(θ))
 */
export function radiusAt(orbit: OrbitElements, theta: number): number {
  const a = semiMajor(orbit);
  const e = Math.min(eccentricity(orbit), 0.9999);
  const p = a * (1 - e * e);
  return p / (1 + e * Math.cos(theta));
}

/**
 * Get position (local to parent body) at a given time
 */
export interface LocalPosition {
  x: number;
  y: number;
  theta: number;  // true anomaly
  r: number;      // radius
  phi: number;    // absolute angle in orbital plane
}

export function localPositionAt(
  orbit: OrbitElements,
  t: number
): LocalPosition {
  const theta = trueAnomalyAt(orbit, t);
  const r = radiusAt(orbit, theta);
  const phi = orbit.omega + orbit.direction * theta;
  return {
    x: r * Math.cos(phi),
    y: r * Math.sin(phi),
    theta,
    r,
    phi,
  };
}

/**
 * Get velocity vectors (prograde, radial-out) at a position
 */
export interface VelocityVectors {
  prograde: { x: number; y: number };
  radialOut: { x: number; y: number };
  r: number;
  theta: number;
  phi: number;
}

export function velocityVectorsAt(
  orbit: OrbitElements,
  t: number
): VelocityVectors {
  const pos = localPositionAt(orbit, t);
  const { theta, r, phi } = pos;
  const a = semiMajor(orbit);
  const e = eccentricity(orbit);
  const p = a * (1 - e * e);

  const drdtheta = (p * e * Math.sin(theta)) / Math.pow(1 + e * Math.cos(theta), 2);
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dxdtheta = drdtheta * cosPhi - r * sinPhi * orbit.direction;
  const dydtheta = drdtheta * sinPhi + r * cosPhi * orbit.direction;
  const tanLen = Math.sqrt(dxdtheta * dxdtheta + dydtheta * dydtheta);

  return {
    prograde: { x: dxdtheta / tanLen, y: dydtheta / tanLen },
    radialOut: { x: cosPhi, y: sinPhi },
    r,
    theta,
    phi,
  };
}

/**
 * Body position in world frame at time t
 */
export interface WorldPosition {
  x: number;
  y: number;
}

export function bodyPosition(body: Body, t: number, bodies: Body[]): WorldPosition {
  if (!body.parent) return { x: 0, y: 0 };
  const parent = bodies.find(b => b.id === body.parent);
  if (!parent) return { x: 0, y: 0 };

  const parentPos = bodyPosition(parent, t, bodies);
  const angle = body.angle0! + (TWO_PI * t / body.orbitPeriod);
  return {
    x: parentPos.x + Math.cos(angle) * body.orbitRadius,
    y: parentPos.y + Math.sin(angle) * body.orbitRadius,
  };
}

/**
 * Orbit world position: position of ship on orbit in world frame
 */
export function orbitWorldPos(
  orbit: OrbitElements,
  t: number,
  bodies: Body[]
): WorldPosition {
  const parentBody = bodies.find(b => b.id === orbit.parentBodyId);
  if (!parentBody) return { x: 0, y: 0 };

  const parentPos = bodyPosition(parentBody, t, bodies);
  const local = localPositionAt(orbit, t);
  return {
    x: parentPos.x + local.x,
    y: parentPos.y + local.y,
  };
}

/**
 * Vis-viva equation: compute velocity magnitude at radius r
 * v² = μ(2/r - 1/a)
 */
export function visVivaSpeed(
  mu: number,
  r: number,
  a: number
): number {
  const energyTerm = 2 / r - 1 / a;
  if (energyTerm <= 0) {
    // Escape trajectory (hyperbolic or parabolic)
    return Math.sqrt(mu * 2 / r);
  }
  return Math.sqrt(mu * energyTerm);
}

/**
 * Compute semi-major axis from vis-viva
 * a = 1 / (2/r - v²/μ)
 */
export function semiMajorFromVisViva(
  mu: number,
  r: number,
  vMag: number
): number {
  const energyTerm = 2 / r - (vMag * vMag) / mu;
  if (energyTerm <= 0.0001) {
    // Escape trajectory
    return r * 3; // approximate
  }
  return 1 / energyTerm;
}

// ---------- ORBIT FROM STATE VECTOR ----------
// Given a position (relative to focus) and a velocity direction at that point,
// plus a target semi-major axis 'newA', compute the new orbital elements.
// Ported from HTML prototype — more numerically stable than re-deriving a from energy.
export function orbitFromStateVector(
  rx: number, ry: number,
  vx: number, vy: number,
  newA: number,
  parentBodyId: string,
  burnTime: number,
  oldPeriod: number,
  oldA: number
): OrbitElements | null {
  const r = Math.sqrt(rx * rx + ry * ry);
  const vMag = Math.sqrt(vx * vx + vy * vy);
  if (vMag < 1e-9 || r < 1e-9) return null;

  // Direction sign from 2D cross product of position × velocity
  const cross = rx * vy - ry * vx;
  const direction: 1 | -1 = cross >= 0 ? 1 : -1;

  // Flight path angle gamma = angle between velocity and local horizontal
  const radialX = rx / r;
  const radialY = ry / r;
  const tangentX = -radialY * direction;
  const tangentY = radialX * direction;
  const vxu = vx / vMag;
  const vyu = vy / vMag;
  const sinGamma = vxu * radialX + vyu * radialY;
  const cosGamma = vxu * tangentX + vyu * tangentY;
  const gamma = Math.atan2(sinGamma, cosGamma);

  // Clamp newA to sane values
  const minA = Math.max(1, r * 0.55);
  const maxA = r * 500;
  newA = Math.max(minA, Math.min(maxA, newA));

  // Solve for eccentricity given semi-major axis, r, gamma.
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
    let qHigh = 1;
    let qLow = 1;
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
      if (f(qm) > 0) qHigh = qm;
      else qLow = qm;
      if (qHigh - qLow < 1e-12) break;
    }
    q = (qLow + qHigh) / 2;
  }

  // Eccentricity clamping: allow up to 1.0 (matches HTML)
  const eSq = Math.max(0, Math.min(1, 1 - q));
  const e = Math.sqrt(eSq);

  // True anomaly at current point
  const u = k * q - 1;
  const w = tanG * k * q;
  const theta = Math.atan2(w, u);
  const rp = newA * (1 - e);
  const ra = newA * (1 + e);
  const phi = Math.atan2(ry, rx);
  let omega = phi - direction * theta;
  while (omega < 0) omega += TWO_PI;
  while (omega >= TWO_PI) omega -= TWO_PI;

  // Period scaling: more stable than re-deriving from Kepler's 3rd law
  const newPeriod = oldPeriod * Math.pow(newA / oldA, 1.5);

  return {
    rp, ra, omega,
    M0: theta,
    epoch: burnTime,
    direction,
    period: newPeriod,
    parentBodyId,
  };
}

/**
 * Check if a position is inside a body's SOI
 */
export function isInsideSOI(
  worldX: number,
  worldY: number,
  body: Body,
  t: number,
  bodies: Body[]
): boolean {
  const bodyPos = bodyPosition(body, t, bodies);
  const dx = worldX - bodyPos.x;
  const dy = worldY - bodyPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist < body.soi;
}

/**
 * Find which SOI contains a world position (deepest/smallest)
 */
export function whichSOI(
  worldX: number,
  worldY: number,
  t: number,
  bodies: Body[]
): Body {
  let best = bodies.find(b => b.id === 'sol') || bodies[0];
  let bestRadius = Infinity;

  for (const body of bodies) {
    if (body.id === 'sol') continue;
    const pos = bodyPosition(body, t, bodies);
    const dx = worldX - pos.x;
    const dy = worldY - pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < body.soi && body.soi < bestRadius) {
      best = body;
      bestRadius = body.soi;
    }
  }

  return best;
}

/**
 * Create a circular orbit at a given radius around a body
 */
export function createCircularOrbit(
  bodyId: string,
  radius: number,
  t: number,
  bodies: Body[]
): OrbitElements {
  const mu = muOf(bodyId, bodies);
  const period = 2 * Math.PI * Math.sqrt((radius * radius * radius) / mu);

  return {
    rp: radius,
    ra: radius,
    omega: 0,
    M0: 0,
    epoch: t,
    direction: 1,
    period,
    parentBodyId: bodyId,
  };
}

/**
 * Create an elliptical transfer orbit between two orbital radii
 */
export function createTransferOrbit(
  fromRadius: number,
  toRadius: number,
  parentBodyId: string,
  t: number,
  bodies: Body[]
): OrbitElements {
  const mu = muOf(parentBodyId, bodies);
  const a = (fromRadius + toRadius) / 2;
  const period = 2 * Math.PI * Math.sqrt((a * a * a) / mu);

  return {
    rp: Math.min(fromRadius, toRadius),
    ra: Math.max(fromRadius, toRadius),
    omega: 0,
    M0: 0,
    epoch: t,
    direction: 1,
    period,
    parentBodyId,
  };
}

/**
 * Get velocity of a body in world frame
 */
export function bodyWorldVelocity(body: Body, t: number, bodies: Body[]): { x: number; y: number } {
  const dt = 0.01;
  const p1 = bodyPosition(body, t, bodies);
  const p2 = bodyPosition(body, t + dt, bodies);
  return { x: (p2.x - p1.x) / dt, y: (p2.y - p1.y) / dt };
}

/**
 * Get velocity of a ship on an orbit in world frame
 */
export function orbitWorldVelocity(
  orbit: OrbitElements,
  t: number,
  bodies: Body[]
): { x: number; y: number } {
  const es = (orbit as any).escapeState;
  if (es) {
    const mu = muOf(orbit.parentBodyId, bodies);
    let rx = es.rx, ry = es.ry, vx = es.vx, vy = es.vy;
    const h = 0.25;
    const steps = Math.max(0, Math.ceil((t - es.t) / h));
    for (let i = 0; i < steps; i++) {
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
    }
    const parent = bodies.find(b => b.id === orbit.parentBodyId);
    if (parent) {
      const pVel = bodyWorldVelocity(parent, t, bodies);
      return { x: pVel.x + vx, y: pVel.y + vy };
    }
  }
  const dt = 0.01;
  const p1 = orbitWorldPos(orbit, t, bodies);
  const p2 = orbitWorldPos(orbit, t + dt, bodies);
  return { x: (p2.x - p1.x) / dt, y: (p2.y - p1.y) / dt };
}

/**
 * Convert world-frame state vector to orbit
 * Returns orbit elements or null if invalid
 * Matches HTML prototype: uses fake large ellipses for escape trajectories
 */
export function orbitFromWorldState(
  worldX: number,
  worldY: number,
  worldVx: number,
  worldVy: number,
  parentBodyId: string,
  t: number,
  bodies: Body[],
  oldPeriod?: number,
  oldA?: number
): OrbitElements | null {
  const parent = bodies.find(b => b.id === parentBodyId);
  if (!parent) return null;

  const pPos = bodyPosition(parent, t, bodies);
  const pVel = bodyWorldVelocity(parent, t, bodies);
  const rx = worldX - pPos.x;
  const ry = worldY - pPos.y;
  const vx = worldVx - pVel.x;
  const vy = worldVy - pVel.y;

  const r = Math.sqrt(rx * rx + ry * ry);
  const vMag = Math.sqrt(vx * vx + vy * vy);
  if (vMag < 1e-9 || r < 1e-9) return null;

  const cross = rx * vy - ry * vx;
  const direction: 1 | -1 = cross >= 0 ? 1 : -1;
  const radialX = rx / r;
  const radialY = ry / r;
  const tangentX = -radialY * direction;
  const tangentY = radialX * direction;
  const vxu = vx / vMag;
  const vyu = vy / vMag;
  const sinGamma = vxu * radialX + vyu * radialY;
  const cosGamma = vxu * tangentX + vyu * tangentY;
  const gamma = Math.atan2(sinGamma, cosGamma);

  const mu = muOf(parentBodyId, bodies);
  const energyTerm = 2 / r - (vMag * vMag) / mu;

  // Escape or near-parabolic: use fake large ellipse (matches HTML)
  let newA: number;
  let isEscape = false;
  if (energyTerm <= 0.0001) {
    isEscape = true;
    const soiR = (parent.soi !== Infinity) ? parent.soi : r * 50;
    newA = soiR * 50;
  } else {
    newA = 1 / energyTerm;
    newA = Math.max(1, newA);
  }

  // Solve for eccentricity (elliptical iterative solver)
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
    let qHigh = 1;
    let qLow = 1;
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
      if (f(qm) > 0) qHigh = qm;
      else qLow = qm;
      if (qHigh - qLow < 1e-12) break;
    }
    q = (qLow + qHigh) / 2;
  }

  // Eccentricity clamping: allow up to 1.0 (matches HTML)
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

  // Period: use scaling approach when oldPeriod/oldA available, else Kepler's 3rd law
  let period: number;
  if (oldPeriod != null && oldA != null && oldA > 0) {
    period = oldPeriod * Math.pow(newA / oldA, 1.5);
  } else {
    period = TWO_PI * Math.sqrt((newA * newA * newA) / mu);
  }

  const result: OrbitElements = {
    rp, ra, omega,
    M0: theta,
    epoch: t,
    direction,
    period,
    parentBodyId,
  };

  if (isEscape) {
    // Store escape energy for patched conics (matches HTML)
    (result as any).escapeEnergy = (vMag * vMag) / mu - 2 / r;
  }

  return result;
}

// ============================================================
// Next-apsis-time solver (ported from HTML prototype)
// ============================================================

/**
 * Find the next periapsis or apoapsis time after fromTick.
 * For near-circular orbits, returns fromTick + 1 as a safe default.
 */
export function nextApsisTime(
  orbit: OrbitElements,
  fromTick: number,
  which: 'periapsis' | 'apoapsis'
): number {
  const e = eccentricity(orbit);
  if (e < 1e-3) {
    return fromTick + 1;
  }

  const thetaTarget = which === 'apoapsis' ? Math.PI : 0;
  const samples = 60;
  let tLow = fromTick;
  let tHigh = fromTick + orbit.period * 1.01;

  let lastDiff = trueAnomalyAt(orbit, fromTick) - thetaTarget;
  while (lastDiff > Math.PI) lastDiff -= TWO_PI;
  while (lastDiff < -Math.PI) lastDiff += TWO_PI;

  for (let i = 1; i <= samples; i++) {
    const ti = fromTick + (i / samples) * orbit.period * 1.01;
    let diff = trueAnomalyAt(orbit, ti) - thetaTarget;
    while (diff > Math.PI) diff -= TWO_PI;
    while (diff < -Math.PI) diff += TWO_PI;
    if (Math.sign(diff) !== Math.sign(lastDiff) && Math.abs(lastDiff) < Math.PI / 2) {
      tLow = fromTick + ((i - 1) / samples) * orbit.period * 1.01;
      tHigh = ti;
      break;
    }
    lastDiff = diff;
  }

  for (let i = 0; i < 30; i++) {
    const tm = (tLow + tHigh) / 2;
    let diff = trueAnomalyAt(orbit, tm) - thetaTarget;
    while (diff > Math.PI) diff -= TWO_PI;
    while (diff < -Math.PI) diff += TWO_PI;
    if (diff < 0) tLow = tm; else tHigh = tm;
    if (tHigh - tLow < 1e-4) break;
  }
  return (tLow + tHigh) / 2;
}

// ============================================================
// SOI event detection (ported from HTML prototype)
// ============================================================

interface SOIEvent {
  type: 'exit' | 'enter';
  t: number;
  body: Body;
  newOrbit: OrbitElements | null;
}

/**
 * Find the next SOI event (exit or enter) from a given orbit and start time.
 * Returns the event with new orbit, or null if none within budget.
 * Ported from HTML prototype's findNextSOIEvent.
 */
function findNextSOIEvent(
  orbit: OrbitElements,
  fromTick: number,
  maxLookahead: number,
  bodies: Body[]
): SOIEvent | null {
  const parent = bodies.find(b => b.id === orbit.parentBodyId);
  if (!parent) return null;

  // For escape orbits with escapeEnergy, use numerical integration
  if ((orbit as any).escapeEnergy && parent.id !== 'sol') {
    const result = propagateEscape(orbit, fromTick, Math.min(maxLookahead, 100), parent, bodies);
    if (result && result.exited) {
      const newParentId = parent.parent || 'sol';
      const newOrbit = orbitFromWorldState(
        result.worldX, result.worldY, result.worldVx, result.worldVy,
        newParentId, result.t, bodies
      );
      return { type: 'exit', t: result.t, body: parent, newOrbit };
    }
    if (result && result.entered && result.body) {
      const newOrbit = orbitFromWorldState(
        result.worldX, result.worldY, result.worldVx, result.worldVy,
        result.body.id, result.t, bodies
      );
      return { type: 'enter', t: result.t, body: result.body, newOrbit };
    }
    return null;
  }

  const stepSize = 0.5;
  const limit = Math.min(maxLookahead, orbit.period * 2);

  for (let dt = stepSize; dt <= limit; dt += stepSize) {
    const t = fromTick + dt;
    const pos = orbitWorldPos(orbit, t, bodies);

    // Check SOI exit
    if (parent.id !== 'sol') {
      const pp = bodyPosition(parent, t, bodies);
      const dx = pos.x - pp.x;
      const dy = pos.y - pp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > parent.soi) {
        const tExit = bisectSOIExit(orbit, parent, t - stepSize, t, bodies);
        const newParentId = parent.parent || 'sol';
        const exitPos = orbitWorldPos(orbit, tExit, bodies);
        const exitVel = orbitWorldVelocity(orbit, tExit, bodies);
        const newOrbit = orbitFromWorldState(
          exitPos.x, exitPos.y, exitVel.x, exitVel.y,
          newParentId, tExit, bodies
        );
        return { type: 'exit', t: tExit, body: parent, newOrbit };
      }
    }

    // Check SOI entry into child bodies
    for (const body of bodies) {
      if (body.id === 'sol' || body.id === parent.id) continue;
      if (body.parent !== parent.id) continue;
      const bp = bodyPosition(body, t, bodies);
      const dx = pos.x - bp.x;
      const dy = pos.y - bp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < body.soi) {
        const tEnter = bisectSOIEnter(orbit, body, t - stepSize, t, bodies);
        const enterPos = orbitWorldPos(orbit, tEnter, bodies);
        const enterVel = orbitWorldVelocity(orbit, tEnter, bodies);
        const newOrbit = orbitFromWorldState(
          enterPos.x, enterPos.y, enterVel.x, enterVel.y,
          body.id, tEnter, bodies
        );
        return { type: 'enter', t: tEnter, body, newOrbit };
      }
    }
  }
  return null;
}

/**
 * Numerically propagate an escape orbit using Verlet integration.
 * Detects SOI exit and sibling body SOI entry.
 * Ported from HTML prototype's propagateEscape.
 */
function propagateEscape(
  orbit: OrbitElements,
  fromTick: number,
  maxTicks: number,
  parent: Body,
  bodies: Body[]
): {
  exited?: boolean;
  entered?: boolean;
  t: number;
  body?: Body;
  worldX: number;
  worldY: number;
  worldVx: number;
  worldVy: number;
} | null {
  const mu = muOf(orbit.parentBodyId, bodies);
  const es = (orbit as any).escapeState;
  if (!es) return null;

  let rx = es.rx, ry = es.ry, vx = es.vx, vy = es.vy;
  const startT = es.t;
  const h = 0.25; // integration step (ticks)
  const endTime = fromTick + maxTicks;
  const steps = Math.ceil((endTime - startT) / h);

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

    if (r2 > parent.soi) {
      const pPos = bodyPosition(parent, t, bodies);
      const pVel = bodyWorldVelocity(parent, t, bodies);
      return {
        exited: true, t,
        worldX: pPos.x + rx, worldY: pPos.y + ry,
        worldVx: pVel.x + vx, worldVy: pVel.y + vy,
      };
    }

    // Check entering a sibling body's SOI
    const pPos = bodyPosition(parent, t, bodies);
    const worldX = pPos.x + rx, worldY = pPos.y + ry;
    for (const body of bodies) {
      if (body.id === 'sol' || body.id === parent.id) continue;
      if (body.parent !== parent.id) continue;
      const bp = bodyPosition(body, t, bodies);
      const d = Math.sqrt((worldX - bp.x) ** 2 + (worldY - bp.y) ** 2);
      if (d < body.soi) {
        const pVel = bodyWorldVelocity(parent, t, bodies);
        return {
          entered: true, t, body,
          worldX, worldY,
          worldVx: pVel.x + vx, worldVy: pVel.y + vy,
        };
      }
    }
  }
  return null;
}

// ============================================================
// Transfer Planner — Grid-search validated (ported from HTML)
// ============================================================

/**
 * Plan a transfer maneuver: send a ship from its current SOI to a target body.
 * Uses analytic Hohmann as initial guess, then grid-searches (burnTime, dv) pairs
 * to find one that actually produces an SOI encounter via trajectory simulation.
 *
 * Returns { burns, target, fromBody, dvTotal, hasValidPlan } or null on error.
 */
export interface TransferBurn {
  dv: number;
  timing: number; // tick time
  label: string;
  capturedAtBody?: string; // set on capture burn
}

export interface TransferPlan {
  burns: TransferBurn[];
  target: string;
  fromBody: string;
  dvTotal: number;
  hasValidPlan: boolean;
}

export function planTransfer(
  currentOrbit: OrbitElements,
  targetBodyId: string,
  bodies: Body[],
  currentTick: number,
  strategy: 'quickest' | 'soonest' | 'cheapest' = 'soonest'
): TransferPlan | null {
  const targetMaybe = bodies.find(b => b.id === targetBodyId);
  if (!targetMaybe) return null;
  const target: Body = targetMaybe;  // narrow for use in closures

  const orbit = currentOrbit;
  const currentParentId = orbit.parentBodyId;
  const currentParent = bodies.find(b => b.id === currentParentId);
  if (!currentParent) return null;

  if (currentParentId === targetBodyId) return null; // Already at target
  if (currentParentId === 'sol') return null; // Must be in a body's SOI

  // ── Classify the transfer ──
  type TransferCase = 'planet-planet' | 'to-moon' | 'moon-moon' | 'to-parent' | 'moon-to-planet';
  let transferCase: TransferCase;
  let commonParentId: string;
  let originBody: Body | null = null;
  let targetBody: Body = target;

  if (currentParent.parent === 'sol' && target.parent === 'sol') {
    // Planet -> Planet
    transferCase = 'planet-planet';
    commonParentId = 'sol';
    originBody = currentParent;
    targetBody = target;
  } else if (target.parent === currentParentId) {
    // Planet -> Own Moon
    transferCase = 'to-moon';
    commonParentId = currentParentId;
    originBody = null;
    targetBody = target;
  } else if (currentParent.parent && currentParent.parent !== 'sol' &&
             target.parent === currentParent.parent) {
    // Moon -> Sibling Moon
    transferCase = 'moon-moon';
    commonParentId = currentParent.parent;
    originBody = currentParent;
    targetBody = target;
  } else if (target.id === currentParent.parent) {
    // Moon -> Parent body (escape to parent)
    transferCase = 'to-parent';
    commonParentId = target.id;
    originBody = currentParent;
    targetBody = target;
  } else if (currentParent.parent && currentParent.parent !== 'sol' && target.parent === 'sol') {
    // Moon -> Different planet (cross-system via Sol)
    transferCase = 'moon-to-planet';
    commonParentId = 'sol';
    originBody = bodies.find(b => b.id === currentParent.parent) || null;
    targetBody = target;
  } else if (currentParent.parent === 'sol' && target.parent && target.parent !== 'sol') {
    // Planet -> Foreign moon: must transfer to moon's parent first
    if (currentParentId === target.parent) {
      transferCase = 'to-moon';
      commonParentId = currentParentId;
      originBody = null;
      targetBody = target;
    } else {
      console.log(`[TRANSFER] Cannot transfer directly; go to ${target.parent} first`);
      return null;
    }
  } else {
    console.log('[TRANSFER] Unsupported transfer route');
    return null;
  }

  // ── Special case: escape to parent body ──
  if (transferCase === 'to-parent') {
    const mu_esc = muOf(currentParentId, bodies);
    const r_pe_esc = orbit.rp;
    const a_cur = semiMajor(orbit);
    const v_cur = Math.sqrt(mu_esc * (2 / r_pe_esc - 1 / a_cur));
    const v_esc = Math.sqrt(2 * mu_esc / r_pe_esc);
    const dv_esc = (v_esc - v_cur) * 1.05;
    const tBurn = Math.max(nextApsisTime(orbit, currentTick, 'periapsis'), currentTick + 0.5);

    return {
      burns: [{
        dv: dv_esc,
        timing: tBurn,
        label: `Escape ${currentParent.name} → ${target.name} orbit`,
      }],
      target: target.name,
      fromBody: currentParent.name,
      dvTotal: Math.abs(dv_esc),
      hasValidPlan: true,
    };
  }

  // ── Hohmann parameters in common-parent frame ──
  const mu_cp = muOf(commonParentId, bodies);
  let r1: number, r2: number;
  if (transferCase === 'to-moon') {
    r1 = semiMajor(orbit);
    r2 = targetBody.orbitRadius;
  } else {
    r1 = originBody!.orbitRadius;
    r2 = targetBody.orbitRadius;
  }
  if (r1 <= 0 || r2 <= 0 || Math.abs(r1 - r2) < 0.1) return null;

  const a_transfer = (r1 + r2) / 2;
  const isOutbound = r2 > r1;

  const v1_circ = Math.sqrt(mu_cp / r1);
  const v2_circ = Math.sqrt(mu_cp / r2);
  const v1_trans = Math.sqrt(mu_cp * (2 / r1 - 1 / a_transfer));
  const v2_trans = Math.sqrt(mu_cp * (2 / r2 - 1 / a_transfer));
  const v_inf_origin = Math.abs(v1_trans - v1_circ);
  const v_inf_target = Math.abs(v2_circ - v2_trans);

  const transferTime = Math.PI * Math.sqrt(Math.pow(a_transfer, 3) / mu_cp);

  // ── Injection dv estimate (per transfer case) ──
  const r_pe = orbit.rp;
  const a_current = semiMajor(orbit);
  let dv_injection: number;
  let dv_min_search: number;
  let dv_max_search: number;

  if (transferCase === 'planet-planet') {
    const mu_o = muOf(currentParentId, bodies);
    const v_cur = Math.sqrt(mu_o * (2 / r_pe - 1 / a_current));
    const v_b = Math.sqrt(v_inf_origin ** 2 + 2 * mu_o / r_pe);
    dv_injection = (isOutbound ? 1 : -1) * (v_b - v_cur);
    const v_esc = Math.sqrt(2 * mu_o / r_pe);
    dv_min_search = v_esc - v_cur;
    dv_max_search = Math.max(Math.abs(dv_injection) * 2.0, dv_min_search * 3.0);

  } else if (transferCase === 'to-moon') {
    const v_cur = Math.sqrt(mu_cp * (2 / r_pe - 1 / a_current));
    const v_trans = Math.sqrt(Math.max(0, mu_cp * (2 / r_pe - 1 / a_transfer)));
    dv_injection = (isOutbound ? 1 : -1) * (v_trans - v_cur);
    dv_min_search = Math.max(0.01, Math.abs(dv_injection) * 0.3);
    dv_max_search = Math.max(0.1, Math.abs(dv_injection) * 3.0);

  } else if (transferCase === 'moon-moon') {
    const mu_o = muOf(currentParentId, bodies);
    const v_cur = Math.sqrt(mu_o * (2 / r_pe - 1 / a_current));
    const v_b = Math.sqrt(v_inf_origin ** 2 + 2 * mu_o / r_pe);
    dv_injection = (isOutbound ? 1 : -1) * (v_b - v_cur);
    const v_esc = Math.sqrt(2 * mu_o / r_pe);
    dv_min_search = v_esc - v_cur;
    dv_max_search = Math.max(Math.abs(dv_injection) * 2.5, dv_min_search * 3.0);

  } else /* moon-to-planet */ {
    const mu_moon = muOf(currentParentId, bodies);
    const pPlanet = bodies.find(b => b.id === currentParent.parent);
    const mu_planet = pPlanet ? muOf(pPlanet.id, bodies) : mu_cp;
    const r_moon_orb = currentParent.orbitRadius;
    const v_needed = Math.sqrt(v_inf_origin ** 2 + 2 * mu_planet / r_moon_orb);
    const v_moon_c = Math.sqrt(mu_planet / r_moon_orb);
    const v_inf_m = Math.abs(v_needed - v_moon_c);
    const v_cur = Math.sqrt(mu_moon * (2 / r_pe - 1 / a_current));
    const v_b = Math.sqrt(v_inf_m ** 2 + 2 * mu_moon / r_pe);
    dv_injection = (isOutbound ? 1 : -1) * (v_b - v_cur);
    const v_esc = Math.sqrt(2 * mu_moon / r_pe);
    dv_min_search = v_esc - v_cur;
    dv_max_search = Math.max(Math.abs(dv_injection) * 2.5, dv_min_search * 4.0);
  }

  // ── Capture dv estimate (local SOI capture, not heliocentric) ──
  const mu_capture = muOf(target.id, bodies);
  const r_target_pe = target.soi / 2;
  const v_capture_pe = Math.sqrt(v_inf_target ** 2 + 2 * mu_capture / r_target_pe);
  const v_target_circ = Math.sqrt(mu_capture / r_target_pe);
  const dv_brake = v_capture_pe - v_target_circ;

  console.log(`[TRANSFER] Planning ${transferCase}: ${currentParent.name} → ${target.name}`);
  console.log(`[TRANSFER] Hohmann estimate: dv_inj=${dv_injection.toFixed(3)} dv_brake=${dv_brake.toFixed(3)} transferTime=${transferTime.toFixed(1)}`);
  console.log(`[TRANSFER] Search range: dv=[${dv_min_search.toFixed(3)}, ${dv_max_search.toFixed(3)}]`);

  // ── Grid search: try (burnTime, dv) combinations and simulate ──
  // Lookahead for SOI scanning
  const simLookahead = Math.min(transferTime * 2 + 100, TRAJ_MAX_TICKS);

  /**
   * Simulate a departure burn and walk the SOI chain to find target encounter.
   * Returns the post-capture orbit with _brakeDv attached, or null if no encounter.
   */
  function simulateChain(injectionDv: number, burnTime: number): (OrbitElements & { _brakeDv?: number }) | null {
    // Build a temporary ManeuverNode for the injection burn
    const injNode: ManeuverNode = {
      id: '__grid_inj__', shipId: '', type: 'manual_burn',
      burnTime,
      deltav: injectionDv,
      prograde: injectionDv,
      radial: 0,
      normal: 0,
      status: 'planned',
    };

    const cursorOrbit = applyNodeToOrbit(orbit, injNode, bodies);

    // Walk through SOI transitions looking for target encounter
    let scanOrbit = cursorOrbit;
    let scanTick = burnTime;
    let encounter: SOIEvent | null = null;

    for (let i = 0; i < 16; i++) {
      const ev = findNextSOIEvent(scanOrbit, scanTick, simLookahead, bodies);
      if (!ev) break;
      if (ev.type === 'enter' && ev.body && ev.body.id === target.id) {
        encounter = ev;
        break;
      }
      if (!ev.newOrbit) break;
      scanOrbit = ev.newOrbit;
      scanTick = ev.t;
    }

    // If no encounter found via standard SOI check, do a near-miss sweep
    // using a generous 1.3x SOI radius for the target
    if (!encounter && scanOrbit.parentBodyId === (target.parent || 'sol')) {
      const sweepStep = 0.5;
      const sweepLimit = Math.min(simLookahead, scanOrbit.period * 2);
      for (let dt = sweepStep; dt <= sweepLimit; dt += sweepStep) {
        const t = scanTick + dt;
        const pos = orbitWorldPos(scanOrbit, t, bodies);
        const tp = bodyPosition(target, t, bodies);
        const dist = Math.hypot(pos.x - tp.x, pos.y - tp.y);
        if (dist < target.soi * 1.3) {
          const vel = orbitWorldVelocity(scanOrbit, t, bodies);
          const newOrbit = orbitFromWorldState(pos.x, pos.y, vel.x, vel.y, target.id, t, bodies);
          if (newOrbit) {
            encounter = { type: 'enter', t, body: target, newOrbit };
          }
          break;
        }
      }
    }

    if (!encounter || !encounter.newOrbit) return null;

    // We found an encounter! Compute the capture burn dv.
    const encOrbit = encounter.newOrbit;
    const tPeri = nextApsisTime(encOrbit, encounter.t, 'periapsis');
    const mu_t = muOf(target.id, bodies);
    const enc_a = semiMajor(encOrbit);
    const v_pe = Math.sqrt(mu_t * (2 / encOrbit.rp - 1 / enc_a));
    const v_circ = Math.sqrt(mu_t / encOrbit.rp);
    const actualBrakeDv = -(v_pe - v_circ);

    // Apply brake to see resulting orbit quality
    const brakeNode: ManeuverNode = {
      id: '__grid_brake__', shipId: '', type: 'manual_burn',
      burnTime: tPeri,
      deltav: actualBrakeDv,
      prograde: actualBrakeDv,
      radial: 0,
      normal: 0,
      status: 'planned',
    };
    const postOrbit = applyNodeToOrbit(encOrbit, brakeNode, bodies);
    (postOrbit as any)._brakeDv = actualBrakeDv;
    return postOrbit;
  }

  const targetSOI = target.soi;
  let bestPlan: { burnT: number; dv: number; brakeDv: number; postOrbit: OrbitElements } | null = null;
  let bestPlanScore = Infinity;

  // ── Phase angle timing ──
  let omega_o: number, omega_t: number, angle0_o: number, angle0_t: number;

  if (transferCase === 'planet-planet') {
    omega_o = TWO_PI / currentParent.orbitPeriod;
    omega_t = TWO_PI / target.orbitPeriod;
    angle0_o = currentParent.angle0;
    angle0_t = target.angle0;
  } else if (transferCase === 'to-moon') {
    omega_o = TWO_PI / orbit.period;
    omega_t = TWO_PI / target.orbitPeriod;
    angle0_o = orbit.omega + orbit.M0 - (TWO_PI / orbit.period) * (orbit.epoch || 0);
    angle0_t = target.angle0;
  } else if (transferCase === 'moon-moon') {
    omega_o = TWO_PI / originBody!.orbitPeriod;
    omega_t = TWO_PI / targetBody.orbitPeriod;
    angle0_o = originBody!.angle0;
    angle0_t = targetBody.angle0;
  } else /* moon-to-planet */ {
    const pPlanet2 = bodies.find(b => b.id === currentParent.parent);
    omega_o = TWO_PI / (pPlanet2 ? pPlanet2.orbitPeriod : 1000);
    omega_t = TWO_PI / target.orbitPeriod;
    angle0_o = pPlanet2 ? pPlanet2.angle0 : 0;
    angle0_t = target.angle0;
  }

  const requiredLeadAngle = Math.PI - omega_t * transferTime;
  const diff0 = angle0_t - angle0_o;
  const dDiff = omega_t - omega_o;
  const fallbackPeriod = (target.orbitPeriod || 1000) * 10;
  const synodic = Math.abs(dDiff) > 1e-9 ? TWO_PI / Math.abs(dDiff) : fallbackPeriod;

  let tPhase = (requiredLeadAngle - diff0) / dDiff;
  const periodK = TWO_PI / Math.abs(dDiff);
  while (tPhase < currentTick) tPhase += periodK;

  const shipPeriod = orbit.period;

  // Build search windows: list of { tCenter, windowHalf, dvMin, dvMax }
  type SearchWindow = { tCenter: number; windowHalf: number; dvMin: number; dvMax: number };
  const windows: SearchWindow[] = [];

  if (strategy === 'quickest') {
    // Quick transfer: search near "now" with wider dv range
    const quickWindowHalf = Math.max(shipPeriod * 3, 12);
    const quickDvMax = Math.max(dv_max_search * 3, dv_min_search * 6);
    windows.push({
      tCenter: currentTick + quickWindowHalf,
      windowHalf: quickWindowHalf,
      dvMin: dv_min_search * 0.9,
      dvMax: quickDvMax,
    });
  } else {
    // Efficient / soonest: search around optimal Hohmann windows
    const maxWindows = strategy === 'soonest' ? 2 : 4;
    for (let w = 0; w < maxWindows; w++) {
      const tCenter = tPhase + w * periodK;
      if (tCenter - currentTick > synodic * 2) break;
      windows.push({
        tCenter,
        windowHalf: Math.max(shipPeriod * 2, 8),
        dvMin: dv_min_search * 0.95,
        dvMax: dv_max_search,
      });
    }
  }

  for (const win of windows) {
    const dvRange = win.dvMax - win.dvMin;
    const dvStep = Math.max(0.005, dvRange / 140);
    const dtStep = Math.max(0.2, shipPeriod / 14);

    for (let dt = -win.windowHalf; dt <= win.windowHalf; dt += dtStep) {
      const t_candidate = win.tCenter + dt;
      if (t_candidate <= currentTick) continue;

      for (let dvMag = win.dvMin; dvMag <= win.dvMax; dvMag += dvStep) {
        const dv = (transferCase === 'to-moon' && !isOutbound) ? -dvMag : dvMag;
        const probe = simulateChain(dv, t_candidate);
        if (!probe) continue;

        if (probe.rp > 0.5 && probe.ra < targetSOI * 0.95) {
          const actualBrake = (probe as any)._brakeDv || 0;
          let score: number;
          if (strategy === 'quickest') {
            score = t_candidate + Math.abs(dv) * 0.1;
          } else if (strategy === 'soonest') {
            score = t_candidate + Math.abs(actualBrake) * 0.01;
          } else {
            score = Math.abs(dv) + Math.abs(actualBrake);
          }
          if (score < bestPlanScore) {
            bestPlan = { burnT: t_candidate, dv, brakeDv: actualBrake, postOrbit: probe };
            bestPlanScore = score;
          }
        }
      }
      if ((strategy === 'quickest' || strategy === 'soonest') && bestPlan) break;
    }
    if (bestPlan) break;
  }

  // ── Build the result ──
  let bestBurnT: number;
  let dv_injection_final: number;
  let dv_brake_final: number;

  if (bestPlan) {
    bestBurnT = bestPlan.burnT;
    dv_injection_final = bestPlan.dv;
    dv_brake_final = Math.abs(bestPlan.brakeDv);

    // Refine the brake dv with a fresh simulation
    const refinedBrake = refineBrakeDv(orbit, dv_injection_final, bestBurnT, dv_brake_final, target, bodies);
    if (refinedBrake !== null) {
      dv_brake_final = refinedBrake;
    }

    console.log(`[TRANSFER] Grid search SUCCESS: burnT=${bestBurnT.toFixed(1)} dv=${dv_injection_final.toFixed(3)} brakeDv=${dv_brake_final.toFixed(3)}`);
  } else {
    // Fallback to analytic Hohmann estimate (may not produce encounter)
    bestBurnT = currentTick + 1;
    dv_injection_final = dv_injection;
    dv_brake_final = dv_brake;
    console.log('[TRANSFER] Grid search FAILED — using analytic fallback');
  }

  // Estimated arrival time
  const arrivalTime = bestBurnT + transferTime;

  return {
    burns: [
      {
        dv: dv_injection_final,
        timing: bestBurnT,
        label: `Transfer burn — ${isOutbound ? 'outbound' : 'inbound'} to ${target.name}`,
      },
      {
        dv: -dv_brake_final,  // retrograde
        timing: arrivalTime,
        label: `Capture at ${target.name}`,
        capturedAtBody: targetBodyId,
      },
    ],
    target: target.name,
    fromBody: currentParent.name,
    dvTotal: Math.abs(dv_injection_final) + dv_brake_final,
    hasValidPlan: bestPlan !== null,
  };
}

/**
 * Refine the capture brake dv by re-simulating the injection and finding
 * the exact encounter orbit's periapsis speed.
 * Ported from HTML prototype's refineBrakeDv.
 */
function refineBrakeDv(
  shipOrbit: OrbitElements,
  injectionDv: number,
  injectionT: number,
  initialBrakeDv: number,
  target: Body,
  bodies: Body[]
): number | null {
  const injNode: ManeuverNode = {
    id: '__refine_inj__', shipId: '', type: 'manual_burn',
    burnTime: injectionT,
    deltav: injectionDv,
    prograde: injectionDv,
    radial: 0,
    normal: 0,
    status: 'planned',
  };
  const postInjOrbit = applyNodeToOrbit(shipOrbit, injNode, bodies);

  let scanOrbit = postInjOrbit;
  let scanTick = injectionT;
  let encounter: SOIEvent | null = null;

  for (let i = 0; i < 10; i++) {
    const ev = findNextSOIEvent(scanOrbit, scanTick, TRAJ_MAX_TICKS, bodies);
    if (!ev) break;
    if (ev.type === 'enter' && ev.body && ev.body.id === target.id) {
      encounter = ev;
      break;
    }
    if (!ev.newOrbit) break;
    scanOrbit = ev.newOrbit;
    scanTick = ev.t;
  }
  if (!encounter || !encounter.newOrbit) return initialBrakeDv;

  const approachOrbit = encounter.newOrbit;
  const mu = muOf(target.id, bodies);
  const a = semiMajor(approachOrbit);
  const rPeri = approachOrbit.rp;
  const visVivaArg = 2 / rPeri - 1 / a;
  const vAtPeri = visVivaArg > 0 ? Math.sqrt(mu * visVivaArg) : Math.sqrt(mu / rPeri);
  const targetRa = Math.min(target.soi * 0.3, target.radius * 10);
  const aTarget = (rPeri + targetRa) / 2;
  const vTarget = Math.sqrt(mu * (2 / rPeri - 1 / aTarget));
  const exactBrake = vAtPeri - vTarget;
  return exactBrake > 0 ? exactBrake : initialBrakeDv;
}

/**
 * Constants for trajectory computation
 */
const TRAJ_MAX_ARCS = 10;
const TRAJ_MAX_TICKS = 2000;
const TRAJ_STEP = 1;
const TRAJ_ORBITS_AHEAD = 2;

/**
 * Bisect to find the exact time when orbit exits a body's SOI
 * Assumes tA is inside SOI and tB is outside
 */
export function bisectSOIExit(
  orbit: OrbitElements,
  parent: Body,
  tA: number,
  tB: number,
  bodies: Body[]
): number {
  for (let i = 0; i < 30; i++) {
    const tm = (tA + tB) / 2;
    const pos = orbitWorldPos(orbit, tm, bodies);
    const pp = bodyPosition(parent, tm, bodies);
    const dx = pos.x - pp.x;
    const dy = pos.y - pp.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < parent.soi) {
      tA = tm;
    } else {
      tB = tm;
    }
    if (tB - tA < 1e-4) break;
  }
  return (tA + tB) / 2;
}

/**
 * Bisect to find the exact time when orbit enters a body's SOI
 * Assumes tA is outside SOI and tB is inside
 */
export function bisectSOIEnter(
  orbit: OrbitElements,
  body: Body,
  tA: number,
  tB: number,
  bodies: Body[]
): number {
  for (let i = 0; i < 30; i++) {
    const tm = (tA + tB) / 2;
    const pos = orbitWorldPos(orbit, tm, bodies);
    const bp = bodyPosition(body, tm, bodies);
    const dx = pos.x - bp.x;
    const dy = pos.y - bp.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > body.soi) {
      tA = tm;
    } else {
      tB = tm;
    }
    if (tB - tA < 1e-4) break;
  }
  return (tA + tB) / 2;
}

/**
 * Apply a maneuver node to an orbit to get the post-burn orbit.
 * Matches HTML prototype: works in local frame with prograde + radial components,
 * uses orbitFromStateVector with known semi-major axis.
 *
 * Supports two calling conventions:
 *   applyNodeToOrbit(orbit, node, bodies)           — new (ManeuverNode with prograde/radial)
 *   applyNodeToOrbit(orbit, dv, burnTime, bodies)   — legacy (scalar dv, prograde-only)
 */
export function applyNodeToOrbit(
  preOrbit: OrbitElements,
  nodeOrDv: ManeuverNode | number,
  bodiesOrBurnTime: Body[] | number,
  legacyBodies?: Body[]
): OrbitElements {
  // Handle legacy calling convention: (orbit, dv, burnTime, bodies)
  let node: ManeuverNode;
  let bodies: Body[];
  if (typeof nodeOrDv === 'number') {
    const dv = nodeOrDv as number;
    const burnTime = bodiesOrBurnTime as number;
    bodies = legacyBodies!;
    node = {
      id: '', shipId: '', type: 'manual_burn',
      burnTime,
      deltav: dv,
      prograde: dv,
      radial: 0,
      normal: 0,
      status: 'planned',
    };
  } else {
    node = nodeOrDv as ManeuverNode;
    bodies = bodiesOrBurnTime as Body[];
  }
  const { prograde, radialOut } = velocityVectorsAt(preOrbit, node.burnTime);
  const local = localPositionAt(preOrbit, node.burnTime);
  const a = semiMajor(preOrbit);
  const r = Math.sqrt(local.x * local.x + local.y * local.y);
  const mu = muOf(preOrbit.parentBodyId, bodies);

  // Pre-burn speed via vis-viva, clamped to non-negative (safe for fake large ellipses)
  const visVivaIn = 2 / r - 1 / a;
  const speed = visVivaIn > 0 ? Math.sqrt(mu * visVivaIn) : 0;

  // Pre-burn velocity in local frame (unit prograde * speed)
  const oldVx = prograde.x * speed;
  const oldVy = prograde.y * speed;

  // Add delta-v components along prograde and radial-out directions
  const dvx = prograde.x * node.prograde + radialOut.x * node.radial;
  const dvy = prograde.y * node.prograde + radialOut.y * node.radial;
  const newVx = oldVx + dvx;
  const newVy = oldVy + dvy;
  const newSpeed = Math.sqrt(newVx * newVx + newVy * newVy);

  // New semi-major axis from vis-viva:
  //   v_new² = μ · (2/r - 1/a_new)   =>   a_new = 1 / (2/r - v_new²/μ)
  const energyTerm = 2 / r - (newSpeed * newSpeed) / mu;
  let newA: number;
  if (energyTerm <= 0) {
    // Escape trajectory — model as a very wide ellipse (matches HTML)
    const parentBody = bodies.find(b => b.id === preOrbit.parentBodyId);
    const soiR = (parentBody && parentBody.soi !== Infinity) ? parentBody.soi : r * 50;
    newA = soiR * 50;
  } else {
    newA = 1 / energyTerm;
  }

  const newOrbit = orbitFromStateVector(
    local.x, local.y, newVx, newVy,
    newA, preOrbit.parentBodyId, node.burnTime, preOrbit.period, a
  );
  if (!newOrbit) return preOrbit;

  if (energyTerm <= 0) {
    (newOrbit as any).escapeEnergy = (newSpeed * newSpeed) / mu - 2 / r;
    (newOrbit as any).escapeState = { rx: local.x, ry: local.y, vx: newVx, vy: newVy, t: node.burnTime };
  }

  return newOrbit;
}

/**
 * Compute trajectory: projects a ship's path through space following current orbit and nodes
 * Returns sequence of arcs, each describing motion within a single parent body's SOI
 * Accepts nodes with burnTime/prograde/radial (ManeuverNode) or simple { t, dv } objects
 */
export function computeTrajectory(
  baseOrbit: OrbitElements,
  nodes: Array<{ t: number; dv: number; prograde?: number; radial?: number; burnTime?: number; capturedAtBody?: string }>,
  tStart: number,
  bodies: Body[]
): TrajectoryArc[] {
  const arcs: TrajectoryArc[] = [];
  let currentOrbit = baseOrbit;
  let tCursor = tStart;
  const tEnd = tStart + TRAJ_MAX_TICKS;

  // Sort nodes by time and filter to future ones
  const sortedNodes = [...nodes]
    .filter(n => n.t >= tStart)
    .sort((a, b) => a.t - b.t);
  let nodeIdx = 0;
  let prevParentId: string | null = null;

  for (let arcCount = 0; arcCount < TRAJ_MAX_ARCS && tCursor < tEnd; arcCount++) {
    let t = tCursor;
    let event: { type: 'exit' | 'enter' | 'node'; t: number; fromBody?: string; intoBody?: string } | null = null;

    // eslint-disable-next-line no-loop-func
    const currentParent = bodies.find(b => b.id === currentOrbit.parentBodyId);
    if (!currentParent) break;

    // After escape: skip the body we just left (it's a child of our new parent)
    // Only applies when the parent changed (escape from child → grandparent)
    const skipSOIs = new Set<string>();
    if (prevParentId && prevParentId !== currentOrbit.parentBodyId) {
      // eslint-disable-next-line no-loop-func
      const prevBody = bodies.find(b => b.id === prevParentId);
      if (prevBody && prevBody.parent === currentOrbit.parentBodyId) {
        const arcStartPos = orbitWorldPos(currentOrbit, tCursor, bodies);
        const bp = bodyPosition(prevBody, tCursor, bodies);
        const dist = Math.hypot(arcStartPos.x - bp.x, arcStartPos.y - bp.y);
        if (dist < prevBody.soi) skipSOIs.add(prevParentId);
      }
    }

    const nextNode = sortedNodes[nodeIdx];
    const nodeT = nextNode ? nextNode.t : Infinity;
    // Arc budget: project at most TRAJ_ORBITS_AHEAD periods, but always reach the next node
    const orbitBudget = tCursor + currentOrbit.period * TRAJ_ORBITS_AHEAD;
    const arcBudget = Math.min(tEnd, nodeT < Infinity ? Math.max(orbitBudget, nodeT) : orbitBudget);

    while (t < arcBudget && t < nodeT) {
      const nextT = Math.min(t + TRAJ_STEP, arcBudget, nodeT);

      // Position at nextT on currentOrbit
      const pos = orbitWorldPos(currentOrbit, nextT, bodies);

      // Check SOI containment relative to currentParent
      if (currentParent.id !== 'sol') {
        const pp = bodyPosition(currentParent, nextT, bodies);
        const dx = pos.x - pp.x;
        const dy = pos.y - pp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > currentParent.soi) {
          // Crossing OUT of currentParent's SOI
          const tCross = bisectSOIExit(currentOrbit, currentParent, t, nextT, bodies);
          event = { type: 'exit', t: tCross, fromBody: currentParent.id };
          break;
        }
      }

      // Check entry into any child body's SOI
      let entered: { type: 'enter'; t: number; intoBody: string } | null = null;
      for (const body of bodies) {
        if (body.id === 'sol') continue;
        if (body.id === currentOrbit.parentBodyId) continue;
        if (body.parent !== currentOrbit.parentBodyId) continue;

        const bp = bodyPosition(body, nextT, bodies);
        const dx = pos.x - bp.x;
        const dy = pos.y - bp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Skip bodies the ship started inside (from escape burns)
        if (skipSOIs.has(body.id)) {
          if (dist > body.soi) skipSOIs.delete(body.id);
          continue;
        }

        if (dist < body.soi) {
          const tEnter = bisectSOIEnter(currentOrbit, body, t, nextT, bodies);

          // Flythrough check: compute orbit at SOI boundary
          // If orbit apoapsis extends past SOI, this is a grazing encounter — skip it
          // BUT: if there's a pending capture node for this body, always accept the encounter
          const currentNodeIdx = nodeIdx;
          const hasCapture = sortedNodes.some(
            (n, idx) => idx >= currentNodeIdx && n.capturedAtBody === body.id
          );
          if (!hasCapture) {
            const wpTest = orbitWorldPos(currentOrbit, tEnter, bodies);
            const wvTest = orbitWorldVelocity(currentOrbit, tEnter, bodies);
            const testOrbit = orbitFromWorldState(wpTest.x, wpTest.y, wvTest.x, wvTest.y, body.id, tEnter, bodies);
            if (testOrbit) {
              const testE = eccentricity(testOrbit);
              if (testE < 1 && testOrbit.ra > body.soi) {
                skipSOIs.add(body.id);
                continue;
              }
            }
          }

          if (!entered || tEnter < entered.t) {
            entered = { type: 'enter', t: tEnter, intoBody: body.id };
          }
        }
      }
      if (entered) {
        event = entered;
        break;
      }

      t = nextT;
    }

    if (event) {
      arcs.push({
        orbit: currentOrbit,
        tStart: tCursor,
        tEnd: event!.t,
        endReason: event!.type,
      });

      prevParentId = currentOrbit.parentBodyId;

      // Re-anchor: compute new orbit relative to new parent
      if (event!.type === 'exit' && event!.fromBody) {
        const parentOfParent = bodies.find(b => b.id === event!.fromBody)?.parent;
        if (!parentOfParent) break;

        const wp = orbitWorldPos(currentOrbit, event.t, bodies);
        const wv = orbitWorldVelocity(currentOrbit, event.t, bodies);
        const newOrbit = orbitFromWorldState(
          wp.x,
          wp.y,
          wv.x,
          wv.y,
          parentOfParent,
          event.t,
          bodies
        );
        if (!newOrbit) break;
        currentOrbit = newOrbit;
        tCursor = event.t;
      } else if (event!.type === 'enter' && event!.intoBody) {
        const wp = orbitWorldPos(currentOrbit, event!.t, bodies);
        const wv = orbitWorldVelocity(currentOrbit, event!.t, bodies);
        const newOrbit = orbitFromWorldState(
          wp.x,
          wp.y,
          wv.x,
          wv.y,
          event!.intoBody,
          event!.t,
          bodies
        );
        if (!newOrbit) break;

        // Check if there's a capture node for this body — consume it and
        // create a stable circular orbit instead of the raw flyby trajectory
        const capNodeIdx = nodeIdx;
        const capIdx = sortedNodes.findIndex(
          (n, idx) => idx >= capNodeIdx && n.capturedAtBody === event!.intoBody
        );
        if (capIdx >= 0) {
          const targetBody = bodies.find(b => b.id === event!.intoBody);
          const mu_cap = muOf(event!.intoBody!, bodies);
          const local_cap = localPositionAt(newOrbit, event!.t);
          const r_cap = Math.sqrt(local_cap.x * local_cap.x + local_cap.y * local_cap.y);
          const capR = Math.min(r_cap, targetBody ? targetBody.soi * 0.8 : r_cap);
          const omega_cap = Math.atan2(local_cap.y, local_cap.x);
          currentOrbit = {
            rp: capR,
            ra: capR,
            omega: omega_cap,
            M0: 0,
            epoch: event!.t,
            direction: newOrbit.direction,
            period: TWO_PI * Math.sqrt(capR * capR * capR / mu_cap),
            parentBodyId: event!.intoBody!,
          };
          // Skip all nodes up to and including the capture node
          nodeIdx = capIdx + 1;
        } else {
          currentOrbit = newOrbit;
        }
        tCursor = event!.t;
      }
    } else if (t >= nodeT && nextNode) {
      // Capture nodes are consumed on SOI entry, not at their scheduled time
      if (nextNode.capturedAtBody) {
        nodeIdx++;
        continue;
      }
      // Hit a maneuver node - close arc and apply node
      arcs.push({
        orbit: currentOrbit,
        tStart: tCursor,
        tEnd: nextNode.t,
        endReason: 'node',
      });
      prevParentId = currentOrbit.parentBodyId;
      // Build a ManeuverNode-like object for the new applyNodeToOrbit signature
      const nodeForApply: ManeuverNode = {
        id: '', shipId: '', type: 'manual_burn',
        burnTime: nextNode.burnTime ?? nextNode.t,
        deltav: nextNode.dv,
        prograde: nextNode.prograde ?? nextNode.dv,
        radial: nextNode.radial ?? 0,
        normal: 0,
        status: 'planned',
      };
      currentOrbit = applyNodeToOrbit(currentOrbit, nodeForApply, bodies);
      tCursor = nextNode.t;
      nodeIdx++;
    } else {
      // Budget exhausted with no event
      arcs.push({
        orbit: currentOrbit,
        tStart: tCursor,
        tEnd: arcBudget,
        endReason: 'budget',
      });
      break;
    }
  }

  return arcs;
}

