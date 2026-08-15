// Occlusion clipping for the battle recap (2026-08-15).
//
// Everyone at a body is in orbit around it, so roughly half the shots in
// any engagement cross the world they are being fought over. Drawing them
// straight through it is what made a centred planet unusable in the first
// cut of this recap; the fix is to hand the renderer only the parts of
// each bolt that were actually in view.
//
// The edge cases are the whole risk here — a shooter that is itself
// behind the limb, a grazing shot, a disc that the segment points away
// from — and every one of them draws something wrong rather than
// throwing, which is exactly the kind of bug that ships.

import { clipOutsideDisc } from '../BattleReview';

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
/** Disc used by every case: centred at (50, 0) with radius 20. */
const CX = 50, CY = 0, R = 20;
const clip = (x1: number, y1: number, x2: number, y2: number) =>
  clipOutsideDisc(x1, y1, x2, y2, CX, CY, R);

describe('clipOutsideDisc', () => {
  it('leaves a shot that never crosses the world alone', () => {
    expect(clip(0, -50, 100, -50)).toEqual([[0, -50, 100, -50]]);
  });

  it('splits a shot through the middle into the two visible halves', () => {
    const parts = clip(0, 0, 100, 0);
    expect(parts).toHaveLength(2);
    expect(near(parts[0][2], CX - R)).toBe(true);   // stops at the near rim
    expect(near(parts[1][0], CX + R)).toBe(true);   // resumes at the far rim
  });

  it('shows only the emerging half when the shooter is behind the limb', () => {
    const parts = clip(CX, CY, 100, 0);
    expect(parts).toHaveLength(1);
    expect(near(parts[0][0], CX + R)).toBe(true);
  });

  it('hides a shot entirely when both ends are behind the world', () => {
    expect(clip(45, 0, 55, 0)).toHaveLength(0);
  });

  it('keeps a grazing shot whole', () => {
    // Tangent at the top of the disc: touches, never passes behind.
    expect(clip(0, R, 100, R)).toHaveLength(1);
  });

  it('does not clip against a disc the shot points away from', () => {
    // The infinite line crosses the disc, but the segment starts past it.
    expect(clip(80, 0, 140, 0)).toEqual([[80, 0, 140, 0]]);
  });

  it('returns nothing for a zero-length segment', () => {
    expect(clip(5, 5, 5, 5)).toHaveLength(0);
  });
});
