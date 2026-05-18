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
/** Ticks of SOI-exit suppression after a fresh re-anchor. Prevents the
 *  ship from instantly bouncing back out of an SOI because the new
 *  orbit's reconstructed radius lies microscopically outside its parent
 *  due to floating-point noise in orbitFromWorldState. */
export const SOI_ENTRY_GRACE = 3.0;
/** Ticks of suppression on re-detecting an enter event into the body we
 *  just exited. After a clean exit, the re-anchored heliocentric orbit
 *  can land microscopically back inside the exited body's SOI due to
 *  reconstruction noise — without this cooldown, the propagator picks
 *  up an immediate "re-encounter" and you get a string of duplicate
 *  ENC/EXIT pairs on the same body. */
export const SOI_EXIT_COOLDOWN = 3.0;
/** Multiplicative margin on SOI-exit detection. A capture burn sized
 *  "just enough" to bound the orbit will land apoapsis right at SOI;
 *  tiny floating-point excursions of `r` above SOI shouldn't trigger
 *  an exit. We require dist > soi · this factor before declaring exit.
 *  Bisection then finds the true (soi-radius) crossing for the arc
 *  endpoint, so observable exits stay exact. */
export const SOI_EXIT_HYSTERESIS = 1.03;
/** Multiplicative margin on SOI-enter detection. Same idea as the exit
 *  hysteresis but in reverse: don't declare an "enter" event unless the
 *  ship is meaningfully inside the body's SOI. Prevents false re-entries
 *  triggered by reconstruction noise at the boundary. */
export const SOI_ENTER_HYSTERESIS = 0.97;

/**
 * Anchor kinds drive how `node.t` is recomputed when the trajectory or
 * prior burns change:
 *   - 'absolute'    user-picked time; never moves
 *   - 'periapsis'   next periapsis of the orbit the node fires on
 *   - 'apoapsis'    next apoapsis
 *   - 'encounter'   the instant the ship crosses into targetBodyId's
 *                   SOI. The pre-burn orbit is already re-parameterized
 *                   in the captured body's frame — burning retrograde
 *                   here lowers apoapsis (braking).
 *   - 'capture'     periapsis of the captured orbit around
 *                   targetBodyId. Use this for circularization burns
 *                   after a capture has been planned.
 */
export type AnchorKind =
  | 'absolute' | 'periapsis' | 'apoapsis'
  | 'encounter' | 'capture';

export interface ManeuverNode {
  id: number;
  t: number;                  // tick when the burn fires
  anchor: AnchorKind;
  dv: ManeuverDv;
  committed: boolean;
  /** Required for 'encounter' and 'capture' — the body whose SOI we're
   *  capturing into. Ignored for other anchors. */
  targetBodyId?: string;
  /** True when an anchor's target event can't be found within the
   *  projection budget (e.g. the trajectory no longer encounters the
   *  body the node was planned around). The node won't fire while
   *  stale. */
  stale?: boolean;
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

  // Grace window after a fresh SOI entry — see SOI_ENTRY_GRACE doc.
  let exitGraceUntil = -Infinity;
  // Cooldown on re-entering the body we just exited — see SOI_EXIT_COOLDOWN.
  let enterCooldownBody: string | null = null;
  let enterCooldownUntil = -Infinity;

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

      // Exit current parent's SOI? Suppressed inside the grace window
      // that follows a fresh SOI re-anchor — see SOI_ENTRY_GRACE. The
      // hysteresis margin (SOI_EXIT_HYSTERESIS) handles the common case
      // where a capture burn sized just-enough places apoapsis right
      // at the SOI radius: tiny radial noise at apsis shouldn't trip
      // exit. Bisection finds the true SOI crossing for the arc end.
      if (currentParent.id !== 'sol' && nextT >= exitGraceUntil) {
        const pp = bodyPosition(currentParent, nextT);
        const dx = pos.x - pp.x, dy = pos.y - pp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > currentParent.soi * SOI_EXIT_HYSTERESIS) {
          const tCross = bisectSOIExit(currentOrbit, currentParent.id, t, nextT);
          event = { type: 'exit', t: tCross, fromBodyId: currentParent.id };
          break;
        }
      }

      // Enter a sibling body's SOI? Two guards:
      //  - hysteresis margin (require dist meaningfully inside SOI)
      //  - cooldown on re-entering the SAME body we just exited
      let entered: { type: 'enter'; t: number; intoBodyId: string } | null = null;
      for (const body of BODIES) {
        if (body.id === 'sol') continue;
        if (body.id === currentOrbit.parentBodyId) continue;
        if (body.parent !== currentOrbit.parentBodyId) continue;
        if (body.id === enterCooldownBody && nextT < enterCooldownUntil) continue;
        const bp = bodyPosition(body, nextT);
        const dx = pos.x - bp.x, dy = pos.y - bp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < body.soi * SOI_ENTER_HYSTERESIS) {
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
      // Fresh re-anchor: silence the SOI-exit check briefly so floating-
      // point noise at the boundary doesn't immediately bounce us back
      // out of the new parent.
      if (event.type === 'enter') {
        exitGraceUntil = event.t + SOI_ENTRY_GRACE;
      } else if (event.type === 'exit') {
        // After an exit, suppress an immediate re-entry into the same
        // body — the new heliocentric orbit can land microscopically
        // back inside its SOI from reconstruction noise.
        enterCooldownBody = event.fromBodyId ?? null;
        enterCooldownUntil = event.t + SOI_EXIT_COOLDOWN;
      }
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
    // For encounter / capture nodes, we walk SOI events and CONSUME the
    // matching one. For encounter, the burn fires AT the SOI entry — so
    // the post-SOI orbit (in target body's frame) is the pre-burn orbit.
    // For capture, we additionally fast-forward through the SOI entry
    // so the pre-burn orbit is already inside the captured body's frame
    // at periapsis.
    const targetType: 'enter' | 'exit' | null =
      node.anchor === 'encounter' || node.anchor === 'capture' ? 'enter'
      : null;

    let walkOrbit = cursorOrbit;
    let walkTick = cursorTick;

    for (let i = 0; i < 6 && walkTick < node.t - 1e-6; i++) {
      const remaining = node.t - walkTick;
      const ev = findNextSOIEvent(walkOrbit, walkTick, Math.min(remaining + 5, TRAJ_MAX_TICKS));
      if (!ev || !ev.newOrbit) break;
      const isAnchorMatch =
        !!targetType && ev.type === targetType &&
        ev.bodyId === node.targetBodyId &&
        Math.abs(ev.t - node.t) < 5.0;
      const isIntermediate = ev.t < node.t - 1e-6;
      if (!isAnchorMatch && !isIntermediate) break;
      walkOrbit = ev.newOrbit;
      walkTick = ev.t;
      if (isAnchorMatch && node.anchor === 'encounter') break;
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
  // If this orbit was just re-anchored (epoch is recent), skip exit
  // checks until the grace window elapses — same numerical-noise guard
  // computeTrajectory uses.
  const exitGraceUntil = orbit.epoch + SOI_ENTRY_GRACE;
  for (let dt = stepSize; dt <= limit; dt += stepSize) {
    const t = fromTick + dt;
    const pos = orbitWorldPos(orbit, t);
    if (parent.id !== 'sol' && t >= exitGraceUntil) {
      const pp = bodyPosition(parent, t);
      const dx = pos.x - pp.x, dy = pos.y - pp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > parent.soi * SOI_EXIT_HYSTERESIS && parent.parent) {
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
      if (dist < body.soi * SOI_ENTER_HYSTERESIS) {
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
 * Recompute every node's `t` based on the trajectory built from prior
 * nodes. Anchor semantics:
 *   - periapsis / apoapsis  → nextApsisTime on the cursor orbit
 *   - absolute              → leave t alone, but still walk SOI events
 *                             so the cursor stays in sync for later nodes
 *   - encounter             → next SOI 'enter' event whose body matches
 *                             targetBodyId; node fires AT the SOI boundary
 *   - capture               → consume the SOI 'enter' event, then take
 *                             the next periapsis of the captured orbit
 * For encounter/capture we mark the node `stale: true` if we can't find
 * the matching event within the projection budget — the executor skips
 * stale nodes so a half-broken plan doesn't fire random burns.
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
    node.stale = false;

    if (node.anchor === 'periapsis' || node.anchor === 'apoapsis') {
      node.t = nextApsisTime(cursorOrbit, cursorTick, node.anchor);
    } else if (node.anchor === 'encounter' || node.anchor === 'capture') {
      const targetId = node.targetBodyId;
      if (!targetId) {
        node.stale = true;
      } else {
        // Step through SOI events from cursorOrbit forward; the FIRST
        // 'enter' into targetBodyId is the anchor instant.
        let walkOrbit: Orbit | null = cursorOrbit;
        let walkTick = cursorTick;
        let found: { t: number; orbit: Orbit } | null = null;
        for (let i = 0; i < 6; i++) {
          if (!walkOrbit) break;
          const ev = findNextSOIEvent(walkOrbit, walkTick, TRAJ_MAX_TICKS);
          if (!ev || !ev.newOrbit) break;
          walkOrbit = ev.newOrbit;
          walkTick = ev.t;
          if (ev.type === 'enter' && ev.bodyId === targetId) {
            found = { t: ev.t, orbit: ev.newOrbit };
            break;
          }
        }
        if (!found) {
          node.stale = true;
        } else if (node.anchor === 'encounter') {
          // Bump slightly past the SOI boundary so `computeTrajectory`
          // processes the SOI re-anchor first and fires this node in
          // the captured body's frame on the next iteration.
          node.t = found.t + 0.1;
          cursorOrbit = found.orbit;
          cursorTick = found.t;
        } else {
          // capture: node fires at periapsis of the captured orbit
          node.t = nextApsisTime(found.orbit, found.t, 'periapsis');
          cursorOrbit = found.orbit;
          cursorTick = found.t;
        }
      }
    } else {
      // 'absolute' — walk SOI events so the cursor stays accurate
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

    if (node.stale) continue;

    const dvMag = Math.sqrt(node.dv.prograde * node.dv.prograde + node.dv.radial * node.dv.radial);
    cursorOrbit = dvMag > 0
      ? applyNodeToOrbit(cursorOrbit, node.t, node.dv)
      : cursorOrbit;
    cursorTick = node.t;
  }
}
