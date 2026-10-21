// The director's arithmetic (shotPlan.ts). Lorne, 2026-10-21, over the
// Mega Destroyer clip: the camera "pans through empty space", and the
// Mega Destroyer's strike fired while it was still in flight, so nothing
// happened at the end.
import { arcApexScale, arcNeeded, panCamera, strikeTimingWarnings, tickAtStep } from '../shotPlan';

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

  it('without an arc it is the plain ease (log-space zoom)', () => {
    const m = panCamera(0.5, from, 100, 0, 4, null);
    expect(m.x).toBeCloseTo(50);
    expect(m.scale).toBeCloseTo(2);   // geometric middle of 1 and 4
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
