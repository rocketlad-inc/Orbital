// THE FLAK BATTERY DOES NO DAMAGE, WHICH IS THE WHOLE POINT.
//
// It slows what it is pointed at, and in this game speed IS
// survivability: the hit roll is atk^2/(atk^2+def^2), so a slower hull
// is an easier one for EVERY gun in the fleet rather than only for the
// ship carrying the flak.
//
// That is what makes it the answer to a swarm without a rule that says
// so. Five percent off a corvette's 0.85 buys far more hit chance than
// five percent off a destroyer's 0.30, because the same fraction comes
// off a much bigger number. The counter self-selects against the fast,
// and these tests pin that property rather than the implementation —
// if flak ever stops being better against swarms, it has stopped being
// the part that was asked for.

import fs from 'fs';
import path from 'path';
import {
  flakSlowMultiplier, FLAK_SLOW_PER_MOUNT, FLAK_SLOW_FLOOR, SHIP_PART_DEFS,
} from '../shipParts';

/** p = atk^2 / (atk^2 + def^2) — mirrors hitChance in shipDesigns.js. */
const hit = (atk: number, def: number) => (atk * atk) / (atk * atk + def * def);

const CORVETTE = 0.85;
const DESTROYER = 0.30;

describe('flak slows, and slowing is what kills swarms', () => {
  it('compounds rather than adding to a cliff', () => {
    expect(flakSlowMultiplier(0)).toBe(1);
    expect(flakSlowMultiplier(1)).toBeCloseTo(0.95, 5);
    expect(flakSlowMultiplier(4)).toBeCloseTo(0.95 ** 4, 5);
  });

  it('cannot drive the hit roll to certainty', () => {
    // Mounts stack across every ship present. Without a floor, ten
    // destroyers carrying six flak each would make a corvette a ~98%
    // shot, which is not a counter, it is a delete button.
    expect(flakSlowMultiplier(60)).toBe(FLAK_SLOW_FLOOR);
    expect(flakSlowMultiplier(1000)).toBe(FLAK_SLOW_FLOOR);
  });

  it('four mounts lift a destroyer from 11% to 16% against a corvette', () => {
    const before = hit(DESTROYER, CORVETTE);
    const after = hit(DESTROYER, CORVETTE * flakSlowMultiplier(4));
    expect(before).toBeCloseTo(0.111, 2);
    expect(after).toBeCloseTo(0.158, 2);
    // ~43% more kills per volley, for four slots that were never going
    // to out-damage the swarm anyway.
    expect(after / before).toBeGreaterThan(1.4);
  });

  it('tilts toward swarms — but only by about a fifth', () => {
    // MEASURED, not assumed. A percentage slow is inherently a mild,
    // fairly universal accuracy buff: four mounts multiply kills against
    // corvettes by 1.43 and against destroyers by 1.20. That is a real
    // tilt toward the swarm and nothing like a hard counter.
    //
    // Worth stating plainly because the obvious reading of "anti-swarm
    // part" is much stronger than what a percentage buys. If flak ever
    // needs to be a genuine counter rather than a lean, the lever is not
    // the percentage — it is capping enemy speed, which by construction
    // only bites hulls that were fast to begin with.
    const swarmGain = hit(DESTROYER, CORVETTE * flakSlowMultiplier(4))
      / hit(DESTROYER, CORVETTE);
    const heavyGain = hit(DESTROYER, DESTROYER * flakSlowMultiplier(4))
      / hit(DESTROYER, DESTROYER);
    expect(swarmGain).toBeCloseTo(1.43, 1);
    expect(heavyGain).toBeCloseTo(1.20, 1);
    expect(swarmGain).toBeGreaterThan(heavyGain);
  });

  it('also makes the swarm slightly worse at shooting back', () => {
    // Speed is both halves of the roll, so slowing a corvette blunts its
    // own attack too. Small, but it is why flak reads as defensive.
    const before = hit(CORVETTE, DESTROYER);
    const after = hit(CORVETTE * flakSlowMultiplier(4), DESTROYER);
    expect(after).toBeLessThan(before);
  });

  it('at the floor a swarm is still harder to hit than a heavy', () => {
    // The cap must not invert the game's basic truth that fast things
    // are hard to hit — otherwise flak turns corvettes into the WORST
    // hull to field rather than a counterable one.
    const swarm = hit(DESTROYER, CORVETTE * FLAK_SLOW_FLOOR);
    const heavy = hit(DESTROYER, DESTROYER);
    expect(swarm).toBeLessThan(heavy);
  });
});

describe('flak is mirrored and mountable where it should be', () => {
  const worker = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/shipDesigns.js'), 'utf8',
  );

  it('the constants match the server', () => {
    const per = worker.match(/FLAK_SLOW_PER_MOUNT = ([0-9.]+)/);
    const floor = worker.match(/FLAK_SLOW_FLOOR = ([0-9.]+)/);
    expect(Number(per![1])).toBe(FLAK_SLOW_PER_MOUNT);
    expect(Number(floor![1])).toBe(FLAK_SLOW_FLOOR);
  });

  it('mounts on every combat hull and nothing else', () => {
    // "All combat ships" — not freighters, not colony hulls, and not
    // the capital hulls, which take no fittings at all.
    expect(SHIP_PART_DEFS.flak.allowedOn).toEqual(['corvette', 'frigate', 'destroyer']);
  });

  it('does no damage', () => {
    // The one thing that must never quietly change: it has no
    // damageType, so it can never be counted as a weapon mount.
    expect(SHIP_PART_DEFS.flak).not.toHaveProperty('damageType');
  });

  it('the server agrees about the hulls', () => {
    expect(worker).toMatch(/flak:\s+\{ metal: \d+,\s+gold: \d+,\s+allowed: \['corvette', 'frigate', 'destroyer'\] \}/);
  });
});

describe('flak reaches combat through one choke point', () => {
  const room = fs.readFileSync(
    path.resolve(__dirname, '../../..', 'worker/room.js'), 'utf8',
  );

  it('speedOfShip carries the debuff, so every gun picks it up', () => {
    // The ship volley, the settlement guns, the Weapons Station and
    // counter-battery all read speed through this one helper. Applying
    // flak at the call sites instead would mean four places that have
    // to remember, and the fifth one added later that does not.
    expect(room).toMatch(/const speedOfShip = \(sh\) => shipSpeed\(sh\.ship_class, sh\._parts\)\s*\n\s*\* \(flakSlow\.get\(sh\.id\) \?\? 1\)/);
  });

  it('your own flak never slows you, and never slows a peace partner', () => {
    const i = room.indexOf('---- FLAK BATTERIES');
    const block = room.slice(i, i + 2600);
    expect(block).toMatch(/fid === sh\.owner_faction_id\) continue/);
    expect(block).toMatch(/peace\.has\(pairKey\(fid, sh\.owner_faction_id\)\)\) continue/);
  });

  it('covers the orbit it stands in, not hulls in transit', () => {
    const i = room.indexOf('---- FLAK BATTERIES');
    const block = room.slice(i, i + 2600);
    expect(block).toMatch(/inTransitIds\.has\(sh\.id\)\) continue/);
  });
});
