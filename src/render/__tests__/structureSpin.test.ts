// A ROTATION NOBODY CAN SEE IS NOT A ROTATION.
//
// This file exists because of a bug that no test could have caught and
// no code review would have flagged. The spin rates were correct code
// operating on correct plumbing: the render loop ran, the clock was
// live, the canvas transform was applied and unwound. Every part worked.
//
// The rates were just wrong by a factor of ten. Written in radians per
// millisecond, 0.00004 looks like a considered, tasteful "slow". It is
// one revolution every two minutes and thirty-seven seconds — about two
// degrees per second, which no human perceives as movement. The feature
// shipped, and the bug report was "you sure you pushed?".
//
// So the assertions below are deliberately NOT about the rate constants.
// Pinning 0.00035 would only pin the unreadable number and re-lose the
// meaning. They are about the PERIOD IN SECONDS, which is the units a
// person can hold an opinion about.

import { STRUCTURE_SPIN } from '../mapRenderer';
import { MEGASTRUCTURES } from '../../game/megastructures';

/** Seconds for one full revolution at a given radians-per-ms rate. */
const periodSec = (rate: number) => (Math.PI * 2) / Math.abs(rate) / 1000;

describe('structure spin is perceptible', () => {
  it('every turning structure completes a revolution in the machinery band', () => {
    const rates = Object.entries(STRUCTURE_SPIN);
    expect(rates.length).toBeGreaterThan(0);

    for (const [kind, rate] of rates) {
      const p = periodSec(rate as number);
      // Under 8s a structure reads as a spinner or a loading throbber
      // rather than as something enormous under power.
      expect(p).toBeGreaterThan(8);
      // Over 45s is the failure this file is named for. At one minute a
      // player watching closely for ten seconds sees a still image.
      expect(p).toBeLessThan(45);
    }
  });

  it('the gate is the liveliest and the null field the most ponderous', () => {
    // Not arbitrary ordering: it is the read. A gate is a door being
    // held open and should look energetic; a null field is a thing
    // suppressing an entire volume and should look like it resents
    // moving at all. If these ever invert, the map is telling players
    // the opposite of what the rules do.
    expect(periodSec(STRUCTURE_SPIN.warp_gate!))
      .toBeLessThan(periodSec(STRUCTURE_SPIN.null_field!));
  });

  it('the sink turns against the gates', () => {
    // Sign, not speed. Two rings on one screen turning the same way
    // read as the same object; the sink is the one thing that works
    // inward and it should not be mistakable for a gate.
    expect(Math.sign(STRUCTURE_SPIN.gravity_sink!))
      .not.toBe(Math.sign(STRUCTURE_SPIN.warp_gate!));
  });

  it('only turns the kinds that would actually turn', () => {
    // A fort does not revolve. The weapons station and the foundry are
    // deliberately absent — a gun emplacement slowly rotating reads as
    // adrift rather than as manned, and they get their life from the
    // live overlay instead.
    expect(STRUCTURE_SPIN.weapons_station).toBeUndefined();
    expect(STRUCTURE_SPIN.mobile_foundry).toBeUndefined();
  });

  it('names only real megastructure kinds', () => {
    // Mirror-drift guard, the house failure mode: a rate keyed to a kind
    // that no longer exists is dead weight that silently never applies.
    for (const kind of Object.keys(STRUCTURE_SPIN)) {
      expect(MEGASTRUCTURES[kind as keyof typeof MEGASTRUCTURES]).toBeDefined();
    }
  });
});
