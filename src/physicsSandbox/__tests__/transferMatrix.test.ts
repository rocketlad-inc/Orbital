// ============================================================
// PHYSICS SANDBOX — Transfer matrix test
// ============================================================
// Exercises Hohmann-style heliocentric transfers between every pair of
// sun-orbiting planets in the sandbox. For each (from, to) pair we:
//   1. Place the ship on a circular heliocentric orbit at `from`'s
//      orbital radius, at heliocentric angle 0 (arbitrary).
//   2. Apply a tangential Δv sized by Hohmann math (vis-viva at r1 for
//      an ellipse with the other apsis at r2).
//   3. Patch `to.angle0` so the target arrives at the rendezvous point
//      exactly when the ship does (half a transfer period later).
//   4. Zero the SOIs of every OTHER body so they don't trigger spurious
//      encounter events as the ship coasts through their orbital radii.
//      Also move `from` to the opposite side of Sol so the ship doesn't
//      start inside its SOI.
//
// Pass criteria: the trajectory's closest-approach to `to` is less than
// `to.soi`. (Either an explicit 'enter' arc, or sub-SOI even if the arc
// loop terminated for other reasons.)

import { BODIES, BY_ID, MU_SOL } from '../bodies';
import { orbitFromLocalState, bodyPosition, localPositionAt } from '../orbitalMath';
import { computeTrajectory } from '../trajectory';

const TWO_PI = Math.PI * 2;

interface TransferAttempt {
  from: string;
  to: string;
  r1: number;
  r2: number;
  dv: number;
  transferTime: number;
  result: 'enter' | 'closer-than-soi' | 'over-soi' | 'no-orbit';
  closestApproach: number;
  soi: number;
  arcsExplored: number;
}

const HELIO_PLANETS = BODIES.filter(b => b.parent === 'sol').map(b => b.id);

function attemptTransfer(fromId: string, toId: string): TransferAttempt {
  const from = BY_ID[fromId];
  const to = BY_ID[toId];

  const r1 = from.orbitRadius;
  const r2 = to.orbitRadius;
  const aTransfer = (r1 + r2) / 2;
  const transferTime = Math.PI * Math.sqrt(Math.pow(aTransfer, 3) / MU_SOL);
  const vCirc = Math.sqrt(MU_SOL / r1);
  const vTransfer = Math.sqrt(MU_SOL * (2 / r1 - 1 / aTransfer));
  const dv = vTransfer - vCirc;  // signed: + outbound, − inbound

  // Snapshot+restore EVERY planet's mutable bits — we patch angles and
  // soi during the test.
  const snapshot = BODIES.map(b => ({
    id: b.id, angle0: b.angle0, soi: b.soi,
  }));
  try {
    // 1) Zero out SOIs of all non-target bodies so they can't trigger
    //    spurious SOI enters along the way (e.g. Mercury→Mars passes
    //    near Venus and Earth at their orbital radius).
    for (const b of BODIES) {
      if (b.id === toId) continue;
      if (b.id === 'sol') continue;
      b.soi = 0;
    }
    // 2) Move `from` to the opposite side of Sol so the ship's start
    //    point isn't inside its (now-zero, but still) area.
    from.angle0 = Math.PI;

    // 3) Place ship at heliocentric (r1, 0) with prograde velocity
    //    v_circ + dv. Prograde at this position is +y.
    const px = r1, py = 0;
    const vx = 0;
    const vy = vCirc + dv;

    // 4) Patch `to.angle0` so the target reaches heliocentric angle π
    //    at t=transferTime. The ship's transfer ellipse has periapsis at
    //    (r1, 0) for outbound (or apoapsis there for inbound); either
    //    way, after half a transfer period the ship is at heliocentric
    //    angle π, distance r2.
    const arrivalAngle = Math.PI;
    to.angle0 = arrivalAngle - (TWO_PI * transferTime) / to.orbitPeriod;

    const orbit = orbitFromLocalState(px, py, vx, vy, 'sol', 0);
    if (!orbit) {
      return {
        from: fromId, to: toId, r1, r2, dv, transferTime,
        result: 'no-orbit', closestApproach: Infinity,
        soi: to.soi, arcsExplored: 0,
      };
    }

    const arcs = computeTrajectory(orbit, [], 0);
    let closest = Infinity;
    let result: TransferAttempt['result'] = 'over-soi';
    for (const arc of arcs) {
      const samples = 400;
      const dur = arc.tEnd - arc.tStart;
      const parent = BY_ID[arc.orbit.parentBodyId];
      for (let i = 0; i <= samples; i++) {
        const t = arc.tStart + (i / samples) * dur;
        const tp = bodyPosition(to, t);
        const local = localPositionAt(arc.orbit, t);
        const pp = bodyPosition(parent, t);
        const dx = pp.x + local.x - tp.x;
        const dy = pp.y + local.y - tp.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < closest) closest = d;
      }
      if (arc.endReason === 'enter' && arc.enteredBodyId === toId) {
        result = 'enter';
      }
    }
    if (result !== 'enter' && closest < to.soi) result = 'closer-than-soi';

    return {
      from: fromId, to: toId, r1, r2, dv, transferTime, result,
      closestApproach: closest, soi: to.soi, arcsExplored: arcs.length,
    };
  } finally {
    // Restore
    for (const snap of snapshot) {
      const b = BY_ID[snap.id];
      b.angle0 = snap.angle0;
      b.soi = snap.soi;
    }
  }
}

describe('PhysicsSandbox transfer matrix', () => {
  it('every heliocentric planet pair rendezvouses within target SOI', () => {
    const results: TransferAttempt[] = [];
    for (const from of HELIO_PLANETS) {
      for (const to of HELIO_PLANETS) {
        if (from === to) continue;
        results.push(attemptTransfer(from, to));
      }
    }

    const pad = (s: string, n: number) => s.padEnd(n);
    const lines: string[] = ['', 'Transfer matrix:'];
    lines.push(
      pad('FROM', 9) + pad('TO', 9) + pad('Δv', 9) +
      pad('Δt', 9) + pad('RESULT', 18) + pad('CLOSEST', 11) + pad('SOI', 8) + 'ARCS',
    );
    for (const r of results) {
      lines.push(
        pad(r.from, 9) +
        pad(r.to, 9) +
        pad(r.dv.toFixed(2), 9) +
        pad(r.transferTime.toFixed(1), 9) +
        pad(r.result, 18) +
        pad(r.closestApproach.toFixed(2), 11) +
        pad(r.soi.toFixed(0), 8) +
        String(r.arcsExplored),
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    const failures = results.filter(r => r.closestApproach > r.soi);
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'FAILURES:\n' +
        failures.map(f =>
          `  ${f.from} → ${f.to}: closest ${f.closestApproach.toFixed(2)} vs soi ${f.soi} (${f.result})`,
        ).join('\n'),
      );
    }
    expect(failures.map(f => `${f.from}→${f.to}`)).toEqual([]);
  });
});
