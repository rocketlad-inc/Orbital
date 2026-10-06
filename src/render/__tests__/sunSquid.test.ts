// IT LANDS AS THE GATE.
//
// The thing from the Sun unfurls into its ring over the last fifth of
// the flight (sunSquid.ts), and the resting gate is drawn by the same
// function at morph 1. The promise is that the final frame of the flight
// and the first frame of the gate are the SAME picture, whatever way the
// squid happened to be pointing when it stopped. A canvas that records
// every point it is handed, in screen space, holds it to that.

import {
  drawSunSquid, sunGateHeading, sunGateMorph, sunGateSpin,
} from '../sunSquid';

type M = [number, number, number, number, number, number];

/** Just enough of a 2D context to follow transforms and record points. */
function recordingCanvas() {
  const pts: Array<[number, number]> = [];
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const at = (x: number, y: number) =>
    pts.push([m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const mul = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    m = [
      m[0] * a + m[2] * b, m[1] * a + m[3] * b,
      m[0] * c + m[2] * d, m[1] * c + m[3] * d,
      m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5],
    ];
  };
  const grad = { addColorStop: () => {} };
  const g = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    save: () => { stack.push(m); },
    restore: () => { m = stack.pop() ?? m; },
    translate: (x: number, y: number) => mul(1, 0, 0, 1, x, y),
    rotate: (a: number) => mul(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0),
    scale: (x: number, y: number) => mul(x, 0, 0, y, 0, 0),
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    beginPath: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {},
    moveTo: at, lineTo: at,
    arc: (x: number, y: number) => at(x, y),
    ellipse: (x: number, y: number) => at(x, y),
    quadraticCurveTo: (_cx: number, _cy: number, x: number, y: number) => at(x, y),
    bezierCurveTo: (_a: number, _b: number, _c: number, _d: number, x: number, y: number) => at(x, y),
  };
  return { g: g as unknown as CanvasRenderingContext2D, pts };
}

const draw = (pose: Parameters<typeof drawSunSquid>[3]) => {
  const { g, pts } = recordingCanvas();
  drawSunSquid(g, 400, 300, pose);
  return pts;
};

describe('the thing from the Sun', () => {
  it('stays a squid for most of the trip and is all gate on arrival', () => {
    expect(sunGateMorph(0)).toBe(0);
    expect(sunGateMorph(0.5)).toBe(0);
    expect(sunGateMorph(0.8)).toBe(0);
    expect(sunGateMorph(0.9)).toBeGreaterThan(0);
    expect(sunGateMorph(0.9)).toBeLessThan(1);
    expect(sunGateMorph(1)).toBe(1);
  });

  it('flies out mantle first and turns round to brake past the flip', () => {
    expect(sunGateHeading(0.7, 0.2)).toBeCloseTo(0.7);
    expect(sunGateHeading(0.7, 0.8)).toBeCloseTo(0.7 + Math.PI);
  });

  it('the last frame of the flight is the first frame of the gate, whatever way it faced', () => {
    const now = 123456;
    const rest = draw({ u: 1, ringR: 30, heading: 0, morph: 1, thrust: 0, now });
    for (const heading of [0.4, 2.2, -1.3, Math.PI]) {
      const landing = draw({ u: 14, ringR: 30, heading, morph: 1, thrust: 0.25, now });
      expect(landing.length).toBe(rest.length);
      landing.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(rest[i][0], 6);
        expect(y).toBeCloseTo(rest[i][1], 6);
      });
    }
  });

  it('is genuinely a different picture in flight', () => {
    const now = 5000;
    const squid = draw({ u: 14, ringR: 30, heading: 0, morph: 0, thrust: 1, now });
    const gate = draw({ u: 14, ringR: 30, heading: 0, morph: 1, thrust: 0, now });
    // The squid trails aft of its centre (arms, feeders, jet); the gate
    // is a ring around it.
    const minX = (p: Array<[number, number]>) => Math.min(...p.map(q => q[0] - 400));
    expect(minX(squid)).toBeLessThan(-14 * 4);
    expect(minX(gate)).toBeGreaterThan(-30 * 2);
  });

  it('turns slowly and never loses precision in a long session', () => {
    expect(sunGateSpin(0)).toBe(0);
    const late = sunGateSpin(1e12);
    expect(late).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThan(Math.PI * 2);
  });
});
