/**
 * A hull LEAVING a world moves on from where it was drawn.
 *
 * Two Studio clips, 2026-10-23:
 *  - "three-way battle of Earth": the Lunar Wing left Earth mid-battle. Its
 *    marker swept ~300 px round Earth in four frames, its hull was drawn
 *    over Earth's disc, and then it reversed back through the battle. The
 *    course starts at the hull's TRUE parking-orbit point, inside Earth's
 *    drawn disc on the far side from its battle slot; the hand-off dragged
 *    it there in a straight line (layout glide + a 1.3 s time blend), the
 *    disc clamp pushed it round the rim, and then the course carried it
 *    back the way it came.
 *  - "select and strike": eleven hulls ordered off Ganymede at badge zoom
 *    popped into existence at full size, and their selection rings stood
 *    at the empty formation slots while the sprites glided from somewhere
 *    else (the rings read the formation, the sprite was blended).
 *
 * The frames below replay those geometries through the same calls, in the
 * same order, that MapCanvas makes for a hull in flight.
 */
import {
  settleTransitLayout, keepOffDrawnDiscs, transitDrawnPos, transitHitWorldPos,
  recordDrawnShipWorldPos, continuousDrawnPos, departureLook, noteEmergence,
} from '../mapRenderer';

type P = { x: number; y: number };
type S = { t: number; x: number; y: number };

const FRAME_MS = 33;
const TICKS_PER_FRAME = 1 / 30;   // the Studio's fast tempo: a tick a second
const SCALE = 38;                 // px per world unit (the Earth close-up)

/** The world, drifting along its own orbit (the camera follows it). */
const world = (t: number): P => ({ x: 100 + 0.6 * t, y: 50 - 0.3 * t });

describe('a hull leaving a battle (the Lunar Wing)', () => {
  const T0 = 1;                                  // the departure tick
  const R = 250 / SCALE;                         // Earth's drawn disc, world units
  const SLOT = { x: 3, y: 8 };                   // its battle slot: lower right, outside the disc
  const P0 = { x: -3, y: 0 };                    // its true parking point: inside the disc, far side
  const dirRaw = { x: 43, y: 20 };               // toward Luna, through the disc
  const dl = Math.hypot(dirRaw.x, dirRaw.y);
  const DIR = { x: dirRaw.x / dl, y: dirRaw.y / dl };
  const A = 6.7;                                 // units / tick^2, a torch burn from rest
  /** The course, riding the world's frame. */
  const course = (t: number): P => {
    const w = world(t), tau = Math.max(0, t - T0), s = A * tau * tau;
    return { x: w.x + P0.x + DIR.x * s, y: w.y + P0.y + DIR.y * s };
  };
  const samples: S[] = [];
  for (let t = T0; t <= T0 + 6; t += 0.02) samples.push({ t, ...course(t) });

  const ID = 'g:lunar_wing_lead';
  const frames: Array<{ rel: P; hitRel: P; t: number }> = [];
  let lastParkedRel: P | null = null;
  for (let k = 0; k < 150; k++) {
    const nowMs = 500_000 + k * FRAME_MS;
    const t = T0 - 5 * TICKS_PER_FRAME + k * TICKS_PER_FRAME + 0.01;
    const w = world(t);
    if (t < T0) {
      // Parked in the battle: drawShip puts it at its slot, riding Earth.
      const kept = continuousDrawnPos(ID, w.x + SLOT.x, w.y + SLOT.y, SCALE, nowMs, { ...w, id: 'earth' });
      recordDrawnShipWorldPos(ID, kept.x, kept.y, 'parked');
      lastParkedRel = { x: kept.x - w.x, y: kept.y - w.y };
      continue;
    }
    // In flight: MapCanvas's pipeline for one hull (no formation).
    let placed = settleTransitLayout(ID, samples, samples, t, SCALE, nowMs, undefined, w);
    placed = keepOffDrawnDiscs(placed, [{ at: world, R, isDest: false }]);
    const drawn = transitDrawnPos(ID, placed, course(t), t, SCALE, nowMs);
    const hit = transitHitWorldPos(ID, placed, t);
    frames.push({ t, rel: { x: drawn.x - w.x, y: drawn.y - w.y }, hitRel: { x: hit.x - w.x, y: hit.y - w.y } });
  }
  const px = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y) * SCALE;

  test('the first frame in flight is where the battle drew it', () => {
    expect(px(frames[0].rel, lastParkedRel!)).toBeLessThan(4);
  });

  test('it never sweeps: no frame moves it more than its course does, plus a little', () => {
    for (let i = 1; i < frames.length; i++) {
      const courseStep = px(course(frames[i].t), course(frames[i - 1].t))
        - px(world(frames[i].t), world(frames[i - 1].t));
      expect(px(frames[i].rel, frames[i - 1].rel)).toBeLessThan(Math.max(0, courseStep) + 12);
    }
  });

  test('it is never drawn over the world it is leaving', () => {
    for (const f of frames) expect(Math.hypot(f.rel.x, f.rel.y) * SCALE).toBeGreaterThan(R * SCALE - 2);
  });

  test('it never backs up: every step is along its course', () => {
    for (let i = 1; i < frames.length; i++) {
      const sx = (frames[i].rel.x - frames[i - 1].rel.x) * SCALE;
      const sy = (frames[i].rel.y - frames[i - 1].rel.y) * SCALE;
      expect(sx * DIR.x + sy * DIR.y).toBeGreaterThan(-0.5);
    }
  });

  test('it ends up on its course', () => {
    const last = frames[frames.length - 1];
    const w = world(last.t), c = course(last.t);
    expect(px(last.rel, { x: c.x - w.x, y: c.y - w.y })).toBeLessThan(2);
  });

  test('its selection ring and click target are on the hull as drawn', () => {
    for (const f of frames) expect(px(f.hitRel, f.rel)).toBeLessThan(1);
  });
});

describe('the hand-off in live play', () => {
  // An hour a tick: in the seconds after the tick lands the course has
  // hardly moved. The hull holds its slot instead of crossing the world
  // to its course's start (which a timed blend did in 1.3 s).
  const course: S[] = [];
  for (let t = 5; t <= 9; t += 0.05) course.push({ t, x: (t - 5) * (t - 5) * 4, y: 0 });
  const slot = { x: 6, y: 6 };

  test('a hull whose course has not got going stays where the battle drew it', () => {
    recordDrawnShipWorldPos('live:a', slot.x, slot.y, 'parked');
    let last: P = slot;
    for (let k = 0; k < 120; k++) {
      const t = 5.0001 + k * 1e-5;              // two seconds of a one-hour tick
      const placed = settleTransitLayout('live:a', course, course, t, 40, 2_000_000 + k * 16, undefined, { x: 0, y: 0 });
      last = transitDrawnPos('live:a', placed, { x: 0, y: 0 }, t, 40, 2_000_000 + k * 16);
    }
    expect(Math.hypot(last.x - slot.x, last.y - slot.y) * 40).toBeLessThan(2);
  });

  test('a hull first seen well into its flight is drawn where it is', () => {
    recordDrawnShipWorldPos('live:b', slot.x, slot.y, 'parked');
    const t = 6;                                 // a whole tick into the leg
    const placed = settleTransitLayout('live:b', course, course, t, 40, 3_000_000, undefined, { x: 0, y: 0 });
    const at = transitDrawnPos('live:b', placed, { x: 0, y: 0 }, t, 40, 3_000_000);
    expect(Math.hypot(at.x - 4, at.y)).toBeLessThan(0.01);
  });

  test('a hull that was last drawn in flight is not handed off again', () => {
    // (It was drawn somewhere else in flight, as an escort in a block: the
    // layout glide brings it to its line in half a second, course or no.)
    recordDrawnShipWorldPos('live:c', slot.x, slot.y, 'flight');
    let placed: S[] = course;
    for (let k = 0; k < 60; k++) {
      placed = settleTransitLayout('live:c', course, course, 5.01 + k * 1e-5, 40, 4_000_000 + k * 16, undefined, { x: 0, y: 0 });
    }
    expect(Math.abs(placed[0].y) * 40).toBeLessThan(1);
  });
});

describe('a squadron leaving a world drawn as a badge (the strike on Europa)', () => {
  const T0 = 0.92;
  const R = 12 / 2;                               // Ganymede's drawn disc at map zoom, world units (scale 2)
  const SC = 2;
  const DIR = { x: 0.83, y: 0.56 };
  const A = 40;
  const course = (t: number): P => {
    const w = world(t), tau = Math.max(0, t - T0), s = A * tau * tau;
    return { x: w.x + 1 + DIR.x * s, y: w.y + DIR.y * s };
  };
  const samples: S[] = [];
  for (let t = T0; t <= T0 + 6; t += 0.02) samples.push({ t, ...course(t) });
  // Arrowhead slots (screen px off the lead's point), as placeInFormation gives.
  const SLOTS: P[] = [{ x: 0, y: 0 }, { x: -60, y: 30 }, { x: -60, y: -60 }, { x: -120, y: 0 }];
  const ids = SLOTS.map((_, i) => `g:strike_${i}`);
  const at: P[][] = ids.map(() => []);
  const hits: P[][] = ids.map(() => []);
  for (let k = 0; k < 60; k++) {
    const nowMs = 900_000 + k * FRAME_MS;
    const t = T0 + 0.004 + k * TICKS_PER_FRAME;
    ids.forEach((id, i) => {
      const placed0 = samples.map(p => ({ t: p.t, x: p.x + SLOTS[i].x / SC, y: p.y + SLOTS[i].y / SC }));
      // The client saw these hulls leave this frame; their world was a badge.
      const emerge = k === 0 ? world(t) : undefined;
      if (k === 0) noteEmergence(id, nowMs);
      let placed = settleTransitLayout(id, samples, placed0, t, SC, nowMs, emerge, world(t));
      placed = keepOffDrawnDiscs(placed, [{ at: world, R, isDest: false }]);
      const d = transitDrawnPos(id, placed, course(t), t, SC, nowMs);
      at[i].push({ x: (d.x - world(t).x) * SC, y: (d.y - world(t).y) * SC });
      const h = transitHitWorldPos(id, placed, t);
      hits[i].push({ x: (h.x - world(t).x) * SC, y: (h.y - world(t).y) * SC });
    });
  }

  test('they come out of the world, not out of nowhere at their slots', () => {
    for (let i = 0; i < ids.length; i++) expect(Math.hypot(at[i][0].x, at[i][0].y)).toBeLessThan(R * SC + 3);
  });

  test('the arrowhead opens without a jump', () => {
    for (let i = 0; i < ids.length; i++) {
      for (let k = 1; k < at[i].length; k++) {
        expect(Math.hypot(at[i][k].x - at[i][k - 1].x, at[i][k].y - at[i][k - 1].y)).toBeLessThan(30);
      }
    }
  });

  test('and they reach their slots', () => {
    const last = at.map(a => a[a.length - 1]);
    const c = (k: number) => course(T0 + 0.004 + k * TICKS_PER_FRAME);
    const w = world(T0 + 0.004 + 59 * TICKS_PER_FRAME);
    const lead = { x: (c(59).x - w.x) * SC, y: (c(59).y - w.y) * SC };
    for (let i = 0; i < ids.length; i++) {
      expect(Math.hypot(last[i].x - lead.x - SLOTS[i].x, last[i].y - lead.y - SLOTS[i].y)).toBeLessThan(3);
    }
  });

  test('the selection rings ride the hulls the whole way', () => {
    for (let i = 0; i < ids.length; i++) {
      for (let k = 0; k < at[i].length; k++) {
        expect(Math.hypot(hits[i][k].x - at[i][k].x, hits[i][k].y - at[i][k].y)).toBeLessThan(1);
      }
    }
  });

  test('a hull that was not drawn grows out of its world instead of popping in at full size', () => {
    noteEmergence('g:grow', 1_000_000);
    const first = departureLook('g:grow', 30, 0, 1_000_000);
    expect(first.size).toBeLessThan(15);
    const later = departureLook('g:grow', 30, 0, 1_000_000 + 5000);
    expect(later.size).toBe(30);
  });
});
