// Noah: "When clicking on fleets that are intercepting, sometimes their
// flight paths bug out. They'll jump around and act like they're
// travelling to the destination planet, but when you refresh, they're
// back on the intercepting flight path."
//
// The panel clears its rendezvous preview on every close / hull switch,
// and the clear wrote `plannedRendezvous = undefined` over the COMMITTED
// intercept the MP mapper had put in the same field.

import { withRendezvousPreview } from '../rendezvousPreview';
import type { Ship } from '../../types';

type Rv = NonNullable<Ship['plannedRendezvous']>;

/** A committed intercept exactly as the MP mapper builds it: no
 *  `staged` flag. Shaped on the live Stonekin fleet meeting Wu Tang's
 *  Mega Destroyer at T+644.5 on a leg that ends at Mars. */
const COMMITTED: Rv = {
  p0: { x: 1200, y: -300 }, v0: { x: 0.4, y: 1.1 }, accel: 0.02,
  A: { x: 0.01, y: 0.02 }, B: { x: -0.01, y: -0.02 },
  startTick: 636, meetTick: 644.47,
  followShipId: 'ghhqbPbWz64Y:mega_88e9ff5f',
};
const PREVIEW: Rv = { ...COMMITTED, meetTick: 700, followShipId: 'someone-else' };

const ship = (rv?: Rv): Ship => ({ id: 'ghhqbPbWz64Y:s140_0_066fw', plannedRendezvous: rv } as unknown as Ship);

describe('rendezvous preview never erases the committed intercept', () => {
  it('closing the panel on an intercepting hull keeps its intercept', () => {
    // The exact report: click the fleet, click away. The panel's cleanup
    // is previewRendezvous(id, null) with nothing staged.
    const after = withRendezvousPreview(ship(COMMITTED), null);
    expect(after.plannedRendezvous).toEqual(COMMITTED);
  });

  it('...and does not even re-render it (same object back)', () => {
    const s = ship(COMMITTED);
    expect(withRendezvousPreview(s, null)).toBe(s);
  });

  it('a preview staged over a committed intercept hands it back on clear', () => {
    const staged = withRendezvousPreview(ship(COMMITTED), PREVIEW);
    expect(staged.plannedRendezvous?.staged).toBe(true);
    expect(staged.plannedRendezvous?.followShipId).toBe('someone-else');
    const cleared = withRendezvousPreview(staged, null);
    expect(cleared.plannedRendezvous).toEqual(COMMITTED);
  });

  it('re-staging keeps the ORIGINAL committed plan underneath, not the last preview', () => {
    const one = withRendezvousPreview(ship(COMMITTED), PREVIEW);
    const two = withRendezvousPreview(one, { ...PREVIEW, meetTick: 710 });
    expect(withRendezvousPreview(two, null).plannedRendezvous).toEqual(COMMITTED);
  });

  it('a preview on a hull with no intercept still clears to nothing', () => {
    const staged = withRendezvousPreview(ship(undefined), PREVIEW);
    expect(withRendezvousPreview(staged, null).plannedRendezvous).toBeUndefined();
  });
});
