// ============================================================
// Overlays must anchor to where a hull is DRAWN.
//
// Player report (2026-08-13): "the ships around Callisto are still
// spazzing out."
//
// A parked ship is not drawn at its orbital position. drawShip adds
// three things on top:
//   1. the cosmetic spin — a full lap every 180s, so hulls visibly
//      circle instead of creeping a pixel a minute at 1 tick/hour
//   2. the formation phase offset that fans a co-orbiting fleet evenly
//      around the ring instead of stacking it at the arrival point
//   3. the radial lane
//
// Three overlays ignored all of that and used shipWorldPosition():
// the fleet bond lines, the selected-ship hover line, and the combat-FX
// fallback. They therefore anchored to empty space — and because term 1
// advances every frame while the orbital position barely moves, the gap
// opened and closed continuously. Dashed lines sweeping around a planet
// while the hulls they name sit still.
//
// This asserts the DIVERGENCE is real and large, which is what makes
// using the wrong one a bug. The renderer's own smoothness was measured
// separately and was never the problem: per-frame position and heading
// deltas for a parked hull are constant to 4 significant figures.
//
// Run: npm run sim:overlays
// ============================================================

import { localPositionAt, bodyPosition } from '../src/physics/orbitalMechanics';
import { shipDisplayTick, smoothedTick, spinNowMs, SHIP_VISUAL_ORBIT_MS } from '../src/render/tickPhase';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}

const jupiter = { id: 'jupiter', type: 'gas_giant', radius: 12, soi: 60, mu: 300, orbitRadius: 520, orbitPeriod: 4330, angle0: 1.1 };
const callisto = { id: 'callisto', parent: 'jupiter', type: 'moon', radius: 2, soi: 6, mu: 6, orbitRadius: 26, orbitPeriod: 16.7, angle0: 0.4 };
const bodies = [jupiter, callisto];

// The six destroyers actually parked at Callisto in prod, verbatim:
// rp = ra = 4, omega = m0 = 0, direction 1, these epochs.
const PARK = 4;
const period = 2 * Math.PI * Math.sqrt(PARK ** 3 / callisto.mu);
const EPOCHS = [271, 340, 364, 404, 420, 431];
const fleet = EPOCHS.map((epoch, i) => ({
  id: `s${epoch}`, index: i, total: EPOCHS.length,
  orbit: { rp: PARK, ra: PARK, omega: 0, M0: 0, epoch, direction: 1, period, parentBodyId: 'callisto' },
}));

const TICK_MS = 3_600_000;

/** Raw orbital point — what the broken overlays used. */
function rawLocal(ship, t) {
  return localPositionAt(ship.orbit, t);
}
/** Where drawShip actually puts the hull (spin + formation phase). */
function drawnLocal(ship, t, wallMs) {
  let shipT = shipDisplayTick(t, ship.orbit.period, wallMs);
  if (ship.total > 1) shipT += (ship.index / ship.total) * ship.orbit.period;
  return localPositionAt(ship.orbit, shipT);
}

// --- 1. the gap is big enough to matter ---
{
  const wall = spinNowMs();
  const t = smoothedTick(441, wall + TICK_MS * 0.6, TICK_MS, wall);
  const gaps = fleet.map(s => {
    const a = rawLocal(s, t), b = drawnLocal(s, t, wall);
    return Math.hypot(a.x - b.x, a.y - b.y);
  });
  const worst = Math.max(...gaps);
  check('raw and drawn positions genuinely differ',
    worst > callisto.radius, `worst gap only ${worst.toFixed(2)} units`);
  // The ring's diameter is the ceiling: two points on one circle.
  check('the gap can span the whole parking ring',
    worst > PARK, `worst ${worst.toFixed(2)} vs ring radius ${PARK}`);
}

// --- 2. and it MOVES, which is what reads as spazzing ---
//
// A static offset would look merely wrong. The spin advances the drawn
// point every frame while the raw point creeps at true orbital rate, so
// a line between them sweeps. Sampled across a full visual lap.
{
  const base = spinNowMs();
  const ship = fleet[2];
  const gaps = [];
  for (let k = 0; k < 24; k++) {
    const wall = base + (k / 24) * SHIP_VISUAL_ORBIT_MS;
    const t = smoothedTick(441, wall + TICK_MS * 0.6, TICK_MS, wall);
    const a = rawLocal(ship, t), b = drawnLocal(ship, t, wall);
    gaps.push(Math.hypot(a.x - b.x, a.y - b.y));
  }
  const spread = Math.max(...gaps) - Math.min(...gaps);
  check('the gap swings over a visual lap (a sweeping line, not a fixed offset)',
    spread > PARK, `spread only ${spread.toFixed(2)} units`);
}

// --- 3. the renderer itself is smooth ---
//
// Guards against "fixing" this by damping the spin. The hull's own
// motion was measured and is constant; if that ever stops being true the
// diagnosis above is wrong and this should fail loudly.
{
  const base = spinNowMs();
  const ship = fleet[0];
  let prev = null;
  const deltas = [];
  for (let f = 0; f < 120; f++) {
    const wall = base + f * 16.67;
    const t = smoothedTick(441, wall + TICK_MS * 0.6, TICK_MS, wall);
    const p = drawnLocal(ship, t, wall);
    const pp = bodyPosition(callisto, t, bodies);
    const world = { x: pp.x + p.x, y: pp.y + p.y };
    if (prev) deltas.push(Math.hypot(world.x - prev.x, world.y - prev.y));
    prev = world;
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const ratio = Math.max(...deltas) / mean;
  check('a parked hull moves smoothly frame to frame',
    ratio < 1.05, `max/mean = ${ratio.toFixed(3)} — hull motion itself is erratic`);
}

// --- 4. one clock for the spin ---
//
// mapRenderer drove the lap from Date.now() and combatFx from
// performance.now(). Both feed `nowMs % SHIP_VISUAL_ORBIT_MS`, so
// unrelated origins put the same hull at different points on its orbit
// depending on which layer asked.
{
  const t = 441.6;
  const viaSpin = shipDisplayTick(t, period, spinNowMs());
  const viaPerf = shipDisplayTick(t, period, performance.now());
  const laps = Math.abs(viaSpin - viaPerf) / period;
  check('Date.now and performance.now really do disagree about the lap',
    laps > 0.01, `only ${laps.toFixed(4)} laps apart — clocks may have converged`);
  check('spinNowMs is the Date.now-based clock',
    Math.abs(spinNowMs() - Date.now()) < 50, 'spinNowMs drifted from Date.now');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
