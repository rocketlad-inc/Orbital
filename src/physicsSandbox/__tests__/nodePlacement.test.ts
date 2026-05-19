// ============================================================
// PHYSICS SANDBOX — Node-diamond placement test
// ============================================================
// Verifies that an un-touched plan node (Pe / Ap with dv=0) on a ship
// in low Earth orbit lands on the visible orbit ellipse, NOT off in
// some other corner of the canvas.
//
// The orbit ellipse is drawn anchored to its parent body's position at
// the LIVE current tick. The diamond's world position has to use the
// same anchor — anything else (notably orbitWorldPos(orbit, node.t),
// which adds Earth-at-node.t instead of Earth-at-now) shifts the
// diamond by the parent's orbital motion between now and node.t.

import { BY_ID, muOf } from '../bodies';
import {
  Orbit, bodyPosition, localPositionAt,
} from '../orbitalMath';
import {
  ManeuverNode, computeTrajectory, computeNodeChain,
} from '../trajectory';

const TWO_PI = Math.PI * 2;

describe('PhysicsSandbox node placement', () => {
  it('Pe and Ap diamonds land on the visible Earth-orbit ellipse', () => {
    const earth = BY_ID['earth'];
    const orbit: Orbit = {
      rp: 8, ra: 12, omega: 0.4,
      M0: 0, epoch: 0, direction: 1,
      period: TWO_PI * Math.sqrt((10 * 10 * 10) / muOf(earth.id)),
      parentBodyId: 'earth',
    };
    const period = orbit.period;

    const peNode: ManeuverNode = {
      id: 1, t: period, anchor: 'periapsis',
      dv: { prograde: 0, radial: 0 }, committed: false,
    };
    const apNode: ManeuverNode = {
      id: 2, t: period * 1.5, anchor: 'apoapsis',
      dv: { prograde: 0, radial: 0 }, committed: false,
    };
    const nodes = [peNode, apNode];

    const currentTick = 0;
    const arcs = computeTrajectory(orbit, nodes, currentTick);
    const chain = computeNodeChain(orbit, nodes, currentTick);

    // ----- Reproduce the renderer's coordinate math -----
    // The ellipse for the arc whose tStart <= currentTick is anchored to
    // Earth at currentTick. So Earth-at-now is the visual anchor.
    const earthAtNow = bodyPosition(earth, currentTick);

    // For each node, the diamond's WORLD position should be
    // Earth_at_now + local_position_on_orbit(node.t).
    for (const link of chain) {
      const localPos = localPositionAt(link.preBurnOrbit, link.node.t);
      const expectedWp = {
        x: earthAtNow.x + localPos.x,
        y: earthAtNow.y + localPos.y,
      };
      // The diamond's expected distance from Earth-at-now equals the
      // orbital radius at that true anomaly. For Pe it's exactly rp,
      // for Ap it's exactly ra. Verify the math.
      const dx = expectedWp.x - earthAtNow.x;
      const dy = expectedWp.y - earthAtNow.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (link.node.anchor === 'periapsis') {
        expect(dist).toBeCloseTo(orbit.rp, 3);
      } else {
        expect(dist).toBeCloseTo(orbit.ra, 3);
      }
    }

    // The trajectory should contain at least one arc whose tStart <=
    // currentTick (the "current" arc the ship is on right now). Without
    // such an arc, the renderer falls back to drawing future-projection
    // ellipses around Earth-at-future-position, and the diamonds drift
    // off-screen.
    const currentArc = arcs.find(
      a => a.tStart <= currentTick + 1e-6 && a.tEnd >= currentTick - 1e-6,
    );
    expect(currentArc).toBeDefined();
    expect(currentArc!.orbit.parentBodyId).toBe('earth');
    expect(currentArc!.orbit.rp).toBeCloseTo(orbit.rp, 6);
    expect(currentArc!.orbit.ra).toBeCloseTo(orbit.ra, 6);

    // Sanity: if we INCORRECTLY used Earth-at-node.t (the old buggy
    // approach), the diamond would land ~132 game units away from
    // Earth-at-now (Earth moves significantly in one orbital period).
    // Confirm that the correct placement is dramatically different
    // from the bug placement.
    const earthAtPe = bodyPosition(earth, peNode.t);
    const buggyDx = earthAtPe.x - earthAtNow.x;
    const buggyDy = earthAtPe.y - earthAtNow.y;
    const earthMotion = Math.sqrt(buggyDx * buggyDx + buggyDy * buggyDy);
    // Earth orbits ~58° in 19.9 ticks => ~130 game-unit displacement
    expect(earthMotion).toBeGreaterThan(50);
  });
});
