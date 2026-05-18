// ============================================================
// PHYSICS SANDBOX — Patched-conics trajectory + SOI events
// ============================================================
// Builds a multi-arc trajectory from a base orbit and a list of maneuver
// nodes. Each arc is a finite segment around a single parent body that
// ends when one of:
//   1. The ship crosses out of the current parent's SOI
//   2. The ship enters a child body's SOI
//   3. A maneuver node fires
//   4. The per-arc / total budget runs out
//
// On an SOI event the orbit is re-parameterized into the new parent's
// frame via orbitFromWorldState and projection continues. This is the
// core of the patched-conics approximation.

import { BODIES, BY_ID } from './bodies';
import {
  Orbit, orbitWorldPos, orbitWorldVelocity, orbitFromWorldState,
  bodyPosition, applyNodeToOrbit, propagateEscape,
  ManeuverDv, trueAnomalyAt, eccentricity,
} from './orbitalMath';

export const TRAJ_STEP = 0.5;
export const TRAJ_MAX_TICKS = 1500;
export const TRAJ_MAX_ARCS = 6;
export const TRAJ_ORBITS_AHEAD = 1.5;

export type AnchorKind = 'absolute' | 'periapsis' | 'apoapsis';

export interface ManeuverNode {
  id: number;
  t: number;                  // tick when the burn fires
  anchor: AnchorKind;
  dv: ManeuverDv;
  committed: boolean;
}

export interface TrajectoryArc {
  orbit: Orbit;
  tStart: number;
  tEnd: number;
  endReason: 'exit' | 'enter' | 'node' | 'budget';
  /** Set on 'enter' arcs — the body whose SOI we crossed into. */
  enteredBodyId?: string;
}

// ----- SOI bisection -----

function bisectSOIExit(orbit: Orbit, parentId: string, tA: number, tB: number): number {
  const parent = BY_ID[parentId];
  for (let i = 0; i < 30; i++) {
    const tm = (tA + tB) / 2;
    const pos = orbitWorldPos(orbit, tm);
    const pp = bodyPosition(parent, tm);
    const dx = pos.x - pp.x, dy = pos.y - pp.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < parent.soi) tA = tm; else tB = tm;
    if (tB - tA < 1e-4) break;
  }
  return (tA + tB) / 2;
}

function bisectSOIEnter(orbit: Orbit, bodyId: string, tA: number, tB: number): number {
  const body = BY_ID[bodyId];
  for (let i = 0; i < 30; i++) {
    const tm = (tA + tB) / 2;
    const pos = orbitWorldPos(orbit, tm);
    const bp = bodyPosition(body, tm);
    const dx = pos.x - bp.x, dy = pos.y - bp.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > body.soi) tA = tm; else tB = tm;
    if (tB - tA < 1e-4) break;
  }
  return (tA + tB) / 2;
}

// ----- next-apsis search (for periapsis/apoapsis anchored nodes) -----

const TWO_PI = Math.PI * 2;

export function nextApsisTime(
  orbit: Orbit,
  fromTick: number,
  which: 'periapsis' | 'apoapsis',
): number {
  const e = eccentricity(orbit);
  if (e < 1e-3) return fromTick + 1;

  const thetaNow = trueAnomalyAt(orbit, fromTick);
  const thetaTarget = which === 'apoapsis' ? Math.PI : 0;

  let tLow = fromTick;
  let tHigh = fromTick + orbit.period * 1.01;
  const samples = 60;
  let lastDiff = thetaNow - thetaTarget;
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

// ----- main trajectory builder -----

export function computeTrajectory(
  baseOrbit: Orbit,
  nodes: ManeuverNode[],
  tStart: number,
): TrajectoryArc[] {
  const arcs: TrajectoryArc[] = [];
  let currentOrbit = baseOrbit;
  let tCursor = tStart;
  const tEnd = tStart + TRAJ_MAX_TICKS;

  const sortedNodes = [...nodes].filter(n => n.t >= tStart).sort((a, b) => a.t - b.t);
  let nodeIdx = 0;

  for (let arcCount = 0; arcCount < TRAJ_MAX_ARCS && tCursor < tEnd; arcCount++) {
    let t = tCursor;
    let event: {
      type: 'exit' | 'enter';
      t: number;
      fromBodyId?: string;
      intoBodyId?: string;
    } | null = null;

    const currentParent = BY_ID[currentOrbit.parentBodyId];
    const arcBudget = Math.min(tEnd, tCursor + currentOrbit.period * TRAJ_ORBITS_AHEAD);

    const nextNode = sortedNodes[nodeIdx];
    const nodeT = nextNode ? nextNode.t : Infinity;

    // Escape orbits get numerical Verlet integration for SOI detection.
    if (currentOrbit.escapeEnergy && currentParent.id !== 'sol') {
      const result = propagateEscape(currentOrbit, tCursor, Math.min(tEnd - tCursor, 100));
      if (result && result.exited && currentParent.parent) {
        event = { type: 'exit', t: result.t, fromBodyId: currentParent.id };
        // Re-anchor at result point.
        const newOrbit = orbitFromWorldState(
          result.worldX, result.worldY, result.worldVx, result.worldVy,
          currentParent.parent, result.t,
        );
        arcs.push({
          orbit: currentOrbit, tStart: tCursor, tEnd: result.t, endReason: 'exit',
        });
        if (!newOrbit) break;
        currentOrbit = newOrbit;
        tCursor = result.t;
        continue;
      }
    }

    while (t < arcBudget && t < nodeT) {
      const nextT = Math.min(t + TRAJ_STEP, arcBudget, nodeT);
      const pos = orbitWorldPos(currentOrbit, nextT);

      // Exit current parent's SOI?
      if (currentParent.id !== 'sol') {
        const pp = bodyPosition(currentParent, nextT);
        const dx = pos.x - pp.x, dy = pos.y - pp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > currentParent.soi) {
          const tCross = bisectSOIExit(currentOrbit, currentParent.id, t, nextT);
          event = { type: 'exit', t: tCross, fromBodyId: currentParent.id };
          break;
        }
      }

      // Enter a sibling body's SOI?
      let entered: { type: 'enter'; t: number; intoBodyId: string } | null = null;
      for (const body of BODIES) {
        if (body.id === 'sol') continue;
        if (body.id === currentOrbit.parentBodyId) continue;
        if (body.parent !== currentOrbit.parentBodyId) continue;
        const bp = bodyPosition(body, nextT);
        const dx = pos.x - bp.x, dy = pos.y - bp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < body.soi) {
          const tEnter = bisectSOIEnter(currentOrbit, body.id, t, nextT);
          if (!entered || tEnter < entered.t) {
            entered = { type: 'enter', t: tEnter, intoBodyId: body.id };
          }
        }
      }
      if (entered) { event = entered; break; }

      t = nextT;
    }

    if (event) {
      arcs.push({
        orbit: currentOrbit,
        tStart: tCursor,
        tEnd: event.t,
        endReason: event.type,
        enteredBodyId: event.type === 'enter' ? event.intoBodyId : undefined,
      });

      const newParentId = event.type === 'exit'
        ? BY_ID[event.fromBodyId!].parent
        : event.intoBodyId!;
      if (!newParentId) break;

      const wp = orbitWorldPos(currentOrbit, event.t);
      const wv = orbitWorldVelocity(currentOrbit, event.t);
      const newOrbit = orbitFromWorldState(
        wp.x, wp.y, wv.x, wv.y, newParentId, event.t,
      );
      if (!newOrbit) break;
      currentOrbit = newOrbit;
      tCursor = event.t;
    } else if (nextNode && t >= nodeT) {
      arcs.push({
        orbit: currentOrbit,
        tStart: tCursor,
        tEnd: nextNode.t,
        endReason: 'node',
      });
      currentOrbit = applyNodeToOrbit(currentOrbit, nextNode.t, nextNode.dv);
      tCursor = nextNode.t;
      nodeIdx++;
    } else {
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

/**
 * Walk through all SOI events (and apply nodes in order) to determine the
 * orbit each maneuver node will be FIRED on. Result is a list of
 * { node, preBurnOrbit, postBurnOrbit } in node order — what the renderer
 * and UI need to draw handles + post-burn projections.
 */
export interface NodeLink {
  node: ManeuverNode;
  preBurnOrbit: Orbit;
  postBurnOrbit: Orbit;
}

export function computeNodeChain(
  baseOrbit: Orbit,
  nodes: ManeuverNode[],
  fromTick: number,
): NodeLink[] {
  const sortedNodes = [...nodes].sort((a, b) => a.id - b.id);
  const chain: NodeLink[] = [];
  let cursorOrbit = baseOrbit;
  let cursorTick = Math.max(fromTick, baseOrbit.epoch);

  for (const node of sortedNodes) {
    // Walk through intermediate SOI transitions before the node fires
    let walkOrbit = cursorOrbit;
    let walkTick = cursorTick;
    for (let i = 0; i < 6 && walkTick < node.t - 1e-6; i++) {
      const remaining = node.t - walkTick;
      const ev = findNextSOIEvent(walkOrbit, walkTick, Math.min(remaining + 5, TRAJ_MAX_TICKS));
      if (!ev || ev.t >= node.t) break;
      if (!ev.newOrbit) break;
      walkOrbit = ev.newOrbit;
      walkTick = ev.t;
    }
    const preBurnOrbit = walkOrbit;
    const dvMag = Math.sqrt(node.dv.prograde * node.dv.prograde + node.dv.radial * node.dv.radial);
    const postBurnOrbit = dvMag > 0
      ? applyNodeToOrbit(preBurnOrbit, node.t, node.dv)
      : preBurnOrbit;
    chain.push({ node, preBurnOrbit, postBurnOrbit });
    cursorOrbit = postBurnOrbit;
    cursorTick = node.t;
  }
  return chain;
}

/** Used by computeNodeChain to step through SOI events between nodes. */
export function findNextSOIEvent(
  orbit: Orbit,
  fromTick: number,
  maxLookahead: number,
): {
  type: 'exit' | 'enter';
  t: number;
  newOrbit: Orbit | null;
  bodyId: string;
} | null {
  const parent = BY_ID[orbit.parentBodyId];

  // Escape orbits: numerical integration
  if (orbit.escapeEnergy && parent.id !== 'sol') {
    const result = propagateEscape(orbit, fromTick, Math.min(maxLookahead, 100));
    if (result && result.exited && parent.parent) {
      const newOrbit = orbitFromWorldState(
        result.worldX, result.worldY, result.worldVx, result.worldVy,
        parent.parent, result.t,
      );
      return { type: 'exit', t: result.t, newOrbit, bodyId: parent.id };
    }
    return null;
  }

  const stepSize = 0.5;
  const limit = Math.min(maxLookahead, orbit.period * 2);
  for (let dt = stepSize; dt <= limit; dt += stepSize) {
    const t = fromTick + dt;
    const pos = orbitWorldPos(orbit, t);
    if (parent.id !== 'sol') {
      const pp = bodyPosition(parent, t);
      const dx = pos.x - pp.x, dy = pos.y - pp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > parent.soi && parent.parent) {
        const tExit = bisectSOIExit(orbit, parent.id, t - stepSize, t);
        const exitPos = orbitWorldPos(orbit, tExit);
        const exitVel = orbitWorldVelocity(orbit, tExit);
        const newOrbit = orbitFromWorldState(
          exitPos.x, exitPos.y, exitVel.x, exitVel.y,
          parent.parent, tExit,
        );
        return { type: 'exit', t: tExit, newOrbit, bodyId: parent.id };
      }
    }
    for (const body of BODIES) {
      if (body.id === 'sol' || body.id === parent.id) continue;
      if (body.parent !== parent.id) continue;
      const bp = bodyPosition(body, t);
      const dx = pos.x - bp.x, dy = pos.y - bp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < body.soi) {
        const tEnter = bisectSOIEnter(orbit, body.id, t - stepSize, t);
        const enterPos = orbitWorldPos(orbit, tEnter);
        const enterVel = orbitWorldVelocity(orbit, tEnter);
        const newOrbit = orbitFromWorldState(
          enterPos.x, enterPos.y, enterVel.x, enterVel.y,
          body.id, tEnter,
        );
        return { type: 'enter', t: tEnter, newOrbit, bodyId: body.id };
      }
    }
  }
  return null;
}

/**
 * Recompute periapsis/apoapsis anchor node times based on the orbit each
 * one will be fired on. Mutates nodes in place so the caller can re-render.
 */
export function recomputeNodeTimes(
  baseOrbit: Orbit,
  nodes: ManeuverNode[],
  fromTick: number,
): void {
  const sortedNodes = [...nodes].sort((a, b) => a.id - b.id);
  let cursorOrbit = baseOrbit;
  let cursorTick = Math.max(fromTick, baseOrbit.epoch);

  for (const node of sortedNodes) {
    if (node.anchor === 'periapsis' || node.anchor === 'apoapsis') {
      // Walk through any SOI events before scanning for the next apsis
      let walkOrbit = cursorOrbit;
      let walkTick = cursorTick;
      // Then update node.t
      node.t = nextApsisTime(walkOrbit, walkTick, node.anchor);
    } else {
      // 'absolute' — leave node.t alone, but still walk SOI events to
      // keep cursorOrbit consistent for subsequent nodes
      let walkOrbit = cursorOrbit;
      let walkTick = cursorTick;
      for (let i = 0; i < 5 && walkTick < node.t - 1e-6; i++) {
        const ev = findNextSOIEvent(walkOrbit, walkTick, Math.min(node.t - walkTick + 5, TRAJ_MAX_TICKS));
        if (!ev || ev.t >= node.t) break;
        if (!ev.newOrbit) break;
        walkOrbit = ev.newOrbit;
        walkTick = ev.t;
      }
      cursorOrbit = walkOrbit;
    }
    const dvMag = Math.sqrt(node.dv.prograde * node.dv.prograde + node.dv.radial * node.dv.radial);
    cursorOrbit = dvMag > 0
      ? applyNodeToOrbit(cursorOrbit, node.t, node.dv)
      : cursorOrbit;
    cursorTick = node.t;
  }
}
