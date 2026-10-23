// A SUN GATE IS BORN (Studio clip a-sun-gate-is-born, reviewed 2026-10-23).
//
// (a) f151-f153: the omen rose through the Sun's lower-left limb, the Sun
//     went empty for a frame, and the gate then came out of the RIGHT
//     limb. The omen sat at a bearing hashed from the tick; it now takes
//     the bearing the gate really leaves on (state.js sunGateOmenAngle,
//     checked against the spawned gate in sim/sunGates.mjs), and holds
//     until the state that carries the gate lands.
// (b) f480-f494: the dashed link to Alpha Centauri slid ~40 px off the
//     landed gate. The link projected its ends at the INTEGER tick while
//     every body draws at the smoothed render tick.
// (c) f356: "CENTAURI GATE" and "CENTAURI GATE LANDING SITE" piled up as
//     the gate came in.

import fs from 'fs';
import path from 'path';
import { gateOmenPose, siteLabelYields, GATE_OMEN_HOLD_TICKS } from '../mapRenderer';

describe('(a) the omen rises where the gate will leave', () => {
  it('uses the bearing the server sends', () => {
    expect(gateOmenPose(300, 297, 0.1)?.angle).toBeCloseTo(0.1);
    expect(gateOmenPose(300, 297, 4.2)?.angle).toBeCloseTo(4.2);
  });

  it('swells over the six-tick warning', () => {
    expect(gateOmenPose(300, 293.9, 1)).toBeNull();
    expect(gateOmenPose(300, 294, 1)?.k).toBeCloseTo(0);
    expect(gateOmenPose(300, 297, 1)?.k).toBeCloseTo(0.5);
  });

  it('holds, fully risen, past the emerge tick until the gate arrives (no empty-Sun frame)', () => {
    expect(gateOmenPose(300, 300.2, 1)).toEqual({ k: 1, angle: 1 });
    expect(gateOmenPose(300, 300 + GATE_OMEN_HOLD_TICKS, 1)).toBeNull();
  });

  it('an older server with no bearing still gets an omen', () => {
    const p = gateOmenPose(300, 297, null);
    expect(p).not.toBeNull();
    expect(Number.isFinite(p!.angle)).toBe(true);
  });

  it('no warning running, no omen', () => {
    expect(gateOmenPose(null, 297, 1)).toBeNull();
  });
});

describe('(b) the gate link is drawn at the render tick', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'MapCanvas.tsx'), 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const block = code(src.slice(src.indexOf('// GATE LINKS.'), src.indexOf('clipSegmentToRect(', src.indexOf('// GATE LINKS.'))));

  it('both ends are projected at renderContext.t, where the gates are drawn', () => {
    expect(block).toMatch(/bodyPosition\(a, renderContext\.t,/);
    expect(block).toMatch(/bodyPosition\(bb, renderContext\.t,/);
  });

  it('nothing on the map positions a body at the integer tick', () => {
    expect(code(src)).not.toMatch(/bodyPosition\([^)]*gameState\.currentTick/);
  });
});

describe('(c) the landing site name gives way to its gate', () => {
  // Measured off the clip at zoom 0.2: squid art ~15 px, site ~17 px.
  it('keeps both names while the gate is far off (f340, ~140 px apart)', () => {
    expect(siteLabelYields(140, 15, 17, false)).toBe(false);
  });
  it('drops the site name as the gate comes in (f352, ~85 px; f356 closer)', () => {
    expect(siteLabelYields(85, 15, 17, false)).toBe(true);
    expect(siteLabelYields(40, 15, 17, false)).toBe(true);
  });
  it('scales with the art when zoomed in', () => {
    expect(siteLabelYields(180, 45, 30, false)).toBe(true);
    expect(siteLabelYields(260, 45, 30, false)).toBe(false);
  });
  it('a landed gate always wins', () => {
    expect(siteLabelYields(1000, 15, 17, true)).toBe(true);
  });
});
