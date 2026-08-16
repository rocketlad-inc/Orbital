// Occlusion for the battle recap (2026-08-15).
//
// Everyone at a body is in orbit around it, so roughly half the shots in
// any engagement cross the world they are being fought over. The map
// settles this with a boolean — combatFx's occludedByBody drops any
// tracer whose line passes near the body — but that rule cannot be lifted
// here unchanged: this view looks down on the orbital plane at an angle,
// so half the fleet is BETWEEN you and the world and must be allowed to
// shoot across it. The first cut clipped on the silhouette alone and hid
// exactly that fire.
//
// Hence depth. The edge cases are the whole risk: a shooter already
// behind the limb, a shot that dives behind mid-flight, a grazing pass, a
// disc the segment points away from. Every one of them draws something
// wrong rather than throwing, which is the kind of bug that ships.

import { visibleSegments, pointVisible } from '../BattleReview';

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
/** The world in every case below: centred at (50, 0), radius 20. */
const CX = 50, CY = 0, R = 20;
const seg = (
  x1: number, y1: number, z1: number, x2: number, y2: number, z2: number,
) => visibleSegments(x1, y1, z1, x2, y2, z2, CX, CY, R);

describe('visibleSegments', () => {
  it('leaves a shot that never crosses the world alone', () => {
    expect(seg(0, -50, -1, 100, -50, -1)).toEqual([[0, -50, 100, -50]]);
  });

  it('draws fire between two hulls IN FRONT straight across the disc', () => {
    // The whole point of carrying depth: both ends are nearer the viewer
    // than the world, so nothing is hidden even dead across the middle.
    expect(seg(0, 0, 1, 100, 0, 1)).toEqual([[0, 0, 100, 0]]);
  });

  it('splits a shot between two hulls BEHIND into its two visible halves', () => {
    const parts = seg(0, 0, -1, 100, 0, -1);
    expect(parts).toHaveLength(2);
    expect(near(parts[0][2], CX - R)).toBe(true);   // vanishes at the near rim
    expect(near(parts[1][0], CX + R)).toBe(true);   // reappears at the far rim
  });

  it('cuts a diving shot where it enters shadow, not at the rim', () => {
    // In front on the left, behind on the right, crossing over at x=50 —
    // which is the middle of the disc, not its edge. So the shot stays
    // visible ACROSS the near half of the world, winks out the moment it
    // passes behind, and comes back at the far limb. Getting this wrong
    // is invisible in a still and obvious in motion, which is why the
    // cut point is asserted rather than just the piece count.
    const parts = seg(0, 0, 1, 100, 0, -1);
    expect(parts).toHaveLength(2);
    expect(near(parts[0][2], 50)).toBe(true);       // crosses into shadow mid-disc
    expect(near(parts[1][0], CX + R)).toBe(true);   // clears the far limb
  });

  it('hides a shot entirely when it is behind the world at both ends', () => {
    expect(seg(45, 0, -1, 55, 0, -1)).toHaveLength(0);
  });

  it('keeps a grazing shot whole', () => {
    expect(seg(0, R, -1, 100, R, -1)).toHaveLength(1);
  });

  it('does not clip against a disc the shot points away from', () => {
    expect(seg(80, 0, -1, 140, 0, -1)).toEqual([[80, 0, 140, 0]]);
  });

  it('returns nothing for a zero-length segment', () => {
    expect(seg(5, 5, -1, 5, 5, -1)).toHaveLength(0);
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
