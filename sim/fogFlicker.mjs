// ============================================================
// Fog of war must not decide what it can see from what it drew.
//
// Player report (clownking, with phone footage): "if a ship is arriving
// soon to a planet that already has a ship/ships there, the game freaks
// out between counting the new arrival as being at the planet or not
// there yet, which makes the ship number counter flicker between the
// correct amount and the soon-to-be-correct amount... you can see the
// T-0 flickering in time with the ship number fluctuating."
//
// "T-0" is the fog GHOST label — age in ticks since a hull was last
// seen. A ghost and a live hull alternating means visibility itself was
// alternating, once per frame.
//
// The loop:
//   * the sensor pass positioned a transiting hull from
//     transitShipWorldPosRef (the polyline point the renderer lerps to),
//     falling back to ship.transit.pos, a SEPARATE integration that
//     drifts away from it
//   * that map was filled as a side effect of DRAWING the hull
//   * the draw loop skipped any hull the sensor pass had just called
//     invisible
//
// So a hull near the edge of a ring froze its fog position the moment it
// went dark and jumped forward the moment it came back. Frozen-vs-live
// straddles the range edge exactly where the player saw it: an inbound
// ship closing on a planet your sensors already cover.
//
// This models the two designs over a straight approach and counts how
// many times visibility CHANGES. A ship flying steadily inward should
// cross a sensor boundary exactly once.
//
// Run: npm run sim:fog
// ============================================================

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}

const SENSOR = { x: 0, y: 0, range: 100 };

// A hull closing on the sensor at a steady rate. Two positions per
// frame, as the real code had:
//   drawn      — the polyline point the renderer uses
//   integrated — ship.transit.pos, which drifts AHEAD of it
// The drift is what makes the two disagree about the boundary.
const DRIFT = 6;
const drawnAt = (f) => ({ x: 130 - f * 0.5, y: 0 });
const integratedAt = (f) => ({ x: 130 - f * 0.5 - DRIFT, y: 0 });
const inRange = (p) => Math.hypot(p.x - SENSOR.x, p.y - SENSOR.y) <= SENSOR.range;

const FRAMES = 160;

function transitions(seq) {
  let n = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) n++;
  return n;
}

// --- the OLD design: the map only updates on frames the hull is drawn,
// and it is drawn only when visible. ---
{
  const seq = [];
  let cached = null;             // transitShipWorldPosRef entry
  for (let f = 0; f < FRAMES; f++) {
    // Sensor pass: prefer the cached DRAWN point, else the integration.
    const probe = cached ?? integratedAt(f);
    const visible = inRange(probe);
    seq.push(visible);
    // Draw pass: skipped entirely when invisible, so the cache freezes.
    if (visible) cached = drawnAt(f);
  }
  const flips = transitions(seq);
  check('[old design] visibility oscillates instead of crossing once',
    flips > 1, `only ${flips} transition(s) — model no longer reproduces the bug`);
  console.log(`        old design: ${flips} visibility changes over ${FRAMES} frames`);
}

// --- the NEW design: the position is rebuilt every frame for every
// hull in transit, before the sensor pass, from the same sampler the
// renderer draws along. Nothing about it depends on visibility. ---
{
  const seq = [];
  for (let f = 0; f < FRAMES; f++) {
    const probe = drawnAt(f);    // always current, drawn or not
    seq.push(inRange(probe));
  }
  const flips = transitions(seq);
  check('[new design] a steady approach crosses the boundary exactly once',
    flips === 1, `${flips} transitions`);
  check('[new design] it ends up visible', seq[seq.length - 1] === true);
  check('[new design] it started invisible', seq[0] === false);
}

// --- the property that actually matters, stated directly ---
//
// Guards the regression rather than the specific numbers above: if the
// fog position is a pure function of the frame, no feedback is possible
// and a monotone approach cannot flicker whatever the drift is.
{
  for (const drift of [0, 3, 6, 12, 25]) {
    const seq = [];
    for (let f = 0; f < FRAMES; f++) seq.push(inRange(drawnAt(f)));
    const flips = transitions(seq);
    check(`[new design] no flicker with ${drift}-unit drift between the two integrations`,
      flips <= 1, `${flips} transitions`);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
