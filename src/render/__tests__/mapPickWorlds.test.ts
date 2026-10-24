// Play for Free playtest, 2026-10-24.
//  C14: "Clicking Luna (zoomed out) / the planet opens the ship parked in
//       front of it" (Dale, Maya) -- ships won every overlapping click.
//  C24: "Sending a ship needed two taps the first time" (Maya) -- the
//       phone's preview-then-commit fired for a pick that posts nothing.

import { bodyBeatsShip, pickPostsLeg } from '../mapPick';
import type { Ship } from '../../types';

describe('bodyBeatsShip: a world and a parked ship under one click', () => {
  it('the world wins when the click is nearer its centre', () => {
    // Zoomed out: Luna's dot under the pointer, a corvette marker 6px off.
    expect(bodyBeatsShip(1, 6)).toBe(true);
  });

  it('the ship wins when the click is on the ship', () => {
    expect(bodyBeatsShip(9, 2)).toBe(false);
  });

  it('a tie goes to the world, whose menu lists the ships there', () => {
    expect(bodyBeatsShip(4, 4)).toBe(true);
  });

  it('no world hit: the ship; no ship hit: the world', () => {
    expect(bodyBeatsShip(null, 3)).toBe(false);
    expect(bodyBeatsShip(3, null)).toBe(true);
    expect(bodyBeatsShip(null, null)).toBe(false);
  });
});

describe('pickPostsLeg: when a phone tap must be confirmed', () => {
  const flying = { pos: { x: 0, y: 0 } } as unknown as Ship['transit'];
  const staged = {} as unknown as Ship['plannedTransit'];
  const ship = (over: Partial<Ship>): Ship => ({ id: 'a', ...over } as Ship);

  it('a parked ship with nothing staged: one tap', () => {
    expect(pickPostsLeg('a', [ship({})])).toBe(false);
  });

  it('a parked ship with a STAGED plan only stages another leg: one tap', () => {
    expect(pickPostsLeg('a', [ship({ plannedTransit: staged })])).toBe(false);
  });

  it('a ship in flight posts the chained leg: preview, then commit', () => {
    expect(pickPostsLeg('a', [ship({ transit: flying })])).toBe(true);
  });

  it('a fleet posts when any attached mate is flying', () => {
    const ships = [
      ship({ id: 'a', fleetId: 'f', plannedTransit: staged }),
      ship({ id: 'b', fleetId: 'f', transit: flying }),
    ];
    expect(pickPostsLeg('a', ships)).toBe(true);
  });

  it('a detached hull answers for itself only', () => {
    const ships = [
      ship({ id: 'a', fleetId: 'f', fleetDetached: true, plannedTransit: staged }),
      ship({ id: 'b', fleetId: 'f', transit: flying }),
    ];
    expect(pickPostsLeg('a', ships)).toBe(false);
  });

  it('no selected ship: nothing to post', () => {
    expect(pickPostsLeg(null, [ship({ transit: flying })])).toBe(false);
  });
});
