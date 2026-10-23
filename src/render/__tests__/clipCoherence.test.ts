/**
 * The Mega Destroyer clip as a litmus test (Lorne, 2026-10-21: "an
 * incoherent mess. The ships overlap, pop around, blue flies entirely
 * backwards toward the enemy from the beginning, and then the mega
 * destroyer fires from offscreen").
 *
 * Held here: an intercepting hull points the way its manoeuvre points;
 * a change of layout glides instead of popping; a zero-length firing
 * window draws nothing; and a kill's blast stays near the hull.
 */
import {
  rendezvousAttitude, glideLayout, LAYOUT_GLIDE_TAU_MS, INTERCEPT_MIN_WINDOW_TICKS,
  continuousDrawnPos, CONTINUITY_TAU_MS, guardedEscortCanvasPos,
} from '../mapRenderer';
import { EXPLOSION_REACH } from '../fxArt';
import type { Ship } from '../../types';

const DOWN = Math.PI / 2, UP = -Math.PI / 2;
const near = (a: number, b: number) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d) < 0.05;
};

// The Guard: burns DOWN toward the raid for one tick, coasts down, burns
// UP for two ticks to match it, then flies up with it toward Earth.
const rv = {
  p0: { x: 0, y: 0 }, v0: { x: 0, y: 0 }, accel: 1,
  A: { x: 0, y: 1 }, B: { x: 0, y: -2 },
  startTick: 0, meetTick: 10, followShipId: 'raid',
  followTransfer: { startTick: 0, flipTick: 50, arriveTick: 60, targetBodyId: 'earth',
    startPos: { x: 0, y: 100 }, interceptPos: { x: 0, y: 0 } },
} as unknown as NonNullable<Ship['plannedRendezvous']>;
// Down until the meeting at T10, then up.
const path = [
  { t: 0, x: 0, y: 0 }, { t: 10, x: 0, y: 50 }, { t: 20, x: 0, y: 10 },
];

describe('an intercepting hull points the way it is flying', () => {
  test('nose toward the enemy on the first burn, engine lit', () => {
    const a = rendezvousAttitude(rv, 0.5, path)!;
    expect(near(a.heading, DOWN)).toBe(true);
    expect(a.thrusting).toBe(true);
  });

  test('coasting at the enemy it is NOT flipped round (the clip: nose home, flying out)', () => {
    const a = rendezvousAttitude(rv, 4, path)!;
    expect(near(a.heading, DOWN)).toBe(true);
    expect(a.thrusting).toBe(false);
  });

  test('the matching burn is a flip-and-brake: nose back, engine lit', () => {
    const a = rendezvousAttitude(rv, 9, path)!;
    expect(near(a.heading, UP)).toBe(true);
    expect(a.thrusting).toBe(true);
    expect(a.braking).toBe(true);
  });

  test('it swings round just before that burn, not from the launch', () => {
    // The plain leg underneath flipped half a tick after launch.
    expect(near(rendezvousAttitude(rv, 1.2, path)!.heading, DOWN)).toBe(true);
    const mid = rendezvousAttitude(rv, 7.9, path)!.heading;
    expect(near(mid, DOWN) || near(mid, UP)).toBe(false);   // mid-turn
  });

  test('once matched it flies nose-first with its leader', () => {
    const a = rendezvousAttitude(rv, 12, path)!;
    expect(near(a.heading, UP)).toBe(true);
  });
});

describe('a change of layout glides instead of popping', () => {
  test('a new hull starts where it is put; a later change eases over', () => {
    expect(glideLayout('t1', { x: 10, y: 0 }, 1000)).toEqual({ x: 10, y: 0 });
    // The slot jumps 60 px (a flagship died): one 16 ms frame later the
    // hull has moved a little of the way, not all of it.
    const f = glideLayout('t1', { x: 70, y: 0 }, 1016);
    expect(f.x).toBeGreaterThan(10);
    expect(f.x).toBeLessThan(20);
    let at = f;
    for (let ms = 1032; ms <= 1000 + LAYOUT_GLIDE_TAU_MS * 6; ms += 16) at = glideLayout('t1', { x: 70, y: 0 }, ms);
    expect(at.x).toBeCloseTo(70, 0);
  });

  test('a hull that was just drawn in another role starts from there', () => {
    // An escort promoted to flagship: it was drawn 40 px off, it starts there.
    expect(glideLayout('t2', { x: 0, y: 0 }, 2000, { x: 40, y: 0 })).toEqual({ x: 40, y: 0 });
    expect(glideLayout('t2', { x: 0, y: 0 }, 2016).x).toBeGreaterThan(30);
  });

  test('a hull not seen for a while snaps rather than sliding in from long ago', () => {
    glideLayout('t3', { x: 0, y: 0 }, 3000);
    expect(glideLayout('t3', { x: 90, y: 0 }, 9000)).toEqual({ x: 90, y: 0 });
  });
});

describe('effects stay with what made them', () => {
  test('a firing window that opens and shuts at once gets no marker', () => {
    expect(INTERCEPT_MIN_WINDOW_TICKS).toBeGreaterThan(0);
  });

  test('a kill blast reaches under two hull lengths, sparks under one and a half', () => {
    // R is about 0.47 of the hull's drawn size (drawDestructionFlashes).
    const hullsOf = (k: number) => k * 0.47;
    expect(hullsOf(EXPLOSION_REACH.shock)).toBeLessThan(2);
    expect(hullsOf(EXPLOSION_REACH.sparks)).toBeLessThan(1.5);
  });
});

describe('a hull never jumps on screen (the continuity guard)', () => {
  const run = (id: string, path: (i: number) => { x: number; y: number }, n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) { const p = path(i); out.push(continuousDrawnPos(id, p.x, p.y, 1, 1000 + i * 33)); }
    return out;
  };

  test('steady motion passes through untouched', () => {
    const out = run('steady', i => ({ x: i * 5, y: 0 }), 20);
    out.forEach((p, i) => expect(p.x).toBeCloseTo(i * 5, 6));
  });

  test('a hard burn (steady acceleration) passes through untouched', () => {
    const out = run('burn', i => ({ x: 0.4 * i * i, y: 0 }), 40);
    out.forEach((p, i) => expect(p.x).toBeCloseTo(0.4 * i * i, 6));
  });

  test('a teleport becomes a short slide that ends where the hull really is', () => {
    // Moving 3 px a frame, then its position is re-derived 300 px away.
    const out = run('tp', i => ({ x: i * 3 + (i >= 10 ? 300 : 0), y: 0 }), 10 + Math.ceil((CONTINUITY_TAU_MS * 5) / 33));
    // The frame of the jump stays on its line.
    expect(out[10].x - out[9].x).toBeLessThan(10);
    // No later frame steps more than a sliver of the gap at once.
    for (let i = 11; i < out.length; i++) expect(out[i].x - out[i - 1].x).toBeLessThan(80);
    // And it gets there.
    const last = out.length - 1;
    expect(out[last].x).toBeCloseTo(last * 3 + 300, -1);
  });

  test('a parked hull rides its world, however fast and curved the world moves', () => {
    // A moon swinging round its planet fast on screen (a close-up in a
    // time-lapse replay); the hull sits at a fixed spot beside it. Predicted
    // as a straight line in WORLD space every frame read as a jump, and
    // the absorbed offsets carried a whole fleet off the screen.
    const moon = (i: number) => ({ x: 600 * Math.cos(i * 0.35), y: 600 * Math.sin(i * 0.35) });
    for (let i = 0; i < 90; i++) {
      const m = moon(i);
      const p = continuousDrawnPos('rider', m.x + 40, m.y - 25, 3, 1000 + i * 33, { ...m, id: 'moon' });
      expect(Math.hypot(p.x - (m.x + 40), p.y - (m.y - 25)) * 3).toBeLessThan(1);
    }
  });

  test('caught jumps never stack into a runaway slide', () => {
    // Even if every frame looks like a jump, the drawn hull is never
    // further off than the one catch it is closing.
    for (let i = 0; i < 60; i++) {
      const p = continuousDrawnPos('wild', i % 2 ? 500 : -500, 0, 1, 1000 + i * 33);
      expect(Math.abs(p.x - (i % 2 ? 500 : -500))).toBeLessThanOrEqual(1001);
    }
  });

  test('a landing followed by a re-slot next frame is two slides, not a teleport', () => {
    // The match film, Triton: a hull in flight lands (new frame of
    // reference), then its orbit place is solved one frame later. The
    // second jump went through whole, ~1,000 px at the close-up.
    const scale = 50;
    const step = (i: number) => (i < 10 ? { x: i * 2, y: 0 } : i === 10 ? { x: 40, y: 0 } : { x: -10, y: 0 });
    let prev: { x: number; y: number } | null = null;
    const moves: number[] = [];
    for (let i = 0; i < 14; i++) {
      const p = step(i);
      const d = continuousDrawnPos('lander', p.x, p.y, scale, 70000 + i * 33,
        i < 10 ? undefined : { x: 0, y: 0, id: 'triton' });
      if (prev) moves.push(Math.hypot(d.x - prev.x, d.y - prev.y) * scale);
      prev = d;
    }
    // In flight it moved 100 px a frame; neither jump (1,000 then 2,500 px)
    // shows up as a frame-to-frame leap.
    for (const m of moves.slice(10)) expect(m).toBeLessThan(400);
  });

  test('after a catch, a hull whose motion changes does not pop (loose escorts in orbit)', () => {
    // The Mega Destroyer take, 2026-10-22: one catch froze the velocity, the
    // hull kept rounding its world, every later frame read as a jump, and
    // the stacked offset dropped at the cap: ~390 px pops every few frames.
    // 3 px a frame one way, then 25 px a frame another (scale 16).
    const at = (i: number) => (i < 10
      ? { x: (i * 3) / 16, y: 0 }
      : { x: 30 / 16, y: ((i - 9) * 25) / 16 });
    const steps: number[] = [];
    let prev: { x: number; y: number } | null = null;
    for (let i = 0; i < 120; i++) {
      const p = at(i);
      const d = continuousDrawnPos('rounding', p.x, p.y, 16, 50000 + i * 33, { x: 0, y: 0, id: 'earth' });
      if (prev) steps.push(Math.hypot(d.x - prev.x, d.y - prev.y) * 16);
      prev = d;
    }
    // A true step is 25 px; nothing ever lands as a pop.
    for (const s of steps) expect(s).toBeLessThan(60);
    const end = at(119), last = prev!;
    expect(Math.hypot(last.x - end.x, last.y - end.y) * 16).toBeLessThan(1);
  });

  test('a hull holding a screen-px slot through a zoom does not pop', () => {
    // Formation slots are screen px, so through a zoom the hull's WORLD spot
    // moves by slot/scale every frame: changing motion, never a jump.
    // Off where it truly is (screen px), frame by frame: never far, and
    // never changing by much in one frame (a pop is a big change).
    let prevOff: number | null = null;
    for (let i = 0; i < 60; i++) {
      const scale = 0.18 * Math.pow(1.09, i);
      const x = i * 0.5 + 120 / scale, y = 60 / scale;
      const d = continuousDrawnPos('slotzoom', x, y, scale, 70000 + i * 33);
      const off = Math.hypot(d.x - x, d.y - y) * scale;
      expect(off).toBeLessThan(60);
      if (prevOff != null) expect(Math.abs(off - prevOff)).toBeLessThan(30);
      prevOff = off;
    }
  });

  test('an escort that becomes the flagship slides, it does not snap', () => {
    // The Mega Destroyer take: the Earth Guard's flagship died, the block
    // re-centred, and the hull promoted to flagship moved from the escort
    // draw path to drawShip's on that frame, 300 px from where it was.
    const ctx = { canvas: { width: 1000, height: 800 }, camera: { x: 0, y: 0, scale: 1 }, nowMs: 0 } as never as Parameters<typeof guardedEscortCanvasPos>[0];
    const c = ctx as unknown as { nowMs: number };
    const drawn: number[] = [];
    for (let i = 0; i < 10; i++) {
      c.nowMs = 2000 + i * 33;
      const at = guardedEscortCanvasPos(ctx, 'promoted', 500 + i * 3, 400);   // escort path, canvas px
      drawn.push(at.x - 500);
    }
    // Now drawShip draws it (world units; camera at 0, scale 1, so world x = canvas x - 500).
    for (let i = 10; i < 10 + Math.ceil((CONTINUITY_TAU_MS * 5) / 33); i++) {
      drawn.push(continuousDrawnPos('promoted', i * 3 + 300, 0, 1, 2000 + i * 33).x);
    }
    expect(drawn[10] - drawn[9]).toBeLessThan(10);
    for (let i = 11; i < drawn.length; i++) expect(drawn[i] - drawn[i - 1]).toBeLessThan(80);
    expect(drawn[drawn.length - 1]).toBeCloseTo((drawn.length - 1) * 3 + 300, -1);
  });

  test('a hull guarded twice in one frame keeps one history and still slides', () => {
    // Two draw paths guarding the same escort each frame used to reset the
    // guard on the second call, so a teleport went straight through.
    const out: number[] = [];
    for (let i = 0; i < 10 + Math.ceil((CONTINUITY_TAU_MS * 5) / 33); i++) {
      const ms = 40000 + i * 33;
      const tx = i * 3 + (i >= 10 ? 300 : 0);
      const a = continuousDrawnPos('twice', tx, 0, 1, ms);
      const b = continuousDrawnPos('twice', a.x, a.y, 1, ms);   // the second path, same frame
      expect(b.x).toBeCloseTo(a.x, 6);
      out.push(b.x);
    }
    expect(out[10] - out[9]).toBeLessThan(10);
    for (let i = 11; i < out.length; i++) expect(out[i] - out[i - 1]).toBeLessThan(80);
    // And it gets there: with the guard reset by the second call, the hull
    // stayed caught on its old line, then popped across when released.
    const last = out.length - 1;
    expect(out[last]).toBeCloseTo(last * 3 + 300, -1);
  });

  test('a re-centred escort block slides', () => {
    const ctx = { canvas: { width: 1000, height: 800 }, camera: { x: 0, y: 0, scale: 1 }, nowMs: 0 } as never as Parameters<typeof guardedEscortCanvasPos>[0];
    const c = ctx as unknown as { nowMs: number };
    const xs: number[] = [];
    for (let i = 0; i < 30; i++) {
      c.nowMs = 9000 + i * 33;
      xs.push(guardedEscortCanvasPos(ctx, 'escort-block', 500 + (i >= 10 ? 250 : 0), 400).x);
    }
    expect(xs[10] - xs[9]).toBeLessThan(10);
    for (let i = 11; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThan(80);
  });

  test('a caught jump starts from rest: no kick on the first frame of the slide', () => {
    // 3 px a frame, then re-derived 1,000 px away (an arriving fleet re-slotted).
    const out = run('kick', i => ({ x: i * 3 + (i >= 10 ? 1000 : 0), y: 0 }), 60);
    const step = (i: number) => out[i].x - out[i - 1].x;
    // The first frames of the slide barely move beyond its own 3 px...
    expect(step(11)).toBeLessThan(12);
    // ...and the speed builds frame on frame rather than arriving at once.
    for (let i = 12; i < 16; i++) expect(Math.abs(step(i) - step(i - 1))).toBeLessThan(25);
  });

  test('a hull not drawn for a while starts where it is', () => {
    continuousDrawnPos('gap', 0, 0, 1, 5000);
    expect(continuousDrawnPos('gap', 900, 0, 1, 6000)).toEqual({ x: 900, y: 0 });
  });
});
