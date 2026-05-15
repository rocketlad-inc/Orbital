import { OrbitElements, Body, TransferArc } from '../types';
import { bodyPosition, muOf, GRAVITATIONAL_PARAMS } from './orbitalMechanics';

const TWO_PI = Math.PI * 2;
const MU_SUN = GRAVITATIONAL_PARAMS.SOL;

export function planBezierTransfer(
  shipOrbit: OrbitElements,
  targetBodyId: string,
  currentTick: number,
  bodies: Body[],
  /** Optional multiplier (0..1) that reduces Hohmann travel time. Defaults
   *  to 1.0 (no tech bonus). Used by the Flight Dynamics tech. */
  travelTimeMultiplier: number = 1.0,
): TransferArc | null {
  const departureBody = bodies.find(b => b.id === shipOrbit.parentBodyId);
  const arrivalBody = bodies.find(b => b.id === targetBodyId);
  if (!departureBody || !arrivalBody) return null;

  const depParent = departureBody.parent;
  const arrParent = arrivalBody.parent;

  let r1: number, r2: number;
  let depBody: Body, arrBody: Body;
  let mu = MU_SUN;

  // Planet → own moon (ship orbits Jupiter, target is Europa)
  if (departureBody.id === arrParent) {
    mu = muOf(departureBody.id, bodies);
    r1 = (shipOrbit.rp + shipOrbit.ra) / 2;
    r2 = arrivalBody.orbitRadius;
    depBody = departureBody;
    arrBody = arrivalBody;
  // Moon → own parent planet (ship orbits Europa, target is Jupiter)
  } else if (arrivalBody.id === depParent) {
    const parentPlanet = arrivalBody;
    mu = muOf(parentPlanet.id, bodies);
    r1 = departureBody.orbitRadius;
    r2 = (parentPlanet.radius + 4);
    depBody = departureBody;
    arrBody = arrivalBody;
  } else if (depParent === 'sol' && arrParent === 'sol') {
    r1 = departureBody.orbitRadius;
    r2 = arrivalBody.orbitRadius;
    depBody = departureBody;
    arrBody = arrivalBody;
  } else if (depParent === 'sol' && arrParent !== 'sol') {
    const parentPlanet = bodies.find(b => b.id === arrParent);
    if (!parentPlanet || parentPlanet.parent !== 'sol') return null;
    r1 = departureBody.orbitRadius;
    r2 = parentPlanet.orbitRadius;
    depBody = departureBody;
    arrBody = parentPlanet;
  } else if (depParent !== 'sol' && arrParent === 'sol') {
    const parentPlanet = bodies.find(b => b.id === depParent);
    if (!parentPlanet || parentPlanet.parent !== 'sol') return null;
    r1 = parentPlanet.orbitRadius;
    r2 = arrivalBody.orbitRadius;
    depBody = parentPlanet;
    arrBody = arrivalBody;
  } else if (depParent === arrParent && depParent !== 'sol') {
    // Same-parent moons (e.g. Io -> Europa at Jupiter)
    const parentPlanet = bodies.find(b => b.id === depParent);
    if (!parentPlanet) return null;
    mu = muOf(parentPlanet.id, bodies);
    r1 = departureBody.orbitRadius;
    r2 = arrivalBody.orbitRadius;
    depBody = departureBody;
    arrBody = arrivalBody;
  } else if (depParent !== 'sol' && arrParent !== 'sol') {
    // Cross-system moons (e.g. Luna -> Titan): treat as parent-to-parent
    const depPlanet = bodies.find(b => b.id === depParent);
    const arrPlanet = bodies.find(b => b.id === arrParent);
    if (!depPlanet || !arrPlanet) return null;
    if (depPlanet.parent !== 'sol' || arrPlanet.parent !== 'sol') return null;
    r1 = depPlanet.orbitRadius;
    r2 = arrPlanet.orbitRadius;
    depBody = depPlanet;
    arrBody = arrPlanet;
  } else {
    return null;
  }

  // Hohmann transfer math
  const a_transfer = (r1 + r2) / 2;
  const baseTravelTime = Math.PI * Math.sqrt(a_transfer * a_transfer * a_transfer / mu);
  const travelTime = baseTravelTime * Math.max(0.25, travelTimeMultiplier);

  // Vis-viva dv
  const v1_circ = Math.sqrt(mu / r1);
  const v1_trans = Math.sqrt(mu * (2 / r1 - 1 / a_transfer));
  const departureDv = Math.abs(v1_trans - v1_circ);

  const v2_circ = Math.sqrt(mu / r2);
  const v2_trans = Math.sqrt(mu * (2 / r2 - 1 / a_transfer));
  const arrivalDv = Math.abs(v2_circ - v2_trans);

  const departureTime = currentTick + 5;

  const arrivalTime = departureTime + travelTime;

  const isLocalTransfer = departureBody.id === arrParent || arrivalBody.id === depParent;
  const isSameParentMoons = depParent === arrParent && depParent !== 'sol';
  const isCrossSystemMoons = depParent !== 'sol' && arrParent !== 'sol' && depParent !== arrParent;

  let controlPoints;
  if (isLocalTransfer || isSameParentMoons) {
    const parentId = departureBody.id === arrParent ? departureBody.id
      : arrivalBody.id === depParent ? arrivalBody.id
      : depParent!;
    controlPoints = computeBezierControlPointsLocal(
      departureBody, arrivalBody, departureTime, arrivalTime, bodies,
      bodies.find(b => b.id === parentId)!
    );
  } else if (isCrossSystemMoons) {
    controlPoints = computeBezierControlPointsCrossSystem(
      departureBody, arrivalBody, depBody, arrBody, departureTime, arrivalTime, bodies
    );
  } else {
    controlPoints = computeBezierControlPoints(
      depBody, arrBody, departureTime, arrivalTime, bodies
    );
  }

  return {
    id: `transfer-${Date.now()}-${Math.random()}`,
    departureBodyId: departureBody.id,
    arrivalBodyId: targetBodyId,
    departureTime,
    arrivalTime,
    departureDv,
    arrivalDv,
    label: `${departureBody.name} → ${arrivalBody.name}`,
    ...controlPoints,
  };
}

function computeBezierControlPoints(
  departureBody: Body,
  arrivalBody: Body,
  departureTime: number,
  arrivalTime: number,
  bodies: Body[]
): { p0: { x: number; y: number }; p3: { x: number; y: number }; cp1: { x: number; y: number }; cp2: { x: number; y: number } } {
  const p0 = bodyPosition(departureBody, departureTime, bodies);
  const p3 = bodyPosition(arrivalBody, arrivalTime, bodies);

  // Departure tangent: prograde direction (perpendicular to radial from Sol)
  const depAngle = departureBody.angle0 + TWO_PI * departureTime / departureBody.orbitPeriod;
  const depTangent = { x: -Math.sin(depAngle), y: Math.cos(depAngle) };

  // Arrival tangent: prograde direction at arrival body's position
  const arrAngle = arrivalBody.angle0 + TWO_PI * arrivalTime / arrivalBody.orbitPeriod;
  const arrTangent = { x: -Math.sin(arrAngle), y: Math.cos(arrAngle) };

  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const armLength = dist * 0.4;

  const outbound = arrivalBody.orbitRadius >= departureBody.orbitRadius;

  const cp1 = {
    x: p0.x + depTangent.x * armLength,
    y: p0.y + depTangent.y * armLength,
  };

  // For outbound transfers, CP2 approaches from behind (against arrival tangent)
  // For inbound transfers, CP2 approaches from ahead (with arrival tangent)
  const cp2 = outbound
    ? { x: p3.x - arrTangent.x * armLength, y: p3.y - arrTangent.y * armLength }
    : { x: p3.x + arrTangent.x * armLength, y: p3.y + arrTangent.y * armLength };

  return { p0, p3, cp1, cp2 };
}

function computeBezierControlPointsLocal(
  departureBody: Body,
  arrivalBody: Body,
  departureTime: number,
  arrivalTime: number,
  bodies: Body[],
  parentPlanet: Body
): { p0: { x: number; y: number }; p3: { x: number; y: number }; cp1: { x: number; y: number }; cp2: { x: number; y: number } } {
  const p0 = bodyPosition(departureBody, departureTime, bodies);
  const p3 = bodyPosition(arrivalBody, arrivalTime, bodies);

  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const armLength = dist * 0.4;

  const depIsMoon = departureBody.parent === parentPlanet.id;
  const arrIsMoon = arrivalBody.parent === parentPlanet.id;

  let depTangent: { x: number; y: number };
  if (depIsMoon) {
    const depAngle = departureBody.angle0 + TWO_PI * departureTime / departureBody.orbitPeriod;
    depTangent = { x: -Math.sin(depAngle), y: Math.cos(depAngle) };
  } else {
    const perp = { x: -dy / dist, y: dx / dist };
    depTangent = perp;
  }

  let arrTangent: { x: number; y: number };
  if (arrIsMoon) {
    const arrAngle = arrivalBody.angle0 + TWO_PI * arrivalTime / arrivalBody.orbitPeriod;
    arrTangent = { x: -Math.sin(arrAngle), y: Math.cos(arrAngle) };
  } else {
    const perp = { x: dy / dist, y: -dx / dist };
    arrTangent = perp;
  }

  const outbound = (arrIsMoon ? arrivalBody.orbitRadius : 0) >= (depIsMoon ? departureBody.orbitRadius : 0);

  const cp1 = {
    x: p0.x + depTangent.x * armLength,
    y: p0.y + depTangent.y * armLength,
  };

  const cp2 = outbound
    ? { x: p3.x - arrTangent.x * armLength, y: p3.y - arrTangent.y * armLength }
    : { x: p3.x + arrTangent.x * armLength, y: p3.y + arrTangent.y * armLength };

  return { p0, p3, cp1, cp2 };
}

function computeBezierControlPointsCrossSystem(
  departureBody: Body,
  arrivalBody: Body,
  depPlanet: Body,
  arrPlanet: Body,
  departureTime: number,
  arrivalTime: number,
  bodies: Body[]
): { p0: { x: number; y: number }; p3: { x: number; y: number }; cp1: { x: number; y: number }; cp2: { x: number; y: number } } {
  const p0 = bodyPosition(departureBody, departureTime, bodies);
  const p3 = bodyPosition(arrivalBody, arrivalTime, bodies);

  // Use parent planet tangents for the heliocentric transfer shape
  const depAngle = depPlanet.angle0 + TWO_PI * departureTime / depPlanet.orbitPeriod;
  const depTangent = { x: -Math.sin(depAngle), y: Math.cos(depAngle) };

  const arrAngle = arrPlanet.angle0 + TWO_PI * arrivalTime / arrPlanet.orbitPeriod;
  const arrTangent = { x: -Math.sin(arrAngle), y: Math.cos(arrAngle) };

  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const armLength = dist * 0.4;

  const outbound = arrPlanet.orbitRadius >= depPlanet.orbitRadius;

  const cp1 = {
    x: p0.x + depTangent.x * armLength,
    y: p0.y + depTangent.y * armLength,
  };

  const cp2 = outbound
    ? { x: p3.x - arrTangent.x * armLength, y: p3.y - arrTangent.y * armLength }
    : { x: p3.x + arrTangent.x * armLength, y: p3.y + arrTangent.y * armLength };

  return { p0, p3, cp1, cp2 };
}

export function bezierPositionAt(
  arc: TransferArc,
  currentTick: number
): { x: number; y: number } {
  const duration = arc.arrivalTime - arc.departureTime;
  const t = Math.max(0, Math.min(1, (currentTick - arc.departureTime) / duration));

  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * arc.p0.x + 3 * mt2 * t * arc.cp1.x + 3 * mt * t2 * arc.cp2.x + t3 * arc.p3.x,
    y: mt3 * arc.p0.y + 3 * mt2 * t * arc.cp1.y + 3 * mt * t2 * arc.cp2.y + t3 * arc.p3.y,
  };
}

export function bezierTangentAt(
  arc: TransferArc,
  currentTick: number
): { x: number; y: number } {
  const duration = arc.arrivalTime - arc.departureTime;
  const t = Math.max(0, Math.min(1, (currentTick - arc.departureTime) / duration));

  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  // B'(t) = 3(1-t)²(P1-P0) + 6(1-t)t(P2-P1) + 3t²(P3-P2)
  const dx =
    3 * mt2 * (arc.cp1.x - arc.p0.x) +
    6 * mt * t * (arc.cp2.x - arc.cp1.x) +
    3 * t2 * (arc.p3.x - arc.cp2.x);
  const dy =
    3 * mt2 * (arc.cp1.y - arc.p0.y) +
    6 * mt * t * (arc.cp2.y - arc.cp1.y) +
    3 * t2 * (arc.p3.y - arc.cp2.y);

  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag < 1e-10) return { x: 1, y: 0 };
  return { x: dx / mag, y: dy / mag };
}

export function bezierPoints(
  arc: TransferArc,
  steps: number = 60
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const tick = arc.departureTime + (arc.arrivalTime - arc.departureTime) * (i / steps);
    points.push(bezierPositionAt(arc, tick));
  }
  return points;
}
