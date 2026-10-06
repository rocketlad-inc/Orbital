// ============================================================
// refitStatus — where and when an ordered refit will happen, or why
// it can't yet.
//
// "Nothing happens" was the most common refit report. Part of it was a
// tick bug (route freighters were never parked when the pass looked;
// fixed in room.js applyPendingRefits); the rest was that an ordered
// refit said only "fits on arrival at a friendly world" and then went
// silent. This answers the three questions a player has, in ONE place
// the ship panel, the situation report and the map/outliner badges all
// read, so they can never disagree:
//
//   WHERE + WHEN  the first friendly world on the hull's course: parked
//                 at one now (next tick), the end of a leg it is flying
//                 (that leg's arrival tick), or a stop on its route.
//   WHY NOT YET   the design is gone, the treasury cannot cover the fee
//                 (the tick retries every tick until it can), or no
//                 friendly world is anywhere on its course.
//
// "Friendly world" is exactly the server's rule (room.js
// applyPendingRefits): a body where the hull's owner has a living
// settlement, with the hull parked there.
// ============================================================

import type { GameState, Ship } from '../types';
import { refitFee, sanitizeParts } from './shipParts';
import type { ShipClassName } from './shipClasses';

export interface RefitStatus {
  designId: string;
  designName: string | null;
  fee: { ore: number; credits: number };
  /** Where it will happen, if anywhere on its course. */
  where: {
    bodyId: string;
    name: string;
    /** Tick it gets there; null for a route stop with no planned leg yet. */
    tick: number | null;
    kind: 'here' | 'arrival' | 'route';
  } | null;
  /** Why it is not going to happen as things stand. */
  blocked: { reason: 'design_gone' | 'cant_afford' | 'no_friendly_stop'; text: string } | null;
  /** One line for the panel and the situation report. */
  text: string;
}

const fmtFee = (f: { ore: number; credits: number }) =>
  [f.ore > 0 ? `${Math.round(f.ore)} metal` : null, f.credits > 0 ? `${Math.round(f.credits)} credits` : null]
    .filter(Boolean).join(' + ') || 'no charge';

export function refitStatus(ship: Ship, gs: GameState): RefitStatus | null {
  const designId = ship.refitPendingDesignId;
  if (!designId) return null;
  const design = (gs.shipDesigns ?? []).find(d => d.id === designId);
  const nameOf = (id: string) => gs.bodies.find(b => b.id === id)?.name ?? 'a friendly world';
  const friendly = new Set(
    gs.settlements.filter(s => s.ownedBy === ship.ownedBy).map(s => s.bodyId),
  );

  if (!design || design.shipClass !== ship.class) {
    return {
      designId, designName: design?.name ?? null, fee: { ore: 0, credits: 0 }, where: null,
      blocked: { reason: 'design_gone', text: 'Its design was deleted — the refit will be dropped' },
      text: 'Its design was deleted — the refit will be dropped',
    };
  }
  const fee = refitFee(
    sanitizeParts(ship.parts ?? []), sanitizeParts(design.parts ?? []), ship.class as ShipClassName,
  );

  // WHERE: parked at a friendly world, the end of a leg in flight, a
  // queued leg, or a stop on its route.
  let where: RefitStatus['where'] = null;
  if (!ship.transit && friendly.has(ship.orbit.parentBodyId)) {
    where = { bodyId: ship.orbit.parentBodyId, name: nameOf(ship.orbit.parentBodyId), tick: gs.currentTick + 1, kind: 'here' };
  } else {
    const legs = [
      ...(ship.transit ? [ship.transit.currentTransfer] : []),
      ...(ship.queuedTransits ?? []),
    ];
    const leg = legs.find(l => l && friendly.has(l.targetBodyId));
    if (leg) {
      where = { bodyId: leg.targetBodyId, name: nameOf(leg.targetBodyId), tick: Math.ceil(leg.arriveTick), kind: 'arrival' };
    } else {
      const route = (gs.tradeRoutes ?? []).find(r =>
        r.shipId === ship.id || (r.ships ?? []).some(c => c.shipId === ship.id));
      const stop = route
        ? [...(route.stops ?? [])].sort((a, b) => a.sequence - b.sequence).find(s => friendly.has(s.bodyId))
          ?? (friendly.has(route.originBodyId) ? { bodyId: route.originBodyId }
            : friendly.has(route.destBodyId) ? { bodyId: route.destBodyId } : undefined)
        : undefined;
      if (stop) where = { bodyId: stop.bodyId, name: nameOf(stop.bodyId), tick: null, kind: 'route' };
    }
  }

  const pool = gs.resources?.[ship.ownedBy];
  const short = !!pool && (fee.ore > (pool.ore ?? 0) || fee.credits > (pool.credits ?? 0));

  let blocked: RefitStatus['blocked'] = null;
  if (short) {
    blocked = { reason: 'cant_afford', text: `Waiting for ${fmtFee(fee)} — it fits as soon as you can pay` };
  } else if (!where) {
    blocked = { reason: 'no_friendly_stop', text: 'No friendly world on its course — send it to one' };
  }

  const whenText = !where ? ''
    : where.kind === 'here' ? `Fits at ${where.name} next tick`
    : where.kind === 'arrival' ? `Fits at ${where.name}, tick ${where.tick}`
    : `Fits next time its route reaches ${where.name}`;

  return {
    designId, designName: design.name, fee, where, blocked,
    text: blocked ? blocked.text : whenText,
  };
}
