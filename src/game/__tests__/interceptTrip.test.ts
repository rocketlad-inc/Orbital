import { pathFraction } from '../interceptOptions';
import { solveRendezvous } from '../../physics/rendezvous.js';

// ============================================================
// "Meets at 88% of their trip" (player report, 2026-10-20: "they literally
// waited on their ships to travel 90 percent of the way then met them in
// orbit"). A matched intercept of a group flying AT you comes late, because
// matching means flying beside them and they are fastest mid-trip. The
// picker now says where on their trip you meet; these pin the number.
// ============================================================

describe('pathFraction', () => {
  const line = [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }, { t: 20, x: 100, y: 100 }];

  it('measures distance flown, not time', () => {
    expect(pathFraction(line, 0)).toBe(0);
    expect(pathFraction(line, 5)).toBeCloseTo(0.25);
    expect(pathFraction(line, 10)).toBeCloseTo(0.5);
    expect(pathFraction(line, 15)).toBeCloseTo(0.75);
    expect(pathFraction(line, 99)).toBe(1);
  });

  it('a timed (shaped) line counts the miles, so a slow start is a small share', () => {
    const shaped = [{ t: 0, x: 0, y: 0 }, { t: 5, x: 10, y: 0 }, { t: 10, x: 100, y: 0 }];
    expect(pathFraction(shaped, 5)).toBeCloseTo(0.1);
  });
});

describe('a group flying straight at you is matched late', () => {
  // Uranus -> Saturn at the closest gap, a flip-and-burn at accel 10; the
  // defender parked at Saturn, at rest.
  const L = 2056, a = 10;
  const T = 2 * Math.sqrt(L / a), h = T / 2;
  const at = (t: number) => {
    if (t <= h) return { pos: { x: 0.5 * a * t * t, y: 0 }, vel: { x: a * t, y: 0 } };
    const u = Math.min(t, T) - h;
    return { pos: { x: 0.5 * a * h * h + a * h * u - 0.5 * a * u * u, y: 0 }, vel: { x: a * (h - u), y: 0 } };
  };
  const meetShare = (ratio: number) => {
    const rv = solveRendezvous({ x: L, y: 0 }, { x: 0, y: 0 }, a * ratio, at, 0, T);
    expect(rv).not.toBeNull();
    return at(rv!.meetTick).pos.x / L;
  };

  it('an equal engine meets them about 88% of the way in, never halfway', () => {
    expect(meetShare(1)).toBeGreaterThan(0.85);
    expect(meetShare(1)).toBeLessThan(0.91);
  });

  it('a faster engine meets them sooner, but even 3x stays past halfway', () => {
    expect(meetShare(2)).toBeLessThan(meetShare(1));
    expect(meetShare(3)).toBeGreaterThan(0.5);
  });
});
