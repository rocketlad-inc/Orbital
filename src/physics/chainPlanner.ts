// ============================================================
// CHAIN PLANNER
//
// "Go to Neptune. Wait 3 ticks. Go to Pluto." — planned for ONE ship,
// as a pure function, so the same chain can be applied to a group or a
// whole fleet without going through React state.
//
// WHY THIS EXISTS RATHER THAN A LOOP OVER enqueueTorchTransfer.
// That function reports its result out of a setState updater. React
// runs only the FIRST queued updater of a synchronous batch eagerly,
// so calling it three times in a row returns a plan for leg 1 and
// null for legs 2 and 3. That is not hypothetical — it is the exact
// bug clownking reported for bulk fleet orders (see the note in
// gameContext.launchTorchTransfer). A per-click UI never hits it; a
// programmatic chain hits it every time.
//
// So the chain is solved here, with no state involved, and the caller
// posts the results.
// ============================================================

import { planTorchTransfer, TorchTransfer } from './torchTransfer';
import { bodyPosition, bodyWorldVelocity } from './orbitalMechanics';
import { Body } from '../types';

/** One link: sit still for `wait` ticks, then burn for `bodyId`. */
export interface ChainStep {
  bodyId: string;
  /** Ticks to hold before this leg departs. 0 = leave as soon as the
   *  previous leg parks (or immediately, for the first leg). */
  wait: number;
}

/**
 * Carry a PARKED ship forward in world space.
 *
 * A ship waiting at a body is not stationary — it rides that body
 * around its orbit. Planning the next burn from where the ship landed
 * would aim from where it was `toTick - fromTick` ticks ago, which at
 * outer-planet rates is a long way off.
 *
 * Exported because gameContext's per-click enqueue needs the identical
 * rule; one derivation, so the single-ship and bulk paths cannot
 * disagree about where a waiting ship is.
 */
export function carryParkedShip(
  pos: { x: number; y: number },
  body: Body | undefined,
  fromTick: number,
  toTick: number,
  bodies: Body[],
): { x: number; y: number } {
  if (!body || toTick <= fromTick) return { x: pos.x, y: pos.y };
  const at = bodyPosition(body, fromTick, bodies);
  const then = bodyPosition(body, toTick, bodies);
  return { x: pos.x + (then.x - at.x), y: pos.y + (then.y - at.y) };
}

export interface ChainPlanInput {
  /** Where the ship is when the chain is issued. */
  startPos: { x: number; y: number };
  startVel: { x: number; y: number };
  /** The tick the chain is issued on. */
  startTick: number;
  /** The body the ship is parked at, so a leading wait can ride it. */
  parkedAtBodyId?: string | null;
  steps: ChainStep[];
  bodies: Body[];
  accel: number;
}

/**
 * Solve every leg of a chain in order.
 *
 * Returns the legs it could solve, stopping at the first one it
 * cannot: a chain is ordered, so leg 3 is meaningless without leg 2.
 * A caller that gets back fewer legs than it asked for should say so
 * rather than silently flying a truncated route.
 */
export function planChainLegs(input: ChainPlanInput): TorchTransfer[] {
  const { startPos, startVel, startTick, parkedAtBodyId, steps, bodies, accel } = input;
  const out: TorchTransfer[] = [];
  if (accel <= 0) return out;

  let pos = { x: startPos.x, y: startPos.y };
  let vel = { x: startVel.x, y: startVel.y };
  let readyAt = startTick;
  let parkedAt = parkedAtBodyId ?? null;

  for (const step of steps) {
    const wait = Math.max(0, Math.round(step.wait || 0));
    const departAt = readyAt + wait;
    // eslint-disable-next-line no-loop-func -- per-iteration capture is the intent
    const parkBody = parkedAt ? bodies.find(b => b.id === parkedAt) : undefined;
    const departPos = carryParkedShip(pos, parkBody, readyAt, departAt, bodies);
    // Velocity is resampled outright rather than carried: a parked hull
    // matches its body's velocity, and that is what the body has at the
    // departure tick, not at arrival.
    const departVel = parkBody
      ? bodyWorldVelocity(parkBody, departAt, bodies)
      : { x: vel.x, y: vel.y };

    const plan = planTorchTransfer(
      { pos: departPos, vel: departVel },
      step.bodyId,
      accel, accel,
      departAt, bodies,
    );
    if (!plan) break;

    out.push(plan);
    pos = { x: plan.interceptPos.x, y: plan.interceptPos.y };
    vel = { x: 0, y: 0 };
    readyAt = plan.arriveTick;
    parkedAt = step.bodyId;
  }
  return out;
}
