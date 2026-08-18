// [pure] A "claimed but still raw" opportunity must be actionable.
//
// clownking, 2026-08-12: "I have a station on Vagrant, which is a large
// asteroid. It can't be terraformed, but I have a situation report
// opportunity that won't go away stating 'Vagrant is claimed, but still
// raw'."
//
// Both terraform rules in useSituationItems filtered on owned + raw + not
// being fed, and never asked whether the body could be terraformed AT ALL.
// An asteroid is permanently raw, so the row could never clear no matter
// what the player did — a suggestion with no action behind it, which is
// worse than no suggestion.
//
// canBeTerraformed mirrors the server's `cannot_terraform` gate in
// worker/actions.js ("only terrestrial worlds, moons and dwarf planets").
// If the two ever disagree the UI offers a route the server will reject, so
// the mirror is asserted here too.

import { canBeTerraformed, canHostCity } from '../settlements';
import type { Body } from '../../types';

const body = (type: string): Body => ({
  id: `b-${type}`, name: type, type, radius: 2, mu: 2,
  orbitRadius: 20, orbitPeriod: 20, angle0: 0,
  terraformedAtTick: null,
} as unknown as Body);

/** The server's list, verbatim from worker/actions.js. */
const SERVER_TERRAFORMABLE = ['terrestrial', 'moon', 'dwarf'];

describe('[pure] terraform eligibility gates the opportunity', () => {
  it('accepts exactly the types the server accepts', () => {
    for (const t of SERVER_TERRAFORMABLE) {
      expect(canBeTerraformed(body(t))).toBe(true);
    }
  });

  it('rejects an asteroid — the reported case (Vagrant)', () => {
    expect(canBeTerraformed(body('asteroid'))).toBe(false);
  });

  it('rejects every other body type the map can contain', () => {
    for (const t of ['asteroid', 'meteoroid', 'gas-giant', 'ice-giant', 'star', 'black_hole', 'lagrange']) {
      expect(canBeTerraformed(body(t))).toBe(false);
    }
  });

  it('stays in step with canHostCity, since terraforming is what unlocks a city', () => {
    for (const t of [...SERVER_TERRAFORMABLE, 'asteroid', 'meteoroid', 'gas-giant', 'star']) {
      expect(canBeTerraformed(body(t))).toBe(canHostCity(body(t)));
    }
  });

  // The rule the two situation items now apply, in the shape they apply it.
  const wouldOfferTerraform = (b: Body, acc = 0, fed = false) =>
    canBeTerraformed(b)
    && b.terraformedAtTick === null
    && b.terraformCompletesAtTick == null
    && acc < 1
    && !fed;

  it('offers nothing on a claimed asteroid, however long it sits there', () => {
    expect(wouldOfferTerraform(body('asteroid'))).toBe(false);
  });

  it('still offers on a claimed raw moon — the case the row is FOR', () => {
    expect(wouldOfferTerraform(body('moon'))).toBe(true);
  });

  it('stops offering once a route is feeding it, or a payload has landed', () => {
    expect(wouldOfferTerraform(body('moon'), 0, true)).toBe(false);
    expect(wouldOfferTerraform(body('moon'), 50, false)).toBe(false);
  });
});
