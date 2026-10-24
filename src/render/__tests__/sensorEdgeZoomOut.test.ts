// speedmaster, 2026-10-23: "vision range indicator is not accurate when
// zoomed out". Every world the server lists as visible (which is every
// world inside your coverage) got a flat 36px bubble past its drawn disc,
// at every zoom. At full zoom-out a destroyer's sensor circle is ~10px,
// so the drawn edge was the bubbles, not the coverage.
import { presenceBubblePx, sensorEdgeArcs, PRESENCE_BUBBLE_PX } from '../sensorEdge';
import { hullReveal } from '../bodyPresentation';
import type { Body } from '../../types';

const earth = { id: 'earth', type: 'terrestrial', radius: 6.4 } as Body;
// Full zoom-out over Sol: Neptune's 12,000-unit orbit ~200px from the Sun.
const FAR = 0.017;
// Close in: Earth's true disc well past the hull-reveal size.
const NEAR = 6;

/** How far the drawn edge reaches from the ship, px. */
function edgeReach(scale: number, drawnEarthPx: number): number {
  const ship = { x: 500, y: 500 };
  const sensor = { ...ship, r: 600 * scale };                 // a destroyer's sight
  // Earth sits inside that coverage, near its rim.
  const at = { x: ship.x + sensor.r * 0.8, y: ship.y };
  const bubble = { ...at, r: presenceBubblePx(drawnEarthPx, hullReveal(earth, scale)) };
  const arcs = sensorEdgeArcs([sensor, bubble]);
  return Math.max(...arcs.map(a => Math.hypot(a.x - ship.x, a.y - ship.y) + a.r));
}

describe('the sensor edge zoomed out', () => {
  it('follows the coverage, not a fixed bubble round every visible world', () => {
    const sensorPx = 600 * FAR;                                // ~10px
    const drawn = 9;                                           // a rocky planet's floor
    // The edge may reach the world's drawn disc, never 36px of room past it.
    expect(edgeReach(FAR, drawn)).toBeLessThanOrEqual(sensorPx * 0.8 + drawn + 0.5);
  });

  it('a world whose hulls are a count badge gets just its drawn disc', () => {
    expect(hullReveal(earth, FAR)).toBe(0);
    expect(presenceBubblePx(9, hullReveal(earth, FAR))).toBe(9);
  });

  it('close in, where the hulls are drawn, the room for them is still there', () => {
    expect(hullReveal(earth, NEAR)).toBe(1);
    expect(presenceBubblePx(40, hullReveal(earth, NEAR))).toBe(40 + PRESENCE_BUBBLE_PX);
  });
});
