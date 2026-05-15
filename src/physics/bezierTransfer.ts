import { OrbitElements, Body, TransferArc } from '../types';
import { bodyPosition, GRAVITATIONAL_PARAMS } from './orbitalMechanics';

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

  // For planet-to-planet: both must orbit Sol (or we go via parent)
  const depParent = departureBody.parent;
  const arrParent = arrivalBody.parent;

  let r1: number, r2: number;
  let depBody: Body, arrBody: Body;

  if (depParent === 'sol' && arrParent === 'sol') {
    // Direct planet-to-planet
    r1 = departureBody.orbitRadius;
    r2 = arrivalBody.orbitRadius;
    depBody = departureBody;
    arrBody = arrivalBody;
  } else if (depParent === 'sol' && arrParent !== 'sol') {
    // Planet to moon: transfer to the moon's parent planet
    const parentPlanet = bodies.find(b => b.id === arrParent);
    if (!parentPlanet || parentPlanet.parent !== 'sol') return null;
    r1 = departureBody.orbitRadius;
    r2 = parentPlanet.orbitRadius;
    depBody = departureBody;
    arrBody = parentPlanet;
  } else if (depParent !== 'sol' && arrParent === 'sol') {
    // Moon to planet: treat departure as the parent planet
    const parentPlanet = bodies.find(b => b.id === depParent);
    if (!parentPlanet || parentPlanet.parent !== 'sol') return null;
    r1 = parentPlanet.orbitRadius;
    r2 = arrivalBody.orbitRadius;
    depBody = parentPlanet;
    arrBody = arrivalBody;
  } else {
    return null;
  }

  // Hohmann transfer math
  const a_transfer = (r1 + r2) / 2;
  const travelTime = Math.PI * Math.sqrt(a_transfer * a_transfer * a_transfer / MU_SUN);

  // Vis-viva Δv
  const v1_circ = Math.sqrt(MU_SUN / r1);
  const v1_trans = Math.sqrt(MU_SUN * (2 / r1 - 1 / a_transfer));
  const departureDv = Math.abs(v1_trans - v1_circ);

  const v2_circ = Math.sqrt(MU_SUN / r2);
  const v2_trans = Math.sqrt(MU_SUN * (2 / r2 - 1 / a_transfer));
  const arrivalDv = Math.abs(v2_circ - v2_trans);

  let departureTime: number;

  if (strategy === 'quickest') {
    departureTime = currentTick + 5;
  } else {
    // Efficient: find next Hohmann window via phase angle
    const requiredPhaseAngle = Math.PI * (1 - Math.pow((r1 + r2) / (2 * r2), 1.5));
    const currentDepAngle = depBody.angle0 + TWO_PI * currentTick / depBody.orbitPeriod;
    const currentArrAngle = arrBody.angle0 + TWO_PI * currentTick / arrBody.orbitPeriod;
    let currentPhase = ((currentArrAngle - currentDepAngle) % TWO_PI + TWO_PI) % TWO_PI;

    // Synodic period
    const n1 = TWO_PI / depBody.orbitPeriod;
    const n2 = TWO_PI / arrBody.orbitPeriod;
    const synodicPeriod = TWO_PI / Math.abs(n1 - n2);

    // How much phase angle changes per tick
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

  const controlPoints = computeBezierControlPoints(
    depBody, arrBody, departureTime, arrivalTime, bodies
  );

  const depName = departureBody.name;
  const arrName = arrivalBody.id === targetBodyId
    ? arrivalBody.name
    : bodies.find(b => b.id === targetBodyId)?.name || arrivalBody.name;

  return {
    id: `transfer-${Date.now()}-${Math.random()}`,
    departureBodyId: departureBody.id,
    arrivalBodyId: targetBodyId,
    departureTime,
    arrivalTime,
    departureDv,
    arrivalDv,
    label: `${depName} → ${arrName}`,
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
