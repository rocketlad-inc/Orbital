import { OrbitElements, Body, TransferArc } from '../types';
import { bodyPosition, muOf, GRAVITATIONAL_PARAMS } from './orbitalMechanics';

const TWO_PI = Math.PI * 2;
const MU_SUN = GRAVITATIONAL_PARAMS.SOL;

export function planBezierTransfer(
  shipOrbit: OrbitElements,
  targetBodyId: string,
  currentTick: number,
  bodies: Body[],
  strategy: 'quickest' | 'efficient' = 'quickest'
): TransferArc | null {
  const departureBody = bodies.find(b => b.id === shipOrbit.parentBodyId);
  const arrivalBody = bodies.find(b => b.id === targetBodyId);
  if (!departureBody || !arrivalBody) return null;

  const depParent = departureBody.parent;
  const arrParent = arrivalBody.parent;

  let r1: number, r2: number;
  let depBody: Body, arrBody: Body;
  let mu = MU_SUN;

  if (depParent === 'sol' && arrParent === 'sol') {
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
  const travelTime = Math.PI * Math.sqrt(a_transfer * a_transfer * a_transfer / mu);

  // Vis-viva dv
  const v1_circ = Math.sqrt(mu / r1);
  const v1_trans = Math.sqrt(mu * (2 / r1 - 1 / a_transfer));
  const departureDv = Math.abs(v1_trans - v1_circ);

  const v2_circ = Math.sqrt(mu / r2);
  const v2_trans = Math.sqrt(mu * (2 / r2 - 1 / a_transfer));
  const arrivalDv = Math.abs(v2_circ - v2_trans);

  let departureTime: number;

  if (strategy === 'quickest') {
    departureTime = currentTick + 5;
  } else {
    const requiredPhaseAngle = Math.PI * (1 - Math.pow((r1 + r2) / (2 * r2), 1.5));
    const currentDepAngle = depBody.angle0 + TWO_PI * currentTick / depBody.orbitPeriod;
    const currentArrAngle = arrBody.angle0 + TWO_PI * currentTick / arrBody.orbitPeriod;
    let currentPhase = ((currentArrAngle - currentDepAngle) % TWO_PI + TWO_PI) % TWO_PI;

    const n1 = TWO_PI / depBody.orbitPeriod;
    const n2 = TWO_PI / arrBody.orbitPeriod;
    const synodicPeriod = TWO_PI / Math.abs(n1 - n2);

    const phaseRate = n2 - n1;
    let phaseDiff = ((requiredPhaseAngle - currentPhase) % TWO_PI + TWO_PI) % TWO_PI;
    if (Math.abs(phaseRate) < 1e-12) {
      departureTime = currentTick + 5;
    } else {
      let waitTime = phaseDiff / Math.abs(phaseRate);
      if (waitTime < 5) waitTime += synodicPeriod;
      departureTime = currentTick + waitTime;
    }
  }

  const arrivalTime = departureTime + travelTime;

  // For same-parent moons, use the actual moon bodies for control points
  // For cross-system moons, use actual moons for endpoints but parent tangents
  const isSameParentMoons = depParent === arrParent && depParent !== 'sol';
  const isCrossSystemMoons = depParent !== 'sol' && arrParent !== 'sol' && depParent !== arrParent;

  let controlPoints;
  if (isSameParentMoons) {
    controlPoints = computeBezierControlPointsLocal(
      departureBody, arrivalBody, departureTime, arrivalTime, bodies,
      bodies.find(b => b.id === depParent)!
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

  // Tangents relative to parent planet
  const depAngle = departureBody.angle0 + TWO_PI * departureTime / departureBody.orbitPeriod;
  const depTangent = { x: -Math.sin(depAngle), y: Math.cos(depAngle) };

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
