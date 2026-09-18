// ============================================================
// MP fog is the PAYLOAD, not a client-side recomputation.
//
// Player report (2026-08-13, third day of flicker chasing): "a flickering
// ship around Mercury at all zoom levels; zoomed out its number box
// flickers in and out." Board reconstruction from the live DB showed two
// factions whose sensor margin to Mercury sat at +30.6 and −40.5 units
// while Mercury moves 6.5 units/tick — and the client re-ran its OWN fog
// on top of the server's with different sensor positions (orbits vs body
// centres) plus an occlusion test the server doesn't have (a 35-unit Sol
// disk that was actively occluding one viewer's line to Mercury). Any
// disagreement window = a ship the server sent but the client refused to
// draw.
//
// The contract these tests pin: in MP, a ship in the payload is VISIBLE,
// unconditionally. Geometry has no veto.
//
// The client used to have a second fog job — remembering "ghosts" of
// ships the server stopped sending, to paint a last-known marker. That
// marker was removed from the game, and the bookkeeping with it, so
// visibility is now present tense and nothing else.
// ============================================================

import { payloadVisibility } from '../visibility';
import type { Ship } from '../../types';

function ship(id: string, ownedBy: string, parentBodyId = 'mercury'): Ship {
  return {
    id, name: id, ownedBy, class: 'corvette', hp: 40, parts: [],
    orbit: { rp: 3.2, ra: 3.2, omega: 0, M0: 0, epoch: 0, direction: 1, period: 10, parentBodyId },
    transit: null,
  } as unknown as Ship;
}

describe('payloadVisibility (MP server-authoritative fog)', () => {
  it('every payload ship is visible — geometry has no veto', () => {
    // A rival parked at Mercury, 144 units from Sol, directly "behind"
    // the Sol occlusion disk from any imaginable sensor. Irrelevant: the
    // server sent it, so the player sees it.
    const v = payloadVisibility([ship('rival1', 'f6'), ship('mine', 'player')]);
    expect(v.visibleShipIds.has('rival1')).toBe(true);
    expect(v.visibleShipIds.has('mine')).toBe(true);
  });

  it('a ship the server withholds is simply absent — no memory of it', () => {
    // The whole result, once rival1 stops being sent. There is no
    // last-known record to outlive it and nothing to draw: the hull is
    // off the map the moment the payload drops it.
    const v = payloadVisibility([ship('mine', 'player')]);
    expect(v.visibleShipIds.has('rival1')).toBe(false);
    expect([...v.visibleShipIds]).toEqual(['mine']);
    expect(Object.keys(v)).toEqual(['visibleShipIds']);
  });

  it('an empty payload sees nothing', () => {
    expect(payloadVisibility([]).visibleShipIds.size).toBe(0);
  });
});
