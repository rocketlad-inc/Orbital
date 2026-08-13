// Regression test for the fog-of-war ring floating ahead of a transiting
// ship (playtest: "the fog of war for the freighter in transit is ahead of
// it, but also not revealing anything there").
//
// A ship in transit has TWO positions in play:
//   - ship.transit.pos          — a running integration
//   - the polyline the renderer actually lerps the sprite along
//
// They diverge. MapCanvas already routed the click hit-test around that
// (transitShipCanvasPosRef, "not the diverging ship.transit.pos
// integration") but the sensor rings still read the integration, so the
// lit circle sat off in front of the hull, revealing empty space.
//
// These lock in that sensor rings and the visibility pass follow the DRAWN
// position when the renderer supplies one.

import { factionSensorRings, computeVisibility, shipWorldPosition } from '../visibility';
import type { Ship, Body } from '../../types';

const DRAWN = { x: 1000, y: 0 };     // where the sprite really is
const INTEGRATED = { x: 1400, y: 0 }; // where transit.pos has drifted to

function transitingShip(id: string, ownedBy: string): Ship {
  return {
    id,
    name: id,
    class: 'freighter',
    ownedBy,
    orbit: { parentBodyId: 'sol', radius: 0, period: 1, angle0: 0 },
    transit: { pos: { ...INTEGRATED } },
  } as unknown as Ship;
}

const BODIES: Body[] = [
  { id: 'sol', parentBodyId: null, orbitRadius: 0, orbitPeriod: 1, angle0: 0 } as unknown as Body,
];

describe('fog of war follows the drawn hull, not the integration', () => {
  const drawnMap = new Map([['f1', DRAWN]]);

  it('shipWorldPosition prefers the renderer position for a transiting ship', () => {
    const ship = transitingShip('f1', 'player');
    expect(shipWorldPosition(ship, 0, BODIES)).toEqual(INTEGRATED);        // no override -> old behaviour
    expect(shipWorldPosition(ship, 0, BODIES, drawnMap)).toEqual(DRAWN);   // override wins
  });

  it('the sensor ring is centred on the hull, not 400u ahead of it', () => {
    const ship = transitingShip('f1', 'player');
    const rings = factionSensorRings('player', [ship], [], BODIES, 0, new Set(), drawnMap);
    const shipRing = rings.find(r => r.sourceType === 'ship');
    expect(shipRing).toBeDefined();
    expect(shipRing!.pos).toEqual(DRAWN);
    // The whole bug in one assertion: the circle used to be offset from the
    // sprite by the full divergence.
    expect(Math.hypot(shipRing!.pos.x - DRAWN.x, shipRing!.pos.y - DRAWN.y)).toBe(0);
  });

  it('an enemy next to the drawn hull is revealed (it was not, before)', () => {
    const mine = transitingShip('f1', 'player');
    // Freighter sensor range is 200; park the enemy 50u from the DRAWN
    // position, which is 350u from the integrated one — inside the real
    // circle, outside the mis-placed one.
    const enemy = {
      id: 'e1', name: 'e1', class: 'corvette', ownedBy: 'rival',
      orbit: { parentBodyId: 'sol', radius: 0, period: 1, angle0: 0 },
      transit: { pos: { x: DRAWN.x + 50, y: 0 } },
    } as unknown as Ship;

    const withDrawn = computeVisibility(
      'player', [mine, enemy], [], BODIES, 0, new Map(), new Set(), drawnMap,
    );
    expect(withDrawn.visibleShipIds.has('e1')).toBe(true);

    const withoutDrawn = computeVisibility(
      'player', [mine, enemy], [], BODIES, 0, new Map(), new Set(),
    );
    expect(withoutDrawn.visibleShipIds.has('e1')).toBe(false);
  });
});
