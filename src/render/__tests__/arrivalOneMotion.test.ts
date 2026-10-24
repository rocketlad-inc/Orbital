/**
 * AN ARRIVAL IS ONE MOTION (Studio take "strike4", 2026-10-23, Ganymede to
 * Europa). Lorne: "smoothen out the transition from transit to orbit ...
 * make sure it's smooth and nice for the camera".
 *
 * Measured off the take's trace (per-hull drawn positions, 30 fps, 60 px
 * a unit, Europa moving 60 px a frame), eleven hulls arriving made FOUR
 * motions with three breaks between them:
 *  - f360: the course reached the arrival standoff and the hold took the
 *    radial speed off in one frame (160 -> 97 px/frame);
 *  - f366-367: the course point came within 5% of the standoff of the
 *    world's centre, the hold's bearing snapped to the approach side, and
 *    every hull jumped 75-93 px (caught by the continuity guard, which then
 *    slid the fleet ~400 px in a straight line ACROSS the disc);
 *  - f372 (T9, landed): the fleet stopped dead, held where it was drawn
 *    while the roster dwell (1.5 s) kept the newcomers out of the layout;
 *  - f423: it set off again, round the moon to its slot.
 *
 * Replayed here through the calls MapCanvas makes (the roster, the layout,
 * the in-flight hold, the guard, the parked draw), with the take's
 * geometry: an arrowhead braking in from upper left to a moon running
 * right, a hostile fight and a station already in orbit there. On the
 * code of the take this replay reproduced it frame for frame: a 138 px a
 * frame per frame lurch at the snap, a hull drawn 138 px from the centre
 * of a 184 px disc, a dead stop at the landing and a 45-frame hold.
 *
 * Checked, from a tick before the landing to four after: the guard never
 * has to catch anything; no frame's change of velocity is far past the
 * course's own brake; no hull comes to rest and sets off again; none is
 * drawn over the disc; each has its place in the layout before it lands,
 * carries straight on through the landing and is in that place
 * ARRIVAL_SETTLE_TICKS later. For the take, a lone hull, a plain parking
 * orbit, and arrivals from every side.
 */
import {
  torchTrajectorySamples, formationSlot, settleTransitLayout, approachWorlds, transitDrawnPos,
  continuousDrawnPos, recordDrawnShipWorldPos, battleLocalPos, battleUnitsFor, shipIconSize,
  flightReachPx, forgetDrawnShips,
} from '../mapRenderer';
import { liveBattleFor, resetLiveBattles, battleScale, battleSlotPx, type LiveBattle } from '../battleLayoutLive';
import { worldRosters, resetCaptures, ARRIVAL_SETTLE_TICKS } from '../arrivalApproach';
import { torchPositionFromSamples } from '../../physics/torchTransfer';
import type { Ship, TorchTransferPlan } from '../../types';

type P = { x: number; y: number };

const SCALE = 60;                       // px per world unit (the take's close-up)
const FRAME_MS = 1000 / 30;
const TICKS_PER_FRAME = 1 / 24;         // the take: tick 8 to 9 in 24 frames
const DRAWN_R = 184;                    // Europa's drawn radius at that zoom, px
const EUROPA = { type: 'moon', radius: 1.5 };
const ARRIVE = 9;

/** Europa round Jupiter: 24 units a tick, running +x at the arrival. */
const OMEGA = 0.4, ORBIT_R = 60;
const world = (t: number): P => {
  const a = -Math.PI / 2 + OMEGA * (t - ARRIVE);
  return { x: Math.cos(a) * ORBIT_R, y: Math.sin(a) * ORBIT_R };
};

/** The strike's leg: a shaped burn (boost to T8, hard brake to rest at
 *  T8.7, a ceiled arrival at T9), in from the upper left. */
function legFrom(dirDeg: number): TorchTransferPlan {
  const a = 20, k = 10, t1 = 7;
  const D = 0.5 * a * t1 * t1 + (a * t1) ** 2 / (2 * k * a);
  const end = world(ARRIVE);
  const u = { x: Math.cos((dirDeg * Math.PI) / 180), y: Math.sin((dirDeg * Math.PI) / 180) };
  return {
    targetBodyId: 'europa', acceleration: a, brakeAcceleration: a * k,
    startTick: ARRIVE - 8, flipTick: ARRIVE - 8 + t1, arriveTick: ARRIVE,
    thrustDir: { x: -u.x, y: -u.y }, interceptPos: end,
    startPos: { x: end.x + u.x * D, y: end.y + u.y * D }, startVel: { x: 0, y: 0 },
    totalDv: 0, peakVelocity: a * t1,
  } as TorchTransferPlan;
}

const CLASSES = ['destroyer', 'destroyer', 'destroyer', 'destroyer', 'frigate', 'frigate',
  'frigate', 'frigate', 'corvette', 'corvette', 'corvette'];
const FOES = ['destroyer', 'destroyer', 'destroyer', 'frigate', 'frigate', 'frigate', 'corvette', 'corvette'];

function ship(id: string, owner: string, cls: string, leg: TorchTransferPlan | null, home: string, queued = false): Ship {
  return {
    id, ownedBy: owner, class: cls, homeBodyId: home,
    orbit: { parentBodyId: leg ? 'ganymede' : 'europa', direction: 1 },
    transit: leg ? { currentTransfer: leg, pos: leg.startPos, vel: { x: 0, y: 0 } } : undefined,
    // A next leg queued behind this one: it is not laid out before it lands.
    queuedTransits: queued ? [leg] : undefined,
  } as unknown as Ship;
}

interface Run {
  /** Per hull, per frame: drawn spot relative to Europa's centre, screen px. */
  rel: Map<string, P[]>;
  t: number[];
  lb: LiveBattle;
  /** Per hull, per frame: its place in the layout, screen px (null: none). */
  slots: Map<string, Array<P | null>>;
  /** Per hull: the most the continuity guard moved it off its own path. */
  guarded: Map<string, number>;
}

function replay(o: { hulls: number; foes: number; station: boolean; fromDeg?: number; queued?: boolean }): Run {
  resetLiveBattles();
  resetCaptures();
  forgetDrawnShips();
  const leg = legFrom(o.fromDeg ?? -150);
  const samples = torchTrajectorySamples(leg, []);
  const ids = Array.from({ length: o.hulls }, (_, i) => `g:st_strike_${i}`);
  const foes = FOES.slice(0, o.foes).map((c, i) => ship(`g:st_foe_${i}`, 'mars', c, null, 'europa'));
  // Each hull's arrowhead slot, off the lead's course (placeInFormation).
  const dl = Math.hypot(leg.interceptPos.x - leg.startPos.x, leg.interceptPos.y - leg.startPos.y);
  const tan = { x: (leg.interceptPos.x - leg.startPos.x) / dl, y: (leg.interceptPos.y - leg.startPos.y) / dl };
  const offs = ids.map((_, i) => {
    const { back, side } = formationSlot(i);
    const along = (-back * 34) / SCALE, across = (side * 17) / SCALE;
    return { x: tan.x * along + tan.y * across, y: tan.y * along - tan.x * across };
  });
  const reach = flightReachPx(shipIconSize('destroyer', false));
  const rel = new Map<string, P[]>(ids.map(id => [id, []]));
  const guarded = new Map<string, number>();
  const slots = new Map<string, Array<P | null>>(ids.map(id => [id, []]));
  const t: number[] = [];
  let lb: LiveBattle | undefined;
  // A tick of warm-up before anything is judged: the guard needs a
  // hull's motion before it can tell a jump from it.
  const T0 = ARRIVE - 3;
  for (let f = 0; f <= 72 + 120; f++) {
    const tick = T0 + f * TICKS_PER_FRAME;
    const nowMs = 1_000_000 + f * FRAME_MS;
    // The state: the server's last tick. The hulls land on the tick of
    // their arrival.
    const currentTick = Math.floor(tick + 1e-9);
    const landed = currentTick >= ARRIVE;
    const ships = [...foes, ...ids.map((id, i) => ship(id, 'terra', CLASSES[i], landed ? null : leg, 'ganymede', !!o.queued))];
    const byId = new Map(ships.map(s => [s.id, s]));
    // MapCanvas's formation pass for Europa.
    const rosters = worldRosters(ships, () => true, { currentTick });
    const atBody = (rosters.byBody.get('europa') ?? []).sort((a, b) => (a.id < b.id ? -1 : 1));
    const units = battleUnitsFor(atBody, 'europa', { collapsed: new Set(), markerByLeadShip: new Map() },
      byId, rosters.arriving);
    const owners = [...new Set(atBody.map(s => s.ownedBy))].sort();
    const battle = liveBattleFor('europa', EUROPA, 1, units, owners, o.station ? 'stn' : undefined, { nowMs });
    lb = battle;
    const c = world(tick);
    const k = battleScale(battle, DRAWN_R);
    ids.forEach((id, i) => {
      let d: P, raw: P;
      if (!landed) {
        // MapCanvas's in-flight pipeline for one hull.
        const placed0 = samples.map(p => ({ t: p.t, x: p.x + offs[i].x, y: p.y + offs[i].y }));
        let placed = settleTransitLayout(id, samples, placed0, tick, SCALE, nowMs, undefined, leg.startPos);
        placed = approachWorlds(id, placed, samples, [
          { id: 'europa', at: world, drawnR: DRAWN_R, isDest: true, battle },
          { id: 'ganymede', at: () => leg.startPos, drawnR: 150, isDest: false },
        ], leg, SCALE, reach, nowMs);
        raw = torchPositionFromSamples(placed, tick);
        d = transitDrawnPos(id, placed, leg.startPos, tick, SCALE, nowMs);
      } else {
        // drawShip, parked at a laid-out world.
        const at = battleLocalPos(id, battle, k, c, SCALE, nowMs, tick);
        const lx = at ? at.lx : 0, ly = at ? at.ly : 0;
        raw = { x: c.x + lx, y: c.y + ly };
        d = continuousDrawnPos(id, raw.x, raw.y, SCALE, nowMs, { ...c, id: 'europa' });
        recordDrawnShipWorldPos(id, d.x, d.y, 'parked');
      }
      rel.get(id)!.push({ x: (d.x - c.x) * SCALE, y: (d.y - c.y) * SCALE });
      // How far the continuity guard had to move it off its own path
      // (from two ticks out: the arrival, admission included).
      if (tick >= ARRIVE - 2) {
        guarded.set(id, Math.max(guarded.get(id) ?? 0, Math.hypot(d.x - raw.x, d.y - raw.y) * SCALE));
      }
      // Its place in the layout this frame (the battle wheel turns it).
      const s = battleSlotPx(battle, id, nowMs, k);
      slots.get(id)!.push(s ? { x: s.x, y: s.y } : null);
    });
    t.push(tick);
  }
  return { rel, t, lb: lb!, slots, guarded };
}

/** ARRIVAL_DUMP=prefix: each scenario's per-frame drawn spots and slots,
 *  to read the replay frame by frame as scripts/jump-check.py reads a
 *  take (prefix.<name>.json). */
function dump(name: string, r: Run): void {
  const out = process.env.ARRIVAL_DUMP;
  if (!out) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('fs').writeFileSync(`${out}.${name}.json`, JSON.stringify({
    t: r.t, rel: Object.fromEntries(r.rel), slots: Object.fromEntries(r.slots), drawnR: DRAWN_R,
  }));
}

const sub = (a: P, b: P) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: P) => Math.hypot(a.x, a.y);

/** Frames from the last tick of the flight to well after the landing. */
const inArrival = (r: Run, f: number) => r.t[f] >= ARRIVE - 1;

/** Worst frame-to-frame change of velocity (screen px per frame per frame). */
function worstAccel(r: Run): { a: number; id: string; f: number } {
  let worst = { a: 0, id: '', f: -1 };
  for (const [id, ps] of r.rel) {
    for (let f = 2; f < ps.length; f++) {
      if (!inArrival(r, f - 2)) continue;
      const a = len(sub(sub(ps[f], ps[f - 1]), sub(ps[f - 1], ps[f - 2])));
      if (a > worst.a) worst = { a, id, f };
    }
  }
  return worst;
}

/** A hull that came to rest (under 1 px a frame) and then moved off
 *  again (over 4 px a frame): the hold-then-glide. */
function stopThenMove(r: Run): Array<{ id: string; stop: number; go: number }> {
  const out: Array<{ id: string; stop: number; go: number }> = [];
  for (const [id, ps] of r.rel) {
    let stop = -1;
    for (let f = 1; f < ps.length; f++) {
      if (!inArrival(r, f)) continue;
      const v = len(sub(ps[f], ps[f - 1]));
      if (v < 1 && stop < 0) stop = f;
      if (v > 4 && stop >= 0) { out.push({ id, stop, go: f }); break; }
    }
  }
  return out;
}

const CLEAR_PX = 10;
function closestToWorld(r: Run): { d: number; id: string; f: number } {
  let best = { d: Infinity, id: '', f: -1 };
  for (const [id, ps] of r.rel) {
    for (let f = 0; f < ps.length; f++) {
      if (inArrival(r, f) && len(ps[f]) < best.d) best = { d: len(ps[f]), id, f };
    }
  }
  return best;
}

/** The course's own hard brake at this zoom, px per frame per frame. */
const BRAKE_PX = (200 * SCALE) * TICKS_PER_FRAME * TICKS_PER_FRAME;
/** The take's geometry stays within ~1.1x its brake. Head-on into a moon
 *  running at it (60 px a frame here) a hull also has to shed the moon's
 *  closing speed, and peaks at ~1.65x. Today's code: 6.6x (138 px). */
const MAX_ACCEL = BRAKE_PX * 1.75;

/** Worst distance from its place in the layout, from `fromTick` on. */
function offSlot(r: Run, fromTick: number): number {
  let worst = 0;
  for (const [id, ps] of r.rel) {
    const ss = r.slots.get(id)!;
    for (let f = 0; f < ps.length; f++) {
      if (r.t[f] < fromTick) continue;
      const s = ss[f];
      worst = Math.max(worst, s ? len(sub(ps[f], s)) : Infinity);
    }
  }
  return worst;
}

describe('eleven hulls arriving at a moon with a fight in orbit (the take)', () => {
  let r: Run;
  beforeAll(() => {
    r = replay({ hulls: 11, foes: 8, station: true });
    dump('take', r);
  });

  test('no hull jumps or lurches: acceleration stays near the course’s own brake', () => {
    expect(worstAccel(r).a).toBeLessThan(MAX_ACCEL);
  });

  test('no hull stops and then sets off again', () => {
    expect(stopThenMove(r)).toEqual([]);
  });

  test('no hull is ever drawn over the moon', () => {
    expect(closestToWorld(r).d).toBeGreaterThan(DRAWN_R + CLEAR_PX);
  });

  test('every hull is in its place in the layout once it has settled, and stays there', () => {
    expect(offSlot(r, ARRIVE + ARRIVAL_SETTLE_TICKS)).toBeLessThan(2);
  });

  test('the hulls have their places before they land (the layout took them in flight)', () => {
    const before = r.t.findIndex(x => x >= ARRIVE - 1);
    for (const ss of r.slots.values()) expect(ss[before]).not.toBeNull();
  });

  test('the landing is not a stop: each hull is still moving the frame it lands', () => {
    const landF = r.t.findIndex(x => x >= ARRIVE);
    for (const ps of r.rel.values()) {
      const before = len(sub(ps[landF - 1], ps[landF - 2]));
      const at = len(sub(ps[landF], ps[landF - 1]));
      const after = len(sub(ps[landF + 1], ps[landF]));
      // The same motion either side of the landing, not a halt or a kick.
      expect(Math.abs(at - before)).toBeLessThan(MAX_ACCEL);
      expect(Math.abs(after - at)).toBeLessThan(MAX_ACCEL);
    }
  });
});

/** The most the continuity guard had to move any hull off its own path:
 *  an arrival that is one motion gives it nothing to catch. */
const worstGuarded = (r: Run) => Math.max(0, ...r.guarded.values());

function oneMotion(r: Run): void {
  expect(worstGuarded(r)).toBeLessThan(1);
  expect(worstAccel(r).a).toBeLessThan(MAX_ACCEL);
  expect(stopThenMove(r)).toEqual([]);
  expect(closestToWorld(r).d).toBeGreaterThan(DRAWN_R + CLEAR_PX);
  expect(offSlot(r, ARRIVE + ARRIVAL_SETTLE_TICKS)).toBeLessThan(2);
}

describe('a lone hull, and a world with nobody else at it', () => {
  test('a lone hull into the fight, from the far side: one motion, off the disc', () => {
    const r = replay({ hulls: 1, foes: 8, station: true, fromDeg: 160 });
    dump('lone', r);
    oneMotion(r);
  });

  test('a squadron into a plain parking orbit (no fight, no station): the same', () => {
    const r = replay({ hulls: 5, foes: 0, station: false, fromDeg: -60 });
    dump('quiet', r);
    oneMotion(r);
  });

  test('from every side', () => {
    for (let deg = -180; deg < 180; deg += 45) {
      const r = replay({ hulls: 3, foes: 8, station: true, fromDeg: deg });
      dump(`from${deg}`, r);
      oneMotion(r);
    }
  });
});

describe('a hull that lands without a place yet (a next leg queued: the old hold)', () => {
  // Not laid out before it lands (it leaves again), so it is still held at
  // the arrival standoff in flight. The hold no longer snaps to the
  // approach side at the world's centre (strike4 f366-f372: ~90 px jumps,
  // then a chord straight across Europa).
  let r: Run;
  beforeAll(() => {
    r = replay({ hulls: 11, foes: 8, station: true, queued: true });
    dump('queued', r);
  });

  test('it is not laid out early', () => {
    const before = r.t.findIndex(x => x >= ARRIVE - 0.5);
    for (const ss of r.slots.values()) expect(ss[before]).toBeNull();
  });

  test('in flight it never cuts across the disc', () => {
    let near = Infinity;
    for (const ps of r.rel.values()) {
      for (let f = 0; f < ps.length; f++) {
        if (r.t[f] >= ARRIVE - 1 && r.t[f] < ARRIVE) near = Math.min(near, len(ps[f]));
      }
    }
    expect(near).toBeGreaterThan(DRAWN_R + CLEAR_PX);
  });
});
