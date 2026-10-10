// ============================================================
// What a parked hull can intercept, one answer per group in flight.
//
// The rule is the one the ship panel always used (DESIGN-transit-
// combat.md, "the missing order"): a group is catchable when a true
// rendezvous exists before it lands, or when you can reach its
// destination no later than it does. What changed is the unit — the
// group, solved once from its lead hull, instead of every hull — and that
// groups you CAN'T catch are kept, with the reason, for the "can't reach"
// view.
// ============================================================

import type { Body, GameState, Ship } from '../types';
import type { TorchTransfer } from '../physics/torchTransfer';
import { torchPositionFromSamples } from '../physics/torchTransfer';
import { torchTrajectorySamples } from '../render/mapRenderer';
import { solveRendezvous, type RendezvousSolution } from '../physics/rendezvous.js';
import { bodyPosition } from '../physics/orbitalMechanics';
import { groupFlights, standingOf, worldBoxOf, type FlightGroup, type Standing, type WorldBox } from './interceptPicker';

export interface Vec { x: number; y: number }

export interface InterceptOption extends FlightGroup {
  dest: Body;
  /** Absolute tick the group lands. */
  theirEta: number;
  /** Your leg to their destination, flown from orbit now. */
  myPlan: TorchTransfer;
  /** A matched-velocity meeting in flight, when one exists. */
  rv: RendezvousSolution | null;
  /** Ticks until you meet them: in flight for a match, at the door otherwise. */
  meetIn: number;
  /** Ticks until you could be at their destination. */
  myEta: number;
  /** Catchable by the rule above. */
  ok: boolean;
  standing: Standing;
  /** Where the lead is now, and where you would meet. */
  nowPos: Vec;
  meetPos: Vec;
}

/**
 * Every group in flight that `me` could try to intercept, catchable ones
 * first by how soon you meet, then the rest by how near a miss they are.
 * `exclude` drops hulls that are part of the order (the fleet or group
 * being sent) so nobody is offered an intercept of themselves.
 */
export function solveIntercepts(
  me: Ship,
  gs: Pick<GameState, 'ships' | 'fleets' | 'bodies' | 'currentTick' | 'alliedFactionIds' | 'warPairs'>,
  planLegFor: (shipId: string, targetBodyId: string) => TorchTransfer | null,
  exclude?: ReadonlySet<string>,
): InterceptOption[] {
  const now = gs.currentTick;
  const flying = gs.ships.filter(t =>
    t.id !== me.id && !exclude?.has(t.id) && !!t.transit && (t.hp ?? 1) > 0
    && !!t.transit.currentTransfer?.targetBodyId);
  const myPlans = new Map<string, TorchTransfer | null>();
  const out: InterceptOption[] = [];
  for (const g of groupFlights(flying, gs.fleets ?? [])) {
    const tr = g.lead.transit!.currentTransfer;
    const dest = gs.bodies.find(b => b.id === tr.targetBodyId);
    if (!dest) continue;
    const theirEta = tr.arriveTick;
    if (theirEta <= now) continue;                   // already parking
    if (!myPlans.has(dest.id)) myPlans.set(dest.id, planLegFor(me.id, dest.id));
    const myPlan = myPlans.get(dest.id);
    if (!myPlan) continue;                            // no course at all
    // Sampled once per group: the solver asks ~29 times.
    const samples = torchTrajectorySamples(tr, gs.bodies);
    if (!samples || samples.length < 2) continue;
    const rv = solveRendezvous(
      { x: myPlan.startPos.x, y: myPlan.startPos.y },
      { x: myPlan.startVel.x, y: myPlan.startVel.y },
      myPlan.acceleration,
      // Against the polyline the hull is DRAWN along, so the meeting is
      // where the player can see the target (see ShipPanel history).
      (tick: number) => {
        const q1 = torchPositionFromSamples(samples, tick);
        const h = 0.01;
        const q2 = torchPositionFromSamples(samples, tick + h);
        return { pos: { x: q1.x, y: q1.y }, vel: { x: (q2.x - q1.x) / h, y: (q2.y - q1.y) / h } };
      },
      now,
      theirEta,
    );
    const ok = !!rv || myPlan.arriveTick <= theirEta;
    const meetTick = rv ? rv.meetTick : theirEta;
    const nowP = torchPositionFromSamples(samples, now);
    const meetP = rv ? torchPositionFromSamples(samples, rv.meetTick) : bodyPosition(dest, theirEta, gs.bodies);
    out.push({
      ...g,
      dest, theirEta, myPlan, rv, ok,
      meetIn: Math.max(0, meetTick - now),
      myEta: Math.max(0, myPlan.arriveTick - now),
      standing: standingOf(g.lead.ownedBy, gs.alliedFactionIds, gs.warPairs),
      nowPos: { x: nowP.x, y: nowP.y },
      meetPos: { x: meetP.x, y: meetP.y },
    });
  }
  return out.sort((a, b) =>
    a.ok !== b.ok ? (a.ok ? -1 : 1)
      : a.ok ? a.meetIn - b.meetIn
        : (a.myEta - (a.theirEta - now)) - (b.myEta - (b.theirEta - now)));
}

/** Bearing of the meeting from you, for the radar. A meeting on top of
 *  you (an escort arriving at your own world) takes its bearing from
 *  where the group is now instead. */
export function meetBearing(o: InterceptOption, myPos: Vec): number {
  const dx = o.meetPos.x - myPos.x, dy = o.meetPos.y - myPos.y;
  if (Math.hypot(dx, dy) > 1) return Math.atan2(dy, dx);
  return Math.atan2(o.nowPos.y - myPos.y, o.nowPos.x - myPos.x);
}

/** Everything a SHOW must keep in frame: you, them now, the meeting and
 *  their destination when they land there. */
export function courseBox(o: InterceptOption, myPos: Vec | null, bodies: readonly Body[]): WorldBox | null {
  const pts: Vec[] = [o.nowPos, o.meetPos, bodyPosition(o.dest, o.theirEta, bodies as Body[])];
  if (myPos) pts.push(myPos);
  return worldBoxOf(pts);
}
