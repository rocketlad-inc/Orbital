// Occlusion for the battle recap (2026-08-16).
//
// Everyone at a body is in orbit around it, so a recap has to decide what
// happens when a shot and the world end up in the same place on screen.
//
// The rule is the map's rule: combatFx's occludedByBody refuses to draw
// any tracer whose line passes near the body it is fought around, full
// stop. A middle version of this file tested a cleverer one — it carried
// depth per endpoint and let a hull in FRONT of the disc shoot across it,
// on the grounds that this view looks down on the orbital plane at an
// angle so half the fleet really is between the viewer and the world.
// That is geometrically true and it looks wrong: an opaque planet with a
// bolt over its face reads as a shot going THROUGH the planet, whichever
// side the shooter is on. The silhouette wins, and the layout carries the
// weight instead — sides sit in adjacent orbital slots so there is
// hardly ever anything to hide.
//
// pointVisible keeps the depth, because deciding what is drawn in FRONT
// of what is a different question from deciding what is drawn at all.

import { clipOutsideDisc, pointVisible } from '../BattleReview';

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
/** The world in every case below: centred at (50, 0), radius 20. */
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
    expect(near(parts[0][2], CX - R)).toBe(true);   // vanishes at the near rim
    expect(near(parts[1][0], CX + R)).toBe(true);   // reappears at the far rim
  });

  it('shows only the emerging half when the shot starts behind the limb', () => {
    const parts = clip(CX, CY, 100, 0);
    expect(parts).toHaveLength(1);
    expect(near(parts[0][0], CX + R)).toBe(true);
  });

  it('hides a shot entirely when it is wholly inside the silhouette', () => {
    expect(clip(45, 0, 55, 0)).toHaveLength(0);
  });

  it('keeps a grazing shot whole', () => {
    expect(clip(0, R, 100, R)).toHaveLength(1);
  });

  it('does not clip against a disc the shot points away from', () => {
    // The infinite line crosses the disc; the segment starts past it.
    expect(clip(80, 0, 140, 0)).toEqual([[80, 0, 140, 0]]);
  });

  it('returns nothing for a zero-length segment', () => {
    expect(clip(5, 5, 5, 5)).toHaveLength(0);
  });
});

describe('pointVisible', () => {
  it('shows anything in front of the world', () => {
    expect(pointVisible(CX, CY, 1, CX, CY, R)).toBe(true);
  });
  it('hides a point behind the world and inside its silhouette', () => {
    expect(pointVisible(CX, CY, -1, CX, CY, R)).toBe(false);
  });
  it('shows a point behind the world but clear of its silhouette', () => {
    expect(pointVisible(CX + R + 5, CY, -1, CX, CY, R)).toBe(true);
  });
});
