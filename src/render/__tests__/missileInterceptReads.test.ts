/**
 * A SALVO SHOT DOWN IN FLIGHT READS AS ONE: they meet, a burst, gone.
 *
 * Studio clip "Salvos shot down in flight" (prod, 2026-10-23, trace.jsonl):
 *  - f155 both missiles reach the meeting point; f156 each is drawn a
 *    frame PAST it (msl_0 1985 -> 1993, 383 px), flying through the
 *    other, then both slide back onto the meeting over ~16 frames. The
 *    continuity guard read the stop (the map holds the next tick's spot
 *    until the server tick lands) as a teleport and absorbed it.
 *  - f13 -> f14 the salvo went from still to ~270 px a frame: its line
 *    was a plain two-point chord, lerped at constant speed from launch.
 *  - the shoot-down played as 'damage', the 6 px "took fire" spark, at
 *    the true meeting point rather than where the two were drawn.
 */
import { continuousDrawnPos, torchTrajectorySamples, isPushOnly } from '../mapRenderer';
import { torchPositionFromSamples } from '../../physics/torchTransfer';
import { ingestChronicleFx, drainVisibleFx, resetPendingFx, fxKindFor, PendingFx } from '../pendingFx';
import type { Body } from '../../types';

describe('a missile that stops at its meeting', () => {
  it('is drawn where it stopped, not a frame past it', () => {
    const scale = 30;
    const id = 'g:msl_stop';
    let ms = 1000;
    let x = 1900, y = -80;
    // Flying at ~9 units a frame (~270 px), as in the clip.
    for (let k = 0; k < 20; k++) {
      continuousDrawnPos(id, x, y, scale, ms);
      x += 6.5; y -= 6.5; ms += 33;
    }
    const stopX = x, stopY = y;
    // It stops dead (the meeting) and stays.
    for (let k = 0; k < 20; k++) {
      const d = continuousDrawnPos(id, stopX, stopY, scale, ms);
      expect(Math.hypot(d.x - stopX, d.y - stopY) * scale).toBeLessThan(1);
      ms += 33;
    }
  });

  it('a real teleport is still smoothed', () => {
    const scale = 30;
    const id = 'g:hull_tp';
    let ms = 1000;
    let x = 0;
    for (let k = 0; k < 10; k++) { continuousDrawnPos(id, x, 0, scale, ms); x += 0.2; ms += 33; }
    const d = continuousDrawnPos(id, x + 30, 0, scale, ms);   // 900 px off in one frame
    expect(Math.abs(d.x - (x + 30)) * scale).toBeGreaterThan(100);
  });
});

describe('a salvo leaves its world from rest', () => {
  const plan = {
    targetBodyId: 'mars', startTick: 1, flipTick: 6, arriveTick: 6,
    startPos: { x: 802, y: 1110 }, interceptPos: { x: 2230, y: -455 },
    startVel: { x: 0, y: 0 }, acceleration: 115, brakeAcceleration: 115,
    thrustDir: { x: 0.67, y: -0.74 }, peakVelocity: 0, totalDv: 0,
  } as never;

  it('pushes the whole way (a salvo leg)', () => {
    expect(isPushOnly(plan)).toBe(true);
    expect(isPushOnly({ startTick: 1, flipTick: 3, arriveTick: 6 })).toBe(false);
  });

  it('creeps off and gathers speed: no full-speed first frame', () => {
    const s = torchTrajectorySamples(plan, [] as Body[]);
    const p0 = torchPositionFromSamples(s, 1);
    const p1 = torchPositionFromSamples(s, 1 + 1 / 30);
    const pEnd = torchPositionFromSamples(s, 6);
    const step = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
    const whole = step(p0, pEnd);
    // A constant-speed chord covered 1/150 of the line in that frame.
    expect(step(p0, p1)).toBeLessThan(whole / 150 / 10);
    expect(pEnd.x).toBeCloseTo(2230, 6);
    expect(pEnd.y).toBeCloseTo(-455, 6);
    // ...and it is faster at the end than at the start.
    const late = step(torchPositionFromSamples(s, 6 - 1 / 30), pEnd);
    expect(late).toBeGreaterThan(step(p0, p1) * 20);
  });
});

describe('the shoot-down', () => {
  beforeEach(() => { resetPendingFx(); try { localStorage.clear(); } catch { /* jsdom */ } });

  it('plays a burst, not a hit spark', () => {
    expect(fxKindFor('missile_intercepted')).toBe('impact');
  });

  it('at the interceptor the map drew, else the true meeting', () => {
    ingestChronicleFx('g', [
      { id: 'mi', kind: 'missile_intercepted', shipId: 'g:msl_1_x', at: { x: 1980, y: -170 } },
    ]);
    const fired: PendingFx[] = [];
    let now = performance.now();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      drainVisibleFx(now, () => ({ x: 100, y: 100 }), (fx) => { fired.push(fx); });
    }
    expect(fired).toHaveLength(1);
    expect(fired[0].kind).toBe('impact');
    expect(fired[0].shipId).toBe('g:msl_1_x');
    expect(fired[0].at).toEqual({ x: 1980, y: -170 });
  });
});
