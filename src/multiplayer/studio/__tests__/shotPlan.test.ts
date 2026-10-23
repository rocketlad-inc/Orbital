// The director's arithmetic (shotPlan.ts). Lorne, 2026-10-21, over the
// Mega Destroyer clip: the camera "pans through empty space", and the
// Mega Destroyer's strike fired while it was still in flight, so nothing
// happened at the end.
import { arcApexScale, arcNeeded, glideProgress, panCamera, strikeTimingWarnings, tickAtStep, worldStopsAt } from '../shotPlan';

const view = { w: 1920, h: 1080 };

describe('arc pans', () => {
  const from = { x: 0, y: 0, scale: 1 };

  it('a target on screen glides straight; one off screen arcs', () => {
    expect(arcNeeded(from, 300, 0, 1, view)).toBe(false);
    expect(arcNeeded(from, 5000, 0, 1, view)).toBe(true);
    // Zoomed out far enough, the same distance is on screen.
    expect(arcNeeded({ ...from, scale: 0.05 }, 5000, 0, 0.05, view)).toBe(false);
  });

  it('pulls back far enough that both ends fit at the top', () => {
    const apex = arcApexScale(from, 5000, 0, 1, view);
    // Both ends inside the frame from the midpoint: half the distance within half the frame.
    expect(2500 * apex).toBeLessThanOrEqual(540);
    expect(apex).toBeLessThan(1);
  });

  it('starts and ends exactly where it was asked, and bottoms at the apex halfway', () => {
    const apex = arcApexScale(from, 5000, 0, 2, view);
    const a = panCamera(0, from, 5000, 0, 2, { apex });
    const z = panCamera(1, from, 5000, 0, 2, { apex });
    const m = panCamera(0.5, from, 5000, 0, 2, { apex });
    expect(a).toEqual({ x: 0, y: 0, scale: 1 });
    expect(z.x).toBeCloseTo(5000); expect(z.scale).toBeCloseTo(2);
    expect(m.scale).toBeCloseTo(apex, 6);
    expect(m.x).toBeCloseTo(2500);
  });

  it('starts its pull-back at rest, not at full rate', () => {
    // Judges, 2026-10-22: a pan off a close-up shrank the world a quarter
    // in its first frame (the dip ran on the raw clock).
    const apex = arcApexScale(from, 5000, 0, 1, view);
    const firstFrame = panCamera(1 / 90, from, 5000, 0, 1, { apex });   // 1 frame of a 3 s pan
    expect(firstFrame.scale).toBeGreaterThan(0.99);
  });

  it('pulls back BEFORE it travels, and travels before it pushes in', () => {
    const apex = arcApexScale(from, 5000, 0, 1, view);
    const early = panCamera(0.15, from, 5000, 0, 1, { apex });
    const late = panCamera(0.85, from, 5000, 0, 1, { apex });
    expect(early.x).toBeCloseTo(0);            // still home, already zooming out
    expect(early.scale).toBeLessThan(1);
    expect(late.x).toBeCloseTo(5000);          // arrived, still pushing in
    expect(late.scale).toBeLessThan(1);
  });

  it('never leaves both ends off the frame for long: the target is in view from the apex on', () => {
    const apex = arcApexScale(from, 5000, 0, 1, view);
    for (let u = 0.5; u <= 1.0001; u += 0.05) {
      const c = panCamera(u, from, 5000, 0, 1, { apex });
      expect(Math.abs(5000 - c.x) * c.scale).toBeLessThanOrEqual(view.h / 2 + 1e-6);
    }
  });

  it('keeps one end in frame the whole way: the start until the apex, the target from it', () => {
    // Judges, 2026-10-23, three-way battle (5.67-5.83 s and 6.53-6.70 s):
    // the arc moved the camera before it had zoomed out and arrived before
    // it zoomed in, so Earth left the frame before Titan's system was in it.
    // A close-up both ends: Earth at px 460, Titan at px 330, 9 AU apart
    // (the take's own numbers: scale 38 to 41, the apex 0.146).
    const cases = [
      { from: { x: 0, y: 0, scale: 38.3 }, tx: 5900, ty: -600, to: 41.25 },
      { from: { x: 0, y: 0, scale: 2 }, tx: 20000, ty: 3000, to: 1.5 },
      { from: { x: 0, y: 0, scale: 0.6 }, tx: -9000, ty: 0, to: 4 },
      { from: { x: 0, y: 0, scale: 5 }, tx: 0, ty: 4000, to: 0.4 },
    ];
    // No further from the centre than the apex puts it (both ends inside
    // 80% of the frame there), so never at the edge either.
    const half = 0.4 * view.h + 1e-6;
    for (const c of cases) {
      const apex = arcApexScale(c.from, c.tx, c.ty, c.to, view);
      let lastG = -1;
      for (let u = 0; u <= 1.0001; u += 0.01) {
        const cam = panCamera(u, c.from, c.tx, c.ty, c.to, { apex });
        const fromStart = Math.hypot(cam.x - c.from.x, cam.y - c.from.y) * cam.scale;
        const fromEnd = Math.hypot(c.tx - cam.x, c.ty - cam.y) * cam.scale;
        if (u <= 0.5) expect(fromStart).toBeLessThanOrEqual(half);
        if (u >= 0.5) expect(fromEnd).toBeLessThanOrEqual(half);
        // It never goes back the way it came.
        const g = Math.hypot(cam.x - c.from.x, cam.y - c.from.y);
        expect(g).toBeGreaterThanOrEqual(lastG - 1e-6);
        lastG = g;
      }
    }
  });

  it('without an arc it is the plain ease (log-space zoom)', () => {
    const m = panCamera(0.5, from, 100, 0, 1, null);
    expect(m.x).toBeCloseTo(50);
    expect(panCamera(0.5, from, 100, 0, 4, null).scale).toBeCloseTo(2);   // geometric middle of 1 and 4
  });

  it('a straight pan that zooms keeps its subject in frame', () => {
    // Judges, 2026-10-23: a fit pan off a close-up of Ganymede moved the
    // centre at the zoom's pace, left the moon before the view widened, and
    // filmed a second of empty starfield. Zooming out, the start stays as
    // close to centre as the end frame puts it; zooming in, so does the target.
    const out = { x: 0, y: 0, scale: 2 };
    const end = 0.05;                             // the fit: both ends in a 1920 frame
    const D = 1920 / 2 / end * 0.8;               // the target sits 80% out at the end
    for (let u = 0; u <= 1.0001; u += 0.05) {
      const c = panCamera(u, out, D, 0, end, null);
      expect(Math.abs(c.x) * c.scale).toBeLessThanOrEqual(D * end + 1e-6);
    }
    for (let u = 0; u <= 1.0001; u += 0.05) {
      const c = panCamera(u, { x: D, y: 0, scale: end }, 0, 0, 2, null);
      expect(Math.abs(c.x) * c.scale).toBeLessThanOrEqual(D * end + 1e-6);
    }
  });
});

describe('the tick glide', () => {
  it('runs at an even pace between ticks', () => {
    expect(glideProgress(450, 900, false)).toBeCloseTo(0.5);
    expect(glideProgress(-10, 900, false)).toBe(0);
    expect(glideProgress(2000, 900, false)).toBe(1);
  });

  it('comes to rest after the last tick instead of stopping dead', () => {
    // Judges, 2026-10-23: seven clips froze on the frame the last glide
    // ended. The last glide covers its tick over twice the pace, starting
    // at the pace's speed and slowing to a stop.
    const pace = 900, ms = 2 * pace;
    const v0 = glideProgress(1, ms, true) / 1;         // ticks per ms at the start
    expect(v0 * pace).toBeCloseTo(1, 2);               // the same speed as the glides before it
    expect(glideProgress(ms, ms, true)).toBe(1);
    const vEnd = (glideProgress(ms, ms, true) - glideProgress(ms - 1, ms, true));
    expect(vEnd * pace).toBeLessThan(0.01);            // at rest by the end
  });

  it('says when the world stops moving, so a shot can end there', () => {
    const steps = [{ at: 1, do: 'tick' }, { at: 1.9, do: 'tick' }, { at: 2.8, do: 'tick' }];
    expect(worldStopsAt(steps, 900)).toBeCloseTo(2.8 + 1.8);
    expect(worldStopsAt([], 900)).toBeCloseTo(1.8);
    expect(worldStopsAt([{ at: 1, do: 'tick' }, { at: 9, do: 'tick' }], 900)).toBeCloseTo(9 + 1.8);
  });
});

describe('strike timing', () => {
  const steps = [
    { at: 0.3, do: 'tick' },
    { at: 1.0, do: 'tick', n: 2 },
    { at: 2.0, do: 'strike', ship: 'st_mega_0' },
    { at: 3.0, do: 'tick' },
    { at: 4.0, do: 'tick' },
    { at: 4.0, do: 'strike', ship: 'st_mega_0' },
  ];

  it('counts the ticks a step fires after: earlier times, and earlier in the list at the same time', () => {
    expect(tickAtStep(steps, 2, 10)).toBe(13);
    expect(tickAtStep(steps, 5, 10)).toBe(15);
  });

  it('warns when the hull is still in flight, and says when it could strike', () => {
    const w = strikeTimingWarnings(steps, 10, () => 15);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/steps\[2\] strike at 2s: st_mega_0 is still in flight then \(tick 13, lands at tick 15\)/);
    expect(w[0]).toMatch(/after the tick step at 4s/);
  });

  it('is quiet for a parked hull, and names a missing one', () => {
    expect(strikeTimingWarnings(steps, 10, () => null)).toEqual([]);
    expect(strikeTimingWarnings(steps, 10, () => undefined)[0]).toMatch(/no ship st_mega_0/);
  });

  it('says so when the shot never ticks far enough', () => {
    expect(strikeTimingWarnings(steps, 10, () => 40)[0]).toMatch(/never ticks far enough/);
  });
});
