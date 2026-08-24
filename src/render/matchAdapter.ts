/**
 * MATCH REPLAY -> GAME STATE.
 *
 * The recap used to carry its own renderer: two and a half thousand
 * lines that redrew orbits, worlds, labels, territory and hulls from
 * scratch. It was never going to look like the game, because it was a
 * second, worse implementation of the game's map -- and every reviewer
 * said so in the same words, that the panel read as shipped work and the
 * map read as instrumentation someone had pointed a camera at.
 *
 * The game's map renderer takes plain data and returns pixels:
 * `drawBody(body, ctx)`, `drawShip(ship, ctx)`, `computeSystemRegions`,
 * `planBodyLabels`. It has no idea whether it is drawing a live match or
 * a recording, and `LobbyMapPreview` already proved a non-live caller
 * works. So the recap does not need a renderer at all. It needs an
 * ADAPTER: turn a reconstructed tick into the `Body[]`, `Ship[]`,
 * `Settlement[]` and `Faction[]` the real renderer already knows how to
 * draw, and let the game draw the game.
 *
 * What a snapshot cannot carry, this fills in honestly:
 *   - Ships record WHICH body they were at, never their orbit, so a
 *     parked hull gets a synthesized circular orbit. The renderer phases
 *     co-orbiting hulls into a ring itself, so a fleet still reads as a
 *     fleet.
 *   - Torch transits integrate position per tick and none of that is
 *     recorded. A crossing gets a plan built from its two endpoints and
 *     a position interpolated along it -- the real sprite and the real
 *     trajectory art on an approximated path.
 * Everything else is the record.
 */
import type {
  Body, Faction, OrbitElements, Settlement, Ship, TorchTransferPlan,
} from '../types';
import type { MatchSummary, MatchWorld } from './matchWorld';

/** Stable 32-bit hash, so synthesized angles never flicker between frames. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const SHIP_CLASSES: Array<Ship['class']> =
  ['corvette', 'frigate', 'destroyer', 'freighter', 'colony'];

function shipClassOf(cls: string | null | undefined): Ship['class'] {
  const c = (cls ?? '').toLowerCase();
  return (SHIP_CLASSES as string[]).includes(c) ? c as Ship['class'] : 'corvette';
}

/** The worlds, as the game models them. */
export function adaptBodies(summary: MatchSummary): Body[] {
  return summary.bodies.map(b => ({
    id: b.id,
    name: b.name ?? b.id,
    type: (b.type || 'terrestrial') as Body['type'],
    parent: b.parent_body_id ?? undefined,
    orbitRadius: b.orbit_radius ?? 0,
    orbitPeriod: b.orbit_period ?? 0,
    angle0: b.angle0 ?? 0,
    radius: b.radius ?? 4,
    // Not recorded, and only read by sensor//gameplay paths the recap
    // never exercises; a proportional value keeps any consumer sane.
    soi: Math.max(24, (b.radius ?? 4) * 8),
    color: b.color ?? '#8899aa',
    terraformedAtTick: b.terraformed_at_tick ?? null,
    destroyedAtTick: b.destroyed_at_tick ?? null,
  } as Body));
}

/** The empires. */
export function adaptFactions(summary: MatchSummary): Faction[] {
  return summary.factions.map(f => ({
    id: f.id,
    name: f.name,
    color: f.color ?? '#8899aa',
    color2: f.color2 ?? undefined,
    isPlayer: false,
  } as Faction));
}

/**
 * Colonies at this tick. The record keeps which body, whose it is, and
 * how many people -- everything else is presentation the renderer wants
 * and the recap can invent deterministically.
 */
export function adaptSettlements(world: MatchWorld): Settlement[] {
  const out: Settlement[] = [];
  for (const [id, st] of world.stls) {
    if (!st.body || !st.fid) continue;
    out.push({
      id,
      type: 'city',
      name: id,
      bodyId: st.body,
      ownedBy: st.fid,
      hp: 100, maxHp: 100,
      population: Math.max(1, st.pop || 1),
      lastGrowthTick: 0,
      lastHarvestTick: 0,
      // Fixed per settlement, so a city does not walk around its world.
      surfaceAngle: hash(id) * Math.PI * 2,
      stockpile: { fuel: 0, ore: 0, credits: 0, science: 0 },
    } as Settlement);
  }
  return out;
}

/** A circular orbit just clear of the world, phased off the hull's id. */
function parkedOrbit(parentId: string, parentRadius: number,
                     shipId: string, tick: number): OrbitElements {
  const r = Math.max(parentRadius * 2.1, parentRadius + 9);
  return {
    rp: r, ra: r,
    omega: 0,
    M0: hash(shipId) * Math.PI * 2,
    epoch: 0,
    direction: 1,
    // Long enough that hulls drift rather than spin, short enough that a
    // held shot shows movement. The renderer's own cosmetic spin rides
    // on top of this.
    period: 240 + Math.floor(hash(shipId + ':p') * 120),
    parentBodyId: parentId,
  };
}

/** A crossing the record knows the ends of but not the path. */
function transitPlan(fromId: string, toId: string,
                     fromPos: { x: number; y: number },
                     toPos: { x: number; y: number },
                     startTick: number, arriveTick: number): TorchTransferPlan {
  const dx = toPos.x - fromPos.x, dy = toPos.y - fromPos.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    targetBodyId: toId,
    acceleration: 0, brakeAcceleration: 0,
    startTick,
    flipTick: (startTick + arriveTick) / 2,
    arriveTick,
    thrustDir: { x: dx / len, y: dy / len },
    interceptPos: { x: toPos.x, y: toPos.y },
    startPos: { x: fromPos.x, y: fromPos.y },
    startVel: { x: 0, y: 0 },
    totalDv: 0,
    peakVelocity: len / Math.max(1, arriveTick - startTick),
  };
}

export interface TransitLeg {
  id: string; from: string; to: string;
  depart: number; arrive: number;
}

/**
 * The fleets at this tick.
 *
 * `legs` are crossings in flight right now, keyed by ship id; anything
 * listed there is drawn between worlds, everything else is parked.
 * `posOf` resolves a body's position in world units at this instant --
 * passed in because the caller already has the game's own
 * `bodyPosition` bound to the adapted body list.
 */
export function adaptShips(
  world: MatchWorld,
  t: number,
  legs: Map<string, TransitLeg>,
  bodyRadius: (id: string) => number,
  posOf: (id: string) => { x: number; y: number } | null,
): Ship[] {
  const out: Ship[] = [];
  for (const [id, sh] of world.ships) {
    if (!sh.parent) continue;
    const leg = legs.get(id);
    const base: Ship = {
      id,
      name: id,
      class: shipClassOf(sh.cls),
      ownedBy: sh.fid ?? '',
      fuel: 100,
      iconVariant: sh.iv as Ship['iconVariant'],
      orbit: parkedOrbit(sh.parent, bodyRadius(sh.parent), id, t),
    } as Ship;

    if (leg) {
      const a = posOf(leg.from), b = posOf(leg.to);
      if (a && b) {
        const span = Math.max(1, leg.arrive - leg.depart);
        const u = Math.max(0, Math.min(1, (t - leg.depart) / span));
        // Eased so departures and arrivals settle rather than snapping.
        const e = u * u * (3 - 2 * u);
        base.orbit = parkedOrbit(leg.from, bodyRadius(leg.from), id, t);
        base.transit = {
          pos: { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e },
          vel: { x: (b.x - a.x) / span, y: (b.y - a.y) / span },
          currentTransfer: transitPlan(leg.from, leg.to, a, b,
            leg.depart, leg.arrive),
        };
      }
    }
    out.push(base);
  }
  return out;
}
