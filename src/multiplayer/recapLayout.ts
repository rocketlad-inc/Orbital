// ============================================================
// recapLayout — the game's whole-orbit battle layout, for the recap.
//
// Lorne, 2026-10-09, on a recap of a 72-hull fight at Mars that drew as
// one blob with its labels stacked: "all the ships are clustered on top
// of each other. Can we follow the same distribution rules we've loaded
// into the game?" The recap had its own solver (BattleReview
// stationShips: a band per faction, each side packed into a 1.8 rad arc)
// that was laid out for every hull the fight EVER saw, so a side of 25
// corvettes shared a few lanes of one short arc.
//
// This is the map's rule (orbitBattleLayout via battleLayoutLive) applied
// to the recap's board, beat by beat:
//
//   * each beat lays out the hulls ON THE BOARD that beat, as the map
//     lays out the hulls at a world now: every side a contiguous share of
//     the orbit sized to its ships, no man's land between, blobs and
//     stragglers relaxed apart until no sprites touch, noses prograde;
//   * the world's station goes opposite the fight, as on the map;
//   * a roster change re-solves, and the recap GLIDES each hull to its new
//     place (the caller eases between consecutive beats), as the map does;
//   * the whole recap is drawn at ONE sprite scale, fitted to the frame
//     from its busiest beat, so nothing changes size mid-fight.
//
// THE TILT. The recap looks down on the orbital plane at an angle (its
// ORBIT_TILT squashes the plane's y). Two hulls a sprite apart in the
// plane are only tilt x that apart on screen when they line up along the
// squashed axis, and since the battle turns, every pair does at some
// point. So each hull is laid out with its clearance divided by the
// tilt: then no two sprites touch on screen at any angle.
//
// Pure, so it can be tested without a canvas.
// ============================================================

import { layoutOrbitBattle, CLEAR_FRAC, type OBShip } from '../render/orbitBattleLayout';

export interface RecapUnit {
  id: string;
  faction: string;
  /** Sprite size at full scale, px. */
  size: number;
  armed: boolean;
}

export interface RecapBeat {
  units: RecapUnit[];
  /** The world's station, placed opposite the fight. */
  stationId?: string;
}

/** A unit's place in the orbital plane, at drift 0. */
export interface RecapSlot {
  r: number;
  theta: number;
  /** The layout's small nose jitter off prograde, radians. */
  jitter: number;
}

export interface RecapLayout {
  /** Every unit placed on each beat. */
  beats: Map<string, RecapSlot>[];
  /** Each beat's places plus the LAST place of anything off the board
   *  (wrecks, hulls that left): where a wreck is drawn. */
  carry: Map<string, RecapSlot>[];
  /** The sprite scale the whole recap is drawn at. */
  k: number;
}

export interface RecapLayoutOptions {
  /** The world's drawn radius, px. */
  planetR: number;
  /** ry/rx of the drawn orbital plane. */
  tilt: number;
  /** Farthest a sprite's edge may reach from the world's centre, px. */
  rMax: number;
  /** The station's drawn width at full scale, px. */
  stationPx: number;
  seed: number;
  /** Factions in share order. */
  order: string[];
}

/** Smallest the fit may shrink the sprites. */
const K_FLOOR = 0.5;

export function layoutRecap(beats: readonly RecapBeat[], o: RecapLayoutOptions): RecapLayout {
  const tilt = Math.max(0.2, Math.min(1, o.tilt));
  const clearOf = (sizePx: number) => (sizePx * CLEAR_FRAC) / tilt;

  const keyOf = (b: RecapBeat) =>
    `${b.stationId ?? ''}|${b.units.map(u => u.id).sort().join(',')}`;
  const solve = (b: RecapBeat, k: number) => {
    const ships: OBShip[] = b.units.map(u => ({
      id: u.id, faction: u.faction, fleet: null, size: u.size * k, armed: u.armed,
      clearR: clearOf(u.size * k),
    }));
    const order = o.order.filter(f => b.units.some(u => u.faction === f));
    for (const u of b.units) if (!order.includes(u.faction)) order.push(u.faction);
    return layoutOrbitBattle(ships, o.planetR, {
      seed: o.seed,
      factionOrder: order,
      station: b.stationId ? { id: b.stationId, clearR: clearOf(o.stationPx * k) } : undefined,
    });
  };
  /** How far the beat's farthest sprite edge reaches, px. */
  const reach = (b: RecapBeat, k: number) => {
    const lay = solve(b, k);
    let out = o.planetR;
    const sizeBy = new Map(b.units.map(u => [u.id, u.size * k]));
    for (const p of lay.placements.values()) out = Math.max(out, p.r + (sizeBy.get(p.id) ?? 0) / 2);
    if (lay.station) out = Math.max(out, lay.station.r + (o.stationPx * k) / 2);
    return out;
  };

  // FIT from the busiest beat (most room needed), then hold that scale.
  let k = 1;
  let busiest: RecapBeat | null = null;
  let most = -1;
  for (const b of beats) {
    const need = b.units.reduce((n, u) => n + u.size * u.size, 0)
      + (b.stationId ? o.stationPx * o.stationPx : 0);
    if (need > most) { most = need; busiest = b; }
  }
  if (busiest && busiest.units.length > 0) {
    for (let pass = 0; pass < 6; pass++) {
      const out = reach(busiest, k);
      if (out <= o.rMax) break;
      const room = Math.max(1, o.rMax - o.planetR);
      k = Math.max(K_FLOOR, k * Math.min(0.97, (room / Math.max(1, out - o.planetR)) * 0.98));
      if (k === K_FLOOR) break;
    }
  }

  const solved = new Map<string, Map<string, RecapSlot>>();
  const out: Map<string, RecapSlot>[] = [];
  const carry: Map<string, RecapSlot>[] = [];
  let last = new Map<string, RecapSlot>();
  for (const b of beats) {
    const key = keyOf(b);
    let slots = solved.get(key);
    if (!slots) {
      slots = new Map();
      const lay = solve(b, k);
      const all = [...lay.placements.values(), ...(lay.station ? [lay.station] : [])];
      for (const p of all) {
        const theta = Math.atan2(p.y, p.x);
        slots.set(p.id, { r: p.r, theta, jitter: p.heading - (theta + Math.PI / 2) });
      }
      solved.set(key, slots);
    }
    out.push(slots);
    last = new Map([...last, ...slots]);
    carry.push(last);
  }
  return { beats: out, carry, k };
}

/** Ease a unit from one place to the next, the short way round. */
export function glideSlot(from: RecapSlot, to: RecapSlot, u: number): RecapSlot {
  const TAU = Math.PI * 2;
  let d = (to.theta - from.theta) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return {
    r: from.r + (to.r - from.r) * u,
    theta: from.theta + d * u,
    jitter: from.jitter + (to.jitter - from.jitter) * u,
  };
}
