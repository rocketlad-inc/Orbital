// ============================================================
// A SUN GATE FLIES OUT OF THE SUN AND LANDS ON ITS ORBIT.
//
// worker/sunGates.js spawns the gate with its FINAL orbit and an
// emergence window; bodyPosition draws the flight between. Three things
// have to hold or the map lies: it starts at the Sun's surface, it stays
// on the bearing it will orbit at (straight out, no swerve), and at the
// landing tick it is exactly where the ordinary orbit puts it — so there
// is no jump the frame the window closes.
// ============================================================

import { bodyPosition } from '../orbitalMechanics';
import type { Body } from '../../types';

const sol = { id: 'sol', name: 'Sol', type: 'star', radius: 50, orbitRadius: 0, orbitPeriod: 0, angle0: 0, soi: 0, color: '#fff' } as unknown as Body;
const gate = {
  id: 'sungate_centauri', name: 'Centauri Gate', type: 'megastructure', parent: 'sol',
  radius: 2.85, orbitRadius: 26000, orbitPeriod: 90000, angle0: 1.1, soi: 0, color: '#ffc86b',
  emerge: { fromTick: 100, untilTick: 110 },
} as unknown as Body;
const bodies = [sol, gate];
const landed = { ...gate, emerge: undefined } as Body;

const r = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
const bearing = (p: { x: number; y: number }) => Math.atan2(p.y, p.x);

describe('a sun gate leaving the Sun', () => {
  it('starts at the surface of the Sun', () => {
    expect(r(bodyPosition(gate, 100, bodies))).toBeCloseTo(50, 3);
  });

  it('flies straight out on its orbit\'s bearing', () => {
    for (const t of [101, 103.5, 105, 108]) {
      const p = bodyPosition(gate, t, bodies);
      const orbit = bodyPosition(landed, t, bodies);
      expect(bearing(p)).toBeCloseTo(bearing(orbit), 9);
      expect(r(p)).toBeGreaterThan(50);
      expect(r(p)).toBeLessThan(26000);
    }
  });

  it('is halfway at the flip, on an even burn', () => {
    expect(r(bodyPosition(gate, 105, bodies))).toBeCloseTo(50 + (26000 - 50) / 2, 3);
  });

  it('lands exactly on its orbit, with no jump when the window closes', () => {
    const justBefore = bodyPosition(gate, 110 - 1e-6, bodies);
    const at = bodyPosition(gate, 110, bodies);
    const orbit = bodyPosition(landed, 110, bodies);
    expect(at.x).toBeCloseTo(orbit.x, 6);
    expect(at.y).toBeCloseTo(orbit.y, 6);
    expect(Math.hypot(justBefore.x - at.x, justBefore.y - at.y)).toBeLessThan(0.01);
  });
});
