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
  // CLEAR OF THE DISC (Lorne, 2026-10-09: "expand the orbit a bit so
  // ships don't spend a whole arc of the battle behind the planet"). Seen
  // through the tilt, a hull straight behind the world sits only r x tilt
  // above its centre, so anything inside planetR / tilt vanished behind
  // the disc for a whole arc of every turn. The band starts there instead:
  // on the far side the hulls skim just over the world's top limb, and
  // every one of them stays in view all the way round.
  //
  // The solver keeps every body at least its own clearance (+3) off the
  // radius it is given, and starts the band a whole BIGGEST clearance off
  // it, so one destroyer pushed every corvette out with it. Handing it
  // the clear-of-disc radius less the SMALLEST clearance keeps each hull's
  // centre over the limb without that extra ring of empty space.
  const minClear = Math.min(...beats.flatMap(b => b.units.map(u => clearOf(u.size))), Infinity);
  const innerR = Math.max(o.planetR, o.planetR / tilt - (Number.isFinite(minClear) ? minClear + 3 : 0));

  const keyOf = (b: RecapBeat) =>
    `${b.stationId ?? ''}|${b.units.map(u => u.id).sort().join(',')}`;
  const solve = (b: RecapBeat, k: number) => {
    const ships: OBShip[] = b.units.map(u => ({
      id: u.id, faction: u.faction, fleet: null, size: u.size * k, armed: u.armed,
      clearR: clearOf(u.size * k),
    }));
    const order = o.order.filter(f => b.units.some(u => u.faction === f));
    for (const u of b.units) if (!order.includes(u.faction)) order.push(u.faction);
    return layoutOrbitBattle(ships, innerR, {
      seed: o.seed,
      factionOrder: order,
      station: b.stationId ? { id: b.stationId, clearR: clearOf(o.stationPx * k) } : undefined,
    });
  };
  /** How far the beat's farthest sprite edge reaches, px. */
  const reach = (b: RecapBeat, k: number) => {
    const lay = solve(b, k);
    let out = innerR;
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
  // The LARGEST scale that fits, by bisection. Shrinking in proportion to
  // the overflow overshot badly: a fight a few pixels too deep lost a
  // third of its sprite size.
  if (busiest && busiest.units.length > 0 && reach(busiest, 1) > o.rMax) {
    let lo = K_FLOOR, hi = 1;
    for (let pass = 0; pass < 7; pass++) {
      const mid = (lo + hi) / 2;
      if (reach(busiest, mid) <= o.rMax) lo = mid; else hi = mid;
    }
    k = lo;
  }

  const solved = new Map<string, Map<string, RecapSlot>>();
  const fresh = (b: RecapBeat) => {
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
    return slots;
  };

  // STICKY. Lorne, the same day: "the orbit of the ships keeps rapidly
  // readjusting whenever ships leave or explode." Re-solving every beat
  // moved every survivor whenever one hull went. So a beat only re-solves
  // the whole fight when a side that was NOT on the board joins it (or
  // the station changes): its share of the orbit has to come from
  // somewhere. Otherwise a hull that leaves or dies just leaves a gap,
  // and a hull that arrives takes the place a full solve would give it,
  // nudged clear of the hulls already there, which do not move.
  const out: Map<string, RecapSlot>[] = [];
  const carry: Map<string, RecapSlot>[] = [];
  let last = new Map<string, RecapSlot>();
  let live = new Map<string, RecapSlot>();
  let liveFactions = new Set<string>();
  let liveStation: string | undefined;
  for (const b of beats) {
    const factions = new Set(b.units.map(u => u.faction));
    const was = live, wasFactions = liveFactions;
    const newSide = [...factions].some(f => !wasFactions.has(f));
    let slots: Map<string, RecapSlot>;
    if (was.size === 0 || newSide || b.stationId !== liveStation) {
      slots = fresh(b);
    } else {
      slots = new Map();
      const ids = [...b.units.map(u => u.id), ...(b.stationId ? [b.stationId] : [])];
      const newcomers = ids.filter(id => !was.has(id));
      for (const id of ids) if (was.has(id)) slots.set(id, was.get(id)!);
      if (newcomers.length > 0) {
        const want = fresh(b);
        const sizeOf = new Map(b.units.map(u => [u.id, u.size * k]));
        if (b.stationId) sizeOf.set(b.stationId, o.stationPx * k);
        placeNewcomers(slots, newcomers.map(id => ({ id, slot: want.get(id)! })),
          id => clearOf(sizeOf.get(id) ?? 0), innerR);
      }
    }
    out.push(slots);
    live = slots;
    liveFactions = factions;
    liveStation = b.stationId;
    last = new Map([...last, ...slots]);
    carry.push(last);
  }
  return { beats: out, carry, k };
}

/** Add `incoming` to `slots` where a full solve wanted them, then push
 *  ONLY the newcomers apart from everything (the hulls already placed
 *  never move) until no clearances overlap. */
function placeNewcomers(
  slots: Map<string, RecapSlot>,
  incoming: Array<{ id: string; slot: RecapSlot }>,
  clearOf: (id: string) => number,
  planetR: number,
): void {
  const fixed = [...slots.entries()].map(([id, s]) => ({
    x: s.r * Math.cos(s.theta), y: s.r * Math.sin(s.theta), c: clearOf(id),
  }));
  const moving = incoming.map(({ id, slot }) => ({
    id, jitter: slot.jitter, c: clearOf(id),
    x: slot.r * Math.cos(slot.theta), y: slot.r * Math.sin(slot.theta),
  }));
  for (let it = 0; it < 240; it++) {
    let moved = false;
    for (let i = 0; i < moving.length; i++) {
      const a = moving[i];
      const others = [
        ...fixed.map(f => ({ ...f, share: 1 })),
        ...moving.filter((_, j) => j !== i).map(m => ({ x: m.x, y: m.y, c: m.c, share: 0.5 })),
      ];
      for (const o of others) {
        const dx = a.x - o.x, dy = a.y - o.y;
        const need = a.c + o.c + 2;
        const d2 = dx * dx + dy * dy;
        if (d2 >= need * need) continue;
        const d = Math.sqrt(d2) || 0.01;
        const ux = d2 > 0 ? dx / d : Math.cos(i + it), uy = d2 > 0 ? dy / d : Math.sin(i + it);
        a.x += ux * (need - d) * o.share;
        a.y += uy * (need - d) * o.share;
        moved = true;
      }
      // Off the planet, always.
      const r = Math.hypot(a.x, a.y) || 1;
      const rMin = planetR + a.c + 3;
      if (r < rMin) { a.x *= rMin / r; a.y *= rMin / r; }
    }
    if (!moved) break;
  }
  // Boxed in (between hulls that cannot move and the planet, pushing
  // shuffles it back and forth): take the nearest free spot instead,
  // searching outward from where the relaxation left it.
  const placed = [...fixed];
  const freeAt = (x: number, y: number, c: number) =>
    Math.hypot(x, y) >= planetR + c + 3
    && placed.every(f => Math.hypot(x - f.x, y - f.y) >= c + f.c + 2);
  for (const m of moving) {
    if (!freeAt(m.x, m.y, m.c)) {
      search: for (let rho = 3; rho <= 600; rho += 3) {
        const steps = Math.max(8, Math.ceil((Math.PI * 2 * rho) / 3));
        for (let s = 0; s < steps; s++) {
          const a = (s / steps) * Math.PI * 2;
          const x = m.x + Math.cos(a) * rho, y = m.y + Math.sin(a) * rho;
          if (freeAt(x, y, m.c)) { m.x = x; m.y = y; break search; }
        }
      }
    }
    placed.push(m);
    slots.set(m.id, { r: Math.hypot(m.x, m.y), theta: Math.atan2(m.y, m.x), jitter: m.jitter });
  }
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
