// A METEOROID TAKES NO SETTLEMENT.
//
// `canHostStation` returned true for literally every body, because until
// meteoroids existed that was true — stations orbit gas giants and even
// Sol. A rock is the first body type where it is false, and nothing
// caught it: a colony ship could plant a station on a few hundred metres
// of tumbling gravel.
//
// This matters beyond plausibility. The economics of a rock are that
// working it costs a freighter's TIME — parked, defenceless, 50/tick
// into a 500 hold — rather than a one-off construction bill. A station
// on the rock would convert a decaying resource into an outpost that
// mines itself, which is the one shape mining was designed not to have.
//
// MIRRORS the `too_small` gate in worker/actions.js. If one side moves
// without the other, the button and the server disagree.

import { canHostCity, canHostStation } from '../settlements';
import type { Body } from '../../types';

const body = (type: Body['type'], extra: Partial<Body> = {}): Body => ({
  id: 'b', name: 'B', type,
  orbitRadius: 100, orbitPeriod: 100, angle0: 0,
  radius: 1, soi: 0, color: '#fff',
  ...extra,
} as Body);

describe('meteoroids cannot host settlements', () => {
  it('refuses a station on a rock', () => {
    expect(canHostStation(body('meteoroid'))).toBe(false);
  });

  it('refuses a city on a rock', () => {
    expect(canHostCity(body('meteoroid'))).toBe(false);
  });

  it('still allows stations everywhere else', () => {
    // The rule is one carve-out, not a new allow-list. Stations orbit
    // gas giants and Sol — that is the Dyson Sphere's foundation — so a
    // regression here would be far worse than the hole it closed.
    for (const t of ['terrestrial', 'moon', 'dwarf', 'asteroid', 'gas_giant', 'star'] as const) {
      expect(canHostStation(body(t as Body['type']))).toBe(true);
    }
  });
});
