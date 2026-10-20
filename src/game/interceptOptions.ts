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
//
// EVERY FLIGHT YOU CAN SEE COMES BACK (2026-10-20). A group with no
// course from here, or one already landing, used to be skipped without a
// word, so a player looking at a raid on the map found it missing from
// the list and had no way to tell why. Now each one carries `why`.
// ============================================================

import type { Body, GameState, Ship } from '../types';
import type { TorchTransfer } from '../physics/torchTransfer';
import { torchPositionFromSamples } from '../physics/torchTransfer';
import { torchTrajectorySamples } from '../render/mapRenderer';
import { solveRendezvous, type RendezvousSolution } from '../physics/rendezvous.js';
import { bodyPosition } from '../physics/orbitalMechanics';
import { groupFlights, standingOf, worldBoxOf, type FlightGroup, type Standing, type WorldBox } from './interceptPicker';

export interface Vec { x: number; y: number }

export type InterceptWhy = 'late' | 'noCourse' | 'landing';

export interface InterceptOption extends FlightGroup {
  dest: Body;
  /** Absolute tick the group lands. */
  theirEta: number;
  /** Your leg to their destination, flown from orbit now; null when no
   *  course exists (why = 'noCourse'). */
  myPlan: TorchTransfer | null;
  /** A matched-velocity meeting in flight, when one exists. */
  rv: RendezvousSolution | null;
  /** Ticks until you meet them: in flight for a match, at the door otherwise. */
  meetIn: number;
  /** Ticks until you could be at their destination. */
  myEta: number;
  /** Catchable by the rule above. */
  ok: boolean;
  /** Why not, when !ok:
   *   late     — no speed match before they land, and you reach their
   *              destination after they do
   *   noCourse — no course from here to their destination at all
   *   landing  — they land this tick; nothing is left to catch */
  why: InterceptWhy | null;
  /** They are flying to the world this hull is parked at. */
  toYou: boolean;
  standing: Standing;
  /** Where the lead is now, and where you would meet. */
  nowPos: Vec;
  meetPos: Vec;
  /** How far along THEIR whole trip a matched meeting falls, 0..1 by
   *  distance flown; null without a match. A group flying straight at
   *  you is matched late (it has to slow down before you can fly beside
   *  it), and saying so is the answer to "why not halfway?". */
  tripFrac: number | null;
}

/** Fraction of a sampled path's length flown by `tick`, 0..1. */
export function pathFraction(samples: ReadonlyArray<{ t: number; x: number; y: number }>, tick: number): number {
  let total = 0, done = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    total += seg;
    if (tick >= b.t) done += seg;
    else if (tick > a.t && b.t > a.t) done += seg * (tick - a.t) / (b.t - a.t);
  }
  return total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
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
    if (!dest) continue;                              // nowhere we can name
    const theirEta = tr.arriveTick;
    const samples = torchTrajectorySamples(tr, gs.bodies);
    const nowP = samples && samples.length > 0 ? torchPositionFromSamples(samples, now) : bodyPosition(dest, now, gs.bodies);
    const base = {
      ...g, dest, theirEta,
      standing: standingOf(g.lead.ownedBy, gs.alliedFactionIds, gs.warPairs),
      toYou: me.orbit?.parentBodyId === dest.id,
      nowPos: { x: nowP.x, y: nowP.y },
      tripFrac: null,
      rv: null,
    };
    const miss = (why: InterceptWhy, myPlan: TorchTransfer | null) => {
      const doorP = bodyPosition(dest, Math.max(now, theirEta), gs.bodies);
      out.push({
        ...base, myPlan, ok: false, why,
        meetIn: Math.max(0, theirEta - now),
        myEta: myPlan ? Math.max(0, myPlan.arriveTick - now) : 0,
        meetPos: { x: doorP.x, y: doorP.y },
      });
    };
    if (theirEta <= now) { miss('landing', null); continue; }
    if (!myPlans.has(dest.id)) myPlans.set(dest.id, planLegFor(me.id, dest.id));
    const myPlan = myPlans.get(dest.id) ?? null;
    if (!myPlan || !samples || samples.length < 2) { miss('noCourse', myPlan); continue; }
    // Sampled once per group: the solver asks ~29 times.
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
    if (!rv && myPlan.arriveTick > theirEta) { miss('late', myPlan); continue; }
    const meetTick = rv ? rv.meetTick : theirEta;
    const meetP = rv ? torchPositionFromSamples(samples, rv.meetTick) : bodyPosition(dest, theirEta, gs.bodies);
    out.push({
      ...base, myPlan, rv, ok: true, why: null,
      meetIn: Math.max(0, meetTick - now),
      myEta: Math.max(0, myPlan.arriveTick - now),
      meetPos: { x: meetP.x, y: meetP.y },
      tripFrac: rv ? pathFraction(samples, rv.meetTick) : null,
    });
  }
  // The misses: near misses first (the ones a faster hull or an earlier
  // start would catch), then the ones landing now, then no course at all.
  const missRank: Record<InterceptWhy, number> = { late: 0, landing: 1, noCourse: 2 };
  return out.sort((a, b) =>
    a.ok !== b.ok ? (a.ok ? -1 : 1)
      : a.ok ? a.meetIn - b.meetIn
        : a.why !== b.why ? missRank[a.why!] - missRank[b.why!]
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
