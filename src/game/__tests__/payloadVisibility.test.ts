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
// unconditionally. Geometry has no veto. The client's only fog job is
// remembering ghosts of ships the server stopped sending.
// ============================================================

import { payloadVisibility, GHOST_LIFETIME_TICKS } from '../visibility';
import type { Ship, Body } from '../../types';

const bodies: Body[] = [
  { id: 'sol', name: 'Sol', type: 'star', orbitRadius: 0, orbitPeriod: 1, angle0: 0, radius: 20, soi: 10000, color: '#fff' } as unknown as Body,
  { id: 'mercury', name: 'Mercury', type: 'terrestrial', parent: 'sol', orbitRadius: 144, orbitPeriod: 139, angle0: 0, radius: 1.2, soi: 4, color: '#aaa' } as unknown as Body,
];

function ship(id: string, ownedBy: string, parentBodyId = 'mercury'): Ship {
  return {
    id, name: id, ownedBy, class: 'corvette', hp: 40, parts: [],
    orbit: { rp: 3.2, ra: 3.2, omega: 0, M0: 0, epoch: 0, direction: 1, period: 10, parentBodyId },
    transit: null,
  } as unknown as Ship;
}

const T = 71;

describe('payloadVisibility (MP server-authoritative fog)', () => {
  it('every payload ship is visible — geometry has no veto', () => {
    // A rival parked at Mercury, 144 units from Sol, directly "behind"
    // the Sol occlusion disk from any imaginable sensor. Irrelevant: the
    // server sent it, so the player sees it.
    const v = payloadVisibility('player', [ship('rival1', 'f6'), ship('mine', 'player')], T, new Map(), bodies);
    expect(v.visibleShipIds.has('rival1')).toBe(true);
    expect(v.visibleShipIds.has('mine')).toBe(true);
  });

  it('a visible rival never renders as a ghost', () => {
    const v = payloadVisibility('player', [ship('rival1', 'f6')], T, new Map(), bodies);
    // It IS in lastSeen (that's the intel record), but the ghost pass
    // skips ids in visibleShipIds — assert the invariant the draw loop
    // relies on: visible ⊆ recorded, never visible-and-stale.
    expect(v.lastSeen.get('rival1')!.tick).toBe(T);
  });

  it('records the sighting at the DRAWN position when available', () => {
    const drawn = new Map([['rival1', { x: 123, y: -45 }]]);
    const v = payloadVisibility('player', [ship('rival1', 'f6')], T, new Map(), bodies, drawn);
    expect(v.lastSeen.get('rival1')).toMatchObject({ x: 123, y: -45 });
  });

  it('a ship dropped from the payload becomes a ghost that ages out', () => {
    const prev = new Map([
      ['rival1', { x: 10, y: 20, tick: T - 5, shipClass: 'corvette', ownedBy: 'f6' }],
    ]);
    // Payload no longer contains rival1.
    const v = payloadVisibility('player', [ship('mine', 'player')], T, prev, bodies);
    expect(v.visibleShipIds.has('rival1')).toBe(false);
    expect(v.lastSeen.get('rival1')).toMatchObject({ x: 10, y: 20, tick: T - 5 });

    // ...and after GHOST_LIFETIME_TICKS it is forgotten entirely.
    const later = payloadVisibility('player', [ship('mine', 'player')], T - 5 + GHOST_LIFETIME_TICKS, prev, bodies);
    expect(later.lastSeen.has('rival1')).toBe(false);
  });

  it('own ships never leave intel records', () => {
    const v = payloadVisibility('player', [ship('mine', 'player')], T, new Map(), bodies);
    expect(v.lastSeen.has('mine')).toBe(false);
  });

  it('a returning ship replaces its ghost with a fresh sighting', () => {
    const prev = new Map([
      ['rival1', { x: 10, y: 20, tick: T - 30, shipClass: 'corvette', ownedBy: 'f6' }],
    ]);
    const drawn = new Map([['rival1', { x: 300, y: 400 }]]);
    const v = payloadVisibility('player', [ship('rival1', 'f6')], T, prev, bodies, drawn);
    expect(v.visibleShipIds.has('rival1')).toBe(true);
    expect(v.lastSeen.get('rival1')).toMatchObject({ x: 300, y: 400, tick: T });
  });
});
