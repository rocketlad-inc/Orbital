// A FLEET FIGHTS AS ITS ICON.
//
// A folded hull is drawn nowhere of its own, so combat FX used to resolve
// it to its raw orbital point: its bolts left from empty space near the
// flagship and hits on it landed on nothing. Its slot in the formation is
// where the player actually sees it. The slot must win over EVERY other
// source — including the transit cache and the drawn hitbox, which both
// used to take precedence.

import { shipCanvasPos } from '../combatFx';
import type { RenderContext } from '../mapRenderer';
import type { Ship } from '../../types';

const rcWith = (over: Partial<RenderContext>): RenderContext =>
  ({ bodies: [], t: 0, ...over } as unknown as RenderContext);

const inTransit = { id: 'x', transit: { currentTransfer: {} } } as unknown as Ship;
const parked = { id: 'x', orbit: { parentBodyId: 'earth' } } as unknown as Ship;

describe('shipCanvasPos and fleet slots', () => {
  it('a fleet hull in transit fires from its SLOT, not the transit cache', () => {
    const rc = rcWith({ fleetSlots: new Map([['x', { x: 50, y: 60 }]]) });
    const transitCache = new Map([['x', { x: 1, y: 1 }]]);
    expect(shipCanvasPos(inTransit, rc, transitCache)).toEqual({ x: 50, y: 60 });
  });

  it('a parked fleet hull fires from its SLOT, not its drawn hitbox', () => {
    const rc = rcWith({
      fleetSlots: new Map([['x', { x: 70, y: 80 }]]),
      shipHitboxes: new Map([['x', { x: 5, y: 5, r: 9 }]]),
    });
    expect(shipCanvasPos(parked, rc)).toEqual({ x: 70, y: 80 });
  });

  it('a hull outside any fleet is resolved exactly as before', () => {
    const rc = rcWith({ fleetSlots: new Map() });
    const transitCache = new Map([['x', { x: 1, y: 1 }]]);
    expect(shipCanvasPos(inTransit, rc, transitCache)).toEqual({ x: 1, y: 1 });
  });
});
