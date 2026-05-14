// ============================================================
// Orbital Mechanics - Physics calculations
// Extracted from the prototype and refactored for reuse
// ============================================================

import { OrbitElements, Body, TrajectoryArc } from '../types';

const TWO_PI = Math.PI * 2;

// Gravitational parameters (G·M for each body)
// These match the prototype values
export const GRAVITATIONAL_PARAMS = {
  SOL: 4 * Math.PI * Math.PI * Math.pow(130, 3) / Math.pow(88, 2),
  PLANET: 200,     // terrestrial planets
  GAS_GIANT: 600,  // gas giants
} as const;

/**
 * Get gravitational parameter μ for a body
 */
export function muOf(bodyId: string, bodies: Body[]): number {
  if (bodyId === 'sol') return GRAVITATIONAL_PARAMS.SOL;
  const body = bodies.find(b => b.id === bodyId);
  if (!body) return GRAVITATIONAL_PARAMS.PLANET;
  if (body.type === 'gas_giant') return GRAVITATIONAL_PARAMS.GAS_GIANT;
  return GRAVITATIONAL_PARAMS.PLANET;
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
  // Newton-Raphson iteration to solve Kepler's equation
  let E = M; // initial guess
  for (let i = 0; i < 20; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }

  // Convert eccentric anomaly to true anomaly
  // tan(θ/2) = sqrt((1+e)/(1-e)) · tan(E/2)
  let theta: number;
  if (e < 1e-9) {
    theta = E;
  } else {
    theta = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2)
    );
    if (theta < 0) theta += TWO_PI;
  }
  return theta;
}

/**
 * Get true anomaly at a given time
 */
export function trueAnomalyAt(orbit: OrbitElements, t: number): number {
  const e = eccentricity(orbit);

  // Convert stored M0 (true anomaly at epoch) to mean anomaly form
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

  // Mean anomaly at time t
  let M = M0_mean + TWO_PI * (t - orbit.epoch) / orbit.period;
  // Normalize to [0, 2π)
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;

  return solveKepler(M, e);
}

/**
 * Get radius at a given true anomaly
 * r = a(1-e²) / (1 + e·cos(θ))
 */
export function radiusAt(orbit: OrbitElements, theta: number): number {
  const a = semiMajor(orbit);
  const e = eccentricity(orbit);
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
  const dt = 0.01;
  const p1 = orbitWorldPos(orbit, t, bodies);
  const p2 = orbitWorldPos(orbit, t + dt, bodies);
  return { x: (p2.x - p1.x) / dt, y: (p2.y - p1.y) / dt };
}

/**
 * Convert world-frame state vector to orbit
 * Returns orbit elements or null if invalid
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
  const direction = cross >= 0 ? 1 : -1;
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
  let newA: number;
  if (energyTerm <= 0.0001) {
    newA = r * 3;
  } else {
    newA = 1 / energyTerm;
    newA = Math.max(15, newA);
  }

  // Solve for eccentricity
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

  const eSq = Math.max(0, Math.min(0.99, 1 - q));
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

  return {
    rp,
    ra,
    omega,
    M0: theta,
    epoch: t,
    direction,
    period,
    parentBodyId,
  };
}

/**
 * Plan a Hohmann transfer between two planets in same parent (Sol)
 */
export interface TransferBurn {
  dv: number;
  timing: number; // tick time
  label: string;
}

export interface TransferPlan {
  burns: TransferBurn[];
  target: string;
  fromBody: string;
  dvTotal: number;
}

export function planTransfer(
  currentOrbit: OrbitElements,
  targetBodyId: string,
  bodies: Body[],
  currentTick: number
): TransferPlan | null {
  const target = bodies.find(b => b.id === targetBodyId);
  const fromBody = bodies.find(b => b.id === currentOrbit.parentBodyId);

  if (!target || !fromBody || target.id === 'sol' || !target.parent || !fromBody.parent) return null;
  if (target.parent !== 'sol' || fromBody.parent !== 'sol' || target.id === currentOrbit.parentBodyId) return null;

  const rCapture = target.radius! * 2 + 5;
  const muSol = GRAVITATIONAL_PARAMS.SOL;
  const muFrom = muOf(currentOrbit.parentBodyId, bodies);
  const muTarget = muOf(targetBodyId, bodies);

  const r1 = fromBody.orbitRadius;
  const r2 = target.orbitRadius;
  const aHelio = (r1 + r2) / 2;

  const vCircFrom = Math.sqrt(muSol / r1);
  const vTransferDeparture = Math.sqrt(muSol * (2 / r1 - 1 / aHelio));
  const vCircTarget = Math.sqrt(muSol / r2);
  const vTransferArrival = Math.sqrt(muSol * (2 / r2 - 1 / aHelio));

  const vInfDeparture = Math.abs(vTransferDeparture - vCircFrom);
  const vInfArrival = Math.abs(vCircTarget - vTransferArrival);

  const rDep = currentOrbit.rp;
  const vEscapeAtRp = Math.sqrt(vInfDeparture * vInfDeparture + 2 * muFrom / rDep);
  const vShipAtRp = visVivaSpeed(muFrom, rDep, semiMajor(currentOrbit));
  const dvDeparture = vEscapeAtRp - vShipAtRp;

  const rPeriApproach = rCapture;
  const vAtPeriIn = Math.sqrt(vInfArrival * vInfArrival + 2 * muTarget / rPeriApproach);
  const raPost = target.soi! * 0.7;
  const aPost = (rCapture + raPost) / 2;
  const vAtPeriOut = visVivaSpeed(muTarget, rCapture, aPost);
  const dvCapture = vAtPeriIn - vAtPeriOut;

  const TTransferHalf = Math.PI * Math.sqrt((aHelio * aHelio * aHelio) / muSol);
  const omegaTarget = TWO_PI / target.orbitPeriod;
  const requiredLeadAngle = Math.PI - omegaTarget * TTransferHalf;

  const omegaFrom = TWO_PI / fromBody.orbitPeriod;
  const diff0 = target.angle0! - fromBody.angle0!;
  const dDiff = omegaTarget - omegaFrom;

  let tDeparture = currentTick;
  if (Math.abs(dDiff) > 1e-9) {
    let tBase = (requiredLeadAngle - diff0) / dDiff;
    const periodK = TWO_PI / Math.abs(dDiff);
    while (tBase < currentTick) tBase += periodK;
    tDeparture = tBase;
  }

  return {
    burns: [
      { dv: dvDeparture, timing: tDeparture, label: `TRANSFER → ${target.name}` },
      { dv: dvCapture, timing: tDeparture + TTransferHalf, label: `CAPTURE ${target.name}` },
    ],
    target: target.name,
    fromBody: fromBody.name,
    dvTotal: dvDeparture + dvCapture,
  };
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
 * Apply a maneuver node to an orbit to get the post-burn orbit
 * Simplified: assumes instantaneous burn at the current position
 */
export function applyNodeToOrbit(
  preOrbit: OrbitElements,
  dv: number,
  bodies: Body[]
): OrbitElements {
  // Get position at node time
  const localPos = localPositionAt(preOrbit, preOrbit.epoch);
  const r = localPos.r;

  // Get world position for re-anchoring
  const parentBody = bodies.find(b => b.id === preOrbit.parentBodyId);
  if (!parentBody) return preOrbit;

  const parentPos = bodyPosition(parentBody, preOrbit.epoch, bodies);
  const worldPos = {
    x: parentPos.x + localPos.x,
    y: parentPos.y + localPos.y,
  };

  // Current velocity magnitude and direction
  const mu = muOf(preOrbit.parentBodyId, bodies);
  const vMag = visVivaSpeed(mu, r, semiMajor(preOrbit));
  const vel = velocityVectorsAt(preOrbit, preOrbit.epoch);

  // Apply prograde burn (simplification: all burn is prograde)
  const vNewMag = vMag + dv;

  // Get current world velocity
  const currentWorldVel = orbitWorldVelocity(preOrbit, preOrbit.epoch, bodies);

  // Apply delta-v in prograde direction
  const newWorldVx = currentWorldVel.x + vel.prograde.x * dv;
  const newWorldVy = currentWorldVel.y + vel.prograde.y * dv;

  // Compute new semi-major axis
  const newA = semiMajorFromVisViva(mu, r, vNewMag);

  // Re-compute orbit from new state vector
  const newOrbit = orbitFromWorldState(
    worldPos.x,
    worldPos.y,
    newWorldVx,
    newWorldVy,
    preOrbit.parentBodyId,
    preOrbit.epoch,
    bodies,
    preOrbit.period,
    newA
  );

  return newOrbit || preOrbit;
}

/**
 * Compute trajectory: projects a ship's path through space following current orbit and nodes
 * Returns sequence of arcs, each describing motion within a single parent body's SOI
 */
export function computeTrajectory(
  baseOrbit: OrbitElements,
  nodes: Array<{ t: number; dv: number }>,
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

  for (let arcCount = 0; arcCount < TRAJ_MAX_ARCS && tCursor < tEnd; arcCount++) {
    // Walk forward in time on currentOrbit until:
    // 1. We exit currentOrbit.parentBodyId's SOI
    // 2. We enter a child body's SOI
    // 3. We hit the next maneuver node
    // 4. We hit tEnd

    let t = tCursor;
    let event: { type: 'exit' | 'enter' | 'node'; t: number; fromBody?: string; intoBody?: string } | null = null;

    // eslint-disable-next-line no-loop-func
    const currentParent = bodies.find(b => b.id === currentOrbit.parentBodyId);
    if (!currentParent) break;

    // Arc budget: project at most TRAJ_ORBITS_AHEAD periods
    const arcBudget = Math.min(tEnd, tCursor + currentOrbit.period * TRAJ_ORBITS_AHEAD);
    const nextNode = sortedNodes[nodeIdx];
    const nodeT = nextNode ? nextNode.t : Infinity;

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
        // Only consider bodies whose parent matches current frame
        if (body.parent !== currentOrbit.parentBodyId) continue;

        const bp = bodyPosition(body, nextT, bodies);
        const dx = pos.x - bp.x;
        const dy = pos.y - bp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < body.soi) {
          const tEnter = bisectSOIEnter(currentOrbit, body, t, nextT, bodies);
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
      // Close arc at event time
      arcs.push({
        orbit: currentOrbit,
        tStart: tCursor,
        tEnd: event!.t,
        endReason: event!.type,
      });

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
          bodies,
          currentOrbit.period,
          semiMajor(currentOrbit)
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
          bodies,
          currentOrbit.period,
          semiMajor(currentOrbit)
        );
        if (!newOrbit) break;
        currentOrbit = newOrbit;
        tCursor = event!.t;
      }
    } else if (t >= nodeT && nextNode) {
      // Hit a maneuver node - close arc and apply node
      arcs.push({
        orbit: currentOrbit,
        tStart: tCursor,
        tEnd: nextNode.t,
        endReason: 'node',
      });
      currentOrbit = applyNodeToOrbit(currentOrbit, nextNode.dv, bodies);
      currentOrbit = { ...currentOrbit, epoch: nextNode.t };
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
