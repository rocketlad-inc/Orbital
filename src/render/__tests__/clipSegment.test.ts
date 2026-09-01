// A dashed gate link arrived on screen as a floating fragment attached
// to nothing, and "cleared" when the player panned.
//
// It was never stale canvas. The link runs between two real positions,
// and at system zoom the far end is hundreds of thousands of pixels off
// canvas — a dashed stroke that long does not rasterise reliably, so
// the pattern dropped out in stretches. Panning moved where the dropout
// landed, which is why a pan appeared to fix it.
//
// Clipping to the viewport keeps the stroke screen-sized.

import { clipSegmentToRect } from '../mapRenderer';

const W = 1920;
const H = 1020;

describe('clipSegmentToRect', () => {
  it('keeps a segment already on screen unchanged', () => {
    const r = clipSegmentToRect(100, 100, 400, 400, W, H);
    expect(r).toEqual({ x1: 100, y1: 100, x2: 400, y2: 400 });
  });

  it('trims the runaway end of a gate link', () => {
    // The reported case: one end on the Neptune Gate, the other far off
    // canvas toward the Solar Gate.
    const r = clipSegmentToRect(820, 330, 820, 480000, W, H);
    expect(r).not.toBeNull();
    expect(r!.x1).toBe(820);
    expect(r!.y1).toBe(330);
    // Trimmed to the bottom edge plus the margin, not left at 480000.
    expect(r!.y2).toBeLessThanOrEqual(H + 64);
    expect(r!.y2).toBeGreaterThan(H);
  });

  it('keeps the on-screen end anchored so the line still leaves the gate', () => {
    const r = clipSegmentToRect(500, 500, -900000, -900000, W, H);
    expect(r).not.toBeNull();
    expect(r!.x1).toBe(500);
    expect(r!.y1).toBe(500);
  });

  it('drops a segment that misses the screen entirely', () => {
    expect(clipSegmentToRect(-5000, -5000, -4000, -4000, W, H)).toBeNull();
    expect(clipSegmentToRect(9000, 40, 9000, 900, W, H)).toBeNull();
  });

  it('keeps a segment that crosses the screen with both ends outside', () => {
    const r = clipSegmentToRect(-100000, H / 2, 100000, H / 2, W, H);
    expect(r).not.toBeNull();
    expect(r!.x1).toBeGreaterThanOrEqual(-64);
    expect(r!.x2).toBeLessThanOrEqual(W + 64);
    expect(r!.y1).toBe(H / 2);
  });

  it('handles a degenerate point', () => {
    expect(clipSegmentToRect(10, 10, 10, 10, W, H)).not.toBeNull();
    expect(clipSegmentToRect(-9000, -9000, -9000, -9000, W, H)).toBeNull();
  });

  it('never returns a stroke longer than the screen plus margins', () => {
    const r = clipSegmentToRect(0, 0, 500000, 500000, W, H);
    expect(r).not.toBeNull();
    const len = Math.hypot(r!.x2 - r!.x1, r!.y2 - r!.y1);
    expect(len).toBeLessThanOrEqual(Math.hypot(W + 128, H + 128));
  });
});
