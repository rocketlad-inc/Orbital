// ============================================================
// fleetSummary — the numbers on a fleet's own card.
//
// The ship panel was built for one hull. Selecting any member of a fleet
// showed that hull's HP, that hull's destination, that hull's firepower —
// true, and useless for the question you actually had, which is "what is
// this FLEET, and what is it doing". This module answers that once, from
// the ships, so the FLEET tab and anything else that wants a fleet's
// strength read the same figures.
//
// Pure and free of React on purpose. Every number here reaches a player
// as a claim about their squadron, so it lives where it can be tested.
// ============================================================

import type { Ship } from '../types';
import type { ShipStatus } from './systemGrouping';

export interface FleetPlace {
  /** Parked at a body, or burning for one. */
  kind: 'parked' | 'transit';
  /** The parent body when parked; the destination when under way. */
  bodyId: string;
  count: number;
  /** Under way only: ticks until the LAST hull of this group arrives. A
   *  fleet has arrived when all of it has, not when its fastest ship has. */
  eta?: number;
}

export interface FleetSummary {
  /** Hulls taking the fleet's orders. */
  attached: Ship[];
  /** Members that stepped out of formation: still in the fleet, on their
   *  own orders. Counted apart so the strength figures describe the
   *  squadron that actually moves and fights together. */
  detached: Ship[];
  /** Hull classes of the attached ships, most numerous first. */
  composition: Array<{ cls: string; count: number }>;
  hp: number;
  hpMax: number;
  /** 0..100, rounded. 100 for an empty fleet rather than NaN. */
  hpPct: number;
  /** Most damaged attached hull, 0..100. The average hides the ship that
   *  is about to die, which is usually the one you need to know about. */
  worstHpPct: number;
  /** Damage per tick of every attached hull together. */
  firepower: number;
  /** Attached hulls that can shoot at all. */
  armed: number;
  /** Where the attached hulls are, biggest group first. More than one
   *  entry means the fleet is split, which the card has to say. */
  places: FleetPlace[];
}

export function summarizeFleet(
  members: readonly Ship[],
  currentTick: number,
  maxHpOf: (s: Ship) => number,
  damageOf: (s: Ship) => number,
): FleetSummary {
  const attached = members.filter(s => !s.fleetDetached);
  const detached = members.filter(s => !!s.fleetDetached);

  const byClass = new Map<string, number>();
  let hp = 0, hpMax = 0, firepower = 0, armed = 0, worstHpPct = 100;
  const placeMap = new Map<string, FleetPlace>();

  for (const s of attached) {
    byClass.set(s.class, (byClass.get(s.class) ?? 0) + 1);

    const mx = Math.max(0, maxHpOf(s));
    // A hull with no hp field is at full strength — same convention as
    // the ship card, which reads `ship.hp ?? maxHp`.
    const cur = Math.max(0, Math.min(mx, s.hp ?? mx));
    hp += cur; hpMax += mx;
    if (mx > 0) worstHpPct = Math.min(worstHpPct, Math.round((cur / mx) * 100));

    const dmg = Math.max(0, damageOf(s));
    firepower += dmg;
    if (dmg > 0) armed++;

    const leg = s.transit?.currentTransfer;
    const key = leg ? `t:${leg.targetBodyId}` : `p:${s.orbit?.parentBodyId ?? '?'}`;
    let place = placeMap.get(key);
    if (!place) {
      place = leg
        ? { kind: 'transit', bodyId: leg.targetBodyId, count: 0, eta: 0 }
        : { kind: 'parked', bodyId: s.orbit?.parentBodyId ?? '?', count: 0 };
      placeMap.set(key, place);
    }
    place.count++;
    if (leg && place.kind === 'transit') {
      place.eta = Math.max(place.eta ?? 0, Math.max(0, Math.round(leg.arriveTick - currentTick)));
    }
  }

  return {
    attached,
    detached,
    composition: [...byClass.entries()]
      .map(([cls, count]) => ({ cls, count }))
      .sort((a, b) => b.count - a.count || a.cls.localeCompare(b.cls)),
    hp,
    hpMax,
    hpPct: hpMax > 0 ? Math.round((hp / hpMax) * 100) : 100,
    worstHpPct: attached.length > 0 ? worstHpPct : 100,
    firepower,
    armed,
    places: [...placeMap.values()]
      .sort((a, b) => b.count - a.count || a.bodyId.localeCompare(b.bodyId)),
  };
}

/** Which member status speaks for the whole fleet: the most urgent one
 *  present. A squadron with one hull under fire is a squadron in combat;
 *  averaging that away is how a player misses the fight. */
const STATUS_URGENCY = ['combat', 'retreating', 'transit', 'repairing', 'holding', 'planned', 'orbiting'];

export function fleetHeadlineStatus(
  statuses: readonly ShipStatus[],
): { status: ShipStatus; count: number } | null {
  if (statuses.length === 0) return null;
  const rank = (s: ShipStatus) => {
    const i = STATUS_URGENCY.indexOf(s.cls);
    return i < 0 ? STATUS_URGENCY.length : i;
  };
  let best = statuses[0];
  for (const s of statuses) if (rank(s) < rank(best)) best = s;
  return { status: best, count: statuses.filter(s => s.cls === best.cls).length };
}
