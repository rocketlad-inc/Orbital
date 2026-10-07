// Full zoom-out after the far systems (Lorne, 2026-10-06: "territory and
// sensor and icons get all kinds of fucky"). Two causes, both here.

import { layoutBadgePills, BADGE_ROW_MAX } from '../fleetBadge';
import { washScaleKey } from '../mapRenderer';
import { MIN_CAMERA_SCALE } from '../cameraLimits';

describe('the territory cache key follows the zoom all the way out', () => {
  it('the far end of the zoom no longer shares one key', () => {
    // The old key, Math.round(scale * 1000), gave 1 for all three: a layer
    // painted at 0.0015 was blitted, shifted, at 0.0006.
    const keys = [0.0015, 0.0012, 0.0009, MIN_CAMERA_SCALE].map(washScaleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the step is relative: the same 0.1% at every zoom', () => {
    for (const s of [MIN_CAMERA_SCALE, 0.01, 1, 40]) {
      expect(Math.abs(washScaleKey(s * 1.0004) - washScaleKey(s))).toBeLessThanOrEqual(1);
      expect(washScaleKey(s * 1.003) - washScaleKey(s)).toBe(3);
    }
  });

  it('a 1% zoom step repaints at every zoom', () => {
    for (const s of [MIN_CAMERA_SCALE, 0.01, 1, 40]) {
      expect(washScaleKey(s * 1.01)).not.toBe(washScaleKey(s));
    }
  });
});

describe('a fleet badge wraps into rows', () => {
  const W = 40, H = 23, GAP = 3;
  const rowsOf = (n: number) => {
    const l = layoutBadgePills(Array(n).fill(W), H, GAP);
    return [...new Set(l.pills.map(p => p.y))].map(y => l.pills.filter(p => p.y === y).length);
  };

  it('four or fewer stay one row, exactly the old strip', () => {
    for (let n = 1; n <= BADGE_ROW_MAX; n++) {
      const l = layoutBadgePills(Array(n).fill(W), H, GAP);
      expect(l.h).toBe(H);
      expect(l.w).toBe(n * W + (n - 1) * GAP);
      l.pills.forEach((p, i) => expect(p).toEqual({ x: i * (W + GAP), y: 0, w: W }));
    }
  });

  it('eight empires are two rows of four, half the width', () => {
    expect(rowsOf(8)).toEqual([4, 4]);
    const l = layoutBadgePills(Array(8).fill(W), H, GAP);
    expect(l.w).toBe(4 * W + 3 * GAP);
    expect(l.h).toBe(2 * H + GAP);
  });

  it('rows are balanced, never a lone pill under a full row', () => {
    expect(rowsOf(5)).toEqual([3, 2]);
    expect(rowsOf(7)).toEqual([4, 3]);
    expect(rowsOf(9)).toEqual([3, 3, 3]);
  });

  it('a short row sits centred, every pill inside the box, none overlapping', () => {
    const widths = [40, 52, 33, 47, 61];
    const l = layoutBadgePills(widths, H, GAP);
    for (const p of l.pills) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(l.w + 1e-9);
      expect(p.y + H).toBeLessThanOrEqual(l.h);
    }
    for (let i = 0; i < l.pills.length; i++) {
      for (let j = i + 1; j < l.pills.length; j++) {
        const a = l.pills[i], b = l.pills[j];
        const overlap = a.y === b.y && a.x < b.x + b.w && b.x < a.x + a.w;
        expect(overlap).toBe(false);
      }
    }
    // Second row (2 pills) centred under the first (3 pills).
    const row2 = l.pills.slice(3);
    const left = row2[0].x, right = row2[1].x + row2[1].w;
    expect(left).toBeCloseTo(l.w - right, 9);
  });
});
