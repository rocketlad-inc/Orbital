// ============================================================
// THE WELL: closer to Cygnus X, longer in transit.
//
// Lorne (2026-10-06): "the closer to the black hole you get, the longer
// transit takes". The client planner and the server's leg timer each
// carry a copy of the rule (wellDilation.ts / worker/wellDilation.js);
// a ship whose ETA the client shows must arrive when the server says,
// so the two are held together here.
// ============================================================

import { legDilation, wellDepthAt, WELL_RADIUS } from '../wellDilation';
import { planTorchTransfer } from '../torchTransfer';
import type { Body } from '../../types';
/* eslint-disable @typescript-eslint/no-var-requires */
const worker = require('../../../worker/wellDilation.js');

describe('the well', () => {
  it('client and server agree on every leg', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const wells = [{ x: 0, y: 0 }];
    for (let i = 0; i < 500; i++) {
      const a = { x: (rnd() - 0.5) * 30000, y: (rnd() - 0.5) * 30000 };
      const b = { x: (rnd() - 0.5) * 30000, y: (rnd() - 0.5) * 30000 };
      expect(legDilation(a, b, wells)).toBeCloseTo(worker.legDilation(a, b, wells), 12);
    }
    expect(worker.WELL_RADIUS).toBe(WELL_RADIUS);
  });

  it('bites harder the deeper you go, and not at all outside', () => {
    // Live Cygnus orbits since FAR_LOCAL_SCALE: Requiem 1000, Vellichor
    // 2000, Echelon 3400, Reliquary 5600.
    const at = [1000, 2000, 3400, 5600].map(wellDepthAt);
    expect(at[0]).toBeGreaterThan(1.8);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeLessThan(at[i - 1]);
    expect(at[3]).toBeGreaterThan(1);
    expect(wellDepthAt(WELL_RADIUS + 1)).toBe(1);
    expect(wellDepthAt(1)).toBeLessThanOrEqual(3);
  });

  it('charges the long crossing only for the part inside the well', () => {
    const sol = { x: -340000, y: 0 };
    // Requiem on the near side: the ship stops 1000 short of the hole.
    const requiem = { x: -1000, y: 0 };
    const f = legDilation(sol, requiem, [{ x: 0, y: 0 }]);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeLessThan(1.05);
    // A hop that stays deep in the well pays nearly the full depth.
    expect(legDilation({ x: 1000, y: 0 }, { x: 0, y: 1000 }, [{ x: 0, y: 0 }])).toBeGreaterThan(1.9);
  });

  it('makes the planner fly a slower, still-real burn', () => {
    const B = (o: Partial<Body> & { id: string; type: Body['type'] }) => ({
      name: o.id, radius: 1, orbitRadius: 0, orbitPeriod: 0, angle0: 0, soi: 0, color: '#fff', ...o,
    } as Body);
    const bary = B({ id: 'bh_barycenter', type: 'lagrange' });
    const hole = B({ id: 'cygnus_x', type: 'black_hole', parent: 'bh_barycenter', orbitRadius: 24, orbitPeriod: 500 });
    const target = B({ id: 'requiem', type: 'terrestrial', parent: 'bh_barycenter', orbitRadius: 1000, orbitPeriod: 1e9 });
    const ship = { pos: { x: 0, y: 1500 }, vel: { x: 0, y: 0 } };
    const without = planTorchTransfer(ship, 'requiem', 10, 90, 0, [bary, target])!;
    const within = planTorchTransfer(ship, 'requiem', 10, 90, 0, [bary, hole, target])!;
    expect(within.arriveTick).toBeGreaterThan(without.arriveTick * 1.5);
    // The committed engine is the well's, not the hull's.
    const f = within.arriveTick / without.arriveTick;
    expect(within.acceleration).toBeCloseTo(10 / (f * f), 1);
    expect(within.brakeAcceleration / within.acceleration).toBeCloseTo(9, 6);
  });
});
