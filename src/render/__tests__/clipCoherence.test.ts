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
  continuousDrawnPos, CONTINUITY_TAU_MS,
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

  test('a hull not drawn for a while starts where it is', () => {
    continuousDrawnPos('gap', 0, 0, 1, 5000);
    expect(continuousDrawnPos('gap', 900, 0, 1, 6000)).toEqual({ x: 900, y: 0 });
  });
});
